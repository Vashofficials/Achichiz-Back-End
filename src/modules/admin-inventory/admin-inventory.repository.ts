/**
 * Drizzle queries for inventory core. No business rules, no HTTP.
 *
 * Three things about this file are worth knowing before reading it.
 *
 * **1. `inventory_levels` is polymorphic.** A row points at exactly one of
 * `variant_id`, `hamper_item_id` or `packaging_id` (CHECK
 * `inventory_exactly_one_stockable`). Every read here therefore LEFT JOINs all
 * three target tables and coalesces a `kind` / `id` / `sku` / `name` projection
 * out of them, so the rest of the module can treat a level as "an item in a
 * warehouse" without three code paths.
 *
 * **2. `location_id` is selected as raw SQL.** Migration `0003_inventory.sql`
 * added it to the table; the Drizzle model in `db/schema/inventory.ts` has not
 * been regenerated and this module must not edit `db/**`. The migration is the
 * authoritative artifact (see the schema README), so the column is read through a
 * `sql` fragment naming it explicitly rather than pretended out of existence.
 *
 * **3. The oversell guard lives in `applyOnHandDelta` and `reserveStock`.** Both
 * fold the availability test INTO the write and report zero-rows-affected to the
 * caller. Neither catches a CHECK violation — code that catches
 * `inventory_no_oversell` is doing it wrong, per the header of the schema file.
 */

import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  activityLogs,
  documentNumberSeries,
  hamperItems,
  inventoryLevels,
  inventoryReservations,
  notifications,
  packagingMaterials,
  productVariants,
  products,
  purchaseOrderLines,
  purchaseOrders,
  stockMovements,
  supplierProducts,
  suppliers,
  warehouses,
  type StockMovementType,
} from '../../db/schema/index.js';
import type { ReferenceType, StockableKind } from './admin-inventory.schemas.js';

/* ------------------------------------------------------------ projections */

/** Which of the three polymorphic targets this level points at. */
export const itemKindExpr = sql<StockableKind>`
  CASE WHEN ${inventoryLevels.variantId} IS NOT NULL THEN 'variant'
       WHEN ${inventoryLevels.hamperItemId} IS NOT NULL THEN 'hamper_item'
       ELSE 'packaging' END`;

export const itemIdExpr = sql<string>`
  coalesce(${inventoryLevels.variantId}, ${inventoryLevels.hamperItemId}, ${inventoryLevels.packagingId})`;

export const itemSkuExpr = sql<string>`
  coalesce(${productVariants.sku}, ${hamperItems.sku}, ${packagingMaterials.sku})`;

/**
 * A variant's display name is its product title plus the option label — except
 * for the default option, where 'Cork Diary — Standard' reads like a mistake.
 */
export const itemNameExpr = sql<string>`
  coalesce(
    CASE WHEN ${productVariants.id} IS NULL THEN NULL
         WHEN ${productVariants.optionLabel} = 'Standard' THEN ${products.title}
         ELSE ${products.title} || ' — ' || ${productVariants.optionLabel} END,
    ${hamperItems.name},
    ${packagingMaterials.name})`;

/** Nullable on purpose: an item with no recorded cost contributes 0 to valuation, never a guess. */
export const unitCostExpr = sql<number | null>`
  coalesce(${productVariants.costPaise}, ${hamperItems.costPaise}, ${packagingMaterials.costPaise})`;

export const stockValueExpr = sql<number>`
  (${inventoryLevels.onHandQty} * coalesce(${productVariants.costPaise}, ${hamperItems.costPaise}, ${packagingMaterials.costPaise}, 0))::bigint`;

/** See the file header: present in the database since 0003, absent from the Drizzle model. */
export const locationIdExpr = sql<string | null>`inventory_levels.location_id`;

/** `on_hand - reserved + incoming`. What a buying decision is actually made against. */
export const inventoryPositionExpr = sql<number>`
  (${inventoryLevels.onHandQty} - ${inventoryLevels.reservedQty} + ${inventoryLevels.incomingQty})::int`;

/** A reservation is only consuming stock while it is unreleased AND unexpired. */
export const reservationIsActive = sql`
  ${inventoryReservations.releasedAt} IS NULL
  AND (${inventoryReservations.expiresAt} IS NULL OR ${inventoryReservations.expiresAt} > now())`;

const levelSelection = {
  id: inventoryLevels.id,
  itemKind: itemKindExpr,
  itemId: itemIdExpr,
  sku: itemSkuExpr,
  name: itemNameExpr,
  warehouseId: inventoryLevels.warehouseId,
  warehouseCode: warehouses.code,
  warehouseName: warehouses.name,
  binLocation: inventoryLevels.binLocation,
  locationId: locationIdExpr,
  onHandQty: inventoryLevels.onHandQty,
  reservedQty: inventoryLevels.reservedQty,
  availableQty: inventoryLevels.availableQty,
  incomingQty: inventoryLevels.incomingQty,
  reorderPoint: inventoryLevels.reorderPoint,
  reorderQty: inventoryLevels.reorderQty,
  unitCostPaise: unitCostExpr,
  stockValuePaise: stockValueExpr,
  lastMovementAt: inventoryLevels.lastMovementAt,
} as const;

export type LevelRow = {
  id: string;
  itemKind: StockableKind;
  itemId: string;
  sku: string;
  name: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  binLocation: string | null;
  locationId: string | null;
  onHandQty: number;
  reservedQty: number;
  availableQty: number | null;
  incomingQty: number;
  reorderPoint: number;
  reorderQty: number;
  unitCostPaise: number | null;
  stockValuePaise: number;
  lastMovementAt: Date | null;
};

/* ------------------------------------------------------------ sortable SQL */

