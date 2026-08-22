/**
 * Checkout contracts — and the money-breakdown schemas the cart module reuses.
 *
 * The breakdown here is a 1:1 projection of `PriceBreakdown` from
 * `checkout.pricing.ts`, so the shape the frontend renders on the cart page and
 * the shape it renders on the review step are literally the same object. That is
 * deliberate: the storefront's bug today is that the cart and the checkout each
 * compute their own totals and disagree (`store/src/routes/cart.tsx:28` vs
 * `store/src/routes/checkout.tsx:73-74`).
 *
 * Nothing in any request schema in this file carries a price, a discount or a
 * total. There is no field a client could use to tell the server what something
 * costs — the only inputs are ids, quantities and choices.
 */

import { z } from 'zod';
import { DELIVERY_TYPES, PAYMENT_METHODS } from './checkout.pricing.js';

/* ------------------------------------------------------- shared primitives */

export const PINCODE = /^[1-9][0-9]{5}$/;
export const MOBILE_IN = /^[6-9][0-9]{9}$/;
export const STATE_CODE = /^[0-3][0-9]$/;

export const deliveryType = z
  .enum(DELIVERY_TYPES)
  .describe(
    'Delivery method. Drives the surcharge (`standard` free, `scheduled` ₹249, ' +
      '`same_day`/`midnight` ₹499) and the courier SLA. Server-side constants — the ' +
      'client cannot set a shipping amount.',
  );

export const paymentMethod = z
  .enum(PAYMENT_METHODS)
  .describe('How the order will be paid. `cod` requires a COD-eligible PIN code; everything else is prepaid.');

export const pincode = z
  .string()
  .regex(PINCODE, 'An Indian PIN code is six digits and does not start with 0.')
  .describe('Six-digit Indian PIN code, e.g. `400053`.');

export const mobile = z
  .string()
  .regex(MOBILE_IN, 'An Indian mobile number is ten digits starting 6-9.')
  .describe('Ten-digit Indian mobile number without the country code, e.g. `9820012345`.');

/* ----------------------------------------------------------- the breakdown */

export const pricedLine = z.object({
  lineId: z.string().describe('`cart_lines.id` while quoting; `order_lines.id` once the order exists.'),
  variantId: z.uuid().describe('The stock-bearing variant this line sells.'),
  quantity: z.number().int().describe('Units of the variant on this line.'),
  unitPricePaise: z
    .number()
    .int()
    .describe('LIVE `product_variants.price_paise`, GST-inclusive, in integer paise. Re-read at every quote.'),
  addOnsPaise: z
    .number()
    .int()
    .describe('Sum of this line’s add-on prices PER UNIT, in integer paise.'),
  lineTotalPaise: z
    .number()
    .int()
    .describe('`quantity × (unitPrice + addOns)` before any discount. The strike-through display figure.'),
  allocatedOrderDiscountPaise: z
    .number()
    .int()
    .describe(
      'This line’s share of the order-level coupon, largest-remainder allocated. The parts sum ' +
        'EXACTLY to `couponDiscountPaise` — the deferred `check_order_totals()` trigger rejects a ' +
        'transaction where they differ by one paisa.',
    ),
  grossPaise: z
    .number()
    .int()
    .describe('`order_lines.gross_paise` — net of every discount. `subtotalPaise` is the sum of these.'),
  gstRateBp: z
    .number()
    .int()
    .describe('GST rate in basis points resolved from the product HSN on the supply date. 1800 = 18%.'),
  taxablePaise: z.number().int().describe('Value net of tax, back-computed from the GST-inclusive gross.'),
  cgstPaise: z.number().int().describe('Central GST in paise. Zero on an interstate supply.'),
  sgstPaise: z.number().int().describe('State GST in paise. Always equal to `cgstPaise` — that is a CHECK.'),
  igstPaise: z.number().int().describe('Integrated GST in paise. Zero on an intrastate supply.'),
  cessPaise: z.number().int().describe('Compensation cess in paise.'),
});

