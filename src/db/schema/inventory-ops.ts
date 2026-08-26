/**
 * inventory-ops.ts — §2.5b (migration 0003_inventory.sql)
 *
 * The OPERATIONS half of the inventory context. `inventory.ts` owns the state —
 * levels, reservations, the movement ledger, warehouses, suppliers, POs, GRNs,
 * transfers. This file owns the processes that CHANGE that state and did not
 * exist in 0001: bin locations, supplier catalogues, purchase returns, physical
 * counts, and production runs.
 *
 * Split into its own file rather than appended to `inventory.ts` because that
 * file is already 800+ lines and these are a distinct concern. Both are
 * re-exported from the barrel, so application code sees one surface.
 *
 * SQL-only objects backing this file (see migrations/0003_inventory.sql):
 *  - stock_count_items.variance_qty is GENERATED ALWAYS AS
 *    (COALESCE(counted_qty,0) - system_qty) STORED. Declared with
 *    .generatedAlwaysAs() below so it is typed on select; SQL is authoritative.
 *  - The widened stock_movements CHECK constraints (five new movement types,
 *    three new reference types) live only in the migration.
 *  - PARTIAL unique indexes WHERE deleted_at IS NULL on warehouse_locations.path
 *    and every supplier_products target — a soft-deleted bin must not squat on
 *    its code forever.
 *  - CHECK stock_counts_approved_by_required: an approved count must name its
 *    approver. Anonymous approval defeats the point of an approval step.
 *  - trg_*_updated BEFORE UPDATE triggers calling set_updated_at().
 */

import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  char,
  integer,
  bigint,
  numeric,
  boolean,
  date,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { staffUsers } from './identity.js';
import { productVariants, hamperItems } from './catalogue.js';
import { packagingMaterials } from './delivery.js';
import { warehouses, suppliers, inventoryLevels, goodsReceipts } from './inventory.js';

/* ------------------------------------------------------ shared vocabularies */

/**
 * Units of measure.
 *
 * Raw materials are not all counted in pieces — wax is grams, fragrance is ml,
 * ribbon is meters. Conversion between them is deliberately NOT modelled: a BOM
 * line and the inventory level it draws from must already agree on the unit, so
 * there is no silent gram→kg arithmetic to get wrong.
 */
export const UOM = ['piece', 'gram', 'kg', 'ml', 'litre', 'meter'] as const;
export type Uom = (typeof UOM)[number];

export const LOCATION_KINDS = ['zone', 'rack', 'shelf', 'bin'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/* --------------------------------------------------- warehouse_locations §18 */

export const warehouseLocations = pgTable(
  'warehouse_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'cascade' }),
    /** Self-referencing: a bin's parent is a shelf, a shelf's is a rack, and so on. */
    parentId: uuid('parent_id').references((): AnyPgColumn => warehouseLocations.id, {
      onDelete: 'restrict',
    }),
    kind: text('kind').notNull().$type<LocationKind>(),
    /** Segment code, unique within its parent — 'B7'. */
    code: text('code').notNull(),
    name: text('name'),
    /**
     * Materialised full path — 'A/R3/S2/B7'.
     *
     * Denormalised on purpose: a pick list renders hundreds of rows, and walking
     * parents per row is a recursive query per line. The service writes this on
     * create/move; it is never edited directly.
     */
    path: text('path').notNull(),
    isPickable: boolean('is_pickable').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_warehouse_locations_path')
      .on(t.warehouseId, t.path)
      .where(sql`deleted_at IS NULL`),
    index('idx_warehouse_locations_parent').on(t.parentId),
    index('idx_warehouse_locations_wh').on(t.warehouseId, t.kind),
    check('warehouse_locations_kind_check', sql`kind IN ('zone','rack','shelf','bin')`),
    check('warehouse_locations_code_check', sql`code ~ '^[A-Z0-9][A-Z0-9._-]{0,23}$'`),
    check('warehouse_locations_not_self_parent', sql`parent_id IS DISTINCT FROM id`),
  ],
);

