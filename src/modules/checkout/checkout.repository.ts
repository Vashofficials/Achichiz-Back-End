/**
 * Drizzle queries for checkout and order creation. No business rules, no HTTP.
 *
 * Three of these functions are the concurrency-critical ones from 03_schema.md
 * §4, and each carries its reasoning inline because getting any of them subtly
 * wrong loses money rather than throwing:
 *
 *  - `lockInventoryLevels`  — deterministic lock ordering, the deadlock guard.
 *  - `reserveStock`         — the conditional UPDATE that makes oversell
 *                             impossible at READ COMMITTED.
 *  - `claimCouponRedemption`— the conditional UPDATE whose row lock is also what
 *                             serialises the per-customer count that follows it.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  addresses,
  carts,
  couponRedemptions,
  coupons,
  customers,
  deliveryZonePincodes,
  deliveryZones,
  gstStates,
  inventoryLevels,
  inventoryReservations,
  orderLineAddOns,
  orderLinePersonalisations,
  orderLines,
  orderTimeline,
  orders,
  warehouses,
  type NewOrder,
  type NewOrderLine,
} from '../../db/schema/index.js';

/* ------------------------------------------------------------------ types */

export type DestinationRow = {
  pincode: string;
  city: string | null;
  stateCode: string | null;
  serviceable: boolean;
  codAllowed: boolean;
  zoneId: string;
  zoneName: string;
  zoneStatus: string;
  baseFeePaise: number;
  supportsSameDay: boolean;
  supportsMidnight: boolean;
  supportsCod: boolean;
  sameDayCutoff: string | null;
  standardTatDays: number | null;
};

export type AddressRow = typeof addresses.$inferSelect;

export type SupplyPointRow = {
  warehouseId: string;
  stateCode: string;
  gstin: string | null;
};

export type InventoryLevelRow = {
  id: string;
  variantId: string;
  warehouseId: string;
  availableQty: number;
};

/* --------------------------------------------------------- reference data */

export async function stateCodeExists(code: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec.select({ code: gstStates.code }).from(gstStates).where(eq(gstStates.code, code)).limit(1);
  return rows.length === 1;
}

/**
 * Serviceability and the zone's own base fee, in one lookup.
 *
 * `delivery_zone_pincodes.pincode` is the primary key precisely so this is O(1)
 * on the checkout path. An unknown PIN code returns null — which the service
 * treats identically to a suspended one, because to a shopper they are the same
 * answer.
 */
