/**
 * Drizzle queries for customer-facing orders. No business rules, no HTTP.
 *
 * Every read is scoped by `customer_id` in the WHERE clause rather than filtered
 * afterwards, so "someone else's order" is a 404 by construction — the storefront
 * today renders any order id that happens to be in that browser's localStorage
 * (`account.orders.$id.tsx:26-38`).
 */

import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  couponRedemptions,
  coupons,
  inventoryLevels,
  inventoryReservations,
  orderLineAddOns,
  orderLinePersonalisations,
  orderLines,
  orderTimeline,
  orders,
  type Order,
  type OrderStatus,
} from '../../db/schema/index.js';

export type OrderRow = Order;

export type OrderListRow = {
  order: Order;
  itemCount: number;
  thumbnailUrl: string | null;
};

const itemCountFor = (orderId: unknown): ReturnType<typeof sql<number>> =>
  sql<number>`coalesce((
    SELECT sum(ol.quantity)::int FROM order_lines ol
     WHERE ol.order_id = ${orderId} AND ol.fulfilment_status <> 'cancelled'), 0)`;

const thumbnailFor = (orderId: unknown): ReturnType<typeof sql<string | null>> =>
  sql<string | null>`(
    SELECT ol.image_url_snapshot FROM order_lines ol
     WHERE ol.order_id = ${orderId}
     ORDER BY ol.position ASC
     LIMIT 1)`;

/* ------------------------------------------------------------------ reads */

export async function listForCustomer(
  customerId: string,
  opts: { limit: number; offset: number; status?: OrderStatus | undefined },
  exec: Executor = db,
): Promise<{ rows: OrderListRow[]; total: number }> {
  const where = opts.status
    ? and(eq(orders.customerId, customerId), eq(orders.status, opts.status))
    : eq(orders.customerId, customerId);

  const rows = await exec
    .select({
      order: orders,
      itemCount: itemCountFor(orders.id),
      thumbnailUrl: thumbnailFor(orders.id),
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.placedAt))
    .limit(opts.limit)
    .offset(opts.offset);

  const counted = await exec.select({ n: sql<number>`count(*)::int` }).from(orders).where(where);

  return { rows, total: counted[0]?.n ?? 0 };
}

