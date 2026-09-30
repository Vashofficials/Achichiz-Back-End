import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated } from '../../lib/http.js';
import * as service from './admin-invoices.service.js';
import {
  adminInvoiceDetail,
  adminInvoiceResponse,
  batchInvoicesBody,
  invoiceIdParam,
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
    200: { description: 'Paginated invoices.', schema: z.array(adminInvoiceResponse) },
  },
  handler: async ({ query }) => {
    const { items, meta } = await service.listInvoices(query);
    return paginated(items, meta);
  },
});

defineRoute(adminInvoicesRouter, {
  method: 'get',
  path: '/v1/admin/invoices/:id',
  surface: 'admin',
  operationId: 'getInvoiceDetail',
  summary: 'Get invoice detail',
  description: 'Full GST invoice details including line items, tax splits, and buyer data.',
  tags: ['Admin Payments'],
  auth: 'staff',
  permission: { module: 'finance', action: 'view' },
  request: { params: invoiceIdParam },
  responses: {
    200: { description: 'The invoice details.', schema: adminInvoiceDetail },
  },
  handler: async ({ params }) => ok(await service.getInvoice(params.id)),
});

defineRoute(adminInvoicesRouter, {
  method: 'post',
  path: '/v1/admin/invoices/batch',
  surface: 'admin',
  operationId: 'getBatchInvoices',
  summary: 'Get multiple invoices for batch PDF / print',
  description: 'Returns multiple invoices with full line item details for batch download and printing.',
  tags: ['Admin Payments'],
  auth: 'staff',
  permission: { module: 'finance', action: 'view' },
  request: { body: batchInvoicesBody },
  responses: {
    200: { description: 'Array of invoice details.', schema: z.array(adminInvoiceDetail) },
  },
  handler: async ({ body }) => ok(await service.getBatchInvoices(body.ids)),
});
