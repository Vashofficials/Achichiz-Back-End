/**
 * orders.ts — §2.6
 *
 * Carts (including the abandonment/recovery columns that back the admin's
 * "Abandoned Carts" screen — there is no separate abandoned_carts table),
 * orders with their frozen buyer/address/tax snapshots, order lines with
 * per-line GST, the append-only order timeline, returns and exchanges.
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN nonneg_paise / money_paise / percent_bp / pincode / mobile_in / gstin
 *  - SEQUENCE order_no_seq + FUNCTION next_order_no() — 'ACH100000'. Order
 *    numbers need not be gapless (§3.5, assumption A8), so a sequence is used.
 *  - FUNCTION split_inclusive_tax(gross, rate_bp, interstate) — line prices are
 *    GST-INCLUSIVE (assumption A4); tax is back-computed per line at that
 *    line's own rate and the odd paisa is absorbed into `taxable`.
 *  - CONSTRAINT TRIGGERs trg_order_totals_lines / trg_order_totals_header,
 *    both DEFERRABLE INITIALLY DEFERRED, enforcing §4.4 invariants I1-I4 at
 *    COMMIT. Drizzle cannot express constraint triggers at all — this is the
 *    single most important integrity rule in the schema and it is invisible
 *    here. Cancelling a line REQUIRES adjusting the header in the same
 *    transaction or the commit fails.
 *  - ALTER TABLE carts ADD CONSTRAINT carts_converted_order_id_fkey — the
 *    carts <-> orders FK cycle is closed after both tables exist. It is
 *    declared inline below because Drizzle resolves references lazily.
 *  - Tier 1: no deleted_at on orders / order_lines / order_timeline, and
 *    DELETE is REVOKEd from the application role.
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
  date,
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
import { customers } from './customers.js';
import { corporateAccounts } from './corporate.js';
import { warehouses } from './inventory.js';
import { mediaAssets } from './content.js';
import { payments } from './payments.js';
import {
  productVariants,
  builderTemplates,
  addOns,
  personalisationTemplates,
} from './catalogue.js';

/* ------------------------------------------------------------------ carts */

export const CART_STAGES = ['cart', 'address', 'payment', 'converted'] as const;
export type CartStage = (typeof CART_STAGES)[number];

export const CART_RECOVERY_STATES = [
  'not_sent',
  'email_sent',
  'whatsapp_sent',
  'recovered',
] as const;
export type CartRecoveryState = (typeof CART_RECOVERY_STATES)[number];

export const carts = pgTable(
  'carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'cascade',
    }),
    /** Logged-out carts (localStorage today). */
    anonToken: text('anon_token').unique(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    couponCode: text('coupon_code'),
    /** DB type: CITEXT. Captured at the address step. */
    email: text('email'),
    mobile: text('mobile'),
    stage: text('stage').notNull().default('cart').$type<CartStage>(),
    /** SQL-only: FK added by ALTER after `orders` exists (carts <-> orders cycle). */
    convertedOrderId: uuid('converted_order_id').references(
      (): AnyPgColumn => orders.id,
      { onDelete: 'set null' },
    ),
    /** Backs the admin's Abandoned Carts screen; no separate table exists. */
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
    recoveryState: text('recovery_state')
      .notNull()
      .default('not_sent')
      .$type<CartRecoveryState>(),
    recoverySentAt: timestamp('recovery_sent_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_carts_customer').on(t.customerId).where(sql`stage <> 'converted'`),
    index('idx_carts_abandoned')
      .on(t.abandonedAt.desc())
      .where(sql`stage <> 'converted' AND abandoned_at IS NOT NULL`),
    index('idx_carts_expiry').on(t.expiresAt).where(sql`stage <> 'converted'`),
    check('carts_stage_check', sql`stage IN ('cart','address','payment','converted')`),
    check(
      'carts_recovery_state_check',
      sql`recovery_state IN ('not_sent','email_sent','whatsapp_sent','recovered')`,
    ),
    check('cart_has_owner', sql`customer_id IS NOT NULL OR anon_token IS NOT NULL`),
    check(
      'cart_converted_has_order',
      sql`stage <> 'converted' OR converted_order_id IS NOT NULL`,
    ),
  ],
);

