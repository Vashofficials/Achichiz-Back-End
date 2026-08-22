import { Router } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok } from '../../lib/http.js';
import * as checkout from './checkout.service.js';
import { checkoutQuote, checkoutQuoteBody, createOrderBody, orderCreated } from './checkout.schemas.js';

/**
 * Checkout. Two endpoints, one rule: the server decides what things cost.
 *
 * `quote` and `orders` run the same computation over the same live catalogue
 * state, so the total the shopper approves is the total that is charged — unless
 * something genuinely changed in between, which `warnings` and a fresh `totals`
 * make visible rather than silent.
 */
export const checkoutRouter: Router = Router();

const RECOMPUTE_NOTE =
  'Every figure is recomputed here from `product_variants`, `add_ons`, `gst_rates`, `coupons` and ' +
  '`delivery_zones`. There is no request field through which a price, discount or total can be sent, ' +
  'and none would be read if there were.';

defineRoute(checkoutRouter, {
  method: 'post',
  path: '/v1/checkout/quote',
  surface: 'storefront',
  operationId: 'createCheckoutQuote',
  summary: 'Price a cart for a destination, delivery method and payment method',
  description:
    `The review step, and the only honest source of a total. ${RECOMPUTE_NOTE} ` +
    'It also answers the three questions the storefront currently guesses: is the PIN code actually ' +
    'serviceable, is cash on delivery allowed there, and which delivery options are live right now ' +
    '(same-day depends on the zone AND on the cutoff not having passed in Asia/Kolkata). ' +
    'Read `warnings` before showing a payment button — that is where a price change, a dropped coupon ' +
    'or a stock shortfall since the cart was last loaded appears. ' +
    'Quoting is free of side effects: no stock is held and no coupon redemption is claimed.',
  tags: ['Checkout'],
  auth: 'customer',
  rateLimit: 'checkout',
  request: { body: checkoutQuoteBody },
  responses: {
    200: { description: 'The priced quote.', schema: checkoutQuote },
    404: { description: 'No such cart, or the address does not belong to the caller.' },
    422: { description: 'The cart is empty, or the coupon/address is invalid.' },
  },
  handler: async ({ body, auth }) => ok(await checkout.quote(auth.customerId, body)),
});

defineRoute(checkoutRouter, {
  method: 'post',
  path: '/v1/orders',
  surface: 'storefront',
  operationId: 'createOrder',
  summary: 'Place the order',
  description:
    `Converts the cart into an order in one transaction. ${RECOMPUTE_NOTE} ` +
    '\n\n' +
    'What happens, in order: the cart is re-priced; the coupon redemption is claimed with a conditional ' +
    'UPDATE that cannot over-redeem; stock is reserved with `UPDATE … WHERE on_hand − reserved >= qty` ' +
    'after locking every affected row in id order (so concurrent checkouts cannot deadlock and cannot ' +
    'oversell); the order number is drawn from the `document_number_series` counter; the header and ' +
    'lines are written; and the commit re-proves the totals against the lines through the deferred ' +
    '`check_order_totals()` trigger. Anything that fails rolls all of it back — including the coupon ' +
    'count and the stock hold.' +
    '\n\n' +
    '**An `Idempotency-Key` header is required.** Retrying with the same key and the same body replays ' +
    'the stored response instead of creating a second order; the same key with a different body is a ' +
    '409. Use a UUID and keep it for the whole retry sequence.' +
    '\n\n' +
    'Prepaid orders come back `pending_payment` with a Razorpay session in `payment`; the order is ' +
    'confirmed by the webhook, never by the browser. COD orders come back `confirmed` / `cod_due` ' +
    'provided the PIN code allows it.',
  tags: ['Checkout'],
  auth: 'customer',
  rateLimit: 'checkout',
  idempotent: true,
  request: { body: createOrderBody },
  responses: {
    201: { description: 'The order, and a payment session when prepaid.', schema: orderCreated },
    400: { description: 'The `Idempotency-Key` header is missing or malformed.' },
    404: { description: 'No such cart, or the address does not belong to the caller.' },
    409: { description: 'That `Idempotency-Key` is in flight, or was used with a different body.' },
    422: {
      description:
        'Empty cart, an item went out of stock, the coupon stopped applying, the PIN code is ' +
        'unserviceable, or COD is not allowed there.',
    },
  },
  handler: async ({ body, auth }) => created(await checkout.createOrder(auth.customerId, body)),
});
