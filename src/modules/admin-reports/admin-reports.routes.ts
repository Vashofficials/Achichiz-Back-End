import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok, paginated, pageMeta, raw } from '../../lib/http.js';
import * as service from './admin-reports.service.js';
import {
  agingQuery,
  agingResponse,
  valuationQuery,
  valuationResponse,
  movementReportQuery,
  movementReportResponse,
  performanceQuery,
  productPerformanceResponse,
  supplierPerformanceResponse,
  healthResponse,
  velocityQuery,
  velocityResponse,
  forecastQuery,
  forecastResponse,
  exportParams,
  exportQuery,
} from './admin-reports.schemas.js';

export const adminReportsRouter: Router = Router();

const TAG = 'Admin reports';

defineRoute(adminReportsRouter, {
  method: 'get',
  path: '/v1/admin/reports/inventory-aging',
  surface: 'admin',
  operationId: 'adminReportInventoryAging',
  summary: 'Inventory aging report',
  description: 'Find stock sitting longer than threshold days.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: agingQuery },
  responses: {
    200: { description: 'A page of aging inventory.', schema: z.array(agingResponse) },
  },
  handler: async ({ query }) => {
    const { items, total } = await service.getInventoryAging(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminReportsRouter, {
  method: 'get',
  path: '/v1/admin/reports/dead-stock',
  surface: 'admin',
  operationId: 'adminReportDeadStock',
  summary: 'Dead stock report',
  description: 'Items that have not moved recently.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: agingQuery },
  responses: {
    200: { description: 'A page of dead stock.', schema: z.array(agingResponse) },
  },
  handler: async ({ query }) => {
    const { items, total } = await service.getDeadStock(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminReportsRouter, {
  method: 'get',
  path: '/v1/admin/reports/inventory-valuation',
  surface: 'admin',
  operationId: 'adminReportInventoryValuation',
  summary: 'Inventory valuation report',
  description: 'Calculate total value of on-hand inventory.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: valuationQuery },
  responses: {
    200: { description: 'A page of inventory values.', schema: z.array(valuationResponse) },
  },
  handler: async ({ query }) => {
    const { items, total } = await service.getInventoryValuation(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminReportsRouter, {
  method: 'get',
  path: '/v1/admin/reports/stock-movements',
  surface: 'admin',
  operationId: 'adminReportStockMovements',
  summary: 'Stock movements report',
  description: 'Aggregate stock movements over time.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: movementReportQuery },
  responses: {
    200: { description: 'A page of stock movement totals.', schema: z.array(movementReportResponse) },
  },
  handler: async ({ query }) => {
    const { items, total } = await service.getStockMovementsReport(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminReportsRouter, {
  method: 'get',
  path: '/v1/admin/reports/product-performance',
  surface: 'admin',
  operationId: 'adminReportProductPerformance',
  summary: 'Product performance report',
  description: 'Best selling products by volume and revenue.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: performanceQuery },
  responses: {
    200: { description: 'A page of product performance.', schema: z.array(productPerformanceResponse) },
  },
  handler: async ({ query }) => {
    const { items, total } = await service.getProductPerformance(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminReportsRouter, {
  method: 'get',
  path: '/v1/admin/reports/supplier-performance',
  surface: 'admin',
  operationId: 'adminReportSupplierPerformance',
  summary: 'Supplier performance report',
  description: 'Lead times, defect rates, PO fulfillment rates.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: performanceQuery },
  responses: {
    200: { description: 'A page of supplier performance.', schema: z.array(supplierPerformanceResponse) },
  },
  handler: async ({ query }) => {
    const { items, total } = await service.getSupplierPerformance(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminReportsRouter, {
  method: 'get',
  path: '/v1/admin/reports/inventory-health',
  surface: 'admin',
  operationId: 'adminReportInventoryHealth',
  summary: 'Overall inventory health',
  description: 'Stock status percentages (out of stock, low stock, overstock).',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: {},
  responses: {
    200: { description: 'Inventory health summary.', schema: healthResponse },
  },
  handler: async () => ok(await service.getInventoryHealth()),
});

defineRoute(adminReportsRouter, {
  method: 'get',
  path: '/v1/admin/reports/stock-velocity',
  surface: 'admin',
  operationId: 'adminReportStockVelocity',
  summary: 'Stock velocity report',
  description: 'Sales per day / week over time.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: velocityQuery },
  responses: {
    200: { description: 'A page of stock velocities.', schema: z.array(velocityResponse) },
  },
  handler: async ({ query }) => {
    const { items, total } = await service.getStockVelocity(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminReportsRouter, {
  method: 'get',
  path: '/v1/admin/reports/purchase-forecast',
  surface: 'admin',
  operationId: 'adminReportPurchaseForecast',
  summary: 'Purchase forecast report',
  description: 'Forecasted run-out date and order quantities.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { query: forecastQuery },
  responses: {
    200: { description: 'A page of purchase forecasts.', schema: z.array(forecastResponse) },
  },
  handler: async ({ query }) => {
    const { items, total } = await service.getPurchaseForecast(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

defineRoute(adminReportsRouter, {
  method: 'get',
  path: '/v1/admin/reports/:report/export',
  surface: 'admin',
  operationId: 'adminExportReport',
  summary: 'Export a report',
  description:
    'The same report as its JSON endpoint, unpaginated, as an RFC 4180 CSV attachment. Reads through ' +
    'the read-only pool, so a large export cannot contend with checkout writes.\n\n' +
    'Cells are quoted on comma, quote AND newline — an unquoted newline silently splits one record into ' +
    'two and shifts every row after it. Values that begin `=`, `+`, `-` or `@` are tab-prefixed: export ' +
    'rows carry supplier- and operator-supplied text, and a product title beginning `=HYPERLINK(...)` ' +
    'would otherwise execute when the file is opened in Excel.\n\n' +
    '`inventory-health` is not exportable — it returns one summary object, not rows.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'export' },
  rateLimit: 'export',
  request: {
    params: exportParams,
    query: exportQuery,
  },
  responses: {
    200: {
      description: 'A CSV attachment.',
      schema: z.string(),
      envelope: false,
    },
    422: { description: 'Unknown report name.' },
  },
  handler: async ({ params, query, res }) => {
    const csv = await service.exportReportData(params.report, query);
    const filename = `report-${params.report}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
    return raw();
  },
});