export const cartLines = pgTable(
  'cart_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cartId: uuid('cart_id')
      .notNull()
      .references((): AnyPgColumn => carts.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'cascade',
    }),
    builderTemplateId: uuid('builder_template_id').references(
      (): AnyPgColumn => builderTemplates.id,
      { onDelete: 'cascade' },
    ),
    /** Chosen option ids for a built hamper. */
    builderConfig: jsonb('builder_config'),
    quantity: integer('quantity').notNull(),
    /** Snapshot at add-to-cart. GST-inclusive. */
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    /** { "Name": "...", "Message": "..." } */
    personalisation: jsonb('personalisation'),
    /** Dedupe key; mirrors the storefront's existing line-key construction. */
    lineKey: text('line_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_cart_line_key').on(t.cartId, t.lineKey),
    index('idx_cart_lines_cart').on(t.cartId),
    check('cart_lines_quantity_check', sql`quantity > 0`),
    check(
      'cart_line_exactly_one_kind',
      sql`(variant_id IS NOT NULL)::int + (builder_template_id IS NOT NULL)::int = 1`,
    ),
    check(
      'cart_line_builder_has_config',
      sql`builder_template_id IS NULL OR builder_config IS NOT NULL`,
    ),
  ],
);

export const cartLineAddOns = pgTable(
  'cart_line_add_ons',
  {
    cartLineId: uuid('cart_line_id')
      .notNull()
      .references((): AnyPgColumn => cartLines.id, { onDelete: 'cascade' }),
    addOnId: uuid('add_on_id')
      .notNull()
      .references((): AnyPgColumn => addOns.id, { onDelete: 'cascade' }),
    pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
    inputText: text('input_text'),
  },
  (t) => [primaryKey({ columns: [t.cartLineId, t.addOnId] })],
);

/* ----------------------------------------------------------------- orders */

export const ORDER_CHANNELS = [
  'website',
  'mobile_app',
  'whatsapp',
  'corporate_portal',
  'phone',
  'admin',
] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const ORDER_DELIVERY_TYPES = [
  'standard',
  'scheduled',
  'same_day',
  'midnight',
  'international',
] as const;
export type OrderDeliveryType = (typeof ORDER_DELIVERY_TYPES)[number];

/** The 16-value operational status. The storefront's 5 stages are a display mapping. */
export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'confirmed',
  'in_production',
  'personalisation_pending',
  'quality_check',
  'packed',
  'ready_to_ship',
  'shipped',
  'out_for_delivery',
  'delivered',
  'failed_delivery',
  'rto',
  'cancelled',
  'refund_initiated',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_PAYMENT_STATUSES = [
  'pending',
  'paid',
  'failed',
  'partially_refunded',
  'refunded',
  'cod_due',
] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

export const ORDER_FULFILMENT_STATUSES = [
  'unfulfilled',
  'partially_fulfilled',
  'fulfilled',
  'returned',
] as const;
export type OrderFulfilmentStatus = (typeof ORDER_FULFILMENT_STATUSES)[number];

