/**
 * Inventory core — the stock desk.
 *
 * Five rules shape this file.
 *
 * **1. An adjustment is ONE transaction.** Lock the level (`SELECT … FOR
 * UPDATE`), validate against the locked snapshot, apply the conditional UPDATE,
 * append the movement with the balance the UPDATE actually returned, commit. A
 * level that changed and a ledger that did not is the failure mode that makes
 * every downstream number a lie, so there is no path where one happens without
 * the other.
 *
 * **2. The ledger is append-only (§10).** Nothing here updates or deletes a
 * `stock_movements` row. A correction is a NEW movement with the opposite sign,
 * which is why `balance_after` can be trusted to reconstruct any historical
 * position.
 *
 * **3. Negative sellable stock is impossible (§64).** The mechanism is the
 * conditional `UPDATE … WHERE on_hand - reserved + delta >= 0` in the repository,
 * whose zero-rows result becomes `insufficient_stock`. The pre-check in
 * `admin-inventory.stock.ts` runs first only to produce a readable error with
 * real numbers in it; it is not what makes the guarantee.
 *
 * **4. A reservation moves `reserved_qty` and writes NO movement (§14).** The
 * units have not moved, they are only spoken for. A ledger row for a hold would
 * double-count against `balance_after` the moment the goods actually shipped.
 *
 * **5. Bulk is all-or-nothing, but the ledger is per SKU.** One transaction, one
 * movement row per line. Levels are locked in a single statement in ascending
 * `inventory_level_id` order so two concurrent batches queue rather than
 * deadlock (§62).
 *
 * On the two audit trails: `defineRoute` applies `middleware/audit.ts` to every
 * non-GET admin route, which records the REQUEST. This module additionally writes
 * `activity_logs` inside the stock transaction, which records the EFFECT — the
 * quantities before and after, as queryable JSONB. `GET /audit` reads the second.
 * They are complementary, not duplicates: a request log cannot tell you what the
 * number was, and a state log cannot tell you which IP asked.
 */

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { BadRequestError, NotFoundError, UnprocessableError, type FieldIssue } from '../../lib/errors.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import type { StaffAuth } from '../../lib/openapi/define-route.js';
import { inventoryLevels, stockMovements } from '../../db/schema/index.js';
import * as repo from './admin-inventory.repository.js';
import {
  applyReservation,
  assertReservable,
  assertSufficientStock,
  availableOf,
  balanceAfter,
  reorderSuggestion,
  roundUpToMoq,
  stockState,
  type StockState,
} from './admin-inventory.stock.js';
import {
  MOVEMENT_TYPES,
  REFERENCE_TYPES,
  type AdjustmentBody,
  type AdjustmentResult,
  type AlertListQuery,
  type AvailabilityQuery,
  type AvailabilityResponse,
  type BulkAdjustBody,
  type BulkAdjustResult,
  type DashboardQuery,
  type InventoryAuditEvent,
  type InventoryAuditQuery,
  type InventoryDashboard,
  type InventoryDetail,
  type InventoryExportQuery,
  type InventoryLevelSummary,
  type InventoryListQuery,
  type InventoryNotification,
  type InventoryNotificationQuery,
  type MovementListQuery,
  type PurchaseDraftBody,
  type PurchaseDraftResponse,
  type ReorderLine,
  type ReorderListQuery,
  type ReservationBody,
  type ReservationListQuery,
  type ReservationResponse,
  type StockMovementResponse,
  type StockableRef,
} from './admin-inventory.schemas.js';

/* ------------------------------------------------------------- utilities */

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const likePattern = (term: string): string => `%${escapeLike(term)}%`;

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

function parseInstant(raw: string | undefined, label: string): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`\`${label}\` is not a date I can read: '${raw}'.`);
  }
  return parsed;
}

/**
 * `?movementType=damage,loss` → `inArray`, every value checked against the live
 * vocabulary first. An unknown value is a 400, not a silently empty page: a typo
 * that returns nothing reads exactly like "there were no damage movements".
 */
