/**
 * Stock counts — freeze, count, approve.
 *
 * Four rules shape this file. The first is the one the whole subsystem exists for.
 *
 * **1. A count never overwrites stock.** `start` freezes `system_qty`, `items`
 * records `counted_qty`, and `approve` posts the DIFFERENCE as a `stock_count`
 * movement. There is no statement anywhere in this module that assigns
 * `on_hand_qty = counted_qty`, and adding one would break the ledger's central
 * property: that `SUM(quantity_delta)` reconstructs `on_hand_qty`.
 *
 * **2. The frozen figure is never re-read.** If approval read on-hand again
 * instead of using `system_qty`, every sale that happened while the counter
 * walked the aisle would be absorbed into the comparison and the variance would
 * come out zero. A count that always agrees with itself is a count that finds
 * nothing — which is the exact failure it is commissioned to catch. See the
 * header of `admin-stock-counts.state.ts`.
 *
 * **3. Approval is one transaction.** The count row is locked, every varying
 * level is locked in ascending id order (§62), each adjustment is posted with the
 * balance its own conditional UPDATE returned, and the header is stamped. If any
 * line fails, none of it happened — a half-approved count leaves a warehouse in
 * a state nobody chose and nobody can describe.
 *
 * **4. A shortfall may not eat reserved units.** Reserved stock is promised to a
 * paid order. A counted quantity that would drive sellable stock negative is
 * refused with `insufficient_stock` and a message that says what to do, because
 * this is a normal operational event — someone counted a shelf a picker had
 * already emptied — and not a programming error.
 */

import { and, asc, desc, type SQL } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { BadRequestError, NotFoundError, UnprocessableError, type FieldIssue } from '../../lib/errors.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import type { StaffAuth } from '../../lib/openapi/define-route.js';
import { availableOf } from '../admin-inventory/admin-inventory.stock.js';
import { STOCK_COUNT_STATUSES, type StockCountStatus } from '../../db/schema/index.js';
import * as repo from './admin-stock-counts.repository.js';
import {
  assertCountAcceptsItems,
  assertCountAction,
  assertVarianceApplies,
  countBalanceAfter,
  countEdgesFrom,
  countTotals,
  postableVariances,
  varianceOf,
  type CountLine,
} from './admin-stock-counts.state.js';
import type {
  ApproveCountBody,
  CompleteCountBody,
  CountApprovalResult,
  CountDetail,
  CountDetailQuery,
  CountItemResponse,
  CountListQuery,
  CountSummary,
  CreateCountBody,
  StartCountBody,
  SubmitCountItemsBody,
  SubmitItemsResult,
} from './admin-stock-counts.schemas.js';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const csv = (raw: string | undefined): string[] =>
  raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/** Exported for the test: an unrecognised status is a 400, never a silently empty page. */
