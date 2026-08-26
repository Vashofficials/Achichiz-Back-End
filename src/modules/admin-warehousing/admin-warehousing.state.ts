/**
 * The stock-transfer state machine — pure, no I/O.
 *
 * **The status vocabulary is the database's, not the brief's.**
 * `stock_transfers` carries `CHECK (status IN
 * ('requested','approved','in_transit','received','cancelled'))` from migration
 * 0001. The operational lifecycle people describe as
 * `draft → approved → dispatched → in_transit → received → completed` maps onto
 * those five without inventing anything:
 *
 * | spoken           | stored        | why |
 * |------------------|---------------|-----|
 * | draft            | `requested`   | the table's own default |
 * | approved         | `approved`    | — |
 * | dispatched       | `in_transit`  | dispatch IS the event that puts stock in transit; a row that is "dispatched but not in transit" describes nothing |
 * | in_transit       | `in_transit`  | — |
 * | received         | `received`    | — |
 * | completed        | `received`    | there is no post-receipt settlement step on a transfer — the goods are simply there |
 *
 * Inventing `draft`/`dispatched`/`completed` would not be a modelling
 * disagreement, it would be a runtime CHECK violation on every write.
 *
 * Three properties this table has to encode:
 *
 *  1. **Legality.** Anything not listed is 422 `illegal_transfer_transition`,
 *     never a silent no-op. A cancel that quietly does nothing is how a warehouse
 *     ends up shipping stock somebody thought they had stopped.
 *  2. **Which edges move stock.** `dispatch` and `receive` do; `approve` and
 *     `cancel` do not. The service uses this to decide whether it needs the
 *     conditional-decrement path at all.
 *  3. **Why `in_transit` cannot be cancelled.** Stock has already left the source
 *     warehouse. "Cancelling" it would leave the units in neither warehouse's
 *     ledger — invisible inventory, which is the exact failure mode the whole
 *     movement ledger exists to prevent. Receive it and transfer it back.
 */

import { UnprocessableError } from '../../lib/errors.js';
import type { StockTransferStatus } from '../../db/schema/index.js';

/** The four endpoints that write to a transfer. */
export const TRANSFER_ACTIONS = ['approve', 'dispatch', 'receive', 'cancel'] as const;
export type TransferAction = (typeof TRANSFER_ACTIONS)[number];

export type TransferEdge = {
  to: StockTransferStatus;
  action: TransferAction;
  label: string;
  /** True when taking this edge writes to `inventory_levels` and `stock_movements`. */
  movesStock: boolean;
  /** Documented so the console can warn before the click. */
  sideEffects?: readonly string[];
};

const cancelEdge: TransferEdge = {
  to: 'cancelled',
  action: 'cancel',
  label: 'Cancelled',
  movesStock: false,
  sideEffects: ['Nothing to unwind — no stock has moved yet'],
};

/**
 * The table. Keyed by the status you are in.
 *
 * `received` and `cancelled` are terminal. A "reopen" that looked like a status
 * flip would leave two `transfer_in` movements against one dispatch.
 */
export const TRANSFER_TRANSITIONS: Record<StockTransferStatus, readonly TransferEdge[]> = {
  requested: [
    {
      to: 'approved',
      action: 'approve',
      label: 'Approved',
      movesStock: false,
      sideEffects: ['Locks the line quantities — an approved transfer is no longer editable'],
    },
    cancelEdge,
  ],
  approved: [
    {
      to: 'in_transit',
      action: 'dispatch',
      label: 'Dispatched',
      movesStock: true,
      sideEffects: [
        'Decrements on-hand at the SOURCE warehouse',
        'Writes one `transfer_out` movement per line',
        'Raises `incoming_qty` at the destination',
        'The stock is now in neither warehouse’s available — that is correct, not a gap',
      ],
    },
    cancelEdge,
  ],
  in_transit: [
    {
      to: 'received',
      action: 'receive',
      label: 'Received',
      movesStock: true,
      sideEffects: [
        'Increments on-hand at the DESTINATION warehouse',
        'Writes one `transfer_in` movement per line',
        'Clears the destination’s `incoming_qty` for this transfer',
      ],
    },
  ],
  received: [],
  cancelled: [],
};