function enumCsv<T extends string>(raw: string | undefined, allowed: readonly T[], label: string): T[] {
  const values = (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.length === 0) return [];

  const unknown = values.filter((v) => !(allowed as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown ${label}: ${unknown.join(', ')}. Valid values: ${allowed.join(', ')}.`,
    );
  }
  return values as T[];
}

/** The activity-log actor. Staff tokens carry an id and a role, not a display name. */
const actorOf = (auth: StaffAuth): { staffId: string; label: string; role: string } => ({
  staffId: auth.staffId,
  label: auth.role,
  role: auth.role,
});

/* -------------------------------------------------------------- mappers */

const toItemRef = (row: {
  itemKind: StockableRef['kind'];
  itemId: string;
  sku: string;
  name: string;
}): StockableRef => ({ kind: row.itemKind, id: row.itemId, sku: row.sku, name: row.name });

/**
 * `availableQty` comes back from the GENERATED column, which is the value the
 * database itself computed and indexed. The fallback recomputes the identical
 * expression and exists only so the field is never null in the API — it is not a
 * second opinion.
 */
const availableFrom = (row: { availableQty: number | null; onHandQty: number; reservedQty: number }): number =>
  row.availableQty ?? row.onHandQty - row.reservedQty;

function toLevelSummary(row: repo.LevelRow): InventoryLevelSummary {
  const availableQty = availableFrom(row);
  return {
    id: row.id,
    item: toItemRef(row),
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouseCode,
    warehouseName: row.warehouseName,
    binLocation: row.binLocation,
    locationId: row.locationId,
    onHandQty: row.onHandQty,
    reservedQty: row.reservedQty,
    availableQty,
    incomingQty: row.incomingQty,
    reorderPoint: row.reorderPoint,
    reorderQty: row.reorderQty,
    state: stockState(row, row.reorderPoint),
    unitCostPaise: row.unitCostPaise,
    stockValuePaise: row.stockValuePaise,
    lastMovementAt: iso(row.lastMovementAt),
  };
}

/** `stock_movements.id` is a BIGINT identity. `JSON.stringify` throws on a bigint. */
function toMovement(row: repo.MovementRow): StockMovementResponse {
  return {
    id: String(row.id),
    inventoryLevelId: row.inventoryLevelId,
    item: toItemRef(row),
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouseCode,
    warehouseName: row.warehouseName,
    movementType: row.movementType as StockMovementResponse['movementType'],
    quantityDelta: row.quantityDelta,
    balanceAfter: row.balanceAfter,
    referenceType: row.referenceType as StockMovementResponse['referenceType'],
    referenceId: row.referenceId,
    referenceLabel: row.referenceLabel,
    referenceNo: row.referenceNo,
    note: row.note,
    actorId: row.actorId,
    actorName: row.actorName,
    occurredAt: row.occurredAt.toISOString(),
  };
}

function toReservation(row: repo.ReservationRow): ReservationResponse {
  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
  return {
    id: row.id,
    inventoryLevelId: row.inventoryLevelId,
    item: toItemRef(row),
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouseCode,
    quantity: row.quantity,
    reason: row.reason,
    cartId: row.cartId,
    orderId: row.orderId,
    expiresAt: iso(row.expiresAt),
    releasedAt: iso(row.releasedAt),
    isActive: row.releasedAt === null && !expired,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ---------------------------------------------------------- where builders */

const LEVEL_SORT_FIELDS = [
  'sku',
  'name',
  'onHandQty',
  'reservedQty',
  'availableQty',
  'incomingQty',
  'lastMovementAt',
  'warehouse',
] as const;

/** Exported for the test: the whole WHERE is buildable without a database. */
export function buildInventoryWhere(query: InventoryListQuery): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    query.warehouseId ? eq(inventoryLevels.warehouseId, query.warehouseId) : undefined,
    query.locationId ? repo.locationIs(query.locationId) : undefined,
    query.kind ? repo.kindIs(query.kind) : undefined,
    query.state ? repo.stateIs(query.state) : undefined,
    query.belowReorderPoint ? repo.atOrBelowReorderPoint() : undefined,
    query.q ? repo.matchesText(likePattern(query.q)) : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  return present.length > 0 ? and(...present) : undefined;
}

function levelOrderBy(sort: string | undefined, fallbackField: string, fallbackDir: 'asc' | 'desc'): SQL[] {
  const { field, direction } = parseSort(sort, LEVEL_SORT_FIELDS, {
    field: fallbackField,
    direction: fallbackDir,
  });
  const expr = repo.SORTABLE[field as keyof typeof repo.SORTABLE] ?? repo.SORTABLE.sku;
  // Second key so pagination is stable when the first key ties — without it,
  // page 2 can repeat a row from page 1.
  return [repo.orderByFor(expr, direction), repo.orderByFor(repo.SORTABLE.sku, 'asc')];
}

/* ------------------------------------------------------------------ list */

export async function listInventory(
  query: InventoryListQuery,
): Promise<{ items: InventoryLevelSummary[]; total: number }> {
  const where = buildInventoryWhere(query);
  const [rows, total] = await Promise.all([
    repo.listLevels(where, levelOrderBy(query.sort, 'sku', 'asc'), query.perPage, offsetOf(query.page, query.perPage)),
    repo.countLevels(where),
  ]);
  return { items: rows.map(toLevelSummary), total };
}

/* --------------------------------------------------------------- by SKU */

async function requireItem(sku: string): Promise<repo.ResolvedItem> {
  const item = await repo.resolveSku(sku);
  if (!item) {
    throw new NotFoundError(
      'SKU',
      `${sku}' — no active product variant, hamper item or packaging material carries it. (Soft-deleted items are not matched`,
    );
  }
  return item;
}

export async function getBySku(sku: string): Promise<InventoryDetail> {
  const item = await requireItem(sku);
  const levels = await repo.findLevelsForItem(item, undefined);

  const [movements, reservations, incoming] = await Promise.all([
    repo.listMovements(
      levels.length > 0
        ? inArray(
            stockMovements.inventoryLevelId,
            levels.map((l) => l.id),
          )
        : sql`false`,
      [repo.orderByFor(repo.MOVEMENT_SORTABLE.occurredAt, 'desc'), repo.orderByFor(repo.MOVEMENT_SORTABLE.id, 'desc')],
      20,
      0,
    ),
    repo.listReservations(
      and(repo.itemIs(item), repo.reservationIsActive),
      [repo.orderByFor(repo.RESERVATION_SORTABLE.createdAt, 'desc')],
      100,
      0,
    ),
    repo.findIncomingForItem(item),
  ]);

  const totals = levels.reduce(
    (acc, l) => ({
      onHand: acc.onHand + l.onHandQty,
      reserved: acc.reserved + l.reservedQty,
      incoming: acc.incoming + l.incomingQty,
      value: acc.value + l.stockValuePaise,
      reorderPoint: Math.max(acc.reorderPoint, l.reorderPoint),
    }),
    { onHand: 0, reserved: 0, incoming: 0, value: 0, reorderPoint: 0 },
  );

  return {
    item: { kind: item.kind, id: item.id, sku: item.sku, name: item.name },
    totalOnHandQty: totals.onHand,
    totalReservedQty: totals.reserved,
    totalAvailableQty: totals.onHand - totals.reserved,
    totalIncomingQty: totals.incoming,
    totalStockValuePaise: totals.value,
    state: stockState({ onHandQty: totals.onHand, reservedQty: totals.reserved }, totals.reorderPoint),
    levels: levels.map(toLevelSummary),
    recentMovements: movements.map(toMovement),
    reservations: reservations.map(toReservation),
    incoming: incoming.map((row) => ({
      purchaseOrderId: row.purchaseOrderId,
      poNo: row.poNo,
      supplierName: row.supplierName,
      warehouseId: row.warehouseId,
      status: row.status,
      orderedQty: row.orderedQty,
      receivedQty: row.receivedQty,
      outstandingQty: Math.max(0, row.orderedQty - row.receivedQty),
      expectedOn: row.expectedOn,
    })),
  };
}

export async function getAvailability(sku: string, query: AvailabilityQuery): Promise<AvailabilityResponse> {
  const item = await requireItem(sku);
  const levels = await repo.findLevelsForItem(item, query.warehouseId);
  const requestedQty = query.quantity ?? null;

  let onHand = 0;
  let reserved = 0;
  let incoming = 0;
  let worstReorderPoint = 0;

  const warehouses = levels.map((level) => {
    const available = availableFrom(level);
    onHand += level.onHandQty;
    reserved += level.reservedQty;
    incoming += level.incomingQty;
    worstReorderPoint = Math.max(worstReorderPoint, level.reorderPoint);

    return {
      warehouseId: level.warehouseId,
      warehouseCode: level.warehouseCode,
      warehouseName: level.warehouseName,
      onHandQty: level.onHandQty,
      reservedQty: level.reservedQty,
      availableQty: available,
      incomingQty: level.incomingQty,
      state: stockState(level, level.reorderPoint),
      canFulfil: requestedQty === null ? null : available >= requestedQty,
    };
  });

  const totalAvailable = onHand - reserved;

  return {
    item: { kind: item.kind, id: item.id, sku: item.sku, name: item.name },
    totalOnHandQty: onHand,
    totalReservedQty: reserved,
    totalAvailableQty: totalAvailable,
    totalIncomingQty: incoming,
    state: stockState({ onHandQty: onHand, reservedQty: reserved }, worstReorderPoint),
    requestedQty,
    // A single warehouse covering the quantity is a shippable answer. The network
    // total is a different, weaker claim — it needs a split shipment to be true —
    // so the two are reported separately rather than conflated.
    canFulfil: requestedQty === null ? null : warehouses.some((w) => w.canFulfil === true),
    canFulfilAcrossWarehouses: requestedQty === null ? null : totalAvailable >= requestedQty,
    warehouses,
  };
}