export async function findDestination(
  pincodeValue: string,
  exec: Executor = db,
): Promise<DestinationRow | null> {
  const rows = await exec
    .select({
      pincode: deliveryZonePincodes.pincode,
      city: deliveryZonePincodes.city,
      stateCode: deliveryZonePincodes.stateCode,
      serviceable: deliveryZonePincodes.isServiceable,
      codAllowed: deliveryZonePincodes.codAllowed,
      zoneId: deliveryZones.id,
      zoneName: deliveryZones.name,
      zoneStatus: deliveryZones.status,
      baseFeePaise: deliveryZones.baseFeePaise,
      supportsSameDay: deliveryZones.supportsSameDay,
      supportsMidnight: deliveryZones.supportsMidnight,
      supportsCod: deliveryZones.supportsCod,
      sameDayCutoff: deliveryZones.sameDayCutoff,
      standardTatDays: deliveryZones.standardTatDays,
    })
    .from(deliveryZonePincodes)
    .innerJoin(deliveryZones, eq(deliveryZonePincodes.zoneId, deliveryZones.id))
    .where(eq(deliveryZonePincodes.pincode, pincodeValue))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The place goods are supplied FROM. Its state code decides IGST vs CGST+SGST,
 * so it is frozen onto the order rather than looked up at read time.
 *
 * GST registration is state-wise (Q3 is still open on how many states HARIVON is
 * registered in), so this deliberately reads the warehouse rather than a
 * constant: when the second registration lands, this query starts returning a
 * different row and nothing else has to change.
 */
export async function findSupplyPoint(exec: Executor = db): Promise<SupplyPointRow | null> {
  const rows = await exec
    .select({ warehouseId: warehouses.id, stateCode: warehouses.stateCode, gstin: warehouses.gstin })
    .from(warehouses)
    .where(and(eq(warehouses.status, 'active'), isNull(warehouses.deletedAt)))
    .orderBy(sql`${warehouses.isDefault} DESC`, asc(warehouses.code))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------- addresses */

export async function findCustomerAddress(
  customerId: string,
  addressId: string,
  exec: Executor = db,
): Promise<AddressRow | null> {
  const rows = await exec
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.customerId, customerId), isNull(addresses.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Inserted with `is_default = false` on purpose. The `ensure_default_address()`
 * trigger promotes it when it is the customer's first, which keeps the
 * "first address becomes the default" rule true even after a delete — unlike the
 * storefront, which decides it client-side at insert time only.
 */
export async function insertAddress(
  input: typeof addresses.$inferInsert,
  exec: Executor = db,
): Promise<AddressRow> {
  const rows = await exec.insert(addresses).values({ ...input, isDefault: false }).returning();
  const row = rows[0];
  if (!row) throw new Error('address insert returned no row');
  return row;
}

export async function findCustomerProfile(
  customerId: string,
  exec: Executor = db,
): Promise<{ fullName: string | null; email: string | null; mobile: string | null } | null> {
  const rows = await exec
    .select({ fullName: customers.fullName, email: customers.email, mobile: customers.mobile })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------- inventory */

export async function findInventoryLevels(
  variantIds: readonly string[],
  exec: Executor = db,
): Promise<InventoryLevelRow[]> {
  if (variantIds.length === 0) return [];
  const rows = await exec
    .select({
      id: inventoryLevels.id,
      variantId: inventoryLevels.variantId,
      warehouseId: inventoryLevels.warehouseId,
      availableQty: sql<number>`coalesce(${inventoryLevels.availableQty}, 0)`,
    })
    .from(inventoryLevels)
    .innerJoin(warehouses, eq(inventoryLevels.warehouseId, warehouses.id))
    .where(
      and(
        inArray(inventoryLevels.variantId, [...variantIds]),
        eq(warehouses.status, 'active'),
        isNull(warehouses.deletedAt),
      ),
    );
  return rows.filter((r): r is InventoryLevelRow => r.variantId !== null);
}

/**
 * §4.1 deadlock guard.
 *
 * Without this, cart A holding SKU-1 and wanting SKU-2 deadlocks against cart B
 * holding SKU-2 and wanting SKU-1. PostgreSQL detects it and aborts one, but a
 * `deadlock_timeout` stall on the checkout path is not acceptable. Locking every
 * level this transaction will touch, in a single statement, in `id` order,
 * removes the possibility rather than handling it.
 */
export async function lockInventoryLevels(tx: Tx, levelIds: readonly string[]): Promise<void> {
  if (levelIds.length === 0) return;
  await tx
    .select({ id: inventoryLevels.id })
    .from(inventoryLevels)
    .where(inArray(inventoryLevels.id, [...levelIds]))
    .orderBy(asc(inventoryLevels.id))
    .for('update');
}

/**
 * §4.1 layer 2 — the mechanism, not the backstop.
 *
 * The availability test is folded INTO the write. Two concurrent checkouts for
 * the last unit: the second blocks on the row lock, and when the first commits
 * PostgreSQL re-evaluates this WHERE clause against the newly committed row
 * (EvalPlanQual) and updates zero rows. Race-free at READ COMMITTED, with no
 * SERIALIZABLE, no retry loop, and no reliance on catching the
 * `inventory_no_oversell` CHECK — code that catches that constraint is doing it
 * wrong.
 *
 * Returns false when there was not enough stock. Never throws for that reason.
 */
export async function reserveStock(tx: Tx, levelId: string, quantity: number): Promise<boolean> {
  const rows = await tx
    .update(inventoryLevels)
    .set({
      reservedQty: sql`${inventoryLevels.reservedQty} + ${quantity}`,
      updatedAt: new Date(),
      lastMovementAt: new Date(),
    })
    .where(
      and(
        eq(inventoryLevels.id, levelId),
        sql`${inventoryLevels.onHandQty} - ${inventoryLevels.reservedQty} >= ${quantity}`,
      ),
    )
    .returning({ id: inventoryLevels.id });
  return rows.length === 1;
}

/**
 * Order-backed holds. `reason = 'order'` with a NULL `expires_at` — the
 * `reservation_cart_expires` CHECK enforces that only cart holds expire, so an
 * order's stock is never swept away by the expiry job.
 */
export async function insertReservations(
  tx: Tx,
  orderId: string,
  rows: readonly { inventoryLevelId: string; quantity: number }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(inventoryReservations)
    .values(rows.map((r) => ({ ...r, orderId, reason: 'order' as const, expiresAt: null })));
}

/* ---------------------------------------------------------------- coupons */

/**
 * §4.2 — claim exactly one redemption.
 *
 * Zero rows means exhausted, expired, paused, or not yet started; the caller
 * cannot tell which from here and does not need to, because the readable reason
 * was already produced by the service's pre-check. What this UPDATE adds is
 * atomicity: the check and the increment are one statement, so a flash sale
 * cannot redeem a 8,000-cap coupon 8,050 times.
 *
 * The exclusive row lock it takes is held to COMMIT, which is also what makes
 * the per-customer count that follows it correct — that count is otherwise a
 * phantom-read problem with no single row to lock.
 */
export async function claimCouponRedemption(
  tx: Tx,
  couponId: string,
): Promise<{ maxRedemptionsPerCustomer: number } | null> {
  const rows = await tx
    .update(coupons)
    .set({ redemptionCount: sql`${coupons.redemptionCount} + 1`, updatedAt: new Date() })
    .where(
      sql`${coupons.id} = ${couponId}
        AND ${coupons.status} = 'active'
        AND now() >= ${coupons.startsAt}
        AND (${coupons.endsAt} IS NULL OR now() < ${coupons.endsAt})
        AND (${coupons.maxRedemptions} IS NULL OR ${coupons.redemptionCount} < ${coupons.maxRedemptions})`,
    )
    .returning({ maxRedemptionsPerCustomer: coupons.maxRedemptionsPerCustomer });
  return rows[0] ?? null;
}

export async function countCustomerRedemptionsForUpdate(
  tx: Tx,
  couponId: string,
  customerId: string,
): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(couponRedemptions)
    .where(
      and(
        eq(couponRedemptions.couponId, couponId),
        eq(couponRedemptions.customerId, customerId),
        isNull(couponRedemptions.reversedAt),
      ),
    );
  return rows[0]?.n ?? 0;
}

export async function insertCouponRedemption(
  tx: Tx,
  input: { couponId: string; orderId: string; customerId: string | null; discountPaise: number },
): Promise<void> {
  await tx.insert(couponRedemptions).values(input);
}

/* ---------------------------------------------------------- order numbers */

/**
 * §3.5 — the document-number series, not `Math.random()` and not a bare sequence.
 *
 * `next_document_number()` is a row-locked `UPDATE ... RETURNING` that
 * participates in this transaction: a concurrent checkout blocks on the series
 * row until we commit or roll back, so numbers are never issued twice and are
 * released on rollback. Called as LATE as possible — the lock is held from here
 * to COMMIT and serialises every other order being numbered.
 *
 * The 'order' series is not in the initial seed (which covers only the statutory
 * documents), so it is created on first use. `ON CONFLICT DO NOTHING` makes that
 * a no-op for every order after the first, and safe under concurrency: a second
 * transaction blocks on the unique index, then finds the row already there.
 * Shape `ACH100000`, which satisfies `orders.order_no ~ '^ACH[0-9]{6,}$'`.
 */
export async function nextOrderNumber(tx: Tx): Promise<string> {
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('order', '', 'ACH', '', 6, 100000)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ order_no: string }>(
    sql`SELECT next_document_number('order', '') AS order_no`,
  );
  const orderNo = result.rows[0]?.order_no;
  if (!orderNo) throw new Error('next_document_number returned no order number');
  return orderNo;
}

/* ----------------------------------------------------------------- orders */

export async function insertOrder(tx: Tx, values: NewOrder): Promise<{ id: string; placedAt: Date }> {
  const rows = await tx.insert(orders).values(values).returning({ id: orders.id, placedAt: orders.placedAt });
  const row = rows[0];
  if (!row) throw new Error('order insert returned no row');
  return row;
}

export async function insertOrderLines(tx: Tx, values: NewOrderLine[]): Promise<string[]> {
  if (values.length === 0) return [];
  const rows = await tx.insert(orderLines).values(values).returning({ id: orderLines.id });
  return rows.map((r) => r.id);
}

export async function insertOrderLineAddOns(
  tx: Tx,
  values: (typeof orderLineAddOns.$inferInsert)[],
): Promise<void> {
  if (values.length === 0) return;
  await tx.insert(orderLineAddOns).values(values);
}

export async function insertOrderLinePersonalisations(
  tx: Tx,
  values: (typeof orderLinePersonalisations.$inferInsert)[],
): Promise<void> {
  if (values.length === 0) return;
  await tx.insert(orderLinePersonalisations).values(values);
}

export async function insertTimelineEvent(
  tx: Tx,
  values: typeof orderTimeline.$inferInsert,
): Promise<void> {
  await tx.insert(orderTimeline).values(values);
}

export async function markCartConverted(tx: Tx, cartId: string, orderId: string): Promise<void> {
  await tx
    .update(carts)
    .set({ stage: 'converted', convertedOrderId: orderId, updatedAt: new Date() })
    .where(eq(carts.id, cartId));
}
