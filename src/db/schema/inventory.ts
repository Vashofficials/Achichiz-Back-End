/**
 * inventory.ts — §2.5
 *
 * Warehouses, the single source of truth for stock (`inventory_levels`),
 * reservations, the append-only movement ledger, and procurement
 * (suppliers → purchase orders → goods receipts) plus inter-warehouse transfers.
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN nonneg_paise / money_paise / percent_bp / pincode / gstin / pan_in
 *  - inventory_levels.available_qty is GENERATED ALWAYS AS
 *    (on_hand_qty - reserved_qty) STORED. Declared with .generatedAlwaysAs()
 *    below so it is typed on select; the SQL migration is authoritative.
 *  - CONSTRAINT inventory_no_oversell (reserved_qty <= on_hand_qty) is the §4.1
 *    backstop that makes an oversold row unrepresentable. The MECHANISM is the
 *    conditional UPDATE ... WHERE on_hand_qty - reserved_qty >= $n, which is
 *    race-free at READ COMMITTED. Never rely on catching the CHECK violation.
 *  - §7 correction 2 — PARTIAL unique indexes WHERE deleted_at IS NULL on
 *    warehouses.code, warehouses.name, suppliers.code, hamper_items.sku
 *    (declared in catalogue.ts) and packaging_materials.sku (delivery.ts).
 *  - Document numbers (po_no, grn_no, transfer_no) stay FULL unique — Tier 1.
 *  - TRIGGER trg_<table>_updated (set_updated_at)
 */

import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  boolean,
  integer,
  numeric,
  date,
  char,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { gstStates } from './tax.js';
import { staffUsers } from './identity.js';
import { productVariants, hamperItems } from './catalogue.js';
import { packagingMaterials } from './delivery.js';
import { carts, orders } from './orders.js';
import { corporateCampaigns } from './corporate.js';

/* ------------------------------------------------------------- warehouses */

export const WAREHOUSE_STATUSES = ['active', 'maintenance', 'closed'] as const;
export type WarehouseStatus = (typeof WAREHOUSE_STATUSES)[number];

export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'WH-MUM-AND'. Partial-unique (§7 correction 2). */
    code: text('code').notNull(),
    /** 'Mumbai Atelier (Andheri)'. Partial-unique. */
    name: text('name').notNull(),
    line1: text('line1').notNull(),
    city: text('city').notNull(),
    stateCode: char('state_code', { length: 2 })
      .notNull()
      .references((): AnyPgColumn => gstStates.code, { onDelete: 'restrict' }),
    /** DB type: DOMAIN pincode. */
    pincode: text('pincode').notNull(),
    /** GST registration is state-wise; one GSTIN per state of operation (Q3). */
    gstin: text('gstin'),
    managerId: uuid('manager_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    capacityUnits: integer('capacity_units'),
    supportsSameDay: boolean('supports_same_day').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    status: text('status').notNull().default('active').$type<WarehouseStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_warehouses_code').on(t.code).where(sql`deleted_at IS NULL`),
    uniqueIndex('uq_warehouses_name').on(t.name).where(sql`deleted_at IS NULL`),
    uniqueIndex('uq_one_default_warehouse')
      .on(t.isDefault)
      .where(sql`is_default AND deleted_at IS NULL`),
    index('idx_warehouses_state').on(t.stateCode).where(sql`deleted_at IS NULL`),
    check('warehouses_status_check', sql`status IN ('active','maintenance','closed')`),
    check(
      'warehouses_capacity_units_check',
      sql`capacity_units IS NULL OR capacity_units > 0`,
    ),
  ],
);

/* -------------------------------------------------------- inventory_levels */
/**
 * Replaces the admin's three conflicting stock sources (products.stock,
 * variants.stock, inventory.onHand). Stock is per stockable × warehouse.
 */