export const ORDER_PRIORITIES = ['standard', 'high', 'vip'] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'ACH100000'. Generated by next_order_no(); FULL unique (Tier 1). */
    orderNo: text('order_no').notNull().unique(),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'restrict',
    }),
    corporateAccountId: uuid('corporate_account_id').references(
      (): AnyPgColumn => corporateAccounts.id,
      { onDelete: 'set null' },
    ),
    cartId: uuid('cart_id').references((): AnyPgColumn => carts.id, {
      onDelete: 'set null',
    }),
    channel: text('channel').notNull().default('website').$type<OrderChannel>(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),

    // --- Buyer snapshot: an order is a legal record and must not mutate.
    buyerName: text('buyer_name').notNull(),
    buyerEmail: text('buyer_email'),
    buyerMobile: text('buyer_mobile'),

    // --- Recipient (the entire point of the business; storefront must add these)
    recipientName: text('recipient_name'),
    recipientMobile: text('recipient_mobile'),
    isAnonymousGift: boolean('is_anonymous_gift').notNull().default(false),
    giftMessage: text('gift_message'),

    // --- Shipping address snapshot
    shipLine1: text('ship_line1').notNull(),
    shipLine2: text('ship_line2'),
    shipArea: text('ship_area'),
    shipCity: text('ship_city').notNull(),
    shipStateCode: char('ship_state_code', { length: 2 })
      .notNull()
      .references((): AnyPgColumn => gstStates.code, { onDelete: 'restrict' }),
    shipPincode: text('ship_pincode').notNull(),
    shipCountryCode: char('ship_country_code', { length: 2 }).notNull().default('IN'),

    // --- Billing (differs for corporate / input-tax-credit buyers)
    billSameAsShip: boolean('bill_same_as_ship').notNull().default(true),
    billName: text('bill_name'),
    billLine1: text('bill_line1'),
    billCity: text('bill_city'),
    billStateCode: char('bill_state_code', { length: 2 }).references(
      (): AnyPgColumn => gstStates.code,
      { onDelete: 'restrict' },
    ),
    billPincode: text('bill_pincode'),
    billGstin: text('bill_gstin'),

    // --- Tax determination, frozen at order time (§3.3)
    placeOfSupplyStateCode: char('place_of_supply_state_code', { length: 2 })
      .notNull()
      .references((): AnyPgColumn => gstStates.code, { onDelete: 'restrict' }),
    supplierGstin: text('supplier_gstin'),
    supplierStateCode: char('supplier_state_code', { length: 2 }).references(
      (): AnyPgColumn => gstStates.code,
      { onDelete: 'restrict' },
    ),
    /** Stored, not computed: the state codes are themselves snapshots. */
    isInterstate: boolean('is_interstate').notNull(),
    isExport: boolean('is_export').notNull().default(false),

    // --- Delivery
    deliveryType: text('delivery_type')
      .notNull()
      .default('standard')
      .$type<OrderDeliveryType>(),
    requestedDeliveryDate: date('requested_delivery_date'),
    /** '09:00 - 12:00' | 'Midnight surprise' */
    deliverySlot: text('delivery_slot'),
    fulfilmentWarehouseId: uuid('fulfilment_warehouse_id').references(
      (): AnyPgColumn => warehouses.id,
      { onDelete: 'set null' },
    ),

    // --- Money: all paise; line prices GST-inclusive (§3.2).
    //     The header discount columns are informational rollups of
    //     order_lines.allocated_order_discount_paise — do NOT subtract them
    //     again from subtotal (§4.4 I2/I3).
    subtotalPaise: bigint('subtotal_paise', { mode: 'number' }).notNull().default(0),
    couponDiscountPaise: bigint('coupon_discount_paise', { mode: 'number' })
      .notNull()
      .default(0),
    autoDiscountPaise: bigint('auto_discount_paise', { mode: 'number' })
      .notNull()
      .default(0),
    loyaltyDiscountPaise: bigint('loyalty_discount_paise', { mode: 'number' })
      .notNull()
      .default(0),
    shippingPaise: bigint('shipping_paise', { mode: 'number' }).notNull().default(0),
    codFeePaise: bigint('cod_fee_paise', { mode: 'number' }).notNull().default(0),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull().default(0),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    cessPaise: bigint('cess_paise', { mode: 'number' }).notNull().default(0),
    /** DOMAIN money_paise, bounded to +/-50: invoice rounding only. */
    roundOffPaise: bigint('round_off_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull().default(0),
    amountPaidPaise: bigint('amount_paid_paise', { mode: 'number' }).notNull().default(0),
    amountRefundedPaise: bigint('amount_refunded_paise', { mode: 'number' })
      .notNull()
      .default(0),

    couponCode: text('coupon_code'),
    status: text('status').notNull().default('pending_payment').$type<OrderStatus>(),
    paymentStatus: text('payment_status')
      .notNull()
      .default('pending')
      .$type<OrderPaymentStatus>(),
    fulfilmentStatus: text('fulfilment_status')
      .notNull()
      .default('unfulfilled')
      .$type<OrderFulfilmentStatus>(),
    priority: text('priority').notNull().default('standard').$type<OrderPriority>(),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    internalNotes: text('internal_notes'),

    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('idx_orders_customer').on(t.customerId, t.placedAt.desc()),
    index('idx_orders_status').on(t.status, t.placedAt.desc()),
    index('idx_orders_payment').on(t.paymentStatus, t.placedAt.desc()),
    index('idx_orders_placed').on(t.placedAt.desc()),
    index('idx_orders_delivery')
      .on(t.requestedDeliveryDate)
      .where(sql`status NOT IN ('delivered','cancelled','refunded')`),
    index('idx_orders_corporate')
      .on(t.corporateAccountId)
      .where(sql`corporate_account_id IS NOT NULL`),
    index('idx_orders_warehouse').on(t.fulfilmentWarehouseId, t.status),
    index('idx_orders_channel').on(t.channel, t.placedAt.desc()),
    index('idx_orders_tags').using('gin', t.tags),
    index('idx_orders_priority')
      .on(t.priority, t.placedAt.desc())
      .where(sql`priority <> 'standard'`),
    index('idx_orders_search_trgm').using(
      'gin',
      sql`(order_no || ' ' || buyer_name || ' ' || coalesce(buyer_email::text,'') || ' ' || coalesce(buyer_mobile,'')) gin_trgm_ops`,
    ),
    check('orders_order_no_check', sql`order_no ~ '^ACH[0-9]{6,}$'`),
    check(
      'orders_channel_check',
      sql`channel IN ('website','mobile_app','whatsapp','corporate_portal','phone','admin')`,
    ),
    check(
      'orders_delivery_type_check',
      sql`delivery_type IN ('standard','scheduled','same_day','midnight','international')`,
    ),
    check(
      'orders_status_check',
      sql`status IN ('pending_payment','paid','confirmed','in_production','personalisation_pending','quality_check','packed','ready_to_ship','shipped','out_for_delivery','delivered','failed_delivery','rto','cancelled','refund_initiated','refunded')`,
    ),
    check(
      'orders_payment_status_check',
      sql`payment_status IN ('pending','paid','failed','partially_refunded','refunded','cod_due')`,
    ),
    check(
      'orders_fulfilment_status_check',
      sql`fulfilment_status IN ('unfulfilled','partially_fulfilled','fulfilled','returned')`,
    ),
    check('orders_priority_check', sql`priority IN ('standard','high','vip')`),
    check('orders_round_off_paise_check', sql`round_off_paise BETWEEN -50 AND 50`),
    check(
      'order_tax_split_consistent',
      sql`(is_interstate AND cgst_paise = 0 AND sgst_paise = 0) OR (NOT is_interstate AND igst_paise = 0)`,
    ),
    check('order_cgst_equals_sgst', sql`cgst_paise = sgst_paise`),
    check('order_refund_not_over_paid', sql`amount_refunded_paise <= amount_paid_paise`),
    check(
      'order_cancel_has_reason',
      sql`cancelled_at IS NULL OR cancel_reason IS NOT NULL`,
    ),
    check(
      'order_billing_complete',
      sql`bill_same_as_ship OR (bill_name IS NOT NULL AND bill_line1 IS NOT NULL AND bill_state_code IS NOT NULL)`,
    ),
  ],
);

