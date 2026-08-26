/**
 * Drizzle queries for stock counts. No business rules, no HTTP.
 *
 * ## On `lockLevels`, `applyOnHandDelta` and `insertMovement` looking copied
 *
 * They are, and deliberately — the same trade `admin-purchasing.repository.ts`
 * documents at its head. The boundary this codebase enforces is "a service may
 * call another module's SERVICE, never its repository", and there is no
 * inventory-service operation that means "move this level by the variance a
 * count found, inside the transaction that is also approving the count". Calling
 * `inventory.adjust()` would open its own transaction, and a count that
 * half-posted is precisely the outcome §40 forbids.
 *
 * What must NOT be duplicated is the guard, and it is not: this is the same
 * conditional `UPDATE … WHERE on_hand_qty − reserved_qty + delta >= 0` returning
 * the new balance, which is the only shape that is race-free at READ COMMITTED.
 * Zero rows back means refused, never no-op.
 *
 * ## On `inventory_levels.location_id`
 *
 * Migration `0003_inventory.sql` added the column; the Drizzle model in
 * `db/schema/inventory.ts` has not been regenerated and this module must not edit
 * `db/**`. The migration is the authoritative artifact, so the column is read and
 * filtered through `sql` fragments naming it explicitly — the same accommodation
 * `admin-inventory.repository.ts` and `admin-warehousing.repository.ts` make.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  inventoryLevels,
  stockCountItems,
  stockCounts,
  stockMovements,
  warehouseLocations,
  warehouses,
  type StockCount,
  type StockCountStatus,
} from '../../db/schema/index.js';

/* ------------------------------------------------------------ projections */

/**
 * SKU and name for whichever of the three stockables a level tracks.
 *
 * Correlated subqueries rather than three LEFT JOINs: exactly one of the ids is
 * non-null (CHECK `inventory_exactly_one_stockable`), so at most one subquery
 * does any work and the row count cannot fan out — which matters here, because
 * fanning out a count sheet would produce duplicate lines for one shelf.
 */
const levelSku = sql<string | null>`coalesce(
  (SELECT pv.sku FROM product_variants pv WHERE pv.id = ${inventoryLevels.variantId}),
  (SELECT hi.sku FROM hamper_items hi WHERE hi.id = ${inventoryLevels.hamperItemId}),
  (SELECT pm.sku FROM packaging_materials pm WHERE pm.id = ${inventoryLevels.packagingId}))`;

const levelName = sql<string | null>`coalesce(
  (SELECT p.title || ' — ' || pv.option_label
     FROM product_variants pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = ${inventoryLevels.variantId}),
  (SELECT hi.name FROM hamper_items hi WHERE hi.id = ${inventoryLevels.hamperItemId}),
  (SELECT pm.name FROM packaging_materials pm WHERE pm.id = ${inventoryLevels.packagingId}))`;

const levelLocationPath = sql<string | null>`(
  SELECT wl.path FROM warehouse_locations wl WHERE wl.id = inventory_levels.location_id)`;

export const stockableKindOf = (row: {
  variantId: string | null;
  hamperItemId: string | null;
}): 'variant' | 'hamper_item' | 'packaging' =>
  row.variantId ? 'variant' : row.hamperItemId ? 'hamper_item' : 'packaging';

/* ------------------------------------------------------------ warehouses */

export async function findWarehouse(
  warehouseId: string,
  exec: Executor = db,
): Promise<{ id: string; name: string; code: string } | undefined> {
  const rows = await exec
    .select({ id: warehouses.id, name: warehouses.name, code: warehouses.code })
    .from(warehouses)
    .where(and(eq(warehouses.id, warehouseId), isNull(warehouses.deletedAt)))
    .limit(1);
  return rows[0];
}

export async function findLocation(
  locationId: string,
  exec: Executor = db,
): Promise<{ id: string; warehouseId: string; path: string } | undefined> {
  const rows = await exec
    .select({
      id: warehouseLocations.id,
      warehouseId: warehouseLocations.warehouseId,
      path: warehouseLocations.path,
    })
    .from(warehouseLocations)
    .where(and(eq(warehouseLocations.id, locationId), isNull(warehouseLocations.deletedAt)))
    .limit(1);
  return rows[0];
}

