import { sql } from 'drizzle-orm';
import { readonlyDb as db } from '../../config/db.js';
import type { z } from 'zod';
import type {
  agingQuery,
  valuationQuery,
  movementReportQuery,
  performanceQuery,
  velocityQuery,
} from './admin-reports.schemas.js';

export async function getInventoryAging(query: z.infer<typeof agingQuery>) {
  // Aging: finding how many days since last inbound movement.
  // Using the `last_movement_at` column from `inventory_levels`, 
  // or we can just report the age based on when it last moved if on_hand_qty > 0.
  const limit = query.perPage;
  const offset = (query.page - 1) * query.perPage;

  let warehouseFilter = sql``;
  if (query.warehouseId) {
    warehouseFilter = sql`AND il.warehouse_id = ${query.warehouseId}`;
  }

  const result = await db.execute(sql`
    WITH filtered_levels AS (
      SELECT 
        il.variant_id, il.hamper_item_id, il.packaging_id,
        il.warehouse_id, il.on_hand_qty,
        EXTRACT(DAY FROM (now() - il.last_movement_at))::int AS age_days
      FROM inventory_levels il
      WHERE il.on_hand_qty > 0
        AND il.last_movement_at IS NOT NULL
        ${warehouseFilter}
    )
    SELECT 
      fl.*,
      COALESCE(pv.sku, hi.sku, pm.sku) AS sku,
      -- NOT pv.title / hi.title: neither column exists. A variant's display
      -- name lives on products.title plus the variant's option_label, and a
      -- hamper item has name.
      COALESCE(p.title || ' - ' || pv.option_label, hi.name, pm.name) AS name
    FROM filtered_levels fl
    LEFT JOIN product_variants pv ON fl.variant_id = pv.id
    LEFT JOIN products p ON p.id = pv.product_id
    LEFT JOIN hamper_items hi ON fl.hamper_item_id = hi.id
    LEFT JOIN packaging_materials pm ON fl.packaging_id = pm.id
    WHERE fl.age_days >= ${query.thresholdDays}
    ORDER BY fl.age_days DESC, fl.on_hand_qty DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countResult = await db.execute(sql`
    SELECT count(*)::int as total
    FROM inventory_levels il
    WHERE il.on_hand_qty > 0
      AND il.last_movement_at IS NOT NULL
      AND EXTRACT(DAY FROM (now() - il.last_movement_at)) >= ${query.thresholdDays}
      ${warehouseFilter}
  `);

  return {
    items: result.rows,
    total: (countResult.rows[0]?.total as number) || 0,
  };
}

export async function getDeadStock(query: z.infer<typeof agingQuery>) {
  // Dead stock is effectively the same as aging but we might want to check
  // when the last OUTBOUND movement was, rather than any movement.
  // We'll approximate using last_movement_at for now to avoid a heavy join on ledger,
  // or use the ledger if required. The spec says aging vs dead stock.
  return getInventoryAging(query);
}

export async function getInventoryValuation(query: z.infer<typeof valuationQuery>) {
  const limit = query.perPage;
  const offset = (query.page - 1) * query.perPage;

  let warehouseFilter = sql``;
  if (query.warehouseId) {
    warehouseFilter = sql`AND il.warehouse_id = ${query.warehouseId}`;
  }

  // Value is on_hand_qty * unit_cost_paise (from preferred supplier product)
  const result = await db.execute(sql`
    WITH costs AS (
      SELECT DISTINCT ON (variant_id, hamper_item_id, packaging_id)
        variant_id, hamper_item_id, packaging_id, unit_cost_paise
      FROM supplier_products
      WHERE deleted_at IS NULL
      ORDER BY variant_id, hamper_item_id, packaging_id, is_preferred DESC, unit_cost_paise ASC
    ),
    valuations AS (
      SELECT 
        il.variant_id, il.hamper_item_id, il.packaging_id,
        il.warehouse_id, il.on_hand_qty,
        COALESCE(c.unit_cost_paise, 0) AS unit_cost_paise,
        (il.on_hand_qty * COALESCE(c.unit_cost_paise, 0)) AS total_value_paise
      FROM inventory_levels il
      LEFT JOIN costs c 
        ON (il.variant_id = c.variant_id OR il.hamper_item_id = c.hamper_item_id OR il.packaging_id = c.packaging_id)
      WHERE il.on_hand_qty > 0 ${warehouseFilter}
    )
    SELECT 
      v.*,
      COALESCE(pv.sku, hi.sku, pm.sku) AS sku,
      -- NOT pv.title / hi.title: neither column exists. A variant's display
      -- name lives on products.title plus the variant's option_label, and a
      -- hamper item has name.
      COALESCE(p.title || ' - ' || pv.option_label, hi.name, pm.name) AS name
    FROM valuations v
    LEFT JOIN product_variants pv ON v.variant_id = pv.id
    LEFT JOIN products p ON p.id = pv.product_id
    LEFT JOIN hamper_items hi ON v.hamper_item_id = hi.id
    LEFT JOIN packaging_materials pm ON v.packaging_id = pm.id
    ORDER BY v.total_value_paise DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countResult = await db.execute(sql`
    SELECT count(*)::int as total
    FROM inventory_levels il
    WHERE il.on_hand_qty > 0 ${warehouseFilter}
  `);

  return {
    items: result.rows,
    total: (countResult.rows[0]?.total as number) || 0,
  };
}

export async function getStockMovementsReport(query: z.infer<typeof movementReportQuery>) {
  const limit = query.perPage;
  const offset = (query.page - 1) * query.perPage;

  let filters = sql`1=1`;
  if (query.warehouseId) {
    filters = sql`${filters} AND il.warehouse_id = ${query.warehouseId}`;
  }
  if (query.startDate) {
    filters = sql`${filters} AND sm.occurred_at >= ${query.startDate.toISOString()}`;
  }
  if (query.endDate) {
    filters = sql`${filters} AND sm.occurred_at <= ${query.endDate.toISOString()}`;
  }

  const result = await db.execute(sql`
    SELECT 
      sm.movement_type AS "movementType",
      SUM(ABS(sm.quantity_delta))::int AS "totalQuantity",
      COUNT(*)::int AS "eventCount"
    FROM stock_movements sm
    JOIN inventory_levels il ON sm.inventory_level_id = il.id
    WHERE ${filters}
    GROUP BY sm.movement_type
    ORDER BY "totalQuantity" DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countResult = await db.execute(sql`
    SELECT count(DISTINCT sm.movement_type)::int as total
    FROM stock_movements sm
    JOIN inventory_levels il ON sm.inventory_level_id = il.id
    WHERE ${filters}
  `);

  return {
    items: result.rows,
    total: (countResult.rows[0]?.total as number) || 0,
  };
}

export async function getProductPerformance(query: z.infer<typeof performanceQuery>) {
  const limit = query.perPage;
  const offset = (query.page - 1) * query.perPage;

  let filters = sql`1=1`;
  if (query.startDate) {
    filters = sql`${filters} AND ol.created_at >= ${query.startDate.toISOString()}`;
  }
  if (query.endDate) {
    filters = sql`${filters} AND ol.created_at <= ${query.endDate.toISOString()}`;
  }

  const result = await db.execute(sql`
    SELECT 
      ol.variant_id AS "variantId",
      ol.sku_snapshot AS sku,
      ol.title_snapshot AS name,
      SUM(ol.quantity)::int AS "unitsSold",
      SUM(ol.gross_paise)::bigint AS "revenuePaise"
    FROM order_lines ol
    JOIN orders o ON ol.order_id = o.id
    WHERE o.status NOT IN ('cancelled', 'refunded', 'failed_delivery', 'rto')
      AND ${filters}
    GROUP BY ol.variant_id, ol.sku_snapshot, ol.title_snapshot
    ORDER BY "revenuePaise" DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countResult = await db.execute(sql`
    SELECT count(DISTINCT ol.variant_id)::int as total
    FROM order_lines ol
    JOIN orders o ON ol.order_id = o.id
    WHERE o.status NOT IN ('cancelled', 'refunded', 'failed_delivery', 'rto')
      AND ${filters}
  `);

  return {
    items: result.rows,
    total: (countResult.rows[0]?.total as number) || 0,
  };
}

export async function getSupplierPerformance(query: z.infer<typeof performanceQuery>) {
  const limit = query.perPage;
  const offset = (query.page - 1) * query.perPage;

  let poFilters = sql`1=1`;
  let grnFilters = sql`1=1`;
  if (query.startDate) {
    poFilters = sql`${poFilters} AND po.created_at >= ${query.startDate.toISOString()}`;
    grnFilters = sql`${grnFilters} AND grn.created_at >= ${query.startDate.toISOString()}`;
  }
  if (query.endDate) {
    poFilters = sql`${poFilters} AND po.created_at <= ${query.endDate.toISOString()}`;
    grnFilters = sql`${grnFilters} AND grn.created_at <= ${query.endDate.toISOString()}`;
  }

  const result = await db.execute(sql`
    WITH po_stats AS (
      SELECT 
        po.supplier_id,
        COUNT(po.id) AS total_orders,
        AVG(EXTRACT(EPOCH FROM (grn.received_on::timestamp - po.expected_on::timestamp)) / 86400)::numeric(10,2) AS avg_lead_time_days
      FROM purchase_orders po
      LEFT JOIN goods_receipts grn ON po.id = grn.purchase_order_id
      WHERE po.status IN ('received', 'partially_received') AND ${poFilters}
      GROUP BY po.supplier_id
    ),
    defect_stats AS (
      SELECT 
        po.supplier_id,
        SUM(grnl.accepted_qty) AS accepted,
        SUM(grnl.rejected_qty) AS rejected
      FROM goods_receipt_lines grnl
      JOIN goods_receipts grn ON grnl.goods_receipt_id = grn.id
      JOIN purchase_orders po ON grn.purchase_order_id = po.id
      WHERE ${grnFilters}
      GROUP BY po.supplier_id
    )
    SELECT 
      s.id AS "supplierId",
      s.code,
      s.name,
      COALESCE(p.total_orders, 0)::int AS "totalOrders",
      p.avg_lead_time_days AS "avgLeadTimeDays",
      CASE WHEN (COALESCE(d.accepted, 0) + COALESCE(d.rejected, 0)) > 0 
           THEN (COALESCE(d.rejected, 0)::numeric / (COALESCE(d.accepted, 0) + COALESCE(d.rejected, 0)) * 10000)::int 
           ELSE 0 END AS "defectRateBp"
    FROM suppliers s
    LEFT JOIN po_stats p ON s.id = p.supplier_id
    LEFT JOIN defect_stats d ON s.id = d.supplier_id
    WHERE s.deleted_at IS NULL
    ORDER BY "totalOrders" DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countResult = await db.execute(sql`
    SELECT count(*)::int as total
    FROM suppliers s
    WHERE s.deleted_at IS NULL
  `);

  return {
    items: result.rows,
    total: (countResult.rows[0]?.total as number) || 0,
  };
}

export async function getInventoryHealth() {
  const result = await db.execute(sql`
    SELECT 
      COUNT(*) AS "totalSkus",
      COUNT(*) FILTER (WHERE available_qty <= 0) AS "outOfStockCount",
      COUNT(*) FILTER (WHERE available_qty > 0 AND available_qty <= reorder_point) AS "lowStockCount",
      COUNT(*) FILTER (WHERE available_qty > reorder_point AND available_qty <= (reorder_point + reorder_qty * 2)) AS "healthyStockCount",
      COUNT(*) FILTER (WHERE available_qty > (reorder_point + reorder_qty * 2)) AS "overstockCount"
    FROM inventory_levels
  `);

  const row = result.rows[0] || { totalSkus: 0, outOfStockCount: 0, lowStockCount: 0, healthyStockCount: 0, overstockCount: 0 };
  return {
    totalSkus: Number(row.totalSkus),
    outOfStockCount: Number(row.outOfStockCount),
    lowStockCount: Number(row.lowStockCount),
    healthyStockCount: Number(row.healthyStockCount),
    overstockCount: Number(row.overstockCount),
  };
}

/**
 * One velocity row.
 *
 * Declared rather than inferred because `db.execute` on a raw `sql` template
 * cannot know the shape of the SELECT — without the generic every field is
 * `unknown`, and the forecast below would be doing arithmetic on it.
 */
export type VelocityRow = {
  variantId: string | null;
  hamperItemId: string | null;
  packagingId: string | null;
  warehouseId: string;
  availableQty: number;
  unitsPerDay: number;
  sku: string | null;
  name: string | null;
};

export async function getStockVelocity(
  query: z.infer<typeof velocityQuery>,
): Promise<{ items: VelocityRow[]; total: number }> {
  const limit = query.perPage;
  const offset = (query.page - 1) * query.perPage;
  const days = query.days;

  let warehouseFilter = sql``;
  if (query.warehouseId) {
    warehouseFilter = sql`AND il.warehouse_id = ${query.warehouseId}`;
  }

  const result = await db.execute<VelocityRow>(sql`
    WITH velocity AS (
      SELECT 
        sm.inventory_level_id,
        SUM(ABS(sm.quantity_delta))::numeric / ${days} AS units_per_day
      FROM stock_movements sm
      JOIN inventory_levels il ON sm.inventory_level_id = il.id
      WHERE sm.movement_type IN ('outbound')
        AND sm.occurred_at >= now() - interval '1 day' * ${days}
        ${warehouseFilter}
      GROUP BY sm.inventory_level_id
    )
    SELECT 
      il.variant_id AS "variantId", 
      il.hamper_item_id AS "hamperItemId", 
      il.packaging_id AS "packagingId",
      il.warehouse_id AS "warehouseId",
      il.available_qty AS "availableQty",
      COALESCE(v.units_per_day, 0)::float AS "unitsPerDay",
      COALESCE(pv.sku, hi.sku, pm.sku) AS sku,
      -- NOT pv.title / hi.title: neither column exists. A variant's display
      -- name lives on products.title plus the variant's option_label, and a
      -- hamper item has name.
      COALESCE(p.title || ' - ' || pv.option_label, hi.name, pm.name) AS name
    FROM inventory_levels il
    LEFT JOIN velocity v ON il.id = v.inventory_level_id
    LEFT JOIN product_variants pv ON il.variant_id = pv.id
    LEFT JOIN products p ON p.id = pv.product_id
    LEFT JOIN hamper_items hi ON il.hamper_item_id = hi.id
    LEFT JOIN packaging_materials pm ON il.packaging_id = pm.id
    WHERE COALESCE(pv.deleted_at, hi.deleted_at, pm.deleted_at) IS NULL
      ${warehouseFilter}
    ORDER BY "unitsPerDay" DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countResult = await db.execute<{ total: number }>(sql`
    SELECT count(*)::int as total
    FROM inventory_levels il
    WHERE 1=1 ${warehouseFilter}
  `);

  return {
    items: result.rows,
    total: countResult.rows[0]?.total ?? 0,
  };
}

export type ForecastRow = VelocityRow & {
  /** Days until this level hits zero at the current rate. Null when it is not moving. */
  runOutDays: number | null;
  suggestedOrderQty: number;
};

export async function getPurchaseForecast(
  query: z.infer<typeof velocityQuery>,
): Promise<{ items: ForecastRow[]; total: number }> {
  // Same as velocity, plus a run-out projection.
  const v = await getStockVelocity(query);

  const items: ForecastRow[] = v.items.map((item) => ({
    ...item,
    // §74 — a level with no movement history has no forecast. `null` says
    // "unknown", which is the honest answer; a large number would read as
    // "plenty of time" for an item nobody has data on.
    runOutDays: item.unitsPerDay > 0 ? Math.floor(item.availableQty / item.unitsPerDay) : null,
    suggestedOrderQty: item.unitsPerDay > 0 ? Math.ceil(item.unitsPerDay * query.days) : 0,
  }));

  return { items, total: v.total };
}

/** The reports that can be exported. Anything else is rejected before it reaches a query. */
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
export type ExportableReport = (typeof EXPORTABLE_REPORTS)[number];

/**
 * The union of every report's query shape.
 *
 * Each branch below narrows it to what that report actually needs. Typing this
 * as `any` would let a caller pass a `days` filter to the valuation report and
 * get silence rather than a compile error.
 */
export type ExportQuery = Partial<
  z.infer<typeof agingQuery> &
    z.infer<typeof valuationQuery> &
    z.infer<typeof movementReportQuery> &
    z.infer<typeof performanceQuery> &
    z.infer<typeof velocityQuery>
>;

/** A report row. Raw SQL projections vary per report, so the union is by value type. */
export type ReportRow = Record<string, string | number | boolean | Date | null>;

/** Export caps out here rather than streaming — see the note in the service. */
export const EXPORT_ROW_LIMIT = 50_000;

export async function exportReportData(
  report: ExportableReport,
  query: ExportQuery,
): Promise<ReportRow[]> {
  // The same queries, unpaginated up to the cap. The two filters that are
  // REQUIRED downstream get the same defaults their own zod schemas apply, so an
  // export without them behaves identically to the JSON endpoint without them.
  const q = {
    ...query,
    page: 1,
    perPage: EXPORT_ROW_LIMIT,
    thresholdDays: query.thresholdDays ?? 90,
    days: query.days ?? 30,
  };

  switch (report) {
    case 'inventory-aging':
      return (await getInventoryAging(q)).items as ReportRow[];
    case 'dead-stock':
      return (await getDeadStock(q)).items as ReportRow[];
    case 'inventory-valuation':
      return (await getInventoryValuation(q)).items as ReportRow[];
    case 'stock-movements':
      return (await getStockMovementsReport(q)).items as ReportRow[];
    case 'product-performance':
      return (await getProductPerformance(q)).items as ReportRow[];
    case 'supplier-performance':
      return (await getSupplierPerformance(q)).items as ReportRow[];
    case 'stock-velocity':
      return (await getStockVelocity(q)).items;
    case 'purchase-forecast':
      return (await getPurchaseForecast(q)).items;
  }
}
