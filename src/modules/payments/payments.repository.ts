/**
 * Drizzle queries for payments, refunds and the gateway event log.
 * No business rules, no HTTP.
 *
 * `payments` and `refunds` are Tier 1 (03_schema.md §4.5): DELETE is revoked from
 * the application role, so nothing here removes a row. A failed payment is a row
 * with `status = 'failed'`, not an absence.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  orderTimeline,
  orders,
  payments,
  refunds,
  type Order,
  type Payment,
  type OrderStatus,
} from '../../db/schema/index.js';

export type PaymentRow = Payment;

export type OrderForPaymentRow = {
  id: string;
  orderNo: string;
  customerId: string | null;
  currency: string;
  totalPaise: number;
  amountPaidPaise: number;
  amountRefundedPaise: number;
  status: string;
  paymentStatus: string;
};

const ORDER_FOR_PAYMENT = {
  id: orders.id,
  orderNo: orders.orderNo,
  customerId: orders.customerId,
  currency: orders.currency,
  totalPaise: orders.totalPaise,
  amountPaidPaise: orders.amountPaidPaise,
  amountRefundedPaise: orders.amountRefundedPaise,
  status: orders.status,
  paymentStatus: orders.paymentStatus,
} as const;

/* ------------------------------------------------------------------ orders */

export async function findOrderForPayment(
  orderId: string,
  exec: Executor = db,
): Promise<OrderForPaymentRow | null> {
  const rows = await exec.select(ORDER_FOR_PAYMENT).from(orders).where(eq(orders.id, orderId)).limit(1);
  return rows[0] ?? null;
}

export async function lockOrder(tx: Tx, orderId: string): Promise<Order | null> {
  const rows = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1);
  return rows[0] ?? null;
}

/**
 * Only the settlement columns move.
 *
 * `amount_paid_paise` and `amount_refunded_paise` are deliberately NOT among the
 * columns the deferred `check_order_totals()` trigger watches, so recording a
 * capture never re-runs the I1–I4 aggregate over the lines.
 */
export async function updateOrderPaymentState(
  tx: Tx,
  orderId: string,
  patch: {
    status?: OrderStatus;
    paymentStatus?: string;
    amountPaidPaise?: number;
    amountRefundedPaise?: number;
    confirmedAt?: Date | null;
  },
): Promise<void> {
  await tx
    .update(orders)
    .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
    .where(eq(orders.id, orderId));
}

export async function insertTimelineEvent(
  tx: Tx,
  values: typeof orderTimeline.$inferInsert,
): Promise<void> {
  await tx.insert(orderTimeline).values(values);
}

/* ---------------------------------------------------------------- payments */

export async function findPaymentByGatewayPaymentId(
  gatewayPaymentId: string,
  exec: Executor = db,
): Promise<PaymentRow | null> {
  const rows = await exec
    .select()
    .from(payments)
    .where(and(eq(payments.gateway, 'razorpay'), eq(payments.gatewayPaymentId, gatewayPaymentId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPaymentByGatewayOrderId(
  gatewayOrderId: string,
  exec: Executor = db,
): Promise<PaymentRow | null> {
  const rows = await exec
    .select()
    .from(payments)
    .where(and(eq(payments.gateway, 'razorpay'), eq(payments.gatewayOrderId, gatewayOrderId)))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** The reusable session for an order: a gateway order created but not yet paid. */
export async function findOpenSession(orderId: string, exec: Executor = db): Promise<PaymentRow | null> {
  const rows = await exec
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.orderId, orderId),
        eq(payments.gateway, 'razorpay'),
        eq(payments.status, 'created'),
        isNull(payments.gatewayPaymentId),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function findCapturedPayment(
  orderId: string,
  exec: Executor = db,
): Promise<PaymentRow | null> {
  const rows = await exec
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'captured')))
    .orderBy(desc(payments.capturedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertPayment(
  values: typeof payments.$inferInsert,
  exec: Executor = db,
): Promise<PaymentRow> {
  const rows = await exec.insert(payments).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('payment insert returned no row');
  return row;
}

export async function updatePayment(
  tx: Tx,
  paymentId: string,
  patch: Partial<typeof payments.$inferInsert>,
): Promise<void> {
  await tx
    .update(payments)
    .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
    .where(eq(payments.id, paymentId));
}

/* ----------------------------------------------------------------- refunds */

export async function findRefundByGatewayId(
  gatewayRefundId: string,
  exec: Executor = db,
): Promise<typeof refunds.$inferSelect | null> {
  const rows = await exec
    .select()
    .from(refunds)
    .where(eq(refunds.gatewayRefundId, gatewayRefundId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Every paisa already committed to going back: rows in `initiated` or
 * `processing` are in flight at the gateway, and `completed` rows are done.
 * Only `failed` frees the money up again.
 *
 * This is the number the refund cap must be computed against —
 * `orders.amount_refunded_paise` alone lags by however long the gateway takes to
 * confirm, and a second refund initiated inside that window would be real money
 * leaving twice.
 */
export async function sumCommittedRefundsPaise(
  orderId: string,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .select({ total: sql<number>`COALESCE(SUM(${refunds.amountPaise}), 0)::bigint` })
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, orderId),
        inArray(refunds.status, ['initiated', 'processing', 'completed']),
      ),
    );
  return rows[0]?.total ?? 0;
}

export async function findRefundByIdempotencyKey(
  key: string,
  exec: Executor = db,
): Promise<typeof refunds.$inferSelect | null> {
  const rows = await exec.select().from(refunds).where(eq(refunds.idempotencyKey, key)).limit(1);
  return rows[0] ?? null;
}

export async function insertRefund(
  tx: Tx,
  values: typeof refunds.$inferInsert,
): Promise<typeof refunds.$inferSelect> {
  const rows = await tx.insert(refunds).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('refund insert returned no row');
  return row;
}

export async function updateRefund(
  exec: Executor,
  refundId: string,
  patch: Partial<typeof refunds.$inferInsert>,
): Promise<void> {
  await exec
    .update(refunds)
    .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
    .where(eq(refunds.id, refundId));
}

/**
 * §3.5 again, for refund numbers. The '2026' series is seeded by the initial
 * migration; later financial years create their own row on first use, which is a
 * no-op forever after.
 */
export async function nextRefundNumber(tx: Tx, year: number): Promise<string> {
  const scope = String(year);
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('refund', ${scope}, ${'REF-' + scope + '-'}, '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ refund_no: string }>(
    sql`SELECT next_document_number('refund', ${scope}) AS refund_no`,
  );
  const refundNo = result.rows[0]?.refund_no;
  if (!refundNo) throw new Error('next_document_number returned no refund number');
  return refundNo;
}

/*
 * `payment_events` is deliberately NOT touched here. The inbound gateway event
 * log belongs to the webhooks module, which owns the idempotency boundary; this
 * module owns what an event MEANS. Keeping them apart is what stops "have I seen
 * this event" and "has this payment been captured" turning into one tangled
 * condition.
 */
