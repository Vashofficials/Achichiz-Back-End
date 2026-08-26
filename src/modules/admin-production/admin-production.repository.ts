/**
 * Drizzle queries for bills of materials and production orders. No business
 * rules, no HTTP.
 *
 * ## Two things in this file that look odd, and why they are not
 *
 * **1. `waste_pct`, `version` and `unit` are addressed as raw SQL.** Migration
 * 0003 added those three columns to `product_bom_lines`; the Drizzle model in
 * `db/schema/catalogue.ts` predates it and does not declare them. The database is
 * the authoritative artifact (see `db/schema/index.ts`), so the columns are read
 * and written through `sql` fragments rather than by editing the schema from a
 * feature module. The fragments name the table explicitly, so they stay correct
 * whether or not Drizzle later aliases it.
 *
 * **2. `ensureLevel`, `adjustOnHand`, `lockLevels` and `insertMovement` are the
 * same four functions as in `admin-purchasing.repository.ts`.** Deliberately, for
 * the reason stated there: the boundary this codebase enforces is "a service may
 * call another module's SERVICE, never its repository", and there is no
 * inventory-service operation meaning "take 105 g of wax off this level because a
 * batch consumed it". Wrapping one would put production's rules inside inventory.
 *
 * The one thing that is NOT duplicated is the guard. Every copy is the same
 * conditional `UPDATE ... WHERE on_hand_qty - reserved_qty >= n` returning the new
 * balance, which is the only shape that is race-free at READ COMMITTED.
 */

import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  hamperItems,
  inventoryLevels,
  packagingMaterials,
  productBomLines,
  productVariants,
  products,
  productionOrderLines,
  productionOrders,
  warehouses,
  PRODUCTION_STATUSES,
  type ProductionOrder,
  type ProductionStatus,
  type StockMovementType,
  type StockReferenceType,
  type Uom,
} from '../../db/schema/index.js';

/* ------------------------------------------------------------ projections */

/** Columns added by migration 0003 and absent from the Drizzle model. See the header. */
const bomWastePct = sql<string>`product_bom_lines.waste_pct`;
const bomVersion = sql<number>`product_bom_lines.version`;
const bomUnit = sql<Uom>`product_bom_lines.unit`;

const componentSku = sql<string | null>`coalesce(
  (SELECT pv.sku FROM product_variants pv WHERE pv.id = ${productBomLines.componentVariantId}),
  (SELECT hi.sku FROM hamper_items hi WHERE hi.id = ${productBomLines.hamperItemId}))`;

const componentName = sql<string | null>`coalesce(
  (SELECT p.title || ' — ' || pv.option_label
     FROM product_variants pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = ${productBomLines.componentVariantId}),
  (SELECT hi.name FROM hamper_items hi WHERE hi.id = ${productBomLines.hamperItemId}))`;

export type BomLineRow = {
  id: string;
  outputVariantId: string;
  componentVariantId: string | null;
  hamperItemId: string | null;
  quantity: number;
  wastePct: number;
  unit: Uom;
  version: number;
  isSubstitutable: boolean;
  sku: string | null;
  name: string | null;
};

const toBomLine = (r: {
  id: string;
  outputVariantId: string;
  componentVariantId: string | null;
  hamperItemId: string | null;
  quantity: string;
  wastePct: string;
  unit: Uom;
  version: number;
  isSubstitutable: boolean;
  sku: string | null;
  name: string | null;
}): BomLineRow => ({
  id: r.id,
  outputVariantId: r.outputVariantId,
  componentVariantId: r.componentVariantId,
  hamperItemId: r.hamperItemId,
  // NUMERIC arrives as a string — node-postgres is configured never to let one
  // silently become a float. These are measurements, not money, so a JS number
  // is the right destination; the conversion just has to be explicit.
  quantity: Number(r.quantity),
  wastePct: Number(r.wastePct),
  unit: r.unit,
  version: r.version,
  isSubstitutable: r.isSubstitutable,
  sku: r.sku,
  name: r.name,
});

