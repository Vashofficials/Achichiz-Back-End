/**
 * Customer-facing order contracts.
 *
 * Two audiences, two shapes, deliberately different:
 *
 *  - `orderDetail` is for the authenticated owner. It carries the address, the
 *    money and the line breakdown.
 *  - `orderTracking` is public, proved only by an order number plus a mobile
 *    number, so it carries the minimum a courier tracker needs: where the parcel
 *    is and when it moved. No address, no email, no prices, no line items.
 */

import { z } from 'zod';
import { paginationQuery } from '../../lib/pagination.js';
import { ORDER_STATUSES } from '../../db/schema/index.js';
import { TRACKING_STAGES } from './orders.state.js';
import { MOBILE_IN } from '../checkout/checkout.schemas.js';

export const orderStatus = z
  .enum(ORDER_STATUSES)
  .describe(
    'Operational status, driven by real fulfilment and gateway events — never by elapsed time. ' +
      'Sixteen values; `trackingStage` projects them onto the five the customer UI shows.',
  );

export const orderIdParam = z.object({
  orderId: z.uuid().describe('Order id from `GET /v1/account/orders`.'),
});

export const orderListQuery = paginationQuery.extend({
  status: orderStatus.optional().describe('Filter to a single operational status.'),
});

export const cancelOrderBody = z.object({
  reason: z
    .string()
    .trim()
    .max(400)
    .optional()
    .describe('Why you are cancelling. Stored on the order and shown to ops.'),
});

export const trackOrderQuery = z.object({
  orderNo: z
    .string()
    .trim()
    .regex(/^ACH[0-9]{6,}$/, 'An order number looks like `ACH100042`.')
    .describe('The order number from the confirmation email.'),
  mobile: z
    .string()
    .regex(MOBILE_IN, 'An Indian mobile number is ten digits starting 6-9.')
    .describe('The buyer’s or recipient’s mobile number. Both must match — the number is the shared secret.'),
});

/* -------------------------------------------------------------- responses */

export const orderLineAddOnView = z.object({
  name: z.string().describe('Add-on name as it was when the order was placed.'),
  pricePaise: z.number().int().describe('Price per unit, GST-inclusive, in integer paise.'),
  quantity: z.number().int().describe('Units of the add-on, matching the line quantity.'),
  inputText: z.string().nullable().describe('Text the shopper supplied, or null.'),
});

export const orderLineView = z.object({
  id: z.uuid().describe('Order line id.'),
  variantId: z.uuid().nullable().describe('Variant id, or null for a built hamper.'),
  sku: z.string().describe('SKU snapshot taken at order time. The catalogue may have moved on.'),
  title: z.string().describe('Product title snapshot.'),
  variantLabel: z.string().nullable().describe('Variant label snapshot, e.g. `Signature`.'),
  imageUrl: z.string().nullable().describe('Image URL snapshot.'),
  quantity: z.number().int().describe('Units ordered.'),
  unitPricePaise: z
    .number()
    .int()
    .describe('All-in price per unit at order time (variant plus its add-ons), GST-inclusive, in paise.'),
  allocatedOrderDiscountPaise: z.number().int().describe('This line’s share of the order coupon, in paise.'),
  grossPaise: z.number().int().describe('Line value net of every discount, in paise. These sum to the subtotal.'),
  gstRateBp: z.number().int().describe('GST rate in basis points, frozen at order time. 1800 = 18%.'),
  taxablePaise: z.number().int().describe('Taxable value in paise, back-computed from the inclusive gross.'),
  cgstPaise: z.number().int().describe('CGST in paise.'),
  sgstPaise: z.number().int().describe('SGST in paise.'),
  igstPaise: z.number().int().describe('IGST in paise.'),
  cessPaise: z.number().int().describe('Cess in paise.'),
  fulfilmentStatus: z.string().describe('Per-line fulfilment state — a partial dispatch is representable.'),
  addOns: z.array(orderLineAddOnView).describe('Add-ons on this line, itemised because they are taxed.'),
  personalisation: z.string().nullable().describe('Personalisation instructions as sent to production, or null.'),
});

export const orderTimelineEventView = z.object({
  occurredAt: z.string().describe('ISO-8601 timestamp of the event.'),
  eventType: z.string().describe('Machine event key, e.g. `payment.captured`.'),
  label: z.string().describe('Human label for the event.'),
  note: z.string().nullable().describe('Free-text note, or null.'),
  actorKind: z
    .enum(['customer', 'staff', 'system', 'courier', 'gateway'])
    .describe('Who caused it. Append-only and server-generated; never client-editable.'),
  actorLabel: z.string().nullable().describe('Named actor, e.g. `Razorpay` or `Blue Dart`.'),
});

