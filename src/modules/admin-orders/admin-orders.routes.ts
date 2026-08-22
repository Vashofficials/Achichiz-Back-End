import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated, pageMeta } from '../../lib/http.js';
import * as adminOrders from './admin-orders.service.js';
import { STAFF_TRANSITIONS } from './admin-orders.state.js';
import {
  adminOrderDetail,
  adminOrderIdParam,
  adminOrderListQuery,
  adminOrderSummary,
  availableTransition,
  cancelBody,
  noteBody,
  orderBulkBody,
  orderBulkResult,
  orderStatus,
  refundBody,
  refundResult,
  transitionBody,
} from './admin-orders.schemas.js';

/**
 * The order desk.
 *
 * `orders` is the sixtieth resource and the one the generic engine does not
 * serve: it needs a KPI header computed over the filter set, six named
 * dropdowns, a search that reaches into `shipments` for the AWB, and writes that
 * are state transitions rather than column patches.
 *
 * Route order matters: `/transitions` and `/bulk` are literal segments declared
 * before `/:orderId`, so Express matches them first.
 */
export const adminOrdersRouter: Router = Router();

const TAG = 'Admin orders';

defineRoute(adminOrdersRouter, {
  method: 'get',
  path: '/v1/admin/orders',
  surface: 'admin',
  operationId: 'adminListOrders',
  summary: 'List orders',
  description:
    'The order desk. Six named filters (`status`, `paymentStatus`, `channel`, `deliveryType`, ' +
    '`priority`, `warehouseId`), two date ranges (`placedFrom`/`placedTo`, `deliveryFrom`/`deliveryTo`), ' +
    'a `tag` filter and a `corporateAccountId` filter. Each enum filter takes a comma-separated list; ' +
    'an unrecognised value is a 400 rather than a silently empty page, because a typo that returns ' +
    'nothing reads exactly like "there are no orders".\n\n' +
    '`?q=` searches order number, buyer name, buyer email, both mobile numbers, recipient name, ' +
    'destination PIN code and the AWB — the last through an EXISTS on `shipments`, so a multi-parcel ' +
    'order still returns one row.\n\n' +
    'The KPI block in `meta` is computed over the SAME filter set as the rows, not over the page. The ' +
    'console currently derives those numbers from whatever happens to be in memory, which makes ' +
    '"order value" mean "order value of these ten".',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'orders', action: 'view' },
  request: { query: adminOrderListQuery },
  responses: {
    200: {
      description: 'A page of orders. `meta` carries pagination plus the KPI block.',
      schema: z.array(adminOrderSummary),
    },
    400: { description: 'An unrecognised filter value or an unparseable date.' },
  },
  handler: async ({ query }) => {
    const { items, total, kpis } = await adminOrders.listOrders(query);
    const meta = { ...pageMeta(total, query.page, query.perPage), kpis };
    return paginated(items, meta);
  },
});

defineRoute(adminOrdersRouter, {
  method: 'get',
  path: '/v1/admin/orders/transitions',
  surface: 'admin',
  operationId: 'adminGetOrderTransitionMap',
  summary: 'The order state machine',
  description:
    'The whole transition table: every status, its legal next states, the RBAC action each edge ' +
    'requires, and the side effects it triggers. Edges marked `systemOnly` are facts reported by a ' +
    'courier scan or a payment-gateway webhook — `delivered`, `out_for_delivery`, `refunded` — and no ' +
    'staff member may set them by hand, because forging one puts the ledger out of step with reality.\n\n' +
    'Fetch this once and render the "Advance status" menu from it instead of hardcoding sixteen ' +
    'statuses in the console.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'orders', action: 'view' },
  responses: {
    200: {
      description: 'status → legal edges.',
      schema: z.record(orderStatus, z.array(availableTransition)),
    },
  },
  handler: ({ auth }) =>
    ok(
      Object.fromEntries(
        Object.keys(STAFF_TRANSITIONS).map((status) => [
          status,
          adminOrders.availableTransitions(status as keyof typeof STAFF_TRANSITIONS, auth.permissions),
        ]),
      ),
    ),
});