export const inventoryLevels = pgTable(
  'inventory_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variantId: uuid('variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'cascade',
    }),
    hamperItemId: uuid('hamper_item_id').references((): AnyPgColumn => hamperItems.id, {
      onDelete: 'cascade',
    }),
    packagingId: uuid('packaging_id').references(
      (): AnyPgColumn => packagingMaterials.id,
      { onDelete: 'cascade' },
    ),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'restrict' }),
    onHandQty: integer('on_hand_qty').notNull().default(0),
    reservedQty: integer('reserved_qty').notNull().default(0),
    /** SQL-only semantics: GENERATED ALWAYS AS (on_hand_qty - reserved_qty) STORED. */
    availableQty: integer('available_qty').generatedAlwaysAs(
      sql`on_hand_qty - reserved_qty`,
    ),
    incomingQty: integer('incoming_qty').notNull().default(0),
    reorderPoint: integer('reorder_point').notNull().default(0),
    reorderQty: integer('reorder_qty').notNull().default(0),
    binLocation: text('bin_location'),
    lastMovementAt: timestamp('last_movement_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_inventory_variant_wh')
      .on(t.variantId, t.warehouseId)
      .where(sql`variant_id IS NOT NULL`),
    uniqueIndex('uq_inventory_item_wh')
      .on(t.hamperItemId, t.warehouseId)
      .where(sql`hamper_item_id IS NOT NULL`),
    uniqueIndex('uq_inventory_packaging_wh')
      .on(t.packagingId, t.warehouseId)
      .where(sql`packaging_id IS NOT NULL`),
    index('idx_inventory_warehouse').on(t.warehouseId),
    index('idx_inventory_low')
      .on(t.warehouseId, t.availableQty)
      .where(sql`available_qty <= reorder_point`),
    check('inventory_levels_on_hand_qty_check', sql`on_hand_qty >= 0`),
    check('inventory_levels_reserved_qty_check', sql`reserved_qty >= 0`),
    check('inventory_levels_incoming_qty_check', sql`incoming_qty >= 0`),
    check('inventory_levels_reorder_point_check', sql`reorder_point >= 0`),
    check('inventory_levels_reorder_qty_check', sql`reorder_qty >= 0`),
    // §4.1 layer 1: the oversell guard, in the database.
    check('inventory_no_oversell', sql`reserved_qty <= on_hand_qty`),
    check(
      'inventory_exactly_one_stockable',
      sql`(variant_id IS NOT NULL)::int + (hamper_item_id IS NOT NULL)::int + (packaging_id IS NOT NULL)::int = 1`,
    ),
  ],
);

/* -------------------------------------------------- inventory_reservations */
/** §4.1 layer 3 — reservations are rows with an expiry, not a bare counter. */

export const RESERVATION_REASONS = ['cart', 'order', 'manual_hold', 'quotation'] as const;
export type ReservationReason = (typeof RESERVATION_REASONS)[number];

