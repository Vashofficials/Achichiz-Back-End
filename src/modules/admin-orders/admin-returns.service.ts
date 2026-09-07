import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { returns, returnLines, orders, customers, orderLines, productVariants } from '../../db/schema/index.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import * as payments from '../payments/payments.service.js';

export async function listReturns(params: {
  page: number;
  perPage: number;
  status?: any;
  q?: string;
}) {
  const { page, perPage, status, q } = params;

  let conditions = [];
  if (status) conditions.push(eq(returns.status, status));
  if (q) {
    conditions.push(or(
      ilike(returns.returnNo, `%${q}%`),
      ilike(orders.orderNo, `%${q}%`)
    )!);
  }

  const offset = (page - 1) * perPage;

  const results = await db
    .select({
      id: returns.id,
      returnNo: returns.returnNo,
      orderNo: orders.orderNo,
      customerName: customers.fullName,
      reason: returns.reason,
      reasonNote: returns.reasonNote,
      status: returns.status,
      refundMode: returns.refundMode,
      refundPaise: returns.refundPaise,
      restock: returns.restock,
      pickupAwb: returns.pickupAwb,
      requestedAt: returns.requestedAt,
      resolvedAt: returns.resolvedAt,
    })
    .from(returns)
    .leftJoin(orders, eq(returns.orderId, orders.id))
    .leftJoin(customers, eq(returns.customerId, customers.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(returns.requestedAt))
    .limit(perPage)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(returns)
    .leftJoin(orders, eq(returns.orderId, orders.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const count = countResult[0]?.count ?? 0;

  const items = await Promise.all(results.map(async (ret) => {
    const lines = await db
      .select({
        id: returnLines.id,
        title: productVariants.optionLabel, // placeholder title
        sku: productVariants.sku,
        quantity: returnLines.quantity,
        condition: returnLines.condition,
        refundPaise: returnLines.refundPaise,
      })
      .from(returnLines)
      .innerJoin(orderLines, eq(returnLines.orderLineId, orderLines.id))
      .leftJoin(productVariants, eq(orderLines.variantId, productVariants.id))
      .where(eq(returnLines.returnId, ret.id));

    return {
      ...ret,
      requestedAt: ret.requestedAt.toISOString(),
      resolvedAt: ret.resolvedAt?.toISOString() ?? null,
      lines: lines.map(l => ({
        ...l,
        title: l.title ?? 'Unknown',
        sku: l.sku ?? '',
      })),
    };
  }));

  return {
    items,
    meta: {
      page,
      perPage,
      total: count,
      totalPages: Math.ceil(count / perPage),
    },
  };
}

export async function approveReturn(returnId: string, pickupAwb?: string) {
  const [ret] = await db.update(returns).set({
    status: 'approved',
    pickupAwb,
    updatedAt: new Date(),
  }).where(eq(returns.id, returnId)).returning();
  if (!ret) throw new NotFoundError('Return');
  return ret;
}

/**
 * Process a refund for an approved return.
 *
 * **State guard:** Only returns in `approved` status can be refunded. A return
 * that has already been refunded, rejected, or is still in `requested` status
 * is rejected with a 422 — the transition must go through `approveReturn` first.
 *
 * **Gateway integration:** Calls `payments.refundOrder` so the refund is
 * actually issued through the payment gateway (Razorpay), not just recorded
 * locally. The return status is set to `refunded` only after the gateway call
 * returns successfully.
 */
export async function refundReturn(returnId: string, refundPaise: number) {
  // 1. Load the return and verify it exists.
  const [existing] = await db
    .select({ id: returns.id, status: returns.status, orderId: returns.orderId })
    .from(returns)
    .where(eq(returns.id, returnId))
    .limit(1);
  if (!existing) throw new NotFoundError('Return');

  // 2. State guard — only approved returns can be refunded.
  const REFUNDABLE_STATES = ['approved'] as const;
  if (!REFUNDABLE_STATES.includes(existing.status as any)) {
    throw new UnprocessableError(
      `Return is in '${existing.status}' state and cannot be refunded. Only 'approved' returns can be refunded.`,
      'invalid_return_state',
    );
  }

  // 3. Call the payment gateway through the payments service.
  const gatewayResult = await payments.refundOrder({
    orderId: existing.orderId,
    amountPaise: refundPaise,
    reason: `Return ${returnId}`,
    idempotencyKey: `return-refund-${returnId}`,
  });

  // 4. Mark the return as refunded with the actual refund amount.
  const [ret] = await db.update(returns).set({
    status: 'refunded',
    refundPaise,
    resolvedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(returns.id, returnId)).returning();
  if (!ret) throw new NotFoundError('Return');

  return { ...ret, gatewayRefundId: gatewayResult.gatewayRefundId };
}

/**
 * Reject a return request.
 *
 * **State guard:** Only returns in `requested` or `approved` status can be
 * rejected. Returns that have already been refunded or rejected are immutable.
 */
export async function rejectReturn(returnId: string, reasonNote: string) {
  // 1. Load and verify state.
  const [existing] = await db
    .select({ id: returns.id, status: returns.status })
    .from(returns)
    .where(eq(returns.id, returnId))
    .limit(1);
  if (!existing) throw new NotFoundError('Return');

  const REJECTABLE_STATES = ['requested', 'approved'] as const;
  if (!REJECTABLE_STATES.includes(existing.status as any)) {
    throw new UnprocessableError(
      `Return is in '${existing.status}' state and cannot be rejected.`,
      'invalid_return_state',
    );
  }

  const [ret] = await db.update(returns).set({
    status: 'rejected',
    reasonNote,
    resolvedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(returns.id, returnId)).returning();
  if (!ret) throw new NotFoundError('Return');
  return ret;
}