export const transferEdgesFrom = (status: StockTransferStatus): readonly TransferEdge[] =>
  TRANSFER_TRANSITIONS[status];

/** Statuses whose lines may still be edited. Once approved, the quantities are the agreement. */
export const isTransferEditable = (status: StockTransferStatus): boolean => status === 'requested';

/**
 * Resolve an endpoint's action against the current status.
 *
 * Endpoints are action-named (`/approve`, `/dispatch`), not target-named, so the
 * lookup is by action. An action with no edge from here is 422 with a stable
 * code and the list of what IS possible — a 422 that only says "no" sends an
 * operator hunting through the UI for a button that was never going to appear.
 */
export function assertTransferAction(
  from: StockTransferStatus,
  action: TransferAction,
): TransferEdge {
  const edge = transferEdgesFrom(from).find((e) => e.action === action);
  if (edge) return edge;

  // The one refusal worth explaining rather than merely reporting.
  if (action === 'cancel' && from === 'in_transit') {
    throw new UnprocessableError(
      'This transfer is already in transit — the stock has left the source warehouse, so cancelling ' +
        'it would leave those units in neither warehouse. Receive it at the destination and raise a ' +
        'transfer back.',
      'transfer_in_transit_not_cancellable',
      { context: { from, action } },
    );
  }

  const legal = transferEdgesFrom(from).map((e) => e.action);
  throw new UnprocessableError(
    `A transfer in \`${from}\` cannot be ${action}ed.` +
      (legal.length > 0 ? ` What you can do from here: ${legal.join(', ')}.` : ' It is in a terminal state.'),
    'illegal_transfer_transition',
    { context: { from, action, legal } },
  );
}

/* --------------------------------------------------------- location tree */

/**
 * Depth ranks for `warehouse_locations.kind`.
 *
 * A child must sit STRICTLY deeper than its parent, not exactly one level below:
 * migration 0003 exists precisely so "a studio with one room and a shop with
 * racks are the same shape, just different depth". A zone straight to a bin is a
 * legitimate small warehouse; a shelf under a bin is not a warehouse at all.
 */
export const LOCATION_RANK = { zone: 0, rack: 1, shelf: 2, bin: 3 } as const;
export type LocationKindKey = keyof typeof LOCATION_RANK;

export function assertLocationDepth(parentKind: LocationKindKey | null, childKind: LocationKindKey): void {
  if (parentKind === null) return;
  if (LOCATION_RANK[childKind] > LOCATION_RANK[parentKind]) return;
  throw new UnprocessableError(
    `A \`${childKind}\` cannot sit inside a \`${parentKind}\`. The hierarchy runs zone → rack → shelf → ` +
      'bin; a child may skip levels but never sit at or above its parent.',
    'invalid_location_depth',
    { context: { parentKind, childKind } },
  );
}

/**
 * The materialised path, built from segment codes: `A/R3/S2/B7`.
 *
 * Never client-supplied. It is denormalised so a pick list can render hundreds of
 * rows without a recursive query per line, and the moment a client could set it
 * the denormalisation would stop being derived from anything.
 */
export const buildLocationPath = (parentPath: string | null, code: string): string =>
  parentPath ? `${parentPath}/${code}` : code;

/**
 * Rewrite one path when its ancestor moves.
 *
 * `A/R3/S2/B7` under old prefix `A/R3` and new prefix `B/R9` becomes
 * `B/R9/S2/B7`. Exported for the test — a subtree move that silently keeps the
 * old prefix on grandchildren is invisible until someone walks to the wrong bin.
 */
export function rewriteLocationPath(path: string, oldPrefix: string, newPrefix: string): string {
  if (path === oldPrefix) return newPrefix;
  if (path.startsWith(`${oldPrefix}/`)) return newPrefix + path.slice(oldPrefix.length);
  return path;
}
