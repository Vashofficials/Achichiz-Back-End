import { Router } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok, paginated, pageMeta } from '../../lib/http.js';
import * as bulkOrders from './admin-bulk-orders.service.js';
import {
  bulkOrderDetail,
  bulkOrderIdParam,
  bulkOrderListQuery,
  bulkOrderSummary,
  createBulkOrderBody,
  fulfillmentPlanQuery,
  fulfillmentPlanResponse,
  inventoryCheckBody,
  inventoryCheckResponse,
  procurementPlanBody,
  procurementPlanResponse,
  releaseBody,
  releaseResponse,
  reserveBody,
  reserveResponse,
  updateBulkOrderBody,
} from './admin-bulk-orders.schemas.js';

/**
 * Corporate bulk orders — §88.
 *
 * A bulk order is a `corporate_campaigns` row and its recipients. The demand is
 * the recipient list; there is deliberately no quantity field to disagree with it.
 *
 * The five inventory endpoints split cleanly into reads and writes, and the split
 * is the point: `inventory-check`, `procurement-plan` and `fulfillment-plan`
 * change nothing and can be called as often as anyone likes. `reserve` and
 * `release` are the only two that touch `reserved_qty`, and both are one
 * transaction.
 */
export const adminBulkOrdersRouter: Router = Router();

const TAG = 'Admin bulk orders';

/* =============================================================== the record */

