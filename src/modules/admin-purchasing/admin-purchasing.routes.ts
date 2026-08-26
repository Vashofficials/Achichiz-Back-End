import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok, paginated, pageMeta } from '../../lib/http.js';
import * as purchasing from './admin-purchasing.service.js';
import {
  cancelPoBody,
  createGrnBody,
  createPoBody,
  createReturnBody,
  createSupplierProductBody,
  grnDetail,
  grnIdParam,
  grnListQuery,
  grnSummary,
  poDetail,
  poIdParam,
  poListQuery,
  poSummary,
  returnDetail,
  returnIdParam,
  returnListQuery,
  returnSummary,
  supplierIdParam,
  supplierProductListQuery,
  supplierProductParams,
  supplierProductResponse,
  updatePoBody,
  updateSupplierProductBody,
} from './admin-purchasing.schemas.js';

/**
 * Purchasing — the supplier catalogue and the three procurement documents.
 *
 * `/v1/admin/suppliers` itself already has seven CRUD endpoints from
 * `admin-resources`. Nothing here rebuilds them; `/products` is a sub-resource.
 *
 * POs, GRNs and purchase returns cannot use the generic engine at all. They are
 * parent+lines documents whose writes are state transitions with stock side
 * effects — the same shape, and the same reason, as `admin-orders`.
 */
export const adminPurchasingRouter: Router = Router();

const SUPPLIER_TAG = 'Admin suppliers';
const PO_TAG = 'Admin purchasing';
const GRN_TAG = 'Admin goods receipts';
const RETURN_TAG = 'Admin purchase returns';

/* ======================================================= supplier products */