/* ------------------------------------------------------------ order_lines */

export const ORDER_LINE_FULFILMENT_STATUSES = [
  'unfulfilled',
  'allocated',
  'picked',
  'packed',
  'fulfilled',
  'cancelled',
  'returned',
] as const;
export type OrderLineFulfilmentStatus = (typeof ORDER_LINE_FULFILMENT_STATUSES)[number];

export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'restrict',
    }),
    builderTemplateId: uuid('builder_template_id').references(
      (): AnyPgColumn => builderTemplates.id,
      { onDelete: 'restrict' },
    ),
    builderConfig: jsonb('builder_config'),

    // --- Snapshots: the catalogue will change; the order must not.
    skuSnapshot: text('sku_snapshot').notNull(),
    titleSnapshot: text('title_snapshot').notNull(),
    variantLabelSnapshot: text('variant_label_snapshot'),
    imageUrlSnapshot: text('image_url_snapshot'),
    /** DB type: DOMAIN hsn. Resolved rate is snapshotted into gstRateBp. */
    hsnSnapshot: text('hsn_snapshot'),

    quantity: integer('quantity').notNull(),
    /** GST-inclusive. */
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    lineDiscountPaise: bigint('line_discount_paise', { mode: 'number' })
      .notNull()
      .default(0),
    /** The line's share of an order-level coupon, largest-remainder allocated. */
    allocatedOrderDiscountPaise: bigint('allocated_order_discount_paise', {
      mode: 'number',
    })
      .notNull()
      .default(0),
    /** qty*unit - both discounts. This is what §4.4 I1 sums. */
    grossPaise: bigint('gross_paise', { mode: 'number' }).notNull(),
    gstRateBp: integer('gst_rate_bp').notNull().default(0),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull().default(0),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    cessPaise: bigint('cess_paise', { mode: 'number' }).notNull().default(0),

    fulfilmentStatus: text('fulfilment_status')
      .notNull()
      .default('unfulfilled')
      .$type<OrderLineFulfilmentStatus>(),
    fulfilledQty: integer('fulfilled_qty').notNull().default(0),
    returnedQty: integer('returned_qty').notNull().default(0),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_order_lines_order').on(t.orderId, t.position),
    index('idx_order_lines_variant_time').on(t.variantId, t.createdAt.desc()),
    check('order_lines_quantity_check', sql`quantity > 0`),
    check('order_lines_fulfilled_qty_check', sql`fulfilled_qty >= 0`),
    check('order_lines_returned_qty_check', sql`returned_qty >= 0`),
    check(
      'order_lines_fulfilment_status_check',
      sql`fulfilment_status IN ('unfulfilled','allocated','picked','packed','fulfilled','cancelled','returned')`,
    ),
    check(
      'order_line_exactly_one_kind',
      sql`(variant_id IS NOT NULL)::int + (builder_template_id IS NOT NULL)::int = 1`,
    ),
    check('order_line_fulfil_bounds', sql`fulfilled_qty <= quantity`),
    check('order_line_return_bounds', sql`returned_qty <= quantity`),
    check(
      'order_line_discount_bounds',
      sql`line_discount_paise + allocated_order_discount_paise <= unit_price_paise * quantity`,
    ),
    check(
      'order_line_tax_split',
      sql`(igst_paise = 0) OR (cgst_paise = 0 AND sgst_paise = 0)`,
    ),
  ],
);

