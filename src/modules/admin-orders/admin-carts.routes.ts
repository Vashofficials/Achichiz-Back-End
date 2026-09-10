import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated, noContent } from '../../lib/http.js';
import * as service from './admin-carts.service.js';
import {
  adminCart,
  cartIdParam,
  listAbandonedCartsQuery,
  remindCartBody,
} from './admin-carts.schemas.js';

export const adminCartsRouter: Router = Router();

defineRoute(adminCartsRouter, {
  method: 'get',
  path: '/v1/admin/abandoned-carts',
  surface: 'admin',
  operationId: 'listAbandonedCarts',
  summary: 'List abandoned carts',
  description: 'Returns all carts where abandoned_at is set and the stage is not converted.',
  tags: ['Admin Orders'],
  auth: 'staff',
  permission: { module: 'orders', action: 'view' },
  request: { query: listAbandonedCartsQuery },
  responses: {
    200: { description: 'Paginated abandoned carts.', schema: z.array(adminCart) },
  },
  handler: async ({ query }) => {
    const { items, meta } = await service.listAbandonedCarts(query);
    return paginated(items, meta);
  },
});

defineRoute(adminCartsRouter, {
  method: 'post',
  path: '/v1/admin/abandoned-carts/:cartId/remind',
  surface: 'admin',
  operationId: 'remindAbandonedCart',
  summary: 'Send cart recovery reminder',
  description: 'Triggers an email or WhatsApp recovery link to the customer.',
  tags: ['Admin Orders'],
  auth: 'staff',
  permission: { module: 'orders', action: 'edit' },
  request: { params: cartIdParam, body: remindCartBody },
  responses: {
    204: { description: 'Reminder dispatched successfully.' },
  },
  handler: async ({ params, body }) => {
    await service.remindCart(params.cartId, body.method);
    return noContent();
  },
});