/* ------------------------------------------------------------- movements */

const MOVEMENT_SORT_FIELDS = ['occurredAt', 'quantityDelta', 'id'] as const;

export async function listMovements(
  query: MovementListQuery,
): Promise<{ items: StockMovementResponse[]; total: number }> {
  const types = enumCsv(query.movementType, MOVEMENT_TYPES, 'movementType');
  const refTypes = enumCsv(query.referenceType, REFERENCE_TYPES, 'referenceType');
  const from = parseInstant(query.from, 'from');
  const to = parseInstant(query.to, 'to');

  const conditions: (SQL | undefined)[] = [
    query.sku ? repo.matchesSku(query.sku) : undefined,
    query.warehouseId ? eq(inventoryLevels.warehouseId, query.warehouseId) : undefined,
    types.length > 0 ? inArray(stockMovements.movementType, types as never[]) : undefined,
    refTypes.length > 0 ? inArray(stockMovements.referenceType, refTypes as never[]) : undefined,
    query.referenceId ? eq(stockMovements.referenceId, query.referenceId) : undefined,
    query.actorId ? eq(stockMovements.actorId, query.actorId) : undefined,
    from ? sql`${stockMovements.occurredAt} >= ${from}` : undefined,
    to ? sql`${stockMovements.occurredAt} <= ${to}` : undefined,
    query.q ? repo.movementMatchesText(likePattern(query.q)) : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  const where = present.length > 0 ? and(...present) : undefined;

  const { field, direction } = parseSort(query.sort, MOVEMENT_SORT_FIELDS, {
    field: 'occurredAt',
    direction: 'desc',
  });
  const expr = repo.MOVEMENT_SORTABLE[field as keyof typeof repo.MOVEMENT_SORTABLE] ?? repo.MOVEMENT_SORTABLE.occurredAt;
  // `id` is the tiebreak: a bulk adjustment writes several rows with the same
  // `occurred_at`, and without a second key their order across pages is undefined.
  const orderBy = [repo.orderByFor(expr, direction), repo.orderByFor(repo.MOVEMENT_SORTABLE.id, 'desc')];

  const [rows, total] = await Promise.all([
    repo.listMovements(where, orderBy, query.perPage, offsetOf(query.page, query.perPage)),
    repo.countMovements(where),
  ]);
  return { items: rows.map(toMovement), total };
}

export async function getMovement(movementId: string): Promise<StockMovementResponse> {
  let id: bigint;
  try {
    id = BigInt(movementId);
  } catch {
    throw new NotFoundError('Movement', movementId);
  }
  const row = await repo.findMovement(id);
  if (!row) throw new NotFoundError('Movement', movementId);
  return toMovement(row);
}

/* ----------------------------------------------------------- adjustments */

type LockedLevel = { onHandQty: number; reservedQty: number };

/**
 * The write half of one adjustment, inside an already-open transaction with the
 * level already locked. Shared by the single and bulk endpoints so there is
 * exactly one implementation of "change stock and record it".
 */
async function writeAdjustment(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    levelId: string;
    before: LockedLevel;
    item: repo.ResolvedItem;
    warehouseId: string;
    warehouseCode: string;
    quantityDelta: number;
    movementType: string;
    note: string;
    referenceType?: (typeof REFERENCE_TYPES)[number] | undefined;
    referenceId?: string | undefined;
    referenceLabel?: string | undefined;
    actorId: string;
    at: Date;
  },
): Promise<AdjustmentResult> {
  const label = `${input.item.sku} at ${input.warehouseCode}`;

  // Readability first: this produces an error naming the actual numbers. It is
  // NOT the guarantee — the conditional UPDATE below is.
  assertSufficientStock(input.before, input.quantityDelta, label);

  const after = await repo.applyOnHandDelta(tx, input.levelId, input.quantityDelta, input.at);
  if (!after) {
    // Zero rows affected. Under READ COMMITTED this is the WHERE clause being
    // re-evaluated against a row someone else just committed — the race the
    // pre-check cannot see. Never a no-op, always a refusal.
    throw new UnprocessableError(
      `${label} no longer has enough sellable stock for a change of ${input.quantityDelta}. ` +
        `Another operation committed while this one was in flight. Re-read the level and try again.`,
      'insufficient_stock',
      { context: { inventoryLevelId: input.levelId, quantityDelta: input.quantityDelta } },
    );
  }

  const expected = balanceAfter(input.before, input.quantityDelta);
  if (after.onHandQty !== expected) {
    // Unreachable while the row lock is held. Loud rather than silent, because
    // the alternative is a ledger whose running balance is quietly wrong.
    throw new Error(
      `Ledger integrity: level ${input.levelId} moved from ${input.before.onHandQty} by ${input.quantityDelta} ` +
        `and landed on ${after.onHandQty}, not ${expected}.`,
    );
  }

  const movement = await repo.insertMovement(tx, {
    inventoryLevelId: input.levelId,
    movementType: input.movementType,
    quantityDelta: input.quantityDelta,
    balanceAfter: after.onHandQty,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    referenceLabel: input.referenceLabel,
    note: input.note,
    actorId: input.actorId,
    occurredAt: input.at,
  });

  return {
    inventoryLevelId: input.levelId,
    item: { kind: input.item.kind, id: input.item.id, sku: input.item.sku, name: input.item.name },
    warehouseId: input.warehouseId,
    movementId: String(movement.id),
    movementType: input.movementType as AdjustmentResult['movementType'],
    quantityDelta: input.quantityDelta,
    onHandQtyBefore: input.before.onHandQty,
    onHandQty: after.onHandQty,
    reservedQty: after.reservedQty,
    availableQty: availableOf(after),
    balanceAfter: after.onHandQty,
    occurredAt: movement.occurredAt.toISOString(),
  };
}

const adjustmentActivity = (
  result: AdjustmentResult,
  before: LockedLevel,
  actor: { staffId: string; label: string; role: string },
  reason: string,
  requestId: string | null,
): repo.NewActivity => ({
  actorStaffId: actor.staffId,
  actorLabel: actor.label,
  actorRole: actor.role,
  action: 'inventory.adjusted',
  entityType: 'inventory_level',
  entityId: result.inventoryLevelId,
  entityLabel: result.item.sku,
  beforeData: { onHandQty: before.onHandQty, reservedQty: before.reservedQty, availableQty: availableOf(before) },
  afterData: {
    onHandQty: result.onHandQty,
    reservedQty: result.reservedQty,
    availableQty: result.availableQty,
    movementId: result.movementId,
    movementType: result.movementType,
    quantityDelta: result.quantityDelta,
    reason,
  },
  changedFields: ['onHandQty'],
  requestId,
});