export const inventoryReservations = pgTable(
  'inventory_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inventoryLevelId: uuid('inventory_level_id')
      .notNull()
      .references((): AnyPgColumn => inventoryLevels.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull(),
    cartId: uuid('cart_id').references((): AnyPgColumn => carts.id, {
      onDelete: 'cascade',
    }),
    orderId: uuid('order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'cascade',
    }),
    /**
     * Added by 0004. A corporate bulk hold: set for campaign reservations, NULL
     * for carts, orders and manual holds. It is what makes a bulk hold
     * releasable — without it the only reason an admin hold could carry was
     * `manual_hold`, which back-references nothing.
     */
    campaignId: uuid('campaign_id').references((): AnyPgColumn => corporateCampaigns.id, {
      onDelete: 'cascade',
    }),
    reason: text('reason').notNull().default('cart').$type<ReservationReason>(),
    /** NULL for order-backed reservations, and for campaign holds (0004 CHECK). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_reservations_expiry')
      .on(t.expiresAt)
      .where(sql`released_at IS NULL AND expires_at IS NOT NULL`),
    index('idx_reservations_level')
      .on(t.inventoryLevelId)
      .where(sql`released_at IS NULL`),
    index('idx_reservations_order').on(t.orderId).where(sql`order_id IS NOT NULL`),
    index('idx_reservations_campaign')
      .on(t.campaignId)
      .where(sql`campaign_id IS NOT NULL AND released_at IS NULL`),
    check('inventory_reservations_quantity_check', sql`quantity > 0`),
    check(
      'inventory_reservations_reason_check',
      sql`reason IN ('cart','order','manual_hold','quotation')`,
    ),
    // Widened by 0004. Before it, `reason = 'quotation'` satisfied the reason
    // CHECK and violated this one for every possible row — an enum value no row
    // could ever hold.
    check(
      'reservation_has_owner',
      sql`cart_id IS NOT NULL OR order_id IS NOT NULL OR campaign_id IS NOT NULL OR reason = 'manual_hold'`,
    ),
    // A campaign hold mislabelled `cart` would be swept by the cart-expiry job,
    // silently releasing stock a corporate customer has been quoted on.
    check('reservation_campaign_reason', sql`campaign_id IS NULL OR reason IN ('quotation','manual_hold')`),
    // A bulk hold is released explicitly or by fulfilment, never by a timer.
    check('reservation_campaign_no_expiry', sql`campaign_id IS NULL OR expires_at IS NULL`),
    check(
      'reservation_cart_expires',
      sql`reason <> 'cart' OR expires_at IS NOT NULL`,
    ),
  ],
);

/* --------------------------------------------------------- stock_movements */
/**
 * Append-only ledger (Tier 1). Every change to on_hand_qty writes exactly one
 * row. BIGINT identity, not UUID: monotonic keys cluster and halve index size.
 * A nightly job asserts SUM(quantity_delta) = inventory_levels.on_hand_qty.
 */

/**
 * These two lists MUST match the CHECK constraints on `stock_movements`.
 *
 * The SQL migration is authoritative — widening the constraint there does not
 * widen the type here, and the drift is silent in the wrong direction: the
 * database happily accepts a value TypeScript refuses to construct, so a whole
 * movement kind quietly becomes unreachable from the application.
 *
 * The last five movement types and last three reference types were added by
 * migration 0003_inventory.sql. Anything added later must be added in both places.
 */
export const STOCK_MOVEMENT_TYPES = [
  'inbound',
  'outbound',
  'adjustment',
  'transfer_out',
  'transfer_in',
  'damage',
  'return_in',
  // 0003 — production, counts, and unexplained loss/gain
  'production',
  'raw_material_consumption',
  'stock_count',
  'loss',
  'found',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const STOCK_REFERENCE_TYPES = [
  'purchase_order',
  'goods_receipt',
  'order',
  'stock_transfer',
  'return',
  'adjustment',
  'import',
  // 0003
  'production_order',
  'stock_count',
  'purchase_return',
] as const;
export type StockReferenceType = (typeof STOCK_REFERENCE_TYPES)[number];

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    inventoryLevelId: uuid('inventory_level_id')
      .notNull()
      .references((): AnyPgColumn => inventoryLevels.id, { onDelete: 'restrict' }),
    movementType: text('movement_type').notNull().$type<StockMovementType>(),
    quantityDelta: integer('quantity_delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    referenceType: text('reference_type').$type<StockReferenceType>(),
    referenceId: uuid('reference_id'),
    /** 'PO-2026-02291' / 'ACH104422' for display. */
    referenceLabel: text('reference_label'),
    note: text('note'),
    actorId: uuid('actor_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_stock_movements_level').on(t.inventoryLevelId, t.occurredAt.desc()),
    index('idx_stock_movements_ref').on(t.referenceType, t.referenceId),
    index('idx_stock_movements_time').on(t.occurredAt.desc()),
    check(
      'stock_movements_movement_type_check',
      sql`movement_type IN ('inbound','outbound','adjustment','transfer_out','transfer_in','damage','return_in')`,
    ),
    check(
      'stock_movements_reference_type_check',
      sql`reference_type IN ('purchase_order','goods_receipt','order','stock_transfer','return','adjustment','import')`,
    ),
    check('stock_movements_quantity_delta_check', sql`quantity_delta <> 0`),
    check('stock_movements_balance_after_check', sql`balance_after >= 0`),
  ],
);

/* -------------------------------------------------------------- suppliers */

export const SUPPLIER_STATUSES = ['active', 'on_hold', 'archived'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Partial-unique. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    /** DB type: CITEXT. */
    email: text('email'),
    mobile: text('mobile'),
    line1: text('line1'),
    city: text('city'),
    stateCode: char('state_code', { length: 2 }).references(
      (): AnyPgColumn => gstStates.code,
      { onDelete: 'restrict' },
    ),
    pincode: text('pincode'),
    gstin: text('gstin'),
    pan: text('pan'),
    /** Gourmet | Packaging | Decor | Fragrance | Logistics */
    category: text('category'),
    leadTimeDays: integer('lead_time_days'),
    paymentTerms: text('payment_terms'),
    rating: numeric('rating', { precision: 2, scale: 1 }),
    /** DB type: DOMAIN money_paise — may be negative. */
    outstandingPaise: bigint('outstanding_paise', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('active').$type<SupplierStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_suppliers_code').on(t.code).where(sql`deleted_at IS NULL`),
    index('idx_suppliers_status').on(t.status).where(sql`deleted_at IS NULL`),
    index('idx_suppliers_search').using(
      'gin',
      sql`(name || ' ' || coalesce(contact_name,'') || ' ' || coalesce(city,'') || ' ' || coalesce(gstin,'')) gin_trgm_ops`,
    ),
    check('suppliers_status_check', sql`status IN ('active','on_hold','archived')`),
    check(
      'suppliers_lead_time_days_check',
      sql`lead_time_days IS NULL OR lead_time_days >= 0`,
    ),
    check('suppliers_rating_check', sql`rating IS NULL OR rating BETWEEN 1.0 AND 5.0`),
  ],
);

/* -------------------------------------------------------- purchase_orders */

export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'sent',
  'partially_received',
  'received',
  'cancelled',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'PO-2026-02291'. Document number: FULL unique (§3.5). */
    poNo: text('po_no').notNull().unique(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references((): AnyPgColumn => suppliers.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('draft').$type<PurchaseOrderStatus>(),
    /** DB type: DOMAIN currency_code. Always 'INR' (assumption A6). */
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    subtotalPaise: bigint('subtotal_paise', { mode: 'number' }).notNull().default(0),
    taxPaise: bigint('tax_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull().default(0),
    expectedOn: date('expected_on'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    notes: text('notes'),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_po_supplier').on(t.supplierId, t.createdAt.desc()),
    index('idx_po_status').on(t.status, t.expectedOn),
    index('idx_po_warehouse').on(t.warehouseId),
    check(
      'purchase_orders_status_check',
      sql`status IN ('draft','sent','partially_received','received','cancelled')`,
    ),
  ],
);

/** Absolute quantities only — the admin mock stored `received` as a percentage. */
export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references((): AnyPgColumn => purchaseOrders.id, { onDelete: 'cascade' }),
    hamperItemId: uuid('hamper_item_id').references((): AnyPgColumn => hamperItems.id, {
      onDelete: 'restrict',
    }),
    variantId: uuid('variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'restrict',
    }),
    packagingId: uuid('packaging_id').references(
      (): AnyPgColumn => packagingMaterials.id,
      { onDelete: 'restrict' },
    ),
    description: text('description').notNull(),
    orderedQty: integer('ordered_qty').notNull(),
    receivedQty: integer('received_qty').notNull().default(0),
    unitCostPaise: bigint('unit_cost_paise', { mode: 'number' }).notNull(),
    gstRateBp: integer('gst_rate_bp').notNull().default(0),
    lineTotalPaise: bigint('line_total_paise', { mode: 'number' }).notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('idx_po_lines_po').on(t.purchaseOrderId, t.position),
    check('purchase_order_lines_ordered_qty_check', sql`ordered_qty > 0`),
    check('purchase_order_lines_received_qty_check', sql`received_qty >= 0`),
    check(
      'po_line_exactly_one_item',
      sql`(hamper_item_id IS NOT NULL)::int + (variant_id IS NOT NULL)::int + (packaging_id IS NOT NULL)::int = 1`,
    ),
    check('po_line_no_over_receipt', sql`received_qty <= ordered_qty`),
  ],
);

