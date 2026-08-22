import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated, pageMeta } from '../../lib/http.js';
import * as orders from './orders.service.js';
import {
  cancelOrderBody,
  orderDetail,
  orderIdParam,
  orderListQuery,
  orderSummary,
  orderTracking,
  trackOrderQuery,
} from './orders.schemas.js';

/**
 * Customer order history and public tracking.
 *
 * Ownership is enforced in the SQL, not after it — an order that is not yours is
 * a 404, which is also the right answer for privacy. Public tracking is the one
 * exception, and it is gated on knowing both the order number and a matching
 * mobile number.
 */
export const ordersRouter: Router = Router();

defineRoute(ordersRouter, {
  method: 'get',
  path: '/v1/account/orders',
  surface: 'storefront',
  operationId: 'listMyOrders',
  summary: 'List my orders',
  description:
    'Newest first. `status` is the real sixteen-value operational status driven by fulfilment and ' +
    'gateway events; `trackingStage` is the five-stage projection the UI renders. `canCancel` tells you ' +
    'whether to show the cancel button — the API re-checks it under a row lock anyway. ' +
    'Wrapped as `{ data, meta }` with `page`, `perPage`, `total` and `totalPages`.',
  tags: ['Orders'],
  auth: 'customer',
  request: { query: orderListQuery },
  responses: {
    200: { description: 'A page of orders.', schema: z.array(orderSummary) },
  },
  handler: async ({ query, auth }) => {
    const { items, total } = await orders.listMyOrders(auth.customerId, query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(ordersRouter, {
  method: 'get',
  path: '/v1/account/orders/:orderId',
  surface: 'storefront',
  operationId: 'getMyOrder',
  summary: 'Get one of my orders',
  description:
    'Everything the order page renders: the frozen address and buyer snapshots, the per-line GST ' +
    'breakdown, add-ons, personalisation instructions, and the append-only timeline. An order id that ' +
    'is not yours returns 404, not 403 — confirming that an order exists is itself a leak.',
  tags: ['Orders'],
  auth: 'customer',
  request: { params: orderIdParam },
  responses: {
    200: { description: 'The order.', schema: orderDetail },
    404: { description: 'No such order, or it belongs to someone else.' },
  },
  handler: async ({ params, auth }) => ok(await orders.getMyOrder(auth.customerId, params.orderId)),
});

defineRoute(ordersRouter, {
  method: 'post',
  path: '/v1/account/orders/:orderId/cancel',
  surface: 'storefront',
  operationId: 'cancelMyOrder',
  summary: 'Cancel one of my orders',
  description:
    'The only state transition a customer owns, and only from a pre-shipped state ' +
    '(`pending_payment`, `paid`, `confirmed`, `in_production`, `personalisation_pending`, ' +
    '`quality_check`, `packed`, `ready_to_ship`). Anything later returns 422 `order_not_cancellable` ' +
    'with the reason — once a courier has it, cancelling is a return, not an update.' +
    '\n\n' +
    'In one transaction it releases the stock reservation, returns the coupon redemption to the pool, ' +
    'stamps the cancellation and appends a timeline event. An order that was actually paid moves to ' +
    '`refund_initiated`, not `cancelled`, and a gateway refund is started afterwards — only the ' +
    'gateway’s confirmation moves it to `refunded`, because telling someone their money is back before ' +
    'it is would be a lie.',
  tags: ['Orders'],
  auth: 'customer',
  rateLimit: 'checkout',
  request: { params: orderIdParam, body: cancelOrderBody },
  responses: {
    200: { description: 'The cancelled order.', schema: orderDetail },
    404: { description: 'No such order, or it belongs to someone else.' },
    422: { description: 'The order has moved past the point where a customer may cancel it.' },
  },
  handler: async ({ params, body, auth }) =>
    ok(await orders.cancelMyOrder(auth.customerId, params.orderId, body.reason)),
});

defineRoute(ordersRouter, {
  method: 'get',
  path: '/v1/orders/track',
  surface: 'storefront',
  operationId: 'trackOrder',
  summary: 'Track an order without signing in',
  description:
    'Backs the public tracking page. Requires the order number AND a matching mobile number — either ' +
    'the buyer’s or the recipient’s, because the person chasing a gift is often the recipient. Order ' +
    'numbers are sequential and therefore guessable, so the mobile number is the actual secret; a wrong ' +
    'number and a non-existent order return the same 404.' +
    '\n\n' +
    'Each stage carries the timestamp of the event that actually happened, or null. Nothing here is ' +
    'derived from elapsed time, and no address, email, name or price is returned.',
  tags: ['Orders'],
  auth: 'public',
  rateLimit: 'search',
  request: { query: trackOrderQuery },
  responses: {
    200: { description: 'The tracking view.', schema: orderTracking },
    404: { description: 'No order matches that number and mobile number.' },
  },
  handler: async ({ query }) => ok(await orders.trackOrder(query.orderNo, query.mobile)),
});