export async function adjust(
  body: AdjustmentBody,
  auth: StaffAuth,
  requestId: string | null,
): Promise<AdjustmentResult> {
  const item = await requireItem(body.sku);
  const warehouse = await repo.findWarehouse(body.warehouseId);
  if (!warehouse) throw new NotFoundError('Warehouse', body.warehouseId);

  const actor = actorOf(auth);

  return db.transaction(async (tx) => {
    const levelId = await repo.findLevelId(item, body.warehouseId, tx);
    if (!levelId) {
      throw new UnprocessableError(
        `${item.sku} is not stocked at ${warehouse.code}. Create the inventory level before adjusting it — ` +
          `an adjustment against a level that does not exist would invent stock with no reorder point, no bin ` +
          `and no history.`,
        'no_inventory_level',
        { context: { sku: item.sku, warehouseId: body.warehouseId } },
      );
    }

    const locked = await repo.lockLevels(tx, [levelId]);
    const before = locked.get(levelId);
    if (!before) throw new NotFoundError('Inventory level', levelId);

    const at = new Date();
    let mappedMovementType = body.movementType;
    if (mappedMovementType === 'adjustment') {
      switch (body.reason) {
        case 'shrinkage':
        case 'expired':
          mappedMovementType = 'loss';
          break;
        case 'damage':
          mappedMovementType = 'damage';
          break;
        case 'return':
          mappedMovementType = 'return_in';
          break;
        case 'found':
          mappedMovementType = 'found';
          break;
        case 'correction':
          mappedMovementType = 'adjustment';
          break;
      }
    }

    if (body.unitCostPaise !== undefined) {
      await repo.updateItemCost(item, body.unitCostPaise, tx);
    }

    const result = await writeAdjustment(tx, {
      levelId,
      before,
      item,
      warehouseId: body.warehouseId,
      warehouseCode: warehouse.code,
      quantityDelta: body.quantityDelta,
      movementType: mappedMovementType,
      note: body.reason,
      referenceType: body.referenceType,
      referenceId: body.referenceId,
      referenceLabel: body.referenceLabel,
      actorId: actor.staffId,
      at,
    });

    await repo.insertActivity(tx, adjustmentActivity(result, before, actor, body.reason, requestId));
    return result;
  });
}

/* ----------------------------------------------------------- bulk adjust */

const pairKey = (kind: string, itemId: string, warehouseId: string): string => `${kind}:${itemId}:${warehouseId}`;

export async function bulkAdjust(
  body: BulkAdjustBody,
  auth: StaffAuth,
  requestId: string | null,
): Promise<BulkAdjustResult> {
  // Two deltas against one level in one batch is ambiguous — which movement's
  // `balance_after` comes first is an implementation detail nobody should have to
  // reason about. Refuse rather than guess.
  const seen = new Set<string>();
  const duplicates: FieldIssue[] = [];
  body.adjustments.forEach((line, index) => {
    const key = `${line.sku}@${line.warehouseId}`;
    if (seen.has(key)) {
      duplicates.push({
        path: `adjustments[${index}]`,
        code: 'duplicate_target',
        message: `${line.sku} at this warehouse appears more than once. Combine the deltas into one line.`,
      });
    }
    seen.add(key);
  });
  if (duplicates.length > 0) {
    throw new UnprocessableError('The batch targets the same inventory level twice.', 'duplicate_target', {
      issues: duplicates,
    });
  }

  const resolved = await repo.resolveSkus(body.adjustments.map((a) => a.sku));
  const unknownSkus: FieldIssue[] = body.adjustments
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !resolved.has(line.sku))
    .map(({ line, index }) => ({
      path: `adjustments[${index}].sku`,
      code: 'unknown_sku',
      message: `No active variant, hamper item or packaging material carries the SKU '${line.sku}'.`,
    }));
  if (unknownSkus.length > 0) {
    throw new UnprocessableError('Some SKUs in the batch do not exist.', 'unknown_sku', { issues: unknownSkus });
  }

  const items = [...new Set(body.adjustments.map((a) => a.sku))].map((sku) => resolved.get(sku)!);
  const warehouseIds = [...new Set(body.adjustments.map((a) => a.warehouseId))];
  const levelRows = await repo.findLevelsForItems(items, warehouseIds);

  const levelByPair = new Map<string, string>();
  for (const row of levelRows) {
    const kind = row.variantId ? 'variant' : row.hamperItemId ? 'hamper_item' : 'packaging';
    const itemId = row.variantId ?? row.hamperItemId ?? row.packagingId;
    if (itemId) levelByPair.set(pairKey(kind, itemId, row.warehouseId), row.id);
  }

  const warehouseCodes = new Map<string, string>();
  for (const warehouseId of warehouseIds) {
    const warehouse = await repo.findWarehouse(warehouseId);
    if (!warehouse) throw new NotFoundError('Warehouse', warehouseId);
    warehouseCodes.set(warehouseId, warehouse.code);
  }

  type Planned = {
    levelId: string;
    item: repo.ResolvedItem;
    warehouseId: string;
    warehouseCode: string;
    quantityDelta: number;
    movementType: string;
    note: string;
  };

  const missing: FieldIssue[] = [];
  const planned: Planned[] = [];

  body.adjustments.forEach((line, index) => {
    const item = resolved.get(line.sku)!;
    const levelId = levelByPair.get(pairKey(item.kind, item.id, line.warehouseId));
    if (!levelId) {
      missing.push({
        path: `adjustments[${index}]`,
        code: 'no_inventory_level',
        message: `${line.sku} is not stocked at ${warehouseCodes.get(line.warehouseId) ?? line.warehouseId}.`,
      });
      return;
    }
    planned.push({
      levelId,
      item,
      warehouseId: line.warehouseId,
      warehouseCode: warehouseCodes.get(line.warehouseId) ?? line.warehouseId,
      quantityDelta: line.quantityDelta,
      movementType: line.movementType ?? body.movementType,
      note: line.note ? `${body.reason} — ${line.note}` : body.reason,
    });
  });

  if (missing.length > 0) {
    throw new UnprocessableError(
      'Some lines target an item that is not stocked at the warehouse they name. Nothing was written — this ' +
        'endpoint is all-or-nothing.',
      'no_inventory_level',
      { issues: missing },
    );
  }

  // §62 deterministic lock ordering. Sorting the WORK by level id as well as
  // locking in that order means the movement rows come back in the same order the
  // locks were taken, which is what makes `results` reproducible.
  planned.sort((a, b) => (a.levelId < b.levelId ? -1 : a.levelId > b.levelId ? 1 : 0));

  const actor = actorOf(auth);

  return db.transaction(async (tx) => {
    const locked = await repo.lockLevels(
      tx,
      planned.map((p) => p.levelId),
    );

    const at = new Date();
    const results: AdjustmentResult[] = [];
    const activity: repo.NewActivity[] = [];

    for (const line of planned) {
      const before = locked.get(line.levelId);
      if (!before) throw new NotFoundError('Inventory level', line.levelId);

      const result = await writeAdjustment(tx, {
        levelId: line.levelId,
        before,
        item: line.item,
        warehouseId: line.warehouseId,
        warehouseCode: line.warehouseCode,
        quantityDelta: line.quantityDelta,
        movementType: line.movementType,
        note: line.note,
        referenceType: body.referenceType,
        referenceId: body.referenceId,
        referenceLabel: body.referenceLabel,
        actorId: actor.staffId,
        at,
      });

      results.push(result);
      activity.push(adjustmentActivity(result, before, actor, line.note, requestId));
    }

    await repo.insertActivity(tx, activity);

    return {
      applied: results.length,
      totalQuantityDelta: results.reduce((sum, r) => sum + r.quantityDelta, 0),
      results,
    };
  });
}

