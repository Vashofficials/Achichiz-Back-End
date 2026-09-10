import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated } from '../../lib/http.js';
import * as service from './admin-exchanges.service.js';
import {
  adminExchangeResponse,
  approveExchangeBody,
  exchangeIdParam,
  listExchangesQuery,
} from './admin-exchanges.schemas.js';

export const adminExchangesRouter: Router = Router();

defineRoute(adminExchangesRouter, {
  method: 'get',
  path: '/v1/admin/exchanges',
  surface: 'admin',
  // Same collision as adminListReturns — `listExchanges` belongs to the
  // customer route in account.routes.ts.
  operationId: 'adminListExchanges',
  summary: 'List exchanges',
  description: 'Admin list of all swap requests with variant from/to and price differences.',
  tags: ['Admin Orders'],
  auth: 'staff',
  permission: { module: 'orders', action: 'view' },
  request: { query: listExchangesQuery },
  responses: {
    200: { description: 'Paginated exchanges.', schema: z.array(adminExchangeResponse) },
  },
  handler: async ({ query }) => {
    const { items, meta } = await service.listExchanges(query);
    return paginated(items, meta);
  },
});

defineRoute(adminExchangesRouter, {
  method: 'post',
  path: '/v1/admin/exchanges/:exchangeId/approve',
  surface: 'admin',
  operationId: 'approveExchange',
  summary: 'Approve exchange',
  description: 'Approves exchange, generates replacement child order, and reserves warehouse stock.',
  tags: ['Admin Orders'],
  auth: 'staff',
  permission: { module: 'orders', action: 'approve' },
  request: { params: exchangeIdParam, body: approveExchangeBody },
  responses: {
    200: { description: 'Exchange approved.' },
  },
  handler: async ({ params }) => {
    await service.approveExchange(params.exchangeId);
    return ok({ type: 'success' }); // To maintain standard pattern if we return a non-standard response
  },
});
