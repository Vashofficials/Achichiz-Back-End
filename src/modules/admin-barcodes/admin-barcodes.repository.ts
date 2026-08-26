/**
 * Drizzle queries for barcodes and scanning. No business rules, no HTTP.
 *
 * `product_variants.barcode` is the whole storage story — there is no registry
 * table, and this module does not create one. Uniqueness is
 * `uq_variants_barcode`, a PARTIAL unique index over live rows only, which is
 * why a soft-deleted variant's code becomes available again and why the
 * pre-flight collision check below also filters on `deleted_at IS NULL`: it has
 * to ask the same question the index does, or it would refuse codes the database
 * would happily accept.
 *
 * The index is the guarantee. The check exists so a bulk batch reports which two
 * lines clashed instead of aborting on a constraint violation that names neither.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import { inventoryLevels, productVariants, products, warehouses } from '../../db/schema/index.js';

/* -------------------------------------------------------------- variants */

export type VariantRow = {
  id: string;
  sku: string;
  optionLabel: string;
  name: string | null;
  barcode: string | null;
  status: string;
};

const variantName = sql<string | null>`${products.title} || ' — ' || ${productVariants.optionLabel}`;

const variantSelection = {
  id: productVariants.id,
  sku: productVariants.sku,
  optionLabel: productVariants.optionLabel,
  name: variantName,
  barcode: productVariants.barcode,
  status: productVariants.status,
} as const;

export async function findVariantBySku(sku: string, exec: Executor = db): Promise<VariantRow | undefined> {
  const rows = await exec
    .select(variantSelection)
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(productVariants.sku, sku), isNull(productVariants.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * Variants for a batch of SKUs, LOCKED in ascending id order.
 *
 * `FOR UPDATE OF product_variants` rather than a plain read: bulk generation is
 * all-or-nothing, and without the lock two concurrent batches naming overlapping
 * SKUs could both see "no barcode yet" and the second would then overwrite the
 * first's freshly printed code. Ascending id keeps the ordering deterministic so
 * the two batches queue instead of deadlocking.
 *
 * `products` is joined only for the display name, so it is deliberately excluded
 * from the lock — locking a product row because somebody printed a label would
 * block catalogue edits for no reason.
 */
export async function lockVariantsBySkus(tx: Tx, skus: readonly string[]): Promise<VariantRow[]> {
  if (skus.length === 0) return [];
  return tx
    .select(variantSelection)
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(inArray(productVariants.sku, [...skus]), isNull(productVariants.deletedAt)))
    .orderBy(asc(productVariants.id))
    .for('update', { of: productVariants });
}

/** Barcode → variant. Live rows only, matching the partial unique index. */
export async function findVariantByBarcode(
  barcode: string,
  exec: Executor = db,
): Promise<VariantRow | undefined> {
  const rows = await exec
    .select(variantSelection)
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(productVariants.barcode, barcode), isNull(productVariants.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * Which of these candidate codes are already taken by a LIVE variant.
 *
 * Same predicate as `uq_variants_barcode`. Asking a different question than the
 * index would either refuse codes that are actually free or miss ones that are not.
 */
export async function takenBarcodes(
  exec: Executor,
  candidates: readonly string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await exec
    .select({ barcode: productVariants.barcode })
    .from(productVariants)
    .where(and(inArray(productVariants.barcode, [...candidates]), isNull(productVariants.deletedAt)));
  return new Set(rows.map((r) => r.barcode).filter((b): b is string => b !== null));
}

export async function setBarcode(tx: Tx, variantId: string, barcode: string, at: Date): Promise<void> {
  await tx
    .update(productVariants)
    .set({ barcode, updatedAt: at })
    .where(eq(productVariants.id, variantId));
}

/* ---------------------------------------------------------------- levels */

export type LevelRow = {
  inventoryLevelId: string;
  warehouseId: string;
  warehouseCode: string | null;
  onHandQty: number;
  reservedQty: number;
  availableQty: number | null;
  incomingQty: number;
  binLocation: string | null;
  locationPath: string | null;
};

const levelLocationPath = sql<string | null>`(
  SELECT wl.path FROM warehouse_locations wl WHERE wl.id = inventory_levels.location_id)`;

/** Every stock position for one variant, optionally narrowed to the warehouse the handheld is in. */
export async function levelsForVariant(
  variantId: string,
  warehouseId: string | undefined,
  exec: Executor = db,
): Promise<LevelRow[]> {
  return exec
    .select({
      inventoryLevelId: inventoryLevels.id,
      warehouseId: inventoryLevels.warehouseId,
      warehouseCode: warehouses.code,
      onHandQty: inventoryLevels.onHandQty,
      reservedQty: inventoryLevels.reservedQty,
      availableQty: inventoryLevels.availableQty,
      incomingQty: inventoryLevels.incomingQty,
      binLocation: inventoryLevels.binLocation,
      locationPath: levelLocationPath,
    })
    .from(inventoryLevels)
    .leftJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
    .where(
      and(
        eq(inventoryLevels.variantId, variantId),
        warehouseId ? eq(inventoryLevels.warehouseId, warehouseId) : undefined,
      ),
    )
    .orderBy(asc(warehouses.code));
}