/* ---------------------------------------------------------------- alerts */

const ALERT_SORT_FIELDS = ['availableQty', 'sku', 'name', 'onHandQty', 'lastMovementAt'] as const;

async function listAlerts(
  query: AlertListQuery,
  stateFilter: StockState,
): Promise<{ items: InventoryLevelSummary[]; total: number }> {
  const conditions: (SQL | undefined)[] = [
    repo.stateIs(stateFilter),
    query.warehouseId ? eq(inventoryLevels.warehouseId, query.warehouseId) : undefined,
    query.kind ? repo.kindIs(query.kind) : undefined,
    query.q ? repo.matchesText(likePattern(query.q)) : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  const where = and(...present);

  const { field, direction } = parseSort(query.sort, ALERT_SORT_FIELDS, {
    field: 'availableQty',
    direction: 'asc',
  });
  const expr = repo.SORTABLE[field as keyof typeof repo.SORTABLE] ?? repo.SORTABLE.availableQty;
  const orderBy = [repo.orderByFor(expr, direction), repo.orderByFor(repo.SORTABLE.sku, 'asc')];

  const [rows, total] = await Promise.all([
    repo.listLevels(where, orderBy, query.perPage, offsetOf(query.page, query.perPage)),
    repo.countLevels(where),
  ]);
  return { items: rows.map(toLevelSummary), total };
}

export const listLowStock = (query: AlertListQuery) => listAlerts(query, 'low');
export const listOutOfStock = (query: AlertListQuery) => listAlerts(query, 'out');

/* --------------------------------------------------------------- reorder */

const REORDER_SORT_FIELDS = ['shortfallQty', 'sku', 'name', 'availableQty'] as const;

function toReorderLine(row: repo.ReorderRow): ReorderLine {
  const moq = row.moq ?? 1;
  const suggestion = reorderSuggestion({
    onHandQty: row.onHandQty,
    reservedQty: row.reservedQty,
    incomingQty: row.incomingQty,
    reorderPoint: row.reorderPoint,
    reorderQty: row.reorderQty,
    moq,
  });
  const unitCostPaise = row.supplierUnitCostPaise ?? row.unitCostPaise ?? 0;

  return {
    inventoryLevelId: row.id,
    item: toItemRef(row),
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouseCode,
    onHandQty: row.onHandQty,
    reservedQty: row.reservedQty,
    availableQty: availableFrom(row),
    incomingQty: row.incomingQty,
    inventoryPosition: suggestion.inventoryPosition,
    reorderPoint: row.reorderPoint,
    reorderQty: row.reorderQty,
    targetLevel: suggestion.targetLevel,
    shortfallQty: suggestion.shortfallQty,
    suggestedQty: suggestion.suggestedQty,
    moq,
    leadTimeDays: row.leadTimeDays ?? 0,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    supplierSku: row.supplierSku,
    isPreferredSupplier: row.isPreferredSupplier === true,
    unitCostPaise,
    estimatedCostPaise: suggestion.suggestedQty * unitCostPaise,
  };
}

function reorderWhere(query: { warehouseId?: string; supplierId?: string; q?: string }): SQL {
  const conditions: (SQL | undefined)[] = [
    repo.atOrBelowReorderPoint(),
    query.warehouseId ? eq(inventoryLevels.warehouseId, query.warehouseId) : undefined,
    query.supplierId ? repo.supplierIs(query.supplierId) : undefined,
    query.q ? repo.matchesText(likePattern(query.q)) : undefined,
  ];
  return and(...conditions.filter((c): c is SQL => Boolean(c))) as SQL;
}

export async function listReorder(query: ReorderListQuery): Promise<{ items: ReorderLine[]; total: number }> {
  const where = reorderWhere(query);
  const { field, direction } = parseSort(query.sort, REORDER_SORT_FIELDS, {
    field: 'shortfallQty',
    direction: 'desc',
  });
  const expr = repo.SORTABLE[field as keyof typeof repo.SORTABLE] ?? repo.SORTABLE.shortfallQty;
  const orderBy = [repo.orderByFor(expr, direction), repo.orderByFor(repo.SORTABLE.sku, 'asc')];

  const [rows, total] = await Promise.all([
    repo.listReorderCandidates(where, orderBy, query.perPage, offsetOf(query.page, query.perPage)),
    repo.countReorderCandidates(where),
  ]);
  return { items: rows.map(toReorderLine), total };
}

/**
 * The purchase-order series is scoped by CALENDAR year (`PO-2026-00042`), unlike
 * the invoice series, which is scoped by financial year because GST requires it.
 * Exported so the test can pin that difference.
 */
export const purchaseOrderScopeKey = (at: Date): string => String(at.getUTCFullYear());

const toIsoDate = (at: Date): string => at.toISOString().slice(0, 10);

export async function createPurchaseDraft(
  body: PurchaseDraftBody,
  auth: StaffAuth,
  requestId: string | null,
): Promise<PurchaseDraftResponse> {
  const supplier = await repo.findSupplier(body.supplierId);
  if (!supplier) throw new NotFoundError('Supplier', body.supplierId);
  if (supplier.status === 'archived') {
    throw new UnprocessableError(
      `${supplier.name} is archived. Reactivate the supplier before drafting a purchase order against them.`,
      'supplier_archived',
    );
  }
  const warehouse = await repo.findWarehouse(body.warehouseId);
  if (!warehouse) throw new NotFoundError('Warehouse', body.warehouseId);

  type DraftLine = {
    sku: string;
    description: string;
    item: repo.ResolvedItem;
    orderedQty: number;
    moq: number;
    unitCostPaise: number;
    leadTimeDays: number;
  };

  const lines: DraftLine[] = [];

  if (body.lines && body.lines.length > 0) {
    // Explicit lines. The buyer has overridden the engine — but the MOQ still
    // applies, because a purchase order the supplier rejects is not a saving.
    const resolved = await repo.resolveSkus(body.lines.map((l) => l.sku));
    const unknown: FieldIssue[] = body.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !resolved.has(line.sku))
      .map(({ line, index }) => ({
        path: `lines[${index}].sku`,
        code: 'unknown_sku',
        message: `No active item carries the SKU '${line.sku}'.`,
      }));
    if (unknown.length > 0) {
      throw new UnprocessableError('Some SKUs on the draft do not exist.', 'unknown_sku', { issues: unknown });
    }

    for (const line of body.lines) {
      const item = resolved.get(line.sku)!;
      const catalogue = await repo.findSupplierProduct(body.supplierId, item);
      const moq = catalogue?.moq ?? 1;
      lines.push({
        sku: item.sku,
        description: item.name,
        item,
        orderedQty: roundUpToMoq(line.quantity, moq),
        moq,
        unitCostPaise: line.unitCostPaise ?? catalogue?.unitCostPaise ?? 0,
        leadTimeDays: catalogue?.leadTimeDays ?? 0,
      });
    }
  } else {
    // Generated from the reorder engine for exactly this supplier and warehouse.
    const candidates = await repo.listReorderCandidates(
      reorderWhere({ warehouseId: body.warehouseId, supplierId: body.supplierId }),
      [repo.orderByFor(repo.SORTABLE.sku, 'asc')],
      200,
      0,
    );
    const wanted = body.skus ? new Set(body.skus) : null;

    for (const row of candidates) {
      if (wanted && !wanted.has(row.sku)) continue;
      const line = toReorderLine(row);
      if (line.suggestedQty <= 0) continue;
      lines.push({
        sku: row.sku,
        description: row.name,
        item: { kind: row.itemKind, id: row.itemId, sku: row.sku, name: row.name },
        orderedQty: line.suggestedQty,
        moq: line.moq,
        unitCostPaise: line.unitCostPaise,
        leadTimeDays: line.leadTimeDays,
      });
    }
  }

  if (lines.length === 0) {
    throw new UnprocessableError(
      `Nothing to order. ${supplier.name} supplies nothing that is at or below its reorder point in ` +
        `${warehouse.code}. An empty purchase order is not a useful document.`,
      'nothing_to_order',
    );
  }

  const subtotalPaise = lines.reduce((sum, l) => sum + l.orderedQty * l.unitCostPaise, 0);
  const maxLeadTime = lines.reduce((max, l) => Math.max(max, l.leadTimeDays), 0);
  const at = new Date();
  const expectedOn = body.expectedOn ?? toIsoDate(new Date(at.getTime() + maxLeadTime * 86_400_000));
  const actor = actorOf(auth);

  return db.transaction(async (tx) => {
    const poNo = await repo.nextDocumentNumber(tx, 'purchase_order', purchaseOrderScopeKey(at));
    if (!poNo) {
      throw new UnprocessableError(
        `No active purchase-order numbering series for ${purchaseOrderScopeKey(at)}. Add one in Settings — ` +
          `improvising a document number here would collide with the real series later.`,
        'no_document_series',
      );
    }

    const po = await repo.insertPurchaseOrder(tx, {
      poNo,
      supplierId: body.supplierId,
      warehouseId: body.warehouseId,
      // Always draft. Sending is a separate endpoint behind its own permission —
      // this one must never put an order in front of a supplier.
      status: 'draft',
      subtotalPaise,
      // GST is resolved when the goods are received and invoiced. A guessed figure
      // on a draft is a statutory number nobody computed, so it stays zero.
      taxPaise: 0,
      totalPaise: subtotalPaise,
      expectedOn,
      notes: body.notes ?? null,
      createdBy: actor.staffId,
    });

    const inserted = await repo.insertPurchaseOrderLines(
      tx,
      lines.map((line, position) => ({
        purchaseOrderId: po.id,
        variantId: line.item.kind === 'variant' ? line.item.id : null,
        hamperItemId: line.item.kind === 'hamper_item' ? line.item.id : null,
        packagingId: line.item.kind === 'packaging' ? line.item.id : null,
        description: line.description,
        orderedQty: line.orderedQty,
        unitCostPaise: line.unitCostPaise,
        gstRateBp: 0,
        lineTotalPaise: line.orderedQty * line.unitCostPaise,
        position,
      })),
    );

    await repo.insertActivity(tx, {
      actorStaffId: actor.staffId,
      actorLabel: actor.label,
      actorRole: actor.role,
      action: 'inventory.purchase_draft_created',
      entityType: 'purchase_order',
      entityId: po.id,
      entityLabel: po.poNo,
      beforeData: null,
      afterData: {
        supplierId: body.supplierId,
        warehouseId: body.warehouseId,
        lineCount: lines.length,
        subtotalPaise,
        status: 'draft',
      },
      changedFields: ['status'],
      requestId,
    });

    return {
      purchaseOrderId: po.id,
      poNo: po.poNo,
      status: 'draft' as const,
      supplierId: body.supplierId,
      supplierName: supplier.name,
      warehouseId: body.warehouseId,
      expectedOn,
      subtotalPaise,
      taxPaise: 0,
      totalPaise: subtotalPaise,
      lines: lines.map((line, index) => ({
        id: inserted[index]?.id ?? '',
        sku: line.sku,
        description: line.description,
        orderedQty: line.orderedQty,
        moq: line.moq,
        unitCostPaise: line.unitCostPaise,
        lineTotalPaise: line.orderedQty * line.unitCostPaise,
      })),
    };
  });
}

