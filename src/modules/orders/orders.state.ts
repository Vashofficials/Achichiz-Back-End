/**
 * The order state machine, as far as a CUSTOMER is concerned — pure, no I/O.
 *
 * The admin owns fifteen of the sixteen transitions (02_admin_api.md §4.3). A
 * customer owns exactly one: cancel, and only from a state where nothing has
 * left the building. Everything else a shopper sees is a *projection* of the
 * operational status onto five display stages.
 *
 * What this file deliberately does NOT do is derive a status from elapsed time.
 * The storefront computes "shipped" from `<60 hours since placedAt`
 * (`store/src/lib/account.ts:141-149`) and the tracking page hardcodes
 * `activeIndex = 3` regardless of input (`track-order.tsx:26-28`). A stage is
 * complete here only when a real event says so.
 */

import { UnprocessableError } from '../../lib/errors.js';
import type { OrderStatus } from '../../db/schema/index.js';

/**
 * Cancellable by the customer: every pre-`shipped` state.
 *
 * Once a parcel is with a courier, cancellation stops being a database update
 * and becomes an RTO, which is an operations decision with a cost attached.
 */
export const CUSTOMER_CANCELLABLE_STATUSES = [
  'pending_payment',
  'paid',
  'confirmed',
  'in_production',
  'personalisation_pending',
  'quality_check',
  'packed',
  'ready_to_ship',
] as const satisfies readonly OrderStatus[];

export type CustomerCancellableStatus = (typeof CUSTOMER_CANCELLABLE_STATUSES)[number];

export const canCustomerCancel = (status: OrderStatus): status is CustomerCancellableStatus =>
  (CUSTOMER_CANCELLABLE_STATUSES as readonly string[]).includes(status);

/** Human wording for the states a customer is refused from, so the 422 is useful. */
const REFUSAL_REASON: Partial<Record<OrderStatus, string>> = {
  shipped: 'It has already been handed to the courier — contact support to arrange a return instead.',
  out_for_delivery: 'It is out for delivery today — refuse the parcel or start a return once it arrives.',
  delivered: 'It has already been delivered. Start a return within the returns window instead.',
  failed_delivery: 'Delivery has already been attempted. Support can arrange a return to origin.',
  rto: 'It is already on its way back to us.',
  cancelled: 'It is already cancelled.',
  refund_initiated: 'A refund is already in progress.',
  refunded: 'It has already been refunded.',
};

export function assertCustomerCancellable(status: OrderStatus): void {
  if (canCustomerCancel(status)) return;
  throw new UnprocessableError(
    `This order can no longer be cancelled. ${REFUSAL_REASON[status] ?? ''}`.trim(),
    'order_not_cancellable',
    { context: { status } },
  );
}

/**
 * Where a cancellation lands.
 *
 * A paid order does not become `cancelled` — it becomes `refund_initiated`, and
 * only the gateway's confirmation moves it to `refunded` (02_admin_api.md §4.3).
 * Skipping that step would tell a customer their money is back before it is.
 */
export const cancellationTargetFor = (paymentStatus: string): OrderStatus =>
  paymentStatus === 'paid' || paymentStatus === 'partially_refunded' ? 'refund_initiated' : 'cancelled';

/* ------------------------------------------------------ display projection */

export const TRACKING_STAGES = ['placed', 'packed', 'shipped', 'out_for_delivery', 'delivered'] as const;
export type TrackingStage = (typeof TRACKING_STAGES)[number];

export const TRACKING_STAGE_LABELS: Record<TrackingStage, string> = {
  placed: 'Order placed',
  packed: 'Packed',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};

/** Statuses that are not on the happy path at all. A tracker shows these as their own note. */
export const OFF_TRACK_STATUSES: Partial<Record<OrderStatus, string>> = {
  failed_delivery: 'Delivery attempt failed. We will try again.',
  rto: 'On its way back to us.',
  cancelled: 'Cancelled.',
  refund_initiated: 'Cancelled — refund in progress.',
  refunded: 'Refunded.',
};

const STAGE_FOR_STATUS: Record<OrderStatus, TrackingStage | null> = {
  pending_payment: 'placed',
  paid: 'placed',
  confirmed: 'placed',
  in_production: 'placed',
  personalisation_pending: 'placed',
  quality_check: 'placed',
  packed: 'packed',
  ready_to_ship: 'packed',
  shipped: 'shipped',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  failed_delivery: 'out_for_delivery',
  rto: null,
  cancelled: null,
  refund_initiated: null,
  refunded: null,
};

export const trackingStageFor = (status: OrderStatus): TrackingStage | null => STAGE_FOR_STATUS[status];

/** Timeline event types that prove a stage happened. Anything else is decoration. */
const STAGE_FOR_EVENT: Record<string, TrackingStage> = {
  'order.placed': 'placed',
  'order.confirmed': 'placed',
  'payment.captured': 'placed',
  'order.packed': 'packed',
  'order.ready_to_ship': 'packed',
  'order.shipped': 'shipped',
  'shipment.dispatched': 'shipped',
  'order.out_for_delivery': 'out_for_delivery',
  'shipment.out_for_delivery': 'out_for_delivery',
  'order.delivered': 'delivered',
  'shipment.delivered': 'delivered',
};

export type TrackingEventInput = { eventType: string; occurredAt: Date; note?: string | null };

export type TrackingStageView = {
  id: TrackingStage;
  label: string;
  completedAt: string | null;
  note: string | null;
};

/**
 * Builds the tracker.
 *
 * `completedAt` is the earliest genuine event for that stage, falling back to the
 * order's own timestamp columns. A stage with neither is `null` — an honest
 * "not yet", rather than a date invented from the clock.
 */
export function buildTracking(
  order: {
    status: OrderStatus;
    placedAt: Date;
    confirmedAt: Date | null;
    shippedAt: Date | null;
    deliveredAt: Date | null;
  },
  events: readonly TrackingEventInput[],
): { stages: TrackingStageView[]; currentStage: TrackingStage | null; statusNote: string | null } {
  const earliest = new Map<TrackingStage, Date>();
  for (const event of events) {
    const stage = STAGE_FOR_EVENT[event.eventType];
    if (!stage) continue;
    const existing = earliest.get(stage);
    if (!existing || event.occurredAt < existing) earliest.set(stage, event.occurredAt);
  }

  const fallback: Record<TrackingStage, Date | null> = {
    placed: order.placedAt,
    packed: null,
    shipped: order.shippedAt,
    out_for_delivery: null,
    delivered: order.deliveredAt,
  };

  const stages = TRACKING_STAGES.map<TrackingStageView>((id) => {
    const at = earliest.get(id) ?? fallback[id];
    return {
      id,
      label: TRACKING_STAGE_LABELS[id],
      completedAt: at ? at.toISOString() : null,
      note: null,
    };
  });

  return {
    stages,
    currentStage: trackingStageFor(order.status),
    statusNote: OFF_TRACK_STATUSES[order.status] ?? null,
  };
}