/* --------------------------------------------------------- goods_receipts */

export const GRN_QC_STATUSES = ['passed', 'partial', 'failed'] as const;
export type GrnQcStatus = (typeof GRN_QC_STATUSES)[number];

export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'GRN-2026-00912'. Document number: FULL unique. */
    grnNo: text('grn_no').notNull().unique(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references((): AnyPgColumn => purchaseOrders.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'restrict' }),
    receivedOn: date('received_on').notNull().default(sql`CURRENT_DATE`),
    qcStatus: text('qc_status').notNull().default('passed').$type<GrnQcStatus>(),
    inspectorId: uuid('inspector_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    supplierInvoiceNo: text('supplier_invoice_no'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_grn_po').on(t.purchaseOrderId),
    check('goods_receipts_qc_status_check', sql`qc_status IN ('passed','partial','failed')`),
  ],
);

export const GRN_LINE_CONDITIONS = [
  'sellable',
  'damaged',
  'opened',
  'missing_parts',
] as const;

export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    goodsReceiptId: uuid('goods_receipt_id')
      .notNull()
      .references((): AnyPgColumn => goodsReceipts.id, { onDelete: 'cascade' }),
    poLineId: uuid('po_line_id')
      .notNull()
      .references((): AnyPgColumn => purchaseOrderLines.id, { onDelete: 'restrict' }),
    acceptedQty: integer('accepted_qty').notNull().default(0),
    rejectedQty: integer('rejected_qty').notNull().default(0),
    rejectionReason: text('rejection_reason'),
    batchNo: text('batch_no'),
    /** Perishables. */
    expiryOn: date('expiry_on'),
  },
  (t) => [
    index('idx_grn_lines_grn').on(t.goodsReceiptId),
    index('idx_grn_lines_expiry').on(t.expiryOn).where(sql`expiry_on IS NOT NULL`),
    check('goods_receipt_lines_accepted_qty_check', sql`accepted_qty >= 0`),
    check('goods_receipt_lines_rejected_qty_check', sql`rejected_qty >= 0`),
    check('grn_line_some_qty', sql`accepted_qty + rejected_qty > 0`),
    check(
      'grn_rejection_needs_reason',
      sql`rejected_qty = 0 OR rejection_reason IS NOT NULL`,
    ),
  ],
);