/* ---------------------------------------------------------- reservations */

const RESERVATION_SORT_FIELDS = ['createdAt', 'expiresAt', 'quantity'] as const;

export async function listReservations(
  query: ReservationListQuery,
): Promise<{ items: ReservationResponse[]; total: number }> {
  const conditions: (SQL | undefined)[] = [
    query.sku ? repo.matchesSku(query.sku) : undefined,
    query.warehouseId ? eq(inventoryLevels.warehouseId, query.warehouseId) : undefined,
    query.reason ? sql`inventory_reservations.reason = ${query.reason}` : undefined,
    query.status === 'active' ? repo.reservationIsActive : undefined,
    query.status === 'released' ? sql`inventory_reservations.released_at IS NOT NULL` : undefined,
    query.status === 'expired'
      ? sql`inventory_reservations.released_at IS NULL AND inventory_reservations.expires_at IS NOT NULL AND inventory_reservations.expires_at <= now()`
      : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  const where = present.length > 0 ? and(...present) : undefined;

  const { field, direction } = parseSort(query.sort, RESERVATION_SORT_FIELDS, {
    field: 'createdAt',
    direction: 'desc',
  });
  const expr = repo.RESERVATION_SORTABLE[field as keyof typeof repo.RESERVATION_SORTABLE] ?? repo.RESERVATION_SORTABLE.createdAt;

  const [rows, total] = await Promise.all([
    repo.listReservations(where, [repo.orderByFor(expr, direction)], query.perPage, offsetOf(query.page, query.perPage)),
    repo.countReservations(where),
  ]);
  return { items: rows.map(toReservation), total };
}

export async function createReservation(
  body: ReservationBody,
  auth: StaffAuth,
  requestId: string | null,
): Promise<ReservationResponse> {
  const item = await requireItem(body.sku);
  const warehouse = await repo.findWarehouse(body.warehouseId);
  if (!warehouse) throw new NotFoundError('Warehouse', body.warehouseId);

  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new UnprocessableError('`expiresAt` is in the past — the hold would lapse before it existed.', 'expiry_in_past');
  }

  const actor = actorOf(auth);

  return db.transaction(async (tx) => {
    const levelId = await repo.findLevelId(item, body.warehouseId, tx);
    if (!levelId) {
      throw new UnprocessableError(
        `${item.sku} is not stocked at ${warehouse.code}, so there is nothing to hold.`,
        'no_inventory_level',
      );
    }

    const locked = await repo.lockLevels(tx, [levelId]);
    const before = locked.get(levelId);
    if (!before) throw new NotFoundError('Inventory level', levelId);

    assertReservable(before, body.quantity, `${item.sku} at ${warehouse.code}`);

    const at = new Date();
    // The same conditional-UPDATE guard, on `reserved_qty`. `on_hand_qty` is
    // untouched and NO movement row is written: a hold is not a movement.
    const held = await repo.reserveStock(tx, levelId, body.quantity, at);
    if (!held) {
      throw new UnprocessableError(
        `${item.sku} at ${warehouse.code} no longer has ${body.quantity} sellable — another operation committed ` +
          `while this hold was being placed.`,
        'insufficient_stock',
        { context: { inventoryLevelId: levelId, requestedQty: body.quantity } },
      );
    }

    const reservation = await repo.insertReservation(tx, {
      inventoryLevelId: levelId,
      quantity: body.quantity,
      expiresAt,
    });

    const after = applyReservation(before, body.quantity);
    await repo.insertActivity(tx, {
      actorStaffId: actor.staffId,
      actorLabel: actor.label,
      actorRole: actor.role,
      action: 'inventory.reserved',
      entityType: 'inventory_reservation',
      entityId: reservation.id,
      entityLabel: item.sku,
      // `onHandQty` is identical on both sides. That is the invariant, recorded
      // rather than asserted in a comment.
      beforeData: { onHandQty: before.onHandQty, reservedQty: before.reservedQty, availableQty: availableOf(before) },
      afterData: {
        onHandQty: after.onHandQty,
        reservedQty: after.reservedQty,
        availableQty: availableOf(after),
        quantity: body.quantity,
        note: body.note ?? null,
      },
      changedFields: ['reservedQty'],
      requestId,
    });

    return {
      id: reservation.id,
      inventoryLevelId: levelId,
      item: { kind: item.kind, id: item.id, sku: item.sku, name: item.name },
      warehouseId: body.warehouseId,
      warehouseCode: warehouse.code,
      quantity: body.quantity,
      reason: 'manual_hold' as const,
      cartId: null,
      orderId: null,
      expiresAt: iso(expiresAt),
      releasedAt: null,
      isActive: true,
      createdAt: reservation.createdAt.toISOString(),
    };
  });
}

