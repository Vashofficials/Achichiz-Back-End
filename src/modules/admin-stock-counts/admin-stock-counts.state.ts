/**
 * The stock-count state machine and its arithmetic — pure, no I/O.
 *
 * Split out for the same reason `admin-purchasing.state.ts` is: the rule that
 * makes a count worth doing should be readable on one screen and provable
 * without a warehouse.
 *
 * ## THE RULE: a count never overwrites stock
 *
 * Three moments, three different jobs:
 *
 *  1. **`start`** freezes `system_qty` — what the system believed, per level, at
 *     the instant the counter was sent to the aisle.
 *  2. **`items`** records `counted_qty` — what the counter's eyes saw.
 *  3. **`approve`** posts the DIFFERENCE as an adjustment movement.
 *
 * Nothing anywhere runs `UPDATE inventory_levels SET on_hand_qty = counted_qty`.
 * The ledger has to be able to answer "how much did this count move, and when",
 * and an assignment leaves no such row.
 *
 * ## Why `system_qty` is frozen rather than re-read at approval
 *
 * Suppose it were re-read. The counter writes down 48 at 09:00. Two units sell at
 * 09:30. Approval runs at 10:00, reads on-hand 48, computes a variance of zero,
 * and reports a clean count — while the shelf is short two units that the count
 * was commissioned to find. Re-reading makes every count agree with itself by
 * construction, which is precisely the failure a count exists to catch. So the
 * variance is measured against the frozen number, the sales in between remain
 * their own `outbound` movements, and the ledger stays additive.
 *
 * ## Uncounted items are not "counted zero"
 *
 * `stock_count_items.variance_qty` is a GENERATED column,
 * `COALESCE(counted_qty, 0) - system_qty`. For a row nobody counted that reads as
 * a variance of `-system_qty` — a full write-off. It is a convenience for
 * reporting on counted rows, NOT an instruction. `varianceOf` below returns null
 * for an uncounted row and `postableVariances` drops those rows entirely, so an
 * unfinished count can never zero a warehouse.
 */

import { UnprocessableError } from '../../lib/errors.js';
import {
  availableOf,
  balanceAfter,
  type StockPosition,
} from '../admin-inventory/admin-inventory.stock.js';
import type { StockCountStatus } from '../../db/schema/index.js';

/* ------------------------------------------------------- the state machine */

export const COUNT_ACTIONS = ['start', 'submit', 'complete', 'approve', 'cancel'] as const;
export type CountAction = (typeof COUNT_ACTIONS)[number];

export type CountEdge = {
  to: StockCountStatus;
  action: CountAction;
  label: string;
  /** True for the one edge that touches `inventory_levels`. Exactly one does. */
  movesStock: boolean;
  sideEffects?: readonly string[];
};

/**
 * No endpoint produces `cancelled` in this phase. The edge is declared anyway so
 * the table is total and a future abandon-count endpoint has somewhere to land
 * rather than a new branch — the same choice `PO_TRANSITIONS` makes for
 * `pending_approval`.
 */
const cancelEdge: CountEdge = {
  to: 'cancelled',
  action: 'cancel',
  label: 'Cancelled',
  movesStock: false,
  sideEffects: ['Abandons the sheet. No stock moves, and the frozen snapshot is kept for the record'],
};

export const COUNT_TRANSITIONS: Record<StockCountStatus, readonly CountEdge[]> = {
  draft: [
    {
      to: 'in_progress',
      action: 'start',
      label: 'Counting started',
      movesStock: false,
      sideEffects: [
        'Snapshots `system_qty` for every level in scope — frozen from this moment',
        'Stamps `startedAt` and `countedBy`',
      ],
    },
    cancelEdge,
  ],
  in_progress: [
    {
      to: 'completed',
      action: 'complete',
      label: 'Counting finished',
      movesStock: false,
      sideEffects: ['Stamps `completedAt`. Still no stock movement — completion is not approval'],
    },
    cancelEdge,
  ],
  completed: [
    {
      to: 'approved',
      action: 'approve',
      label: 'Approved',
      movesStock: true,
      sideEffects: [
        'Posts one `stock_count` movement per varying item, for exactly the variance',
        'Stamps `approvedBy` and `approvedAt`, which the `stock_counts_approved_by_required` CHECK demands',
      ],
    },
    cancelEdge,
  ],
  approved: [],
  cancelled: [],
};

