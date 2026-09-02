import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok, paginated, pageMeta, raw } from '../../lib/http.js';
import * as inventory from './admin-inventory.service.js';
import {
  adjustmentBody,
  adjustmentResult,
  alertListQuery,
  availabilityQuery,
  availabilityResponse,
  bulkAdjustBody,
  bulkAdjustResult,
  dashboardQuery,
  flatInventoryLevel,
  inventoryAuditEvent,
  inventoryAuditQuery,
  inventoryDashboard,
  inventoryDetail,
  inventoryExportQuery,
  inventoryLevelSummary,
  inventoryListQuery,
  inventoryNotification,
  inventoryNotificationQuery,
  movementIdParam,
  movementListQuery,
  purchaseDraftBody,
  purchaseDraftResponse,
  releaseReservationBody,
  reorderLine,
  reorderListQuery,
  reservationBody,
  reservationIdParam,
  reservationListQuery,
  reservationResponse,
  skuParam,
  stockMovementResponse,
} from './admin-inventory.schemas.js';

/**
 * Inventory core — the stock desk.
 *
 * Phase 1 of the inventory system: what is in stock, what moved, what is running
 * out, and what to buy. Warehouses and suppliers already exist through the
 * generic resource engine and are deliberately not rebuilt here; transfers,
 * purchase orders, goods receipts, counts and production are later phases.
 *
 * **Route order is load-bearing.** Express matches in declaration order, so every
 * literal segment — `/dashboard`, `/movements`, `/alerts/*`, `/reorder`,
 * `/reservations`, `/audit`, `/notifications`, `/export` — is declared BEFORE
 * `/:sku`. Move one below it and `GET /v1/admin/inventory/movements` starts
 * looking up a product variant with the SKU "movements" and 404s.
 *
 * Everything that changes stock is `idempotent: true`, so a retried POST after a
 * network stall replays the stored response instead of adjusting twice. Every
 * non-GET route here is also audit-logged automatically by `defineRoute`.
 */
export const adminInventoryRouter: Router = Router();

const TAG = 'Admin inventory';

/** `Idempotency-Key` reaches the service so the write can be tied to the request. */
const requestIdOf = (req: { requestId?: string }): string | null => req.requestId ?? null;

/* ------------------------------------------------------------- dashboard */

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/dashboard',
  surface: 'admin',
  operationId: 'adminInventoryDashboard',
  summary: 'Inventory dashboard',
  description:
    'The header strip for the inventory console, computed in the database rather than by summing whatever ' +
    'page happens to be loaded — the console currently derives "stock value" from the twenty-five rows in ' +
    'memory, which makes it mean "stock value of these twenty-five".\n\n' +
    '`stockValuePaise` is on-hand at unit cost in integer paise. Items with no recorded cost contribute ' +
    'ZERO rather than an estimate: a valuation that quietly invents numbers is worse than one with a ' +
    'visible hole in it.\n\n' +
    '`lowStockCount` and `outOfStockCount` are counted against the GENERATED `available_qty` column, so ' +
    'they can never disagree with the list screens. `reorderCount` is different and larger in scope: it ' +
    'uses the inventory POSITION (`on hand − reserved + incoming`), because an item with a purchase order ' +
    'already in flight does not need a second one.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: dashboardQuery },
  responses: {
    200: { description: 'Network totals plus a per-warehouse breakdown.', schema: inventoryDashboard },
    400: { description: 'Unparseable filter.' },
  },
  handler: async ({ query }) => ok(await inventory.dashboard(query)),
});