/* ------------------------------------------------------ supplier_products §22 */

export const supplierProducts = pgTable(
  'supplier_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references((): AnyPgColumn => suppliers.id, { onDelete: 'cascade' }),
    // Polymorphic target, mirroring inventory_levels: a supplier sells finished
    // variants, loose hamper items, or packaging. Exactly one is set (CHECK).
    variantId: uuid('variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'cascade',
    }),
    hamperItemId: uuid('hamper_item_id').references((): AnyPgColumn => hamperItems.id, {
      onDelete: 'cascade',
    }),
    packagingId: uuid('packaging_id').references((): AnyPgColumn => packagingMaterials.id, {
      onDelete: 'cascade',
    }),
    /** What the SUPPLIER calls it — what goes on the PO they receive. */
    supplierSku: text('supplier_sku'),
    unitCostPaise: bigint('unit_cost_paise', { mode: 'number' }).notNull().default(0),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    /** Minimum order quantity. The reorder engine rounds suggestions up to this. */
    moq: integer('moq').notNull().default(1),
    /** Feeds reorder point = avg daily consumption × lead time + safety stock. */
    leadTimeDays: integer('lead_time_days').notNull().default(0),
    isPreferred: boolean('is_preferred').notNull().default(false),
    lastPurchaseAt: timestamp('last_purchase_at', { withTimezone: true }),
    lastPurchaseCostPaise: bigint('last_purchase_cost_paise', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_supplier_products_variant')
      .on(t.supplierId, t.variantId)
      .where(sql`variant_id IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex('uq_supplier_products_hamper')
      .on(t.supplierId, t.hamperItemId)
      .where(sql`hamper_item_id IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex('uq_supplier_products_packaging')
      .on(t.supplierId, t.packagingId)
      .where(sql`packaging_id IS NOT NULL AND deleted_at IS NULL`),
    // At most ONE preferred supplier per variant. Without this the reorder
    // engine picks arbitrarily and the buyer cannot tell why.
    uniqueIndex('uq_supplier_products_preferred_variant')
      .on(t.variantId)
      .where(sql`is_preferred AND variant_id IS NOT NULL AND deleted_at IS NULL`),
    index('idx_supplier_products_supplier').on(t.supplierId),
    check(
      'supplier_products_one_target',
      sql`(variant_id IS NOT NULL)::int + (hamper_item_id IS NOT NULL)::int + (packaging_id IS NOT NULL)::int = 1`,
    ),
    check('supplier_products_cost_check', sql`unit_cost_paise >= 0`),
    check('supplier_products_moq_check', sql`moq >= 1`),
    check('supplier_products_lead_check', sql`lead_time_days >= 0`),
  ],
);

/* -------------------------------------------------------- purchase_returns §27 */

export const PURCHASE_RETURN_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'dispatched',
  'completed',
  'cancelled',
] as const;
export type PurchaseReturnStatus = (typeof PURCHASE_RETURN_STATUSES)[number];

export const PURCHASE_RETURN_REASONS = [
  'damaged',
  'wrong_item',
  'quality',
  'excess',
  'expired',
  'other',
] as const;
export type PurchaseReturnReason = (typeof PURCHASE_RETURN_REASONS)[number];

