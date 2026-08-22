/**
 * Order-desk contracts.
 *
 * `orders` is the sixtieth resource and the one the generic engine deliberately
 * does not serve: it needs a KPI header, a six-filter set, nested lines,
 * payments, shipments and an append-only timeline, and its writes are state
 * transitions rather than column patches.
 */

import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import {
  ORDER_CHANNELS,
  ORDER_DELIVERY_TYPES,
  ORDER_PAYMENT_STATUSES,
  ORDER_PRIORITIES,
  ORDER_STATUSES,
} from '../../db/schema/index.js';

export const orderStatus = z
  .enum(ORDER_STATUSES)
  .describe('The sixteen-value operational status. Driven by real events, never by elapsed time.');

export const adminOrderIdParam = z.object({
  orderId: z.uuid().describe('Order id.'),
});

/* --------------------------------------------------------------- queries */

export const adminOrderListQuery = listQuery.extend({
  sort: z
    .string()
    .max(120)
    .optional()
    .describe('`-placedAt` (default), `placedAt`, `orderNo`, `totalPaise`, `status`, `priority`, `requestedDeliveryDate`.'),
  status: z
    .string()
    .max(400)
    .optional()
    .describe('One status or a comma-separated list: `?status=packed,ready_to_ship`.'),
  paymentStatus: z.string().max(200).optional().describe('One or a comma-separated list.'),
  channel: z.string().max(200).optional().describe('One or a comma-separated list.'),
  deliveryType: z.string().max(200).optional().describe('One or a comma-separated list.'),
  priority: z.string().max(80).optional().describe('`standard`, `high`, `vip`, or a list.'),
  warehouseId: z.uuid().optional().describe('Fulfilment warehouse.'),
  corporateAccountId: z.uuid().optional().describe('Restrict to one corporate account.'),
  placedFrom: z.string().optional().describe('ISO date or timestamp. Inclusive lower bound on `placedAt`.'),
  placedTo: z.string().optional().describe('ISO date or timestamp. Inclusive upper bound on `placedAt`.'),
  deliveryFrom: z.string().optional().describe('`YYYY-MM-DD`. Lower bound on the requested delivery date.'),
  deliveryTo: z.string().optional().describe('`YYYY-MM-DD`. Upper bound on the requested delivery date.'),
  tag: z.string().max(40).optional().describe('One order tag, e.g. `corporate`, `fragile`, `high-value`.'),
});

/* ---------------------------------------------------------------- bodies */

export const transitionBody = z.object({
  status: orderStatus.describe('The status to move to. Must be a legal edge from the current one.'),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe('Free text appended to the timeline entry. Visible to staff, not to the customer.'),
  courierId: z
    .uuid()
    .optional()
    .describe('Required when moving to `shipped` if no shipment has a courier yet — the AWB is locked at that point.'),
  awb: z.string().trim().max(64).optional().describe('Air waybill, when moving to `shipped`.'),
});

export const cancelBody = z.object({
  reason: z
    .string()
    .trim()
    .min(3)
    .max(400)
    .describe('Why. Required — the database refuses a cancellation with no reason, and ops needs it.'),
  refund: z
    .boolean()
    .default(true)
    .describe(
      'Start a gateway refund when money was actually captured. Setting false leaves the order in ' +
        '`refund_initiated` for Finance to settle by hand.',
    ),
});

export const refundBody = z.object({
  amountPaise: z
    .number()
    .int()
    .positive()
    .describe('How much to refund, in integer paise. Cannot exceed captured minus already refunded.'),
  reason: z.string().trim().min(3).max(400).describe('Recorded on the refund row and the timeline.'),
});

export const noteBody = z.object({
  note: z.string().trim().min(1).max(2_000).describe('Internal note. Appended to the timeline, never shown to the customer.'),
});

export const ORDER_BULK_ACTIONS = [
  'mark_packed',
  'mark_ready_to_ship',
  'generate_invoices',
  'assign_courier',
  'cancel',
] as const;

export const orderBulkBody = z.object({
  action: z
    .enum(ORDER_BULK_ACTIONS)
    .describe(
      '`mark_packed` and `mark_ready_to_ship` are state transitions and obey the machine per order. ' +
        '`generate_invoices` issues a GST invoice from the frozen tax columns, once per order. ' +
        '`assign_courier` needs `courierId`. `cancel` needs `reason` and requires `orders:cancel`.',
    ),
  orderIds: z.array(z.uuid()).min(1).max(100).describe('Order ids. At most 100 per call.'),
  courierId: z.uuid().optional().describe('Required for `assign_courier`.'),
  reason: z.string().trim().min(3).max(400).optional().describe('Required for `cancel`.'),
});

