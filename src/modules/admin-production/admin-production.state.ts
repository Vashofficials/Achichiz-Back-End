/**
 * The production-order state machine — pure, no I/O.
 *
 * ## The vocabulary is the database's
 *
 * `production_orders` carries `CHECK (status IN
 * ('draft','planned','in_progress','completed','cancelled'))` from migration
 * 0003. Nothing here invents a sixth value; writing one would be a CHECK
 * violation, not a modelling disagreement.
 *
 * ```
 *   draft ──plan──▶ planned ──start──▶ in_progress ──complete──▶ completed
 *     └──────────────────┴──────────────cancel───────────────▶ cancelled
 * ```
 *
 * ## Which edge moves stock, and why only one does
 *
 * **`complete` is the only stock-moving edge.** `start` deliberately moves
 * nothing: a run that has begun has not yet consumed anything the ledger can
 * name, and decrementing components at `start` would make a cancelled run
 * un-unwindable — you would have to invent a reverse movement for materials that
 * may or may not have gone into the pot. Consumption and output happen together,
 * in one transaction, at `complete`.
 *
 * That is also why `cancel` is legal from `in_progress` and needs no
 * compensation: nothing has moved. Contrast `stock_transfers`, where
 * `in_transit` cannot be cancelled precisely because stock HAS moved.
 *
 * ## `plan` has no endpoint of its own
 *
 * The create endpoint decides whether an order starts as `draft` or `planned`,
 * and `POST /start` takes the `plan` edge and the `start` edge together when it
 * finds a draft. Both edges are legal and both are asserted; what is avoided is
 * a `draft` that can only ever be cancelled, which is a document nobody can use.
 * The table stays the faithful one, and the service composes it.
 *
 * An illegal transition is a 422 with a stable code and the list of what IS
 * possible from here — never a silent no-op. A cancel that quietly does nothing
 * is how a warehouse consumes materials for a batch somebody thought they had
 * stopped.
 */

import { UnprocessableError } from '../../lib/errors.js';
import type { ProductionStatus } from '../../db/schema/index.js';

export const PRODUCTION_ACTIONS = ['plan', 'start', 'complete', 'cancel'] as const;
export type ProductionAction = (typeof PRODUCTION_ACTIONS)[number];

export type ProductionEdge = {
  to: ProductionStatus;
  action: ProductionAction;
  label: string;
  /** True when taking this edge writes to `inventory_levels` and `stock_movements`. */
  movesStock: boolean;
  sideEffects?: readonly string[];
};

const cancelEdge: ProductionEdge = {
  to: 'cancelled',
  action: 'cancel',
  label: 'Cancelled',
  movesStock: false,
  sideEffects: ['Nothing to unwind — components are consumed at `complete`, not before'],
};

export const PRODUCTION_TRANSITIONS: Record<ProductionStatus, readonly ProductionEdge[]> = {
  draft: [
    {
      to: 'planned',
      action: 'plan',
      label: 'Planned',
      movesStock: false,
      sideEffects: ['Freezes the component lines — the plan is what the shortfall is measured against'],
    },
    cancelEdge,
  ],
  planned: [
    {
      to: 'in_progress',
      action: 'start',
      label: 'In progress',
      movesStock: false,
      sideEffects: [
        'Stamps `startedAt`',
        'Moves NO stock — components are consumed at completion, in one transaction with the output',
      ],
    },
    cancelEdge,
  ],
  in_progress: [
    {
      to: 'completed',
      action: 'complete',
      label: 'Completed',
      movesStock: true,
      sideEffects: [
        'Decrements every component through the conditional guard',
        'Writes one `raw_material_consumption` movement per component',
        'Increments the output’s `on_hand_qty` at the same warehouse',
        'Writes one `production` movement for the output',
        'Records `consumedQty` per line beside the untouched `plannedQty`',
      ],
    },
    cancelEdge,
  ],
  completed: [],
  cancelled: [],
};

export const productionEdgesFrom = (status: ProductionStatus): readonly ProductionEdge[] =>
  PRODUCTION_TRANSITIONS[status];

/** Lines and header are editable only while nothing has been committed to the floor. */
export const isProductionEditable = (status: ProductionStatus): boolean =>
  status === 'draft' || status === 'planned';

/**
 * Resolve an endpoint's action against the current status.
 *
 * Endpoints are action-named (`/start`, `/complete`), not target-named, so the
 * caller never has to know which status an action lands in — and a status that
 * has no such edge produces a 422 that says what it CAN do instead.
 */
export function assertProductionAction(
  from: ProductionStatus,
  action: ProductionAction,
): ProductionEdge {
  const edge = productionEdgesFrom(from).find((e) => e.action === action);
  if (edge) return edge;

  if (action === 'complete' && (from === 'draft' || from === 'planned')) {
    throw new UnprocessableError(
      'This production order has not been started. Completing it would consume components for a batch ' +
        'nobody has begun. Start it first — POST /v1/admin/production/orders/:productionId/start.',
      'production_not_started',
      { context: { from, action } },
    );
  }

  if (action === 'start' && from === 'completed') {
    throw new UnprocessableError(
      'This production order is already completed. Restarting it would consume the components a second ' +
        'time and produce the output twice. Raise a new order for the next batch.',
      'production_already_completed',
      { context: { from, action } },
    );
  }

  const legal = productionEdgesFrom(from).map((e) => e.action);
  throw new UnprocessableError(
    `A production order in \`${from}\` cannot be ${action === 'plan' ? 'planned' : `${action}${action === 'cancel' ? 'led' : 'd'}`}.` +
      (legal.length > 0
        ? ` What you can do from here: ${legal.join(', ')}.`
        : ' It is in a terminal state.'),
    'illegal_production_transition',
    { context: { from, action, legal } },
  );
}

/**
 * `producedQty + scrappedQty` against `plannedQty`.
 *
 * Producing fewer than planned is normal — that is what `scrappedQty` records.
 * Producing MORE than planned is refused: the components were reserved against
 * the plan, and a run that silently yields 20% extra is either a data-entry slip
 * or a batch that consumed materials nobody accounted for. Both deserve a new
 * order rather than a quiet overwrite.
 */
export function assertOutputWithinPlan(
  plannedQty: number,
  producedQty: number,
  scrappedQty: number,
): void {
  if (producedQty < 0 || scrappedQty < 0) {
    throw new UnprocessableError(
      'Produced and scrapped quantities cannot be negative.',
      'invalid_production_output',
      { context: { plannedQty, producedQty, scrappedQty } },
    );
  }
  if (producedQty + scrappedQty > plannedQty) {
    throw new UnprocessableError(
      `This order planned ${plannedQty} unit(s); you are reporting ${producedQty} produced and ` +
        `${scrappedQty} scrapped, which is ${producedQty + scrappedQty}. A run cannot yield more than it ` +
        'planned for — the components were sized against the plan. Raise a second order for the surplus.',
      'production_exceeds_plan',
      { context: { plannedQty, producedQty, scrappedQty } },
    );
  }
}