/** Gift wrap etc. are add-on LINES, not scalar columns — otherwise they cannot be taxed. */
export const orderLineAddOns = pgTable(
  'order_line_add_ons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references((): AnyPgColumn => orderLines.id, { onDelete: 'cascade' }),
    addOnId: uuid('add_on_id').references((): AnyPgColumn => addOns.id, {
      onDelete: 'set null',
    }),
    nameSnapshot: text('name_snapshot').notNull(),
    pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
    quantity: integer('quantity').notNull().default(1),
    inputText: text('input_text'),
    gstRateBp: integer('gst_rate_bp').notNull().default(0),
    hsnSnapshot: text('hsn_snapshot'),
  },
  (t) => [
    index('idx_order_line_addons_line').on(t.orderLineId),
    check('order_line_add_ons_quantity_check', sql`quantity > 0`),
  ],
);

export const PROOF_STATUSES = [
  'not_required',
  'pending',
  'sent',
  'approved',
  'rejected',
] as const;
export type ProofStatus = (typeof PROOF_STATUSES)[number];

export const orderLinePersonalisations = pgTable(
  'order_line_personalisations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references((): AnyPgColumn => orderLines.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').references(
      (): AnyPgColumn => personalisationTemplates.id,
      { onDelete: 'set null' },
    ),
    method: text('method').notNull(),
    inputText: text('input_text'),
    inputMediaId: uuid('input_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    proofMediaId: uuid('proof_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    proofStatus: text('proof_status')
      .notNull()
      .default('not_required')
      .$type<ProofStatus>(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_personalisation_queue')
      .on(t.proofStatus)
      .where(sql`proof_status IN ('pending','sent')`),
    check(
      'order_line_personalisations_proof_status_check',
      sql`proof_status IN ('not_required','pending','sent','approved','rejected')`,
    ),
  ],
);