export async function releaseReservation(
  reservationId: string,
  reason: string | undefined,
  auth: StaffAuth,
  requestId: string | null,
): Promise<ReservationResponse> {
  const actor = actorOf(auth);

  const levelId = await db.transaction(async (tx) => {
    const existing = await repo.findReservation(reservationId, tx);
    if (!existing) throw new NotFoundError('Reservation', reservationId);

    // Lock the level before claiming the release, so the decrement below cannot
    // interleave with a checkout reserving the same level.
    const locked = await repo.lockLevels(tx, [existing.inventoryLevelId]);
    const before = locked.get(existing.inventoryLevelId);
    if (!before) throw new NotFoundError('Inventory level', existing.inventoryLevelId);

    const at = new Date();
    const claimed = await repo.markReservationReleased(tx, reservationId, at);
    if (!claimed) {
      throw new UnprocessableError(
        'That hold was already released. Releasing it twice would return the same units to sellable stock ' +
          'twice, which is how phantom inventory appears.',
        'reservation_already_released',
      );
    }

    const decremented = await repo.releaseReservedQty(tx, claimed.inventoryLevelId, claimed.quantity, at);
    if (!decremented) {
      // Unreachable: `reserved_qty` cannot be below the sum of its own unreleased
      // reservations. Loud, because silently skipping the decrement leaves stock
      // permanently held by a reservation that no longer exists.
      throw new Error(
        `Ledger integrity: level ${claimed.inventoryLevelId} holds less than the ${claimed.quantity} units ` +
          `reservation ${reservationId} claims.`,
      );
    }

    await repo.insertActivity(tx, {
      actorStaffId: actor.staffId,
      actorLabel: actor.label,
      actorRole: actor.role,
      action: 'inventory.released',
      entityType: 'inventory_reservation',
      entityId: reservationId,
      entityLabel: null,
      beforeData: { onHandQty: before.onHandQty, reservedQty: before.reservedQty, availableQty: availableOf(before) },
      afterData: {
        onHandQty: before.onHandQty,
        reservedQty: before.reservedQty - claimed.quantity,
        availableQty: availableOf(before) + claimed.quantity,
        quantity: claimed.quantity,
        reason: reason ?? null,
      },
      changedFields: ['reservedQty'],
      requestId,
    });

    return claimed.inventoryLevelId;
  });

  const rows = await repo.listReservations(
    and(eq(inventoryLevels.id, levelId), sql`inventory_reservations.id = ${reservationId}`),
    [],
    1,
    0,
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('Reservation', reservationId);
  return toReservation(row);
}

/* ----------------------------------------------------------------- audit */

export async function listAudit(
  query: InventoryAuditQuery,
): Promise<{ items: InventoryAuditEvent[]; total: number }> {
  const from = parseInstant(query.from, 'from');
  const to = parseInstant(query.to, 'to');

  const conditions: (SQL | undefined)[] = [
    repo.activityInInventory(),
    query.action ? sql`activity_logs.action = ${query.action}` : undefined,
    query.entityId ? sql`activity_logs.entity_id = ${query.entityId}` : undefined,
    query.actorStaffId ? sql`activity_logs.actor_staff_id = ${query.actorStaffId}` : undefined,
    repo.activityBetween(from, to),
    query.q ? repo.activityMatchesText(likePattern(query.q)) : undefined,
  ];
  const where = and(...conditions.filter((c): c is SQL => Boolean(c)));
  const direction = query.sort === 'occurredAt' ? 'asc' : 'desc';

  const [rows, total] = await Promise.all([
    repo.listActivity(where, direction, query.perPage, offsetOf(query.page, query.perPage)),
    repo.countActivity(where),
  ]);

  return {
    items: rows.map((row) => ({
      id: String(row.id),
      occurredAt: row.occurredAt.toISOString(),
      action: row.action,
      actorLabel: row.actorLabel,
      actorRole: row.actorRole,
      actorStaffId: row.actorStaffId,
      entityType: row.entityType,
      entityId: row.entityId,
      entityLabel: row.entityLabel,
      beforeData: row.beforeData ?? null,
      afterData: row.afterData ?? null,
      changedFields: row.changedFields,
      requestId: row.requestId,
    })),
    total,
  };
}

/* --------------------------------------------------------- notifications */

export async function listNotifications(
  query: InventoryNotificationQuery,
  auth: StaffAuth,
): Promise<{ items: InventoryNotification[]; total: number }> {
  const conditions: (SQL | undefined)[] = [
    repo.inventoryNotificationsFor(auth.staffId),
    query.unreadOnly ? repo.notificationUnread() : undefined,
    query.priority ? repo.notificationPriorityIs(query.priority) : undefined,
  ];
  const where = and(...conditions.filter((c): c is SQL => Boolean(c)));
  const direction = query.sort === 'createdAt' ? 'asc' : 'desc';

  const [rows, total] = await Promise.all([
    repo.listInventoryNotifications(where, direction, query.perPage, offsetOf(query.page, query.perPage)),
    repo.countInventoryNotifications(where),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      kind: 'inventory' as const,
      priority: row.priority,
      title: row.title,
      body: row.body,
      linkUrl: row.linkUrl,
      entityType: row.entityType,
      entityId: row.entityId,
      readAt: iso(row.readAt),
      createdAt: row.createdAt.toISOString(),
    })),
    total,
  };
}