/* ------------------------------------------------------------------ list */

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory',
  surface: 'admin',
  operationId: 'adminListInventory',
  summary: 'List stock levels',
  description:
    'One row per (item, warehouse) — stock is per stockable per warehouse and there is no global figure, ' +
    'which is the single largest difference from the three conflicting stock fields this replaces.\n\n' +
    '`inventory_levels` is polymorphic: a row is a finished `variant`, a loose `hamper_item`, or a ' +
    '`packaging` material. Filter with `?kind=`.\n\n' +
    '`availableQty` is a GENERATED column (`on_hand_qty - reserved_qty`), so it cannot drift from the two ' +
    'numbers beside it. `?state=` filters on it: `out` is nothing sellable, `low` is at or below the ' +
    'reorder point, `in` is above. `?belowReorderPoint=true` is deliberately NOT the same filter — it uses ' +
    'the inventory position including incoming stock, which is the buying question rather than the ' +
    'selling one.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: inventoryListQuery },
  responses: {
    200: { description: 'A page of stock levels.', schema: z.array(flatInventoryLevel) },
    400: { description: 'An unrecognised filter value.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await inventory.listInventory(query);
    const flatItems = items.map(item => ({
      id: item.id,
      variantId: item.item.kind === 'variant' ? item.item.id : null,
      sku: item.item.sku,
      productTitle: item.item.name,
      warehouseId: item.warehouseId,
      warehouseName: item.warehouseName,
      warehouseCode: item.warehouseCode,
      onHandQty: item.onHandQty,
      reservedQty: item.reservedQty,
      availableQty: item.availableQty,
      reorderPoint: item.reorderPoint,
      unitCostPaise: item.unitCostPaise,
      stockValuePaise: item.stockValuePaise,
      status: item.state === 'in' ? 'in_stock' : item.state === 'low' ? 'low_stock' : 'out_of_stock',
      updatedAt: item.lastMovementAt,
    }));
    return paginated(flatItems, pageMeta(total, query.page, query.perPage));
  },
});

/* ------------------------------------------------------------- movements */

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/movements',
  surface: 'admin',
  operationId: 'adminListStockMovements',
  summary: 'The stock ledger',
  description:
    'Append-only. Every change to on-hand stock is exactly one row here, and nothing ever updates or ' +
    'deletes one — a correction is a NEW movement with the opposite sign (§10). That is what makes ' +
    '`balanceAfter` trustworthy: the running on-hand balance immediately after each movement, from which ' +
    'any historical position can be reconstructed without replaying the whole table.\n\n' +
    'Reservations do NOT appear here. A hold moves `reservedQty` and nothing physical has moved, so a ' +
    'ledger row for it would double-count against `balanceAfter` the moment the goods actually shipped.\n\n' +
    '`?movementType=` and `?referenceType=` take comma-separated lists; an unrecognised value is a 400 ' +
    'rather than a silently empty page. `?referenceId=` returns everything one document did — one order, ' +
    'one goods receipt, one transfer. Movement ids are BIGINT and travel as decimal STRINGS; a JSON number ' +
    'would lose precision past 2^53.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: movementListQuery },
  responses: {
    200: { description: 'A page of ledger entries, newest first.', schema: z.array(stockMovementResponse) },
    400: { description: 'An unrecognised movement type, reference type, or an unparseable date.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await inventory.listMovements(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/movements/:movementId',
  surface: 'admin',
  operationId: 'adminGetStockMovement',
  summary: 'Get one ledger entry',
  description:
    'The single movement, with the item, warehouse and document it belongs to resolved. There is no PATCH ' +
    'and no DELETE beside it, and there never will be — see the ledger note on the list endpoint.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: movementIdParam },
  responses: {
    200: { description: 'The movement.', schema: stockMovementResponse },
    404: { description: 'No such movement.' },
  },
  handler: async ({ params }) => ok(await inventory.getMovement(params.movementId)),
});

/* ----------------------------------------------------------- adjustments */