/* -------------------------------------------------------------- responses */

export const adminOrderSummary = z.object({
  id: z.uuid().describe('Order id.'),
  orderNo: z.string().describe('`ACH100042`.'),
  status: orderStatus,
  paymentStatus: z.enum(ORDER_PAYMENT_STATUSES).describe('Tracked independently of `status`.'),
  fulfilmentStatus: z.string().describe('`unfulfilled`, `partially_fulfilled`, `fulfilled`, `returned`.'),
  channel: z.enum(ORDER_CHANNELS).describe('Where it came from.'),
  priority: z.enum(ORDER_PRIORITIES).describe('`standard`, `high`, `vip`.'),
  deliveryType: z.enum(ORDER_DELIVERY_TYPES).describe('A routing property, not a lifecycle stage.'),
  buyerName: z.string().describe('Buyer, frozen at order time.'),
  buyerMobile: z.string().nullable().describe('Buyer mobile.'),
  recipientName: z.string().nullable().describe('Gift recipient, when different.'),
  shipCity: z.string().describe('Destination city.'),
  shipPincode: z.string().describe('Destination PIN code.'),
  totalPaise: z.number().int().describe('Order total in integer paise.'),
  amountPaidPaise: z.number().int().describe('Captured so far, in paise.'),
  amountRefundedPaise: z.number().int().describe('Refunded so far, in paise.'),
  itemCount: z.number().int().describe('Total units.'),
  lineCount: z.number().int().describe('Distinct lines.'),
  awb: z.string().nullable().describe('Most recent air waybill, or null.'),
  courierName: z.string().nullable().describe('Most recent courier, or null.'),
  warehouseId: z.uuid().nullable().describe('Fulfilment warehouse.'),
  corporateAccountId: z.uuid().nullable().describe('Corporate account, when this is a B2B order.'),
  tags: z.array(z.string()).describe('`gift-message`, `personalised`, `fragile`, `high-value`, `corporate`.'),
  placedAt: z.string().describe('ISO-8601.'),
  requestedDeliveryDate: z.string().nullable().describe('`YYYY-MM-DD`, or null.'),
  deliverySlot: z.string().nullable().describe('Requested slot, or null.'),
});

export const adminOrderKpis = z.object({
  orderCount: z.number().int().describe('Orders matching the CURRENT filters — not just this page.'),
  grossValuePaise: z.number().int().describe('Sum of `totalPaise` across the filtered set, in paise.'),
  deliveredCount: z.number().int().describe('How many are delivered.'),
  inFulfilmentCount: z.number().int().describe('Paid through ready-to-ship.'),
  openExceptionCount: z.number().int().describe('Failed delivery or RTO.'),
});

const timelineEvent = z.object({
  occurredAt: z.string().describe('ISO-8601.'),
  eventType: z.string().describe('`order.packed`, `payment.captured`, …'),
  label: z.string().describe('Human label.'),
  note: z.string().nullable().describe('Free text, or null.'),
  actorKind: z.string().describe('`customer`, `staff`, `system`, `courier`, `gateway`.'),
  actorStaffId: z.uuid().nullable().describe('Which staff member, when `actorKind` is `staff`.'),
  actorLabel: z.string().nullable().describe('`Razorpay`, `Blue Dart`, …'),
  metadata: z.unknown().nullable().describe('Structured payload for the event.'),
});

const orderLineView = z.object({
  id: z.uuid().describe('Line id.'),
  variantId: z.uuid().nullable().describe('Variant, or null for a built hamper.'),
  sku: z.string().describe('SKU snapshot.'),
  title: z.string().describe('Title snapshot.'),
  variantLabel: z.string().nullable().describe('Variant label snapshot.'),
  imageUrl: z.string().nullable().describe('Image snapshot.'),
  hsnCode: z.string().nullable().describe('HSN snapshot — this is what the invoice line carries.'),
  quantity: z.number().int().describe('Units ordered.'),
  fulfilledQty: z.number().int().describe('Units dispatched.'),
  returnedQty: z.number().int().describe('Units returned.'),
  unitPricePaise: z.number().int().describe('GST-inclusive unit price, in paise.'),
  lineDiscountPaise: z.number().int().describe('Line-level discount, in paise.'),
  allocatedOrderDiscountPaise: z.number().int().describe('Share of the order coupon, in paise.'),
  grossPaise: z.number().int().describe('Line value net of discounts. These sum to the subtotal.'),
  gstRateBp: z.number().int().describe('GST rate in basis points, frozen at order time.'),
  taxablePaise: z.number().int().describe('Taxable value, in paise.'),
  cgstPaise: z.number().int().describe('CGST, in paise.'),
  sgstPaise: z.number().int().describe('SGST, in paise.'),
  igstPaise: z.number().int().describe('IGST, in paise.'),
  cessPaise: z.number().int().describe('Cess, in paise.'),
  fulfilmentStatus: z.string().describe('Per-line status — a partial dispatch is representable.'),
  addOns: z
    .array(
      z.object({
        name: z.string().describe('Add-on name snapshot.'),
        pricePaise: z.number().int().describe('Unit price, in paise.'),
        quantity: z.number().int().describe('Units.'),
        inputText: z.string().nullable().describe('Text the shopper supplied.'),
      }),
    )
    .describe('Add-ons are lines, not scalar columns, because they are taxed.'),
  personalisation: z.string().nullable().describe('Instructions as sent to production.'),
});