defineRoute(adminOrdersRouter, {
  method: 'post',
  path: '/v1/admin/orders/bulk',
  surface: 'admin',
  operationId: 'adminBulkOrderAction',
  summary: 'Bulk action on selected orders',
  description:
    'Five actions. `mark_packed` and `mark_ready_to_ship` are ordinary transitions and each order is ' +
    'checked against the state machine individually. `generate_invoices` issues one GST invoice per ' +
    'order from its frozen tax columns and is idempotent — an order that already has an issued invoice ' +
    'is reported as succeeded, not duplicated. `assign_courier` needs `courierId` and creates or ' +
    'updates the open shipment. `cancel` needs `reason` and additionally requires `orders:cancel`, ' +
    'which this route’s own `orders:edit` gate does not imply.\n\n' +
    'Results are per order, not all-or-nothing: fifty orders selected on a busy desk will include a ' +
    'few that moved since the page rendered, and failing the batch for those helps nobody. They come ' +
    'back in `failed` with a stable code. Orders are processed sequentially because each takes row ' +
    'locks on the order and its inventory reservations; firing fifty in parallel turns a queue into a ' +
    'deadlock.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'orders', action: 'edit' },
  rateLimit: 'default',
  request: { body: orderBulkBody },
  responses: {
    200: { description: 'Per-order outcomes.', schema: orderBulkResult },
    400: { description: '`courierId` or `reason` missing for an action that needs it.' },
    403: { description: 'The action needs an RBAC action your role does not hold — `cancel` needs `orders:cancel`.' },
  },
  handler: async ({ body, auth }) => ok(await adminOrders.runBulk(body, auth)),
});

defineRoute(adminOrdersRouter, {
  method: 'get',
  path: '/v1/admin/orders/:orderId',
  surface: 'admin',
  operationId: 'adminGetOrder',
  summary: 'Get one order',
  description:
    'The whole workspace in one call: the frozen buyer, recipient, address, billing and tax snapshots; ' +
    'every money column in integer paise including `refundablePaise` (captured minus already ' +
    'refunded, which is the cap on a refund); the lines with their add-ons, personalisation and ' +
    'per-line GST split; the append-only timeline; every payment attempt, not only the successful one; ' +
    'the refund ledger; shipments; and issued invoices.\n\n' +
    '`availableTransitions` lists every legal edge from the current status, each flagged `allowed` ' +
    'against YOUR grants — so the console can render the menu without a second copy of the state ' +
    'machine, and a disabled button and a 403 can never disagree.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'orders', action: 'view' },
  request: { params: adminOrderIdParam },
  responses: {
    200: { description: 'The order.', schema: adminOrderDetail },
    404: { description: 'No such order.' },
  },
  handler: async ({ params, auth }) => ok(await adminOrders.getOrder(params.orderId, auth)),
});

defineRoute(adminOrdersRouter, {
  method: 'patch',
  path: '/v1/admin/orders/:orderId/status',
  surface: 'admin',
  operationId: 'adminUpdateOrderStatus',
  summary: 'Move an order to another status',
  description:
    'Validated against the state machine under a row lock — the status read a moment ago may have ' +
    'moved beneath a courier webhook while the operator was looking at the screen.\n\n' +
    'An edge that does not exist is 422 `illegal_transition` and lists the legal ones; that check runs ' +
    'BEFORE the permission check, so a Super Admin gets the same answer and nobody goes hunting for a ' +
    'missing grant that was never the problem. An edge a courier or the gateway owns is 422 ' +
    '`system_driven_transition`. An edge you lack the grant for is 403.\n\n' +
    'Two targets are redirected rather than handled here, because both have side effects that a status ' +
    'write alone would silently skip: `cancelled` runs the full cancellation (stock released, coupon ' +
    'redemption returned to the pool, refund started), and `refund_initiated` needs an amount, so it ' +
    'returns 422 pointing at the refund endpoint.\n\n' +
    'Moving to `shipped` creates or reuses the open shipment; pass `courierId` and `awb` to lock them in.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'orders', action: 'edit' },
  request: { params: adminOrderIdParam, body: transitionBody },
  responses: {
    200: { description: 'The order, after the move.', schema: adminOrderDetail },
    403: { description: 'Your role lacks the action this edge requires.' },
    404: { description: 'No such order.' },
    422: { description: 'Illegal transition, a system-owned edge, or no warehouse to ship from.' },
  },
  handler: async ({ params, body, auth }) => ok(await adminOrders.transitionOrder(params.orderId, body, auth)),
});

