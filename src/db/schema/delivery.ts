/**
 * delivery.ts — §2.9
 *
 * Serviceability (zones → real pincodes, not a count), couriers and their daily
 * performance rollup, the shipping-rule engine, shipments (orders don't ship —
 * shipments ship), courier tracking events, delivery exceptions and packaging
 * materials.
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN nonneg_paise / percent_bp / pincode
 *  - delivery_zone_pincodes.pincode is the PRIMARY KEY and is of DOMAIN
 *    `pincode`; Drizzle sees a plain text PK.
 *  - §7 correction 2 — packaging_materials.sku uses a PARTIAL unique index.
 *    Zone/courier codes have no deleted_at, so they stay FULL unique.
 *  - uq_shipping_rule_priority is a PARTIAL unique index (WHERE status =
 *    'active'): two inactive rules may share a priority, two active ones may not.
 *  - `onTime` / `ndrRate` / `rtoRate` / `ageHrs` / packaging stock are all
 *    derived and deliberately not columns. Packaging stock lives in
 *    inventory_levels.packaging_id.
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
  smallint,
  date,
  time,
  char,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { gstStates } from './tax.js';
import { staffUsers } from './identity.js';
import { orders, orderLines } from './orders.js';
import { mediaAssets } from './content.js';
import { warehouses, suppliers } from './inventory.js';
import { integrations } from './platform.js';

/* --------------------------------------------------------- delivery_zones */

export const ZONE_TIERS = [
  'metro',
  'tier_1',
  'tier_2',
  'tier_3',
  'remote',
  'international',
] as const;
export type ZoneTier = (typeof ZONE_TIERS)[number];

export const ZONE_STATUSES = ['active', 'paused'] as const;
export type ZoneStatus = (typeof ZONE_STATUSES)[number];

export const deliveryZones = pgTable(
  'delivery_zones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    /** 'Mumbai Metro' */
    name: text('name').notNull(),
    city: text('city'),
    stateCode: char('state_code', { length: 2 }).references(
      (): AnyPgColumn => gstStates.code,
      { onDelete: 'restrict' },
    ),
    tier: text('tier').$type<ZoneTier>(),
    supportsSameDay: boolean('supports_same_day').notNull().default(false),
    supportsMidnight: boolean('supports_midnight').notNull().default(false),
    supportsCod: boolean('supports_cod').notNull().default(true),
    baseFeePaise: bigint('base_fee_paise', { mode: 'number' }).notNull().default(0),
    /** '15:00' */
    sameDayCutoff: time('same_day_cutoff'),
    standardTatDays: smallint('standard_tat_days'),
    status: text('status').notNull().default('active').$type<ZoneStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_zones_status').on(t.status, t.stateCode),
    check(
      'delivery_zones_tier_check',
      sql`tier IN ('metro','tier_1','tier_2','tier_3','remote','international')`,
    ),
    check('delivery_zones_status_check', sql`status IN ('active','paused')`),
  ],
);

