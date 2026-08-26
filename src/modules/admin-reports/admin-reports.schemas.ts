import { z } from 'zod';
import { paginationQuery } from '../../lib/pagination.js';

export const dateRangeQuery = z.object({
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export const agingQuery = paginationQuery.extend({
  warehouseId: z.string().uuid().optional(),
  thresholdDays: z.coerce.number().int().min(1).default(90),
});

export const agingResponse = z.object({
  variantId: z.string().uuid().nullable(),
  hamperItemId: z.string().uuid().nullable(),
  packagingId: z.string().uuid().nullable(),
  sku: z.string(),
  name: z.string(),
  warehouseId: z.string().uuid(),
  onHandQty: z.number().int(),
  ageDays: z.number().int(),
});

export const valuationQuery = paginationQuery.extend({
  warehouseId: z.string().uuid().optional(),
});

export const valuationResponse = z.object({
  variantId: z.string().uuid().nullable(),
  hamperItemId: z.string().uuid().nullable(),
  packagingId: z.string().uuid().nullable(),
  sku: z.string(),
  name: z.string(),
  warehouseId: z.string().uuid(),
  onHandQty: z.number().int(),
  unitCostPaise: z.number().int(),
  totalValuePaise: z.number().int(),
});

export const movementReportQuery = paginationQuery.merge(dateRangeQuery).extend({
  warehouseId: z.string().uuid().optional(),
});

export const movementReportResponse = z.object({
  movementType: z.string(),
  totalQuantity: z.number().int(),
  eventCount: z.number().int(),
});

export const performanceQuery = paginationQuery.merge(dateRangeQuery);

export const productPerformanceResponse = z.object({
  variantId: z.string().uuid().nullable(),
  sku: z.string(),
  name: z.string(),
  unitsSold: z.number().int(),
  revenuePaise: z.number().int(),
});

export const supplierPerformanceResponse = z.object({
  supplierId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  totalOrders: z.number().int(),
  avgLeadTimeDays: z.number().nullable(),
  defectRateBp: z.number().int(),
});

export const healthResponse = z.object({
  totalSkus: z.number().int(),
  outOfStockCount: z.number().int(),
  lowStockCount: z.number().int(),
  healthyStockCount: z.number().int(),
  overstockCount: z.number().int(),
});

export const velocityQuery = paginationQuery.extend({
  warehouseId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const velocityResponse = z.object({
  variantId: z.string().uuid().nullable(),
  hamperItemId: z.string().uuid().nullable(),
  packagingId: z.string().uuid().nullable(),
  sku: z.string(),
  name: z.string(),
  warehouseId: z.string().uuid(),
  availableQty: z.number().int(),
  unitsPerDay: z.number(),
});

export const forecastQuery = velocityQuery;

/**
 * The reports `GET /:report/export` accepts.
 *
 * An enum rather than a free string: it makes the path parameter self-documenting
 * in Swagger, and it turns an unknown report into a 422 from the validator rather
 * than a 400 the service has to raise by hand.
 *
 * `inventory-health` is deliberately absent — it returns a single summary object,
 * not rows, and there is nothing to put in a CSV.
 */
export const EXPORTABLE_REPORTS = [
  'inventory-aging',
  'dead-stock',
  'inventory-valuation',
  'stock-movements',
  'product-performance',
  'supplier-performance',
  'stock-velocity',
  'purchase-forecast',
] as const;

export const exportParams = z.object({
  report: z.enum(EXPORTABLE_REPORTS).describe('Which report to export.'),
});

/**
 * Every filter any report accepts, all optional.
 *
 * A single union rather than a per-report query, because one endpoint serves
 * eight reports. Filters that do not apply to the chosen report are ignored —
 * `days` on the valuation report changes nothing.
 *
 * Pagination is deliberately absent: an export is the whole result set, capped
 * server-side.
 */
export const exportQuery = z.object({
  warehouseId: z.string().uuid().optional().describe('Restrict to one warehouse, where the report supports it.'),
  startDate: z.coerce.date().optional().describe('Range start, for the movement and performance reports.'),
  endDate: z.coerce.date().optional().describe('Range end.'),
  thresholdDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(3_650)
    .optional()
    .describe('Aging/dead-stock threshold in days.'),
  days: z.coerce.number().int().min(1).max(365).optional().describe('Look-back window for velocity and forecast.'),
});

export const forecastResponse = velocityResponse.extend({
  runOutDays: z.number().nullable(),
  suggestedOrderQty: z.number().int(),
});