/**
 * Sort targets, exported so the SERVICE composes the ORDER BY through
 * `parseSort`'s allowlist and the repository never sees a raw field name. Same
 * discipline as `admin-orders`: a sort field is matched, never passed through.
 */
export const SORTABLE = {
  sku: itemSkuExpr,
  name: itemNameExpr,
  onHandQty: sql`${inventoryLevels.onHandQty}`,
  reservedQty: sql`${inventoryLevels.reservedQty}`,
  availableQty: sql`${inventoryLevels.availableQty}`,
  incomingQty: sql`${inventoryLevels.incomingQty}`,
  lastMovementAt: sql`${inventoryLevels.lastMovementAt}`,
  warehouse: sql`${warehouses.code}`,
  shortfallQty: sql`(${inventoryLevels.reorderPoint} + ${inventoryLevels.reorderQty} - (${inventoryLevels.onHandQty} - ${inventoryLevels.reservedQty} + ${inventoryLevels.incomingQty}))`,
} as const;

export const orderByFor = (expr: SQL, direction: 'asc' | 'desc'): SQL =>
  direction === 'desc' ? sql`${expr} DESC NULLS LAST` : sql`${expr} ASC NULLS LAST`;

/* ------------------------------------------------------------- predicates */

export const matchesSku = (sku: string): SQL =>
  sql`coalesce(${productVariants.sku}, ${hamperItems.sku}, ${packagingMaterials.sku}) = ${sku}`;

export const matchesText = (pattern: string): SQL | undefined =>
  or(
    ilike(itemSkuExpr, pattern),
    ilike(itemNameExpr, pattern),
  );

export const kindIs = (kind: StockableKind): SQL => {
  if (kind === 'variant') return sql`${inventoryLevels.variantId} IS NOT NULL`;
  if (kind === 'hamper_item') return sql`${inventoryLevels.hamperItemId} IS NOT NULL`;
  return sql`${inventoryLevels.packagingId} IS NOT NULL`;
};

export const stateIs = (state: 'in' | 'low' | 'out'): SQL => {
  if (state === 'out') return sql`${inventoryLevels.availableQty} <= 0`;
  if (state === 'low')
    return sql`${inventoryLevels.availableQty} > 0 AND ${inventoryLevels.availableQty} <= ${inventoryLevels.reorderPoint}`;
  return sql`${inventoryLevels.availableQty} > ${inventoryLevels.reorderPoint}`;
};

/** The buying queue: inventory POSITION, not on-hand, against the reorder point. */
export const atOrBelowReorderPoint = (): SQL =>
  sql`(${inventoryLevels.onHandQty} - ${inventoryLevels.reservedQty} + ${inventoryLevels.incomingQty}) <= ${inventoryLevels.reorderPoint}
      AND ${inventoryLevels.reorderPoint} > 0`;

export const locationIs = (locationId: string): SQL => sql`inventory_levels.location_id = ${locationId}`;

/* ------------------------------------------------------------------- reads */

export async function listLevels(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<LevelRow[]> {
  return exec
    .select(levelSelection)
    .from(inventoryLevels)
    .innerJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);
}

export async function countLevels(where: SQL | undefined, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryLevels)
    .innerJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .where(where);
  return rows[0]?.n ?? 0;
}

export type ResolvedItem = { kind: StockableKind; id: string; sku: string; name: string };

/**
 * SKU → stockable, checking the three catalogues in a fixed order.
 *
 * Variants first because that is what an operator means by "SKU" nine times out
 * of ten. Each table has its own partial-unique index on `sku WHERE deleted_at IS
 * NULL`, so a soft-deleted item never shadows a live one; a live SKU that also
 * exists as a soft-deleted row in another table still resolves.
 */
export async function resolveSku(sku: string, exec: Executor = db): Promise<ResolvedItem | null> {
  const variant = await exec
    .select({ id: productVariants.id, sku: productVariants.sku, title: products.title, option: productVariants.optionLabel })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(productVariants.sku, sku), isNull(productVariants.deletedAt)))
    .limit(1);
  const v = variant[0];
  if (v) {
    return {
      kind: 'variant',
      id: v.id,
      sku: v.sku,
      name: v.option === 'Standard' ? v.title : `${v.title} — ${v.option}`,
    };
  }

  const hamper = await exec
    .select({ id: hamperItems.id, sku: hamperItems.sku, name: hamperItems.name })
    .from(hamperItems)
    .where(and(eq(hamperItems.sku, sku), isNull(hamperItems.deletedAt)))
    .limit(1);
  const h = hamper[0];
  if (h) return { kind: 'hamper_item', id: h.id, sku: h.sku, name: h.name };

  const packaging = await exec
    .select({ id: packagingMaterials.id, sku: packagingMaterials.sku, name: packagingMaterials.name })
    .from(packagingMaterials)
    .where(and(eq(packagingMaterials.sku, sku), isNull(packagingMaterials.deletedAt)))
    .limit(1);
  const p = packaging[0];
  if (p) return { kind: 'packaging', id: p.id, sku: p.sku, name: p.name };

  return null;
}

/**
 * Batch SKU resolution for bulk operations.
 *
 * `resolveSku` in a loop is up to three round trips per line; a 200-line batch
 * would be 600 queries before a single row is locked, and every one of those is
 * time the batch is NOT holding its locks — which is the good kind of slow, but
 * still 600 queries. This is three, whatever the batch size.
 */