export const purchaseReturns = pgTable(
  'purchase_returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** From document_number_series: 'PRET-2026-00001'. */
    returnNo: text('return_no').notNull(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references((): AnyPgColumn => suppliers.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'restrict' }),
    /** The receipt this is returning against, when it is known. */
    goodsReceiptId: uuid('goods_receipt_id').references((): AnyPgColumn => goodsReceipts.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('draft').$type<PurchaseReturnStatus>(),
    reason: text('reason').notNull().$type<PurchaseReturnReason>(),
    subtotalPaise: bigint('subtotal_paise', { mode: 'number' }).notNull().default(0),
    taxPaise: bigint('tax_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull().default(0),
    note: text('note'),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references((): AnyPgColumn => staffUsers.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_purchase_returns_no').on(t.returnNo),
    index('idx_purchase_returns_supplier').on(t.supplierId, t.createdAt.desc()),
    index('idx_purchase_returns_status').on(t.status, t.createdAt.desc()),
    check(
      'purchase_returns_status_check',
      sql`status IN ('draft','pending_approval','approved','dispatched','completed','cancelled')`,
    ),
    check(
      'purchase_returns_reason_check',
      sql`reason IN ('damaged','wrong_item','quality','excess','expired','other')`,
    ),
  ],
);

export const purchaseReturnLines = pgTable(
  'purchase_return_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purchaseReturnId: uuid('purchase_return_id')
      .notNull()
      .references((): AnyPgColumn => purchaseReturns.id, { onDelete: 'cascade' }),
    inventoryLevelId: uuid('inventory_level_id')
      .notNull()
      .references((): AnyPgColumn => inventoryLevels.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    unitCostPaise: bigint('unit_cost_paise', { mode: 'number' }).notNull().default(0),
    lineTotalPaise: bigint('line_total_paise', { mode: 'number' }).notNull().default(0),
    note: text('note'),
  },
  (t) => [
    index('idx_purchase_return_lines_return').on(t.purchaseReturnId),
    check('purchase_return_lines_qty_check', sql`quantity > 0`),
  ],
);

/* ------------------------------------------------------- stock_counts §39-40 */

export const STOCK_COUNT_KINDS = ['full', 'cycle', 'spot'] as const;
export type StockCountKind = (typeof STOCK_COUNT_KINDS)[number];

export const STOCK_COUNT_STATUSES = [
  'draft',
  'in_progress',
  'completed',
  'approved',
  'cancelled',
] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

export const stockCounts = pgTable(
  'stock_counts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'CNT-2026-00001'. */
    countNo: text('count_no').notNull(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'restrict' }),
    /** Null = whole warehouse. Set = count one zone/rack/bin. */
    locationId: uuid('location_id').references((): AnyPgColumn => warehouseLocations.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull().default('cycle').$type<StockCountKind>(),
    status: text('status').notNull().default('draft').$type<StockCountStatus>(),
    scheduledFor: date('scheduled_for'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, { onDelete: 'set null' }),
    countedBy: uuid('counted_by').references((): AnyPgColumn => staffUsers.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references((): AnyPgColumn => staffUsers.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_stock_counts_no').on(t.countNo),
    index('idx_stock_counts_wh').on(t.warehouseId, t.status, t.createdAt.desc()),
    check('stock_counts_kind_check', sql`kind IN ('full','cycle','spot')`),
    check(
      'stock_counts_status_check',
      sql`status IN ('draft','in_progress','completed','approved','cancelled')`,
    ),
    check(
      'stock_counts_approved_by_required',
      sql`status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)`,
    ),
  ],
);

export const stockCountItems = pgTable(
  'stock_count_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stockCountId: uuid('stock_count_id')
      .notNull()
      .references((): AnyPgColumn => stockCounts.id, { onDelete: 'cascade' }),
    inventoryLevelId: uuid('inventory_level_id')
      .notNull()
      .references((): AnyPgColumn => inventoryLevels.id, { onDelete: 'restrict' }),
    /**
     * FROZEN when the item is first counted.
     *
     * The variance must be against what the system believed at the moment of
     * counting, not against a number that moved while the counter walked the
     * aisle. Re-reading on_hand at approval time would silently absorb every
     * sale that happened in between — the count would always look correct.
     */
    systemQty: integer('system_qty').notNull(),
    countedQty: integer('counted_qty'),
    /** SQL-only generated: COALESCE(counted_qty,0) - system_qty. */
    varianceQty: integer('variance_qty').generatedAlwaysAs(
      sql`COALESCE(counted_qty, 0) - system_qty`,
    ),
    /** Second count, when the first shows a variance worth re-checking. */
    recountQty: integer('recount_qty'),
    reason: text('reason'),
    countedAt: timestamp('counted_at', { withTimezone: true }),
    countedBy: uuid('counted_by').references((): AnyPgColumn => staffUsers.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('uq_stock_count_items').on(t.stockCountId, t.inventoryLevelId),
    index('idx_stock_count_items_variance')
      .on(t.stockCountId)
      .where(sql`counted_qty IS NOT NULL`),
    check('stock_count_items_counted_check', sql`counted_qty IS NULL OR counted_qty >= 0`),
    check('stock_count_items_recount_check', sql`recount_qty IS NULL OR recount_qty >= 0`),
  ],
);

/* ---------------------------------------------------------- production §46 */

export const PRODUCTION_STATUSES = [
  'draft',
  'planned',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number];

export const productionOrders = pgTable(
  'production_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'PRD-2026-00001'. */
    productionNo: text('production_no').notNull(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'restrict' }),
    // The output is a finished variant OR a hamper item. Exactly one (CHECK).
    outputVariantId: uuid('output_variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'restrict',
    }),
    outputHamperItemId: uuid('output_hamper_item_id').references((): AnyPgColumn => hamperItems.id, {
      onDelete: 'restrict',
    }),
    plannedQty: integer('planned_qty').notNull(),
    producedQty: integer('produced_qty').notNull().default(0),
    /** Started but unusable. Components were consumed; no finished stock resulted. */
    scrappedQty: integer('scrapped_qty').notNull().default(0),
    status: text('status').notNull().default('draft').$type<ProductionStatus>(),
    batchNo: text('batch_no'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_production_orders_no').on(t.productionNo),
    index('idx_production_orders_status').on(t.status, t.createdAt.desc()),
    index('idx_production_orders_wh').on(t.warehouseId, t.createdAt.desc()),
    check(
      'production_orders_one_output',
      sql`(output_variant_id IS NOT NULL)::int + (output_hamper_item_id IS NOT NULL)::int = 1`,
    ),
    check(
      'production_orders_status_check',
      sql`status IN ('draft','planned','in_progress','completed','cancelled')`,
    ),
    check('production_orders_planned_check', sql`planned_qty > 0`),
    check('production_orders_produced_check', sql`produced_qty >= 0 AND scrapped_qty >= 0`),
  ],
);

export const productionOrderLines = pgTable(
  'production_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productionOrderId: uuid('production_order_id')
      .notNull()
      .references((): AnyPgColumn => productionOrders.id, { onDelete: 'cascade' }),
    inventoryLevelId: uuid('inventory_level_id')
      .notNull()
      .references((): AnyPgColumn => inventoryLevels.id, { onDelete: 'restrict' }),
    /** From the BOM, including waste_pct. NUMERIC because 105g of wax is not an integer of anything. */
    plannedQty: numeric('planned_qty', { precision: 12, scale: 3 }).notNull(),
    /**
     * What was ACTUALLY taken.
     *
     * It will differ from planned whenever real waste differs from the BOM
     * estimate. That difference is the only honest signal for tuning waste_pct
     * later, which is why both numbers are kept rather than one being overwritten.
     */
    consumedQty: numeric('consumed_qty', { precision: 12, scale: 3 }).notNull().default('0'),
    unit: text('unit').notNull().default('piece').$type<Uom>(),
  },
  (t) => [
    uniqueIndex('uq_production_order_lines').on(t.productionOrderId, t.inventoryLevelId),
    check(
      'production_order_lines_unit_check',
      sql`unit IN ('piece','gram','kg','ml','litre','meter')`,
    ),
    check('production_order_lines_planned_check', sql`planned_qty > 0`),
    check('production_order_lines_consumed_check', sql`consumed_qty >= 0`),
  ],
);