defineRoute(adminInventoryRouter, {
  method: 'post',
  path: '/v1/admin/inventory/adjustments',
  surface: 'admin',
  operationId: 'adminAdjustInventory',
  summary: 'Adjust stock',
  description:
    'One transaction: lock the level, validate, update `inventory_levels`, append the movement with the ' +
    'balance the update actually returned, commit. There is no path where the level moves and the ledger ' +
    'does not.\n\n' +
    'A decrement that would take SELLABLE stock below zero is refused with the stable code ' +
    '`insufficient_stock` — note *sellable*, not on-hand: units already reserved for a paid order are ' +
    'physically present but spoken for, and letting an adjustment eat them turns someone else’s confirmed ' +
    'order into a stockout at picking time. The refusal is enforced by a conditional ' +
    '`UPDATE … WHERE on_hand − reserved + delta >= 0` whose affected-row count is checked, which is ' +
    'race-free at READ COMMITTED; the `inventory_no_oversell` CHECK behind it is a backstop, never flow ' +
    'control.\n\n' +
    '`movementType` is restricted to the seven types a human may post by hand. Transfer and production ' +
    'types are excluded because each is half of a pair that must move together, and `stock_count` is ' +
    'excluded because §40 says a count posts its variance only through approval.\n\n' +
    'To undo an adjustment, post the opposite one. The ledger is append-only and this endpoint will never ' +
    'edit a movement.\n\n' +
    'Requires an `Idempotency-Key`. A retry with the same key and body replays the stored response; the ' +
    'same key with a different body is a 409, because silently returning the first response would hide a ' +
    'client bug that is about to double-adjust something.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  idempotent: true,
  request: { body: adjustmentBody },
  responses: {
    200: { description: 'The level after the change, and the movement it wrote.', schema: adjustmentResult },
    400: { description: 'Missing or malformed `Idempotency-Key`.' },
    404: { description: 'No such SKU, or no such warehouse.' },
    409: { description: 'That `Idempotency-Key` was used with a different body, or a first attempt is still in flight.' },
    422: { description: '`insufficient_stock`, or the item is not stocked at that warehouse (`no_inventory_level`).' },
  },
  handler: async ({ body, auth, req }) => ok(await inventory.adjust(body, auth, requestIdOf(req))),
});

defineRoute(adminInventoryRouter, {
  method: 'post',
  path: '/v1/admin/inventory/bulk-adjust',
  surface: 'admin',
  operationId: 'adminBulkAdjustInventory',
  summary: 'Adjust many SKUs at once',
  description:
    'All-or-nothing in ONE transaction — unlike the order desk’s bulk action, which reports per-order ' +
    'outcomes. Stock is different: a stocktake correction that half-applied leaves a warehouse in a state ' +
    'nobody chose and nobody can describe. Every line succeeds or nothing is written.\n\n' +
    '**Each SKU still gets its own movement row.** The batch is a unit of atomicity, not a unit of ' +
    'bookkeeping; one movement covering fifty SKUs would be unusable for reconciling any of them.\n\n' +
    'Levels are locked in a single statement in ascending `inventory_level_id` order, and the work is ' +
    'sorted the same way. Without that, batch A holding level 1 and wanting level 2 deadlocks against ' +
    'batch B holding 2 and wanting 1 — PostgreSQL would detect it and abort one, but a `deadlock_timeout` ' +
    'stall is not an acceptable way to find out (§62).\n\n' +
    'Every (`sku`, `warehouseId`) pair must be distinct. Two deltas against one level in one batch is ' +
    'ambiguous about which movement’s `balanceAfter` comes first, so it is refused rather than guessed at.\n\n' +
    'Validation is front-loaded: unknown SKUs and items not stocked at the named warehouse come back as ' +
    'field-level issues BEFORE any lock is taken.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  idempotent: true,
  request: { body: bulkAdjustBody },
  responses: {
    200: { description: 'One result per line, in the deterministic lock order.', schema: bulkAdjustResult },
    400: { description: 'Missing or malformed `Idempotency-Key`.' },
    404: { description: 'A warehouse in the batch does not exist.' },
    409: { description: 'That `Idempotency-Key` was used with a different body.' },
    422: { description: '`unknown_sku`, `duplicate_target`, `no_inventory_level`, or `insufficient_stock` on any line — nothing was written.' },
  },
  handler: async ({ body, auth, req }) => ok(await inventory.bulkAdjust(body, auth, requestIdOf(req))),
});