export async function findForCustomer(
  customerId: string,
  orderId: string,
  exec: Executor = db,
): Promise<OrderListRow | null> {
  const rows = await exec
    .select({
      order: orders,
      itemCount: itemCountFor(orders.id),
      thumbnailUrl: thumbnailFor(orders.id),
    })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Public tracking lookup.
 *
 * Order numbers are sequential and therefore guessable, so the mobile number is
 * the shared secret and BOTH must match. Either the buyer's or the recipient's
 * number works, because the person chasing a gift is often the recipient.
 */
export async function findForTracking(
  orderNo: string,
  mobileNumber: string,
  exec: Executor = db,
): Promise<{ order: Order; itemCount: number } | null> {
  const rows = await exec
    .select({ order: orders, itemCount: itemCountFor(orders.id) })
    .from(orders)
    .where(
      and(
        eq(orders.orderNo, orderNo.toUpperCase()),
        or(eq(orders.buyerMobile, mobileNumber), eq(orders.recipientMobile, mobileNumber)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findLines(orderId: string, exec: Executor = db) {
  return exec
    .select()
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId))
    .orderBy(asc(orderLines.position), asc(orderLines.id));
}

export async function findLineAddOns(lineIds: readonly string[], exec: Executor = db) {
  if (lineIds.length === 0) return [];
  return exec
    .select()
    .from(orderLineAddOns)
    .where(inArray(orderLineAddOns.orderLineId, [...lineIds]));
}

export async function findLinePersonalisations(lineIds: readonly string[], exec: Executor = db) {
  if (lineIds.length === 0) return [];
  return exec
    .select()
    .from(orderLinePersonalisations)
    .where(inArray(orderLinePersonalisations.orderLineId, [...lineIds]));
}

export async function findTimeline(orderId: string, exec: Executor = db) {
  return exec
    .select({
      occurredAt: orderTimeline.occurredAt,
      eventType: orderTimeline.eventType,
      label: orderTimeline.label,
      note: orderTimeline.note,
      actorKind: orderTimeline.actorKind,
      actorLabel: orderTimeline.actorLabel,
    })
    .from(orderTimeline)
    .where(eq(orderTimeline.orderId, orderId))
    .orderBy(asc(orderTimeline.occurredAt), asc(orderTimeline.id));
}

/* ----------------------------------------------------------------- writes */

/**
 * Re-read the order under a row lock.
 *
 * Cancellation decides what to do from the order's status, so that status has to
 * be stable for the rest of the transaction — otherwise a webhook capturing the
 * payment between the read and the write produces a cancelled order with a
 * captured payment and nothing to reconcile them.
 */
export async function lockOrder(tx: Tx, orderId: string): Promise<Order | null> {
  const rows = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1);
  return rows[0] ?? null;
}

export async function updateOrder(
  tx: Tx,
  orderId: string,
  patch: Partial<{
    status: OrderStatus;
    paymentStatus: string;
    cancelledAt: Date;
    cancelReason: string;
  }>,
): Promise<void> {
  await tx
    .update(orders)
    .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
    .where(eq(orders.id, orderId));
}

/**
 * Give the stock back.
 *
 * Pre-locking in id order keeps this on the same lock protocol as checkout, so a
 * cancellation and a checkout touching the same SKUs queue rather than deadlock.
 * The `reserved_qty >= 0` CHECK is the backstop: a double-release aborts the
 * statement instead of silently corrupting availability.
 */
export async function releaseOrderReservations(tx: Tx, orderId: string): Promise<void> {
  const held = await tx
    .select({ inventoryLevelId: inventoryReservations.inventoryLevelId })
    .from(inventoryReservations)
    .where(and(eq(inventoryReservations.orderId, orderId), isNull(inventoryReservations.releasedAt)));

  if (held.length === 0) return;

  await tx
    .select({ id: inventoryLevels.id })
    .from(inventoryLevels)
    .where(inArray(inventoryLevels.id, held.map((h) => h.inventoryLevelId)))
    .orderBy(asc(inventoryLevels.id))
    .for('update');

  await tx.execute(sql`
    WITH released AS (
      UPDATE inventory_reservations
         SET released_at = now()
       WHERE order_id = ${orderId} AND released_at IS NULL
      RETURNING inventory_level_id, quantity
    ), totals AS (
      SELECT inventory_level_id, sum(quantity) AS qty FROM released GROUP BY 1
    )
    UPDATE inventory_levels il
       SET reserved_qty = il.reserved_qty - t.qty,
           updated_at   = now()
      FROM totals t
     WHERE il.id = t.inventory_level_id`);
}

/**
 * §4.2 reversal — the redemption goes back into the pool.
 *
 * `redemption_count > 0` in the second statement stops a double-cancel driving
 * the counter negative, and `reversed_at IS NULL` makes the whole thing
 * idempotent: running it twice reverses nothing the second time.
 */
export async function reverseCouponRedemption(tx: Tx, orderId: string, reason: string): Promise<void> {
  const reversed = await tx
    .update(couponRedemptions)
    .set({ reversedAt: new Date(), reversalReason: reason })
    .where(and(eq(couponRedemptions.orderId, orderId), isNull(couponRedemptions.reversedAt)))
    .returning({ couponId: couponRedemptions.couponId });

  for (const row of reversed) {
    await tx
      .update(coupons)
      .set({ redemptionCount: sql`${coupons.redemptionCount} - 1`, updatedAt: new Date() })
      .where(sql`${coupons.id} = ${row.couponId} AND ${coupons.redemptionCount} > 0`);
  }
}

export async function insertTimelineEvent(
  tx: Tx,
  values: typeof orderTimeline.$inferInsert,
): Promise<void> {
  await tx.insert(orderTimeline).values(values);
}