export const priceBreakdown = z.object({
  lines: z.array(pricedLine).describe('Per-line money, in cart order.'),
  itemCount: z.number().int().describe('Total units across all lines, not the number of lines.'),
  merchandisePaise: z
    .number()
    .int()
    .describe('Pre-discount merchandise value in paise. What the cart page labels “Subtotal”.'),
  couponCode: z.string().nullable().describe('The coupon actually applied, or null.'),
  couponDiscountPaise: z.number().int().describe('Coupon value in paise. Never exceeds the eligible value.'),
  subtotalPaise: z
    .number()
    .int()
    .describe('`orders.subtotal_paise` = Σ `grossPaise`. Already net of the coupon — do not subtract it again.'),
  shippingPaise: z
    .number()
    .int()
    .describe(
      'Shipping in paise: the zone/flat fee (waived above the free-shipping threshold, measured ' +
        'AFTER discount) plus the delivery-method surcharge. A free-shipping coupon waives the base ' +
        'fee but not a delivery upgrade.',
    ),
  codFeePaise: z.number().int().describe('Cash-on-delivery handling fee in paise. Currently always 0.'),
  taxablePaise: z.number().int().describe('Order-level taxable value in paise. Σ of the line values.'),
  cgstPaise: z.number().int().describe('Order-level CGST in paise.'),
  sgstPaise: z.number().int().describe('Order-level SGST in paise.'),
  igstPaise: z.number().int().describe('Order-level IGST in paise.'),
  cessPaise: z.number().int().describe('Order-level cess in paise.'),
  roundOffPaise: z
    .number()
    .int()
    .describe('Rounds the grand total to the nearest rupee. Bounded ±50 paise by a CHECK.'),
  totalPaise: z
    .number()
    .int()
    .describe('`orders.total_paise` = subtotal + shipping + codFee + roundOff. The amount actually charged.'),
  isInterstate: z
    .boolean()
    .describe('True when the place of supply differs from the supplier state, which makes the tax IGST.'),
});

export type PriceBreakdownResponse = z.infer<typeof priceBreakdown>;

/* --------------------------------------------------------------- addresses */

export const checkoutAddressInput = z.object({
  label: z.string().max(40).optional().describe('Address book label, e.g. `Home`. Defaults to `Home`.'),
  contactName: z.string().trim().min(2).max(120).describe('Name of the person receiving the parcel.'),
  mobile,
  line1: z.string().trim().min(3).max(200).describe('House/flat, building, street.'),
  line2: z.string().trim().max(200).optional().describe('Second address line.'),
  area: z.string().trim().max(120).optional().describe('Locality or area.'),
  city: z.string().trim().min(2).max(80).describe('City.'),
  stateCode: z
    .string()
    .regex(STATE_CODE, 'A GST state code is two digits, e.g. `27`.')
    .describe('Two-digit GST state code. It decides the place of supply and therefore IGST vs CGST+SGST.'),
  pincode,
  countryCode: z
    .string()
    .length(2)
    .default('IN')
    .describe('ISO-3166-1 alpha-2 country code. Only `IN` is serviceable today.'),
  saveToAddressBook: z
    .boolean()
    .default(false)
    .describe('Persist this address on the customer’s account. Ignored for guests.'),
});

/* ------------------------------------------------------------------ quote */

export const checkoutQuoteBody = z.object({
  cartToken: z
    .string()
    .min(8)
    .max(255)
    .optional()
    .describe('Opaque cart handle. Omit to quote the signed-in customer’s own cart.'),
  addressId: z
    .uuid()
    .optional()
    .describe('A saved address id. Supply this OR `address`, not both and not neither.'),
  address: checkoutAddressInput.optional().describe('A one-off shipping address.'),
  deliveryType: deliveryType.default('standard'),
  paymentMethod: paymentMethod.default('upi'),
  couponCode: z
    .string()
    .trim()
    .max(32)
    .optional()
    .describe(
      'Coupon to apply for this quote. Omit to use whatever is already on the cart; send an empty ' +
        'string to quote without any coupon.',
    ),
  requestedDeliveryDate: z
    .iso
    .date()
    .optional()
    .describe('`YYYY-MM-DD` requested delivery date. Must not be in the past in Asia/Kolkata.'),
  deliverySlot: z.string().trim().max(60).optional().describe('Requested slot, e.g. `09:00 - 12:00`.'),
});

export const deliveryOption = z.object({
  deliveryType,
  available: z.boolean().describe('False when the destination zone cannot do it, or the cutoff has passed.'),
  surchargePaise: z.number().int().describe('What choosing this option adds to shipping, in paise.'),
  estimatedDeliveryDate: z.string().nullable().describe('`YYYY-MM-DD` promise date, or null when unknown.'),
  unavailableReason: z.string().nullable().describe('Why it is unavailable, for display. Null when available.'),
});