/* ------------------------------------------------------------------ relations */

export const warehouseLocationsRelations = relations(warehouseLocations, ({ one, many }) => ({
  warehouse: one(warehouses, {
    fields: [warehouseLocations.warehouseId],
    references: [warehouses.id],
  }),
  parent: one(warehouseLocations, {
    fields: [warehouseLocations.parentId],
    references: [warehouseLocations.id],
    relationName: 'location_tree',
  }),
  children: many(warehouseLocations, { relationName: 'location_tree' }),
}));

export const supplierProductsRelations = relations(supplierProducts, ({ one }) => ({
  supplier: one(suppliers, {
    fields: [supplierProducts.supplierId],
    references: [suppliers.id],
  }),
  variant: one(productVariants, {
    fields: [supplierProducts.variantId],
    references: [productVariants.id],
  }),
}));

export const purchaseReturnsRelations = relations(purchaseReturns, ({ one, many }) => ({
  supplier: one(suppliers, {
    fields: [purchaseReturns.supplierId],
    references: [suppliers.id],
  }),
  warehouse: one(warehouses, {
    fields: [purchaseReturns.warehouseId],
    references: [warehouses.id],
  }),
  lines: many(purchaseReturnLines),
}));

export const purchaseReturnLinesRelations = relations(purchaseReturnLines, ({ one }) => ({
  purchaseReturn: one(purchaseReturns, {
    fields: [purchaseReturnLines.purchaseReturnId],
    references: [purchaseReturns.id],
  }),
  inventoryLevel: one(inventoryLevels, {
    fields: [purchaseReturnLines.inventoryLevelId],
    references: [inventoryLevels.id],
  }),
}));

