/**
 * Drizzle queries for bundles and their contents. No business rules, no HTTP.
 *
 * `bundle_items` has NO surrogate primary key — it is `PRIMARY KEY (bundle_id,
 * variant_id)`. That is why the write path here is delete-then-insert rather
 * than a per-row update: there is no stable id to patch a single line by, and
 * inventing one in application code would be a second identity for a row the
 * database already identifies.
 */

import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  bundleItems,
  bundles,
  inventoryLevels,
  productVariants,
  products,
  warehouses,
  type Bundle,
  type BundleStatus,
} from '../../db/schema/index.js';

/* --------------------------------------------------------------- fragments */

const itemCountExpr = sql<number>`coalesce((
  SELECT count(*)::int FROM bundle_items bi WHERE bi.bundle_id = ${bundles.id}), 0)`;

const unitCountExpr = sql<number>`coalesce((
  SELECT sum(bi.quantity)::int FROM bundle_items bi WHERE bi.bundle_id = ${bundles.id}), 0)`;

/**
 * `SUM(variant price × quantity)` for the bundle, in integer paise.
 *
 * Computed in SQL rather than by loading the items on a list screen, so the
 * saving column costs one subquery instead of N round trips per page.
 */
const componentTotalExpr = sql<number>`coalesce((
  SELECT sum(bi.quantity * pv.price_paise)::bigint
    FROM bundle_items bi
    JOIN product_variants pv ON pv.id = bi.variant_id
   WHERE bi.bundle_id = ${bundles.id}), 0)`;

export type BundleRow = Bundle & {
  itemCount: number;
  unitCount: number;
  componentTotalPaise: number;
};

const BUNDLE_SORT = {
  createdAt: bundles.createdAt,
  name: bundles.name,
  handle: bundles.handle,
  bundlePricePaise: bundles.bundlePricePaise,
  startsAt: bundles.startsAt,
} as const;

export const bundleOrderBy = (field: string, direction: 'asc' | 'desc'): SQL => {
  const column = BUNDLE_SORT[field as keyof typeof BUNDLE_SORT] ?? bundles.createdAt;
  return direction === 'desc' ? desc(column) : asc(column);
};

export const bundleNotArchived = (): SQL => sql`${bundles.deletedAt} IS NULL`;

export const bundleStatusIn = (values: readonly BundleStatus[]): SQL | undefined =>
  values.length > 0 ? inArray(bundles.status, [...values]) : undefined;

/** Sellable right now: active AND inside the schedule window. Status alone does not expire. */
export const bundleIsLive = (now: Date): SQL =>
  sql`${bundles.status} = 'active'
      AND (${bundles.startsAt} IS NULL OR ${bundles.startsAt} <= ${now})
      AND (${bundles.endsAt} IS NULL OR ${bundles.endsAt} > ${now})`;

export const bundleMatchesText = (pattern: string): SQL =>
  sql`(${bundles.name} ILIKE ${pattern} OR ${bundles.handle} ILIKE ${pattern})`;

export const bundleContainsVariant = (variantId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM bundle_items bi
               WHERE bi.bundle_id = ${bundles.id} AND bi.variant_id = ${variantId})`;

/* ------------------------------------------------------------------ reads */

export async function listBundles(
  where: SQL | undefined,
  orderBy: SQL,
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<BundleRow[]> {
  const rows = await exec
    .select({
      bundle: bundles,
      itemCount: itemCountExpr,
      unitCount: unitCountExpr,
      componentTotalPaise: componentTotalExpr,
    })
    .from(bundles)
    .where(where)
    .orderBy(orderBy, asc(bundles.id))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    ...r.bundle,
    itemCount: r.itemCount,
    unitCount: r.unitCount,
    componentTotalPaise: Number(r.componentTotalPaise),
  }));
}

export async function countBundles(where: SQL | undefined, exec: Executor = db): Promise<number> {
  const rows = await exec.select({ n: count() }).from(bundles).where(where);
  return rows[0]?.n ?? 0;
}

export async function findBundle(bundleId: string, exec: Executor = db): Promise<BundleRow | undefined> {
  const rows = await exec
    .select({
      bundle: bundles,
      itemCount: itemCountExpr,
      unitCount: unitCountExpr,
      componentTotalPaise: componentTotalExpr,
    })
    .from(bundles)
    .where(eq(bundles.id, bundleId))
    .limit(1);

  const row = rows[0];
  if (!row) return undefined;
  return {
    ...row.bundle,
    itemCount: row.itemCount,
    unitCount: row.unitCount,
    componentTotalPaise: Number(row.componentTotalPaise),
  };
}

export async function lockBundle(tx: Tx, bundleId: string): Promise<Bundle | undefined> {
  const rows = await tx.select().from(bundles).where(eq(bundles.id, bundleId)).for('update').limit(1);
  return rows[0];
}

/** A live bundle already using this handle, ignoring `exceptId`. Partial-unique: soft-deleted rows free it. */
export async function findBundleByHandle(
  handle: string,
  exceptId: string | null,
  exec: Executor = db,
): Promise<{ id: string } | undefined> {
  const rows = await exec
    .select({ id: bundles.id })
    .from(bundles)
    .where(
      and(
        eq(bundles.handle, handle),
        isNull(bundles.deletedAt),
        exceptId ? sql`${bundles.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  return rows[0];
}