export const orderSummary = z.object({
  id: z.uuid().describe('Order id.'),
  orderNo: z.string().describe('Human-facing number, e.g. `ACH100042`.'),
  status: orderStatus,
  paymentStatus: z
    .string()
    .describe('Independent of `status`: `pending`, `paid`, `failed`, `partially_refunded`, `refunded`, `cod_due`.'),
  trackingStage: z
    .enum(TRACKING_STAGES)
    .nullable()
    .describe('The five-stage projection for the UI. Null when the order left the happy path.'),
  placedAt: z.string().describe('ISO-8601 timestamp the order was placed.'),
  itemCount: z.number().int().describe('Total units across all lines.'),
  totalPaise: z.number().int().describe('Amount charged, in integer paise.'),
  currency: z.string().describe('ISO-4217 currency code.'),
  deliveryType: z.string().describe('`standard`, `scheduled`, `same_day`, `midnight` or `international`.'),
  requestedDeliveryDate: z.string().nullable().describe('`YYYY-MM-DD` requested date, or null.'),
  canCancel: z.boolean().describe('True while the order is still cancellable by you. The API re-checks it.'),
  thumbnailUrl: z.string().nullable().describe('First line’s image, for the order list.'),
});

export const orderDetail = orderSummary.extend({
  buyerName: z.string().describe('Buyer name, frozen at order time.'),
  buyerEmail: z.string().nullable().describe('Buyer email, frozen at order time.'),
  buyerMobile: z.string().nullable().describe('Buyer mobile, frozen at order time.'),
  recipientName: z.string().nullable().describe('Gift recipient, or null.'),
  recipientMobile: z.string().nullable().describe('Recipient mobile, or null.'),
  giftMessage: z.string().nullable().describe('Gift card message, or null.'),
  isAnonymousGift: z.boolean().describe('True when the recipient is not told who sent it.'),
  shippingAddress: z
    .object({
      line1: z.string().describe('House/flat, building, street.'),
      line2: z.string().nullable().describe('Second address line.'),
      area: z.string().nullable().describe('Locality.'),
      city: z.string().describe('City.'),
      stateCode: z.string().describe('Two-digit GST state code.'),
      pincode: z.string().describe('Six-digit PIN code.'),
      countryCode: z.string().describe('ISO-3166-1 alpha-2 country code.'),
    })
    .describe('The address snapshot. An order is a legal record and its address never mutates.'),
  deliverySlot: z.string().nullable().describe('Requested slot, or null.'),
  couponCode: z.string().nullable().describe('Coupon applied at order time, or null.'),
  subtotalPaise: z.number().int().describe('Σ of line gross values, in paise. Already net of the coupon.'),
  couponDiscountPaise: z.number().int().describe('Coupon value in paise. Informational — do not subtract again.'),
  shippingPaise: z.number().int().describe('Shipping charged, in paise.'),
  codFeePaise: z.number().int().describe('COD handling fee, in paise.'),
  taxablePaise: z.number().int().describe('Order taxable value, in paise.'),
  cgstPaise: z.number().int().describe('CGST, in paise.'),
  sgstPaise: z.number().int().describe('SGST, in paise.'),
  igstPaise: z.number().int().describe('IGST, in paise.'),
  cessPaise: z.number().int().describe('Cess, in paise.'),
  roundOffPaise: z.number().int().describe('Invoice rounding, in paise. Bounded ±50.'),
  amountPaidPaise: z.number().int().describe('Captured so far, in paise.'),
  amountRefundedPaise: z.number().int().describe('Refunded so far, in paise.'),
  isInterstate: z.boolean().describe('True when the supply was interstate, which makes the tax IGST.'),
  cancelReason: z.string().nullable().describe('Why it was cancelled, or null.'),
  cancelledAt: z.string().nullable().describe('ISO-8601 cancellation timestamp, or null.'),
  lines: z.array(orderLineView).describe('Order lines in display order.'),
  timeline: z.array(orderTimelineEventView).describe('Append-only event log, oldest first.'),
});

export const orderTracking = z.object({
  orderNo: z.string().describe('The order number, echoed back.'),
  status: orderStatus,
  currentStage: z
    .enum(TRACKING_STAGES)
    .nullable()
    .describe('The stage the parcel is at now. Null when the order was cancelled, refunded or returned.'),
  statusNote: z
    .string()
    .nullable()
    .describe('Set when the order left the happy path — failed delivery, RTO, cancelled, refunded.'),
  stages: z
    .array(
      z.object({
        id: z.enum(TRACKING_STAGES).describe('Stage key.'),
        label: z.string().describe('Display label.'),
        completedAt: z
          .string()
          .nullable()
          .describe('When this stage actually happened, from the event log. Null means it has not.'),
        note: z.string().nullable().describe('Stage note, or null.'),
      }),
    )
    .describe('The five stages in order, each with a real timestamp or null. Nothing is inferred from a clock.'),
  placedAt: z.string().describe('ISO-8601 timestamp the order was placed.'),
  estimatedDeliveryDate: z.string().nullable().describe('`YYYY-MM-DD` requested/promised date, or null.'),
  deliveredAt: z.string().nullable().describe('ISO-8601 delivery timestamp, or null.'),
  itemCount: z.number().int().describe('Total units in the order.'),
});

export type OrderSummaryResponse = z.infer<typeof orderSummary>;
export type OrderDetailResponse = z.infer<typeof orderDetail>;
export type OrderTrackingResponse = z.infer<typeof orderTracking>;