/* -------------------------------------------------------- stock_transfers */

export const STOCK_TRANSFER_STATUSES = [
  'requested',
  'approved',
  'in_transit',
  'received',
  'cancelled',
] as const;
export type StockTransferStatus = (typeof STOCK_TRANSFER_STATUSES)[number];

export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'TRF-2026-00061'. Document number: FULL unique. */
    transferNo: text('transfer_no').notNull().unique(),
    fromWarehouseId: uuid('from_warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'restrict' }),
    toWarehouseId: uuid('to_warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('requested').$type<StockTransferStatus>(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    etaOn: date('eta_on'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    requestedBy: uuid('requested_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_transfers_status').on(t.status, t.etaOn),
    check(
      'stock_transfers_status_check',
      sql`status IN ('requested','approved','in_transit','received','cancelled')`,
    ),
    check('transfer_distinct_warehouses', sql`from_warehouse_id <> to_warehouse_id`),
  ],
);

export const stockTransferLines = pgTable(
  'stock_transfer_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transferId: uuid('transfer_id')
      .notNull()
      .references((): AnyPgColumn => stockTransfers.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'restrict',
    }),
    hamperItemId: uuid('hamper_item_id').references((): AnyPgColumn => hamperItems.id, {
      onDelete: 'restrict',
    }),
    sentQty: integer('sent_qty').notNull(),
    receivedQty: integer('received_qty').notNull().default(0),
  },
  (t) => [
    index('idx_transfer_lines_transfer').on(t.transferId),
    check('stock_transfer_lines_sent_qty_check', sql`sent_qty > 0`),
    check('stock_transfer_lines_received_qty_check', sql`received_qty >= 0`),
    check(
      'transfer_line_exactly_one',
      sql`(variant_id IS NOT NULL)::int + (hamper_item_id IS NOT NULL)::int = 1`,
    ),
    check('transfer_line_no_over_receipt', sql`received_qty <= sent_qty`),
  ],
);

/* -------------------------------------------------------------- relations */

export const warehousesRelations = relations(warehouses, ({ one, many }) => ({
  state: one(gstStates, {
    fields: [warehouses.stateCode],
    references: [gstStates.code],
  }),
  manager: one(staffUsers, {
    fields: [warehouses.managerId],
    references: [staffUsers.id],
  }),
  inventoryLevels: many(inventoryLevels),
  purchaseOrders: many(purchaseOrders),
}));

