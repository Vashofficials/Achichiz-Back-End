import type { AnyPgColumn } from 'drizzle-orm/pg-core';
/**
 * Drizzle queries for locations and transfers. No business rules, no HTTP.
 *
 * Two conventions worth knowing before reading:
 *
 * **1. `inventory_levels.location_id` is reached through raw `sql`.**
 * Migration 0003 added the column; the Drizzle table object in
 * `db/schema/inventory.ts` was not regenerated, so `inventoryLevels.locationId`
 * does not exist as a typed column. The column is real and indexed — the mapping
 * is simply behind. Naming it in `sql` is honest about that rather than pretending
 * the column is absent.
 *
 * **2. `adjustOnHand` is the only way stock changes in this module.**
 * It is a conditional `UPDATE ... WHERE on_hand_qty - reserved_qty >= n` that
 * returns the new balance, so the guard and the `balance_after` for the ledger
 * come from the same statement. A read-then-write would be a race; a read AFTER
 * the write would be a second round trip that another transaction can slip past.
 * `null` back means the guard failed — the caller turns that into
 * `insufficient_stock`.
 */

import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  hamperItems,
  inventoryLevels,
  productVariants,
  stockMovements,
  stockTransferLines,
  stockTransfers,
  warehouseLocations,
  warehouses,
  type StockMovementType,
  type StockReferenceType,
  type StockTransfer,
  type StockTransferLine,
  type StockTransferStatus,
  type WarehouseLocation,
} from '../../db/schema/index.js';

/* ============================================================ stockable labels */

/**
 * SKU and title for whichever of the three stockables a level tracks.
 *
 * Correlated subqueries rather than three LEFT JOINs: exactly one of the three
 * ids is non-null (CHECK `inventory_exactly_one_stockable`), so at most one
 * subquery does any work, and the row count cannot fan out.
 */
const stockableSku = sql<string | null>`coalesce(
  (SELECT pv.sku FROM product_variants pv WHERE pv.id = ${inventoryLevels.variantId}),
  (SELECT hi.sku FROM hamper_items hi WHERE hi.id = ${inventoryLevels.hamperItemId}),
  (SELECT pm.sku FROM packaging_materials pm WHERE pm.id = ${inventoryLevels.packagingId}))`;

const stockableTitle = sql<string | null>`coalesce(
  (SELECT p.title || ' — ' || pv.option_label
     FROM product_variants pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = ${inventoryLevels.variantId}),
  (SELECT hi.name FROM hamper_items hi WHERE hi.id = ${inventoryLevels.hamperItemId}),
  (SELECT pm.name FROM packaging_materials pm WHERE pm.id = ${inventoryLevels.packagingId}))`;

const levelLocationId = sql<string | null>`inventory_levels.location_id`;

const levelLocationPath = sql<string | null>`(
  SELECT wl.path FROM warehouse_locations wl WHERE wl.id = inventory_levels.location_id)`;

export const stockableKindOf = (row: {
  variantId: string | null;
  hamperItemId: string | null;
}): 'variant' | 'hamper_item' | 'packaging' =>
  row.variantId ? 'variant' : row.hamperItemId ? 'hamper_item' : 'packaging';

/* ================================================================ warehouses */

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