export async function resolveSkus(
  skus: readonly string[],
  exec: Executor = db,
): Promise<Map<string, ResolvedItem>> {
  const found = new Map<string, ResolvedItem>();
  const wanted = [...new Set(skus)];
  if (wanted.length === 0) return found;

  const variants = await exec
    .select({ id: productVariants.id, sku: productVariants.sku, title: products.title, option: productVariants.optionLabel })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(inArray(productVariants.sku, wanted), isNull(productVariants.deletedAt)));
  for (const v of variants) {
    found.set(v.sku, {
      kind: 'variant',
      id: v.id,
      sku: v.sku,
      name: v.option === 'Standard' ? v.title : `${v.title} — ${v.option}`,
    });
  }

  const remainingAfterVariants = wanted.filter((s) => !found.has(s));
  if (remainingAfterVariants.length > 0) {
    const hampers = await exec
      .select({ id: hamperItems.id, sku: hamperItems.sku, name: hamperItems.name })
      .from(hamperItems)
      .where(and(inArray(hamperItems.sku, remainingAfterVariants), isNull(hamperItems.deletedAt)));
    for (const h of hampers) found.set(h.sku, { kind: 'hamper_item', id: h.id, sku: h.sku, name: h.name });
  }

  const remaining = wanted.filter((s) => !found.has(s));
  if (remaining.length > 0) {
    const packs = await exec
      .select({ id: packagingMaterials.id, sku: packagingMaterials.sku, name: packagingMaterials.name })
      .from(packagingMaterials)
      .where(and(inArray(packagingMaterials.sku, remaining), isNull(packagingMaterials.deletedAt)));
    for (const p of packs) found.set(p.sku, { kind: 'packaging', id: p.id, sku: p.sku, name: p.name });
  }

  return found;
}

/**
 * Every level for a set of items across a set of warehouses, in one query.
 *
 * Keyed `kind:itemId:warehouseId` by the caller. Three `IN` lists rather than a
 * per-pair OR chain, because a 200-line batch would otherwise build a WHERE
 * clause with 200 disjuncts and no index would survive it.
 */
export async function findLevelsForItems(
  items: readonly ResolvedItem[],
  warehouseIds: readonly string[],
  exec: Executor = db,
): Promise<{ id: string; variantId: string | null; hamperItemId: string | null; packagingId: string | null; warehouseId: string }[]> {
  if (items.length === 0 || warehouseIds.length === 0) return [];

  const variantIds = items.filter((i) => i.kind === 'variant').map((i) => i.id);
  const hamperIds = items.filter((i) => i.kind === 'hamper_item').map((i) => i.id);
  const packagingIds = items.filter((i) => i.kind === 'packaging').map((i) => i.id);

  const targets = [
    variantIds.length > 0 ? inArray(inventoryLevels.variantId, variantIds) : undefined,
    hamperIds.length > 0 ? inArray(inventoryLevels.hamperItemId, hamperIds) : undefined,
    packagingIds.length > 0 ? inArray(inventoryLevels.packagingId, packagingIds) : undefined,
  ].filter((t): t is SQL => Boolean(t));

  return exec
    .select({
      id: inventoryLevels.id,
      variantId: inventoryLevels.variantId,
      hamperItemId: inventoryLevels.hamperItemId,
      packagingId: inventoryLevels.packagingId,
      warehouseId: inventoryLevels.warehouseId,
    })
    .from(inventoryLevels)
    .where(and(or(...targets), inArray(inventoryLevels.warehouseId, [...warehouseIds])));
}

/** The polymorphic FK predicate for one resolved item. */
export const itemIs = (item: ResolvedItem): SQL => {
  if (item.kind === 'variant') return eq(inventoryLevels.variantId, item.id);
  if (item.kind === 'hamper_item') return eq(inventoryLevels.hamperItemId, item.id);
  return eq(inventoryLevels.packagingId, item.id);
};

export async function findLevelsForItem(
  item: ResolvedItem,
  warehouseId: string | undefined,
  exec: Executor = db,
): Promise<LevelRow[]> {
  const where = warehouseId ? and(itemIs(item), eq(inventoryLevels.warehouseId, warehouseId)) : itemIs(item);
  return listLevels(where, [orderByFor(SORTABLE.warehouse, 'asc')], 200, 0, exec);
}

export async function findLevelId(
  item: ResolvedItem,
  warehouseId: string,
  exec: Executor = db,
): Promise<string | null> {
  const rows = await exec
    .select({ id: inventoryLevels.id })
    .from(inventoryLevels)
    .where(and(itemIs(item), eq(inventoryLevels.warehouseId, warehouseId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/* ------------------------------------------------------------- movements */

const movementSelection = {
  id: stockMovements.id,
  inventoryLevelId: stockMovements.inventoryLevelId,
  itemKind: itemKindExpr,
  itemId: itemIdExpr,
  sku: itemSkuExpr,
  name: itemNameExpr,
  warehouseId: inventoryLevels.warehouseId,
  warehouseCode: warehouses.code,
  movementType: stockMovements.movementType,
  quantityDelta: stockMovements.quantityDelta,
  balanceAfter: stockMovements.balanceAfter,
  referenceType: stockMovements.referenceType,
  referenceId: stockMovements.referenceId,
  referenceLabel: stockMovements.referenceLabel,
  note: stockMovements.note,
  actorId: stockMovements.actorId,
  occurredAt: stockMovements.occurredAt,
} as const;

export type MovementRow = {
  id: bigint;
  inventoryLevelId: string;
  itemKind: StockableKind;
  itemId: string;
  sku: string;
  name: string;
  warehouseId: string;
  warehouseCode: string;
  movementType: string;
  quantityDelta: number;
  balanceAfter: number;
  referenceType: string | null;
  referenceId: string | null;
  referenceLabel: string | null;
  note: string | null;
  actorId: string | null;
  occurredAt: Date;
};

export const MOVEMENT_SORTABLE = {
  occurredAt: sql`${stockMovements.occurredAt}`,
  quantityDelta: sql`${stockMovements.quantityDelta}`,
  id: sql`${stockMovements.id}`,
} as const;

export const movementMatchesText = (pattern: string): SQL | undefined =>
  or(ilike(itemSkuExpr, pattern), ilike(itemNameExpr, pattern), ilike(stockMovements.referenceLabel, pattern));

export async function listMovements(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<MovementRow[]> {
  return exec
    .select(movementSelection)
    .from(stockMovements)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, stockMovements.inventoryLevelId))
    .innerJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);
}

export async function countMovements(where: SQL | undefined, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(stockMovements)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, stockMovements.inventoryLevelId))
    .innerJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .where(where);
  return rows[0]?.n ?? 0;
}

