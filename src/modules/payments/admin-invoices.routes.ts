import { Router } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { paginated } from '../../lib/http.js';
import * as service from './admin-invoices.service.js';
import {
  adminInvoiceResponse,
  listInvoicesQuery,
} from './admin-invoices.schemas.js';

export const adminInvoicesRouter: Router = Router();

defineRoute(adminInvoicesRouter, {
  method: 'get',
  path: '/v1/admin/invoices',
  surface: 'admin',
  operationId: 'listInvoices',
  summary: 'List invoices',
  description: 'Admin list of all tax invoices.',
  tags: ['Admin Payments'],
  auth: 'staff',
  permission: { module: 'finance', action: 'view' },
  request: { query: listInvoicesQuery },
  responses: {
    200: { description: 'Paginated invoices.', schema: adminInvoiceResponse },
  },
  handler: async ({ query }) => {
    const { items, meta } = await service.listInvoices(query);
    return paginated(items, meta);
  },
});
