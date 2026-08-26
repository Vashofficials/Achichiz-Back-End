/**
 * Bin locations and inter-warehouse transfers.
 *
 * Four rules shape this file.
 *
 * **1. `path` is derived, never received.** The service computes it from the
 * parent chain on create and rewrites the whole subtree on a move. A client that
 * could POST a `path` would be setting a denormalisation that is no longer
 * derived from anything, and the first wrong value would silently send a picker
 * to the wrong aisle.
 *
 * **2. A stock-touching step is ONE transaction.** Dispatch decrements every
 * source line and writes every `transfer_out` movement, or it does neither. A
 * partial dispatch that committed three lines and failed the fourth would leave
 * stock that is in no warehouse and on no document.
 *
 * **3. Stock in transit belongs to neither warehouse.** Dispatch removes it from
 * the source immediately; receive adds it to the destination. Between the two it
 * is in nobody's `available_qty` — and that is the correct answer, because it is
 * on a lorry. `incoming_qty` at the destination is how it stays visible without
 * being sellable.
 *
 * **4. Never negative, never silent.** Every decrement goes through
 * `repo.adjustOnHand`, whose conditional `UPDATE ... WHERE on_hand - reserved >= n`
 * returns `null` rather than a negative balance. That becomes a 422 with the
 * stable code `insufficient_stock`, naming the SKU that was short.
 */