export async function findMovement(id: bigint, exec: Executor = db): Promise<MovementRow | null> {
  const rows = await listMovements(eq(stockMovements.id, id), [], 1, 0, exec);
  return rows[0] ?? null;
}

/* ---------------------------------------------------------------- writes */

/**
 * §4.1 deadlock guard, and the read the adjustment maths runs against.
 *
 * Locks every level this transaction will touch in ONE statement, in ascending
 * `id` order — the same protocol `checkout.repository.lockInventoryLevels` uses,
 * so a bulk adjustment and a checkout contending for the same SKUs queue instead
 * of deadlocking. Without a deterministic order, batch A holding level 1 and
 * wanting level 2 deadlocks against batch B holding 2 and wanting 1; PostgreSQL
 * would detect it and abort one, but a `deadlock_timeout` stall is not an
 * acceptable way to find out.
 *
 * Returns the locked rows keyed by id, so the caller reads a snapshot nobody else
 * can change until this transaction commits.
 */
export async function lockLevels(
  tx: Tx,
  levelIds: readonly string[],
): Promise<Map<string, { onHandQty: number; reservedQty: number }>> {
  if (levelIds.length === 0) return new Map();

  const rows = await tx
    .select({
      id: inventoryLevels.id,
      onHandQty: inventoryLevels.onHandQty,
      reservedQty: inventoryLevels.reservedQty,
    })
    .from(inventoryLevels)
    .where(inArray(inventoryLevels.id, [...levelIds]))
    .orderBy(asc(inventoryLevels.id))
    .for('update');

  return new Map(rows.map((r) => [r.id, { onHandQty: r.onHandQty, reservedQty: r.reservedQty }]));
}

/**
 * §4.1 layer 2 — THE oversell guard. The mechanism, not the backstop.
 *
 * The availability test is folded INTO the write: `on_hand - reserved + delta >= 0`.
 * Two concurrent decrements of the last unit — the second blocks on the row lock,
 * and when the first commits PostgreSQL re-evaluates this WHERE clause against the
 * newly committed row (EvalPlanQual) and updates ZERO rows. Race-free at READ
 * COMMITTED, with no SERIALIZABLE, no retry loop, and no reliance on catching the
 * `inventory_no_oversell` CHECK — that constraint exists to make an oversold row
 * unrepresentable, not to be used as flow control.
 *
 * The clause is applied to increments too, where it passes trivially, so there is
 * exactly ONE write path into `on_hand_qty` and no branch that could skip the test.
 *
 * Returns null when nothing was updated — the caller MUST treat that as
 * `insufficient_stock`, never as a no-op.
 */
export async function applyOnHandDelta(
  tx: Tx,
  levelId: string,
  quantityDelta: number,
  at: Date,
): Promise<{ onHandQty: number; reservedQty: number } | null> {
  const rows = await tx
    .update(inventoryLevels)
    .set({
      onHandQty: sql`${inventoryLevels.onHandQty} + ${quantityDelta}`,
      lastMovementAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(inventoryLevels.id, levelId),
        sql`${inventoryLevels.onHandQty} - ${inventoryLevels.reservedQty} + ${quantityDelta} >= 0`,
      ),
    )
    .returning({ onHandQty: inventoryLevels.onHandQty, reservedQty: inventoryLevels.reservedQty });

  return rows[0] ?? null;
}

export type NewMovement = {
  inventoryLevelId: string;
  movementType: string;
  quantityDelta: number;
  balanceAfter: number;
  referenceType?: ReferenceType | undefined;
  referenceId?: string | undefined;
  referenceLabel?: string | undefined;
  note?: string | undefined;
  actorId: string;
  occurredAt: Date;
};

/**
 * Append one row to the ledger. There is no update and no delete, here or
 * anywhere — §10. A correction is a NEW movement with the opposite sign.
 *
 * The two casts are the documented consequence of migration 0003 widening the
 * movement and reference vocabularies while the Drizzle `$type<>` annotations in
 * `db/schema/inventory.ts` still carry the narrower 0001 unions. The values are
 * validated against the LIVE constraint by the zod enums in
 * `admin-inventory.schemas.ts`, so the cast asserts something already checked —
 * it is not widening an unvalidated string.
 */
export async function insertMovement(tx: Tx, values: NewMovement): Promise<{ id: bigint; occurredAt: Date }> {
  const rows = await tx
    .insert(stockMovements)
    .values({
      inventoryLevelId: values.inventoryLevelId,
      movementType: values.movementType as StockMovementType,
      quantityDelta: values.quantityDelta,
      balanceAfter: values.balanceAfter,
      referenceType: (values.referenceType ?? null),
      referenceId: values.referenceId ?? null,
      referenceLabel: values.referenceLabel ?? null,
      note: values.note ?? null,
      actorId: values.actorId,
      occurredAt: values.occurredAt,
    })
    .returning({ id: stockMovements.id, occurredAt: stockMovements.occurredAt });

  const row = rows[0];
  if (!row) throw new Error('stock movement insert returned nothing');
  return row;
}

/* ----------------------------------------------------------- reservations */