export type BundleItemRow = {
  variantId: string;
  quantity: number;
  position: number;
  sku: string | null;
  title: string | null;
  unitPricePaise: number;
  archived: boolean;
};

export async function findBundleItems(bundleId: string, exec: Executor = db): Promise<BundleItemRow[]> {
  const rows = await exec
    .select({
      variantId: bundleItems.variantId,
      quantity: bundleItems.quantity,
      position: bundleItems.position,
      sku: productVariants.sku,
      title: sql<string | null>`${products.title} || ' — ' || ${productVariants.optionLabel}`,
      unitPricePaise: productVariants.pricePaise,
      deletedAt: productVariants.deletedAt,
    })
    .from(bundleItems)
    .innerJoin(productVariants, eq(productVariants.id, bundleItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(bundleItems.bundleId, bundleId))
    .orderBy(asc(bundleItems.position), asc(bundleItems.variantId));

  return rows.map((r) => ({
    variantId: r.variantId,
    quantity: r.quantity,
    position: r.position,
    sku: r.sku,
    title: r.title,
    unitPricePaise: r.unitPricePaise,
    archived: r.deletedAt !== null,
  }));
}

/** Which of these variant ids actually exist and are not soft-deleted. */
export async function liveVariantIds(ids: readonly string[], exec: Executor = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await exec
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(inArray(productVariants.id, [...ids]), isNull(productVariants.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

export async function findWarehouse(
  warehouseId: string,
  exec: Executor = db,
): Promise<{ id: string; name: string } | undefined> {
  const rows = await exec
    .select({ id: warehouses.id, name: warehouses.name })
    .from(warehouses)
    .where(and(eq(warehouses.id, warehouseId), isNull(warehouses.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * The stock position of a set of variants, summed across warehouses or narrowed
 * to one.
 *
 * `available_qty` is the GENERATED column (`on_hand_qty - reserved_qty`), read
 * rather than recomputed. A variant with no `inventory_levels` row at all is
 * simply absent from the result — the caller treats a missing key as zero, which
 * is the honest reading: nothing is stocked, so nothing is available.
 */
export type VariantStockRow = {
  variantId: string;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
};

export async function variantStock(
  variantIds: readonly string[],
  warehouseId: string | null,
  exec: Executor = db,
): Promise<Map<string, VariantStockRow>> {
  if (variantIds.length === 0) return new Map();

  const rows = await exec
    .select({
      variantId: inventoryLevels.variantId,
      onHandQty: sql<number>`sum(${inventoryLevels.onHandQty})::int`,
      reservedQty: sql<number>`sum(${inventoryLevels.reservedQty})::int`,
      availableQty: sql<number>`sum(${inventoryLevels.availableQty})::int`,
    })
    .from(inventoryLevels)
    .where(
      and(
        inArray(inventoryLevels.variantId, [...variantIds]),
        warehouseId ? eq(inventoryLevels.warehouseId, warehouseId) : undefined,
      ),
    )
    .groupBy(inventoryLevels.variantId);

  const out = new Map<string, VariantStockRow>();
  for (const r of rows) {
    if (!r.variantId) continue;
    out.set(r.variantId, {
      variantId: r.variantId,
      onHandQty: r.onHandQty,
      reservedQty: r.reservedQty,
      availableQty: r.availableQty,
    });
  }
  return out;
}

/* ----------------------------------------------------------------- writes */

export async function insertBundle(tx: Tx, values: typeof bundles.$inferInsert): Promise<Bundle> {
  const rows = await tx.insert(bundles).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('bundles insert returned no row');
  return row;
}

export async function updateBundle(
  tx: Tx,
  bundleId: string,
  patch: Partial<typeof bundles.$inferInsert>,
): Promise<void> {
  await tx.update(bundles).set(patch).where(eq(bundles.id, bundleId));
}

export async function replaceBundleItems(
  tx: Tx,
  bundleId: string,
  items: readonly { variantId: string; quantity: number; position: number }[],
): Promise<void> {
  await tx.delete(bundleItems).where(eq(bundleItems.bundleId, bundleId));
  if (items.length === 0) return;
  await tx.insert(bundleItems).values(items.map((i) => ({ ...i, bundleId })));
}
