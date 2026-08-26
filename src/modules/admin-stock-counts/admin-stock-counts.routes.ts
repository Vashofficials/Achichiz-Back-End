import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok, paginated, pageMeta } from '../../lib/http.js';
import * as counts from './admin-stock-counts.service.js';
import {
  approveCountBody,
  completeCountBody,
  countApprovalResult,
  countDetail,
  countDetailQuery,
  countIdParam,
  countListQuery,
  countSummary,
  createCountBody,
  startCountBody,
  submitCountItemsBody,
  submitItemsResult,
} from './admin-stock-counts.schemas.js';

/**
 * Physical stock counts — §39/§40.
 *
 * The document is a four-step ratchet, and each step exists because collapsing it
 * into the next one loses something:
 *
 * ```
 *   create  →  draft         nothing frozen, nothing counted
 *   start   →  in_progress   systemQty FROZEN for every level in scope
 *   items   →  in_progress   countedQty recorded, repeatedly, in any order
 *   complete→  completed     counting finished; STILL no stock has moved
 *   approve →  approved      the variance is posted to the ledger
 * ```
 *
 * **A count never overwrites stock.** Approval posts a `stock_count` movement for
 * exactly `countedQty − systemQty` and lets the conditional UPDATE apply it.
 * Nothing here assigns `on_hand_qty = countedQty`, which is what keeps the ledger
 * reconstructible: `SUM(quantity_delta)` still equals `on_hand_qty` afterwards.
 *
 * **Route order is load-bearing.** `/:countId` and everything under it are
 * declared after the collection routes, so `GET /v1/admin/stock-counts` is
 * matched as the literal it is.
 *
 * Every non-GET route here is audit-logged automatically by `defineRoute`.
 */
export const adminStockCountsRouter: Router = Router();

const TAG = 'Admin stock counts';

/* ------------------------------------------------------------ collection */