/** The mock stored `pincodes: 240` as a COUNT. Serviceability needs the rows. */
export const deliveryZonePincodes = pgTable(
  'delivery_zone_pincodes',
  {
    /** DB type: DOMAIN pincode. Natural primary key — O(1) checkout lookup. */
    pincode: text('pincode').primaryKey(),
    zoneId: uuid('zone_id')
      .notNull()
      .references((): AnyPgColumn => deliveryZones.id, { onDelete: 'cascade' }),
    city: text('city'),
    stateCode: char('state_code', { length: 2 }).references(
      (): AnyPgColumn => gstStates.code,
      { onDelete: 'restrict' },
    ),
    isServiceable: boolean('is_serviceable').notNull().default(true),
    codAllowed: boolean('cod_allowed').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_zone_pincodes_zone').on(t.zoneId)],
);

/* --------------------------------------------------------------- couriers */

export const COURIER_STATUSES = ['connected', 'disconnected', 'error'] as const;
export type CourierStatus = (typeof COURIER_STATUSES)[number];

export const couriers = pgTable(
  'couriers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'bluedart' */
    code: text('code').notNull().unique(),
    name: text('name').notNull().unique(),
    /** {'express','surface','same_day'} */
    services: text('services').array().notNull().default(sql`'{}'::text[]`),
    supportsCod: boolean('supports_cod').notNull().default(true),
    supportsInternational: boolean('supports_international').notNull().default(false),
    /** 'https://.../track?awb={awb}' */
    trackingUrlTemplate: text('tracking_url_template'),
    apiIntegrationId: uuid('api_integration_id').references(
      (): AnyPgColumn => integrations.id,
      { onDelete: 'set null' },
    ),
    baseCostPaise: bigint('base_cost_paise', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('disconnected').$type<CourierStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('couriers_status_check', sql`status IN ('connected','disconnected','error')`),
  ],
);

/** onTime / ndrRate / rtoRate are computed from this, not stored on `couriers`. */
export const courierPerformanceDaily = pgTable(
  'courier_performance_daily',
  {
    courierId: uuid('courier_id')
      .notNull()
      .references((): AnyPgColumn => couriers.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    shipments: integer('shipments').notNull().default(0),
    onTime: integer('on_time').notNull().default(0),
    ndrCount: integer('ndr_count').notNull().default(0),
    rtoCount: integer('rto_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.courierId, t.day] })],
);

/* --------------------------------------------------------- shipping_rules */

export const SHIPPING_CHARGE_KINDS = [
  'free',
  'flat',
  'percent',
  'per_kg',
  'table',
] as const;
export type ShippingChargeKind = (typeof SHIPPING_CHARGE_KINDS)[number];

export const SHIPPING_RULE_STATUSES = ['active', 'inactive'] as const;
export type ShippingRuleStatus = (typeof SHIPPING_RULE_STATUSES)[number];

/** The storefront's hardcoded FREE_SHIPPING_THRESHOLD / SHIPPING_FEE become rows here. */
export const shippingRules = pgTable(
  'shipping_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Lower wins; evaluated in order. Unique among ACTIVE rules only. */
    priority: integer('priority').notNull(),
    /** Executable rule DSL (§1.4). */
    conditions: jsonb('conditions').notNull(),
    /** 'order_total >= 2999' — display only. */
    conditionText: text('condition_text'),
    chargeKind: text('charge_kind').notNull().$type<ShippingChargeKind>(),
    chargePaise: bigint('charge_paise', { mode: 'number' }).notNull().default(0),
    chargeBp: integer('charge_bp'),
    preferredCourierId: uuid('preferred_courier_id').references(
      (): AnyPgColumn => couriers.id,
      { onDelete: 'set null' },
    ),
    stopsEvaluation: boolean('stops_evaluation').notNull().default(true),
    status: text('status').notNull().default('active').$type<ShippingRuleStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_shipping_rule_priority').on(t.priority).where(sql`status = 'active'`),
    check(
      'shipping_rules_charge_kind_check',
      sql`charge_kind IN ('free','flat','percent','per_kg','table')`,
    ),
    check('shipping_rules_status_check', sql`status IN ('active','inactive')`),
  ],
);

/* -------------------------------------------------------------- shipments */

export const SHIPMENT_STATUSES = [
  'label_created',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'rto_initiated',
  'rto_delivered',
  'cancelled',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentNo: text('shipment_no').notNull().unique(),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references((): AnyPgColumn => warehouses.id, { onDelete: 'restrict' }),
    courierId: uuid('courier_id').references((): AnyPgColumn => couriers.id, {
      onDelete: 'set null',
    }),
    /** A multi-warehouse gift order has several AWBs; order-level awb is dropped. */
    awb: text('awb'),
    labelMediaId: uuid('label_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    packagingId: uuid('packaging_id').references(
      (): AnyPgColumn => packagingMaterials.id,
      { onDelete: 'set null' },
    ),
    weightGrams: integer('weight_grams'),
    declaredValuePaise: bigint('declared_value_paise', { mode: 'number' }),
    shippingCostPaise: bigint('shipping_cost_paise', { mode: 'number' })
      .notNull()
      .default(0),
    isCod: boolean('is_cod').notNull().default(false),
    codAmountPaise: bigint('cod_amount_paise', { mode: 'number' }).notNull().default(0),
    codRemittedAt: timestamp('cod_remitted_at', { withTimezone: true }),
    status: text('status').notNull().default('label_created').$type<ShipmentStatus>(),
    attempts: smallint('attempts').notNull().default(0),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    etaOn: date('eta_on'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveredTo: text('delivered_to'),
    podMediaId: uuid('pod_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_shipments_awb').on(t.courierId, t.awb).where(sql`awb IS NOT NULL`),
    index('idx_shipments_order').on(t.orderId),
    index('idx_shipments_status').on(t.status, t.dispatchedAt.desc()),
    index('idx_shipments_awb').on(t.awb).where(sql`awb IS NOT NULL`),
    index('idx_shipments_eta')
      .on(t.etaOn)
      .where(sql`status NOT IN ('delivered','cancelled','rto_delivered')`),
    check(
      'shipments_status_check',
      sql`status IN ('label_created','picked_up','in_transit','out_for_delivery','delivered','exception','rto_initiated','rto_delivered','cancelled')`,
    ),
    check('shipments_attempts_check', sql`attempts >= 0`),
    check(
      'shipments_weight_grams_check',
      sql`weight_grams IS NULL OR weight_grams > 0`,
    ),
    check('shipment_cod_amount', sql`is_cod OR cod_amount_paise = 0`),
    check(
      'shipment_delivered_has_time',
      sql`status <> 'delivered' OR delivered_at IS NOT NULL`,
    ),
  ],
);

/** Which order lines are in which box. */
export const shipmentLines = pgTable(
  'shipment_lines',
  {
    shipmentId: uuid('shipment_id')
      .notNull()
      .references((): AnyPgColumn => shipments.id, { onDelete: 'cascade' }),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references((): AnyPgColumn => orderLines.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shipmentId, t.orderLineId] }),
    check('shipment_lines_quantity_check', sql`quantity > 0`),
  ],
);

export const shipmentEvents = pgTable(
  'shipment_events',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references((): AnyPgColumn => shipments.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Free text: the courier's own vocabulary, not our ShipmentStatus set. */
    status: text('status').notNull(),
    location: text('location'),
    description: text('description'),
    courierCode: text('courier_code'),
    rawPayload: jsonb('raw_payload'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_shipment_events').on(t.shipmentId, t.occurredAt.desc())],
);

/* ---------------------------------------------------- delivery_exceptions */

export const EXCEPTION_KINDS = [
  'ndr',
  'rto',
  'delay',
  'damage',
  'address_issue',
  'lost',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_STATUSES = [
  'open',
  'customer_contacted',
  'reattempt_scheduled',
  'resolved',
  'written_off',
] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const deliveryExceptions = pgTable(
  'delivery_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    exceptionNo: text('exception_no').notNull().unique(),
    shipmentId: uuid('shipment_id').references((): AnyPgColumn => shipments.id, {
      onDelete: 'cascade',
    }),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull().$type<ExceptionKind>(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('open').$type<ExceptionStatus>(),
    ownerId: uuid('owner_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    reattemptOn: date('reattempt_on'),
    /** `ageHrs` is derived: now() - raised_at. Not stored. */
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_exceptions_open')
      .on(t.raisedAt)
      .where(sql`status NOT IN ('resolved','written_off')`),
    index('idx_exceptions_order').on(t.orderId),
    index('idx_exceptions_owner').on(t.ownerId, t.status),
    check(
      'delivery_exceptions_kind_check',
      sql`kind IN ('ndr','rto','delay','damage','address_issue','lost')`,
    ),
    check(
      'delivery_exceptions_status_check',
      sql`status IN ('open','customer_contacted','reattempt_scheduled','resolved','written_off')`,
    ),
  ],
);

/* ---------------------------------------------------- packaging_materials */

export const PACKAGING_KINDS = [
  'box',
  'trunk',
  'potli',
  'wrap',
  'card',
  'filler',
  'tape',
] as const;
export type PackagingKind = (typeof PACKAGING_KINDS)[number];

export const PACKAGING_STATUSES = ['active', 'discontinued'] as const;
export type PackagingStatus = (typeof PACKAGING_STATUSES)[number];

/**
 * `status` is lifecycle only. The mock's `stock < 200 ? 'Low stock' : 'Active'`
 * conflated stock with lifecycle; stock lives in inventory_levels.packaging_id.
 */
export const packagingMaterials = pgTable(
  'packaging_materials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Partial-unique (§7 correction 2). */
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull().$type<PackagingKind>(),
    lengthMm: integer('length_mm'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    maxWeightGrams: integer('max_weight_grams'),
    costPaise: bigint('cost_paise', { mode: 'number' }).notNull().default(0),
    supportsGiftNote: boolean('supports_gift_note').notNull().default(false),
    supplierId: uuid('supplier_id').references((): AnyPgColumn => suppliers.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('active').$type<PackagingStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_packaging_sku').on(t.sku).where(sql`deleted_at IS NULL`),
    check(
      'packaging_materials_kind_check',
      sql`kind IN ('box','trunk','potli','wrap','card','filler','tape')`,
    ),
    check('packaging_materials_status_check', sql`status IN ('active','discontinued')`),
  ],
);

/* -------------------------------------------------------------- relations */

export const deliveryZonesRelations = relations(deliveryZones, ({ many }) => ({
  pincodes: many(deliveryZonePincodes),
}));

export const deliveryZonePincodesRelations = relations(
  deliveryZonePincodes,
  ({ one }) => ({
    zone: one(deliveryZones, {
      fields: [deliveryZonePincodes.zoneId],
      references: [deliveryZones.id],
    }),
  }),
);

export const couriersRelations = relations(couriers, ({ many }) => ({
  shipments: many(shipments),
  performance: many(courierPerformanceDaily),
  preferredByRules: many(shippingRules),
}));

export const courierPerformanceDailyRelations = relations(
  courierPerformanceDaily,
  ({ one }) => ({
    courier: one(couriers, {
      fields: [courierPerformanceDaily.courierId],
      references: [couriers.id],
    }),
  }),
);

export const shippingRulesRelations = relations(shippingRules, ({ one }) => ({
  preferredCourier: one(couriers, {
    fields: [shippingRules.preferredCourierId],
    references: [couriers.id],
  }),
}));

export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  order: one(orders, { fields: [shipments.orderId], references: [orders.id] }),
  warehouse: one(warehouses, {
    fields: [shipments.warehouseId],
    references: [warehouses.id],
  }),
  courier: one(couriers, { fields: [shipments.courierId], references: [couriers.id] }),
  packaging: one(packagingMaterials, {
    fields: [shipments.packagingId],
    references: [packagingMaterials.id],
  }),
  lines: many(shipmentLines),
  events: many(shipmentEvents),
  exceptions: many(deliveryExceptions),
}));

export const shipmentLinesRelations = relations(shipmentLines, ({ one }) => ({
  shipment: one(shipments, {
    fields: [shipmentLines.shipmentId],
    references: [shipments.id],
  }),
  orderLine: one(orderLines, {
    fields: [shipmentLines.orderLineId],
    references: [orderLines.id],
  }),
}));

export const shipmentEventsRelations = relations(shipmentEvents, ({ one }) => ({
  shipment: one(shipments, {
    fields: [shipmentEvents.shipmentId],
    references: [shipments.id],
  }),
}));

export const deliveryExceptionsRelations = relations(deliveryExceptions, ({ one }) => ({
  shipment: one(shipments, {
    fields: [deliveryExceptions.shipmentId],
    references: [shipments.id],
  }),
  order: one(orders, { fields: [deliveryExceptions.orderId], references: [orders.id] }),
  owner: one(staffUsers, {
    fields: [deliveryExceptions.ownerId],
    references: [staffUsers.id],
  }),
}));

export const packagingMaterialsRelations = relations(packagingMaterials, ({ one }) => ({
  supplier: one(suppliers, {
    fields: [packagingMaterials.supplierId],
    references: [suppliers.id],
  }),
}));

/* ------------------------------------------------------------------ types */

export type DeliveryZone = typeof deliveryZones.$inferSelect;
export type NewDeliveryZone = typeof deliveryZones.$inferInsert;
export type DeliveryZonePincode = typeof deliveryZonePincodes.$inferSelect;
export type NewDeliveryZonePincode = typeof deliveryZonePincodes.$inferInsert;
export type Courier = typeof couriers.$inferSelect;
export type NewCourier = typeof couriers.$inferInsert;
export type CourierPerformanceDaily = typeof courierPerformanceDaily.$inferSelect;
export type NewCourierPerformanceDaily = typeof courierPerformanceDaily.$inferInsert;
export type ShippingRule = typeof shippingRules.$inferSelect;
export type NewShippingRule = typeof shippingRules.$inferInsert;
export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;
export type ShipmentLine = typeof shipmentLines.$inferSelect;
export type NewShipmentLine = typeof shipmentLines.$inferInsert;
export type ShipmentEvent = typeof shipmentEvents.$inferSelect;
export type NewShipmentEvent = typeof shipmentEvents.$inferInsert;
export type DeliveryException = typeof deliveryExceptions.$inferSelect;
export type NewDeliveryException = typeof deliveryExceptions.$inferInsert;
export type PackagingMaterial = typeof packagingMaterials.$inferSelect;
export type NewPackagingMaterial = typeof packagingMaterials.$inferInsert;
