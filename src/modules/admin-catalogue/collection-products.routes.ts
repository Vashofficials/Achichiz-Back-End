/**
 * Collection products mapping routes.
 */

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok } from '../../lib/http.js';
import * as service from './collection-products.service.js';
import {
  collectionIdParam,
  collectionProductItem,
  syncCollectionProductsBody,
  syncCollectionProductsResponse,
} from './collection-products.schemas.js';

export const collectionProductsRouter: Router = Router();

defineRoute(collectionProductsRouter, {
  method: 'get',
  path: '/v1/admin/collections/:collectionId/products',
  surface: 'admin',
  operationId: 'adminListCollectionProducts',
  summary: 'List products mapped to a collection',
  description: 'Returns all catalogue products with their mapping status for this collection.',
  tags: ['Admin / Catalogue'],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'view' },
  request: { params: collectionIdParam },
  responses: {
    200: { description: 'Products with mapping status.', schema: z.array(collectionProductItem) },
    404: { description: 'No such collection.' },
  },
  handler: async ({ params }) => ok(await service.list(params.collectionId)),
});

defineRoute(collectionProductsRouter, {
  method: 'put',
  path: '/v1/admin/collections/:collectionId/products',
  surface: 'admin',
  operationId: 'adminSyncCollectionProducts',
  summary: 'Sync product mappings for a collection',
  description: 'Replaces the set of products mapped to this collection with the provided list of product IDs.',
  tags: ['Admin / Catalogue'],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'edit' },
  request: { params: collectionIdParam, body: syncCollectionProductsBody },
  responses: {
    200: { description: 'Mapping updated successfully.', schema: syncCollectionProductsResponse },
    404: { description: 'No such collection.' },
  },
  handler: async ({ params, body }) => ok(await service.sync(params.collectionId, body.productIds)),
});
