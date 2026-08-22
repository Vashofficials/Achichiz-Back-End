/**
 * The STAFF half of the order state machine — pure, no I/O.
 *
 * `modules/orders/orders.state.ts` owns the customer's single transition
 * (cancel, pre-shipment) and the five-stage display projection. This file adds
 * the other fifteen (02_admin_api.md §4.3) and does not restate any of it: the
 * cancellable set and the "a paid order cancels to `refund_initiated`, never to
 * `cancelled`" rule are imported, because two copies of that rule is how a
 * customer gets told their money is back before it is.
 *
 * Three things a transition table has to encode, and all three are here:
 *
 *  1. **Legality.** Sixteen statuses is not a line — `out_for_delivery` can go
 *     forward to `delivered` or sideways to `failed_delivery`, and
 *     `failed_delivery` can go back. Anything not listed is a 422.
 *  2. **Who.** Each edge names the RBAC action it needs. `refund` appears on
 *     exactly one edge and, across the eleven roles, only Finance Manager and
 *     Super Admin hold it — which is the whole reason a Catalogue Manager cannot
 *     issue a refund through the API and not merely through the UI.
 *  3. **Who is not staff at all.** Six edges are `system` — a courier scan, a
 *     gateway webhook. Staff must not be able to declare a parcel delivered or a
 *     refund settled; those are facts reported by someone else, and forging them
 *     desynchronises the ledger from reality.
 */

import { ForbiddenError, UnprocessableError } from '../../lib/errors.js';
import { permissionKey, type Action } from '../../lib/rbac-matrix.js';
import { cancellationTargetFor } from '../orders/orders.state.js';
import type { OrderStatus } from '../../db/schema/index.js';

export type TransitionEdge = {
  to: OrderStatus;
  /** The RBAC action on `orders` a staff member needs. Absent means system-only. */
  action?: Action;
  /** Not reachable from the API at all — a courier or gateway event drives it. */
  systemOnly?: boolean;
  label: string;
  /** The timeline `event_type` written when it happens. */
  eventType: string;
  /** Documented so the console can warn before the click. */
  sideEffects?: readonly string[];
};

/** Pre-shipment statuses. Ops may cancel from any of them. */
const PRE_SHIPMENT: readonly OrderStatus[] = [
  'pending_payment',
  'paid',
  'confirmed',
  'in_production',
  'personalisation_pending',
  'quality_check',
  'packed',
  'ready_to_ship',
];

const cancelEdge: TransitionEdge = {
  to: 'cancelled',
  action: 'cancel',
  label: 'Cancelled',
  eventType: 'order.cancelled',
  sideEffects: ['Releases the stock reservation', 'Returns the coupon redemption to the pool'],
};

const refundEdge: TransitionEdge = {
  to: 'refund_initiated',
  action: 'refund',
  label: 'Refund initiated',
  eventType: 'refund.initiated',
  sideEffects: ['Calls the payment gateway', 'Only the gateway’s confirmation moves it to `refunded`'],
};

/**
 * The table. Keyed by the status you are in.
 *
 * `cancelled` and `refunded` have no outgoing edges: they are terminal, and a
 * "reopen" that looked like a status flip would leave released stock and a
 * reversed coupon behind it.
 */