const bomSelection = {
  id: productBomLines.id,
  outputVariantId: productBomLines.variantId,
  componentVariantId: productBomLines.componentVariantId,
  hamperItemId: productBomLines.hamperItemId,
  quantity: productBomLines.quantity,
  wastePct: bomWastePct,
  unit: bomUnit,
  version: bomVersion,
  isSubstitutable: productBomLines.isSubstitutable,
  sku: componentSku,
  name: componentName,
} as const;

/* ================================================================ BOM reads */

/** Every line of one BOM, identified by its OUTPUT variant. */
export async function findBomLines(outputVariantId: string, exec: Executor = db): Promise<BomLineRow[]> {
  const rows = await exec
    .select(bomSelection)
    .from(productBomLines)
    .where(eq(productBomLines.variantId, outputVariantId))
    .orderBy(asc(productBomLines.id));
  return rows.map(toBomLine);
}

/**
 * Lines for MANY outputs in one round trip.
 *
 * The explosion walks level by level and asks for a whole level at a time, so a
 * ten-deep BOM costs ten queries rather than one per node.
 */
export async function findBomLinesForOutputs(
  outputVariantIds: readonly string[],
  exec: Executor = db,
): Promise<BomLineRow[]> {
  if (outputVariantIds.length === 0) return [];
  const rows = await exec
    .select(bomSelection)
    .from(productBomLines)
    .where(inArray(productBomLines.variantId, [...outputVariantIds]))
    .orderBy(asc(productBomLines.id));
  return rows.map(toBomLine);
}

/** Which of these variant ids are themselves manufactured — i.e. have BOM lines of their own. */
export async function outputsWithBom(
  variantIds: readonly string[],
  exec: Executor = db,
): Promise<Set<string>> {
  if (variantIds.length === 0) return new Set();
  const rows = await exec
    .selectDistinct({ id: productBomLines.variantId })
    .from(productBomLines)
    .where(inArray(productBomLines.variantId, [...variantIds]));
  return new Set(rows.map((r) => r.id));
}

export type BomOutputRow = {
  outputVariantId: string;
  outputSku: string | null;
  outputName: string | null;
  version: number;
  lineCount: number;
  hasWaste: boolean;
  hasSubAssemblies: boolean;
};

const OUTPUT_SORT = {
  sku: productVariants.sku,
  lineCount: sql`count(*)`,
  version: sql`max(product_bom_lines.version)`,
} as const;

export const bomOutputOrderBy = (field: string, direction: 'asc' | 'desc'): SQL => {
  const target = OUTPUT_SORT[field as keyof typeof OUTPUT_SORT] ?? productVariants.sku;
  return direction === 'desc' ? desc(target) : asc(target);
};

export const bomOutputIs = (variantId: string): SQL => eq(productBomLines.variantId, variantId);
export const bomUsesComponentVariant = (variantId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM product_bom_lines b2
               WHERE b2.variant_id = ${productBomLines.variantId} AND b2.component_variant_id = ${variantId})`;
export const bomUsesHamperItem = (hamperItemId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM product_bom_lines b2
               WHERE b2.variant_id = ${productBomLines.variantId} AND b2.hamper_item_id = ${hamperItemId})`;
export const bomHasWaste = (): SQL =>
  sql`EXISTS (SELECT 1 FROM product_bom_lines b2
               WHERE b2.variant_id = ${productBomLines.variantId} AND b2.waste_pct > 0)`;
export const bomMatchesText = (pattern: string): SQL =>
  sql`(${productVariants.sku} ILIKE ${pattern} OR ${products.title} ILIKE ${pattern})`;

/**
 * One row per OUTPUT — the BOM list screen.
 *
 * Grouped in SQL rather than by loading every line and folding in JS: a
 * catalogue with a hundred hampers has thousands of lines, and the list screen
 * needs six numbers from them.
 */
