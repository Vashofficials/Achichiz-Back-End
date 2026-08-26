import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok, paginated, pageMeta } from '../../lib/http.js';
import * as warehousing from './admin-warehousing.service.js';
import {
  cancelTransferBody,
  createLocationBody,
  createTransferBody,
  locationListQuery,
  locationParams,
  locationResponse,
  receiveTransferBody,
  transferDetail,
  transferIdParam,
  transferListQuery,
  transferSummary,
  updateLocationBody,
  warehouseIdParam,
  warehouseInventoryQuery,
  warehouseInventoryRow,
} from './admin-warehousing.schemas.js';

/**
 * Warehousing — the two sub-resources the generic engine cannot serve.
 *
 * `/v1/admin/warehouses` itself already has seven CRUD endpoints from
 * `admin-resources`. Nothing here rebuilds them. What is added is the part the
 * engine has no shape for: a self-referencing location tree whose `path` is
 * derived rather than stored by the client, and transfers, which are
 * parent+lines documents whose writes are state transitions with stock side
 * effects — the same reason `admin-orders` is bespoke.
 */
export const adminWarehousingRouter: Router = Router();

const LOCATIONS_TAG = 'Admin warehousing';
const TRANSFERS_TAG = 'Admin transfers';

/* ============================================================== locations */