defineRoute(adminOrdersRouter, {
  method: 'post',
  path: '/v1/admin/orders/:orderId/cancel',
  surface: 'admin',
  operationId: 'adminCancelOrder',
  summary: 'Cancel an order',
  description:
    'Cancellation is not a status write. In one transaction it releases the stock reservation, returns ' +
    'the coupon redemption to the pool, stamps the reason and appends a timeline event.\n\n' +
    'An order that was actually paid becomes `refund_initiated`, **not** `cancelled` — only the ' +
    'gateway’s confirmation moves it to `refunded`, because telling someone their money is back before ' +
    'it is would be a lie. The gateway call happens after the commit, so a Razorpay outage cannot take ' +
    'the cancellation down with it; a failed refund is logged for Finance to retry. Send ' +
    '`refund: false` to leave the money for Finance to settle by hand.\n\n' +
    'Only pre-shipment orders qualify. Once a courier has the parcel, cancelling is a return-to-origin — ' +
    'an operations decision with a cost — so use the `rto` transition or raise a return.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'orders', action: 'cancel' },
  request: { params: adminOrderIdParam, body: cancelBody },
  responses: {
    200: { description: 'The cancelled order.', schema: adminOrderDetail },
    403: { description: 'Your role cannot cancel orders.' },
    404: { description: 'No such order.' },
    422: { description: 'The order has moved past the point where it can be cancelled.' },
  },
  handler: async ({ params, body, auth }) => ok(await adminOrders.cancelOrder(params.orderId, body, auth)),
});

defineRoute(adminOrdersRouter, {
  method: 'post',
  path: '/v1/admin/orders/:orderId/refund',
  surface: 'admin',
  operationId: 'adminRefundOrder',
  summary: 'Refund an order',
  description:
    'Gated on `orders:refund`, which across the eleven roles only **Finance Manager** and **Super ' +
    'Admin** hold. Every other role — including Operations Manager and Order Manager, who can cancel — ' +
    'gets a 403 here. The console hides the button for them; that is a convenience, and this is the ' +
    'control.\n\n' +
    'Also requires a recent re-authentication: call `POST /v1/admin/auth/step-up` first, which opens a ' +
    'five-minute window on the current session. Ten minutes of access-token life is a long time for an ' +
    'unattended laptop and a refund is irreversible.\n\n' +
    'The work is delegated to the payments service, which caps the amount at captured-minus-refunded, ' +
    'writes and commits the refund row **before** calling the gateway (so a refund Razorpay accepted ' +
    'but whose response was lost is still on the books), and honours `Idempotency-Key` for a replayed ' +
    'request. Only a gateway webhook moves the refund to `completed` and the order to `refunded`.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'orders', action: 'refund' },
  rateLimit: 'payment',
  idempotent: true,
  request: { params: adminOrderIdParam, body: refundBody },
  responses: {
    200: { description: 'The refund, as the gateway accepted it.', schema: refundResult },
    403: { description: 'Your role cannot refund orders, or there is no recent step-up.' },
    404: { description: 'No such order.' },
    422: { description: 'The amount exceeds what is still refundable.' },
  },
  handler: async ({ params, body, auth, req }) => {
    const header = req.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    return ok(await adminOrders.refund(params.orderId, body, auth, key ?? null));
  },
});