/**
 * The same conditional-UPDATE guard, applied to `reserved_qty`.
 *
 * `on_hand_qty` is deliberately NOT touched: the units have not moved, they are
 * only spoken for. No `stock_movements` row is written either — see the service.
 */
export async function reserveStock(tx: Tx, levelId: string, quantity: number, at: Date): Promise<boolean> {
  const rows = await tx
    .update(inventoryLevels)
    .set({ reservedQty: sql`${inventoryLevels.reservedQty} + ${quantity}`, updatedAt: at })
    .where(
      and(
        eq(inventoryLevels.id, levelId),
        sql`${inventoryLevels.onHandQty} - ${inventoryLevels.reservedQty} >= ${quantity}`,
      ),
    )
    .returning({ id: inventoryLevels.id });
  return rows.length === 1;
}

export async function insertReservation(
  tx: Tx,
  values: { inventoryLevelId: string; quantity: number; expiresAt: Date | null },
): Promise<{ id: string; createdAt: Date }> {
  const rows = await tx
    .insert(inventoryReservations)
    .values({
      inventoryLevelId: values.inventoryLevelId,
      quantity: values.quantity,
      // `manual_hold` is the only reason an admin-created hold may carry: the
      // `reservation_has_owner` CHECK demands a cart or an order for every other
      // reason, and this endpoint has neither.
      reason: 'manual_hold',
      expiresAt: values.expiresAt,
    })
    .returning({ id: inventoryReservations.id, createdAt: inventoryReservations.createdAt });

  const row = rows[0];
  if (!row) throw new Error('reservation insert returned nothing');
  return row;
}

/**
 * Claim the release. `released_at IS NULL` in the WHERE is what makes a double
 * release a no-op instead of a double decrement of `reserved_qty`.
 */
export async function markReservationReleased(
  tx: Tx,
  reservationId: string,
  at: Date,
): Promise<{ inventoryLevelId: string; quantity: number } | null> {
  const rows = await tx
    .update(inventoryReservations)
    .set({ releasedAt: at })
    .where(and(eq(inventoryReservations.id, reservationId), isNull(inventoryReservations.releasedAt)))
    .returning({
      inventoryLevelId: inventoryReservations.inventoryLevelId,
      quantity: inventoryReservations.quantity,
    });
  return rows[0] ?? null;
}

export async function releaseReservedQty(tx: Tx, levelId: string, quantity: number, at: Date): Promise<boolean> {
  const rows = await tx
    .update(inventoryLevels)
    .set({ reservedQty: sql`${inventoryLevels.reservedQty} - ${quantity}`, updatedAt: at })
    .where(and(eq(inventoryLevels.id, levelId), sql`${inventoryLevels.reservedQty} >= ${quantity}`))
    .returning({ id: inventoryLevels.id });
  return rows.length === 1;
}

export async function findReservation(reservationId: string, exec: Executor = db) {
  const rows = await exec
    .select()
    .from(inventoryReservations)
    .where(eq(inventoryReservations.id, reservationId))
    .limit(1);
  return rows[0] ?? null;
}

const reservationSelection = {
  id: inventoryReservations.id,
  inventoryLevelId: inventoryReservations.inventoryLevelId,
  itemKind: itemKindExpr,
  itemId: itemIdExpr,
  sku: itemSkuExpr,
  name: itemNameExpr,
  warehouseId: inventoryLevels.warehouseId,
  warehouseCode: warehouses.code,
  quantity: inventoryReservations.quantity,
  reason: inventoryReservations.reason,
  cartId: inventoryReservations.cartId,
  orderId: inventoryReservations.orderId,
  expiresAt: inventoryReservations.expiresAt,
  releasedAt: inventoryReservations.releasedAt,
  createdAt: inventoryReservations.createdAt,
} as const;

export type ReservationRow = {
  id: string;
  inventoryLevelId: string;
  itemKind: StockableKind;
  itemId: string;
  sku: string;
  name: string;
  warehouseId: string;
  warehouseCode: string;
  quantity: number;
  reason: 'cart' | 'order' | 'manual_hold' | 'quotation';
  cartId: string | null;
  orderId: string | null;
  expiresAt: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
};

export const RESERVATION_SORTABLE = {
  createdAt: sql`${inventoryReservations.createdAt}`,
  expiresAt: sql`${inventoryReservations.expiresAt}`,
  quantity: sql`${inventoryReservations.quantity}`,
} as const;

export async function listReservations(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<ReservationRow[]> {
  return exec
    .select(reservationSelection)
    .from(inventoryReservations)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, inventoryReservations.inventoryLevelId))
    .innerJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);
}

export async function countReservations(where: SQL | undefined, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryReservations)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, inventoryReservations.inventoryLevelId))
    .innerJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .where(where);
  return rows[0]?.n ?? 0;
}

/* ---------------------------------------------------------------- reorder */

/**
 * The preferred supplier for a level, as a correlated scalar subquery.
 *
 * A LEFT JOIN on `supplier_products` would fan one level out into one row per
 * supplier that stocks it, and the page's `total` would then count suppliers
 * rather than items. This picks exactly one: the flagged preferred supplier
 * (`uq_supplier_products_preferred_variant` guarantees at most one per variant),
 * falling back to the cheapest, with `id` as the final tiebreak so the answer is
 * stable between requests.
 *
 * The NULL semantics do the polymorphic matching for free: `sp.variant_id =
 * il.variant_id` is NULL — not true — when either side is NULL, so a packaging
 * level never matches a variant catalogue row.
 */