defineRoute(adminWarehousingRouter, {
  method: 'get',
  path: '/v1/admin/warehouses/:warehouseId/locations',
  surface: 'admin',
  operationId: 'adminListWarehouseLocations',
  summary: 'List bin locations in a warehouse',
  description:
    'The zone → rack → shelf → bin tree, flattened and sorted by `path` so the default ordering is also ' +
    'the tree order. Filter by `kind`, by `parentId` for one level of children, or by `pickable` to get ' +
    'only the locations a pick list may route to.\n\n' +
    '`?q=` matches path, code and name. Archived locations are excluded unless `includeArchived=true` — ' +
    'they are soft-deleted (§96) because the movement ledger still names them.\n\n' +
    '`depth` and `childCount` come back on every row so the console can render the tree without a ' +
    'second call per node.',
  tags: [LOCATIONS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: warehouseIdParam, query: locationListQuery },
  responses: {
    200: { description: 'A page of locations.', schema: z.array(locationResponse) },
    404: { description: 'No such warehouse.' },
  },
  handler: async ({ params, query }) => {
    const { items, total } = await warehousing.listLocations(params.warehouseId, query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminWarehousingRouter, {
  method: 'post',
  path: '/v1/admin/warehouses/:warehouseId/locations',
  surface: 'admin',
  operationId: 'adminCreateWarehouseLocation',
  summary: 'Create a bin location',
  description:
    '`path` is **not** accepted in the body. The service builds it from the parent chain — ' +
    '`A` + `R3` + `S2` + `B7` becomes `A/R3/S2/B7` — because a client-settable materialised path is a ' +
    'denormalisation that has stopped being derived from anything, and the first wrong value sends a ' +
    'picker to the wrong aisle.\n\n' +
    'A child must sit strictly deeper than its parent. It may skip levels — a zone straight to a bin is ' +
    'a legitimate small studio — but a shelf inside a bin is 422 `invalid_location_depth`. A parent in ' +
    'another warehouse is 422; paths are unique per warehouse, so that would quietly start a second tree.',
  tags: [LOCATIONS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'create' },
  rateLimit: 'default',
  request: { params: warehouseIdParam, body: createLocationBody },
  responses: {
    201: { description: 'The created location.', schema: locationResponse },
    404: { description: 'No such warehouse, or no such parent location.' },
    422: { description: 'Duplicate path, illegal depth, an archived parent, or a parent in another warehouse.' },
  },
  handler: async ({ params, body }) => created(await warehousing.createLocation(params.warehouseId, body)),
});

defineRoute(adminWarehousingRouter, {
  method: 'get',
  path: '/v1/admin/warehouses/:warehouseId/locations/:locationId',
  surface: 'admin',
  operationId: 'adminGetWarehouseLocation',
  summary: 'Get one bin location',
  description:
    'Includes `childCount` and `stockedLevelCount` — the two numbers that decide whether it can be ' +
    'archived, so the console can disable the button rather than discover the 422.',
  tags: [LOCATIONS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: locationParams },
  responses: {
    200: { description: 'The location.', schema: locationResponse },
    404: { description: 'No such location in this warehouse.' },
  },
  handler: async ({ params }) => ok(await warehousing.getLocation(params.warehouseId, params.locationId)),
});

defineRoute(adminWarehousingRouter, {
  method: 'patch',
  path: '/v1/admin/warehouses/:warehouseId/locations/:locationId',
  surface: 'admin',
  operationId: 'adminUpdateWarehouseLocation',
  summary: 'Rename or move a bin location',
  description:
    'Changing `parentId` or `code` rewrites `path` for this location **and every descendant** in the ' +
    'same transaction. A grandchild left holding the old prefix would be a bin that exists in the ' +
    'database and nowhere in the warehouse.\n\n' +
    'A `parentId` that sits inside this location’s own subtree is 422 `location_cycle`. The database ' +
    'CHECK only catches the trivial self-parent case; a three-node ring is caught here, before a ' +
    'recursive walk has anything to fail to terminate on.\n\n' +
    '`kind` is deliberately not editable — turning a rack into a bin while it still has shelves under it ' +
    'is not a rename, it is a restructure, and re-parenting the subtree is the honest way to say so.',
  tags: [LOCATIONS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  request: { params: locationParams, body: updateLocationBody },
  responses: {
    200: { description: 'The updated location.', schema: locationResponse },
    404: { description: 'No such location, or no such new parent.' },
    422: { description: 'A cycle, a duplicate path, an illegal depth, or the location is archived.' },
  },
  handler: async ({ params, body }) =>
    ok(await warehousing.updateLocation(params.warehouseId, params.locationId, body)),
});

defineRoute(adminWarehousingRouter, {
  method: 'post',
  path: '/v1/admin/warehouses/:warehouseId/locations/:locationId/archive',
  surface: 'admin',
  operationId: 'adminArchiveWarehouseLocation',
  summary: 'Archive a bin location',
  description:
    'Soft delete (§96) — the movement ledger still names this location, so the row stays and the partial ' +
    'unique index frees the path for reuse.\n\n' +
    'Refused while it has live children (they would point at a dead parent) or while inventory levels ' +
    'are still stored there (they would claim a bin that no longer exists). Move the stock first. ' +
    'Archiving an already-archived location is a no-op rather than an error, so a double-click is not a ' +
    'failure.',
  tags: [LOCATIONS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'delete' },
  request: { params: locationParams },
  responses: {
    200: { description: 'The archived location, with `archivedAt` set.', schema: locationResponse },
    404: { description: 'No such location in this warehouse.' },
    422: { description: 'It still has live children or stock stored in it.' },
  },
  handler: async ({ params }) => ok(await warehousing.archiveLocation(params.warehouseId, params.locationId)),
});

/* ==================================================== warehouse inventory */

defineRoute(adminWarehousingRouter, {
  method: 'get',
  path: '/v1/admin/warehouses/:warehouseId/inventory',
  surface: 'admin',
  operationId: 'adminListWarehouseInventory',
  summary: 'Stock held in one warehouse',
  description:
    'Every `inventory_levels` row for this warehouse, across all three stockable kinds — variants, loose ' +
    'hamper items and packaging materials — with the SKU and title resolved for each.\n\n' +
    '`availableQty` is a GENERATED column (`on_hand - reserved`), so it cannot drift from the two ' +
    'numbers it is derived from. `incomingQty` is what is expected to arrive here: sent purchase orders ' +
    'plus transfers dispatched to this warehouse. Stock currently in transit appears in `incomingQty` ' +
    'at the destination and in neither warehouse’s `availableQty`, which is correct — it is on a lorry.\n\n' +
    '`?lowStock=true` returns only levels at or below their reorder point. `?locationId=` narrows to one ' +
    'bin. `inventoryLevelId` is the id transfer and purchase-return lines lock on.',
  tags: [LOCATIONS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: warehouseIdParam, query: warehouseInventoryQuery },
  responses: {
    200: { description: 'A page of inventory levels.', schema: z.array(warehouseInventoryRow) },
    404: { description: 'No such warehouse.' },
  },
  handler: async ({ params, query }) => {
    const { items, total } = await warehousing.listWarehouseInventory(params.warehouseId, query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

/* ============================================================== transfers */

defineRoute(adminWarehousingRouter, {
  method: 'get',
  path: '/v1/admin/transfers',
  surface: 'admin',
  operationId: 'adminListStockTransfers',
  summary: 'List stock transfers',
  description:
    'Filter by `status` (comma-separated), by either end (`warehouseId`) or one specific end ' +
    '(`fromWarehouseId` / `toWarehouseId`), and by ETA range. `?q=` matches the transfer number.\n\n' +
    'The five statuses are the database’s: `requested`, `approved`, `in_transit`, `received`, ' +
    '`cancelled`. The lifecycle people say out loud — draft → approved → dispatched → in transit → ' +
    'received → completed — maps onto them without inventing values: draft is `requested`, dispatched ' +
    'and in-transit are both `in_transit` (dispatch is the event that puts stock in transit), and ' +
    'received and completed are both `received`. Passing `draft` is a 400 that says so.\n\n' +
    '`inTransitQty` is non-zero only while `in_transit` — that is the quantity currently belonging to ' +
    'neither warehouse.',
  tags: [TRANSFERS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: transferListQuery },
  responses: {
    200: { description: 'A page of transfers.', schema: z.array(transferSummary) },
    400: { description: 'An unrecognised status value.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await warehousing.listTransfers(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminWarehousingRouter, {
  method: 'post',
  path: '/v1/admin/transfers',
  surface: 'admin',
  operationId: 'adminCreateStockTransfer',
  summary: 'Raise a stock transfer',
  description:
    'Creates the transfer in `requested` with its lines. **No stock moves.** A transfer is a request ' +
    'until it is approved and dispatched; decrementing here would strand stock the moment somebody ' +
    'raised a transfer and forgot about it.\n\n' +
    'The number comes from the `stock_transfer` document series under a row lock — `TRF-2026-00061`, ' +
    'never `Math.random()`. Source and destination must differ, and every line names exactly one of ' +
    '`variantId` or `hamperItemId`, both of which the database CHECKs.\n\n' +
    'Availability is NOT checked here, deliberately: stock levels at approval time are what matter, and ' +
    'a check now would only produce a promise the dispatch cannot keep.',
  tags: [TRANSFERS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'create' },
  rateLimit: 'default',
  request: { body: createTransferBody },
  responses: {
    201: { description: 'The created transfer.', schema: transferDetail },
    404: { description: 'No such source or destination warehouse.' },
    422: { description: 'Same warehouse at both ends, or a line naming a stockable that does not exist.' },
  },
  handler: async ({ body, auth }) => created(await warehousing.createTransfer(body, auth)),
});

defineRoute(adminWarehousingRouter, {
  method: 'get',
  path: '/v1/admin/transfers/:transferId',
  surface: 'admin',
  operationId: 'adminGetStockTransfer',
  summary: 'Get one stock transfer',
  description:
    'The document with its lines, both warehouse names, and `availableActions` — the legal edges from ' +
    'the current status with the side effects each carries. Render the buttons from that list and a ' +
    'disabled button and a 422 can never disagree.',
  tags: [TRANSFERS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: transferIdParam },
  responses: {
    200: { description: 'The transfer.', schema: transferDetail },
    404: { description: 'No such transfer.' },
  },
  handler: async ({ params }) => ok(await warehousing.getTransfer(params.transferId)),
});

defineRoute(adminWarehousingRouter, {
  method: 'post',
  path: '/v1/admin/transfers/:transferId/approve',
  surface: 'admin',
  operationId: 'adminApproveStockTransfer',
  summary: 'Approve a stock transfer',
  description:
    '`requested` → `approved`, gated on `inventory:approve` — which, across the eleven roles, a ' +
    'Warehouse Manager does not hold. Raising a transfer and authorising it are different jobs.\n\n' +
    'No stock moves. A transfer with no lines is refused here rather than at dispatch, because an ' +
    'approved empty document is a thing nobody can act on.',
  tags: [TRANSFERS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'approve' },
  request: { params: transferIdParam },
  responses: {
    200: { description: 'The approved transfer.', schema: transferDetail },
    404: { description: 'No such transfer.' },
    422: { description: 'Illegal transition (`illegal_transfer_transition`), or the transfer has no lines.' },
  },
  handler: async ({ params }) => ok(await warehousing.approveTransfer(params.transferId)),
});

defineRoute(adminWarehousingRouter, {
  method: 'post',
  path: '/v1/admin/transfers/:transferId/dispatch',
  surface: 'admin',
  operationId: 'adminDispatchStockTransfer',
  summary: 'Dispatch an approved transfer',
  description:
    '`approved` → `in_transit`, and the first of the two edges that touch stock. In ONE transaction, for ' +
    'every line: decrement on-hand at the source through a conditional ' +
    '`UPDATE … WHERE on_hand_qty - reserved_qty >= n`, write a `transfer_out` movement carrying the ' +
    'balance that update returned, and raise `incoming_qty` at the destination.\n\n' +
    'If any line is short the whole dispatch rolls back — no line half-ships. Reserved units belong to ' +
    'open carts and orders and are not available to transfer, so a warehouse with 10 on hand and 8 ' +
    'reserved can send 2. Short is 422 `insufficient_stock`, naming the SKU.\n\n' +
    'Source levels are locked in ascending id order, so two transfers sharing SKUs queue rather than ' +
    'deadlock.\n\n' +
    'From here until receipt the stock is in **neither** warehouse’s `availableQty`. That is not a gap ' +
    'in the accounting — it is where the goods actually are.\n\n' +
    'Requires an `Idempotency-Key`: a retried dispatch must not decrement twice.',
  tags: [TRANSFERS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  idempotent: true,
  request: {
    params: transferIdParam,
    body: z.object({
      note: z.string().trim().max(500).optional().describe('Recorded on each `transfer_out` movement.'),
    }),
  },
  responses: {
    200: { description: 'The dispatched transfer.', schema: transferDetail },
    404: { description: 'No such transfer.' },
    422: { description: 'Illegal transition, no lines, or `insufficient_stock` at the source.' },
  },
  handler: async ({ params, body, auth }) =>
    ok(await warehousing.dispatchTransfer(params.transferId, body.note ?? null, auth)),
});

defineRoute(adminWarehousingRouter, {
  method: 'post',
  path: '/v1/admin/transfers/:transferId/receive',
  surface: 'admin',
  operationId: 'adminReceiveStockTransfer',
  summary: 'Receive a transfer at the destination',
  description:
    '`in_transit` → `received`, the second stock-moving edge. In ONE transaction, for every line: ' +
    'increment on-hand at the destination, write a `transfer_in` movement with the resulting balance, ' +
    'and clear the `incoming_qty` this transfer raised.\n\n' +
    'Omit `lines` to receive everything in full, which is the common case. A line may arrive SHORT — ' +
    'the difference is goods lost in transit: they already left the source ledger and are simply never ' +
    'credited to the destination, so both warehouses stay reconciled and the loss is visible as ' +
    '`shortQty`. A line cannot arrive OVER; that is 422 `over_receipt`, which the ' +
    '`transfer_line_no_over_receipt` CHECK would otherwise raise as a constraint error.\n\n' +
    'Requires an `Idempotency-Key`: a retried receipt must not credit the destination twice.',
  tags: [TRANSFERS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  idempotent: true,
  request: { params: transferIdParam, body: receiveTransferBody },
  responses: {
    200: { description: 'The received transfer, with per-line `receivedQty` and `shortQty`.', schema: transferDetail },
    404: { description: 'No such transfer.' },
    422: { description: 'Illegal transition, an unknown line id, or `over_receipt`.' },
  },
  handler: async ({ params, body, auth }) => ok(await warehousing.receiveTransfer(params.transferId, body, auth)),
});

defineRoute(adminWarehousingRouter, {
  method: 'post',
  path: '/v1/admin/transfers/:transferId/cancel',
  surface: 'admin',
  operationId: 'adminCancelStockTransfer',
  summary: 'Cancel a stock transfer',
  description:
    'Legal from `requested` and `approved` only — nothing has moved yet, so there is nothing to unwind.\n\n' +
    'A transfer that is already `in_transit` is refused with 422 ' +
    '`transfer_in_transit_not_cancellable`. The stock has left the source warehouse; "cancelling" it ' +
    'would leave those units on no document and in no warehouse, which is precisely the invisible ' +
    'inventory the movement ledger exists to prevent. Receive it at the destination and raise a ' +
    'transfer back.',
  tags: [TRANSFERS_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  request: { params: transferIdParam, body: cancelTransferBody },
  responses: {
    200: { description: 'The cancelled transfer.', schema: transferDetail },
    404: { description: 'No such transfer.' },
    422: { description: 'Already in transit, already received, or already cancelled.' },
  },
  handler: async ({ params, body }) => ok(await warehousing.cancelTransfer(params.transferId, body.reason)),
});