export const countEdgesFrom = (status: StockCountStatus): readonly CountEdge[] =>
  COUNT_TRANSITIONS[status];

/** Counted quantities may only be submitted while the sheet is open. */
export const isCountOpen = (status: StockCountStatus): boolean => status === 'in_progress';

export function assertCountAction(from: StockCountStatus, action: CountAction): CountEdge {
  const edge = countEdgesFrom(from).find((e) => e.action === action);
  if (edge) return edge;

  if (action === 'approve' && from === 'in_progress') {
    throw new UnprocessableError(
      'This count is still being counted. Finish it with POST /complete first — approving a sheet that ' +
        'is still being filled in would post a variance for the aisles nobody has walked yet.',
      'count_not_completed',
      { context: { from, action } },
    );
  }
  if (action === 'approve' && from === 'approved') {
    throw new UnprocessableError(
      'This count has already been approved and its variance is already in the ledger. Approving it twice ' +
        'would post the same adjustment again. If the numbers were wrong, raise a new count or a manual ' +
        'adjustment — the ledger is append-only and nothing here edits a movement.',
      'count_already_approved',
      { context: { from, action } },
    );
  }

  const legal = countEdgesFrom(from).map((e) => e.action);
  throw new UnprocessableError(
    `A stock count in \`${from}\` cannot be ${action === 'submit' ? 'submitted to' : `${action}d`}.` +
      (legal.length > 0 ? ` What you can do from here: ${legal.join(', ')}.` : ' It is in a terminal state.'),
    'illegal_count_transition',
    { context: { from, action, legal } },
  );
}

/**
 * The guard on `POST /items`, separate from the transition table because
 * submitting a quantity is not an edge — the sheet stays `in_progress`.
 */
export function assertCountAcceptsItems(status: StockCountStatus): void {
  if (isCountOpen(status)) return;

  const remedy =
    status === 'draft'
      ? 'Start it first with POST /start — that is what freezes `systemQty`, and a counted quantity with ' +
        'nothing to compare it against is not a count.'
      : status === 'completed'
        ? 'It has been marked complete. Re-open it by raising a new count; edits after completion would ' +
          'change numbers an approver has already reviewed.'
        : status === 'approved'
          ? 'It is approved and its variance is already in the ledger. Record the correction as a new count ' +
            'or a manual adjustment.'
          : 'It was cancelled.';

  throw new UnprocessableError(
    `Counted quantities can only be submitted to a count that is \`in_progress\`; this one is \`${status}\`. ${remedy}`,
    'count_not_in_progress',
    { context: { status } },
  );
}

/* --------------------------------------------------------------- variance */

/** The frozen half and the counted half of one line. */
export type CountLine = {
  inventoryLevelId: string;
  /** What the system believed when `start` ran. Never re-read. */
  systemQty: number;
  /** What the counter wrote down. Null until somebody counts it. */
  countedQty: number | null;
};

/**
 * `counted - system`, or null when nobody has counted the row yet.
 *
 * Deliberately NOT `COALESCE(counted, 0) - system`. That is what the GENERATED
 * column computes, and treating its output as a variance for an uncounted row
 * would write off the whole level. Null here means "no opinion", and every
 * caller has to handle it.
 */
export const varianceOf = (line: CountLine): number | null =>
  line.countedQty === null ? null : line.countedQty - line.systemQty;

/** The subset of lines that will actually produce a movement, in lock order. */
export function postableVariances(
  lines: readonly CountLine[],
): (CountLine & { varianceQty: number })[] {
  return lines
    .map((line) => ({ line, varianceQty: varianceOf(line) }))
    .filter((x): x is { line: CountLine; varianceQty: number } => x.varianceQty !== null)
    // A movement of nothing is not a movement. A line counted exactly right
    // leaves no ledger row, which is why `itemsAdjusted` is smaller than
    // `itemsCounted` on a healthy count.
    .filter((x) => x.varianceQty !== 0)
    .map((x) => ({ ...x.line, varianceQty: x.varianceQty }))
    // §62 deterministic lock ordering — the same ascending-id protocol the
    // bulk adjustment and checkout use, so a count and a checkout contending
    // for the same levels queue instead of deadlocking.
    .sort((a, b) =>
      a.inventoryLevelId < b.inventoryLevelId ? -1 : a.inventoryLevelId > b.inventoryLevelId ? 1 : 0,
    );
}

