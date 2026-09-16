/**
 * Admin CMS section items — routes.
 */

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, noContent, ok } from '../../lib/http.js';
import * as service from './admin-cms-items.service.js';
import {
  adminCmsItemDetail,
  createCmsItemBody,
  reorderCmsItemsBody,
  sectionIdParam,
  sectionItemIdParam,
  updateCmsItemBody,
} from './admin-cms-items.schemas.js';

export const adminCmsItemsRouter: Router = Router();

/* ------------------------------------------------------------- GET /items */
defineRoute(adminCmsItemsRouter, {
  method: 'get',
  path: '/v1/admin/cms/sections/:sectionId/items',
  surface: 'admin',
  operationId: 'adminListCmsSectionItems',
  summary: 'List items within a CMS section',
  description: 'Returns all items (tiles/cards) authored for the given section.',
  tags: ['Admin / Content'],
  auth: 'staff',
  permission: { module: 'content', action: 'view' },
  request: { params: sectionIdParam },
  responses: {
    200: { description: 'Ordered list of items.', schema: z.array(adminCmsItemDetail) },
    404: { description: 'No such CMS section.' },
  },
  handler: async ({ params }) => ok(await service.list(params.sectionId)),
});

/* ------------------------------------------------------------ POST /items */
defineRoute(adminCmsItemsRouter, {
  method: 'post',
  path: '/v1/admin/cms/sections/:sectionId/items',
  surface: 'admin',
  operationId: 'adminCreateCmsSectionItem',
  summary: 'Add an item to a CMS section',
  description: 'Inserts a new item into the section, resolving links to collections/products.',
  tags: ['Admin / Content'],
  auth: 'staff',
  permission: { module: 'content', action: 'edit' },
  request: { params: sectionIdParam, body: createCmsItemBody },
  responses: {
    201: { description: 'Item created.', schema: adminCmsItemDetail },
    404: { description: 'No such CMS section.' },
  },
  handler: async ({ params, body }) => created(await service.create(params.sectionId, body)),
});

/* --------------------------------------------------- PUT /items/:itemId */
defineRoute(adminCmsItemsRouter, {
  method: 'put',
  path: '/v1/admin/cms/sections/:sectionId/items/:itemId',
  surface: 'admin',
  operationId: 'adminUpdateCmsSectionItem',
  summary: 'Update a CMS section item',
  description: 'Updates properties of a specific section card/tile.',
  tags: ['Admin / Content'],
  auth: 'staff',
  permission: { module: 'content', action: 'edit' },
  request: { params: sectionItemIdParam, body: updateCmsItemBody },
  responses: {
    200: { description: 'Item updated.', schema: adminCmsItemDetail },
    404: { description: 'No such item or section.' },
  },
  handler: async ({ params, body }) => ok(await service.update(params.sectionId, params.itemId, body)),
});

/* ------------------------------------------------ DELETE /items/:itemId */
defineRoute(adminCmsItemsRouter, {
  method: 'delete',
  path: '/v1/admin/cms/sections/:sectionId/items/:itemId',
  surface: 'admin',
  operationId: 'adminDeleteCmsSectionItem',
  summary: 'Delete a CMS section item',
  description: 'Removes an item from the section.',
  tags: ['Admin / Content'],
  auth: 'staff',
  permission: { module: 'content', action: 'edit' },
  request: { params: sectionItemIdParam },
  responses: {
    204: { description: 'Item deleted.' },
    404: { description: 'No such item or section.' },
  },
  handler: async ({ params }) => {
    await service.remove(params.sectionId, params.itemId);
    return noContent();
  },
});

/* --------------------------------------------------- PUT /items/reorder */
defineRoute(adminCmsItemsRouter, {
  method: 'put',
  path: '/v1/admin/cms/sections/:sectionId/items-reorder',
  surface: 'admin',
  operationId: 'adminReorderCmsSectionItems',
  summary: 'Reorder items in a CMS section',
  description: 'Applies new position indices based on the ordered array of item UUIDs.',
  tags: ['Admin / Content'],
  auth: 'staff',
  permission: { module: 'content', action: 'edit' },
  request: { params: sectionIdParam, body: reorderCmsItemsBody },
  responses: {
    200: { description: 'Items reordered.', schema: z.array(adminCmsItemDetail) },
    404: { description: 'No such CMS section.' },
  },
  handler: async ({ params, body }) => ok(await service.reorder(params.sectionId, body.itemIds)),
});
