import { Router, type Request } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok } from '../../lib/http.js';
import * as cartService from './cart.service.js';
import {
  addCartLineBody,
  applyCouponBody,
  cart,
  cartLineIdParam,
  cartTokenQuery,
  mergeCartBody,
  updateCartLineBody,
} from './cart.schemas.js';

/**
 * The server-side cart.
 *
 * Everything here is `auth: 'public'` except the merge, because a cart exists
 * before an account does — the storefront lets you fill a basket and only
 * demands a login at checkout. Ownership is proved by an opaque cart token, not
 * by a session.
 *
 * The token travels in the `X-Cart-Token` header (preferred — it stays out of
 * access logs and referrers) or, for convenience, in the request body/query. The
 * header wins when both are present.
 */
export const cartRouter: Router = Router();

const TOKEN_HEADER = 'x-cart-token';

/** Header first, then the body/query fallback the schemas document. */
function cartTokenOf(req: Request, fallback?: string  ): string | undefined {
  const header = req.headers[TOKEN_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return fromHeader?.trim() || fallback || undefined;
}

const TOKEN_NOTE =
  'Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. ' +
  'The header wins if both are sent.';

const TOTALS_NOTE =
  'Totals are recomputed server-side on every call from live variant and add-on prices — the ' +
  'response never echoes a number the client sent. Shipping assumes standard delivery until an ' +
  'address is supplied at `POST /v1/checkout/quote`.';

defineRoute(cartRouter, {
  method: 'get',
  path: '/v1/cart',
  surface: 'storefront',
  operationId: 'getCart',
  summary: 'Get the current cart',
  description:
    `The whole basket with server-computed totals. An unknown or missing token returns an empty ` +
    `cart rather than a 404, so a first-time visitor renders without special-casing. ${TOTALS_NOTE} ` +
    `A coupon that has expired, been exhausted or stopped qualifying is dropped here and reported in ` +
    `\`totals.couponCode: null\` — it is re-validated on every read, not only when it was applied. ` +
    TOKEN_NOTE,
  tags: ['Cart'],
  auth: 'public',
  request: { query: cartTokenQuery },
  responses: {
    200: { description: 'The cart. Empty when no cart exists yet.', schema: cart },
  },
  handler: async ({ query, req }) => ok(await cartService.getCart(cartTokenOf(req, query.cartToken))),
});

defineRoute(cartRouter, {
  method: 'post',
  path: '/v1/cart/lines',
  surface: 'storefront',
  operationId: 'addCartLine',
  summary: 'Add a line to the cart',
  description:
    'Adds a variant, its add-ons and its personalisation. Adding an identical configuration sums ' +
    'the quantities instead of creating a second line — “identical” means the same variant, the same ' +
    'add-ons with the same text, and the same personalisation. ' +
    'Quantity is checked against live available stock (on-hand minus reserved) and rejected with 422 ' +
    '`insufficient_stock` when it exceeds it; stock is NOT reserved here, only at order creation. ' +
    'Personalisation is capped server-side at 24 characters for a name, 180 for a message and 240 for ' +
    'a gift message. ' +
    'Omit `cartToken` on the very first add: the response `token` is the handle to keep. ' +
    TOKEN_NOTE,
  tags: ['Cart'],
  auth: 'public',
  request: { body: addCartLineBody },
  responses: {
    200: { description: 'The updated cart.', schema: cart },
    404: { description: 'No such cart token, or no such purchasable variant.' },
    422: { description: 'Out of stock, personalisation too long, or a builder line was sent.' },
  },
  handler: async ({ body, req }) =>
    ok(
      await cartService.addLine(cartTokenOf(req, body.cartToken), {
        variantId: body.variantId,
        quantity: body.quantity,
        addOns: body.addOns,
        personalisation: body.personalisation,
        builderTemplateId: body.builderTemplateId,
      }),
    ),
});

defineRoute(cartRouter, {
  method: 'patch',
  path: '/v1/cart/lines/:lineId',
  surface: 'storefront',
  operationId: 'updateCartLine',
  summary: 'Change a cart line’s quantity or personalisation',
  description:
    '`quantity: 0` removes the line, mirroring the storefront’s existing stepper behaviour. Any other ' +
    'quantity is an absolute value, not a delta, and is checked against live stock. Changing the ' +
    'personalisation rewrites the line’s dedupe key, so it will 422 if that would collide with another ' +
    'line already in the cart. ' +
    TOKEN_NOTE,
  tags: ['Cart'],
  auth: 'public',
  request: { params: cartLineIdParam, body: updateCartLineBody },
  responses: {
    200: { description: 'The updated cart.', schema: cart },
    404: { description: 'No such cart or no such line in it.' },
    422: { description: 'Not enough stock, personalisation too long, or a duplicate line.' },
  },
  handler: async ({ params, body, req }) =>
    ok(
      await cartService.updateLine(cartTokenOf(req, body.cartToken), params.lineId, {
        quantity: body.quantity,
        personalisation: body.personalisation,
      }),
    ),
});

defineRoute(cartRouter, {
  method: 'delete',
  path: '/v1/cart/lines/:lineId',
  surface: 'storefront',
  operationId: 'removeCartLine',
  summary: 'Remove a cart line',
  description: `Deletes the line and its add-ons. ${TOKEN_NOTE}`,
  tags: ['Cart'],
  auth: 'public',
  request: { params: cartLineIdParam, query: cartTokenQuery },
  responses: {
    200: { description: 'The updated cart.', schema: cart },
    404: { description: 'No such cart or no such line in it.' },
  },
  handler: async ({ params, query, req }) =>
    ok(await cartService.removeLine(cartTokenOf(req, query.cartToken), params.lineId)),
});

defineRoute(cartRouter, {
  method: 'delete',
  path: '/v1/cart',
  surface: 'storefront',
  operationId: 'clearCart',
  summary: 'Empty the cart',
  description:
    `Removes every line and the coupon. The cart row and its token survive, so the same handle keeps ` +
    `working. ${TOKEN_NOTE}`,
  tags: ['Cart'],
  auth: 'public',
  request: { query: cartTokenQuery },
  responses: {
    200: { description: 'The now-empty cart.', schema: cart },
    404: { description: 'No such cart token.' },
  },
  handler: async ({ query, req }) => ok(await cartService.clearCart(cartTokenOf(req, query.cartToken))),
});

defineRoute(cartRouter, {
  method: 'post',
  path: '/v1/cart/coupon',
  surface: 'storefront',
  operationId: 'applyCartCoupon',
  summary: 'Apply a coupon to the cart',
  description:
    'Validated against the live `coupons` table — status, start and end dates, global redemption cap, ' +
    'per-customer cap, minimum order value, and product/collection eligibility. Each failure returns a ' +
    'distinct stable `code` (`coupon_not_found`, `coupon_expired`, `coupon_exhausted`, ' +
    '`coupon_min_not_met`, `coupon_not_applicable`, `coupon_first_order_only`, …) so the frontend can ' +
    'explain itself rather than saying “invalid code”. Applying a coupon does not reserve a redemption; ' +
    'that is claimed atomically at order creation. ' +
    TOKEN_NOTE,
  tags: ['Cart'],
  auth: 'public',
  request: { body: applyCouponBody },
  responses: {
    200: { description: 'The cart, repriced with the coupon.', schema: cart },
    404: { description: 'No such cart token.' },
    422: { description: 'The coupon does not exist, is not live, or does not apply to this cart.' },
  },
  handler: async ({ body, req }) =>
    ok(await cartService.applyCoupon(cartTokenOf(req, body.cartToken), body.code)),
});

defineRoute(cartRouter, {
  method: 'delete',
  path: '/v1/cart/coupon',
  surface: 'storefront',
  operationId: 'removeCartCoupon',
  summary: 'Remove the cart’s coupon',
  description: `Clears the coupon and reprices. ${TOKEN_NOTE}`,
  tags: ['Cart'],
  auth: 'public',
  request: { query: cartTokenQuery },
  responses: {
    200: { description: 'The cart, repriced without the coupon.', schema: cart },
    404: { description: 'No such cart token.' },
  },
  handler: async ({ query, req }) => ok(await cartService.removeCoupon(cartTokenOf(req, query.cartToken))),
});

defineRoute(cartRouter, {
  method: 'post',
  path: '/v1/cart/merge',
  surface: 'storefront',
  operationId: 'mergeCart',
  summary: 'Attach a guest cart to the signed-in account',
  description:
    'Call this once immediately after login. With `cartToken`, the guest cart’s lines are folded into ' +
    'the account’s cart — identical configurations have their quantities summed, everything else is ' +
    'moved across — and the guest cart is discarded. Without `cartToken`, it simply returns (creating ' +
    'if needed) the account’s own cart, which is how a second device obtains a handle. ' +
    'No price is carried over: every line is re-priced from the catalogue, and the coupon is ' +
    're-validated. **Use the `token` in the response from this point on** — the guest token is dead.',
  tags: ['Cart'],
  auth: 'customer',
  request: { body: mergeCartBody },
  responses: {
    200: { description: 'The account’s cart, after the merge.', schema: cart },
    404: { description: 'The supplied cart token belongs to a different account.' },
  },
  handler: async ({ body, auth, req }) =>
    ok(await cartService.mergeCart(auth.customerId, cartTokenOf(req, body.cartToken))),
});