export const availableTransition = z.object({
  to: orderStatus.describe('Target status.'),
  label: z.string().describe('Button label.'),
  action: z.string().describe('The RBAC action on `orders` it needs.'),
  allowed: z.boolean().describe('Whether YOUR role may take it. False renders the button disabled.'),
  systemOnly: z
    .boolean()
    .describe('True for edges only a courier scan or a gateway webhook may take. Never clickable.'),
  sideEffects: z.array(z.string()).describe('What else happens. Show this before the click.'),
});

export const adminOrderDetail = adminOrderSummary.extend({
  currency: z.string().describe('ISO-4217.'),
  buyerEmail: z.string().nullable().describe('Buyer email.'),
  recipientMobile: z.string().nullable().describe('Recipient mobile.'),
  isAnonymousGift: z.boolean().describe('True when the recipient is not told who sent it.'),
  giftMessage: z.string().nullable().describe('Gift card message.'),
  shippingAddress: z
    .object({
      line1: z.string().describe('House/flat, building, street.'),
      line2: z.string().nullable().describe('Second line.'),
      area: z.string().nullable().describe('Locality.'),
      city: z.string().describe('City.'),
      stateCode: z.string().describe('Two-digit GST state code.'),
      pincode: z.string().describe('Six-digit PIN code.'),
      countryCode: z.string().describe('ISO-3166-1 alpha-2.'),
    })
    .describe('Frozen snapshot. An order is a legal record; its address does not mutate.'),
  billing: z
    .object({
      sameAsShipping: z.boolean().describe('True when no separate billing address was given.'),
      name: z.string().nullable().describe('Billed to.'),
      line1: z.string().nullable().describe('Billing address.'),
      city: z.string().nullable().describe('Billing city.'),
      stateCode: z.string().nullable().describe('Billing state code.'),
      pincode: z.string().nullable().describe('Billing PIN code.'),
      gstin: z.string().nullable().describe('Buyer GSTIN, for input tax credit.'),
    })
    .describe('Billing snapshot.'),
  tax: z
    .object({
      placeOfSupplyStateCode: z.string().describe('Frozen at order time.'),
      supplierGstin: z.string().nullable().describe('Which registration supplied it.'),
      isInterstate: z.boolean().describe('True makes the tax IGST rather than CGST+SGST.'),
      isExport: z.boolean().describe('Zero-rated supply.'),
    })
    .describe('Tax determination, frozen — the state codes are themselves snapshots.'),
  money: z
    .object({
      subtotalPaise: z.number().int().describe('Σ of line gross values.'),
      couponDiscountPaise: z.number().int().describe('Informational rollup — do NOT subtract it again.'),
      autoDiscountPaise: z.number().int().describe('Automatic discounts rollup.'),
      loyaltyDiscountPaise: z.number().int().describe('Loyalty redemption rollup.'),
      shippingPaise: z.number().int().describe('Shipping charged.'),
      codFeePaise: z.number().int().describe('COD handling fee.'),
      taxablePaise: z.number().int().describe('Order taxable value.'),
      cgstPaise: z.number().int().describe('CGST.'),
      sgstPaise: z.number().int().describe('SGST.'),
      igstPaise: z.number().int().describe('IGST.'),
      cessPaise: z.number().int().describe('Cess.'),
      roundOffPaise: z.number().int().describe('Invoice rounding, bounded ±50.'),
      totalPaise: z.number().int().describe('What was charged.'),
      refundablePaise: z.number().int().describe('Captured minus already refunded. The cap on a refund.'),
    })
    .describe('Every figure in integer paise.'),
  couponCode: z.string().nullable().describe('Coupon applied at order time.'),
  internalNotes: z.string().nullable().describe('Accumulated internal notes. Never shown to the customer.'),
  cancelReason: z.string().nullable().describe('Why it was cancelled.'),
  cancelledAt: z.string().nullable().describe('ISO-8601, or null.'),
  confirmedAt: z.string().nullable().describe('ISO-8601, or null.'),
  shippedAt: z.string().nullable().describe('ISO-8601, or null.'),
  deliveredAt: z.string().nullable().describe('ISO-8601, or null.'),
  lines: z.array(orderLineView).describe('Order lines in display order.'),
  timeline: z.array(timelineEvent).describe('Append-only, server-generated, oldest first.'),
  payments: z
    .array(
      z.object({
        id: z.uuid().describe('Payment id.'),
        gateway: z.string().describe('`razorpay`, `cod`, `gift_card`, …'),
        method: z.string().describe('`upi`, `credit_card`, `cod`, …'),
        status: z.string().describe('`created`, `authorised`, `captured`, `failed`, …'),
        amountPaise: z.number().int().describe('Amount, in paise.'),
        gatewayPaymentId: z.string().nullable().describe('The gateway’s id, for reconciliation.'),
        capturedAt: z.string().nullable().describe('ISO-8601, or null.'),
        failureReason: z.string().nullable().describe('The gateway’s own wording, when it failed.'),
      }),
    )
    .describe('Every attempt, not only the successful one.'),
  refunds: z
    .array(
      z.object({
        id: z.uuid().describe('Refund id.'),
        refundNo: z.string().describe('Human-facing number.'),
        amountPaise: z.number().int().describe('Amount, in paise.'),
        mode: z.string().describe('`original` reverses the capture; `bank_transfer` is settled by hand.'),
        status: z.string().describe('`initiated`, `processing`, `completed`, `failed`.'),
        reason: z.string().nullable().describe('Why.'),
        createdAt: z.string().describe('ISO-8601.'),
      }),
    )
    .describe('Refund ledger for this order.'),
  shipments: z
    .array(
      z.object({
        id: z.uuid().describe('Shipment id.'),
        shipmentNo: z.string().describe('Internal number.'),
        courierName: z.string().nullable().describe('Courier, or null before assignment.'),
        awb: z.string().nullable().describe('Air waybill.'),
        status: z.string().describe('`label_created` … `delivered`.'),
        attempts: z.number().int().describe('Delivery attempts so far.'),
        etaOn: z.string().nullable().describe('`YYYY-MM-DD`, or null.'),
        dispatchedAt: z.string().nullable().describe('ISO-8601, or null.'),
        deliveredAt: z.string().nullable().describe('ISO-8601, or null.'),
      }),
    )
    .describe('A multi-warehouse gift order legitimately has several.'),
  invoices: z
    .array(
      z.object({
        id: z.uuid().describe('Invoice id.'),
        invoiceNo: z.string().describe('Statutory number, at most 16 characters (Rule 46(b)).'),
        totalPaise: z.number().int().describe('Invoice total, in paise.'),
        issuedAt: z.string().describe('ISO-8601.'),
        status: z.string().describe('`issued` or `cancelled`.'),
      }),
    )
    .describe('At most one issued invoice per order.'),
  availableTransitions: z
    .array(availableTransition)
    .describe('Every legal edge from the current status, each flagged with whether YOUR role may take it.'),
});