export const stockCountsRelations = relations(stockCounts, ({ one, many }) => ({
  warehouse: one(warehouses, {
    fields: [stockCounts.warehouseId],
    references: [warehouses.id],
  }),
  location: one(warehouseLocations, {
    fields: [stockCounts.locationId],
    references: [warehouseLocations.id],
  }),
  items: many(stockCountItems),
}));

export const stockCountItemsRelations = relations(stockCountItems, ({ one }) => ({
  stockCount: one(stockCounts, {
    fields: [stockCountItems.stockCountId],
    references: [stockCounts.id],
  }),
  inventoryLevel: one(inventoryLevels, {
    fields: [stockCountItems.inventoryLevelId],
    references: [inventoryLevels.id],
  }),
}));

export const productionOrdersRelations = relations(productionOrders, ({ one, many }) => ({
  warehouse: one(warehouses, {
    fields: [productionOrders.warehouseId],
    references: [warehouses.id],
  }),
  outputVariant: one(productVariants, {
    fields: [productionOrders.outputVariantId],
    references: [productVariants.id],
  }),
  lines: many(productionOrderLines),
}));

export const productionOrderLinesRelations = relations(productionOrderLines, ({ one }) => ({
  productionOrder: one(productionOrders, {
    fields: [productionOrderLines.productionOrderId],
    references: [productionOrders.id],
  }),
  inventoryLevel: one(inventoryLevels, {
    fields: [productionOrderLines.inventoryLevelId],
    references: [inventoryLevels.id],
  }),
}));

/* -------------------------------------------------------------------- types */

export type WarehouseLocation = typeof warehouseLocations.$inferSelect;
export type NewWarehouseLocation = typeof warehouseLocations.$inferInsert;
export type SupplierProduct = typeof supplierProducts.$inferSelect;
export type NewSupplierProduct = typeof supplierProducts.$inferInsert;
export type PurchaseReturn = typeof purchaseReturns.$inferSelect;
export type NewPurchaseReturn = typeof purchaseReturns.$inferInsert;
export type PurchaseReturnLine = typeof purchaseReturnLines.$inferSelect;
export type NewPurchaseReturnLine = typeof purchaseReturnLines.$inferInsert;
export type StockCount = typeof stockCounts.$inferSelect;
export type NewStockCount = typeof stockCounts.$inferInsert;
export type StockCountItem = typeof stockCountItems.$inferSelect;
export type NewStockCountItem = typeof stockCountItems.$inferInsert;
export type ProductionOrder = typeof productionOrders.$inferSelect;
export type NewProductionOrder = typeof productionOrders.$inferInsert;
export type ProductionOrderLine = typeof productionOrderLines.$inferSelect;
export type NewProductionOrderLine = typeof productionOrderLines.$inferInsert;
