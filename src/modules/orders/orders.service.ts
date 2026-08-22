/**
 * Customer-facing order business rules: list, detail, cancel, public tracking.
 *
 * Cancellation is the only state transition a customer owns, and it is not a
 * status update — it has to give the stock back, return the coupon redemption to
 * the pool, and start a refund if money was actually taken. Doing any subset of
 * those is how you end up with a cancelled order that is still holding the last
 * unit of a SKU.
 */

import { db } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { NotFoundError } from '../../lib/errors.js';
import * as payments from '../payments/payments.service.js';
import * as repo from './orders.repository.js';
import {
  assertCustomerCancellable,
  buildTracking,
  canCustomerCancel,
  cancellationTargetFor,
  trackingStageFor,
} from './orders.state.js';
import type { OrderDetailResponse, OrderSummaryResponse, OrderTrackingResponse } from './orders.schemas.js';
import type { OrderStatus } from '../../db/schema/index.js';

/* ------------------------------------------------------------- projections */

function toSummary(row: repo.OrderListRow): OrderSummaryResponse {
  const o = row.order;
  return {
    id: o.id,
    orderNo: o.orderNo,
    status: o.status,
    paymentStatus: o.paymentStatus,
    trackingStage: trackingStageFor(o.status),
    placedAt: o.placedAt.toISOString(),
    itemCount: row.itemCount,
    totalPaise: o.totalPaise,
    currency: o.currency,
    deliveryType: o.deliveryType,
    requestedDeliveryDate: o.requestedDeliveryDate,
    canCancel: canCustomerCancel(o.status),
    thumbnailUrl: row.thumbnailUrl,
  };
}

/* ------------------------------------------------------------------ reads */

export async function listMyOrders(
  customerId: string,
  query: { page: number; perPage: number; status?: OrderStatus | undefined },
): Promise<{ items: OrderSummaryResponse[]; total: number }> {
  const { rows, total } = await repo.listForCustomer(customerId, {
    limit: query.perPage,
    offset: (query.page - 1) * query.perPage,
    status: query.status,
  });
  return { items: rows.map(toSummary), total };
}

export async function getMyOrder(customerId: string, orderId: string): Promise<OrderDetailResponse> {
  const row = await repo.findForCustomer(customerId, orderId);
  if (!row) throw new NotFoundError('Order', orderId);

  const lines = await repo.findLines(orderId);
  const lineIds = lines.map((l) => l.id);
  const [addOns, personalisations, timeline] = await Promise.all([
    repo.findLineAddOns(lineIds),
    repo.findLinePersonalisations(lineIds),
    repo.findTimeline(orderId),
  ]);

  const addOnsByLine = new Map<string, typeof addOns>();
  for (const addOn of addOns) {
    const bucket = addOnsByLine.get(addOn.orderLineId);
    if (bucket) bucket.push(addOn);
    else addOnsByLine.set(addOn.orderLineId, [addOn]);
  }
  const personalisationByLine = new Map(personalisations.map((p) => [p.orderLineId, p.inputText]));

  const o = row.order;
  return {
    ...toSummary(row),
    buyerName: o.buyerName,
    buyerEmail: o.buyerEmail,
    buyerMobile: o.buyerMobile,
    recipientName: o.recipientName,
    recipientMobile: o.recipientMobile,
    giftMessage: o.giftMessage,
    isAnonymousGift: o.isAnonymousGift,
    shippingAddress: {
      line1: o.shipLine1,
      line2: o.shipLine2,
      area: o.shipArea,
      city: o.shipCity,
      stateCode: o.shipStateCode,
      pincode: o.shipPincode,
      countryCode: o.shipCountryCode,
    },
    deliverySlot: o.deliverySlot,
    couponCode: o.couponCode,
    subtotalPaise: o.subtotalPaise,
    couponDiscountPaise: o.couponDiscountPaise,
    shippingPaise: o.shippingPaise,
    codFeePaise: o.codFeePaise,
    taxablePaise: o.taxablePaise,
    cgstPaise: o.cgstPaise,
    sgstPaise: o.sgstPaise,
    igstPaise: o.igstPaise,
    cessPaise: o.cessPaise,
    roundOffPaise: o.roundOffPaise,
    amountPaidPaise: o.amountPaidPaise,
    amountRefundedPaise: o.amountRefundedPaise,
    isInterstate: o.isInterstate,
    cancelReason: o.cancelReason,
    cancelledAt: o.cancelledAt ? o.cancelledAt.toISOString() : null,
    lines: lines.map((line) => ({
      id: line.id,
      variantId: line.variantId,
      sku: line.skuSnapshot,
      title: line.titleSnapshot,
      variantLabel: line.variantLabelSnapshot,
      imageUrl: line.imageUrlSnapshot,
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      allocatedOrderDiscountPaise: line.allocatedOrderDiscountPaise,
      grossPaise: line.grossPaise,
      gstRateBp: line.gstRateBp,
      taxablePaise: line.taxablePaise,
      cgstPaise: line.cgstPaise,
      sgstPaise: line.sgstPaise,
      igstPaise: line.igstPaise,
      cessPaise: line.cessPaise,
      fulfilmentStatus: line.fulfilmentStatus,
      addOns: (addOnsByLine.get(line.id) ?? []).map((a) => ({
        name: a.nameSnapshot,
        pricePaise: a.pricePaise,
        quantity: a.quantity,
        inputText: a.inputText,
      })),
      personalisation: personalisationByLine.get(line.id) ?? null,
    })),
    timeline: timeline.map((event) => ({
      occurredAt: event.occurredAt.toISOString(),
      eventType: event.eventType,
      label: event.label,
      note: event.note,
      actorKind: event.actorKind,
      actorLabel: event.actorLabel,
    })),
  };
}

