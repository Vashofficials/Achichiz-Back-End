import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated } from '../../lib/http.js';
import * as service from './admin-returns.service.js';
import {
  adminReturnResponse,
  approveReturnBody,
  listReturnsQuery,
  refundReturnBody,
  rejectReturnBody,
  returnIdParam,
} from './admin-returns.schemas.js';

export const adminReturnsRouter: Router = Router();

defineRoute(adminReturnsRouter, {
  method: 'get',
  path: '/v1/admin/returns',
  surface: 'admin',
  // `listReturns` is taken by the CUSTOMER route in account.routes.ts, and
  // operationIds must be unique across both surfaces because they become
  // function names in the generated client. The collision made the registry
  // throw at import time, so `createApp()` could not be constructed at all —
  // the whole API failed to boot. Admin operations elsewhere in this module
  // are prefixed `admin*`; this now matches them.
  operationId: 'adminListReturns',
  summary: 'List returns',
  description: 'Admin list of all returns with pagination and filters.',
  tags: ['Admin Orders'],
  auth: 'staff',
  permission: { module: 'orders', action: 'view' },
  request: { query: listReturnsQuery },
  responses: {
    200: { description: 'Paginated returns.', schema: z.array(adminReturnResponse) },
  },
  handler: async ({ query }) => {
    const { items, meta } = await service.listReturns(query);
    return paginated(items, meta);
  },
});

defineRoute(adminReturnsRouter, {
  method: 'post',
  path: '/v1/admin/returns/:returnId/approve',
  surface: 'admin',
  operationId: 'approveReturn',
  summary: 'Approve return',
  description: 'Approves return and optionally assigns a courier AWB.',
  tags: ['Admin Orders'],
  auth: 'staff',
  permission: { module: 'orders', action: 'approve' },
  request: { params: returnIdParam, body: approveReturnBody },
  responses: {
    200: { description: 'Return approved.', schema: adminReturnResponse },
  },
  handler: async ({ params, body }) => ok(await service.approveReturn(params.returnId, body.pickupAwb)),
});

defineRoute(adminReturnsRouter, {
  method: 'post',
  path: '/v1/admin/returns/:returnId/refund',
  surface: 'admin',
  operationId: 'refundReturn',
  summary: 'Refund return',
  description: 'Executes refund state machine update.',
  tags: ['Admin Orders'],
  auth: 'staff',
  permission: { module: 'orders', action: 'refund' },
  request: { params: returnIdParam, body: refundReturnBody },
  responses: {
    200: { description: 'Return refunded.', schema: adminReturnResponse },
  },
  handler: async ({ params, body }) => ok(await service.refundReturn(params.returnId, body.refundPaise)),
});

defineRoute(adminReturnsRouter, {
  method: 'post',
  path: '/v1/admin/returns/:returnId/reject',
  surface: 'admin',
  operationId: 'rejectReturn',
  summary: 'Reject return',
  description: 'Rejects return with staff reason.',
  tags: ['Admin Orders'],
  auth: 'staff',
  permission: { module: 'orders', action: 'cancel' },
  request: { params: returnIdParam, body: rejectReturnBody },
  responses: {
    200: { description: 'Return rejected.', schema: adminReturnResponse },
  },
  handler: async ({ params, body }) => ok(await service.rejectReturn(params.returnId, body.reasonNote)),
});