export function parseCountStatuses(raw: string | undefined): StockCountStatus[] {
  const values = csv(raw);
  const unknown = values.filter((v) => !(STOCK_COUNT_STATUSES as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown stock count status: ${unknown.join(', ')}. Valid values: ${STOCK_COUNT_STATUSES.join(', ')}.`,
    );
  }
  return values as StockCountStatus[];
}

/* ------------------------------------------------------------- projection */

const toItemResponse = (row: repo.CountItemRow): CountItemResponse => {
  const line: CountLine = {
    inventoryLevelId: row.inventoryLevelId,
    systemQty: row.systemQty,
    countedQty: row.countedQty,
  };
  return {
    id: row.id,
    inventoryLevelId: row.inventoryLevelId,
    itemKind: repo.stockableKindOf(row),
    itemId: row.variantId ?? row.hamperItemId ?? row.packagingId ?? row.inventoryLevelId,
    sku: row.sku,
    name: row.name,
    binLocation: row.binLocation,
    locationPath: row.locationPath,
    systemQty: row.systemQty,
    countedQty: row.countedQty,
    // Deliberately `varianceOf`, not `row.generatedVarianceQty`. The generated
    // column reads `COALESCE(counted,0) − system`, which for an uncounted line
    // renders as a full write-off rather than as "no opinion yet".
    varianceQty: varianceOf(line),
    recountQty: row.recountQty,
    reason: row.reason,
    countedAt: iso(row.countedAt),
    countedBy: row.countedBy,
  };
};

async function summaryOf(row: repo.CountRow): Promise<CountSummary> {
  const lines = await repo.allCountLines(row.id);
  return {
    id: row.id,
    countNo: row.countNo,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouseCode,
    locationId: row.locationId,
    locationPath: row.locationPath,
    kind: row.kind,
    status: row.status,
    scheduledFor: row.scheduledFor,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    approvedAt: iso(row.approvedAt),
    createdBy: row.createdBy,
    countedBy: row.countedBy,
    approvedBy: row.approvedBy,
    note: row.note,
    totals: countTotals(lines),
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireCount(countId: string): Promise<repo.CountRow> {
  const row = await repo.findCount(countId);
  if (!row) throw new NotFoundError('Stock count', countId);
  return row;
}

/* ---------------------------------------------------------- cross-module */

/**
 * The in-progress count covering one inventory level, or null.
 *
 * Exists so the barcode module can answer "what am I counting this against?"
 * without reaching into this module's repository — cross-module calls go
 * service→service so the definition of "an open count" stays in one place. If
 * that definition ever widens (say, to include `draft` sheets someone is about
 * to start), it widens here and every caller follows.
 */
export async function openCountForLevel(levelId: string): Promise<{
  countId: string;
  countNo: string;
  inventoryLevelId: string;
  countItemId: string;
  systemQty: number;
  countedQty: number | null;
} | null> {
  const row = await repo.findOpenCountForLevel(levelId);
  if (!row) return null;
  return {
    countId: row.countId,
    countNo: row.countNo,
    inventoryLevelId: levelId,
    countItemId: row.itemId,
    systemQty: row.systemQty,
    countedQty: row.countedQty,
  };
}

/* ------------------------------------------------------------------ list */

const SORT_FIELDS = ['createdAt', 'countNo', 'status', 'scheduledFor', 'completedAt'] as const;

export async function listCounts(query: CountListQuery): Promise<{ items: CountSummary[]; total: number }> {
  const conditions: (SQL | undefined)[] = [
    query.warehouseId ? repo.countWarehouseIs(query.warehouseId) : undefined,
    query.locationId ? repo.countLocationIs(query.locationId) : undefined,
    repo.countStatusIn(parseCountStatuses(query.status)),
    query.kind ? repo.countKindIs(query.kind) : undefined,
    query.scheduledFrom ? repo.countScheduledFrom(query.scheduledFrom) : undefined,
    query.scheduledTo ? repo.countScheduledTo(query.scheduledTo) : undefined,
    query.q ? repo.countMatchesText(`%${query.q}%`) : undefined,
  ];

  const { field, direction } = parseSort(query.sort, SORT_FIELDS, { field: 'createdAt', direction: 'desc' });
  const column = repo.countSortColumn(field);
  const orderBy = [direction === 'asc' ? asc(column) : desc(column)];

  const { rows, total } = await repo.listCounts(
    and(...conditions.filter(Boolean)),
    orderBy,
    query.perPage,
    offsetOf(query.page, query.perPage),
  );

  return { items: await Promise.all(rows.map(summaryOf)), total };
}

/* ---------------------------------------------------------------- detail */

export async function getCount(countId: string, query: CountDetailQuery): Promise<CountDetail> {
  const row = await requireCount(countId);
  const summary = await summaryOf(row);

  const { rows: items, total } = await repo.listCountItems(
    countId,
    { onlyVariances: query.onlyVariances === 'true', uncountedOnly: query.uncountedOnly === 'true' },
    query.itemPerPage,
    offsetOf(query.itemPage, query.itemPerPage),
  );

  return {
    ...summary,
    items: items.map(toItemResponse),
    itemPage: query.itemPage,
    itemPerPage: query.itemPerPage,
    itemTotal: total,
    transitions: countEdgesFrom(row.status).map((e) => ({
      to: e.to,
      action: e.action,
      label: e.label,
      movesStock: e.movesStock,
      sideEffects: [...(e.sideEffects ?? [])],
    })),
  };
}

/* ---------------------------------------------------------------- create */

export async function createCount(body: CreateCountBody, auth: StaffAuth): Promise<CountSummary> {
  const warehouse = await repo.findWarehouse(body.warehouseId);
  if (!warehouse) throw new NotFoundError('Warehouse', body.warehouseId);

  if (body.locationId) {
    const location = await repo.findLocation(body.locationId);
    if (!location) throw new NotFoundError('Warehouse location', body.locationId);
    if (location.warehouseId !== body.warehouseId) {
      throw new UnprocessableError(
        `Location ${location.path} belongs to a different warehouse. A count scoped to a location in one ` +
          'warehouse while naming another would freeze an empty sheet and then report a clean count.',
        'location_warehouse_mismatch',
        { context: { locationId: body.locationId, warehouseId: body.warehouseId } },
      );
    }
  }

  const created = await db.transaction(async (tx) => {
    const countNo = await repo.nextCountNumber(tx, new Date().getUTCFullYear());
    return repo.insertCount(tx, {
      countNo,
      warehouseId: body.warehouseId,
      locationId: body.locationId ?? null,
      kind: body.kind,
      // Created as a draft, always. Nothing is frozen until somebody starts it —
      // a sheet that froze at creation would be stale by the time it is walked.
      status: 'draft',
      scheduledFor: body.scheduledFor ?? null,
      createdBy: auth.staffId,
      note: body.note ?? null,
    });
  });

  return summaryOf(await requireCount(created.id));
}

/* ----------------------------------------------------------------- start */

export async function startCount(
  countId: string,
  body: StartCountBody,
  auth: StaffAuth,
): Promise<CountSummary> {
  await db.transaction(async (tx) => {
    const count = await repo.lockCount(tx, countId);
    if (!count) throw new NotFoundError('Stock count', countId);

    assertCountAction(count.status, 'start');

    const locationRootPath = count.locationId
      ? ((await repo.findLocation(count.locationId, tx))?.path ?? null)
      : null;

    if (count.locationId && !locationRootPath) {
      throw new UnprocessableError(
        'The location this count was scoped to has been deleted, so there is nothing to freeze. Raise a new ' +
          'count against a location that still exists.',
        'count_location_missing',
        { context: { countId, locationId: count.locationId } },
      );
    }

    // THE FREEZE. One INSERT … SELECT, so the whole sheet is one consistent read
    // of `inventory_levels` rather than a walk that is already stale by row 900.
    const frozen = await repo.snapshotLevels(tx, {
      countId,
      warehouseId: count.warehouseId,
      locationRootPath,
    });

    if (frozen === 0) {
      throw new UnprocessableError(
        'Nothing is stocked in this scope, so there is nothing to count. An empty count sheet that can be ' +
          'approved would report a perfect count over zero items. Check the warehouse and location, or ' +
          'create the inventory levels first.',
        'nothing_to_count',
        { context: { countId, warehouseId: count.warehouseId, locationId: count.locationId } },
      );
    }

    const now = new Date();
    await repo.updateCount(tx, countId, {
      status: 'in_progress',
      startedAt: now,
      countedBy: body.countedBy ?? auth.staffId,
      updatedAt: now,
    });
  });

  return summaryOf(await requireCount(countId));
}

/* ----------------------------------------------------------------- items */

export async function submitItems(
  countId: string,
  body: SubmitCountItemsBody,
  auth: StaffAuth,
): Promise<SubmitItemsResult> {
  // Two quantities for one SKU in one submission is ambiguous about which one is
  // the count. Refuse rather than let insertion order decide.
  const seen = new Set<string>();
  const duplicates: FieldIssue[] = [];
  body.items.forEach((line, index) => {
    if (seen.has(line.sku)) {
      duplicates.push({
        path: `items[${index}].sku`,
        code: 'duplicate_count_item',
        message: `${line.sku} appears more than once in this submission. Send one counted quantity per SKU.`,
      });
    }
    seen.add(line.sku);
  });
  if (duplicates.length > 0) {
    throw new UnprocessableError(
      'The submission counts the same SKU twice.',
      'duplicate_count_item',
      { issues: duplicates },
    );
  }

  const written = await db.transaction(async (tx) => {
    const count = await repo.lockCount(tx, countId);
    if (!count) throw new NotFoundError('Stock count', countId);

    // Not a transition — the sheet stays `in_progress` — so it is its own guard.
    assertCountAcceptsItems(count.status);

    const lines = await repo.findCountItemsBySkus(tx, countId, [...seen]);

    // Scope is enforced by the count sheet itself: a SKU stocked in the warehouse
    // but outside this count's location subtree simply has no frozen line, and
    // accepting it would record a counted quantity with no `systemQty` to
    // measure it against.
    const outOfScope: FieldIssue[] = body.items
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !lines.has(line.sku))
      .map(({ line, index }) => ({
        path: `items[${index}].sku`,
        code: 'sku_not_in_count_scope',
        message:
          `${line.sku} is not on count ${count.countNo}. Only the levels frozen when the count started can ` +
          'be counted against it — if this item genuinely belongs in the scope, raise a new count that ' +
          'covers it rather than widening one that is already being walked.',
      }));

    if (outOfScope.length > 0) {
      throw new UnprocessableError(
        'Some SKUs are not in this count’s scope. Nothing was recorded — this endpoint is all-or-nothing.',
        'sku_not_in_count_scope',
        { issues: outOfScope },
      );
    }

    const at = new Date();
    const itemIds: string[] = [];
    for (const line of body.items) {
      const target = lines.get(line.sku);
      if (!target) throw new NotFoundError('Stock count line', line.sku);

      await repo.recordCountedQty(tx, target.id, {
        countedQty: line.countedQty,
        recountQty: line.recountQty ?? null,
        reason: line.reason ?? null,
        countedBy: auth.staffId,
        countedAt: at,
      });
      itemIds.push(target.id);
    }

    await repo.updateCount(tx, countId, { updatedAt: at });

    // Read back INSIDE the transaction, so the response carries this submission's
    // own writes and the roll-up cannot straddle a concurrent one.
    return {
      items: await repo.findCountItemsByIds(tx, itemIds),
      totals: countTotals(await repo.allCountLines(countId, tx)),
      accepted: itemIds.length,
    };
  });

  return {
    countId,
    accepted: written.accepted,
    items: written.items.map(toItemResponse),
    totals: written.totals,
  };
}

/* -------------------------------------------------------------- complete */

export async function completeCount(countId: string, body: CompleteCountBody): Promise<CountSummary> {
  await db.transaction(async (tx) => {
    const count = await repo.lockCount(tx, countId);
    if (!count) throw new NotFoundError('Stock count', countId);

    assertCountAction(count.status, 'complete');

    const totals = countTotals(await repo.allCountLines(countId, tx));

    if (totals.itemsCounted === 0) {
      throw new UnprocessableError(
        'Nothing on this sheet has been counted. Completing it would produce a document that says a ' +
          'warehouse was checked when no shelf was walked.',
        'nothing_counted',
        { context: { countId, itemsInScope: totals.itemsInScope } },
      );
    }

    if (totals.itemsUncounted > 0 && !body.allowUncounted) {
      throw new UnprocessableError(
        `${totals.itemsUncounted} of ${totals.itemsInScope} lines have not been counted. They will be SKIPPED ` +
          'at approval, not written off — but a signed-off count that silently omits them says those SKUs ' +
          'were checked when they were not. Count them, or re-send with `allowUncounted: true` to record ' +
          'deliberately that this was a partial count.',
        'uncounted_items',
        { context: { countId, itemsUncounted: totals.itemsUncounted, itemsInScope: totals.itemsInScope } },
      );
    }

    const now = new Date();
    await repo.updateCount(tx, countId, {
      status: 'completed',
      completedAt: now,
      ...(body.note ? { note: body.note } : {}),
      updatedAt: now,
    });
  });

  return summaryOf(await requireCount(countId));
}

/* --------------------------------------------------------------- approve */

export async function approveCount(
  countId: string,
  body: ApproveCountBody,
  auth: StaffAuth,
): Promise<CountApprovalResult> {
  const outcome = await db.transaction(async (tx) => {
    const count = await repo.lockCount(tx, countId);
    if (!count) throw new NotFoundError('Stock count', countId);

    // The row lock plus this check is what makes a double approval impossible:
    // the second transaction blocks here, then re-reads `approved` and is refused
    // rather than posting the same variance again.
    assertCountAction(count.status, 'approve');

    const rows = await repo.varianceLines(countId, tx);
    const allLines = await repo.allCountLines(countId, tx);
    const totals = countTotals(allLines);

    // Sorted by inventory level id — the deterministic lock order every stock
    // writer in this codebase uses, so an approval and a checkout contending for
    // the same levels queue instead of deadlocking (§62).
    const work = postableVariances(
      rows.map((r) => ({
        inventoryLevelId: r.inventoryLevelId,
        systemQty: r.systemQty,
        countedQty: r.countedQty,
      })),
    );
    const bySku = new Map(rows.map((r) => [r.inventoryLevelId, r]));

    const locked = await repo.lockLevels(
      tx,
      work.map((w) => w.inventoryLevelId),
    );

    const at = new Date();
    const movements: CountApprovalResult['movements'] = [];

    for (const line of work) {
      const source = bySku.get(line.inventoryLevelId);
      if (!source) throw new NotFoundError('Stock count line', line.inventoryLevelId);

      const before = locked.get(line.inventoryLevelId);
      if (!before) throw new NotFoundError('Inventory level', line.inventoryLevelId);

      const label = `${source.sku ?? line.inventoryLevelId}`;

      // The database's GENERATED column and the pure function must agree on a
      // COUNTED row. If they ever do not, the schema changed under this code and
      // continuing would post an adjustment nobody computed.
      if (source.generatedVarianceQty !== null && source.generatedVarianceQty !== line.varianceQty) {
        throw new Error(
          `Variance disagreement on count line ${source.id}: generated column says ` +
            `${source.generatedVarianceQty}, counted ${line.countedQty} minus frozen ${line.systemQty} is ` +
            `${line.varianceQty}.`,
        );
      }

      // Readable refusal with real numbers in it. NOT the guarantee — the
      // conditional UPDATE below is.
      assertVarianceApplies(before, line.varianceQty, label);

      const after = await repo.applyOnHandDelta(tx, line.inventoryLevelId, line.varianceQty, at);
      if (!after) {
        // Zero rows affected. Under READ COMMITTED this is the WHERE clause being
        // re-evaluated against a row somebody else just committed — the race the
        // pre-check cannot see. Never a no-op, always a refusal, and because this
        // throws, the entire approval rolls back.
        throw new UnprocessableError(
          `${label}: the shortfall of ${Math.abs(line.varianceQty)} no longer fits in sellable stock — ` +
            'something reserved or removed these units while the approval was in flight. Nothing was ' +
            'posted. Re-read the count and approve again.',
          'insufficient_stock',
          { context: { countId, inventoryLevelId: line.inventoryLevelId, varianceQty: line.varianceQty } },
        );
      }

      const expected = countBalanceAfter(before, line.varianceQty);
      if (after.onHandQty !== expected) {
        // Unreachable while the row lock is held. Loud rather than silent: the
        // alternative is a ledger whose running balance is quietly wrong.
        throw new Error(
          `Ledger integrity: level ${line.inventoryLevelId} moved from ${before.onHandQty} by ` +
            `${line.varianceQty} and landed on ${after.onHandQty}, not ${expected}.`,
        );
      }

      const movement = await repo.insertMovement(tx, {
        inventoryLevelId: line.inventoryLevelId,
        quantityDelta: line.varianceQty,
        balanceAfter: after.onHandQty,
        referenceId: count.id,
        referenceLabel: count.countNo,
        note: [source.reason, body.note].filter(Boolean).join(' — ') || null,
        actorId: auth.staffId,
        occurredAt: at,
      });

      movements.push({
        movementId: String(movement.id),
        inventoryLevelId: line.inventoryLevelId,
        sku: source.sku,
        systemQty: line.systemQty,
        countedQty: line.countedQty ?? 0,
        varianceQty: line.varianceQty,
        onHandQtyBefore: before.onHandQty,
        onHandQty: after.onHandQty,
        reservedQty: after.reservedQty,
        availableQty: availableOf(after),
      });
    }

    // `approvedBy` and `approvedAt` together with the status, in one statement —
    // `stock_counts_approved_by_required` refuses an anonymous approval, and it
    // is right to: an approval nobody signed defeats the point of the step.
    await repo.updateCount(tx, countId, {
      status: 'approved',
      approvedBy: auth.staffId,
      approvedAt: at,
      ...(body.note ? { note: body.note } : {}),
      updatedAt: at,
    });

    return { movements, totals };
  });

  return {
    count: await summaryOf(await requireCount(countId)),
    itemsAdjusted: outcome.movements.length,
    itemsSkippedUncounted: outcome.totals.itemsUncounted,
    netVarianceQty: outcome.movements.reduce((sum, m) => sum + m.varianceQty, 0),
    absVarianceQty: outcome.movements.reduce((sum, m) => sum + Math.abs(m.varianceQty), 0),
    movements: outcome.movements,
  };
}