export async function listBomOutputs(
  where: SQL | undefined,
  orderBy: SQL,
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<BomOutputRow[]> {
  const rows = await exec
    .select({
      outputVariantId: productBomLines.variantId,
      outputSku: productVariants.sku,
      outputName: sql<string | null>`${products.title} || ' — ' || ${productVariants.optionLabel}`,
      version: sql<number>`max(product_bom_lines.version)::int`,
      lineCount: sql<number>`count(*)::int`,
      wasteLines: sql<number>`count(*) FILTER (WHERE product_bom_lines.waste_pct > 0)::int`,
      // A component that has BOM lines of its own is a sub-assembly, which is what
      // makes this output's explosion recursive. Counted in SQL beside the others
      // rather than by re-querying per row on the list screen.
      subAssemblyLines: sql<number>`count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM product_bom_lines b3
         WHERE b3.variant_id = product_bom_lines.component_variant_id))::int`,
    })
    .from(productBomLines)
    .innerJoin(productVariants, eq(productVariants.id, productBomLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where)
    .groupBy(productBomLines.variantId, productVariants.sku, products.title, productVariants.optionLabel)
    .orderBy(orderBy, asc(productBomLines.variantId))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    outputVariantId: r.outputVariantId,
    outputSku: r.outputSku,
    outputName: r.outputName,
    version: r.version,
    lineCount: r.lineCount,
    hasWaste: r.wasteLines > 0,
    hasSubAssemblies: r.subAssemblyLines > 0,
  }));
}

/**
 * The BOM list's WHERE clause, assembled from the atoms above.
 *
 * `q` matches the OUTPUT's sku or title, not the components': the list is one row
 * per output, and matching a component would return rows whose visible columns
 * contain nothing the user typed.
 */
export function bomFilters(query: {
  outputVariantId?: string | undefined;
  componentVariantId?: string | undefined;
  hamperItemId?: string | undefined;
  hasWaste?: 'true' | 'false' | undefined;
  q?: string | undefined;
}): SQL | undefined {
  const clauses: SQL[] = [];
  if (query.outputVariantId) clauses.push(bomOutputIs(query.outputVariantId));
  if (query.componentVariantId) clauses.push(bomUsesComponentVariant(query.componentVariantId));
  if (query.hamperItemId) clauses.push(bomUsesHamperItem(query.hamperItemId));
  if (query.hasWaste === 'true') clauses.push(bomHasWaste());
  if (query.hasWaste === 'false') clauses.push(sql`NOT ${bomHasWaste()}`);
  if (query.q) clauses.push(bomMatchesText(`%${query.q}%`));
  return clauses.length > 0 ? and(...clauses) : undefined;
}

export async function countBomOutputs(where: SQL | undefined, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ variantId: productBomLines.variantId })
    .from(productBomLines)
    .innerJoin(productVariants, eq(productVariants.id, productBomLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(where)
    .groupBy(productBomLines.variantId);
  return rows.length;
}

export type VariantRow = {
  id: string;
  sku: string;
  name: string;
  archived: boolean;
};

export async function findVariant(variantId: string, exec: Executor = db): Promise<VariantRow | undefined> {
  const rows = await exec
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      name: sql<string>`${products.title} || ' — ' || ${productVariants.optionLabel}`,
      deletedAt: productVariants.deletedAt,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, variantId))
    .limit(1);

  const row = rows[0];
  return row ? { id: row.id, sku: row.sku, name: row.name, archived: row.deletedAt !== null } : undefined;
}

