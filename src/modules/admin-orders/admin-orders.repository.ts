/**
 * Drizzle queries for the order desk. No business rules, no HTTP.
 *
 * A note on the two functions that look like duplicates of
 * `modules/orders/orders.repository.ts` — `releaseReservations` and
 * `reverseCouponRedemption`. They are, deliberately. The module boundary this
 * codebase enforces is "a service may call another module's SERVICE, never its
 * repository", and the customer-side cancel service is not reusable here: it
 * takes a `customerId`, applies the customer's narrower cancellable set, and
 * writes a `customer` actor onto the timeline. Importing its repository would
 * break the boundary; wrapping the whole customer flow would apply the wrong
 * rules. The SQL is the same because the physical operation is the same.
 */

import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  couponRedemptions,
  coupons,
  couriers,
  documentNumberSeries,
  inventoryLevels,
  inventoryReservations,
  invoiceLines,
  invoices,
  orderLineAddOns,
  orderLinePersonalisations,
  orderLines,
  orderTimeline,
  orders,
  payments,
  refunds,
  shipments,
  warehouses,
  type Order,
  type OrderStatus,
} from '../../db/schema/index.js';

export type AdminOrderListRow = {
  order: Order;
  itemCount: number;
  lineCount: number;
  awb: string | null;
  courierName: string | null;
};

/**
 * The outer order id, written out in full: `orders.id`, never `${orders.id}`.
 *
 * Selecting a whole table (`.select({ order: orders })`) makes Drizzle emit the
 * columns UNQUALIFIED — `select "id", "order_no", …` — and it then renders
 * `${orders.id}` unqualified inside these correlated subqueries too. In
 * `latestCourier`, which joins `shipments s` to `couriers c`, a bare `id`
 * matches both and Postgres refuses the whole statement with
 * `column reference "id" is ambiguous`. The other three subqueries have only
 * one table each and got away with it, which is exactly why this is qualified
 * everywhere rather than only where it happened to break.
 */
const outerOrderId = sql.raw('orders.id');

const itemCount = sql<number>`coalesce((
  SELECT sum(ol.quantity)::int FROM order_lines ol
   WHERE ol.order_id = ${outerOrderId} AND ol.fulfilment_status <> 'cancelled'), 0)`;

const lineCount = sql<number>`coalesce((
  SELECT count(*)::int FROM order_lines ol WHERE ol.order_id = ${outerOrderId}), 0)`;

const latestAwb = sql<string | null>`(
  SELECT s.awb FROM shipments s
   WHERE s.order_id = ${outerOrderId} AND s.awb IS NOT NULL
   ORDER BY s.created_at DESC LIMIT 1)`;

const latestCourier = sql<string | null>`(
  SELECT c.name FROM shipments s JOIN couriers c ON c.id = s.courier_id
   WHERE s.order_id = ${outerOrderId}
   ORDER BY s.created_at DESC LIMIT 1)`;

/* ------------------------------------------------------------------ list */

export async function listOrders(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<{ rows: AdminOrderListRow[]; total: number }> {
  const rows = await exec
    .select({ order: orders, itemCount, lineCount, awb: latestAwb, courierName: latestCourier })
    .from(orders)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const counted = await exec.select({ n: sql<number>`count(*)::int` }).from(orders).where(where);

  return { rows, total: counted[0]?.n ?? 0 };
}

/**
 * The KPI strip above the list, computed over the SAME filter set as the list.
 *
 * The console computes these client-side from whatever page happens to be
 * loaded, which makes "order value" mean "order value of these ten rows".
 */
export async function orderKpis(
  where: SQL | undefined,
  exec: Executor = db,
): Promise<{
  orderCount: number;
  grossValuePaise: number;
  deliveredCount: number;
  inFulfilmentCount: number;
  openExceptionCount: number;
}> {
  const rows = await exec
    .select({
      orderCount: sql<number>`count(*)::int`,
      grossValuePaise: sql<number>`coalesce(sum(${orders.totalPaise}), 0)::bigint`,
      deliveredCount: sql<number>`count(*) FILTER (WHERE ${orders.status} = 'delivered')::int`,
      inFulfilmentCount: sql<number>`count(*) FILTER (WHERE ${orders.status} IN
        ('paid','confirmed','in_production','personalisation_pending','quality_check','packed','ready_to_ship'))::int`,
      openExceptionCount: sql<number>`count(*) FILTER (WHERE ${orders.status} IN
        ('failed_delivery','rto'))::int`,
    })
    .from(orders)
    .where(where);

  return (
    rows[0] ?? {
      orderCount: 0,
      grossValuePaise: 0,
      deliveredCount: 0,
      inFulfilmentCount: 0,
      openExceptionCount: 0,
    }
  );
}

/* ---------------------------------------------------------------- detail */

export async function findOrder(orderId: string, exec: Executor = db): Promise<AdminOrderListRow | null> {
  const rows = await exec
    .select({ order: orders, itemCount, lineCount, awb: latestAwb, courierName: latestCourier })
    .from(orders)
    .where(eq(orders.id, orderId))
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
  return exec.select().from(orderLineAddOns).where(inArray(orderLineAddOns.orderLineId, [...lineIds]));
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
    .select()
    .from(orderTimeline)
    .where(eq(orderTimeline.orderId, orderId))
    .orderBy(asc(orderTimeline.occurredAt), asc(orderTimeline.id));
}

export async function findPayments(orderId: string, exec: Executor = db) {
  return exec
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.createdAt));
}

export async function findRefunds(orderId: string, exec: Executor = db) {
  return exec.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(desc(refunds.createdAt));
}