/* --------------------------------------------------------- count numbers */

/**
 * `CNT-2026-00001` from the row-locked series. The '2026' scope is seeded by 0003.
 *
 * The upsert covers the turn of the year: the seed only created 2026, and a count
 * raised on 1 January 2027 should get a number rather than a 500.
 */
export async function nextCountNumber(tx: Tx, year: number): Promise<string> {
  const scope = String(year);
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('stock_count', ${scope}, ${`CNT-${scope}-`}, '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ count_no: string }>(
    sql`SELECT next_document_number('stock_count', ${scope}) AS count_no`,
  );
  const countNo = result.rows[0]?.count_no;
  if (!countNo) throw new Error('next_document_number returned no stock count number');
  return countNo;
}

/* --------------------------------------------------------------- counts */

export type CountRow = StockCount & { warehouseCode: string | null; locationPath: string | null };

const countSelection = {
  count: stockCounts,
  warehouseCode: warehouses.code,
  locationPath: warehouseLocations.path,
} as const;

const flattenCount = (r: {
  count: StockCount;
  warehouseCode: string | null;
  locationPath: string | null;
}): CountRow => ({ ...r.count, warehouseCode: r.warehouseCode, locationPath: r.locationPath });

const COUNT_SORT = {
  createdAt: stockCounts.createdAt,
  countNo: stockCounts.countNo,
  status: stockCounts.status,
  scheduledFor: stockCounts.scheduledFor,
  completedAt: stockCounts.completedAt,
} as const;

export const countSortColumn = (field: string): AnyPgColumn =>
  COUNT_SORT[field as keyof typeof COUNT_SORT] ?? stockCounts.createdAt;

export const countWarehouseIs = (warehouseId: string): SQL => eq(stockCounts.warehouseId, warehouseId);
export const countLocationIs = (locationId: string): SQL => eq(stockCounts.locationId, locationId);
export const countStatusIn = (values: readonly StockCountStatus[]): SQL | undefined =>
  values.length > 0 ? inArray(stockCounts.status, [...values]) : undefined;
export const countKindIs = (kind: string): SQL => sql`${stockCounts.kind} = ${kind}`;
export const countScheduledFrom = (date: string): SQL => gte(stockCounts.scheduledFor, date);
export const countScheduledTo = (date: string): SQL => lte(stockCounts.scheduledFor, date);
export const countMatchesText = (pattern: string): SQL =>
  sql`(${stockCounts.countNo} ILIKE ${pattern} OR coalesce(${stockCounts.note}, '') ILIKE ${pattern})`;