/* ---------------------------------------------------------------- export */

export const EXPORT_COLUMNS = [
  'sku',
  'name',
  'kind',
  'warehouseCode',
  'warehouseName',
  'binLocation',
  'onHandQty',
  'reservedQty',
  'availableQty',
  'incomingQty',
  'reorderPoint',
  'reorderQty',
  'state',
  'unitCostPaise',
  'stockValuePaise',
  'lastMovementAt',
] as const;

/**
 * RFC 4180 quoting. Every field is quoted unconditionally — cheaper than deciding
 * per field, and it removes the classic bug where a bin location containing a
 * comma silently shifts every column after it.
 */
const csvCell = (value: string | number | null): string => {
  if (value === null) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
};

export function toCsv(rows: readonly InventoryLevelSummary[]): string {
  const header = EXPORT_COLUMNS.join(',');
  const body = rows.map((row) =>
    [
      row.item.sku,
      row.item.name,
      row.item.kind,
      row.warehouseCode,
      row.warehouseName,
      row.binLocation,
      row.onHandQty,
      row.reservedQty,
      row.availableQty,
      row.incomingQty,
      row.reorderPoint,
      row.reorderQty,
      row.state,
      row.unitCostPaise,
      row.stockValuePaise,
      row.lastMovementAt,
    ]
      .map(csvCell)
      .join(','),
  );
  // CRLF: Excel on Windows is the overwhelming consumer of this file.
  return [header, ...body].join('\r\n');
}

export async function exportInventory(query: InventoryExportQuery): Promise<InventoryLevelSummary[]> {
  const conditions: (SQL | undefined)[] = [
    query.warehouseId ? eq(inventoryLevels.warehouseId, query.warehouseId) : undefined,
    query.kind ? repo.kindIs(query.kind) : undefined,
    query.state ? repo.stateIs(query.state) : undefined,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  const where = present.length > 0 ? and(...present) : undefined;

  const rows = await repo.listLevels(
    where,
    [repo.orderByFor(repo.SORTABLE.sku, 'asc'), repo.orderByFor(repo.SORTABLE.warehouse, 'asc')],
    query.limit,
    0,
  );
  return rows.map(toLevelSummary);
}

/* ------------------------------------------------------------- dashboard */

export async function dashboard(query: DashboardQuery): Promise<InventoryDashboard> {
  const scope = query.warehouseId ? eq(inventoryLevels.warehouseId, query.warehouseId) : undefined;

  const [totals, byWarehouse, movements, reservations, openPos] = await Promise.all([
    repo.dashboardTotals(scope),
    repo.dashboardByWarehouse(scope),
    repo.movementActivity(query.warehouseId),
    repo.reservationActivity(query.warehouseId),
    repo.openPurchaseOrderTotals(query.warehouseId),
  ]);

  return {
    warehouseId: query.warehouseId ?? null,
    trackedItemCount: totals.trackedItemCount,
    levelCount: totals.levelCount,
    totalOnHandQty: totals.totalOnHandQty,
    totalReservedQty: totals.totalReservedQty,
    totalAvailableQty: totals.totalAvailableQty,
    totalIncomingQty: totals.totalIncomingQty,
    stockValuePaise: totals.stockValuePaise,
    outOfStockCount: totals.outOfStockCount,
    lowStockCount: totals.lowStockCount,
    reorderCount: totals.reorderCount,
    activeReservationCount: reservations.active,
    expiringReservationCount: reservations.expiringSoon,
    movementsLast24h: movements.last24h,
    movementsLast7d: movements.last7d,
    openPurchaseOrderCount: openPos.count,
    openPurchaseOrderValuePaise: openPos.valuePaise,
    warehouses: byWarehouse.map((w) => ({
      warehouseId: w.warehouseId,
      warehouseCode: w.warehouseCode,
      warehouseName: w.warehouseName,
      levelCount: w.levelCount,
      onHandQty: w.onHandQty,
      reservedQty: w.reservedQty,
      availableQty: w.availableQty,
      stockValuePaise: w.stockValuePaise,
      outOfStockCount: w.outOfStockCount,
      lowStockCount: w.lowStockCount,
    })),
  };
}