export const STAFF_TRANSITIONS: Record<OrderStatus, readonly TransitionEdge[]> = {
  pending_payment: [
    { to: 'paid', systemOnly: true, label: 'Payment captured', eventType: 'payment.captured' },
    cancelEdge,
  ],
  paid: [
    {
      to: 'confirmed',
      action: 'edit',
      label: 'Confirmed',
      eventType: 'order.confirmed',
      sideEffects: ['Makes the order eligible for invoice generation'],
    },
    cancelEdge,
    refundEdge,
  ],
  confirmed: [
    { to: 'in_production', action: 'edit', label: 'In production', eventType: 'order.in_production' },
    {
      to: 'personalisation_pending',
      action: 'edit',
      label: 'Awaiting personalisation',
      eventType: 'order.personalisation_pending',
      sideEffects: ['Only meaningful when a line carries personalisation instructions'],
    },
    cancelEdge,
    refundEdge,
  ],
  in_production: [
    {
      to: 'personalisation_pending',
      action: 'edit',
      label: 'Awaiting personalisation',
      eventType: 'order.personalisation_pending',
    },
    { to: 'quality_check', action: 'edit', label: 'In quality check', eventType: 'order.quality_check' },
    cancelEdge,
  ],
  personalisation_pending: [
    { to: 'quality_check', action: 'edit', label: 'In quality check', eventType: 'order.quality_check' },
    { to: 'in_production', action: 'edit', label: 'Back to production', eventType: 'order.in_production' },
    cancelEdge,
  ],
  quality_check: [
    { to: 'packed', action: 'edit', label: 'Packed', eventType: 'order.packed' },
    {
      to: 'in_production',
      action: 'edit',
      label: 'Failed QC — back to production',
      eventType: 'order.in_production',
    },
    cancelEdge,
  ],
  packed: [
    {
      to: 'ready_to_ship',
      action: 'edit',
      label: 'Ready to ship',
      eventType: 'order.ready_to_ship',
      sideEffects: ['Shipping label and manifest are generated'],
    },
    cancelEdge,
  ],
  ready_to_ship: [
    {
      to: 'shipped',
      action: 'edit',
      label: 'Shipped',
      eventType: 'order.shipped',
      sideEffects: ['Courier assignment is final and the AWB is locked', 'Customer is notified with tracking'],
    },
    cancelEdge,
  ],
  // From here the parcel is with a courier and the facts come from its scans.
  shipped: [
    { to: 'out_for_delivery', systemOnly: true, label: 'Out for delivery', eventType: 'shipment.out_for_delivery' },
    { to: 'rto', action: 'edit', label: 'Return to origin', eventType: 'order.rto' },
  ],
  out_for_delivery: [
    { to: 'delivered', systemOnly: true, label: 'Delivered', eventType: 'shipment.delivered' },
    { to: 'failed_delivery', systemOnly: true, label: 'Delivery failed', eventType: 'shipment.failed' },
  ],
  delivered: [refundEdge],
  failed_delivery: [
    {
      to: 'out_for_delivery',
      action: 'edit',
      label: 'Reattempt scheduled',
      eventType: 'shipment.reattempt_scheduled',
    },
    {
      to: 'rto',
      action: 'edit',
      label: 'Return to origin',
      eventType: 'order.rto',
      sideEffects: ['Triggers return-to-origin inventory reconciliation'],
    },
  ],
  rto: [refundEdge],
  cancelled: [],
  refund_initiated: [
    { to: 'refunded', systemOnly: true, label: 'Refund settled', eventType: 'refund.processed' },
  ],
  refunded: [],
};

export const edgesFrom = (status: OrderStatus): readonly TransitionEdge[] => STAFF_TRANSITIONS[status];

/** What a given staff member may actually click from here. */
export const staffEdgesFrom = (
  status: OrderStatus,
  permissions: ReadonlySet<string>,
): TransitionEdge[] =>
  edgesFrom(status).filter(
    (edge) => !edge.systemOnly && edge.action && permissions.has(permissionKey('orders', edge.action)),
  );

export const canStaffCancel = (status: OrderStatus): boolean =>
  PRE_SHIPMENT.includes(status);

/**
 * Legality first, then authorisation.
 *
 * The order matters: an illegal transition is 422 for everyone, including a
 * Super Admin, and telling a Catalogue Manager "you may not" about an edge that
 * does not exist would send them looking for the permission rather than at the
 * order.
 */
export function assertStaffTransition(
  from: OrderStatus,
  to: OrderStatus,
  permissions: ReadonlySet<string>,
  role: string,
): TransitionEdge {
  const edge = edgesFrom(from).find((e) => e.to === to);

  if (!edge) {
    const legal = edgesFrom(from)
      .map((e) => e.to)
      .join(', ');
    throw new UnprocessableError(
      `An order in \`${from}\` cannot move to \`${to}\`.` +
        (legal ? ` Legal next states: ${legal}.` : ' It is in a terminal state.'),
      'illegal_transition',
      { context: { from, to, legal } },
    );
  }

  if (edge.systemOnly || !edge.action) {
    throw new UnprocessableError(
      `\`${to}\` is reported by a courier or the payment gateway, not set by hand. ` +
        'Forging it would put the ledger out of step with reality.',
      'system_driven_transition',
      { context: { from, to } },
    );
  }

  const required = permissionKey('orders', edge.action);
  if (!permissions.has(required)) {
    throw new ForbiddenError(
      `Your role (${role}) does not have permission to ${edge.action} orders, which “${edge.label}” requires.`,
      { context: { required, role, from, to } },
    );
  }

  return edge;
}

/**
 * Where a staff cancellation lands.
 *
 * Re-exported through `orders.state.ts`'s rule rather than restated: a paid
 * order becomes `refund_initiated`, and only the gateway's confirmation makes it
 * `refunded`.
 */
export const staffCancellationTarget = cancellationTargetFor;

export function assertStaffCancellable(status: OrderStatus): void {
  if (canStaffCancel(status)) return;
  throw new UnprocessableError(
    `An order in \`${status}\` can no longer be cancelled — once a courier has it, cancelling is a ` +
      'return-to-origin, which is an operations decision with a cost attached. Use the RTO transition ' +
      'or raise a return.',
    'order_not_cancellable',
    { context: { status } },
  );
}
