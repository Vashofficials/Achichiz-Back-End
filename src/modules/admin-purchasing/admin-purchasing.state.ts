/**
 * The purchase-order and purchase-return state machines — pure, no I/O.
 *
 * ## The PO status vocabulary is the database's
 *
 * `purchase_orders` carries `CHECK (status IN
 * ('draft','sent','partially_received','received','cancelled'))` from migration
 * 0001, and 0003 did not widen it. The seven-stage lifecycle a buyer describes —
 * draft → pending approval → approved → sent → partially received → received →
 * cancelled — has no `approved` column and no `pending_approval` value to write.
 *
 * Writing one would not be a modelling disagreement. It would be a CHECK
 * violation on every approval.
 *
 * So the lifecycle is DERIVED from the two columns that do exist, `status` and
 * `sent_at`:
 *
 * | `status`             | `sent_at` | lifecycle            |
 * |----------------------|-----------|----------------------|
 * | `draft`              | NULL      | `draft`              |
 * | `sent`               | NULL      | `approved`           |
 * | `sent`               | set       | `sent`               |
 * | `partially_received` | set       | `partially_received` |
 * | `received`           | set       | `received`           |
 * | `cancelled`          | any       | `cancelled`          |
 *
 * That gives approval and transmission the two distinct steps they are in real
 * procurement — an approved PO that has not yet gone to the supplier is a normal
 * state, and it is the one where `incoming_qty` must NOT have been raised — while
 * every value written to the column stays legal. The API returns both: `status`
 * is what is stored, `lifecycle` is what it means. `pending_approval` has no
 * encoding and no endpoint produces it; a draft awaiting approval is a `draft`.
 *
 * ## Purchase returns need no such trick
 *
 * `purchase_returns` was created by 0003 with all six spec statuses, so its
 * machine is stored verbatim.
 *
 * ## Both tables share three properties
 *
 *  1. **Legality first.** An edge that does not exist is 422 with a stable code
 *     and the list of what IS possible — never a silent no-op.
 *  2. **Some edges are not staff edges.** A PO does not become
 *     `partially_received` because somebody clicked; it becomes that because a
 *     goods receipt was posted. Those are marked `documentDriven` and there is
 *     deliberately no endpoint for them.
 *  3. **Which edges move stock.** Only purchase-return dispatch does, on these
 *     two machines. GRN moves stock but is a document in its own right, not an
 *     edge on the PO.
 */

import { UnprocessableError } from '../../lib/errors.js';
import type { PurchaseOrderStatus, PurchaseReturnStatus } from '../../db/schema/index.js';

/* ======================================================== purchase orders */

export const PO_LIFECYCLES = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'partially_received',
  'received',
  'cancelled',
] as const;
export type PoLifecycle = (typeof PO_LIFECYCLES)[number];

export const PO_ACTIONS = ['edit', 'approve', 'send', 'receive', 'cancel'] as const;
export type PoAction = (typeof PO_ACTIONS)[number];

export type PoEdge = {
  to: PoLifecycle;
  action: PoAction;
  label: string;
  /** Driven by posting a goods receipt, not by an endpoint on the PO. */
  documentDriven?: boolean;
  sideEffects?: readonly string[];
};

/**
 * `status` + `sent_at` → what the PO actually means.
 *
 * Exported and pure because it is the whole basis of the derivation: if this is
 * wrong, every lifecycle answer in the API is wrong, and it is worth a test that
 * does not need a database.
 */
export function poLifecycle(status: PurchaseOrderStatus, sentAt: Date | null): PoLifecycle {
  if (status === 'sent') return sentAt ? 'sent' : 'approved';
  return status;
}

/** The inverse, for the two edges that write. Everything else patches `status` alone. */
export function poPersistedState(lifecycle: 'approved' | 'sent', now: Date): {
  status: PurchaseOrderStatus;
  sentAt: Date | null;
} {
  return lifecycle === 'approved' ? { status: 'sent', sentAt: null } : { status: 'sent', sentAt: now };
}

const poCancelEdge: PoEdge = {
  to: 'cancelled',
  action: 'cancel',
  label: 'Cancelled',
  sideEffects: ['Releases `incoming_qty` for whatever has not been received yet'],
};

export const PO_TRANSITIONS: Record<PoLifecycle, readonly PoEdge[]> = {
  draft: [
    {
      to: 'approved',
      action: 'approve',
      label: 'Approved',
      sideEffects: ['Freezes the lines — an approved PO is no longer editable'],
    },
    poCancelEdge,
  ],
  // No endpoint produces this today. Declared so the table is total and a future
  // submit-for-approval step has somewhere to land rather than a new branch.
  pending_approval: [
    { to: 'approved', action: 'approve', label: 'Approved' },
    poCancelEdge,
  ],
  approved: [
    {
      to: 'sent',
      action: 'send',
      label: 'Sent to supplier',
      sideEffects: [
        'Stamps `sentAt`',
        'Raises `incoming_qty` at the destination warehouse by the ordered quantity',
      ],
    },
    poCancelEdge,
  ],
  sent: [
    {
      to: 'partially_received',
      action: 'receive',
      label: 'Partially received',
      documentDriven: true,
      sideEffects: ['Posted by a goods receipt, never set by hand'],
    },
    {
      to: 'received',
      action: 'receive',
      label: 'Fully received',
      documentDriven: true,
      sideEffects: ['Posted by a goods receipt, never set by hand'],
    },
    poCancelEdge,
  ],
  partially_received: [
    {
      to: 'received',
      action: 'receive',
      label: 'Fully received',
      documentDriven: true,
      sideEffects: ['Posted by a goods receipt, never set by hand'],
    },
    poCancelEdge,
  ],
  received: [],
  cancelled: [],
};