export async function liveVariantIds(ids: readonly string[], exec: Executor = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await exec
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(inArray(productVariants.id, [...ids]), isNull(productVariants.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

export async function liveHamperItemIds(ids: readonly string[], exec: Executor = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await exec
    .select({ id: hamperItems.id })
    .from(hamperItems)
    .where(and(inArray(hamperItems.id, [...ids]), isNull(hamperItems.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

export async function livePackagingIds(ids: readonly string[], exec: Executor = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await exec
    .select({ id: packagingMaterials.id })
    .from(packagingMaterials)
    .where(and(inArray(packagingMaterials.id, [...ids]), isNull(packagingMaterials.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

/* =============================================================== BOM writes */

export type NewBomLine = {
  componentVariantId: string | null;
  hamperItemId: string | null;
  quantity: number;
  wastePct: number;
  unit: Uom;
  isSubstitutable: boolean;
};

/**
 * Replace every line of one BOM.
 *
 * Raw SQL because three of the eight columns are invisible to the Drizzle model
 * — see the file header. NUMERIC values are bound as strings so nothing
 * round-trips through a float on the way in.
 */
export async function insertBomLines(
  tx: Tx,
  outputVariantId: string,
  version: number,
  lines: readonly NewBomLine[],
): Promise<void> {
  if (lines.length === 0) return;

  const values = lines.map(
    (l) => sql`(${outputVariantId}, ${l.hamperItemId}, ${l.componentVariantId},
                ${l.quantity.toFixed(3)}, ${l.isSubstitutable}, ${l.wastePct.toFixed(2)},
                ${version}, ${l.unit})`,
  );

  await tx.execute(sql`
    INSERT INTO product_bom_lines
      (variant_id, hamper_item_id, component_variant_id, quantity, is_substitutable, waste_pct, version, unit)
    VALUES ${sql.join(values, sql`, `)}`);
}

export async function deleteBomLines(tx: Tx, outputVariantId: string): Promise<number> {
  const result = await tx.execute(
    sql`DELETE FROM product_bom_lines WHERE variant_id = ${outputVariantId}`,
  );
  return result.rowCount ?? 0;
}

export async function setBomVersion(tx: Tx, outputVariantId: string, version: number): Promise<void> {
  await tx.execute(
    sql`UPDATE product_bom_lines SET version = ${version} WHERE variant_id = ${outputVariantId}`,
  );
}

/** Locks the BOM's lines so two concurrent replacements queue rather than interleave. */
export async function lockBomLines(tx: Tx, outputVariantId: string): Promise<void> {
  await tx
    .select({ id: productBomLines.id })
    .from(productBomLines)
    .where(eq(productBomLines.variantId, outputVariantId))
    .orderBy(asc(productBomLines.id))
    .for('update');
}

/* ========================================================= stock primitives */

export type StockableRef = {
  variantId: string | null;
  hamperItemId: string | null;
  packagingId: string | null;
};

const levelMatch = (warehouseId: string, ref: StockableRef): SQL | undefined =>
  and(
    eq(inventoryLevels.warehouseId, warehouseId),
    ref.variantId ? eq(inventoryLevels.variantId, ref.variantId) : isNull(inventoryLevels.variantId),
    ref.hamperItemId ? eq(inventoryLevels.hamperItemId, ref.hamperItemId) : isNull(inventoryLevels.hamperItemId),
    ref.packagingId ? eq(inventoryLevels.packagingId, ref.packagingId) : isNull(inventoryLevels.packagingId),
  );

/**
 * The level for one stockable at one warehouse, created at zero if absent.
 *
 * Creating it is the right call for production: a component nobody has stocked
 * here yet should surface as a SHORTAGE with a number beside it, not as a
 * missing row the planner has to interpret. `ON CONFLICT DO NOTHING` then
 * re-select, so an insert race resolves to one row rather than an error.
 */
export async function ensureLevel(
  tx: Tx,
  warehouseId: string,
  ref: StockableRef,
): Promise<{ id: string; onHandQty: number; reservedQty: number }> {
  const match = levelMatch(warehouseId, ref);
  const selection = {
    id: inventoryLevels.id,
    onHandQty: inventoryLevels.onHandQty,
    reservedQty: inventoryLevels.reservedQty,
  };

  const existing = await tx.select(selection).from(inventoryLevels).where(match).limit(1);
  const found = existing[0];
  if (found) return found;

  await tx
    .insert(inventoryLevels)
    .values({
      warehouseId,
      variantId: ref.variantId,
      hamperItemId: ref.hamperItemId,
      packagingId: ref.packagingId,
      onHandQty: 0,
      reservedQty: 0,
    })
    .onConflictDoNothing();

  const after = await tx.select(selection).from(inventoryLevels).where(match).limit(1);
  const row = after[0];
  if (!row) throw new Error('inventory level could not be created or read back');
  return row;
}

/**
 * THE oversell guard (§62/§64).
 *
 * Returns the new `on_hand_qty` — which IS the movement's `balance_after` — or
 * `null` when the conditional refused, meaning zero rows updated and nothing
 * written. Reserved units belong to open carts and orders; a production run may
 * not eat them any more than an adjustment may.
 */
export async function adjustOnHand(tx: Tx, levelId: string, delta: number): Promise<number | null> {
  if (delta === 0) {
    throw new Error('adjustOnHand called with a zero delta — a movement of nothing is not a movement');
  }

  const guard = delta < 0 ? sql` AND on_hand_qty - reserved_qty >= ${-delta}` : sql``;

  const result = await tx.execute<{ on_hand_qty: number }>(sql`
    UPDATE inventory_levels
       SET on_hand_qty = on_hand_qty + ${delta},
           last_movement_at = now(),
           updated_at = now()
     WHERE id = ${levelId}${guard}
    RETURNING on_hand_qty`);

  return result.rows[0]?.on_hand_qty ?? null;
}

/**
 * Locks taken up front in ascending id order (§62).
 *
 * Without it, batch A holding level 1 and wanting level 2 deadlocks against
 * batch B holding 2 and wanting 1. PostgreSQL would detect it and abort one, but
 * a `deadlock_timeout` stall is not an acceptable way to find out.
 */
export async function lockLevels(tx: Tx, levelIds: readonly string[]): Promise<void> {
  if (levelIds.length === 0) return;
  await tx
    .select({ id: inventoryLevels.id })
    .from(inventoryLevels)
    .where(inArray(inventoryLevels.id, [...levelIds]))
    .orderBy(asc(inventoryLevels.id))
    .for('update');
}

/** The ledger is append-only. There is deliberately no `updateMovement`. */
export async function insertMovement(
  tx: Tx,
  values: {
    inventoryLevelId: string;
    movementType: StockMovementType;
    quantityDelta: number;
    balanceAfter: number;
    referenceType: StockReferenceType;
    referenceId: string;
    referenceLabel: string;
    note?: string | null;
    actorId?: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO stock_movements
      (inventory_level_id, movement_type, quantity_delta, balance_after,
       reference_type, reference_id, reference_label, note, actor_id)
    VALUES (${values.inventoryLevelId}, ${values.movementType}, ${values.quantityDelta},
            ${values.balanceAfter}, ${values.referenceType}, ${values.referenceId},
            ${values.referenceLabel}, ${values.note ?? null}, ${values.actorId ?? null})`);
}

/* ==================================================== production order reads */

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

const outputSku = sql<string | null>`coalesce(
  (SELECT pv.sku FROM product_variants pv WHERE pv.id = ${productionOrders.outputVariantId}),
  (SELECT hi.sku FROM hamper_items hi WHERE hi.id = ${productionOrders.outputHamperItemId}))`;

const outputName = sql<string | null>`coalesce(
  (SELECT p.title || ' — ' || pv.option_label
     FROM product_variants pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = ${productionOrders.outputVariantId}),
  (SELECT hi.name FROM hamper_items hi WHERE hi.id = ${productionOrders.outputHamperItemId}))`;

const productionLineCount = sql<number>`coalesce((
  SELECT count(*)::int FROM production_order_lines l
   WHERE l.production_order_id = ${productionOrders.id}), 0)`;

export type ProductionRow = ProductionOrder & {
  warehouseName: string | null;
  outputSku: string | null;
  outputName: string | null;
  lineCount: number;
};

const PRODUCTION_SORT = {
  createdAt: productionOrders.createdAt,
  productionNo: productionOrders.productionNo,
  plannedQty: productionOrders.plannedQty,
  status: productionOrders.status,
} as const;

export const productionOrderBy = (field: string, direction: 'asc' | 'desc'): SQL => {
  const column = PRODUCTION_SORT[field as keyof typeof PRODUCTION_SORT] ?? productionOrders.createdAt;
  return direction === 'desc' ? desc(column) : asc(column);
};

export const productionStatusIn = (values: readonly ProductionStatus[]): SQL | undefined =>
  values.length > 0 ? inArray(productionOrders.status, [...values]) : undefined;

export const productionWarehouseIs = (warehouseId: string): SQL =>
  eq(productionOrders.warehouseId, warehouseId);
export const productionOutputIs = (variantId: string): SQL =>
  eq(productionOrders.outputVariantId, variantId);
export const productionBatchIs = (batchNo: string): SQL => eq(productionOrders.batchNo, batchNo);
export const productionMatchesText = (pattern: string): SQL =>
  sql`(${productionOrders.productionNo} ILIKE ${pattern}
       OR coalesce(${productionOrders.batchNo}, '') ILIKE ${pattern}
       OR coalesce(${outputSku}, '') ILIKE ${pattern})`;

/** Statuses in which an order still expects to consume components. */
export const OPEN_PRODUCTION_STATUSES: readonly ProductionStatus[] = ['draft', 'planned', 'in_progress'];

export function productionFilters(query: {
  status?: string | undefined;
  warehouseId?: string | undefined;
  outputVariantId?: string | undefined;
  batchNo?: string | undefined;
  q?: string | undefined;
}): SQL | undefined {
  const clauses: SQL[] = [];

  if (query.status) {
    // Comma-separated, then intersected with the CHECK's vocabulary. An unknown
    // value is dropped rather than passed through — `?status=deleted` must not
    // reach an IN clause, and must not silently return everything either.
    const requested = query.status
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is ProductionStatus => (PRODUCTION_STATUSES as readonly string[]).includes(s));
    // Every value was unrecognised: match nothing, which is the honest answer to
    // a filter for a status that does not exist.
    if (requested.length === 0) return sql`false`;
    const statusClause = productionStatusIn(requested);
    if (statusClause) clauses.push(statusClause);
  }

  if (query.warehouseId) clauses.push(productionWarehouseIs(query.warehouseId));
  if (query.outputVariantId) clauses.push(productionOutputIs(query.outputVariantId));
  if (query.batchNo) clauses.push(productionBatchIs(query.batchNo));
  if (query.q) clauses.push(productionMatchesText(`%${query.q}%`));

  return clauses.length > 0 ? and(...clauses) : undefined;
}

/** Orders against this output that have not finished — the guard on removing a BOM. */
export async function countOpenProductionForOutput(
  outputVariantId: string,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .select({ n: count() })
    .from(productionOrders)
    .where(
      and(
        eq(productionOrders.outputVariantId, outputVariantId),
        inArray(productionOrders.status, [...OPEN_PRODUCTION_STATUSES]),
      ),
    );
  return rows[0]?.n ?? 0;
}

export type AvailabilityRow = {
  variantId: string | null;
  hamperItemId: string | null;
  packagingId: string | null;
  availableQty: number;
};

/**
 * Sellable quantity for a set of stockables at one warehouse.
 *
 * SELLABLE, not on-hand: `available_qty` is the generated column
 * `on_hand_qty - reserved_qty`. A component whose stock is reserved for open
 * orders cannot be consumed by a production run either, so answering "can we
 * build this" with on-hand would promise units that are already spoken for.
 *
 * Stockables absent from the result have no level here at all, which the caller
 * reads as zero rather than as missing data.
 */
export async function availabilityFor(
  warehouseId: string,
  refs: readonly StockableRef[],
  exec: Executor = db,
): Promise<AvailabilityRow[]> {
  const variantIds = refs.map((r) => r.variantId).filter((v): v is string => v !== null);
  const hamperItemIds = refs.map((r) => r.hamperItemId).filter((v): v is string => v !== null);
  const packagingIds = refs.map((r) => r.packagingId).filter((v): v is string => v !== null);
  if (variantIds.length + hamperItemIds.length + packagingIds.length === 0) return [];

  const targets: SQL[] = [];
  if (variantIds.length > 0) targets.push(inArray(inventoryLevels.variantId, variantIds));
  if (hamperItemIds.length > 0) targets.push(inArray(inventoryLevels.hamperItemId, hamperItemIds));
  if (packagingIds.length > 0) targets.push(inArray(inventoryLevels.packagingId, packagingIds));

  const rows = await exec
    .select({
      variantId: inventoryLevels.variantId,
      hamperItemId: inventoryLevels.hamperItemId,
      packagingId: inventoryLevels.packagingId,
      availableQty: inventoryLevels.availableQty,
      onHandQty: inventoryLevels.onHandQty,
      reservedQty: inventoryLevels.reservedQty,
    })
    .from(inventoryLevels)
    .where(and(eq(inventoryLevels.warehouseId, warehouseId), or(...targets)));

  return rows.map((r) => ({
    variantId: r.variantId,
    hamperItemId: r.hamperItemId,
    packagingId: r.packagingId,
    availableQty: r.availableQty ?? r.onHandQty - r.reservedQty,
  }));
}

const productionSelection = {
  order: productionOrders,
  warehouseName: warehouses.name,
  outputSku,
  outputName,
  lineCount: productionLineCount,
} as const;

export async function listProductionOrders(
  where: SQL | undefined,
  orderBy: SQL,
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<ProductionRow[]> {
  const rows = await exec
    .select(productionSelection)
    .from(productionOrders)
    .leftJoin(warehouses, eq(warehouses.id, productionOrders.warehouseId))
    .where(where)
    .orderBy(orderBy, asc(productionOrders.id))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    ...r.order,
    warehouseName: r.warehouseName,
    outputSku: r.outputSku,
    outputName: r.outputName,
    lineCount: r.lineCount,
  }));
}

export async function countProductionOrders(where: SQL | undefined, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ n: count() })
    .from(productionOrders)
    .leftJoin(warehouses, eq(warehouses.id, productionOrders.warehouseId))
    .where(where);
  return rows[0]?.n ?? 0;
}

export async function findProductionOrder(
  productionId: string,
  exec: Executor = db,
): Promise<ProductionRow | undefined> {
  const rows = await exec
    .select(productionSelection)
    .from(productionOrders)
    .leftJoin(warehouses, eq(warehouses.id, productionOrders.warehouseId))
    .where(eq(productionOrders.id, productionId))
    .limit(1);

  const row = rows[0];
  if (!row) return undefined;
  return {
    ...row.order,
    warehouseName: row.warehouseName,
    outputSku: row.outputSku,
    outputName: row.outputName,
    lineCount: row.lineCount,
  };
}

export async function lockProductionOrder(
  tx: Tx,
  productionId: string,
): Promise<ProductionOrder | undefined> {
  const rows = await tx
    .select()
    .from(productionOrders)
    .where(eq(productionOrders.id, productionId))
    .for('update')
    .limit(1);
  return rows[0];
}

export type ProductionLineRow = {
  id: string;
  inventoryLevelId: string;
  plannedQty: number;
  consumedQty: number;
  unit: Uom;
  componentKind: 'variant' | 'hamper_item' | 'packaging';
  componentId: string | null;
  sku: string | null;
  name: string | null;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
};

export async function findProductionLines(
  productionId: string,
  exec: Executor = db,
): Promise<ProductionLineRow[]> {
  const rows = await exec
    .select({
      id: productionOrderLines.id,
      inventoryLevelId: productionOrderLines.inventoryLevelId,
      plannedQty: productionOrderLines.plannedQty,
      consumedQty: productionOrderLines.consumedQty,
      unit: productionOrderLines.unit,
      componentKind: sql<'variant' | 'hamper_item' | 'packaging'>`
        CASE WHEN ${inventoryLevels.variantId} IS NOT NULL THEN 'variant'
             WHEN ${inventoryLevels.hamperItemId} IS NOT NULL THEN 'hamper_item'
             ELSE 'packaging' END`,
      componentId: sql<string | null>`coalesce(${inventoryLevels.variantId},
        ${inventoryLevels.hamperItemId}, ${inventoryLevels.packagingId})`,
      sku: sql<string | null>`coalesce(${productVariants.sku}, ${hamperItems.sku}, ${packagingMaterials.sku})`,
      name: sql<string | null>`coalesce(
        ${products.title} || ' — ' || ${productVariants.optionLabel},
        ${hamperItems.name},
        ${packagingMaterials.name})`,
      onHandQty: inventoryLevels.onHandQty,
      reservedQty: inventoryLevels.reservedQty,
      availableQty: inventoryLevels.availableQty,
    })
    .from(productionOrderLines)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, productionOrderLines.inventoryLevelId))
    .leftJoin(productVariants, eq(productVariants.id, inventoryLevels.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(hamperItems, eq(hamperItems.id, inventoryLevels.hamperItemId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, inventoryLevels.packagingId))
    .where(eq(productionOrderLines.productionOrderId, productionId))
    .orderBy(asc(productionOrderLines.inventoryLevelId));

  return rows.map((r) => ({
    id: r.id,
    inventoryLevelId: r.inventoryLevelId,
    plannedQty: Number(r.plannedQty),
    consumedQty: Number(r.consumedQty),
    unit: r.unit,
    componentKind: r.componentKind,
    componentId: r.componentId,
    sku: r.sku,
    name: r.name,
    onHandQty: r.onHandQty,
    reservedQty: r.reservedQty,
    availableQty: r.availableQty ?? r.onHandQty - r.reservedQty,
  }));
}

/* =================================================== production order writes */

/**
 * `PRD-2026-00001` from the row-locked series seeded by migration 0003.
 *
 * The series is the same gapless mechanism every other document uses. Improvising
 * a number here would collide with the real series the first time both ran.
 */
export async function nextProductionNumber(tx: Tx, year: number): Promise<string> {
  const scope = String(year);
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('production', ${scope}, ${`PRD-${scope}-`}, '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ production_no: string }>(
    sql`SELECT next_document_number('production', ${scope}) AS production_no`,
  );
  const productionNo = result.rows[0]?.production_no;
  if (!productionNo) throw new Error('next_document_number returned no production number');
  return productionNo;
}

export async function insertProductionOrder(
  tx: Tx,
  values: typeof productionOrders.$inferInsert,
): Promise<ProductionOrder> {
  const rows = await tx.insert(productionOrders).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('production_orders insert returned no row');
  return row;
}

export async function insertProductionLines(
  tx: Tx,
  values: (typeof productionOrderLines.$inferInsert)[],
): Promise<void> {
  if (values.length === 0) return;
  await tx.insert(productionOrderLines).values(values);
}

export async function updateProductionOrder(
  tx: Tx,
  productionId: string,
  patch: Partial<typeof productionOrders.$inferInsert>,
): Promise<void> {
  await tx.update(productionOrders).set(patch).where(eq(productionOrders.id, productionId));
}

/**
 * Record what was actually taken.
 *
 * `planned_qty` is not in the SET clause and never will be — the difference
 * between the two columns is the only honest signal for tuning `waste_pct`, and
 * overwriting the plan with the actual erases it.
 */
export async function setLineConsumed(tx: Tx, lineId: string, consumedQty: number): Promise<void> {
  await tx
    .update(productionOrderLines)
    .set({ consumedQty: consumedQty.toFixed(3) })
    .where(eq(productionOrderLines.id, lineId));
}