import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db, type Tx } from '../../config/db.js';
import { BadRequestError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import * as repo from './admin-warehousing.repository.js';
import {
  assertLocationDepth,
  assertTransferAction,
  buildLocationPath,
  transferEdgesFrom,
  type LocationKindKey,
  type TransferAction,
} from './admin-warehousing.state.js';
import type {
  LocationResponse,
  TransferDetailResponse,
  TransferSummaryResponse,
  WarehouseInventoryRow,
} from './admin-warehousing.schemas.js';
import type { StaffAuth } from '../../lib/openapi/define-route.js';
import {
  inventoryLevels,
  stockTransfers,
  STOCK_TRANSFER_STATUSES,
  warehouseLocations,
  type LocationKind,
  type StockTransferStatus,
} from '../../db/schema/index.js';

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/* ============================================================== locations */

const toLocationResponse = (row: repo.LocationRow): LocationResponse => ({
  id: row.id,
  warehouseId: row.warehouseId,
  parentId: row.parentId,
  kind: row.kind,
  code: row.code,
  name: row.name,
  path: row.path,
  // Derived rather than stored: it is a property of the path, and a second
  // column would be a second thing that can disagree.
  depth: row.path.split('/').length - 1,
  isPickable: row.isPickable,
  sortOrder: row.sortOrder,
  childCount: row.childCount,
  stockedLevelCount: row.stockedLevelCount,
  archivedAt: row.deletedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

async function assertWarehouse(warehouseId: string): Promise<void> {
  const warehouse = await repo.findWarehouse(warehouseId);
  if (!warehouse) throw new NotFoundError('Warehouse', warehouseId);
}

export type LocationListQuery = {
  page: number;
  perPage: number;
  q?: string | undefined;
  sort?: string | undefined;
  kind?: LocationKind | undefined;
  parentId?: string | undefined;
  pickable?: 'true' | 'false' | undefined;
  includeArchived: 'true' | 'false';
};

/** Exported for the test: the whole WHERE is buildable without a database. */
export function buildLocationWhere(warehouseId: string, query: LocationListQuery): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    eq(warehouseLocations.warehouseId, warehouseId),
    query.includeArchived === 'true' ? undefined : isNull(warehouseLocations.deletedAt),
    query.kind ? eq(warehouseLocations.kind, query.kind) : undefined,
    query.parentId ? eq(warehouseLocations.parentId, query.parentId) : undefined,
    query.pickable ? eq(warehouseLocations.isPickable, query.pickable === 'true') : undefined,
    query.q
      ? sql`(${warehouseLocations.path} ILIKE ${`%${escapeLike(query.q)}%`}
             OR ${warehouseLocations.code} ILIKE ${`%${escapeLike(query.q)}%`}
             OR coalesce(${warehouseLocations.name}, '') ILIKE ${`%${escapeLike(query.q)}%`})`
      : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  return present.length > 0 ? and(...present) : undefined;
}

const LOCATION_SORT_FIELDS = ['path', 'code', 'kind', 'sortOrder', 'createdAt'] as const;

export async function listLocations(
  warehouseId: string,
  query: LocationListQuery,
): Promise<{ items: LocationResponse[]; total: number }> {
  await assertWarehouse(warehouseId);

  const where = buildLocationWhere(warehouseId, query);
  const { field, direction } = parseSort(query.sort, LOCATION_SORT_FIELDS, { field: 'path', direction: 'asc' });
  const column = repo.locationSortColumn(field);
  const orderBy = [
    direction === 'desc' ? desc(column) : asc(column),
    asc(warehouseLocations.id),
  ] as SQL[];

  const { rows, total } = await repo.listLocations(where, orderBy, query.perPage, offsetOf(query.page, query.perPage));
  return { items: rows.map(toLocationResponse), total };
}

export async function getLocation(warehouseId: string, locationId: string): Promise<LocationResponse> {
  const row = await repo.findLocation(warehouseId, locationId);
  if (!row) throw new NotFoundError('Warehouse location', locationId);
  return toLocationResponse(row);
}

/**
 * Resolve the parent and return the path prefix to build under.
 *
 * Three refusals, all 422 rather than a database error: a parent in another
 * warehouse (paths are unique per warehouse, so this would silently create a
 * second tree), an archived parent (live children under a dead branch), and a
 * child at or above its parent's level.
 */
async function resolveParent(
  tx: Tx,
  warehouseId: string,
  parentId: string | null | undefined,
  childKind: LocationKindKey,
): Promise<{ parentId: string | null; parentPath: string | null }> {
  if (!parentId) {
    assertLocationDepth(null, childKind);
    return { parentId: null, parentPath: null };
  }

  const parent = await repo.findLocationRow(parentId, tx);
  if (!parent) throw new NotFoundError('Parent location', parentId);
  if (parent.warehouseId !== warehouseId) {
    throw new UnprocessableError(
      'That parent belongs to a different warehouse. A location tree does not span warehouses — `path` ' +
        'is only unique within one.',
      'parent_in_other_warehouse',
      { context: { parentId, parentWarehouseId: parent.warehouseId, warehouseId } },
    );
  }
  if (parent.deletedAt) {
    throw new UnprocessableError(
      `Parent location \`${parent.path}\` is archived. Restore it before hanging live locations under it.`,
      'parent_archived',
      { context: { parentId } },
    );
  }

  assertLocationDepth(parent.kind, childKind);
  return { parentId: parent.id, parentPath: parent.path };
}

export async function createLocation(
  warehouseId: string,
  input: {
    parentId?: string | null | undefined;
    kind: LocationKind;
    code: string;
    name?: string | null | undefined;
    isPickable: boolean;
    sortOrder: number;
  },
): Promise<LocationResponse> {
  await assertWarehouse(warehouseId);

  const created = await db.transaction(async (tx) => {
    const { parentId, parentPath } = await resolveParent(tx, warehouseId, input.parentId, input.kind);
    const path = buildLocationPath(parentPath, input.code);

    await assertPathFree(tx, warehouseId, path, null);

    return repo.insertLocation(tx, {
      warehouseId,
      parentId,
      kind: input.kind,
      code: input.code,
      name: input.name ?? null,
      path,
      isPickable: input.isPickable,
      sortOrder: input.sortOrder,
    });
  });

  return getLocation(warehouseId, created.id);
}

async function assertPathFree(
  tx: Tx,
  warehouseId: string,
  path: string,
  ignoreLocationId: string | null,
): Promise<void> {
  const clash = await tx
    .select({ id: warehouseLocations.id })
    .from(warehouseLocations)
    .where(
      and(
        eq(warehouseLocations.warehouseId, warehouseId),
        eq(warehouseLocations.path, path),
        isNull(warehouseLocations.deletedAt),
      ),
    )
    .limit(1);

  const existing = clash[0];
  if (!existing || existing.id === ignoreLocationId) return;

  throw new UnprocessableError(
    `\`${path}\` already exists in this warehouse. Location codes are unique within their parent.`,
    'location_path_taken',
    { context: { path } },
  );
}

/**
 * Edit or move a location.
 *
 * A move rewrites `path` for the location AND every descendant in the same
 * transaction — a grandchild left holding the old prefix is a bin that exists in
 * the database and nowhere in the warehouse.
 *
 * The cycle check is the reason `subtreeIds` exists: making a location a child
 * of its own descendant would produce a ring that no recursive walk terminates
 * on, and the `parent_id IS DISTINCT FROM id` CHECK only catches the trivial
 * one-node case.
 */
export async function updateLocation(
  warehouseId: string,
  locationId: string,
  input: {
    parentId?: string | null | undefined;
    code?: string | undefined;
    name?: string | null | undefined;
    isPickable?: boolean | undefined;
    sortOrder?: number | undefined;
  },
): Promise<LocationResponse> {
  await db.transaction(async (tx) => {
    const current = await repo.findLocationRow(locationId, tx);
    if (!current || current.warehouseId !== warehouseId) {
      throw new NotFoundError('Warehouse location', locationId);
    }
    if (current.deletedAt) {
      throw new UnprocessableError(
        'This location is archived. Restore it before editing.',
        'location_archived',
        { context: { locationId } },
      );
    }

    const reparenting = input.parentId !== undefined;
    const recoding = input.code !== undefined && input.code !== current.code;

    const patch: Partial<typeof warehouseLocations.$inferInsert> = {
      ...(input.name !== undefined ? { name: input.name ?? null } : {}),
      ...(input.isPickable !== undefined ? { isPickable: input.isPickable } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(recoding ? { code: input.code } : {}),
      updatedAt: new Date(),
    };

    if (!reparenting && !recoding) {
      await repo.updateLocation(tx, locationId, patch);
      return;
    }

    const nextParentId = reparenting ? (input.parentId ?? null) : current.parentId;

    if (nextParentId === locationId) {
      throw new UnprocessableError(
        'A location cannot be its own parent.',
        'location_cycle',
        { context: { locationId } },
      );
    }

    if (nextParentId && nextParentId !== current.parentId) {
      // The whole point: a descendant cannot become an ancestor.
      const descendants = await repo.subtreeIds(warehouseId, current.path, tx);
      if (descendants.includes(nextParentId)) {
        throw new UnprocessableError(
          'That parent sits inside this location’s own subtree, so the move would create a cycle — the ' +
            'location would end up beneath itself and no path could be computed for either.',
          'location_cycle',
          { context: { locationId, parentId: nextParentId } },
        );
      }
    }

    const { parentId, parentPath } = await resolveParent(
      tx,
      warehouseId,
      nextParentId,
      current.kind,
    );
    const newPath = buildLocationPath(parentPath, input.code ?? current.code);

    if (newPath !== current.path) {
      await assertPathFree(tx, warehouseId, newPath, locationId);
    }

    await repo.updateLocation(tx, locationId, { ...patch, parentId });
    if (newPath !== current.path) {
      await repo.repathSubtree(tx, warehouseId, current.path, newPath);
    }
  });

  return getLocation(warehouseId, locationId);
}

/**
 * Archive, not delete (§96).
 *
 * Two refusals. A location with live children would orphan them — `parent_id`
 * is `ON DELETE RESTRICT` for the same reason. A location that inventory levels
 * still point at would make those levels claim a bin that no longer exists;
 * move the stock first, so the ledger keeps naming somewhere real.
 */
export async function archiveLocation(
  warehouseId: string,
  locationId: string,
): Promise<LocationResponse> {
  await db.transaction(async (tx) => {
    const current = await repo.findLocationRow(locationId, tx);
    if (!current || current.warehouseId !== warehouseId) {
      throw new NotFoundError('Warehouse location', locationId);
    }
    if (current.deletedAt) return; // Idempotent: archiving an archived location is a no-op, not an error.

    const children = await repo.liveChildCount(tx, locationId);
    if (children > 0) {
      throw new UnprocessableError(
        `\`${current.path}\` still has ${children} live child location(s). Archive or move them first — ` +
          'archiving a branch would leave them pointing at a dead parent.',
        'location_has_children',
        { context: { locationId, children } },
      );
    }

    const levels = await repo.levelsAtLocation(tx, locationId);
    if (levels > 0) {
      throw new UnprocessableError(
        `${levels} inventory level(s) are still stored at \`${current.path}\`. Move the stock to another ` +
          'location before archiving this one.',
        'location_has_stock',
        { context: { locationId, levels } },
      );
    }

    await repo.updateLocation(tx, locationId, { deletedAt: new Date(), updatedAt: new Date() });
  });

  return getLocation(warehouseId, locationId);
}

/* ==================================================== warehouse inventory */

export type WarehouseInventoryQuery = {
  page: number;
  perPage: number;
  q?: string | undefined;
  sort?: string | undefined;
  locationId?: string | undefined;
  lowStock?: 'true' | 'false' | undefined;
};

const INVENTORY_SORT_FIELDS = [
  'sku',
  'onHandQty',
  'availableQty',
  'reservedQty',
  'incomingQty',
  'lastMovementAt',
] as const;

export async function listWarehouseInventory(
  warehouseId: string,
  query: WarehouseInventoryQuery,
): Promise<{ items: WarehouseInventoryRow[]; total: number }> {
  await assertWarehouse(warehouseId);

  const conditions: (SQL | undefined)[] = [
    eq(inventoryLevels.warehouseId, warehouseId),
    query.locationId ? repo.inventoryAtLocation(query.locationId) : undefined,
    query.lowStock === 'true' ? repo.inventoryLowStock() : undefined,
    query.q ? repo.inventorySearchClause(`%${escapeLike(query.q)}%`) : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  const where = present.length > 0 ? and(...present) : undefined;

  const { field, direction } = parseSort(query.sort, INVENTORY_SORT_FIELDS, { field: 'sku', direction: 'asc' });
  const orderBy = [repo.inventorySortExpression(field, direction), asc(inventoryLevels.id)] as SQL[];

  const { rows, total } = await repo.listWarehouseInventory(
    where,
    orderBy,
    query.perPage,
    offsetOf(query.page, query.perPage),
  );

  return {
    items: rows.map((row) => ({
      inventoryLevelId: row.id,
      stockableKind: repo.stockableKindOf(row),
      stockableId: row.variantId ?? row.hamperItemId ?? row.packagingId ?? row.id,
      sku: row.sku,
      title: row.title,
      onHandQty: row.onHandQty,
      reservedQty: row.reservedQty,
      // GENERATED column: typed nullable by Drizzle, never null in practice.
      availableQty: row.availableQty ?? row.onHandQty - row.reservedQty,
      incomingQty: row.incomingQty,
      reorderPoint: row.reorderPoint,
      reorderQty: row.reorderQty,
      locationId: row.locationId,
      locationPath: row.locationPath,
      binLocation: row.binLocation,
      lastMovementAt: row.lastMovementAt?.toISOString() ?? null,
    })),
    total,
  };
}

/* ============================================================== transfers */

export type TransferListQuery = {
  page: number;
  perPage: number;
  q?: string | undefined;
  sort?: string | undefined;
  status?: string | undefined;
  fromWarehouseId?: string | undefined;
  toWarehouseId?: string | undefined;
  warehouseId?: string | undefined;
  etaFrom?: string | undefined;
  etaTo?: string | undefined;
};

const TRANSFER_SORT_FIELDS = ['createdAt', 'transferNo', 'status', 'etaOn'] as const;

/** Exported for the test. An unknown status is a 400, not a silently empty page. */
export function parseTransferStatuses(raw: string | undefined): StockTransferStatus[] {
  const values = csv(raw);
  const unknown = values.filter((v) => !(STOCK_TRANSFER_STATUSES as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown transfer status: ${unknown.join(', ')}. Valid values: ${STOCK_TRANSFER_STATUSES.join(', ')}. ` +
        'Note that `draft`, `dispatched` and `completed` are not stored statuses — they map to ' +
        '`requested`, `in_transit` and `received`.',
    );
  }
  return values as StockTransferStatus[];
}

export async function listTransfers(
  query: TransferListQuery,
): Promise<{ items: TransferSummaryResponse[]; total: number }> {
  const conditions: (SQL | undefined)[] = [
    repo.transferStatusIn(parseTransferStatuses(query.status)),
    query.fromWarehouseId ? eq(stockTransfers.fromWarehouseId, query.fromWarehouseId) : undefined,
    query.toWarehouseId ? eq(stockTransfers.toWarehouseId, query.toWarehouseId) : undefined,
    query.warehouseId ? repo.transferTouchesWarehouse(query.warehouseId) : undefined,
    query.etaFrom ? repo.transferEtaFrom(query.etaFrom) : undefined,
    query.etaTo ? repo.transferEtaTo(query.etaTo) : undefined,
    query.q ? sql`${stockTransfers.transferNo} ILIKE ${`%${escapeLike(query.q)}%`}` : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  const where = present.length > 0 ? and(...present) : undefined;

  const { field, direction } = parseSort(query.sort, TRANSFER_SORT_FIELDS, {
    field: 'createdAt',
    direction: 'desc',
  });
  const column = repo.transferSortColumn(field);
  const orderBy = [direction === 'desc' ? desc(column) : asc(column), asc(stockTransfers.id)] as SQL[];

  const { rows, total } = await repo.listTransfers(where, orderBy, query.perPage, offsetOf(query.page, query.perPage));

  const names = await repo.warehouseNames([
    ...new Set(rows.flatMap((r) => [r.fromWarehouseId, r.toWarehouseId])),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      transferNo: row.transferNo,
      status: row.status,
      fromWarehouseId: row.fromWarehouseId,
      fromWarehouseName: names.get(row.fromWarehouseId) ?? null,
      toWarehouseId: row.toWarehouseId,
      toWarehouseName: names.get(row.toWarehouseId) ?? null,
      lineCount: row.lineCount,
      totalSentQty: row.sentQty,
      totalReceivedQty: row.receivedQty,
      inTransitQty: inTransitQty(row.status, row.sentQty, row.receivedQty),
      etaOn: row.etaOn,
      dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
      receivedAt: row.receivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
  };
}

/**
 * How much is on the lorry right now.
 *
 * Non-zero only while `in_transit`: before dispatch nothing has left, and after
 * receipt everything that arrived is on the destination's books. Exported
 * because "in neither warehouse" is the invariant most worth a test.
 */
export function inTransitQty(status: StockTransferStatus, sentQty: number, receivedQty: number): number {
  return status === 'in_transit' ? Math.max(0, sentQty - receivedQty) : 0;
}

export async function getTransfer(transferId: string): Promise<TransferDetailResponse> {
  const transfer = await repo.findTransfer(transferId);
  if (!transfer) throw new NotFoundError('Stock transfer', transferId);

  const lines = await repo.findTransferLines(transferId);
  const names = await repo.warehouseNames([transfer.fromWarehouseId, transfer.toWarehouseId]);

  const sentQty = lines.reduce((sum, l) => sum + l.sentQty, 0);
  const receivedQty = lines.reduce((sum, l) => sum + l.receivedQty, 0);

  return {
    id: transfer.id,
    transferNo: transfer.transferNo,
    status: transfer.status,
    fromWarehouseId: transfer.fromWarehouseId,
    fromWarehouseName: names.get(transfer.fromWarehouseId) ?? null,
    toWarehouseId: transfer.toWarehouseId,
    toWarehouseName: names.get(transfer.toWarehouseId) ?? null,
    lineCount: lines.length,
    totalSentQty: sentQty,
    totalReceivedQty: receivedQty,
    inTransitQty: inTransitQty(transfer.status, sentQty, receivedQty),
    etaOn: transfer.etaOn,
    dispatchedAt: transfer.dispatchedAt?.toISOString() ?? null,
    receivedAt: transfer.receivedAt?.toISOString() ?? null,
    createdAt: transfer.createdAt.toISOString(),
    requestedBy: transfer.requestedBy,
    lines: lines.map((line) => ({
      id: line.id,
      variantId: line.variantId,
      hamperItemId: line.hamperItemId,
      sku: line.sku,
      title: line.title,
      sentQty: line.sentQty,
      receivedQty: line.receivedQty,
      shortQty: transfer.receivedAt ? Math.max(0, line.sentQty - line.receivedQty) : 0,
    })),
    availableActions: transferEdgesFrom(transfer.status).map((edge) => ({
      action: edge.action,
      to: edge.to,
      label: edge.label,
      movesStock: edge.movesStock,
      sideEffects: [...(edge.sideEffects ?? [])],
    })),
  };
}

export type TransferLineInput = {
  variantId?: string | undefined;
  hamperItemId?: string | undefined;
  quantity: number;
};

export async function createTransfer(
  input: {
    fromWarehouseId: string;
    toWarehouseId: string;
    etaOn?: string | null | undefined;
    lines: TransferLineInput[];
  },
  auth: StaffAuth,
): Promise<TransferDetailResponse> {
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new UnprocessableError(
      'Source and destination must be different warehouses — the database refuses a transfer to itself, ' +
        'and it would write two movements that cancel out.',
      'transfer_same_warehouse',
    );
  }

  const [from, to] = await Promise.all([
    repo.findWarehouse(input.fromWarehouseId),
    repo.findWarehouse(input.toWarehouseId),
  ]);
  if (!from) throw new NotFoundError('Source warehouse', input.fromWarehouseId);
  if (!to) throw new NotFoundError('Destination warehouse', input.toWarehouseId);

  await assertStockablesExist(input.lines);

  const created = await db.transaction(async (tx) => {
    // Numbered as late as possible: `next_document_number` holds a row lock on
    // the series until COMMIT, and that row is a global choke point.
    const transferNo = await repo.nextTransferNumber(tx, new Date().getUTCFullYear());

    const transfer = await repo.insertTransfer(tx, {
      transferNo,
      fromWarehouseId: input.fromWarehouseId,
      toWarehouseId: input.toWarehouseId,
      status: 'requested',
      etaOn: input.etaOn ?? null,
      requestedBy: auth.staffId,
    });

    await repo.insertTransferLines(
      tx,
      input.lines.map((line) => ({
        transferId: transfer.id,
        variantId: line.variantId ?? null,
        hamperItemId: line.hamperItemId ?? null,
        sentQty: line.quantity,
      })),
    );

    return transfer;
  });

  return getTransfer(created.id);
}

async function assertStockablesExist(lines: readonly TransferLineInput[]): Promise<void> {
  const variantIds = [...new Set(lines.map((l) => l.variantId).filter((id): id is string => Boolean(id)))];
  const hamperIds = [...new Set(lines.map((l) => l.hamperItemId).filter((id): id is string => Boolean(id)))];

  const [liveVariants, liveHampers] = await Promise.all([
    repo.existingVariantIds(variantIds),
    repo.existingHamperItemIds(hamperIds),
  ]);

  const missing = [
    ...variantIds.filter((id) => !liveVariants.has(id)),
    ...hamperIds.filter((id) => !liveHampers.has(id)),
  ];
  if (missing.length > 0) {
    throw new UnprocessableError(
      `${missing.length} line(s) name a stockable that does not exist or has been deleted.`,
      'unknown_stockable',
      { context: { missing } },
    );
  }
}

/* --------------------------------------------------------- state changes */

export async function approveTransfer(transferId: string): Promise<TransferDetailResponse> {
  await db.transaction(async (tx) => {
    const transfer = await lockOrThrow(tx, transferId);
    assertTransferAction(transfer.status, 'approve');

    const lines = await repo.findTransferLines(transferId, tx);
    if (lines.length === 0) {
      throw new UnprocessableError(
        'This transfer has no lines. Approving a transfer of nothing would produce a document that can ' +
          'never be dispatched.',
        'transfer_has_no_lines',
        { context: { transferId } },
      );
    }

    await repo.updateTransfer(tx, transferId, { status: 'approved', updatedAt: new Date() });
  });

  return getTransfer(transferId);
}

/**
 * Dispatch — the first of the two stock-moving edges.
 *
 * One transaction: for every line, decrement the SOURCE level and write a
 * `transfer_out` movement carrying the balance that decrement returned. If any
 * line is short, the whole thing rolls back and no stock has moved anywhere.
 *
 * The destination level is created here (at zero) so `incoming_qty` has
 * somewhere to land — the goods are on their way to a bin that may never have
 * held this SKU before.
 */
export async function dispatchTransfer(
  transferId: string,
  note: string | null,
  auth: StaffAuth,
): Promise<TransferDetailResponse> {
  await db.transaction(async (tx) => {
    const transfer = await lockOrThrow(tx, transferId);
    assertTransferAction(transfer.status, 'dispatch');

    const lines = await repo.findTransferLines(transferId, tx);
    if (lines.length === 0) {
      throw new UnprocessableError('This transfer has no lines to dispatch.', 'transfer_has_no_lines');
    }

    // Resolve every SOURCE level first, then lock them in id order. Resolving
    // inside the mutation loop would take the locks in line order, which two
    // transfers sharing SKUs can interleave into a deadlock.
    const resolved: { line: (typeof lines)[number]; sourceLevelId: string }[] = [];
    for (const line of lines) {
      const ref = {
        variantId: line.variantId,
        hamperItemId: line.hamperItemId,
        packagingId: null,
      };
      const level = await repo.findLevel(tx, transfer.fromWarehouseId, ref);
      if (!level) {
        throw new UnprocessableError(
          `${line.sku ?? line.variantId ?? line.hamperItemId} has never been stocked at the source ` +
            `warehouse, so there are 0 units to send and ${line.sentQty} were requested.`,
          'insufficient_stock',
          { context: { transferId, lineId: line.id, sku: line.sku, requested: line.sentQty, available: 0 } },
        );
      }
      resolved.push({ line, sourceLevelId: level.id });
    }

    resolved.sort((a, b) => (a.sourceLevelId < b.sourceLevelId ? -1 : a.sourceLevelId > b.sourceLevelId ? 1 : 0));
    await repo.lockLevels(tx, resolved.map((r) => r.sourceLevelId));

    const now = new Date();
    for (const { line, sourceLevelId } of resolved) {
      const balanceAfter = await repo.adjustOnHand(tx, sourceLevelId, -line.sentQty);
      if (balanceAfter === null) {
        // The conditional UPDATE refused. Nothing was written; the transaction
        // rolls back and no other line's decrement survives either.
        throw new UnprocessableError(
          `Not enough sellable stock at the source warehouse for ${line.sku ?? 'this line'}: ` +
            `${line.sentQty} requested. Reserved units belong to open carts and orders and are not ` +
            'available to transfer.',
          'insufficient_stock',
          { context: { transferId, lineId: line.id, sku: line.sku, requested: line.sentQty } },
        );
      }

      await repo.insertMovement(tx, {
        inventoryLevelId: sourceLevelId,
        movementType: 'transfer_out',
        quantityDelta: -line.sentQty,
        balanceAfter,
        referenceType: 'stock_transfer',
        referenceId: transfer.id,
        referenceLabel: transfer.transferNo,
        note,
        actorId: auth.staffId,
      });

      // Destination side: no on-hand yet, only an expectation. `available_qty`
      // there is untouched, so the units are sellable from neither warehouse.
      const destination = await repo.ensureLevel(tx, transfer.toWarehouseId, {
        variantId: line.variantId,
        hamperItemId: line.hamperItemId,
        packagingId: null,
      });
      await repo.adjustIncoming(tx, destination.id, line.sentQty);
    }

    await repo.updateTransfer(tx, transferId, {
      status: 'in_transit',
      dispatchedAt: now,
      updatedAt: now,
    });
  });

  return getTransfer(transferId);
}

/**
 * Receive — the second stock-moving edge.
 *
 * Increments the DESTINATION and writes `transfer_in`. A line may arrive short;
 * the shortfall is never credited anywhere, which is the honest record of goods
 * lost in transit. It cannot arrive OVER — `transfer_line_no_over_receipt`
 * refuses that, and so does this, with a message instead of a constraint error.
 */
export async function receiveTransfer(
  transferId: string,
  input: { lines?: { lineId: string; receivedQty: number }[] | undefined; note?: string | undefined },
  auth: StaffAuth,
): Promise<TransferDetailResponse> {
  await db.transaction(async (tx) => {
    const transfer = await lockOrThrow(tx, transferId);
    assertTransferAction(transfer.status, 'receive');

    const lines = await repo.findTransferLines(transferId, tx);
    const byId = new Map(lines.map((l) => [l.id, l]));

    const overrides = new Map((input.lines ?? []).map((l) => [l.lineId, l.receivedQty]));
    for (const [lineId, qty] of overrides) {
      const line = byId.get(lineId);
      if (!line) {
        throw new UnprocessableError(
          `Line ${lineId} does not belong to transfer ${transfer.transferNo}.`,
          'unknown_transfer_line',
          { context: { transferId, lineId } },
        );
      }
      if (qty > line.sentQty) {
        throw new UnprocessableError(
          `Line ${line.sku ?? lineId} was sent ${line.sentQty} units but ${qty} were reported received. ` +
            'More cannot arrive than left — raise a separate transfer or an adjustment for the difference.',
          'over_receipt',
          { context: { transferId, lineId, sentQty: line.sentQty, receivedQty: qty } },
        );
      }
    }

    const resolved: { line: (typeof lines)[number]; levelId: string; receivedQty: number }[] = [];
    for (const line of lines) {
      const receivedQty = overrides.get(line.id) ?? line.sentQty;
      const level = await repo.ensureLevel(tx, transfer.toWarehouseId, {
        variantId: line.variantId,
        hamperItemId: line.hamperItemId,
        packagingId: null,
      });
      resolved.push({ line, levelId: level.id, receivedQty });
    }

    resolved.sort((a, b) => (a.levelId < b.levelId ? -1 : a.levelId > b.levelId ? 1 : 0));
    await repo.lockLevels(tx, resolved.map((r) => r.levelId));

    for (const { line, levelId, receivedQty } of resolved) {
      // Whatever was dispatched stops being "incoming" whether or not it turned
      // up — the lorry has been and gone.
      await repo.adjustIncoming(tx, levelId, -line.sentQty);
      await repo.setTransferLineReceived(tx, line.id, receivedQty);

      if (receivedQty === 0) continue; // A movement of nothing is not a movement.

      const balanceAfter = await repo.adjustOnHand(tx, levelId, receivedQty);
      if (balanceAfter === null) {
        throw new Error('increment unexpectedly refused — an increment has no guard to fail');
      }

      await repo.insertMovement(tx, {
        inventoryLevelId: levelId,
        movementType: 'transfer_in',
        quantityDelta: receivedQty,
        balanceAfter,
        referenceType: 'stock_transfer',
        referenceId: transfer.id,
        referenceLabel: transfer.transferNo,
        note: input.note ?? null,
        actorId: auth.staffId,
      });
    }

    const now = new Date();
    await repo.updateTransfer(tx, transferId, { status: 'received', receivedAt: now, updatedAt: now });
  });

  return getTransfer(transferId);
}

export async function cancelTransfer(transferId: string, reason: string): Promise<TransferDetailResponse> {
  await db.transaction(async (tx) => {
    const transfer = await lockOrThrow(tx, transferId);
    // Refuses `in_transit` with its own explanation: the stock has already left.
    assertTransferAction(transfer.status, 'cancel');

    await repo.updateTransfer(tx, transferId, { status: 'cancelled', updatedAt: new Date() });
    void reason; // Captured by the automatic audit-log write on every admin mutation.
  });

  return getTransfer(transferId);
}

async function lockOrThrow(tx: Tx, transferId: string): Promise<repo.TransferRow> {
  const transfer = await repo.lockTransfer(tx, transferId);
  if (!transfer) throw new NotFoundError('Stock transfer', transferId);
  return transfer;
}

/** Exported for the route's action map and for the test. */
export const transferActionsFor = (status: StockTransferStatus): TransferAction[] =>
  transferEdgesFrom(status).map((e) => e.action);