export async function warehouseNames(
  ids: readonly string[],
  exec: Executor = db,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await exec
    .select({ id: warehouses.id, name: warehouses.name })
    .from(warehouses)
    .where(inArray(warehouses.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/* ================================================================= locations */

export type LocationRow = WarehouseLocation & { childCount: number; stockedLevelCount: number };

const childCount = sql<number>`coalesce((
  SELECT count(*)::int FROM warehouse_locations c
   WHERE c.parent_id = ${warehouseLocations.id} AND c.deleted_at IS NULL), 0)`;

const stockedLevelCount = sql<number>`coalesce((
  SELECT count(*)::int FROM inventory_levels il
   WHERE il.location_id = ${warehouseLocations.id}), 0)`;

const LOCATION_SORT_COLUMNS = {
  path: warehouseLocations.path,
  code: warehouseLocations.code,
  kind: warehouseLocations.kind,
  sortOrder: warehouseLocations.sortOrder,
  createdAt: warehouseLocations.createdAt,
} as const;

export const locationSortColumn = (field: string): AnyPgColumn =>
  LOCATION_SORT_COLUMNS[field as keyof typeof LOCATION_SORT_COLUMNS] ?? warehouseLocations.path;

export async function listLocations(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<{ rows: LocationRow[]; total: number }> {
  const rows = await exec
    .select({
      location: warehouseLocations,
      childCount,
      stockedLevelCount,
    })
    .from(warehouseLocations)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const counted = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(warehouseLocations)
    .where(where);

  return {
    rows: rows.map((r) => ({ ...r.location, childCount: r.childCount, stockedLevelCount: r.stockedLevelCount })),
    total: counted[0]?.n ?? 0,
  };
}

export async function findLocation(
  warehouseId: string,
  locationId: string,
  exec: Executor = db,
): Promise<LocationRow | undefined> {
  const rows = await exec
    .select({ location: warehouseLocations, childCount, stockedLevelCount })
    .from(warehouseLocations)
    .where(and(eq(warehouseLocations.id, locationId), eq(warehouseLocations.warehouseId, warehouseId)))
    .limit(1);
  const row = rows[0];
  return row ? { ...row.location, childCount: row.childCount, stockedLevelCount: row.stockedLevelCount } : undefined;
}

/** Bare row, no aggregates — used while validating a parent or walking ancestors. */
export async function findLocationRow(
  locationId: string,
  exec: Executor = db,
): Promise<WarehouseLocation | undefined> {
  const rows = await exec
    .select()
    .from(warehouseLocations)
    .where(eq(warehouseLocations.id, locationId))
    .limit(1);
  return rows[0];
}

export async function insertLocation(
  tx: Tx,
  values: typeof warehouseLocations.$inferInsert,
): Promise<WarehouseLocation> {
  const rows = await tx.insert(warehouseLocations).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('warehouse_locations insert returned no row');
  return row;
}

export async function updateLocation(
  tx: Tx,
  locationId: string,
  patch: Partial<typeof warehouseLocations.$inferInsert>,
): Promise<void> {
  await tx.update(warehouseLocations).set(patch).where(eq(warehouseLocations.id, locationId));
}

/**
 * Rewrite the materialised path of a location AND every descendant, in one statement.
 *
 * `left(path, n) = prefix || '/'` rather than `LIKE prefix || '/%'` on purpose:
 * the code CHECK permits `_`, which is a LIKE wildcard, so a rack called `R_3`
 * would match `R13` and drag an unrelated subtree along with it.
 */
export async function repathSubtree(
  tx: Tx,
  warehouseId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE warehouse_locations
       SET path = ${newPath} || substring(path FROM ${oldPath.length + 1}),
           updated_at = now()
     WHERE warehouse_id = ${warehouseId}
       AND deleted_at IS NULL
       AND (path = ${oldPath} OR left(path, ${oldPath.length + 1}) = ${`${oldPath}/`})`);
}

/** Descendants + self, live only. Used to prove a re-parent is not a cycle. */
export async function subtreeIds(
  warehouseId: string,
  rootPath: string,
  exec: Executor = db,
): Promise<string[]> {
  const rows = await exec.execute<{ id: string }>(sql`
    SELECT id FROM warehouse_locations
     WHERE warehouse_id = ${warehouseId}
       AND deleted_at IS NULL
       AND (path = ${rootPath} OR left(path, ${rootPath.length + 1}) = ${`${rootPath}/`})`);
  return rows.rows.map((r) => r.id);
}

export async function liveChildCount(tx: Tx, locationId: string): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(warehouseLocations)
    .where(and(eq(warehouseLocations.parentId, locationId), isNull(warehouseLocations.deletedAt)));
  return rows[0]?.n ?? 0;
}

export async function levelsAtLocation(tx: Tx, locationId: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM inventory_levels WHERE location_id = ${locationId}`,
  );
  return rows.rows[0]?.n ?? 0;
}

/* ====================================================== warehouse inventory */

export type WarehouseInventoryLevelRow = {
  id: string;
  variantId: string | null;
  hamperItemId: string | null;
  packagingId: string | null;
  onHandQty: number;
  reservedQty: number;
  availableQty: number | null;
  incomingQty: number;
  reorderPoint: number;
  reorderQty: number;
  binLocation: string | null;
  lastMovementAt: Date | null;
  sku: string | null;
  title: string | null;
  locationId: string | null;
  locationPath: string | null;
};

const INVENTORY_SORT_COLUMNS = {
  onHandQty: inventoryLevels.onHandQty,
  reservedQty: inventoryLevels.reservedQty,
  availableQty: inventoryLevels.availableQty,
  incomingQty: inventoryLevels.incomingQty,
  lastMovementAt: inventoryLevels.lastMovementAt,
} as const;

export const inventorySortExpression = (field: string, direction: 'asc' | 'desc'): SQL => {
  const column = INVENTORY_SORT_COLUMNS[field as keyof typeof INVENTORY_SORT_COLUMNS];
  if (!column) return direction === 'desc' ? sql`${stockableSku} DESC NULLS LAST` : sql`${stockableSku} ASC NULLS LAST`;
  return direction === 'desc' ? desc(column) : asc(column);
};

export async function listWarehouseInventory(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<{ rows: WarehouseInventoryLevelRow[]; total: number }> {
  const rows = await exec
    .select({
      id: inventoryLevels.id,
      variantId: inventoryLevels.variantId,
      hamperItemId: inventoryLevels.hamperItemId,
      packagingId: inventoryLevels.packagingId,
      onHandQty: inventoryLevels.onHandQty,
      reservedQty: inventoryLevels.reservedQty,
      availableQty: inventoryLevels.availableQty,
      incomingQty: inventoryLevels.incomingQty,
      reorderPoint: inventoryLevels.reorderPoint,
      reorderQty: inventoryLevels.reorderQty,
      binLocation: inventoryLevels.binLocation,
      lastMovementAt: inventoryLevels.lastMovementAt,
      sku: stockableSku,
      title: stockableTitle,
      locationId: levelLocationId,
      locationPath: levelLocationPath,
    })
    .from(inventoryLevels)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const counted = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryLevels)
    .where(where);

  return { rows, total: counted[0]?.n ?? 0 };
}

export const inventorySearchClause = (pattern: string): SQL =>
  sql`(${stockableSku} ILIKE ${pattern} OR ${stockableTitle} ILIKE ${pattern})`;

export const inventoryAtLocation = (locationId: string): SQL =>
  sql`inventory_levels.location_id = ${locationId}`;

export const inventoryLowStock = (): SQL =>
  sql`${inventoryLevels.availableQty} <= ${inventoryLevels.reorderPoint}`;

/* =========================================================== stock primitives */

export type StockableRef = { variantId: string | null; hamperItemId: string | null; packagingId: string | null };

/**
 * Find or create the inventory level for one stockable in one warehouse.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique index, then re-select.
 * Two concurrent receipts of the same SKU into the same warehouse both want this
 * row; the loser of the insert race must find the winner's row rather than fail.
 */
export async function ensureLevel(
  tx: Tx,
  warehouseId: string,
  ref: StockableRef,
): Promise<{ id: string; onHandQty: number }> {
  const match = and(
    eq(inventoryLevels.warehouseId, warehouseId),
    ref.variantId ? eq(inventoryLevels.variantId, ref.variantId) : isNull(inventoryLevels.variantId),
    ref.hamperItemId ? eq(inventoryLevels.hamperItemId, ref.hamperItemId) : isNull(inventoryLevels.hamperItemId),
    ref.packagingId ? eq(inventoryLevels.packagingId, ref.packagingId) : isNull(inventoryLevels.packagingId),
  );

  const existing = await tx
    .select({ id: inventoryLevels.id, onHandQty: inventoryLevels.onHandQty })
    .from(inventoryLevels)
    .where(match)
    .limit(1);
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

  const after = await tx
    .select({ id: inventoryLevels.id, onHandQty: inventoryLevels.onHandQty })
    .from(inventoryLevels)
    .where(match)
    .limit(1);
  const row = after[0];
  if (!row) throw new Error('inventory level could not be created or read back');
  return row;
}

/** Look up an existing level without creating one. `undefined` means nothing has ever been stocked. */
export async function findLevel(
  tx: Tx,
  warehouseId: string,
  ref: StockableRef,
): Promise<{ id: string; onHandQty: number } | undefined> {
  const rows = await tx
    .select({ id: inventoryLevels.id, onHandQty: inventoryLevels.onHandQty })
    .from(inventoryLevels)
    .where(
      and(
        eq(inventoryLevels.warehouseId, warehouseId),
        ref.variantId ? eq(inventoryLevels.variantId, ref.variantId) : isNull(inventoryLevels.variantId),
        ref.hamperItemId ? eq(inventoryLevels.hamperItemId, ref.hamperItemId) : isNull(inventoryLevels.hamperItemId),
        ref.packagingId ? eq(inventoryLevels.packagingId, ref.packagingId) : isNull(inventoryLevels.packagingId),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * THE oversell guard (§62/§64).
 *
 * A negative `delta` decrements and is refused unless
 * `on_hand_qty - reserved_qty >= |delta|` — reserved stock belongs to someone
 * else's cart, so it is not available to ship out on a transfer or a return. A
 * positive `delta` increments and cannot fail that test.
 *
 * Returns the new `on_hand_qty`, which IS the movement's `balance_after`.
 * Returns `null` when the guard refused: zero rows updated, nothing written,
 * caller raises `insufficient_stock`. Race-free at READ COMMITTED because the
 * predicate is evaluated against the row version this statement locks.
 */
export async function adjustOnHand(tx: Tx, levelId: string, delta: number): Promise<number | null> {
  if (delta === 0) throw new Error('adjustOnHand called with a zero delta — a movement of nothing is not a movement');

  const guard =
    delta < 0
      ? sql` AND on_hand_qty - reserved_qty >= ${-delta}`
      : sql``;

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
 * `incoming_qty` — units expected to arrive at this warehouse.
 *
 * One definition across both modules: a SENT purchase order raises it, a goods
 * receipt lowers it; a transfer dispatch raises it at the destination, the
 * matching receipt lowers it. It never touches `available_qty`, which is
 * GENERATED from `on_hand - reserved`, so stock in transit stays invisible to
 * both warehouses' sellable stock — which is the correct answer, not a gap.
 *
 * `GREATEST(..., 0)` because the column has a `>= 0` CHECK and this is a
 * best-effort projection, not a ledger. A drift here must not abort a receipt
 * that is otherwise correct.
 */
export async function adjustIncoming(tx: Tx, levelId: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await tx.execute(sql`
    UPDATE inventory_levels
       SET incoming_qty = GREATEST(incoming_qty + ${delta}, 0),
           updated_at = now()
     WHERE id = ${levelId}`);
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
  await tx.insert(stockMovements).values({
    inventoryLevelId: values.inventoryLevelId,
    movementType: values.movementType,
    quantityDelta: values.quantityDelta,
    balanceAfter: values.balanceAfter,
    referenceType: values.referenceType,
    referenceId: values.referenceId,
    referenceLabel: values.referenceLabel,
    note: values.note ?? null,
    actorId: values.actorId ?? null,
  });
}

/* ================================================================= transfers */

export type TransferRow = StockTransfer;
export type TransferLineRow = StockTransferLine & { sku: string | null; title: string | null };

const TRANSFER_SORT_COLUMNS = {
  createdAt: stockTransfers.createdAt,
  transferNo: stockTransfers.transferNo,
  status: stockTransfers.status,
  etaOn: stockTransfers.etaOn,
} as const;

export const transferSortColumn = (field: string): AnyPgColumn =>
  TRANSFER_SORT_COLUMNS[field as keyof typeof TRANSFER_SORT_COLUMNS] ?? stockTransfers.createdAt;

/**
 * `TRF-2026-00061` from the row-locked series, never `Math.random()`.
 *
 * The '2026' scope is seeded by migration 0001; a later year creates its own row
 * on first use, which is a no-op forever after. `next_document_number` takes a
 * row lock held to COMMIT, so it is called as late as the transaction allows.
 */
export async function nextTransferNumber(tx: Tx, year: number): Promise<string> {
  const scope = String(year);
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('stock_transfer', ${scope}, ${`TRF-${scope}-`}, '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ transfer_no: string }>(
    sql`SELECT next_document_number('stock_transfer', ${scope}) AS transfer_no`,
  );
  const transferNo = result.rows[0]?.transfer_no;
  if (!transferNo) throw new Error('next_document_number returned no transfer number');
  return transferNo;
}

export async function listTransfers(
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
  exec: Executor = db,
): Promise<{ rows: (TransferRow & { lineCount: number; sentQty: number; receivedQty: number })[]; total: number }> {
  const lineCount = sql<number>`coalesce((
    SELECT count(*)::int FROM stock_transfer_lines l WHERE l.transfer_id = ${stockTransfers.id}), 0)`;
  const sentQty = sql<number>`coalesce((
    SELECT sum(l.sent_qty)::int FROM stock_transfer_lines l WHERE l.transfer_id = ${stockTransfers.id}), 0)`;
  const receivedQty = sql<number>`coalesce((
    SELECT sum(l.received_qty)::int FROM stock_transfer_lines l WHERE l.transfer_id = ${stockTransfers.id}), 0)`;

  const rows = await exec
    .select({ transfer: stockTransfers, lineCount, sentQty, receivedQty })
    .from(stockTransfers)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const counted = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(stockTransfers)
    .where(where);

  return {
    rows: rows.map((r) => ({
      ...r.transfer,
      lineCount: r.lineCount,
      sentQty: r.sentQty,
      receivedQty: r.receivedQty,
    })),
    total: counted[0]?.n ?? 0,
  };
}

export const transferTouchesWarehouse = (warehouseId: string): SQL | undefined =>
  or(eq(stockTransfers.fromWarehouseId, warehouseId), eq(stockTransfers.toWarehouseId, warehouseId));

export const transferStatusIn = (values: readonly StockTransferStatus[]): SQL | undefined =>
  values.length > 0 ? inArray(stockTransfers.status, [...values]) : undefined;

export const transferEtaFrom = (date: string): SQL => gte(stockTransfers.etaOn, date);
export const transferEtaTo = (date: string): SQL => lte(stockTransfers.etaOn, date);
export const transferDispatched = (): SQL | undefined => isNotNull(stockTransfers.dispatchedAt);

export async function findTransfer(transferId: string, exec: Executor = db): Promise<TransferRow | undefined> {
  const rows = await exec.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).limit(1);
  return rows[0];
}

/** Re-read under a row lock: an operator's screen may be minutes old. */
export async function lockTransfer(tx: Tx, transferId: string): Promise<TransferRow | undefined> {
  const rows = await tx
    .select()
    .from(stockTransfers)
    .where(eq(stockTransfers.id, transferId))
    .limit(1)
    .for('update');
  return rows[0];
}

export async function findTransferLines(
  transferId: string,
  exec: Executor = db,
): Promise<TransferLineRow[]> {
  const sku = sql<string | null>`coalesce(
    (SELECT pv.sku FROM product_variants pv WHERE pv.id = ${stockTransferLines.variantId}),
    (SELECT hi.sku FROM hamper_items hi WHERE hi.id = ${stockTransferLines.hamperItemId}))`;
  const title = sql<string | null>`coalesce(
    (SELECT p.title || ' — ' || pv.option_label
       FROM product_variants pv JOIN products p ON p.id = pv.product_id
      WHERE pv.id = ${stockTransferLines.variantId}),
    (SELECT hi.name FROM hamper_items hi WHERE hi.id = ${stockTransferLines.hamperItemId}))`;

  const rows = await exec
    .select({ line: stockTransferLines, sku, title })
    .from(stockTransferLines)
    .where(eq(stockTransferLines.transferId, transferId))
    .orderBy(asc(stockTransferLines.id));

  return rows.map((r) => ({ ...r.line, sku: r.sku, title: r.title }));
}

export async function insertTransfer(
  tx: Tx,
  values: typeof stockTransfers.$inferInsert,
): Promise<TransferRow> {
  const rows = await tx.insert(stockTransfers).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('stock_transfers insert returned no row');
  return row;
}

export async function insertTransferLines(
  tx: Tx,
  values: (typeof stockTransferLines.$inferInsert)[],
): Promise<void> {
  if (values.length === 0) return;
  await tx.insert(stockTransferLines).values(values);
}

export async function updateTransfer(
  tx: Tx,
  transferId: string,
  patch: Partial<typeof stockTransfers.$inferInsert>,
): Promise<void> {
  await tx.update(stockTransfers).set(patch).where(eq(stockTransfers.id, transferId));
}

export async function setTransferLineReceived(tx: Tx, lineId: string, receivedQty: number): Promise<void> {
  await tx.update(stockTransferLines).set({ receivedQty }).where(eq(stockTransferLines.id, lineId));
}

/**
 * Take the row locks up front, in ascending id order.
 *
 * The same protocol `checkout` and `admin-orders` use. Two transfers that share
 * SKUs will grab the same levels; without an agreed order they can each hold
 * what the other wants. Sorting makes them queue instead of deadlock. The
 * conditional UPDATE in `adjustOnHand` would lock anyway — this decides the
 * ORDER, which is the part that matters.
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

/** Live variant ids, for validating transfer lines before anything is written. */
export async function existingVariantIds(ids: readonly string[], exec: Executor = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await exec
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(inArray(productVariants.id, [...ids]), isNull(productVariants.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

/** Live hamper-item ids, same reason. */
export async function existingHamperItemIds(ids: readonly string[], exec: Executor = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await exec
    .select({ id: hamperItems.id })
    .from(hamperItems)
    .where(and(inArray(hamperItems.id, [...ids]), isNull(hamperItems.deletedAt)));
  return new Set(rows.map((r) => r.id));
}