export const orderBulkResult = z.object({
  action: z.string().describe('The action that ran.'),
  requested: z.number().int().describe('Order ids sent.'),
  succeeded: z.array(z.uuid()).describe('Orders that changed.'),
  failed: z
    .array(
      z.object({
        orderId: z.uuid().describe('Which order.'),
        code: z.string().describe('`illegal_transition`, `not_found`, `already_invoiced`, …'),
        message: z.string().describe('What went wrong for this one.'),
      }),
    )
    .describe(
      'Per-order, not all-or-nothing. Fifty orders selected on a busy desk will include a few that ' +
        'moved since the page loaded, and failing the batch for those would be useless.',
    ),
});

export const refundResult = z.object({
  refundId: z.uuid().describe('Refund row id.'),
  refundNo: z.string().describe('Human-facing refund number.'),
  status: z.string().describe('`initiated`, `processing` or `failed`. Only a gateway webhook makes it `completed`.'),
  gatewayRefundId: z.string().nullable().describe('The gateway’s id, when it accepted the request.'),
  amountPaise: z.number().int().describe('Amount refunded, in paise.'),
});

export type AdminOrderSummaryResponse = z.infer<typeof adminOrderSummary>;
export type AdminOrderDetailResponse = z.infer<typeof adminOrderDetail>;
export type AdminOrderKpisResponse = z.infer<typeof adminOrderKpis>;
export type OrderBulkResultResponse = z.infer<typeof orderBulkResult>;
export type AvailableTransitionResponse = z.infer<typeof availableTransition>;
