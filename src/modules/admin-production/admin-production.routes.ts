import { Router } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok, paginated, pageMeta } from '../../lib/http.js';
import * as production from './admin-production.service.js';
import {
  bomArchiveResponse,
  bomDetail,
  bomExplosionQuery,
  bomExplosionResponse,
  bomIdParam,
  bomListQuery,
  bomSummary,
  cancelProductionOrderBody,
  completeProductionOrderBody,
  createBomBody,
  createProductionOrderBody,
  productionDetail,
  productionIdParam,
  productionListQuery,
  productionSummary,
  updateBomBody,
} from './admin-production.schemas.js';

/**
 * Bills of materials and production orders.
 *
 * A finished good is the sum of what went into it. The BOM records that; a
 * production order is the transaction that converts one into the other, writing
 * both sides of the ledger — `raw_material_consumption` out, `production` in.
 *
 * Route order: `/explosion` is declared before `/:bomId` is used for anything
 * ambiguous, and both `boms` and `production/orders` sit under distinct prefixes,
 * so no literal segment can be captured as an id.
 */
export const adminProductionRouter: Router = Router();

const BOM_TAG = 'Admin BOM';
const PROD_TAG = 'Admin production';

/* ================================================================== BOMs */

defineRoute(adminProductionRouter, {
  method: 'get',
  path: '/v1/admin/boms',
  surface: 'admin',
  operationId: 'adminListBoms',
  summary: 'List bills of materials',
  description:
    'One row per output that has a recipe. Filter by `componentVariantId` to answer the question worth ' +
    'asking before discontinuing anything: what do we make out of this?',
  tags: [BOM_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: bomListQuery },
  responses: { 200: { description: 'A page of BOMs.', schema: bomSummary.array() } },
  handler: async ({ query }) => {
    const { rows, total } = await production.listBoms(query);
    return paginated(rows, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminProductionRouter, {
  method: 'post',
  path: '/v1/admin/boms',
  surface: 'admin',
  operationId: 'adminCreateBom',
  summary: 'Create a bill of materials',
  description:
    'One BOM per output — a second create is a 409, because silently replacing a recipe would discard ' +
    'one that production orders may already have been costed against. A component that is the output ' +
    'itself is rejected: it would explode forever.',
  tags: [BOM_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'create' },
  request: { body: createBomBody },
  responses: {
    201: { description: 'The BOM as stored.', schema: bomDetail },
    404: { description: 'Output variant not found.' },
    409: { description: 'That output already has a BOM.' },
    422: { description: 'A component does not exist, or the BOM references itself.' },
  },
  handler: async ({ body }) => created(await production.createBom(body)),
});

defineRoute(adminProductionRouter, {
  method: 'get',
  path: '/v1/admin/boms/:bomId/explosion',
  surface: 'admin',
  operationId: 'adminExplodeBom',
  summary: 'Explode a BOM to its requirements',
  description:
    'Recurses to raw materials, compounding waste at every level, and SUMS a component reached by more ' +
    'than one path. `mode=direct` returns only the immediate components instead.\n\n' +
    'Pass `warehouseId` to decorate each line with on-hand and shortage — this is the "can we build ' +
    'this?" question. A cyclic BOM is a 422 rather than a hung request.',
  tags: [BOM_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: bomIdParam, query: bomExplosionQuery },
  responses: {
    200: { description: 'Requirements, and shortages when a warehouse was named.', schema: bomExplosionResponse },
    404: { description: 'No variant or no BOM for it.' },
    422: { description: 'The BOM contains a cycle, or is too deep or too large to explode.' },
  },
  handler: async ({ params, query }) =>
    ok(
      await production.explodeBomForOutput(params.bomId, {
        quantity: query.quantity,
        mode: query.mode,
        warehouseId: query.warehouseId,
      }),
    ),
});

defineRoute(adminProductionRouter, {
  method: 'get',
  path: '/v1/admin/boms/:bomId',
  surface: 'admin',
  operationId: 'adminGetBom',
  summary: 'Get a bill of materials',
  description: 'The recipe for one output variant, with every component line and the current version.',
  tags: [BOM_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: bomIdParam },
  responses: {
    200: { description: 'The BOM.', schema: bomDetail },
    404: { description: 'No variant or no BOM for it.' },
  },
  handler: async ({ params }) => ok(await production.getBom(params.bomId)),
});

defineRoute(adminProductionRouter, {
  method: 'patch',
  path: '/v1/admin/boms/:bomId',
  surface: 'admin',
  operationId: 'adminUpdateBom',
  summary: 'Update a bill of materials',
  description:
    'Supplying `lines` REPLACES the recipe wholesale and bumps the version — half the old recipe merged ' +
    'with half the new one is a recipe nobody wrote. Supplying only `version` restamps without changing ' +
    'components.',
  tags: [BOM_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  request: { params: bomIdParam, body: updateBomBody },
  responses: {
    200: { description: 'The BOM after the change.', schema: bomDetail },
    404: { description: 'No variant or no BOM for it.' },
    422: { description: 'A component does not exist, or the BOM references itself.' },
  },
  handler: async ({ params, body }) => ok(await production.updateBom(params.bomId, body)),
});

defineRoute(adminProductionRouter, {
  method: 'post',
  path: '/v1/admin/boms/:bomId/archive',
  surface: 'admin',
  operationId: 'adminArchiveBom',
  summary: 'Remove a bill of materials',
  description:
    'Refused while any production order against this output is still open — those orders were planned ' +
    'against this recipe, and completing them afterwards would consume components nobody can trace.',
  tags: [BOM_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'delete' },
  request: { params: bomIdParam },
  responses: {
    200: { description: 'What was removed.', schema: bomArchiveResponse },
    404: { description: 'No variant or no BOM for it.' },
    409: { description: 'Open production orders still reference this recipe.' },
  },
  handler: async ({ params }) => ok(await production.archiveBom(params.bomId)),
});

/* ==================================================== production orders */

defineRoute(adminProductionRouter, {
  method: 'get',
  path: '/v1/admin/production/orders',
  surface: 'admin',
  operationId: 'adminListProductionOrders',
  summary: 'List production orders',
  description: 'Filter by status, warehouse, output variant or batch number.',
  tags: [PROD_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: productionListQuery },
  responses: { 200: { description: 'A page of production orders.', schema: productionSummary.array() } },
  handler: async ({ query }) => {
    const { rows, total } = await production.listProductionOrders(query);
    return paginated(rows, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminProductionRouter, {
  method: 'post',
  path: '/v1/admin/production/orders',
  surface: 'admin',
  operationId: 'adminCreateProductionOrder',
  summary: 'Create a production order',
  description:
    'Sizes component lines from the BOM at creation time and materialises them on the order. The recipe ' +
    'is captured NOW, so a BOM edited between planning and completion cannot silently change what a ' +
    'half-built batch consumes.',
  tags: [PROD_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'create' },
  request: { body: createProductionOrderBody },
  responses: {
    201: { description: 'The order and its component lines.', schema: productionDetail },
    404: { description: 'Warehouse or output variant not found.' },
    422: { description: 'No output given, both given, or the output has no BOM.' },
  },
  handler: async ({ body, auth }) => created(await production.createProductionOrder(body, auth.staffId)),
});

defineRoute(adminProductionRouter, {
  method: 'get',
  path: '/v1/admin/production/orders/:productionId',
  surface: 'admin',
  operationId: 'adminGetProductionOrder',
  summary: 'Get a production order',
  description: 'The order, its component lines with planned vs consumed, and the transitions available from here.',
  tags: [PROD_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: productionIdParam },
  responses: {
    200: { description: 'The production order.', schema: productionDetail },
    404: { description: 'No such production order.' },
  },
  handler: async ({ params }) => ok(await production.getProductionOrder(params.productionId)),
});

defineRoute(adminProductionRouter, {
  method: 'post',
  path: '/v1/admin/production/orders/:productionId/start',
  surface: 'admin',
  operationId: 'adminStartProductionOrder',
  summary: 'Start a production order',
  description:
    'Marks the run in progress and stamps `startedAt`. Consumes nothing — components are taken at ' +
    'completion, when the actual output is known.',
  tags: [PROD_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  request: { params: productionIdParam, body: cancelProductionOrderBody },
  responses: {
    200: { description: 'The order after starting.', schema: productionDetail },
    404: { description: 'No such production order.' },
    422: { description: 'Not startable from its current status.' },
  },
  handler: async ({ params, body, auth }) =>
    ok(await production.transitionProductionOrder(params.productionId, 'start', body, auth.staffId)),
});

defineRoute(adminProductionRouter, {
  method: 'post',
  path: '/v1/admin/production/orders/:productionId/complete',
  surface: 'admin',
  operationId: 'adminCompleteProductionOrder',
  summary: 'Complete a production order',
  description:
    'ONE transaction: consume every component, create the finished stock, write both sides of the ledger. ' +
    'If any component is short the whole thing rolls back — a half-consumed run cannot be reconstructed, ' +
    'because nothing records which components were already taken.\n\n' +
    'Components are consumed in proportion to what was STARTED (`producedQty + scrappedQty`). Scrapped ' +
    'units burned their materials too; charging only for good output would understate cost and overstate stock.',
  tags: [PROD_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  idempotent: true,
  request: { params: productionIdParam, body: completeProductionOrderBody },
  responses: {
    200: { description: 'The completed order with consumed quantities.', schema: productionDetail },
    404: { description: 'No such production order.' },
    422: { description: 'Not completable, output exceeds plan, or a component is short (`insufficient_stock`).' },
  },
  handler: async ({ params, body, auth }) =>
    ok(await production.completeProductionOrder(params.productionId, body, auth.staffId)),
});

defineRoute(adminProductionRouter, {
  method: 'post',
  path: '/v1/admin/production/orders/:productionId/cancel',
  surface: 'admin',
  operationId: 'adminCancelProductionOrder',
  summary: 'Cancel a production order',
  description:
    'Only before completion. Nothing to unwind — components are not consumed until the run completes, ' +
    'which is precisely why cancelling is safe up to that point and impossible after it.',
  tags: [PROD_TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  request: { params: productionIdParam, body: cancelProductionOrderBody },
  responses: {
    200: { description: 'The cancelled order.', schema: productionDetail },
    404: { description: 'No such production order.' },
    422: { description: 'Already completed or already cancelled.' },
  },
  handler: async ({ params, body, auth }) =>
    ok(await production.transitionProductionOrder(params.productionId, 'cancel', body, auth.staffId)),
});