defineRoute(adminOrdersRouter, {
  method: 'post',
  path: '/v1/admin/orders/:orderId/invoice',
  surface: 'admin',
  operationId: 'adminGenerateOrderInvoice',
  summary: 'Issue the GST invoice for an order',
  description:
    'Amounts are copied from the order’s FROZEN tax columns, never recomputed — the rates were ' +
    'resolved when the order was placed and the catalogue has moved on since. The total is built as ' +
    '`taxable + cgst + sgst + igst + cess + roundOff` rather than copied from the order header, which ' +
    'also carries shipping and COD fees.\n\n' +
    'The number comes from `document_number_series` under a row lock, because a gap in a statutory ' +
    'series is a compliance problem. If no active series exists for the current financial year this ' +
    'returns 422 rather than improvising one. Every line needs an HSN code — GSTR-1 requires an ' +
    'HSN-wise summary.\n\n' +
    'Idempotent: an order that already has an issued invoice returns that invoice with ' +
    '`alreadyIssued: true`.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'orders', action: 'edit' },
  request: { params: adminOrderIdParam },
  responses: {
    200: {
      description: 'The invoice.',
      schema: z.object({
        id: z.uuid().describe('Invoice id.'),
        invoiceNo: z.string().describe('Statutory number, at most 16 characters (Rule 46(b)).'),
        alreadyIssued: z.boolean().describe('True when this order already had an issued invoice.'),
      }),
    },
    404: { description: 'No such order.' },
    422: { description: 'Not invoiceable yet, no numbering series, an unknown supplier state, or a line with no HSN.' },
  },
  handler: async ({ params, auth }) => ok(await adminOrders.generateInvoice(params.orderId, auth)),
});

defineRoute(adminOrdersRouter, {
  method: 'post',
  path: '/v1/admin/orders/:orderId/courier',
  surface: 'admin',
  operationId: 'adminAssignOrderCourier',
  summary: 'Assign a courier to an order',
  description:
    'Attaches the courier to the order’s open (`label_created`) shipment, creating one from the ' +
    'fulfilment warehouse — or the default warehouse — if none exists yet. A COD order carries its ' +
    'outstanding balance onto the shipment as `codAmountPaise`. Reuses the open shipment rather than ' +
    'creating a second row, so packing and dispatch do not produce two parcels for one box.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'delivery', action: 'edit' },
  request: {
    params: adminOrderIdParam,
    body: z.object({
      courierId: z.uuid().describe('Courier partner id.'),
    }),
  },
  responses: {
    200: {
      description: 'The shipment the courier was attached to.',
      schema: z.object({
        shipmentId: z.uuid().describe('Shipment id.'),
        shipmentNo: z.string().describe('Internal shipment number.'),
      }),
    },
    404: { description: 'No such order, or no such courier.' },
    422: { description: 'No fulfilment warehouse and no default warehouse configured.' },
  },
  handler: async ({ params, body, auth }) =>
    ok(await adminOrders.assignCourier(params.orderId, body.courierId, auth)),
});

defineRoute(adminOrdersRouter, {
  method: 'post',
  path: '/v1/admin/orders/:orderId/notes',
  surface: 'admin',
  operationId: 'adminAddOrderNote',
  summary: 'Add an internal note',
  description:
    'Appends to `orders.internal_notes` AND writes a timeline event. The column is the convenience ' +
    'view; the timeline is the record that cannot be edited. Never shown to the customer.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'orders', action: 'edit' },
  request: { params: adminOrderIdParam, body: noteBody },
  responses: {
    200: {
      description: 'The note, as stored.',
      schema: z.object({ note: z.string().describe('The note text.') }),
    },
    404: { description: 'No such order.' },
  },
  handler: async ({ params, body, auth }) => ok(await adminOrders.addNote(params.orderId, body.note, auth)),
});
