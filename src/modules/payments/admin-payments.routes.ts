import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated } from '../../lib/http.js';
import * as service from './admin-payments.service.js';
import {
  adminPaymentResponse,
  listPaymentsQuery,
  paymentIdParam,
  reconcilePaymentBody,
} from './admin-payments.schemas.js';

export const adminPaymentsRouter: Router = Router();

defineRoute(adminPaymentsRouter, {
  method: 'get',
  path: '/v1/admin/payments',
  surface: 'admin',
  operationId: 'listPayments',
  summary: 'List payments',
  description: 'Admin list of all payments, suitable for master audit desk.',
  tags: ['Admin Payments'],
  auth: 'staff',
  permission: { module: 'finance', action: 'view' },
  request: { query: listPaymentsQuery },
  responses: {
    200: { description: 'Paginated payments.', schema: z.array(adminPaymentResponse) },
  },
  handler: async ({ query }) => {
    const { items, meta } = await service.listPayments(query);
    return paginated(items, meta);
  },
});

defineRoute(adminPaymentsRouter, {
  method: 'post',
  path: '/v1/admin/payments/:paymentId/reconcile',
  surface: 'admin',
  operationId: 'reconcilePayment',
  summary: 'Reconcile payment',
  description: 'Mark a payment as settled with a settlement reference from the gateway.',
  tags: ['Admin Payments'],
  auth: 'staff',
  permission: { module: 'finance', action: 'edit' },
  request: { params: paymentIdParam, body: reconcilePaymentBody },
  responses: {
    200: { description: 'Payment reconciled.' },
  },
  handler: async ({ params, body }) => {
    await service.reconcilePayment(params.paymentId, body.settlementRef);
    return ok({ type: 'success' });
  },
});