export const inventoryLevelsRelations = relations(inventoryLevels, ({ one, many }) => ({
  warehouse: one(warehouses, {
    fields: [inventoryLevels.warehouseId],
    references: [warehouses.id],
  }),
  variant: one(productVariants, {
    fields: [inventoryLevels.variantId],
    references: [productVariants.id],
  }),
  hamperItem: one(hamperItems, {
    fields: [inventoryLevels.hamperItemId],
    references: [hamperItems.id],
  }),
  reservations: many(inventoryReservations),
  movements: many(stockMovements),
}));

export const inventoryReservationsRelations = relations(
  inventoryReservations,
  ({ one }) => ({
    level: one(inventoryLevels, {
      fields: [inventoryReservations.inventoryLevelId],
      references: [inventoryLevels.id],
    }),
  }),
);

export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({
  level: one(inventoryLevels, {
    fields: [stockMovements.inventoryLevelId],
    references: [inventoryLevels.id],
  }),
}));

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  purchaseOrders: many(purchaseOrders),
  hamperItems: many(hamperItems),
}));

export const purchaseOrdersRelations = relations(purchaseOrders, ({ one, many }) => ({
  supplier: one(suppliers, {
    fields: [purchaseOrders.supplierId],
    references: [suppliers.id],
  }),
  warehouse: one(warehouses, {
    fields: [purchaseOrders.warehouseId],
    references: [warehouses.id],
  }),
  lines: many(purchaseOrderLines),
  receipts: many(goodsReceipts),
}));

export const purchaseOrderLinesRelations = relations(purchaseOrderLines, ({ one }) => ({
  purchaseOrder: one(purchaseOrders, {
    fields: [purchaseOrderLines.purchaseOrderId],
    references: [purchaseOrders.id],
  }),
}));

export const goodsReceiptsRelations = relations(goodsReceipts, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrders, {
    fields: [goodsReceipts.purchaseOrderId],
    references: [purchaseOrders.id],
  }),
  lines: many(goodsReceiptLines),
}));

export const goodsReceiptLinesRelations = relations(goodsReceiptLines, ({ one }) => ({
  goodsReceipt: one(goodsReceipts, {
    fields: [goodsReceiptLines.goodsReceiptId],
    references: [goodsReceipts.id],
  }),
  poLine: one(purchaseOrderLines, {
    fields: [goodsReceiptLines.poLineId],
    references: [purchaseOrderLines.id],
  }),
}));

export const stockTransfersRelations = relations(stockTransfers, ({ many }) => ({
  lines: many(stockTransferLines),
}));

export const stockTransferLinesRelations = relations(stockTransferLines, ({ one }) => ({
  transfer: one(stockTransfers, {
    fields: [stockTransferLines.transferId],
    references: [stockTransfers.id],
  }),
}));

/* ------------------------------------------------------------------ types */

export type Warehouse = typeof warehouses.$inferSelect;
export type NewWarehouse = typeof warehouses.$inferInsert;
export type InventoryLevel = typeof inventoryLevels.$inferSelect;
export type NewInventoryLevel = typeof inventoryLevels.$inferInsert;
export type InventoryReservation = typeof inventoryReservations.$inferSelect;
export type NewInventoryReservation = typeof inventoryReservations.$inferInsert;
export type StockMovement = typeof stockMovements.$inferSelect;
export type NewStockMovement = typeof stockMovements.$inferInsert;
export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type NewPurchaseOrder = typeof purchaseOrders.$inferInsert;
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;
export type NewPurchaseOrderLine = typeof purchaseOrderLines.$inferInsert;
export type GoodsReceipt = typeof goodsReceipts.$inferSelect;
export type NewGoodsReceipt = typeof goodsReceipts.$inferInsert;
export type GoodsReceiptLine = typeof goodsReceiptLines.$inferSelect;
export type NewGoodsReceiptLine = typeof goodsReceiptLines.$inferInsert;
export type StockTransfer = typeof stockTransfers.$inferSelect;
export type NewStockTransfer = typeof stockTransfers.$inferInsert;
export type StockTransferLine = typeof stockTransferLines.$inferSelect;
export type NewStockTransferLine = typeof stockTransferLines.$inferInsert;