export async function listCounts(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<{ rows: CountRow[]; total: number }> {
  const rows = await exec
    .select(countSelection)
    .from(stockCounts)
    .leftJoin(warehouses, eq(warehouses.id, stockCounts.warehouseId))
    .leftJoin(warehouseLocations, eq(warehouseLocations.id, stockCounts.locationId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const counted = await exec.select({ n: sql<number>`count(*)::int` }).from(stockCounts).where(where);

  return { rows: rows.map(flattenCount), total: counted[0]?.n ?? 0 };
}

export async function findCount(countId: string, exec: Executor = db): Promise<CountRow | undefined> {
  const rows = await exec
    .select(countSelection)
    .from(stockCounts)
    .leftJoin(warehouses, eq(warehouses.id, stockCounts.warehouseId))
    .leftJoin(warehouseLocations, eq(warehouseLocations.id, stockCounts.locationId))
    .where(eq(stockCounts.id, countId))
    .limit(1);
  const row = rows[0];
  return row ? flattenCount(row) : undefined;
}

/**
 * The count row, locked.
 *
 * Every transition takes this first. It is what makes two approvals of the same
 * count serialise: the second blocks here, and re-reads a row that already says
 * `approved`, so the state machine refuses it instead of posting the variance
 * twice.
 */
export async function lockCount(tx: Tx, countId: string): Promise<StockCount | undefined> {
  const rows = await tx.select().from(stockCounts).where(eq(stockCounts.id, countId)).for('update').limit(1);
  return rows[0];
}

export async function insertCount(
  tx: Tx,
  values: typeof stockCounts.$inferInsert,
): Promise<{ id: string; countNo: string }> {
  const rows = await tx
    .insert(stockCounts)
    .values(values)
    .returning({ id: stockCounts.id, countNo: stockCounts.countNo });
  const row = rows[0];
  if (!row) throw new Error('stock count insert returned nothing');
  return row;
}

export async function updateCount(
  tx: Tx,
  countId: string,
  patch: Partial<typeof stockCounts.$inferInsert>,
): Promise<void> {
  await tx.update(stockCounts).set(patch).where(eq(stockCounts.id, countId));
}

/* ---------------------------------------------------------- the snapshot */

/**
 * THE FREEZE. One statement: every level in scope becomes a count line carrying
 * the on-hand quantity as it is at this instant.
 *
 * `INSERT … SELECT` rather than read-then-write, so the snapshot is a single
 * consistent read of `inventory_levels` — a loop would freeze line one before
 * line nine hundred and produce a sheet that was never true all at once.
 *
 * `ON CONFLICT DO NOTHING` against `uq_stock_count_items` makes a retried start
 * idempotent instead of a constraint violation.
 *
 * The scope is the warehouse, optionally narrowed to a location SUBTREE. The
 * subtree test is `left(path, n) = prefix || '/'` rather than `LIKE prefix || '/%'`
 * on purpose: the location code CHECK permits `_`, which is a LIKE wildcard, so a
 * rack called `R_3` would drag `R13`'s bins into the count.
 */
export async function snapshotLevels(
  tx: Tx,
  input: { countId: string; warehouseId: string; locationRootPath: string | null },
): Promise<number> {
  const scope = input.locationRootPath
    ? sql` AND inventory_levels.location_id IN (
        SELECT wl.id FROM warehouse_locations wl
         WHERE wl.warehouse_id = ${input.warehouseId}
           AND wl.deleted_at IS NULL
           AND (wl.path = ${input.locationRootPath}
                OR left(wl.path, ${input.locationRootPath.length + 1}) = ${`${input.locationRootPath}/`}))`
    : sql``;

  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO stock_count_items (stock_count_id, inventory_level_id, system_qty)
    SELECT ${input.countId}, inventory_levels.id, inventory_levels.on_hand_qty
      FROM inventory_levels
     WHERE inventory_levels.warehouse_id = ${input.warehouseId}${scope}
    ON CONFLICT (stock_count_id, inventory_level_id) DO NOTHING
    RETURNING id`);

  return result.rows.length;
}

/* ----------------------------------------------------------- count lines */

export type CountItemRow = {
  id: string;
  inventoryLevelId: string;
  variantId: string | null;
  hamperItemId: string | null;
  packagingId: string | null;
  sku: string | null;
  name: string | null;
  binLocation: string | null;
  locationPath: string | null;
  systemQty: number;
  countedQty: number | null;
  /** The GENERATED column, `COALESCE(counted,0) − system`. Selected only to cross-check. */
  generatedVarianceQty: number | null;
  recountQty: number | null;
  reason: string | null;
  countedAt: Date | null;
  countedBy: string | null;
};

const itemSelection = {
  id: stockCountItems.id,
  inventoryLevelId: stockCountItems.inventoryLevelId,
  variantId: inventoryLevels.variantId,
  hamperItemId: inventoryLevels.hamperItemId,
  packagingId: inventoryLevels.packagingId,
  sku: levelSku,
  name: levelName,
  binLocation: inventoryLevels.binLocation,
  locationPath: levelLocationPath,
  systemQty: stockCountItems.systemQty,
  countedQty: stockCountItems.countedQty,
  generatedVarianceQty: stockCountItems.varianceQty,
  recountQty: stockCountItems.recountQty,
  reason: stockCountItems.reason,
  countedAt: stockCountItems.countedAt,
  countedBy: stockCountItems.countedBy,
} as const;

/** Non-zero variance among COUNTED lines only. Uncounted lines are excluded, not zeroed. */
const hasVariance = sql`${stockCountItems.countedQty} IS NOT NULL
  AND ${stockCountItems.countedQty} <> ${stockCountItems.systemQty}`;

export async function listCountItems(
  countId: string,
  filter: { onlyVariances: boolean; uncountedOnly: boolean },
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<{ rows: CountItemRow[]; total: number }> {
  const where = and(
    eq(stockCountItems.stockCountId, countId),
    filter.onlyVariances ? hasVariance : undefined,
    filter.uncountedOnly ? isNull(stockCountItems.countedQty) : undefined,
  );

  const rows = await exec
    .select(itemSelection)
    .from(stockCountItems)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, stockCountItems.inventoryLevelId))
    .where(where)
    // Ordered by SKU so the sheet reads like the shelf, with the level id as a
    // stable tiebreak — two pages of an unordered query can repeat a line.
    .orderBy(asc(levelSku), asc(stockCountItems.inventoryLevelId))
    .limit(limit)
    .offset(offset);

  const counted = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(stockCountItems)
    .where(where);

  return { rows, total: counted[0]?.n ?? 0 };
}

/** Every line of a count, unpaginated. Used for the header roll-up and for approval. */
export async function allCountLines(
  countId: string,
  exec: Executor = db,
): Promise<{ inventoryLevelId: string; systemQty: number; countedQty: number | null }[]> {
  return exec
    .select({
      inventoryLevelId: stockCountItems.inventoryLevelId,
      systemQty: stockCountItems.systemQty,
      countedQty: stockCountItems.countedQty,
    })
    .from(stockCountItems)
    .where(eq(stockCountItems.stockCountId, countId));
}

/** The counted, varying lines an approval will post — with the SKU for the error messages. */
export async function varianceLines(
  countId: string,
  exec: Executor = db,
): Promise<
  {
    id: string;
    inventoryLevelId: string;
    sku: string | null;
    systemQty: number;
    countedQty: number;
    generatedVarianceQty: number | null;
    reason: string | null;
  }[]
> {
  const rows = await exec
    .select({
      id: stockCountItems.id,
      inventoryLevelId: stockCountItems.inventoryLevelId,
      sku: levelSku,
      systemQty: stockCountItems.systemQty,
      countedQty: stockCountItems.countedQty,
      generatedVarianceQty: stockCountItems.varianceQty,
      reason: stockCountItems.reason,
    })
    .from(stockCountItems)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, stockCountItems.inventoryLevelId))
    .where(and(eq(stockCountItems.stockCountId, countId), isNotNull(stockCountItems.countedQty), hasVariance))
    .orderBy(asc(stockCountItems.inventoryLevelId));

  return rows.map((r) => ({ ...r, countedQty: r.countedQty ?? 0 }));
}

/**
 * Resolve submitted SKUs against the lines this count actually froze.
 *
 * The join through `stock_count_items` is what enforces scope: a SKU that is
 * stocked in the warehouse but was not in the count's location subtree simply
 * has no row here, and the service turns that absence into `sku_not_in_count_scope`.
 */
export async function findCountItemsBySkus(
  tx: Tx,
  countId: string,
  skus: readonly string[],
): Promise<Map<string, { id: string; inventoryLevelId: string; systemQty: number }>> {
  if (skus.length === 0) return new Map();

  const rows = await tx
    .select({
      id: stockCountItems.id,
      inventoryLevelId: stockCountItems.inventoryLevelId,
      systemQty: stockCountItems.systemQty,
      sku: levelSku,
    })
    .from(stockCountItems)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, stockCountItems.inventoryLevelId))
    .where(and(eq(stockCountItems.stockCountId, countId), inArray(levelSku, [...skus])));

  const found = new Map<string, { id: string; inventoryLevelId: string; systemQty: number }>();
  for (const row of rows) {
    if (row.sku) found.set(row.sku, { id: row.id, inventoryLevelId: row.inventoryLevelId, systemQty: row.systemQty });
  }
  return found;
}

export async function recordCountedQty(
  tx: Tx,
  itemId: string,
  values: { countedQty: number; recountQty: number | null; reason: string | null; countedBy: string; countedAt: Date },
): Promise<void> {
  await tx
    .update(stockCountItems)
    .set({
      countedQty: values.countedQty,
      recountQty: values.recountQty,
      reason: values.reason,
      countedBy: values.countedBy,
      countedAt: values.countedAt,
    })
    .where(eq(stockCountItems.id, itemId));
}

/** Re-read specific lines after a write, so the response carries the generated variance. */
export async function findCountItemsByIds(
  tx: Tx,
  itemIds: readonly string[],
): Promise<CountItemRow[]> {
  if (itemIds.length === 0) return [];
  return tx
    .select(itemSelection)
    .from(stockCountItems)
    .innerJoin(inventoryLevels, eq(inventoryLevels.id, stockCountItems.inventoryLevelId))
    .where(inArray(stockCountItems.id, [...itemIds]))
    .orderBy(asc(levelSku), asc(stockCountItems.inventoryLevelId));
}

/* ------------------------------------------------------- stock primitives */

/** Locks taken up front in ascending id order, so a count and a checkout queue rather than deadlock. */
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
 * THE oversell guard. The mechanism, not the backstop.
 *
 * `on_hand_qty − reserved_qty + delta >= 0` is folded INTO the write, and the
 * clause is applied to increments too so there is exactly one write path into
 * `on_hand_qty`. Returns the new row, or null when zero rows were updated — which
 * the caller MUST treat as `insufficient_stock`, never as a no-op.
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

/** The ledger is append-only. There is deliberately no `updateMovement` here or anywhere. */
export async function insertMovement(
  tx: Tx,
  values: {
    inventoryLevelId: string;
    quantityDelta: number;
    balanceAfter: number;
    referenceId: string;
    referenceLabel: string;
    note: string | null;
    actorId: string;
    occurredAt: Date;
  },
): Promise<{ id: bigint }> {
  const rows = await tx
    .insert(stockMovements)
    .values({
      inventoryLevelId: values.inventoryLevelId,
      // Both vocabularies were widened by 0003 specifically so a count's variance
      // is identifiable in the ledger as a count rather than as a hand adjustment.
      movementType: 'stock_count',
      quantityDelta: values.quantityDelta,
      balanceAfter: values.balanceAfter,
      referenceType: 'stock_count',
      referenceId: values.referenceId,
      referenceLabel: values.referenceLabel,
      note: values.note,
      actorId: values.actorId,
      occurredAt: values.occurredAt,
    })
    .returning({ id: stockMovements.id });

  const row = rows[0];
  if (!row) throw new Error('stock movement insert returned nothing');
  return row;
}

/** An in-progress count covering a level, for the scan endpoint's `stock_count` operation. */
export async function findOpenCountForLevel(
  levelId: string,
  exec: Executor = db,
): Promise<
  | {
      countId: string;
      countNo: string;
      status: StockCountStatus;
      itemId: string;
      systemQty: number;
      countedQty: number | null;
    }
  | undefined
> {
  const rows = await exec
    .select({
      countId: stockCounts.id,
      countNo: stockCounts.countNo,
      status: stockCounts.status,
      itemId: stockCountItems.id,
      systemQty: stockCountItems.systemQty,
      countedQty: stockCountItems.countedQty,
    })
    .from(stockCountItems)
    .innerJoin(stockCounts, eq(stockCounts.id, stockCountItems.stockCountId))
    .where(and(eq(stockCountItems.inventoryLevelId, levelId), eq(stockCounts.status, 'in_progress')))
    .orderBy(desc(stockCounts.startedAt))
    .limit(1);

  return rows[0];
}