export async function findShipments(orderId: string, exec: Executor = db) {
  return exec
    .select({ shipment: shipments, courierName: couriers.name })
    .from(shipments)
    .leftJoin(couriers, eq(couriers.id, shipments.courierId))
    .where(eq(shipments.orderId, orderId))
    .orderBy(desc(shipments.createdAt));
}

export async function findInvoices(orderId: string, exec: Executor = db) {
  return exec.select().from(invoices).where(eq(invoices.orderId, orderId)).orderBy(desc(invoices.issuedAt));
}

/* ----------------------------------------------------------------- writes */

export async function lockOrder(tx: Tx, orderId: string): Promise<Order | null> {
  const rows = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1);
  return rows[0] ?? null;
}

export async function updateOrder(
  tx: Tx,
  orderId: string,
  patch: Partial<{
    status: OrderStatus;
    confirmedAt: Date | null;
    shippedAt: Date | null;
    deliveredAt: Date | null;
    cancelledAt: Date | null;
    cancelReason: string | null;
    priority: string;
    internalNotes: string | null;
    fulfilmentWarehouseId: string | null;
  }>,
): Promise<void> {
  await tx
    .update(orders)
    .set({ ...(patch as Record<string, unknown>), updatedAt: new Date() })
    .where(eq(orders.id, orderId));
}

export async function insertTimelineEvent(
  exec: Executor,
  values: typeof orderTimeline.$inferInsert,
): Promise<void> {
  await exec.insert(orderTimeline).values(values);
}

/** See the file header: intentionally parallel to the customer-side implementation. */
export async function releaseReservations(tx: Tx, orderId: string): Promise<void> {
  const held = await tx
    .select({ inventoryLevelId: inventoryReservations.inventoryLevelId })
    .from(inventoryReservations)
    .where(and(eq(inventoryReservations.orderId, orderId), isNull(inventoryReservations.releasedAt)));

  if (held.length === 0) return;

  // Pre-lock in id order, the same protocol checkout uses, so a cancellation and
  // a checkout touching the same SKUs queue instead of deadlocking.
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

/* -------------------------------------------------------------- invoices */

/**
 * Next number from the statutory series, under a row lock.
 *
 * `UPDATE ... RETURNING` on the series row is what serialises concurrent invoice
 * generation. A gap in an invoice series is a compliance problem, so the caller
 * must be inside the transaction that writes the invoice.
 */
export async function nextInvoiceNumber(
  tx: Tx,
  financialYear: string,
): Promise<{ seriesId: string; invoiceNo: string } | null> {
  const rows = await tx
    .select()
    .from(documentNumberSeries)
    .where(
      and(
        eq(documentNumberSeries.docType, 'invoice'),
        eq(documentNumberSeries.scopeKey, financialYear),
        eq(documentNumberSeries.isActive, true),
      ),
    )
    .for('update')
    .limit(1);

  const series = rows[0];
  if (!series) return null;

  await tx
    .update(documentNumberSeries)
    .set({ nextValue: series.nextValue + 1, updatedAt: new Date() })
    .where(eq(documentNumberSeries.id, series.id));

  const padded = String(series.nextValue).padStart(series.padWidth, '0');
  return { seriesId: series.id, invoiceNo: `${series.prefix}${padded}${series.suffix}` };
}

export async function findIssuedInvoice(orderId: string, exec: Executor = db) {
  const rows = await exec
    .select()
    .from(invoices)
    .where(and(eq(invoices.orderId, orderId), eq(invoices.status, 'issued')))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertInvoice(
  tx: Tx,
  values: typeof invoices.$inferInsert,
): Promise<{ id: string; invoiceNo: string }> {
  const rows = await tx
    .insert(invoices)
    .values(values)
    .returning({ id: invoices.id, invoiceNo: invoices.invoiceNo });
  const row = rows[0];
  if (!row) throw new Error('invoice insert returned nothing');
  return row;
}

export async function insertInvoiceLines(
  tx: Tx,
  values: (typeof invoiceLines.$inferInsert)[],
): Promise<void> {
  if (values.length === 0) return;
  await tx.insert(invoiceLines).values(values);
}

/* ------------------------------------------------------------- shipments */

export async function findCourier(courierId: string, exec: Executor = db) {
  const rows = await exec.select().from(couriers).where(eq(couriers.id, courierId)).limit(1);
  return rows[0] ?? null;
}

export async function defaultWarehouseId(exec: Executor = db): Promise<string | null> {
  const rows = await exec
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.isDefault, true), isNull(warehouses.deletedAt)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function findOpenShipment(orderId: string, exec: Executor = db) {
  const rows = await exec
    .select()
    .from(shipments)
    .where(and(eq(shipments.orderId, orderId), eq(shipments.status, 'label_created')))
    .orderBy(desc(shipments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertShipment(
  tx: Tx,
  values: typeof shipments.$inferInsert,
): Promise<{ id: string; shipmentNo: string }> {
  const rows = await tx
    .insert(shipments)
    .values(values)
    .returning({ id: shipments.id, shipmentNo: shipments.shipmentNo });
  const row = rows[0];
  if (!row) throw new Error('shipment insert returned nothing');
  return row;
}

export async function assignShipmentCourier(
  tx: Tx,
  shipmentId: string,
  courierId: string,
): Promise<void> {
  await tx
    .update(shipments)
    .set({ courierId, updatedAt: new Date() })
    .where(eq(shipments.id, shipmentId));
}

/** AWB search on the list screen, as an EXISTS rather than a join that fans rows out. */
export const awbMatches = (pattern: string): SQL =>
  sql`EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = ${orders.id} AND s.awb ILIKE ${pattern})`;