export const checkoutQuote = z.object({
  cartId: z.uuid().describe('The cart that was priced.'),
  currency: z.string().describe('ISO-4217 currency code. Always `INR` today.'),
  totals: priceBreakdown.describe('The authoritative money. Recomputed from catalogue state on every call.'),
  serviceable: z.boolean().describe('False when the destination PIN code is unknown or suspended.'),
  codEligible: z.boolean().describe('True when both the zone and the PIN code allow cash on delivery.'),
  paymentMethodAllowed: z
    .boolean()
    .describe('False when the requested `paymentMethod` cannot be used — today that means COD on an ineligible PIN.'),
  estimatedDeliveryDate: z.string().nullable().describe('`YYYY-MM-DD` promise for the chosen delivery type.'),
  deliveryOptions: z.array(deliveryOption).describe('Every delivery type with its live availability and surcharge.'),
  placeOfSupplyStateCode: z.string().describe('Two-digit GST state code that will be frozen onto the order.'),
  warnings: z
    .array(z.string())
    .describe(
      'Non-fatal changes since the cart was last read — a price moved, a coupon stopped applying, ' +
        'a line was clamped to available stock. Show these before taking payment.',
    ),
});

/* ------------------------------------------------------------ order create */

export const createOrderBody = checkoutQuoteBody.extend({
  recipientName: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe('Gift recipient, when it is not the buyer. Frozen onto the order.'),
  recipientMobile: mobile.optional().describe('Recipient’s mobile, for the delivery call.'),
  isGift: z.boolean().default(false).describe('Marks the parcel as a gift — no price slip in the box.'),
  isAnonymousGift: z.boolean().default(false).describe('Hide the buyer’s identity from the recipient.'),
  giftMessage: z
    .string()
    .trim()
    .max(240)
    .optional()
    .describe('Gift card message. Hard-capped at 240 characters server-side; the HTML maxlength is not the rule.'),
  buyerName: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .optional()
    .describe('Buyer name. Defaults to the account name, then to the shipping contact name.'),
  buyerEmail: z.email().optional().describe('Where the confirmation and invoice go.'),
  buyerMobile: mobile.optional().describe('Buyer’s mobile. Defaults to the account mobile.'),
  billGstin: z
    .string()
    .trim()
    .length(15)
    .optional()
    .describe('Buyer GSTIN for an input-tax-credit invoice. Validated by a DB domain, so it must be well-formed.'),
});

export const paymentSession = z.object({
  gateway: z.literal('razorpay').describe('Gateway that owns this session.'),
  keyId: z.string().describe('Razorpay public key id to hand to Checkout.js. Never the secret.'),
  razorpayOrderId: z.string().describe('`order_XXXXXXXX` — created server-side. The client never creates one.'),
  amountPaise: z.number().int().describe('Amount to collect, in paise. Equals `order.totalPaise`.'),
  currency: z.string().describe('ISO-4217 currency code.'),
});

export const orderCreated = z.object({
  orderId: z.uuid().describe('Order id. Use it for `GET /v1/account/orders/{orderId}`.'),
  orderNo: z.string().describe('Human-facing number, e.g. `ACH100042`. Issued by the document-number series.'),
  status: z.string().describe('`pending_payment` for prepaid, `confirmed` for COD.'),
  paymentStatus: z.string().describe('`pending` for prepaid, `cod_due` for cash on delivery.'),
  totalPaise: z.number().int().describe('Amount payable in integer paise.'),
  currency: z.string().describe('ISO-4217 currency code.'),
  placedAt: z.string().describe('ISO-8601 timestamp the order was placed.'),
  totals: priceBreakdown.describe('The frozen breakdown, exactly as written to `orders` and `order_lines`.'),
  payment: paymentSession
    .nullable()
    .describe(
      'Razorpay session for a prepaid order. Null for COD, and null if the gateway was unreachable — ' +
        'in that case the order exists in `pending_payment` and the client should call ' +
        '`POST /v1/payments/razorpay/order` to obtain a session.',
    ),
});

export type CheckoutQuoteBody = z.infer<typeof checkoutQuoteBody>;
export type CreateOrderBody = z.infer<typeof createOrderBody>;
export type CheckoutAddressInput = z.infer<typeof checkoutAddressInput>;
export type CheckoutQuoteResponse = z.infer<typeof checkoutQuote>;
export type OrderCreatedResponse = z.infer<typeof orderCreated>;