/* ---------------------------------------------------------------- alerts */

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/alerts/low-stock',
  surface: 'admin',
  operationId: 'adminListLowStock',
  summary: 'Low-stock alerts',
  description:
    'Levels with sellable stock above zero but at or below their reorder point — the ones that will run ' +
    'out, ordered most urgent first. Backed by the partial index `idx_inventory_low`, so this stays cheap ' +
    'as the catalogue grows.\n\n' +
    'An item at zero is NOT here; it is already out, and mixing the two makes the list unusable as a work ' +
    'queue. See `/alerts/out-of-stock`.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: alertListQuery },
  responses: {
    200: { description: 'A page of low-stock levels.', schema: z.array(inventoryLevelSummary) },
    400: { description: 'An unrecognised filter value.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await inventory.listLowStock(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/alerts/out-of-stock',
  surface: 'admin',
  operationId: 'adminListOutOfStock',
  summary: 'Out-of-stock alerts',
  description:
    'Levels with nothing sellable — `availableQty <= 0`. A row can appear here while `onHandQty` is ' +
    'positive: every unit is reserved. That is the honest reading, because those units are already ' +
    'promised and cannot be sold again.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: alertListQuery },
  responses: {
    200: { description: 'A page of out-of-stock levels.', schema: z.array(inventoryLevelSummary) },
    400: { description: 'An unrecognised filter value.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await inventory.listOutOfStock(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

/* --------------------------------------------------------------- reorder */

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/reorder',
  surface: 'admin',
  operationId: 'adminListReorderSuggestions',
  summary: 'What to buy',
  description:
    'The buying queue. A level qualifies when its inventory POSITION — `on hand − reserved + incoming` — ' +
    'is at or below its reorder point. Incoming counts, otherwise every item with a purchase order ' +
    'already in flight is re-ordered, which is how a warehouse ends up with four months of ribbon. ' +
    'Reserved does not count as cover, because those units are leaving the building.\n\n' +
    'The formula lives in ONE documented function (`reorderSuggestion` in `admin-inventory.stock.ts`), ' +
    'shared with the purchase-draft endpoint, so the alert screen and the order that follows it can never ' +
    'disagree:\n\n' +
    '```\ntarget    = reorderPoint + reorderQty\nshortfall = max(0, target - position)\nsuggested = ceil(max(shortfall, 1) / moq) * moq\n```\n\n' +
    'Suggestions are rounded UP to the supplier’s MOQ, never down — a purchase order the supplier will ' +
    'reject is not a saving. The supplier shown is the one flagged preferred (`supplier_products` has a ' +
    'partial unique index guaranteeing at most one per variant), falling back to the cheapest with ' +
    '`isPreferredSupplier: false` so the buyer can see the difference.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: reorderListQuery },
  responses: {
    200: { description: 'A page of reorder suggestions, biggest shortfall first.', schema: z.array(reorderLine) },
    400: { description: 'An unrecognised filter value.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await inventory.listReorder(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminInventoryRouter, {
  method: 'post',
  path: '/v1/admin/inventory/reorder/purchase-draft',
  surface: 'admin',
  operationId: 'adminCreatePurchaseDraft',
  summary: 'Draft a purchase order from the reorder suggestions',
  description:
    'Creates ONE purchase order with status `draft` for one supplier and one warehouse. **It never sends ' +
    'anything to a supplier** — that is `POST /purchase-orders/:poId/send`, behind its own permission. A ' +
    'draft is a document a buyer reviews and edits.\n\n' +
    'With no `lines`, the draft is generated from the reorder engine: everything this supplier supplies ' +
    'that is at or below its reorder point in this warehouse, at the suggested quantity, optionally ' +
    'narrowed with `skus`. With `lines`, the buyer’s quantities are used instead — but still rounded UP ' +
    'to the supplier’s MOQ.\n\n' +
    'Nothing to order is a 422 (`nothing_to_order`), not an empty purchase order: an empty document in the ' +
    'PO list is a false signal that someone ordered something.\n\n' +
    '`taxPaise` is always 0 on a draft. GST is resolved when the goods are received and invoiced, and a ' +
    'guessed figure here would be a statutory number nobody computed. The number comes from ' +
    '`document_number_series` under a row lock; no active series for the year is a 422 rather than an ' +
    'improvised number that collides with the real series later.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'create' },
  rateLimit: 'default',
  request: { body: purchaseDraftBody },
  responses: {
    201: { description: 'The draft purchase order and its lines.', schema: purchaseDraftResponse },
    404: { description: 'No such supplier, or no such warehouse.' },
    422: { description: '`nothing_to_order`, `unknown_sku`, `supplier_archived`, or `no_document_series`.' },
  },
  handler: async ({ body, auth, req }) => created(await inventory.createPurchaseDraft(body, auth, requestIdOf(req))),
});

/* ---------------------------------------------------------- reservations */

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/reservations',
  surface: 'admin',
  operationId: 'adminListInventoryReservations',
  summary: 'List stock holds',
  description:
    'Every hold against stock, whatever placed it: a `cart` (which expires), an `order` (which never ' +
    'does), a `quotation`, or a `manual_hold` placed here.\n\n' +
    '`?status=active` — the default — means unreleased AND unexpired, which is the set actually consuming ' +
    '`reservedQty` right now. `released` and `expired` are separate because they are different questions: ' +
    'one was let go deliberately, the other simply lapsed.\n\n' +
    'This is the screen to open when `onHandQty` is healthy and `availableQty` is not.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: reservationListQuery },
  responses: {
    200: { description: 'A page of holds.', schema: z.array(reservationResponse) },
    400: { description: 'An unrecognised filter value.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await inventory.listReservations(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminInventoryRouter, {
  method: 'post',
  path: '/v1/admin/inventory/reservations',
  surface: 'admin',
  operationId: 'adminCreateInventoryReservation',
  summary: 'Hold stock by hand',
  description:
    'Puts units beyond the reach of the storefront — for a corporate quote being negotiated, a photoshoot, ' +
    'a replacement being held for a support case.\n\n' +
    '**A hold moves `reservedQty` and nothing else.** `onHandQty` is untouched, because the units have not ' +
    'moved, and NO `stock_movements` row is written: the ledger records physical movement, and a hold in ' +
    'it would double-count against `balanceAfter` the moment the goods actually shipped (§14). The effect ' +
    'is recorded in the activity log instead, where the before/after pair shows `onHandQty` unchanged.\n\n' +
    'The hold is refused with `insufficient_stock` when it will not fit in current sellable stock, using ' +
    'the same conditional-UPDATE guard as an adjustment.\n\n' +
    'The reason is always `manual_hold`. The `reservation_has_owner` CHECK requires a cart or an order for ' +
    'every other reason, and this endpoint has neither — cart and order holds are placed by checkout, ' +
    'inside the transaction that creates them.\n\n' +
    'Omit `expiresAt` for an open-ended hold. Note that the expiry sweeper only touches holds that carry ' +
    'one, so an open-ended hold stays until a person releases it — which is the point, and also the risk.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  idempotent: true,
  request: { body: reservationBody },
  responses: {
    201: { description: 'The hold.', schema: reservationResponse },
    400: { description: 'Missing or malformed `Idempotency-Key`.' },
    404: { description: 'No such SKU, or no such warehouse.' },
    409: { description: 'That `Idempotency-Key` was used with a different body.' },
    422: { description: '`insufficient_stock`, `no_inventory_level`, or `expiry_in_past`.' },
  },
  handler: async ({ body, auth, req }) => created(await inventory.createReservation(body, auth, requestIdOf(req))),
});

defineRoute(adminInventoryRouter, {
  method: 'post',
  path: '/v1/admin/inventory/reservations/:id/release',
  surface: 'admin',
  operationId: 'adminReleaseInventoryReservation',
  summary: 'Release a stock hold',
  description:
    'Stamps `releasedAt` and returns the units to sellable stock in one transaction, under the level’s row ' +
    'lock so the decrement cannot interleave with a checkout reserving the same level.\n\n' +
    'Releasing an already-released hold is a 422, not a silent success. Decrementing `reservedQty` twice ' +
    'for one hold is exactly how phantom inventory appears — stock the system believes is sellable and the ' +
    'shelf does not have.\n\n' +
    'Works on any hold, including one placed by a cart or an order. Releasing an order-backed hold does ' +
    'not cancel the order; if that is what you meant, cancel the order and let it release its own stock.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  request: { params: reservationIdParam, body: releaseReservationBody },
  responses: {
    200: { description: 'The hold, after release.', schema: reservationResponse },
    404: { description: 'No such reservation.' },
    422: { description: '`reservation_already_released`.' },
  },
  handler: async ({ params, body, auth, req }) =>
    ok(await inventory.releaseReservation(params.id, body.reason, auth, requestIdOf(req))),
});

/* ----------------------------------------------------------------- audit */

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/audit',
  surface: 'admin',
  operationId: 'adminListInventoryAudit',
  summary: 'Who changed stock, and what the numbers were',
  description:
    'The STATE-level trail from `activity_logs`, restricted to inventory entities. Each entry carries ' +
    '`beforeData` and `afterData` as queryable JSONB — the actual quantities — rather than a rendered ' +
    'string like "₹12,400 → ₹11,900" that cannot be diffed, queried or replayed.\n\n' +
    'This is complementary to the automatic request-level audit `defineRoute` applies to every non-GET ' +
    'admin route, not a duplicate of it. A request log records who called what from where; it cannot tell ' +
    'you what the number was. This one can, and cannot tell you the IP.\n\n' +
    'Distinct from `/movements` too: the ledger is the record of PHYSICAL movement and includes system ' +
    'movements with no human behind them. This is the record of human action, and includes reservations, ' +
    'which never touch the ledger.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: inventoryAuditQuery },
  responses: {
    200: { description: 'A page of audit entries, newest first.', schema: z.array(inventoryAuditEvent) },
    400: { description: 'An unparseable date bound.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await inventory.listAudit(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

/* --------------------------------------------------------- notifications */

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/notifications',
  surface: 'admin',
  operationId: 'adminListInventoryNotifications',
  summary: 'Inventory notifications',
  description:
    'The inventory slice of the staff notification feed — stockouts, low-stock warnings, expiring holds, ' +
    'overdue purchase orders.\n\n' +
    'Returns both notifications addressed to you personally and broadcasts (`staff_user_id IS NULL`). ' +
    'Filtering to "mine only" would hide every broadcast stockout alert, which is most of them.\n\n' +
    'Read-only here. Marking one read belongs to the notification module, which owns the whole feed.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: inventoryNotificationQuery },
  responses: {
    200: { description: 'A page of notifications, newest first.', schema: z.array(inventoryNotification) },
    400: { description: 'An unrecognised filter value.' },
  },
  handler: async ({ query, auth }) => {
    const { items, total } = await inventory.listNotifications(query, auth);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

/* ---------------------------------------------------------------- export */

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/export',
  surface: 'admin',
  operationId: 'adminExportInventory',
  summary: 'Export stock levels',
  description:
    'A flat file of the current position, for the spreadsheet the warehouse actually works from. `csv` by ' +
    'default, delivered as an attachment with CRLF line endings and every field quoted — an unquoted bin ' +
    'location containing a comma silently shifts every column after it, which is the classic way an ' +
    'export becomes wrong without looking wrong.\n\n' +
    'Money stays in integer paise, unconverted. A CSV that says `149900` is unambiguous; one that says ' +
    '`1499.00` has already made a rounding decision on the reader’s behalf.\n\n' +
    'Capped at 50,000 rows and gated on `inventory:export`, which is a separate grant from `inventory:view` ' +
    '— reading one screen and walking out with the whole stock position are different acts. The `export` ' +
    'rate limiter allows 20 per hour per user.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'export' },
  rateLimit: 'export',
  request: { query: inventoryExportQuery },
  responses: {
    200: {
      description: 'A CSV attachment, or the same rows as JSON when `?format=json`.',
      schema: z.array(inventoryLevelSummary),
      envelope: false,
    },
    400: { description: 'An unrecognised filter value.' },
  },
  handler: async ({ query, res }) => {
    const rows = await inventory.exportInventory(query);

    if (query.format === 'json') return ok(rows);

    const filename = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(inventory.toCsv(rows));
    return raw();
  },
});

/* --------------------------------------------------------------- by SKU */
/*
 * Everything below matches a path SEGMENT as an SKU. Nothing may be declared
 * after it that is not genuinely SKU-shaped.
 */

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/:sku/availability',
  surface: 'admin',
  operationId: 'adminGetSkuAvailability',
  summary: 'Can we promise this?',
  description:
    'The narrow question, answered per warehouse and across the network. Pass `?quantity=` to get a ' +
    'straight yes or no.\n\n' +
    '`canFulfil` is true when ONE warehouse can cover the quantity. ' +
    '`canFulfilAcrossWarehouses` is true when the network total covers it. They are reported separately ' +
    'and deliberately not conflated: the second needs a split shipment to be true, which is a fulfilment ' +
    'decision with a real cost attached, not an availability fact.\n\n' +
    '`state` is the `in`/`low`/`out` value the STOREFRONT should surface (§16). Never publish the raw ' +
    'number: it invites scraping the whole catalogue’s stock position, and it is wrong the instant ' +
    'someone else’s cart holds two of them.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: skuParam, query: availabilityQuery },
  responses: {
    200: { description: 'Availability, per warehouse and in total.', schema: availabilityResponse },
    404: { description: 'No active item carries that SKU.' },
  },
  handler: async ({ params, query }) => ok(await inventory.getAvailability(params.sku, query)),
});

defineRoute(adminInventoryRouter, {
  method: 'get',
  path: '/v1/admin/inventory/:sku',
  surface: 'admin',
  operationId: 'adminGetInventoryBySku',
  summary: 'Everything about one SKU',
  description:
    'The whole workspace in one call: the warehouse-by-warehouse breakdown, the last twenty ledger ' +
    'entries across every warehouse, every hold currently consuming stock, and the open purchase-order ' +
    'lines still owed.\n\n' +
    'The SKU is resolved against `product_variants.sku` first, then `hamper_items.sku`, then ' +
    '`packaging_materials.sku` — the three things this business stocks. Each has a partial unique index ' +
    'excluding soft-deleted rows, so a discontinued item never shadows a live one.\n\n' +
    '`incoming` lists only OPEN purchase-order lines (`draft`, `sent`, `partially_received`) with ' +
    '`outstandingQty` computed from absolute quantities, not the percentage the old console stored. A ' +
    'received or cancelled order is not incoming stock.\n\n' +
    'Declared last of the GET routes so that `/movements`, `/alerts/*`, `/reorder`, `/reservations`, ' +
    '`/audit`, `/notifications`, `/export` and `/dashboard` are matched as the literals they are.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: skuParam },
  responses: {
    200: { description: 'The item, its levels, its recent history and what is inbound.', schema: inventoryDetail },
    404: { description: 'No active item carries that SKU.' },
  },
  handler: async ({ params }) => ok(await inventory.getBySku(params.sku)),
});