const preferredSupplierProductId = sql`(
  SELECT sp.id FROM supplier_products sp
   WHERE sp.deleted_at IS NULL
     AND (sp.variant_id = ${inventoryLevels.variantId}
       OR sp.hamper_item_id = ${inventoryLevels.hamperItemId}
       OR sp.packaging_id = ${inventoryLevels.packagingId})
   ORDER BY sp.is_preferred DESC, sp.unit_cost_paise ASC, sp.id
   LIMIT 1)`;

const reorderSelection = {
  ...levelSelection,
  supplierProductId: supplierProducts.id,
  supplierId: suppliers.id,
  supplierName: suppliers.name,
  supplierSku: supplierProducts.supplierSku,
  isPreferredSupplier: supplierProducts.isPreferred,
  supplierUnitCostPaise: supplierProducts.unitCostPaise,
  moq: supplierProducts.moq,
  leadTimeDays: supplierProducts.leadTimeDays,
} as const;

export type ReorderRow = LevelRow & {
  supplierProductId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  supplierSku: string | null;
  isPreferredSupplier: boolean | null;
  supplierUnitCostPaise: number | null;
  moq: number | null;
  leadTimeDays: number | null;
};

export async function listReorderCandidates(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<ReorderRow[]> {
  return exec
    .select(reorderSelection)
    .from(inventoryLevels)
    .innerJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .leftJoin(supplierProducts, sql`${supplierProducts.id} = ${preferredSupplierProductId}`)
    .leftJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);
}

export async function countReorderCandidates(where: SQL | undefined, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryLevels)
    .innerJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .leftJoin(supplierProducts, sql`${supplierProducts.id} = ${preferredSupplierProductId}`)
    .leftJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(where);
  return rows[0]?.n ?? 0;
}

export const supplierIs = (supplierId: string): SQL => eq(supplierProducts.supplierId, supplierId);