export const poEdgesFrom = (lifecycle: PoLifecycle): readonly PoEdge[] => PO_TRANSITIONS[lifecycle];

/** Lines and header are only editable while nobody outside the building has seen the document. */
export const isPoEditable = (lifecycle: PoLifecycle): boolean =>
  lifecycle === 'draft' || lifecycle === 'pending_approval';

/** A goods receipt may only be posted against a PO the supplier has actually been sent. */
export const isPoReceivable = (lifecycle: PoLifecycle): boolean =>
  lifecycle === 'sent' || lifecycle === 'partially_received';

export function assertPoAction(from: PoLifecycle, action: PoAction): PoEdge {
  const edge = poEdgesFrom(from).find((e) => e.action === action);

  if (edge && edge.documentDriven) {
    throw new UnprocessableError(
      `A purchase order becomes \`${edge.to}\` when a goods receipt is posted against it, not by hand. ` +
        'Post the GRN through POST /v1/admin/purchasing/goods-receipts and the status follows from what ' +
        'was actually received.',
      'document_driven_transition',
      { context: { from, action, to: edge.to } },
    );
  }
  if (edge) return edge;

  if (action === 'send' && from === 'draft') {
    throw new UnprocessableError(
      'This purchase order has not been approved yet. Approve it first — sending is what puts it in ' +
        'front of the supplier, and `incoming_qty` is raised at that moment.',
      'po_not_approved',
      { context: { from, action } },
    );
  }

  const legal = poEdgesFrom(from)
    .filter((e) => !e.documentDriven)
    .map((e) => e.action);
  throw new UnprocessableError(
    `A purchase order in \`${from}\` cannot be ${action === 'edit' ? 'edited' : `${action}ed`}.` +
      (legal.length > 0 ? ` What you can do from here: ${legal.join(', ')}.` : ' It is in a terminal state.'),
    'illegal_po_transition',
    { context: { from, action, legal } },
  );
}

/**
 * What a goods receipt leaves the PO in.
 *
 * `partially_received` until ordered == received across ALL lines — not per
 * line, and not counting rejected units. Rejected goods are going back to the
 * supplier; treating them as received would close a PO that is still owed stock.
 */
export function poStatusAfterReceipt(
  lines: readonly { orderedQty: number; receivedQty: number }[],
): Extract<PurchaseOrderStatus, 'partially_received' | 'received'> {
  const ordered = lines.reduce((sum, l) => sum + l.orderedQty, 0);
  const received = lines.reduce((sum, l) => sum + l.receivedQty, 0);
  return received >= ordered ? 'received' : 'partially_received';
}

/* ======================================================= purchase returns */

export const RETURN_ACTIONS = ['approve', 'dispatch', 'complete', 'cancel'] as const;
export type ReturnAction = (typeof RETURN_ACTIONS)[number];

export type ReturnEdge = {
  to: PurchaseReturnStatus;
  action: ReturnAction;
  label: string;
  movesStock: boolean;
  sideEffects?: readonly string[];
};

const returnCancelEdge: ReturnEdge = {
  to: 'cancelled',
  action: 'cancel',
  label: 'Cancelled',
  movesStock: false,
};

export const RETURN_TRANSITIONS: Record<PurchaseReturnStatus, readonly ReturnEdge[]> = {
  draft: [
    { to: 'approved', action: 'approve', label: 'Approved', movesStock: false },
    returnCancelEdge,
  ],
  pending_approval: [
    { to: 'approved', action: 'approve', label: 'Approved', movesStock: false },
    returnCancelEdge,
  ],
  approved: [
    {
      to: 'dispatched',
      action: 'dispatch',
      label: 'Dispatched to supplier',
      movesStock: true,
      sideEffects: [
        'Decrements on-hand at the warehouse',
        'Writes one `outbound` movement per line, referenced to `purchase_return`',
      ],
    },
    returnCancelEdge,
  ],
  // No endpoint yet — settlement is the supplier's credit note, which is a
  // finance step rather than a warehouse one. Declared so the table is total.
  dispatched: [
    {
      to: 'completed',
      action: 'complete',
      label: 'Completed',
      movesStock: false,
      sideEffects: ['Awaits the supplier’s credit note'],
    },
  ],
  completed: [],
  cancelled: [],
};

export const returnEdgesFrom = (status: PurchaseReturnStatus): readonly ReturnEdge[] =>
  RETURN_TRANSITIONS[status];

export function assertReturnAction(from: PurchaseReturnStatus, action: ReturnAction): ReturnEdge {
  const edge = returnEdgesFrom(from).find((e) => e.action === action);
  if (edge) return edge;

  if (action === 'cancel' && from === 'dispatched') {
    throw new UnprocessableError(
      'This return has already been dispatched — the stock has left the warehouse. Cancelling it would ' +
        'leave those units on no document and in no warehouse. Raise a goods receipt if the supplier ' +
        'sends them back.',
      'return_dispatched_not_cancellable',
      { context: { from, action } },
    );
  }

  const legal = returnEdgesFrom(from).map((e) => e.action);
  throw new UnprocessableError(
    `A purchase return in \`${from}\` cannot be ${action}${action === 'dispatch' ? 'ed' : 'd'}.` +
      (legal.length > 0 ? ` What you can do from here: ${legal.join(', ')}.` : ' It is in a terminal state.'),
    'illegal_return_transition',
    { context: { from, action, legal } },
  );
}