/* --------------------------------------------------------- order_timeline */
/** Append-only (Tier 1). BIGINT identity: insert-heavy, scanned by time range. */

export const TIMELINE_ACTOR_KINDS = [
  'customer',
  'staff',
  'system',
  'courier',
  'gateway',
] as const;
export type TimelineActorKind = (typeof TIMELINE_ACTOR_KINDS)[number];

export const orderTimeline = pgTable(
  'order_timeline',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** 'order.placed' | 'payment.captured' | ... */
    eventType: text('event_type').notNull(),
    /** Human string shown in the admin drawer. */
    label: text('label').notNull(),
    note: text('note'),
    actorKind: text('actor_kind').notNull().default('system').$type<TimelineActorKind>(),
    actorStaffId: uuid('actor_staff_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    /** 'Razorpay' | 'Blue Dart' */
    actorLabel: text('actor_label'),
    metadata: jsonb('metadata'),
  },
  (t) => [
    index('idx_order_timeline_order').on(t.orderId, t.occurredAt),
    check(
      'order_timeline_actor_kind_check',
      sql`actor_kind IN ('customer','staff','system','courier','gateway')`,
    ),
  ],
);

/* ---------------------------------------------------------------- returns */

export const RETURN_REASONS = [
  'damaged_in_transit',
  'wrong_item',
  'late_delivery',
  'quality_not_as_expected',
  'changed_mind',
  'personalisation_error',
  'other',
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_STATUSES = [
  'requested',
  'approved',
  'picked_up',
  'received',
  'refunded',
  'rejected',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const REFUND_MODES = ['original', 'store_credit', 'bank_transfer'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

export const returns = pgTable(
  'returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'RET-2026-00001'. Document number: FULL unique. */
    returnNo: text('return_no').notNull().unique(),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'set null',
    }),
    reason: text('reason').notNull().$type<ReturnReason>(),
    reasonNote: text('reason_note'),
    status: text('status').notNull().default('requested').$type<ReturnStatus>(),
    refundMode: text('refund_mode').notNull().default('original').$type<RefundMode>(),
    refundPaise: bigint('refund_paise', { mode: 'number' }).notNull().default(0),
    restock: boolean('restock').notNull().default(true),
    pickupAwb: text('pickup_awb'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_returns_order').on(t.orderId),
    index('idx_returns_status').on(t.status, t.requestedAt.desc()),
    check(
      'returns_reason_check',
      sql`reason IN ('damaged_in_transit','wrong_item','late_delivery','quality_not_as_expected','changed_mind','personalisation_error','other')`,
    ),
    check(
      'returns_status_check',
      sql`status IN ('requested','approved','picked_up','received','refunded','rejected')`,
    ),
    check(
      'returns_refund_mode_check',
      sql`refund_mode IN ('original','store_credit','bank_transfer')`,
    ),
  ],
);

export const RETURN_LINE_CONDITIONS = [
  'sellable',
  'damaged',
  'opened',
  'missing_parts',
] as const;
export type ReturnLineCondition = (typeof RETURN_LINE_CONDITIONS)[number];

/** Line-level returns: the admin mock cannot represent a partial return. */
export const returnLines = pgTable(
  'return_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    returnId: uuid('return_id')
      .notNull()
      .references((): AnyPgColumn => returns.id, { onDelete: 'cascade' }),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references((): AnyPgColumn => orderLines.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    refundPaise: bigint('refund_paise', { mode: 'number' }).notNull().default(0),
    condition: text('condition').$type<ReturnLineCondition>(),
  },
  (t) => [
    uniqueIndex('return_lines_return_id_order_line_id_key').on(t.returnId, t.orderLineId),
    index('idx_return_lines_order_line').on(t.orderLineId),
    check('return_lines_quantity_check', sql`quantity > 0`),
    check(
      'return_lines_condition_check',
      sql`condition IN ('sellable','damaged','opened','missing_parts')`,
    ),
  ],
);

/* -------------------------------------------------------------- exchanges */

export const EXCHANGE_STATUSES = [
  'requested',
  'approved',
  'dispatched',
  'completed',
  'rejected',
] as const;
export type ExchangeStatus = (typeof EXCHANGE_STATUSES)[number];

export const exchanges = pgTable(
  'exchanges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    exchangeNo: text('exchange_no').notNull().unique(),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    orderLineId: uuid('order_line_id').references((): AnyPgColumn => orderLines.id, {
      onDelete: 'set null',
    }),
    fromVariantId: uuid('from_variant_id').references(
      (): AnyPgColumn => productVariants.id,
      { onDelete: 'restrict' },
    ),
    toVariantId: uuid('to_variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'restrict',
    }),
    quantity: integer('quantity').notNull().default(1),
    /** DOMAIN money_paise — negative on a downgrade refund. */
    priceDiffPaise: bigint('price_diff_paise', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('requested').$type<ExchangeStatus>(),
    replacementOrderId: uuid('replacement_order_id').references(
      (): AnyPgColumn => orders.id,
      { onDelete: 'set null' },
    ),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_exchanges_order').on(t.orderId),
    index('idx_exchanges_status').on(t.status, t.requestedAt.desc()),
    check('exchanges_quantity_check', sql`quantity > 0`),
    check(
      'exchanges_status_check',
      sql`status IN ('requested','approved','dispatched','completed','rejected')`,
    ),
    check('exchange_variants_differ', sql`from_variant_id IS DISTINCT FROM to_variant_id`),
  ],
);