defineRoute(adminBulkOrdersRouter, {
  method: 'get',
  path: '/v1/admin/bulk-orders',
  surface: 'admin',
  operationId: 'adminListBulkOrders',
  summary: 'List corporate bulk orders',
  description: 'Filter by status, account or owner. `reservedUnits` is derived from live reservations, never stored.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'corporate', action: 'view' },
  request: { query: bulkOrderListQuery },
  responses: { 200: { description: 'A page of bulk orders.', schema: bulkOrderSummary.array() } },
  handler: async ({ query }) => {
    const { rows, total } = await bulkOrders.listBulkOrders(query);
    return paginated(rows, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminBulkOrdersRouter, {
  method: 'post',
  path: '/v1/admin/bulk-orders',
  surface: 'admin',
  operationId: 'adminCreateBulkOrder',
  summary: 'Create a corporate bulk order',
  description:
    'Takes its number from the same row-locked series every other document uses. A source quotation must ' +
    'belong to the same account — a campaign pointing at another company’s quotation would put one ' +
    'client’s pricing on another client’s dispatch.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'corporate', action: 'create' },
  request: { body: createBulkOrderBody },
  responses: {
    201: { description: 'The bulk order, with demand aggregated from its recipients.', schema: bulkOrderDetail },
    404: { description: 'Account or quotation not found.' },
    422: { description: 'Quotation belongs to another account, or the window ends before it starts.' },
  },
  handler: async ({ body, auth }) => created(await bulkOrders.createBulkOrder(body, auth.staffId)),
});

defineRoute(adminBulkOrdersRouter, {
  method: 'get',
  path: '/v1/admin/bulk-orders/:bulkOrderId',
  surface: 'admin',
  operationId: 'adminGetBulkOrder',
  summary: 'Get a corporate bulk order',
  description: 'The campaign plus its demand — one line per distinct gift, aggregated from the recipient list.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'corporate', action: 'view' },
  request: { params: bulkOrderIdParam },
  responses: {
    200: { description: 'The bulk order.', schema: bulkOrderDetail },
    404: { description: 'No such bulk order.' },
  },
  handler: async ({ params }) => ok(await bulkOrders.getBulkOrder(params.bulkOrderId)),
});

defineRoute(adminBulkOrdersRouter, {
  method: 'patch',
  path: '/v1/admin/bulk-orders/:bulkOrderId',
  surface: 'admin',
  operationId: 'adminUpdateBulkOrder',
  summary: 'Update a corporate bulk order',
  description:
    'Moving to `cancelled` does NOT release held stock. Call POST /release first, or the units stay ' +
    'reserved against a campaign nobody is running — invisible everywhere except a stockout three weeks later.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'corporate', action: 'edit' },
  request: { params: bulkOrderIdParam, body: updateBulkOrderBody },
  responses: {
    200: { description: 'The bulk order after the change.', schema: bulkOrderDetail },
    404: { description: 'No such bulk order.' },
    422: { description: 'The dispatch window ends before it starts.' },
  },
  handler: async ({ params, body }) => ok(await bulkOrders.updateBulkOrder(params.bulkOrderId, body)),
});

/* ============================================================== inventory */

defineRoute(adminBulkOrdersRouter, {
  method: 'post',
  path: '/v1/admin/bulk-orders/:bulkOrderId/inventory-check',
  surface: 'admin',
  operationId: 'adminBulkOrderInventoryCheck',
  summary: 'Check whether a bulk order can be covered',
  description:
    'Aggregates the recipient list into per-gift demand, then allocates it across the warehouses that ' +
    'hold each gift — largest stock first, so a campaign draws from as few sites as possible.\n\n' +
    '**Reserves nothing.** The allocation it returns is a plan against stock that a checkout can take a ' +
    'microsecond later; POST /reserve re-plans under lock, which is what makes the hold honest.\n\n' +
    'Recipients with no gift assigned are reported in `unassignedRecipientCount` rather than skipped: ' +
    '“we cannot plan for 43 people” is the answer a planner needs.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  skipAudit: true,
  request: { params: bulkOrderIdParam, body: inventoryCheckBody },
  responses: {
    200: { description: 'Demand, allocation and shortfall.', schema: inventoryCheckResponse },
    404: { description: 'No such bulk order.' },
  },
  handler: async ({ params, body }) => ok(await bulkOrders.checkInventory(params.bulkOrderId, body)),
});

defineRoute(adminBulkOrdersRouter, {
  method: 'post',
  path: '/v1/admin/bulk-orders/:bulkOrderId/reserve',
  surface: 'admin',
  operationId: 'adminReserveBulkOrderStock',
  summary: 'Hold stock for a bulk order',
  description:
    'ONE transaction. Locks every level in ascending id order, re-plans the allocation under those locks ' +
    'so the numbers cannot move again, then applies the conditional `UPDATE … WHERE on_hand − reserved ' +
    '>= n` per level. Any refusal rolls the whole thing back.\n\n' +
    '**All-or-nothing by default.** A shortfall on any gift reserves nothing, because a half-reserved ' +
    'campaign hides the gap until dispatch day. Pass `allowPartial: true` to hold what is there — the ' +
    'right call when the rest is already on a purchase order.\n\n' +
    'A reservation moves `reserved_qty` and nothing else. No `stock_movements` row is written: the ledger ' +
    'tracks physical movement, and a hold in it would double-count when the goods actually ship.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  idempotent: true,
  request: { params: bulkOrderIdParam, body: reserveBody },
  responses: {
    200: { description: 'What is now held.', schema: reserveResponse },
    404: { description: 'No such bulk order.' },
    422: {
      description:
        'Campaign closed (`campaign_closed`), no gifts assigned (`no_demand`), or short without ' +
        '`allowPartial` (`insufficient_stock`). Nothing was reserved in any case.',
    },
  },
  handler: async ({ params, body, auth }) =>
    ok(await bulkOrders.reserveForBulkOrder(params.bulkOrderId, body, auth.staffId)),
});

defineRoute(adminBulkOrdersRouter, {
  method: 'post',
  path: '/v1/admin/bulk-orders/:bulkOrderId/release',
  surface: 'admin',
  operationId: 'adminReleaseBulkOrderStock',
  summary: 'Release a bulk order’s held stock',
  description:
    'Closes every unreleased reservation for the campaign and gives the units back to sellable stock.\n\n' +
    'Idempotent by construction: `released_at IS NULL` in the UPDATE’s WHERE means a second call closes ' +
    'nothing and decrements nothing. That matters — release is exactly the call somebody retries after a ' +
    'timeout, and a double decrement would push `reserved_qty` below zero and let the next checkout oversell.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  idempotent: true,
  request: { params: bulkOrderIdParam, body: releaseBody },
  responses: {
    200: { description: 'What was released.', schema: releaseResponse },
    404: { description: 'No such bulk order.' },
    422: { description: '`reserved_qty` is lower than the reservation claims (`reservation_inconsistent`).' },
  },
  handler: async ({ params, body, auth }) =>
    ok(await bulkOrders.releaseForBulkOrder(params.bulkOrderId, body, auth.staffId)),
});

defineRoute(adminBulkOrdersRouter, {
  method: 'post',
  path: '/v1/admin/bulk-orders/:bulkOrderId/procurement-plan',
  surface: 'admin',
  operationId: 'adminBulkOrderProcurementPlan',
  summary: 'What to buy to cover a bulk order',
  description:
    'Turns the shortfall into purchase lines: the preferred supplier per gift (or the cheapest when none ' +
    'is marked preferred), the quantity rounded UP to their MOQ, and the date each line must be ordered ' +
    'by to land before the dispatch window opens.\n\n' +
    '**Creates no purchase orders.** It is a plan — POST /v1/admin/purchase-orders is what commits money.\n\n' +
    'A line that cannot arrive in time is marked `meetsWindow: false` with an `orderByDate` in the past. ' +
    'That is stated rather than softened, because the decision it drives — split the campaign, substitute ' +
    'the gift, move the date — belongs to a human and needs the real number. `estimatedTotalPaise` is ' +
    'null if ANY line lacks a cost.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  skipAudit: true,
  request: { params: bulkOrderIdParam, body: procurementPlanBody },
  responses: {
    200: { description: 'The procurement plan.', schema: procurementPlanResponse },
    404: { description: 'No such bulk order.' },
  },
  handler: async ({ params, body }) => ok(await bulkOrders.procurementPlan(params.bulkOrderId, body)),
});

defineRoute(adminBulkOrdersRouter, {
  method: 'get',
  path: '/v1/admin/bulk-orders/:bulkOrderId/fulfillment-plan',
  surface: 'admin',
  operationId: 'adminBulkOrderFulfillmentPlan',
  summary: 'How a bulk order dispatches',
  description:
    'Groups the campaign for dispatch: by `warehouse` (the picking view), by `state` (the courier view), ' +
    'or by `variant`.\n\n' +
    '§88 — `plannedUnits` must equal `reservedUnits`. `balanced: false` means the two disagree, and the ' +
    'campaign should be reserved or released before anyone picks against this plan. A plan that ' +
    'dispatches 799 against a hold of 800 has one recipient nobody will ever ship to, and every ' +
    'individual number in it looks reasonable.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: bulkOrderIdParam, query: fulfillmentPlanQuery },
  responses: {
    200: { description: 'The dispatch plan.', schema: fulfillmentPlanResponse },
    404: { description: 'No such bulk order.' },
  },
  handler: async ({ params, query }) => ok(await bulkOrders.fulfillmentPlan(params.bulkOrderId, query)),
});