defineRoute(adminStockCountsRouter, {
  method: 'get',
  path: '/v1/admin/stock-counts',
  surface: 'admin',
  operationId: 'adminListStockCounts',
  summary: 'List stock counts',
  description:
    'Count sheets, newest first. `?status=` takes a comma-separated list; an unrecognised value is a 400 ' +
    'rather than a silently empty page.\n\n' +
    'Each row carries the full roll-up — `itemsInScope`, `itemsCounted`, `itemsUncounted`, ' +
    '`itemsWithVariance`, `netVarianceQty` and `absVarianceQty` — computed over the WHOLE sheet, not over ' +
    'the page. `netVarianceQty` and `absVarianceQty` are both reported on purpose: a shelf where five ' +
    'units were put in the wrong bin nets to zero and is not a clean count, so a single "variance" figure ' +
    'would be the misleading one.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: countListQuery },
  responses: {
    200: { description: 'A page of count sheets.', schema: z.array(countSummary) },
    400: { description: 'An unrecognised status, kind, or an unparseable date bound.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await counts.listCounts(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminStockCountsRouter, {
  method: 'post',
  path: '/v1/admin/stock-counts',
  surface: 'admin',
  operationId: 'adminCreateStockCount',
  summary: 'Raise a stock count',
  description:
    'Creates a `draft` sheet and nothing else. **No quantities are frozen here** — that is `POST /start`, ' +
    'because a sheet frozen at creation would already be stale by the time somebody walks the aisle.\n\n' +
    'Omit `locationId` to count the whole warehouse. Set it to scope the count to one zone, rack, shelf or ' +
    'bin; the scope includes DESCENDANTS, so counting a zone counts every bin under it. The location must ' +
    'belong to the named warehouse — the mismatch is a 422 rather than an empty sheet that would later ' +
    'report a flawless count over zero items.\n\n' +
    '`countNo` (`CNT-2026-00001`) comes from `document_number_series` under a row lock, never from the ' +
    'application.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'create' },
  rateLimit: 'default',
  request: { body: createCountBody },
  responses: {
    201: { description: 'The draft count sheet.', schema: countSummary },
    404: { description: 'No such warehouse, or no such location.' },
    422: { description: '`location_warehouse_mismatch`.' },
  },
  handler: async ({ body, auth }) => created(await counts.createCount(body, auth)),
});

/* --------------------------------------------------------------- by count */

defineRoute(adminStockCountsRouter, {
  method: 'get',
  path: '/v1/admin/stock-counts/:countId',
  surface: 'admin',
  operationId: 'adminGetStockCount',
  summary: 'Get one stock count',
  description:
    'The sheet, its roll-up, one page of lines, and what may legally happen to it next — `transitions` is ' +
    'rendered from the state machine itself, so a UI that hides buttons from it can never offer an action ' +
    'the server will refuse.\n\n' +
    'Lines page separately from the collection (`?itemPage`, `?itemPerPage`, max 200) because a ' +
    'full-warehouse count has thousands of them. `?onlyVariances=true` is the approver’s work queue; ' +
    '`?uncountedOnly=true` is the counter’s. The header totals always cover the whole sheet regardless of ' +
    'which page of lines you asked for.\n\n' +
    '`varianceQty` on a line is `countedQty − systemQty`, or **null when nobody has counted it yet**. That ' +
    'is deliberately not the raw generated column, which reads `COALESCE(counted,0) − system` and would ' +
    'render an uncounted line as a full write-off.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: countIdParam, query: countDetailQuery },
  responses: {
    200: { description: 'The count, its lines and its legal next steps.', schema: countDetail },
    404: { description: 'No such stock count.' },
  },
  handler: async ({ params, query }) => ok(await counts.getCount(params.countId, query)),
});

defineRoute(adminStockCountsRouter, {
  method: 'post',
  path: '/v1/admin/stock-counts/:countId/start',
  surface: 'admin',
  operationId: 'adminStartStockCount',
  summary: 'Start counting — freezes the system quantities',
  description:
    '**This is the freeze.** Every inventory level in scope becomes a count line carrying the on-hand ' +
    'quantity as it is at this instant, written in ONE `INSERT … SELECT` so the whole sheet is a single ' +
    'consistent read rather than a walk that is already stale by row nine hundred.\n\n' +
    'That frozen `systemQty` is never re-read. If approval compared the count against live on-hand ' +
    'instead, every sale that happened while the counter walked the aisle would be silently absorbed and ' +
    'the variance would come out zero — a count that always agrees with itself finds nothing, which is ' +
    'exactly the failure a count exists to catch. Sales during the count remain their own `outbound` ' +
    'movements and the ledger stays additive.\n\n' +
    'Legal only from `draft`. An empty scope is `nothing_to_count` rather than a sheet that could be ' +
    'approved as a flawless count over zero items.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  request: { params: countIdParam, body: startCountBody },
  responses: {
    200: { description: 'The count, now `in_progress`, with `itemsInScope` frozen.', schema: countSummary },
    404: { description: 'No such stock count.' },
    422: { description: '`illegal_count_transition`, `nothing_to_count`, or `count_location_missing`.' },
  },
  handler: async ({ params, body, auth }) => ok(await counts.startCount(params.countId, body, auth)),
});

defineRoute(adminStockCountsRouter, {
  method: 'post',
  path: '/v1/admin/stock-counts/:countId/items',
  surface: 'admin',
  operationId: 'adminSubmitStockCountItems',
  summary: 'Record counted quantities',
  description:
    'Records what was physically counted. Call it as many times as the counting takes — a handheld ' +
    'submitting one bin at a time and a spreadsheet upload of five hundred lines use the same endpoint.\n\n' +
    '**Only while the count is `in_progress`.** A draft has no frozen `systemQty` to measure against, and a ' +
    'completed or approved sheet has numbers an approver has already reviewed; either is refused with the ' +
    'stable code `count_not_in_progress` and a message saying which it is.\n\n' +
    '**Every SKU must already be on the sheet.** Scope is the set of levels frozen at start, so a SKU that ' +
    'is stocked in the warehouse but sits outside the count’s location subtree is refused with ' +
    '`sku_not_in_count_scope` rather than quietly widened. The same SKU twice in one submission is ' +
    '`duplicate_count_item` — which of the two numbers is the count is not something insertion order ' +
    'should decide.\n\n' +
    'All-or-nothing: one bad line rejects the whole submission and writes nothing. `countedQty: 0` is a ' +
    'legitimate answer meaning the bin is empty, and is entirely different from leaving the line ' +
    'uncounted.\n\n' +
    'Nothing here moves stock.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  request: { params: countIdParam, body: submitCountItemsBody },
  responses: {
    200: { description: 'The lines as they now stand, plus the roll-up over the whole sheet.', schema: submitItemsResult },
    404: { description: 'No such stock count.' },
    422: { description: '`count_not_in_progress`, `sku_not_in_count_scope`, or `duplicate_count_item`.' },
  },
  handler: async ({ params, body, auth }) => ok(await counts.submitItems(params.countId, body, auth)),
});

defineRoute(adminStockCountsRouter, {
  method: 'post',
  path: '/v1/admin/stock-counts/:countId/complete',
  surface: 'admin',
  operationId: 'adminCompleteStockCount',
  summary: 'Finish counting',
  description:
    'Marks the counting done and stamps `completedAt`. **No stock moves here** — completion is not ' +
    'approval, and separating them is what gives a second person something to review.\n\n' +
    'A sheet where nothing was counted is refused (`nothing_counted`): completing it would produce a ' +
    'document asserting that a warehouse was checked when no shelf was walked.\n\n' +
    'A sheet with SOME lines uncounted is refused unless `allowUncounted: true`. Uncounted lines are ' +
    'skipped at approval, never written off — but a signed-off count that silently omits them claims those ' +
    'SKUs were checked when they were not, so the partial count has to be deliberate.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  request: { params: countIdParam, body: completeCountBody },
  responses: {
    200: { description: 'The count, now `completed`.', schema: countSummary },
    404: { description: 'No such stock count.' },
    422: { description: '`illegal_count_transition`, `nothing_counted`, or `uncounted_items`.' },
  },
  handler: async ({ params, body }) => ok(await counts.completeCount(params.countId, body)),
});

defineRoute(adminStockCountsRouter, {
  method: 'post',
  path: '/v1/admin/stock-counts/:countId/approve',
  surface: 'admin',
  operationId: 'adminApproveStockCount',
  summary: 'Approve the count and post the variance',
  description:
    'The only step that touches stock, gated on `inventory:approve` — walking a shelf and authorising a ' +
    'write-off are different jobs.\n\n' +
    'One transaction. The count row is locked, every varying level is locked in ascending ' +
    '`inventory_level_id` order (§62, so an approval and a checkout queue instead of deadlocking), and for ' +
    'each line an ADJUSTMENT of exactly `countedQty − systemQty` is posted as a `stock_count` movement ' +
    'referenced to `stock_count`/`countNo`, carrying the balance its own conditional UPDATE returned. If ' +
    'any line fails, none of it happened.\n\n' +
    '**It is an adjustment, never an assignment.** No statement anywhere sets `on_hand_qty = countedQty`; ' +
    'that would leave no ledger row and break the property that `SUM(quantity_delta)` reconstructs on-hand.\n\n' +
    'A line counted exactly right writes NO movement — a movement of nothing is not a movement — so ' +
    '`itemsAdjusted` is smaller than `itemsCounted` on a healthy count. Uncounted lines are skipped ' +
    'entirely and reported as `itemsSkippedUncounted`; they are never treated as a count of zero.\n\n' +
    'A shortfall that would drive stock below what is already RESERVED is refused with ' +
    '`insufficient_stock` and nothing is written. Those units are promised to open orders, and a count ' +
    'that "fixed" a number by breaking a delivery has not fixed anything. The message names the remedies: ' +
    'recount in case the stock is in another bin, release stale reservations, or let the order’s own ' +
    'outbound movement record the pick and recount after.\n\n' +
    'Requires an `Idempotency-Key`. A retry with the same key replays the stored response; a second ' +
    'genuine approval is refused with `count_already_approved`, because the ledger is append-only and ' +
    'posting the variance twice would double it.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'approve' },
  rateLimit: 'default',
  idempotent: true,
  request: { params: countIdParam, body: approveCountBody },
  responses: {
    200: { description: 'The approved count and one entry per movement posted.', schema: countApprovalResult },
    400: { description: 'Missing or malformed `Idempotency-Key`.' },
    404: { description: 'No such stock count.' },
    409: { description: 'That `Idempotency-Key` was used with a different body, or a first attempt is still in flight.' },
    422: { description: '`count_not_completed`, `count_already_approved`, `illegal_count_transition`, or `insufficient_stock` — nothing was posted.' },
  },
  handler: async ({ params, body, auth }) => ok(await counts.approveCount(params.countId, body, auth)),
});