/* -------------------------------------------------------------- relations */

export const cartsRelations = relations(carts, ({ one, many }) => ({
  customer: one(customers, { fields: [carts.customerId], references: [customers.id] }),
  lines: many(cartLines),
}));

export const cartLinesRelations = relations(cartLines, ({ one, many }) => ({
  cart: one(carts, { fields: [cartLines.cartId], references: [carts.id] }),
  variant: one(productVariants, {
    fields: [cartLines.variantId],
    references: [productVariants.id],
  }),
  addOns: many(cartLineAddOns),
}));

export const cartLineAddOnsRelations = relations(cartLineAddOns, ({ one }) => ({
  cartLine: one(cartLines, {
    fields: [cartLineAddOns.cartLineId],
    references: [cartLines.id],
  }),
  addOn: one(addOns, { fields: [cartLineAddOns.addOnId], references: [addOns.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  corporateAccount: one(corporateAccounts, {
    fields: [orders.corporateAccountId],
    references: [corporateAccounts.id],
  }),
  cart: one(carts, { fields: [orders.cartId], references: [carts.id] }),
  fulfilmentWarehouse: one(warehouses, {
    fields: [orders.fulfilmentWarehouseId],
    references: [warehouses.id],
  }),
  placeOfSupplyState: one(gstStates, {
    fields: [orders.placeOfSupplyStateCode],
    references: [gstStates.code],
  }),
  lines: many(orderLines),
  timeline: many(orderTimeline),
  payments: many(payments),
  returns: many(returns),
  exchanges: many(exchanges),
}));

export const orderLinesRelations = relations(orderLines, ({ one, many }) => ({
  order: one(orders, { fields: [orderLines.orderId], references: [orders.id] }),
  variant: one(productVariants, {
    fields: [orderLines.variantId],
    references: [productVariants.id],
  }),
  addOns: many(orderLineAddOns),
  personalisations: many(orderLinePersonalisations),
  returnLines: many(returnLines),
}));

export const orderLineAddOnsRelations = relations(orderLineAddOns, ({ one }) => ({
  orderLine: one(orderLines, {
    fields: [orderLineAddOns.orderLineId],
    references: [orderLines.id],
  }),
  addOn: one(addOns, { fields: [orderLineAddOns.addOnId], references: [addOns.id] }),
}));

export const orderLinePersonalisationsRelations = relations(
  orderLinePersonalisations,
  ({ one }) => ({
    orderLine: one(orderLines, {
      fields: [orderLinePersonalisations.orderLineId],
      references: [orderLines.id],
    }),
    template: one(personalisationTemplates, {
      fields: [orderLinePersonalisations.templateId],
      references: [personalisationTemplates.id],
    }),
  }),
);

export const orderTimelineRelations = relations(orderTimeline, ({ one }) => ({
  order: one(orders, { fields: [orderTimeline.orderId], references: [orders.id] }),
  actorStaff: one(staffUsers, {
    fields: [orderTimeline.actorStaffId],
    references: [staffUsers.id],
  }),
}));

export const returnsRelations = relations(returns, ({ one, many }) => ({
  order: one(orders, { fields: [returns.orderId], references: [orders.id] }),
  customer: one(customers, { fields: [returns.customerId], references: [customers.id] }),
  lines: many(returnLines),
}));

export const returnLinesRelations = relations(returnLines, ({ one }) => ({
  return: one(returns, { fields: [returnLines.returnId], references: [returns.id] }),
  orderLine: one(orderLines, {
    fields: [returnLines.orderLineId],
    references: [orderLines.id],
  }),
}));

export const exchangesRelations = relations(exchanges, ({ one }) => ({
  order: one(orders, {
    fields: [exchanges.orderId],
    references: [orders.id],
    relationName: 'exchange_order',
  }),
  replacementOrder: one(orders, {
    fields: [exchanges.replacementOrderId],
    references: [orders.id],
    relationName: 'exchange_replacement_order',
  }),
}));

/* ------------------------------------------------------------------ types */

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;
export type CartLine = typeof cartLines.$inferSelect;
export type NewCartLine = typeof cartLines.$inferInsert;
export type CartLineAddOn = typeof cartLineAddOns.$inferSelect;
export type NewCartLineAddOn = typeof cartLineAddOns.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderLine = typeof orderLines.$inferSelect;
export type NewOrderLine = typeof orderLines.$inferInsert;
export type OrderLineAddOn = typeof orderLineAddOns.$inferSelect;
export type NewOrderLineAddOn = typeof orderLineAddOns.$inferInsert;
export type OrderLinePersonalisation = typeof orderLinePersonalisations.$inferSelect;
export type NewOrderLinePersonalisation = typeof orderLinePersonalisations.$inferInsert;
export type OrderTimelineEvent = typeof orderTimeline.$inferSelect;
export type NewOrderTimelineEvent = typeof orderTimeline.$inferInsert;
export type Return = typeof returns.$inferSelect;
export type NewReturn = typeof returns.$inferInsert;
export type ReturnLine = typeof returnLines.$inferSelect;
export type NewReturnLine = typeof returnLines.$inferInsert;
export type Exchange = typeof exchanges.$inferSelect;
export type NewExchange = typeof exchanges.$inferInsert;