export type CountTotals = {
  itemsInScope: number;
  itemsCounted: number;
  itemsUncounted: number;
  /** Counted rows whose variance is non-zero. These are the ones that will move. */
  itemsWithVariance: number;
  /** Sum of the signed variances. Two errors of +5 and −5 net to zero. */
  netVarianceQty: number;
  /** Sum of the absolute variances. THIS is the number that measures accuracy. */
  absVarianceQty: number;
};

/**
 * Both totals are reported because they answer different questions, and a single
 * "variance" figure would be the misleading one. A shelf where five units were
 * put in the wrong bin nets to zero and is not a clean count.
 */
export function countTotals(lines: readonly CountLine[]): CountTotals {
  let itemsCounted = 0;
  let itemsWithVariance = 0;
  let netVarianceQty = 0;
  let absVarianceQty = 0;

  for (const line of lines) {
    const variance = varianceOf(line);
    if (variance === null) continue;
    itemsCounted += 1;
    if (variance !== 0) itemsWithVariance += 1;
    netVarianceQty += variance;
    absVarianceQty += Math.abs(variance);
  }

  return {
    itemsInScope: lines.length,
    itemsCounted,
    itemsUncounted: lines.length - itemsCounted,
    itemsWithVariance,
    netVarianceQty,
    absVarianceQty,
  };
}

/* -------------------------------------------------- the negative-stock rule */

/**
 * §64, in the shape a count meets it: a shortfall may not eat reserved units.
 *
 * A negative variance is a withdrawal, and it has to come out of the SELLABLE
 * balance (`on_hand − reserved`), not the on-hand balance. Reserved units are
 * physically present but already promised to a paid order; letting a count
 * absorb them turns somebody's confirmed order into a stockout at picking time,
 * and the count would have "fixed" the number by breaking a delivery.
 *
 * This is a real operational case, not a defensive check — a counter walking a
 * shelf that the picker emptied ten minutes earlier will genuinely report fewer
 * units than the system holds reserved. So the message says what to do about it.
 *
 * This is the same predicate as `assertSufficientStock` in
 * `admin-inventory.stock.ts` (there is a test asserting the two never disagree);
 * only the remedy in the message differs, because the remedy for a count differs.
 * Neither is the *mechanism* — that is the conditional
 * `UPDATE … WHERE on_hand − reserved + delta >= 0` in the repository, whose
 * affected-row count the service checks.
 */
export function assertVarianceApplies(
  position: StockPosition,
  varianceQty: number,
  label: string,
): void {
  if (varianceQty >= 0) return;

  const available = availableOf(position);
  if (available + varianceQty >= 0) return;

  throw new UnprocessableError(
    `${label}: the count of ${position.onHandQty + varianceQty} is below the ${position.reservedQty} ` +
      `units already reserved for open orders (${position.onHandQty} on hand, ${available} sellable). ` +
      'Posting it would promise units that are not there. Do one of three things: recount the shelf in ' +
      'case the stock is in another bin; release the reservations that no longer have an order behind ' +
      'them (GET /v1/admin/inventory/reservations shows what is holding them); or, if the units really ' +
      'were picked and shipped, let the order’s own outbound movement record that and recount afterwards.',
    'insufficient_stock',
    {
      context: {
        onHandQty: position.onHandQty,
        reservedQty: position.reservedQty,
        availableQty: available,
        varianceQty,
        countedQty: position.onHandQty + varianceQty,
      },
    },
  );
}

/**
 * The on-hand balance the movement row must carry, from the row as it was BEFORE
 * the update. Re-exported from the shared stock primitives rather than
 * reimplemented: `stock_movements.balance_after` has to mean the same thing on a
 * count row as it does on every other row, or a ledger replay stops reconciling.
 */
export const countBalanceAfter = balanceAfter;