export async function trackOrder(orderNo: string, mobile: string): Promise<OrderTrackingResponse> {
  const row = await repo.findForTracking(orderNo, mobile);
  // A wrong mobile and a non-existent order number are the same answer, so this
  // cannot be used to confirm that an order exists.
  if (!row) throw new NotFoundError('Order');

  const events = await repo.findTimeline(row.order.id);
  const tracking = buildTracking(row.order, events);

  return {
    orderNo: row.order.orderNo,
    status: row.order.status,
    currentStage: tracking.currentStage,
    statusNote: tracking.statusNote,
    stages: tracking.stages,
    placedAt: row.order.placedAt.toISOString(),
    estimatedDeliveryDate: row.order.requestedDeliveryDate,
    deliveredAt: row.order.deliveredAt ? row.order.deliveredAt.toISOString() : null,
    itemCount: row.itemCount,
  };
}

/* ----------------------------------------------------------------- cancel */

export async function cancelMyOrder(
  customerId: string,
  orderId: string,
  reason: string | undefined,
): Promise<OrderDetailResponse> {
  const owned = await repo.findForCustomer(customerId, orderId);
  if (!owned) throw new NotFoundError('Order', orderId);

  const cancelReason = reason?.trim() || 'Cancelled by the customer.';

  const outcome = await db.transaction(async (tx) => {
    // Re-read under a lock: the status that was fetched a moment ago may have
    // moved (a webhook capturing payment, ops packing the parcel).
    const order = await repo.lockOrder(tx, orderId);
    if (!order || order.customerId !== customerId) throw new NotFoundError('Order', orderId);

    assertCustomerCancellable(order.status);

    const target = cancellationTargetFor(order.paymentStatus);

    await repo.releaseOrderReservations(tx, order.id);
    await repo.reverseCouponRedemption(tx, order.id, 'Order cancelled by the customer.');

    // Only the status and the cancellation columns change. The money columns are
    // untouched on purpose: the deferred check_order_totals() trigger fires on
    // any UPDATE of them, and a cancelled order must still reconcile against its
    // lines. Zeroing the header without cancelling the lines would fail at COMMIT.
    await repo.updateOrder(tx, order.id, {
      status: target,
      cancelledAt: new Date(),
      cancelReason,
    });

    await repo.insertTimelineEvent(tx, {
      orderId: order.id,
      eventType: 'order.cancelled',
      label: target === 'refund_initiated' ? 'Cancelled — refund initiated' : 'Cancelled',
      note: cancelReason,
      actorKind: 'customer',
    });

    return { target, needsRefund: target === 'refund_initiated', amountPaidPaise: order.amountPaidPaise };
  });

  // Gateway I/O after commit: the cancellation must be durable even if Razorpay
  // is down, and a refund that fails is retried by ops rather than losing the
  // cancellation with it.
  if (outcome.needsRefund && outcome.amountPaidPaise > 0) {
    try {
      await payments.refundOrder({
        orderId,
        amountPaise: outcome.amountPaidPaise,
        reason: 'Order cancelled by the customer.',
      });
    } catch (err) {
      logger.error({ err, orderId }, 'order cancelled but the refund could not be initiated');
    }
  }

  return getMyOrder(customerId, orderId);
}