/** The supplier's catalogue entry for one item, used when drafting a purchase order. */
export async function findSupplierProduct(
  supplierId: string,
  item: ResolvedItem,
  exec: Executor = db,
): Promise<{ supplierSku: string | null; unitCostPaise: number; moq: number; leadTimeDays: number } | null> {
  const target =
    item.kind === 'variant'
      ? eq(supplierProducts.variantId, item.id)
      : item.kind === 'hamper_item'
        ? eq(supplierProducts.hamperItemId, item.id)
        : eq(supplierProducts.packagingId, item.id);

  const rows = await exec
    .select({
      supplierSku: supplierProducts.supplierSku,
      unitCostPaise: supplierProducts.unitCostPaise,
      moq: supplierProducts.moq,
      leadTimeDays: supplierProducts.leadTimeDays,
    })
    .from(supplierProducts)
    .where(and(eq(supplierProducts.supplierId, supplierId), target, isNull(supplierProducts.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------- purchasing */

export async function findSupplier(supplierId: string, exec: Executor = db) {
  const rows = await exec
    .select({ id: suppliers.id, name: suppliers.name, status: suppliers.status })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), isNull(suppliers.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findWarehouse(warehouseId: string, exec: Executor = db) {
  const rows = await exec
    .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name, status: warehouses.status })
    .from(warehouses)
    .where(and(eq(warehouses.id, warehouseId), isNull(warehouses.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Next document number, under a row lock.
 *
 * `SELECT ... FOR UPDATE` on the series row is what serialises concurrent
 * drafting. A purchase-order series may have gaps (it is an internal document,
 * not a statutory invoice series) but two POs sharing a number is a different
 * problem, and the FULL unique index on `purchase_orders.po_no` would reject the
 * second insert anyway.
 */
export async function nextDocumentNumber(
  tx: Tx,
  docType: 'purchase_order',
  scopeKey: string,
): Promise<string | null> {
  const rows = await tx
    .select()
    .from(documentNumberSeries)
    .where(
      and(
        eq(documentNumberSeries.docType, docType),
        eq(documentNumberSeries.scopeKey, scopeKey),
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

  return `${series.prefix}${String(series.nextValue).padStart(series.padWidth, '0')}${series.suffix}`;
}

export async function insertPurchaseOrder(
  tx: Tx,
  values: typeof purchaseOrders.$inferInsert,
): Promise<{ id: string; poNo: string }> {
  const rows = await tx
    .insert(purchaseOrders)
    .values(values)
    .returning({ id: purchaseOrders.id, poNo: purchaseOrders.poNo });
  const row = rows[0];
  if (!row) throw new Error('purchase order insert returned nothing');
  return row;
}

export async function insertPurchaseOrderLines(
  tx: Tx,
  values: (typeof purchaseOrderLines.$inferInsert)[],
): Promise<{ id: string; description: string }[]> {
  if (values.length === 0) return [];
  return tx
    .insert(purchaseOrderLines)
    .values(values)
    .returning({ id: purchaseOrderLines.id, description: purchaseOrderLines.description });
}

export type IncomingRow = {
  purchaseOrderId: string;
  poNo: string;
  supplierName: string;
  warehouseId: string;
  status: string;
  orderedQty: number;
  receivedQty: number;
  expectedOn: string | null;
};

/** Open purchase-order lines for one item. A received or cancelled PO is not incoming. */
export async function findIncomingForItem(item: ResolvedItem, exec: Executor = db): Promise<IncomingRow[]> {
  const target =
    item.kind === 'variant'
      ? eq(purchaseOrderLines.variantId, item.id)
      : item.kind === 'hamper_item'
        ? eq(purchaseOrderLines.hamperItemId, item.id)
        : eq(purchaseOrderLines.packagingId, item.id);

  return exec
    .select({
      purchaseOrderId: purchaseOrders.id,
      poNo: purchaseOrders.poNo,
      supplierName: suppliers.name,
      warehouseId: purchaseOrders.warehouseId,
      status: purchaseOrders.status,
      orderedQty: purchaseOrderLines.orderedQty,
      receivedQty: purchaseOrderLines.receivedQty,
      expectedOn: purchaseOrders.expectedOn,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(and(target, inArray(purchaseOrders.status, ['draft', 'sent', 'partially_received'])))
    .orderBy(desc(purchaseOrders.createdAt))
    .limit(50);
}

/* -------------------------------------------------------------- dashboard */

export type DashboardTotals = {
  trackedItemCount: number;
  levelCount: number;
  totalOnHandQty: number;
  totalReservedQty: number;
  totalAvailableQty: number;
  totalIncomingQty: number;
  stockValuePaise: number;
  outOfStockCount: number;
  lowStockCount: number;
  reorderCount: number;
};

export async function dashboardTotals(where: SQL | undefined, exec: Executor = db): Promise<DashboardTotals> {
  const rows = await exec
    .select({
      trackedItemCount: sql<number>`count(DISTINCT coalesce(${inventoryLevels.variantId}, ${inventoryLevels.hamperItemId}, ${inventoryLevels.packagingId}))::int`,
      levelCount: sql<number>`count(*)::int`,
      totalOnHandQty: sql<number>`coalesce(sum(${inventoryLevels.onHandQty}), 0)::int`,
      totalReservedQty: sql<number>`coalesce(sum(${inventoryLevels.reservedQty}), 0)::int`,
      totalAvailableQty: sql<number>`coalesce(sum(${inventoryLevels.availableQty}), 0)::int`,
      totalIncomingQty: sql<number>`coalesce(sum(${inventoryLevels.incomingQty}), 0)::int`,
      stockValuePaise: sql<number>`coalesce(sum(${stockValueExpr}), 0)::bigint`,
      outOfStockCount: sql<number>`count(*) FILTER (WHERE ${inventoryLevels.availableQty} <= 0)::int`,
      lowStockCount: sql<number>`count(*) FILTER (WHERE ${inventoryLevels.availableQty} > 0 AND ${inventoryLevels.availableQty} <= ${inventoryLevels.reorderPoint})::int`,
      reorderCount: sql<number>`count(*) FILTER (WHERE ${inventoryLevels.reorderPoint} > 0 AND (${inventoryLevels.onHandQty} - ${inventoryLevels.reservedQty} + ${inventoryLevels.incomingQty}) <= ${inventoryLevels.reorderPoint})::int`,
    })
    .from(inventoryLevels)
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .where(where);

  return (
    rows[0] ?? {
      trackedItemCount: 0,
      levelCount: 0,
      totalOnHandQty: 0,
      totalReservedQty: 0,
      totalAvailableQty: 0,
      totalIncomingQty: 0,
      stockValuePaise: 0,
      outOfStockCount: 0,
      lowStockCount: 0,
      reorderCount: 0,
    }
  );
}

export async function dashboardByWarehouse(where: SQL | undefined, exec: Executor = db) {
  return exec
    .select({
      warehouseId: warehouses.id,
      warehouseCode: warehouses.code,
      warehouseName: warehouses.name,
      levelCount: sql<number>`count(*)::int`,
      onHandQty: sql<number>`coalesce(sum(${inventoryLevels.onHandQty}), 0)::int`,
      reservedQty: sql<number>`coalesce(sum(${inventoryLevels.reservedQty}), 0)::int`,
      availableQty: sql<number>`coalesce(sum(${inventoryLevels.availableQty}), 0)::int`,
      stockValuePaise: sql<number>`coalesce(sum(${stockValueExpr}), 0)::bigint`,
      outOfStockCount: sql<number>`count(*) FILTER (WHERE ${inventoryLevels.availableQty} <= 0)::int`,
      lowStockCount: sql<number>`count(*) FILTER (WHERE ${inventoryLevels.availableQty} > 0 AND ${inventoryLevels.availableQty} <= ${inventoryLevels.reorderPoint})::int`,
    })
    .from(inventoryLevels)
    .innerJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .where(where)
    .groupBy(warehouses.id, warehouses.code, warehouses.name)
    .orderBy(asc(warehouses.code));
}

export async function movementActivity(
  warehouseId: string | undefined,
  exec: Executor = db,
): Promise<{ last24h: number; last7d: number }> {
  const scope = warehouseId ? eq(inventoryLevels.warehouseId, warehouseId) : undefined;
  const rows = await exec
    .select({
      last24h: sql<number>`count(*) FILTER (WHERE ${stockMovements.occurredAt} >= now() - interval '24 hours')::int`,
      last7d: sql<number>`count(*) FILTER (WHERE ${stockMovements.occurredAt} >= now() - interval '7 days')::int`,
    })
    .from(stockMovements)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, stockMovements.inventoryLevelId))
    .where(and(sql`${stockMovements.occurredAt} >= now() - interval '7 days'`, scope));

  return rows[0] ?? { last24h: 0, last7d: 0 };
}

export async function reservationActivity(
  warehouseId: string | undefined,
  exec: Executor = db,
): Promise<{ active: number; expiringSoon: number }> {
  const scope = warehouseId ? eq(inventoryLevels.warehouseId, warehouseId) : undefined;
  const rows = await exec
    .select({
      active: sql<number>`count(*)::int`,
      expiringSoon: sql<number>`count(*) FILTER (WHERE ${inventoryReservations.expiresAt} IS NOT NULL AND ${inventoryReservations.expiresAt} <= now() + interval '24 hours')::int`,
    })
    .from(inventoryReservations)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, inventoryReservations.inventoryLevelId))
    .where(and(reservationIsActive, scope));

  return rows[0] ?? { active: 0, expiringSoon: 0 };
}

export async function openPurchaseOrderTotals(
  warehouseId: string | undefined,
  exec: Executor = db,
): Promise<{ count: number; valuePaise: number }> {
  const rows = await exec
    .select({
      count: sql<number>`count(*)::int`,
      valuePaise: sql<number>`coalesce(sum(${purchaseOrders.totalPaise}), 0)::bigint`,
    })
    .from(purchaseOrders)
    .where(
      and(
        inArray(purchaseOrders.status, ['draft', 'sent', 'partially_received']),
        warehouseId ? eq(purchaseOrders.warehouseId, warehouseId) : undefined,
      ),
    );
  return rows[0] ?? { count: 0, valuePaise: 0 };
}

/* ----------------------------------------------------------- activity log */

/**
 * The STATE-level record: what the numbers were before and after.
 *
 * Complementary to `middleware/audit.ts`, which `defineRoute` applies to every
 * non-GET admin route automatically. That one records the REQUEST — who called
 * which operation, from where, with what payload. This one records the effect on
 * stock, in queryable JSONB, which is what `GET /v1/admin/inventory/audit` reads
 * and what an operator actually means by "what happened to this SKU".
 */
export type NewActivity = {
  actorStaffId: string;
  actorLabel: string;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  beforeData: unknown;
  afterData: unknown;
  changedFields: string[];
  requestId: string | null;
};

export async function insertActivity(exec: Executor, values: NewActivity | NewActivity[]): Promise<void> {
  const rows = Array.isArray(values) ? values : [values];
  if (rows.length === 0) return;
  await exec.insert(activityLogs).values(
    rows.map((v) => ({
      actorKind: 'staff' as const,
      actorStaffId: v.actorStaffId,
      actorLabel: v.actorLabel,
      actorRole: v.actorRole,
      action: v.action,
      entityType: v.entityType,
      entityId: v.entityId,
      entityLabel: v.entityLabel,
      beforeData: v.beforeData,
      afterData: v.afterData,
      changedFields: v.changedFields,
      requestId: v.requestId,
    })),
  );
}

export type ActivityRow = {
  id: bigint;
  occurredAt: Date;
  action: string;
  actorLabel: string;
  actorRole: string | null;
  actorStaffId: string | null;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  beforeData: unknown;
  afterData: unknown;
  changedFields: string[] | null;
  requestId: string | null;
};

/** Only the entity types this module writes. A stock audit is not a catalogue audit. */
export const INVENTORY_ENTITY_TYPES = ['inventory_level', 'inventory_reservation', 'purchase_order'] as const;

export async function listActivity(
  where: SQL | undefined,
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<ActivityRow[]> {
  return exec
    .select({
      id: activityLogs.id,
      occurredAt: activityLogs.occurredAt,
      action: activityLogs.action,
      actorLabel: activityLogs.actorLabel,
      actorRole: activityLogs.actorRole,
      actorStaffId: activityLogs.actorStaffId,
      entityType: activityLogs.entityType,
      entityId: activityLogs.entityId,
      entityLabel: activityLogs.entityLabel,
      beforeData: activityLogs.beforeData,
      afterData: activityLogs.afterData,
      changedFields: activityLogs.changedFields,
      requestId: activityLogs.requestId,
    })
    .from(activityLogs)
    .where(where)
    .orderBy(direction === 'asc' ? asc(activityLogs.occurredAt) : desc(activityLogs.occurredAt))
    .limit(limit)
    .offset(offset);
}

export async function countActivity(where: SQL | undefined, exec: Executor = db): Promise<number> {
  const rows = await exec.select({ n: sql<number>`count(*)::int` }).from(activityLogs).where(where);
  return rows[0]?.n ?? 0;
}

export const activityInInventory = (): SQL =>
  inArray(activityLogs.entityType, [...INVENTORY_ENTITY_TYPES]);

export const activityMatchesText = (pattern: string): SQL | undefined =>
  or(ilike(activityLogs.entityLabel, pattern), ilike(activityLogs.action, pattern));

export const activityBetween = (from: Date | undefined, to: Date | undefined): SQL | undefined =>
  and(
    from ? gte(activityLogs.occurredAt, from) : undefined,
    to ? lte(activityLogs.occurredAt, to) : undefined,
  );

/* --------------------------------------------------------- notifications */

export type NotificationRow = {
  id: string;
  priority: 'high' | 'normal' | 'low';
  title: string;
  body: string | null;
  linkUrl: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export async function listInventoryNotifications(
  where: SQL | undefined,
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<NotificationRow[]> {
  return exec
    .select({
      id: notifications.id,
      priority: notifications.priority,
      title: notifications.title,
      body: notifications.body,
      linkUrl: notifications.linkUrl,
      entityType: notifications.entityType,
      entityId: notifications.entityId,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(where)
    .orderBy(direction === 'asc' ? asc(notifications.createdAt) : desc(notifications.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function countInventoryNotifications(where: SQL | undefined, exec: Executor = db): Promise<number> {
  const rows = await exec.select({ n: sql<number>`count(*)::int` }).from(notifications).where(where);
  return rows[0]?.n ?? 0;
}

/**
 * The inventory slice of the staff feed.
 *
 * A staff notification is either addressed to one person or broadcast to
 * everyone (`staff_user_id IS NULL`). Filtering to "mine only" would hide every
 * broadcast stockout alert, which is most of them — so both are returned.
 */
export const inventoryNotificationsFor = (staffId: string): SQL =>
  and(
    eq(notifications.audience, 'staff'),
    eq(notifications.kind, 'inventory'),
    or(isNull(notifications.staffUserId), eq(notifications.staffUserId, staffId)),
  ) as SQL;

export const notificationUnread = (): SQL => isNull(notifications.readAt);
export const notificationPriorityIs = (priority: 'high' | 'normal' | 'low'): SQL =>
  eq(notifications.priority, priority);