defineRoute(adminPurchasingRouter, {
  method: 'get',
  path: '/v1/admin/suppliers/:supplierId/products',
  surface: 'admin',
  operationId: 'adminListSupplierProducts',
  summary: 'List what a supplier sells us',
  description:
    'The join that makes reordering possible: the supplier’s own SKU, what they charge, their minimum ' +
    'order quantity and their lead time, per stockable.\n\n' +
    'A catalogue entry targets exactly one of a product variant, a loose hamper item or a packaging ' +
    'material — the same polymorphism `inventory_levels` uses. `?q=` matches our SKU, the title and the ' +
    'supplier’s own code. Archived entries are excluded unless `includeArchived=true`.',
  tags: [SUPPLIER_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: supplierIdParam, query: supplierProductListQuery },
  responses: {
    200: { description: 'A page of catalogue entries.', schema: z.array(supplierProductResponse) },
    404: { description: 'No such supplier.' },
  },
  handler: async ({ params, query }) => {
    const { items, total } = await purchasing.listSupplierProducts(params.supplierId, query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminPurchasingRouter, {
  method: 'post',
  path: '/v1/admin/suppliers/:supplierId/products',
  surface: 'admin',
  operationId: 'adminCreateSupplierProduct',
  summary: 'Add an item to a supplier’s catalogue',
  description:
    'Exactly one of `variantId`, `hamperItemId` or `packagingId`, which the database CHECKs. A second ' +
    'live entry for the same supplier and the same item is 422 `supplier_product_exists` — the reorder ' +
    'engine would have no way to choose between two prices for one thing.\n\n' +
    '`isPreferred` is capped at ONE per variant by a partial unique index. Setting it here demotes ' +
    'whoever held it, in the same transaction and BEFORE the insert: a partial unique index cannot be ' +
    'deferred, so doing it the other way round collides with a row that is about to change.',
  tags: [SUPPLIER_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'create' },
  rateLimit: 'default',
  request: { params: supplierIdParam, body: createSupplierProductBody },
  responses: {
    201: { description: 'The created catalogue entry.', schema: supplierProductResponse },
    404: { description: 'No such supplier.' },
    422: { description: 'A duplicate entry, or a target that does not exist.' },
  },
  handler: async ({ params, body }) =>
    created(await purchasing.createSupplierProduct(params.supplierId, body)),
});

defineRoute(adminPurchasingRouter, {
  method: 'patch',
  path: '/v1/admin/suppliers/:supplierId/products/:supplierProductId',
  surface: 'admin',
  operationId: 'adminUpdateSupplierProduct',
  summary: 'Update a supplier catalogue entry',
  description:
    'Cost, MOQ, lead time, the supplier’s SKU, and the preferred flag. Promoting one entry demotes the ' +
    'incumbent for that variant.\n\n' +
    'The TARGET is immutable — changing which item an entry prices is not an edit, it is a different ' +
    'entry, and silently repointing it would rewrite the price history of both.\n\n' +
    '`archived: true` soft-deletes and clears the preferred flag, freeing the slot in the unique index ' +
    'for a replacement supplier. `archived: false` restores it.',
  tags: [SUPPLIER_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  request: { params: supplierProductParams, body: updateSupplierProductBody },
  responses: {
    200: { description: 'The updated entry.', schema: supplierProductResponse },
    404: { description: 'No such entry for this supplier.' },
    422: { description: 'Restoring it would collide with a live entry for the same item.' },
  },
  handler: async ({ params, body }) =>
    ok(await purchasing.updateSupplierProduct(params.supplierId, params.supplierProductId, body)),
});

/* ========================================================= purchase orders */

defineRoute(adminPurchasingRouter, {
  method: 'get',
  path: '/v1/admin/purchasing/purchase-orders',
  surface: 'admin',
  operationId: 'adminListPurchaseOrders',
  summary: 'List purchase orders',
  description:
    'Filter by stored `status` (comma-separated), supplier, receiving warehouse and expected-date range. ' +
    '`?q=` matches the PO number.\n\n' +
    'Every row carries **both** `status` and `lifecycle`. `status` is one of the five values the ' +
    'database allows; `lifecycle` is what it means, derived from `status` plus `sentAt`. The one that ' +
    'matters: `status: "sent"` with `sentAt: null` is `lifecycle: "approved"` — approved, but not yet ' +
    'in front of the supplier, and the state in which `incomingQty` has deliberately not been raised. ' +
    'Filter on `sent` and read `lifecycle` to tell the two apart.',
  tags: [PO_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: poListQuery },
  responses: {
    200: { description: 'A page of purchase orders.', schema: z.array(poSummary) },
    400: { description: 'An unrecognised status value.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await purchasing.listPurchaseOrders(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminPurchasingRouter, {
  method: 'post',
  path: '/v1/admin/purchasing/purchase-orders',
  surface: 'admin',
  operationId: 'adminCreatePurchaseOrder',
  summary: 'Raise a purchase order',
  description:
    'Creates the PO in `draft` with its lines. Nothing is ordered and nothing is expected until it has ' +
    'been approved AND sent.\n\n' +
    'Every total is recomputed server-side: `lineTotalPaise` is `orderedQty × unitCostPaise` excluding ' +
    'GST, `taxPaise` applies each line’s own basis-point rate to its own subtotal (so a PO mixing 5% ' +
    'and 18% items does not have to pick one), and `totalPaise` is their sum. All integer paise. A ' +
    'client-supplied total is not accepted, let alone trusted.\n\n' +
    'The number comes from the `purchase_order` document series under a row lock — `PO-2026-02291`.',
  tags: [PO_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'create' },
  rateLimit: 'default',
  request: { body: createPoBody },
  responses: {
    201: { description: 'The created purchase order.', schema: poDetail },
    404: { description: 'No such supplier or warehouse.' },
    422: { description: 'A line naming a stockable that does not exist.' },
  },
  handler: async ({ body, auth }) => created(await purchasing.createPurchaseOrder(body, auth)),
});

defineRoute(adminPurchasingRouter, {
  method: 'get',
  path: '/v1/admin/purchasing/purchase-orders/:poId',
  surface: 'admin',
  operationId: 'adminGetPurchaseOrder',
  summary: 'Get one purchase order',
  description:
    'The document with its lines, every goods receipt posted against it, and `availableActions`.\n\n' +
    'Per line, `outstandingQty` is `orderedQty - receivedQty`, and `receivedQty` counts **accepted** ' +
    'units only. Rejected goods appear on the receipts, never here — they are going back to the ' +
    'supplier, so the PO is still owed that stock.\n\n' +
    'Edges marked `documentDriven` (`partially_received`, `received`) have no endpoint: a PO reaches ' +
    'them because a GRN was posted, not because someone clicked. Render them disabled.',
  tags: [PO_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: poIdParam },
  responses: {
    200: { description: 'The purchase order.', schema: poDetail },
    404: { description: 'No such purchase order.' },
  },
  handler: async ({ params }) => ok(await purchasing.getPurchaseOrder(params.poId)),
});

defineRoute(adminPurchasingRouter, {
  method: 'patch',
  path: '/v1/admin/purchasing/purchase-orders/:poId',
  surface: 'admin',
  operationId: 'adminUpdatePurchaseOrder',
  summary: 'Edit a draft purchase order',
  description:
    'Draft only. Once a PO is approved the lines are the agreement, and once it is sent the supplier ' +
    'has a copy — editing either would leave two different documents with one number. Anything else is ' +
    '422 `illegal_po_transition`.\n\n' +
    'Supplying `lines` REPLACES all of them and recomputes every total. Replacement rather than a ' +
    'partial patch because a line carries `receivedQty`, and a patch that reordered or dropped lines ' +
    'would have to invent an answer for what happens to it. In draft it is always zero, so replacement ' +
    'is safe.',
  tags: [PO_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  request: { params: poIdParam, body: updatePoBody },
  responses: {
    200: { description: 'The updated purchase order.', schema: poDetail },
    404: { description: 'No such purchase order.' },
    422: { description: 'Not a draft, or a line naming a stockable that does not exist.' },
  },
  handler: async ({ params, body }) => ok(await purchasing.updatePurchaseOrder(params.poId, body)),
});

defineRoute(adminPurchasingRouter, {
  method: 'post',
  path: '/v1/admin/purchasing/purchase-orders/:poId/approve',
  surface: 'admin',
  operationId: 'adminApprovePurchaseOrder',
  summary: 'Approve a purchase order',
  description:
    'Gated on `inventory:approve`, which a Warehouse Manager does not hold — raising a PO and ' +
    'committing the company’s money to it are different jobs.\n\n' +
    '**Stored as `status: "sent"` with `sentAt` still null**, which reads back as `lifecycle: ' +
    '"approved"`. The `purchase_orders` CHECK allows exactly five statuses and there is no `approved` ' +
    'among them; writing one would fail against the live database rather than model anything. The two ' +
    'columns together carry the distinction the CHECK cannot.\n\n' +
    '`incomingQty` is deliberately NOT raised here. An approved PO nobody has posted to the supplier ' +
    'is not stock on its way, and counting it would make the reorder engine skip a SKU that was never ' +
    'actually ordered.',
  tags: [PO_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'approve' },
  request: { params: poIdParam },
  responses: {
    200: { description: 'The approved purchase order.', schema: poDetail },
    404: { description: 'No such purchase order.' },
    422: { description: 'Illegal transition, or the PO has no lines.' },
  },
  handler: async ({ params }) => ok(await purchasing.approvePurchaseOrder(params.poId)),
});

defineRoute(adminPurchasingRouter, {
  method: 'post',
  path: '/v1/admin/purchasing/purchase-orders/:poId/send',
  surface: 'admin',
  operationId: 'adminSendPurchaseOrder',
  summary: 'Mark a purchase order sent to the supplier',
  description:
    'Legal only from `lifecycle: "approved"`. Sending an unapproved draft is 422 `po_not_approved`.\n\n' +
    'Stamps `sentAt` and raises `incomingQty` at the receiving warehouse by each line’s outstanding ' +
    'quantity. This is the moment the order becomes real to the outside world, so it is the moment the ' +
    'warehouse starts expecting stock. `incomingQty` never touches `availableQty`, which is GENERATED ' +
    'from `on_hand - reserved` — ordered stock is expected, not sellable.\n\n' +
    'Also stamps `lastPurchaseAt` and `lastPurchaseCostPaise` on the matching supplier-catalogue ' +
    'entries, so the next reorder suggestion prices from what we actually paid.\n\n' +
    'Requires an `Idempotency-Key`: a retried send must not raise `incomingQty` twice.',
  tags: [PO_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  idempotent: true,
  request: { params: poIdParam },
  responses: {
    200: { description: 'The sent purchase order.', schema: poDetail },
    404: { description: 'No such purchase order.' },
    422: { description: 'Not approved yet, or already sent.' },
  },
  handler: async ({ params }) => ok(await purchasing.sendPurchaseOrder(params.poId)),
});

defineRoute(adminPurchasingRouter, {
  method: 'post',
  path: '/v1/admin/purchasing/purchase-orders/:poId/cancel',
  surface: 'admin',
  operationId: 'adminCancelPurchaseOrder',
  summary: 'Cancel a purchase order',
  description:
    'Legal from draft, approved, sent and partially received. A `received` PO is terminal — goods that ' +
    'arrived cannot be un-received by a status flip; raise a purchase return instead.\n\n' +
    'Whatever has NOT been received stops being `incomingQty`, because it is no longer coming. Already ' +
    'received stock stays exactly where it is: it is in the warehouse.\n\n' +
    'The reason is stamped into the PO notes and captured by the automatic audit log.',
  tags: [PO_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  request: { params: poIdParam, body: cancelPoBody },
  responses: {
    200: { description: 'The cancelled purchase order.', schema: poDetail },
    404: { description: 'No such purchase order.' },
    422: { description: 'Already received or already cancelled.' },
  },
  handler: async ({ params, body }) => ok(await purchasing.cancelPurchaseOrder(params.poId, body.reason)),
});

/* ========================================================== goods receipts */

defineRoute(adminPurchasingRouter, {
  method: 'get',
  path: '/v1/admin/purchasing/goods-receipts',
  surface: 'admin',
  operationId: 'adminListGoodsReceipts',
  summary: 'List goods receipts',
  description:
    'Filter by purchase order, warehouse, QC status and received-date range. `?q=` matches the GRN ' +
    'number and the supplier’s invoice number.\n\n' +
    '`acceptedQty` is what entered stock; `rejectedQty` is what did not. The two are always reported ' +
    'separately and never summed into a single "received" figure.',
  tags: [GRN_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: grnListQuery },
  responses: {
    200: { description: 'A page of goods receipts.', schema: z.array(grnSummary) },
  },
  handler: async ({ query }) => {
    const { items, total } = await purchasing.listGoodsReceipts(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminPurchasingRouter, {
  method: 'post',
  path: '/v1/admin/purchasing/goods-receipts',
  surface: 'admin',
  operationId: 'adminCreateGoodsReceipt',
  summary: 'Receive goods against a purchase order',
  description:
    'The stock-in step, and ONE transaction end to end. Per line: increment on-hand by `acceptedQty`, ' +
    'write an `inbound` movement carrying the balance that increment returned, add to the PO line’s ' +
    '`receivedQty`, and lower `incomingQty` by everything that turned up. If any line fails, none of it ' +
    'happened.\n\n' +
    '**Rejected units never enter stock.** They are recorded on the receipt line with a reason and go no ' +
    'further — damaged goods inside `on_hand_qty` are sellable goods, and no downstream report undoes ' +
    'that. They also do not count towards `receivedQty`, so a PO with rejections stays open for what it ' +
    'is still owed. Send them back with a purchase return.\n\n' +
    '**Partial receipts are normal.** The PO becomes `partially_received` and stays there until ordered ' +
    'equals accepted across ALL lines, at which point it becomes `received` and `closedAt` is stamped. ' +
    'Accepting more than a line still has outstanding is 422 `over_receipt`.\n\n' +
    'The warehouse is taken from the PO, not from the request: receiving into a different warehouse ' +
    'than the one that ordered would leave `incomingQty` raised forever at the warehouse still waiting.\n\n' +
    'Requires an `Idempotency-Key`: a retried receipt must not add the stock twice.',
  tags: [GRN_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'create' },
  rateLimit: 'default',
  idempotent: true,
  request: { body: createGrnBody },
  responses: {
    201: { description: 'The posted receipt, with the PO’s resulting status.', schema: grnDetail },
    404: { description: 'No such purchase order.' },
    422: { description: 'The PO has not been sent (`po_not_receivable`), an unknown line, or `over_receipt`.' },
  },
  handler: async ({ body, auth }) => created(await purchasing.createGoodsReceipt(body, auth)),
});

defineRoute(adminPurchasingRouter, {
  method: 'get',
  path: '/v1/admin/purchasing/goods-receipts/:grnId',
  surface: 'admin',
  operationId: 'adminGetGoodsReceipt',
  summary: 'Get one goods receipt',
  description:
    'The receipt with its lines, including per-line rejections with their reasons, batch numbers and ' +
    'expiry dates. `poStatusAfter` is what the purchase order’s stored status became once this receipt ' +
    'was posted.',
  tags: [GRN_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: grnIdParam },
  responses: {
    200: { description: 'The goods receipt.', schema: grnDetail },
    404: { description: 'No such goods receipt.' },
  },
  handler: async ({ params }) => ok(await purchasing.getGoodsReceipt(params.grnId)),
});

/* ========================================================= purchase returns */

defineRoute(adminPurchasingRouter, {
  method: 'get',
  path: '/v1/admin/purchasing/purchase-returns',
  surface: 'admin',
  operationId: 'adminListPurchaseReturns',
  summary: 'List purchase returns',
  description:
    'Stock going back to a supplier. Filter by status (comma-separated), supplier, warehouse and ' +
    'reason. `?q=` matches the return number.\n\n' +
    'Unlike purchase orders, all six lifecycle statuses exist in the database for returns — ' +
    '`draft`, `pending_approval`, `approved`, `dispatched`, `completed`, `cancelled` — so no ' +
    'derivation is needed and `status` means exactly what it says.',
  tags: [RETURN_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: returnListQuery },
  responses: {
    200: { description: 'A page of purchase returns.', schema: z.array(returnSummary) },
    400: { description: 'An unrecognised status value.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await purchasing.listPurchaseReturns(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminPurchasingRouter, {
  method: 'post',
  path: '/v1/admin/purchasing/purchase-returns',
  surface: 'admin',
  operationId: 'adminCreatePurchaseReturn',
  summary: 'Raise a purchase return',
  description:
    'Creates the return in `draft`. **No stock moves** — a return is a request until it is approved and ' +
    'dispatched.\n\n' +
    'Lines name an `inventoryLevelId`, not a SKU. That is what `purchase_return_lines` stores and it is ' +
    'the right shape: a return takes stock out of one specific warehouse, and naming a SKU would leave ' +
    'the question of which one open. Get the ids from ' +
    '`GET /v1/admin/warehouses/{warehouseId}/inventory`. Every line’s level must be in this return’s ' +
    'warehouse — anything else is 422 `level_warehouse_mismatch`.\n\n' +
    'Totals are computed from the lines: `subtotalPaise` is the sum of `quantity × unitCostPaise`, and ' +
    '`totalPaise` adds the `taxPaise` you are reversing. Integer paise.\n\n' +
    'The number comes from the `purchase_return` series added by migration 0003 — `PRET-2026-00001`.',
  tags: [RETURN_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'create' },
  rateLimit: 'default',
  request: { body: createReturnBody },
  responses: {
    201: { description: 'The created return.', schema: returnDetail },
    404: { description: 'No such supplier or warehouse.' },
    422: { description: 'A line naming a level that is not in this warehouse.' },
  },
  handler: async ({ body, auth }) => created(await purchasing.createPurchaseReturn(body, auth)),
});

defineRoute(adminPurchasingRouter, {
  method: 'get',
  path: '/v1/admin/purchasing/purchase-returns/:returnId',
  surface: 'admin',
  operationId: 'adminGetPurchaseReturn',
  summary: 'Get one purchase return',
  description:
    'The return with its lines and `availableActions`. `totalPaise` is the credit expected from the ' +
    'supplier once they receive the goods.',
  tags: [RETURN_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: returnIdParam },
  responses: {
    200: { description: 'The purchase return.', schema: returnDetail },
    404: { description: 'No such purchase return.' },
  },
  handler: async ({ params }) => ok(await purchasing.getPurchaseReturn(params.returnId)),
});

defineRoute(adminPurchasingRouter, {
  method: 'post',
  path: '/v1/admin/purchasing/purchase-returns/:returnId/approve',
  surface: 'admin',
  operationId: 'adminApprovePurchaseReturn',
  summary: 'Approve a purchase return',
  description:
    'Gated on `inventory:approve`. Legal from `draft` and `pending_approval`; stamps `approvedBy` and ' +
    '`approvedAt`. No stock moves — approval authorises the dispatch, it does not perform it.\n\n' +
    'A return with no lines is refused here rather than at dispatch, because an approved empty document ' +
    'authorises sending nothing back.',
  tags: [RETURN_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'approve' },
  request: { params: returnIdParam },
  responses: {
    200: { description: 'The approved return.', schema: returnDetail },
    404: { description: 'No such purchase return.' },
    422: { description: 'Illegal transition, or the return has no lines.' },
  },
  handler: async ({ params, auth }) => ok(await purchasing.approvePurchaseReturn(params.returnId, auth)),
});

defineRoute(adminPurchasingRouter, {
  method: 'post',
  path: '/v1/admin/purchasing/purchase-returns/:returnId/dispatch',
  surface: 'admin',
  operationId: 'adminDispatchPurchaseReturn',
  summary: 'Dispatch an approved return to the supplier',
  description:
    '`approved` → `dispatched`, and the only edge on a return that touches stock. In ONE transaction, ' +
    'for every line: decrement on-hand through the conditional ' +
    '`UPDATE … WHERE on_hand_qty - reserved_qty >= n`, and write an `outbound` movement with ' +
    '`referenceType: "purchase_return"` carrying the balance that update returned.\n\n' +
    'Reserved units belong to open carts and orders and cannot be sent back to a supplier, so a level ' +
    'with 10 on hand and 8 reserved can return 2. Short is 422 `insufficient_stock`, naming the SKU, ' +
    'and the whole dispatch rolls back — a return that shipped three of its four lines is a parcel the ' +
    'supplier will dispute and a ledger nobody can reconcile.\n\n' +
    'Levels are locked in ascending id order, so concurrent returns and transfers queue rather than ' +
    'deadlock.\n\n' +
    'A dispatched return cannot be cancelled: the stock has left. Requires an `Idempotency-Key`.',
  tags: [RETURN_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  rateLimit: 'default',
  idempotent: true,
  request: { params: returnIdParam },
  responses: {
    200: { description: 'The dispatched return.', schema: returnDetail },
    404: { description: 'No such purchase return.' },
    422: { description: 'Not approved, already dispatched, or `insufficient_stock`.' },
  },
  handler: async ({ params, auth }) => ok(await purchasing.dispatchPurchaseReturn(params.returnId, auth)),
});
