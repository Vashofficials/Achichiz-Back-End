/**
 * promotions.ts — §2.10
 *
 * Coupons and their scope/redemptions, automatic cart discounts, bundles,
 * upsell rules, the loyalty programme (tiers → accounts → ledger) and referrals.
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN nonneg_paise / percent_bp
 *  - §4.2 coupon usage limits: the MECHANISM is a conditional
 *    `UPDATE coupons SET redemption_count = redemption_count + 1 WHERE ...
 *     AND (max_redemptions IS NULL OR redemption_count < max_redemptions)`.
 *    That UPDATE's row lock is also what serialises the per-customer count
 *    query that follows it in the same transaction. The CHECK
 *    coupon_within_limit is only a backstop.
 *  - uq_coupon_once_per_order makes double-applying a coupon to one order
 *    impossible even under retry. Where max_redemptions_per_customer = 1, the
 *    application should additionally create
 *    `CREATE UNIQUE INDEX ... ON coupon_redemptions (coupon_id, customer_id)
 *     WHERE reversed_at IS NULL` for that coupon — it cannot be a table-wide
 *    index because multi-use coupons exist.
 *  - §7 correction 4 — referral_conversions self-referral is enforced by
 *    TRIGGER trg_no_self_referral / FUNCTION forbid_self_referral(). The
 *    original CHECK contained a subquery, which PostgreSQL rejects. There is
 *    NO check() for it below; do not add one.
 *  - §7 correction 2 — coupons.code and bundles.handle use PARTIAL unique
 *    indexes (WHERE deleted_at IS NULL).
 *  - coupon_redemptions and loyalty_transactions are Tier 1 (no deleted_at,
 *    DELETE revoked). `bundles.savings` and referral counters are derived.
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
  numeric,
  date,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { staffUsers } from './identity.js';
import { customers } from './customers.js';
import { orders } from './orders.js';
import { products, productVariants, collections, addOns } from './catalogue.js';

/* ---------------------------------------------------------------- coupons */

export const COUPON_DISCOUNT_TYPES = [
  'percent',
  'flat',
  'free_shipping',
  'bogo',
  'free_gift',
] as const;
export type CouponDiscountType = (typeof COUPON_DISCOUNT_TYPES)[number];

export const COUPON_APPLIES_TO = [
  'all',
  'collections',
  'products',
  'first_order',
] as const;
export type CouponAppliesTo = (typeof COUPON_APPLIES_TO)[number];

export const COUPON_STATUSES = [
  'active',
  'scheduled',
  'expired',
  'paused',
  'draft',
] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];

export const coupons = pgTable(
  'coupons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Uppercase, 3-32 chars. Partial-unique (§7 correction 2). */
    code: text('code').notNull(),
    description: text('description'),
    /**
     * The admin mock drew `type` and `value` from independent random pools, so
     * {type:'Flat', value:'10%'} was representable. The CHECKs below make that
     * combination impossible.
     */
    discountType: text('discount_type').notNull().$type<CouponDiscountType>(),
    /** For 'percent'. */
    discountBp: integer('discount_bp'),
    /** For 'flat'. */
    discountPaise: bigint('discount_paise', { mode: 'number' }),
    /** Caps a percent coupon. */
    maxDiscountPaise: bigint('max_discount_paise', { mode: 'number' }),
    minOrderPaise: bigint('min_order_paise', { mode: 'number' }).notNull().default(0),
    bogoBuyQty: smallint('bogo_buy_qty'),
    bogoGetQty: smallint('bogo_get_qty'),
    freeGiftVariantId: uuid('free_gift_variant_id').references(
      (): AnyPgColumn => productVariants.id,
      { onDelete: 'set null' },
    ),
    appliesTo: text('applies_to').notNull().default('all').$type<CouponAppliesTo>(),
    /** {} = all channels. */
    channels: text('channels').array().notNull().default(sql`'{}'::text[]`),
    maxRedemptions: integer('max_redemptions'),
    maxRedemptionsPerCustomer: integer('max_redemptions_per_customer')
      .notNull()
      .default(1),
    redemptionCount: integer('redemption_count').notNull().default(0),
    stackable: boolean('stackable').notNull().default(false),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    status: text('status').notNull().default('draft').$type<CouponStatus>(),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_coupons_code').on(t.code).where(sql`deleted_at IS NULL`),
    index('idx_coupons_status').on(t.status, t.endsAt).where(sql`deleted_at IS NULL`),
    index('idx_coupons_active')
      .on(t.code)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
    check(
      'coupons_code_check',
      sql`code = upper(code) AND code ~ '^[A-Z0-9_-]{3,32}$'`,
    ),
    check(
      'coupons_discount_type_check',
      sql`discount_type IN ('percent','flat','free_shipping','bogo','free_gift')`,
    ),
    check(
      'coupons_applies_to_check',
      sql`applies_to IN ('all','collections','products','first_order')`,
    ),
    check(
      'coupons_status_check',
      sql`status IN ('active','scheduled','expired','paused','draft')`,
    ),
    check(
      'coupons_max_redemptions_check',
      sql`max_redemptions IS NULL OR max_redemptions > 0`,
    ),
    check(
      'coupons_max_per_customer_check',
      sql`max_redemptions_per_customer > 0`,
    ),
    check('coupons_redemption_count_check', sql`redemption_count >= 0`),
    // §4.2 backstop — the usage cap is a database invariant.
    check(
      'coupon_within_limit',
      sql`max_redemptions IS NULL OR redemption_count <= max_redemptions`,
    ),
    check('coupon_window', sql`ends_at IS NULL OR ends_at > starts_at`),
    check(
      'coupon_percent_needs_bp',
      sql`discount_type <> 'percent' OR discount_bp IS NOT NULL`,
    ),
    check(
      'coupon_flat_needs_paise',
      sql`discount_type <> 'flat' OR discount_paise IS NOT NULL`,
    ),
    check(
      'coupon_bogo_needs_qty',
      sql`discount_type <> 'bogo' OR (bogo_buy_qty IS NOT NULL AND bogo_get_qty IS NOT NULL)`,
    ),
    check(
      'coupon_gift_needs_variant',
      sql`discount_type <> 'free_gift' OR free_gift_variant_id IS NOT NULL`,
    ),
  ],
);

/** Inclusion/exclusion list. No surrogate PK — uniqueness is the two partial indexes. */
export const couponScope = pgTable(
  'coupon_scope',
  {
    couponId: uuid('coupon_id')
      .notNull()
      .references((): AnyPgColumn => coupons.id, { onDelete: 'cascade' }),
    collectionId: uuid('collection_id').references((): AnyPgColumn => collections.id, {
      onDelete: 'cascade',
    }),
    productId: uuid('product_id').references((): AnyPgColumn => products.id, {
      onDelete: 'cascade',
    }),
    isExclusion: boolean('is_exclusion').notNull().default(false),
  },
  (t) => [
    uniqueIndex('uq_coupon_scope_col')
      .on(t.couponId, t.collectionId)
      .where(sql`collection_id IS NOT NULL`),
    uniqueIndex('uq_coupon_scope_prod')
      .on(t.couponId, t.productId)
      .where(sql`product_id IS NOT NULL`),
    check(
      'coupon_scope_exactly_one',
      sql`(collection_id IS NOT NULL)::int + (product_id IS NOT NULL)::int = 1`,
    ),
  ],
);

/** Tier 1 — never deleted. Cancellation stamps `reversed_at`. */
export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    couponId: uuid('coupon_id')
      .notNull()
      .references((): AnyPgColumn => coupons.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'set null',
    }),
    discountPaise: bigint('discount_paise', { mode: 'number' }).notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the order is cancelled; the redemption returns to the pool. */
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
  },
  (t) => [
    // §4.2 — one redemption per coupon per order, at the storage layer.
    uniqueIndex('uq_coupon_once_per_order').on(t.couponId, t.orderId),
    index('idx_coupon_redemptions_customer')
      .on(t.couponId, t.customerId)
      .where(sql`reversed_at IS NULL`),
  ],
);

/* --------------------------------------------------------- auto_discounts */

export const AUTO_DISCOUNT_TYPES = [
  'percent',
  'flat',
  'free_shipping',
  'free_gift_wrap',
  'free_gift',
] as const;
export type AutoDiscountType = (typeof AUTO_DISCOUNT_TYPES)[number];

export const AUTO_DISCOUNT_STATUSES = ['active', 'draft', 'expired'] as const;
export type AutoDiscountStatus = (typeof AUTO_DISCOUNT_STATUSES)[number];

export const autoDiscounts = pgTable(
  'auto_discounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Executable rule DSL (§1.4). */
    rule: jsonb('rule').notNull(),
    /** 'cart_items >= 2 AND category = hampers' — display only. */
    ruleText: text('rule_text'),
    discountType: text('discount_type').notNull().$type<AutoDiscountType>(),
    discountBp: integer('discount_bp'),
    discountPaise: bigint('discount_paise', { mode: 'number' }),
    priority: integer('priority').notNull().default(100),
    stackable: boolean('stackable').notNull().default(false),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    status: text('status').notNull().default('draft').$type<AutoDiscountStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_auto_discounts_active')
      .on(t.priority)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
    check(
      'auto_discounts_discount_type_check',
      sql`discount_type IN ('percent','flat','free_shipping','free_gift_wrap','free_gift')`,
    ),
    check('auto_discounts_status_check', sql`status IN ('active','draft','expired')`),
  ],
);

/* ---------------------------------------------------------------- bundles */

export const BUNDLE_STATUSES = ['active', 'draft', 'archived'] as const;
export type BundleStatus = (typeof BUNDLE_STATUSES)[number];

/** `savings` is derived: SUM(component price) - bundle_price. Not stored. */
export const bundles = pgTable(
  'bundles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: DOMAIN handle. Partial-unique. */
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    bundlePricePaise: bigint('bundle_price_paise', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('draft').$type<BundleStatus>(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_bundles_handle').on(t.handle).where(sql`deleted_at IS NULL`),
    check('bundles_status_check', sql`status IN ('active','draft','archived')`),
  ],
);

export const bundleItems = pgTable(
  'bundle_items',
  {
    bundleId: uuid('bundle_id')
      .notNull()
      .references((): AnyPgColumn => bundles.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references((): AnyPgColumn => productVariants.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull().default(1),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bundleId, t.variantId] }),
    check('bundle_items_quantity_check', sql`quantity > 0`),
  ],
);

/* ----------------------------------------------------------- upsell_rules */

export const UPSELL_OFFER_KINDS = [
  'add_on',
  'product',
  'discount',
  'free_shipping',
] as const;
export type UpsellOfferKind = (typeof UPSELL_OFFER_KINDS)[number];

export const UPSELL_PLACEMENTS = [
  'pdp',
  'cart',
  'cart_drawer',
  'checkout',
  'post_purchase',
] as const;
export type UpsellPlacement = (typeof UPSELL_PLACEMENTS)[number];

export const UPSELL_STATUSES = ['active', 'paused'] as const;
export type UpsellStatus = (typeof UPSELL_STATUSES)[number];

export const upsellRules = pgTable(
  'upsell_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    trigger: jsonb('trigger').notNull(),
    /** 'Hamper added to cart' — display only. */
    triggerText: text('trigger_text'),
    offerKind: text('offer_kind').notNull().$type<UpsellOfferKind>(),
    offerAddOnId: uuid('offer_add_on_id').references((): AnyPgColumn => addOns.id, {
      onDelete: 'cascade',
    }),
    offerVariantId: uuid('offer_variant_id').references(
      (): AnyPgColumn => productVariants.id,
      { onDelete: 'cascade' },
    ),
    offerPricePaise: bigint('offer_price_paise', { mode: 'number' }),
    offerDiscountBp: integer('offer_discount_bp'),
    placement: text('placement').notNull().$type<UpsellPlacement>(),
    priority: integer('priority').notNull().default(100),
    status: text('status').notNull().default('paused').$type<UpsellStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_upsell_placement')
      .on(t.placement, t.priority)
      .where(sql`status = 'active'`),
    check(
      'upsell_rules_offer_kind_check',
      sql`offer_kind IN ('add_on','product','discount','free_shipping')`,
    ),
    check(
      'upsell_rules_placement_check',
      sql`placement IN ('pdp','cart','cart_drawer','checkout','post_purchase')`,
    ),
    check('upsell_rules_status_check', sql`status IN ('active','paused')`),
  ],
);

/* ---------------------------------------------------------------- loyalty */

export const LOYALTY_TIER_STATUSES = ['active', 'archived'] as const;
export type LoyaltyTierStatus = (typeof LOYALTY_TIER_STATUSES)[number];

export const loyaltyTiers = pgTable(
  'loyalty_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Silver | Gold | Platinum | Noir */
    name: text('name').notNull().unique(),
    rank: smallint('rank').notNull().unique(),
    /** Lifetime spend to qualify. */
    thresholdPaise: bigint('threshold_paise', { mode: 'number' }).notNull(),
    /** The admin's '2 pts / ₹100' becomes a number. */
    pointsPer100Paise: numeric('points_per_100_paise', { precision: 6, scale: 3 })
      .notNull()
      .default('1'),
    perks: text('perks'),
    isInviteOnly: boolean('is_invite_only').notNull().default(false),
    freeSameDay: boolean('free_same_day').notNull().default(false),
    freeGiftWrap: boolean('free_gift_wrap').notNull().default(false),
    discountBp: integer('discount_bp').notNull().default(0),
    status: text('status').notNull().default('active').$type<LoyaltyTierStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check('loyalty_tiers_status_check', sql`status IN ('active','archived')`)],
);

export const loyaltyAccounts = pgTable(
  'loyalty_accounts',
  {
    customerId: uuid('customer_id')
      .primaryKey()
      .references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
    tierId: uuid('tier_id').references((): AnyPgColumn => loyaltyTiers.id, {
      onDelete: 'set null',
    }),
    pointsBalance: integer('points_balance').notNull().default(0),
    pointsLifetime: integer('points_lifetime').notNull().default(0),
    tierSince: date('tier_since'),
    tierExpiresOn: date('tier_expires_on'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_loyalty_tier').on(t.tierId),
    check('loyalty_accounts_points_balance_check', sql`points_balance >= 0`),
    check('loyalty_accounts_points_lifetime_check', sql`points_lifetime >= 0`),
  ],
);

export const LOYALTY_TXN_KINDS = [
  'earn',
  'redeem',
  'expire',
  'adjustment',
  'referral_bonus',
  'signup_bonus',
] as const;
export type LoyaltyTxnKind = (typeof LOYALTY_TXN_KINDS)[number];

/** Append-only ledger (Tier 1). BIGINT identity. */
export const loyaltyTransactions = pgTable(
  'loyalty_transactions',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'set null',
    }),
    pointsDelta: integer('points_delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    kind: text('kind').notNull().$type<LoyaltyTxnKind>(),
    note: text('note'),
    expiresOn: date('expires_on'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_loyalty_txn_customer').on(t.customerId, t.occurredAt.desc()),
    uniqueIndex('uq_loyalty_earn_per_order')
      .on(t.orderId)
      .where(sql`order_id IS NOT NULL AND kind = 'earn'`),
    check('loyalty_transactions_points_delta_check', sql`points_delta <> 0`),
    check('loyalty_transactions_balance_after_check', sql`balance_after >= 0`),
    check(
      'loyalty_transactions_kind_check',
      sql`kind IN ('earn','redeem','expire','adjustment','referral_bonus','signup_bonus')`,
    ),
  ],
);

/* -------------------------------------------------------------- referrals */

export const REFERRAL_REWARD_KINDS = ['points', 'coupon', 'store_credit'] as const;
export type ReferralRewardKind = (typeof REFERRAL_REWARD_KINDS)[number];

export const REFERRAL_STATUSES = ['active', 'blocked'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/** invited / converted / rewardIssued / revenue are aggregates, not counters. */
export const referrals = pgTable(
  'referrals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referrerCustomerId: uuid('referrer_customer_id')
      .notNull()
      .references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
    code: text('code').notNull().unique(),
    rewardKind: text('reward_kind')
      .notNull()
      .default('points')
      .$type<ReferralRewardKind>(),
    rewardValue: integer('reward_value').notNull().default(0),
    status: text('status').notNull().default('active').$type<ReferralStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check(
      'referrals_reward_kind_check',
      sql`reward_kind IN ('points','coupon','store_credit')`,
    ),
    check('referrals_status_check', sql`status IN ('active','blocked')`),
  ],
);

export const REFERRAL_CONVERSION_STATUSES = [
  'invited',
  'signed_up',
  'converted',
  'rewarded',
  'void',
] as const;
export type ReferralConversionStatus = (typeof REFERRAL_CONVERSION_STATUSES)[number];

/**
 * SQL-only: TRIGGER trg_no_self_referral BEFORE INSERT OR UPDATE executes
 * forbid_self_referral(). §7 correction 4 — the original design expressed this
 * as `CHECK (invited_customer_id <> (SELECT referrer_customer_id FROM ...))`,
 * which PostgreSQL rejects. Do not reintroduce it as a check() here.
 */
export const referralConversions = pgTable(
  'referral_conversions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referralId: uuid('referral_id')
      .notNull()
      .references((): AnyPgColumn => referrals.id, { onDelete: 'cascade' }),
    /** DB type: CITEXT. */
    invitedEmail: text('invited_email'),
    invitedCustomerId: uuid('invited_customer_id').references(
      (): AnyPgColumn => customers.id,
      { onDelete: 'set null' },
    ),
    firstOrderId: uuid('first_order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('invited').$type<ReferralConversionStatus>(),
    rewardIssuedPaise: bigint('reward_issued_paise', { mode: 'number' })
      .notNull()
      .default(0),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_referral_invitee')
      .on(t.invitedCustomerId)
      .where(sql`invited_customer_id IS NOT NULL`),
    index('idx_referral_conv').on(t.referralId, t.status),
    check(
      'referral_conversions_status_check',
      sql`status IN ('invited','signed_up','converted','rewarded','void')`,
    ),
  ],
);

/* -------------------------------------------------------------- relations */

export const couponsRelations = relations(coupons, ({ many }) => ({
  scope: many(couponScope),
  redemptions: many(couponRedemptions),
}));

export const couponScopeRelations = relations(couponScope, ({ one }) => ({
  coupon: one(coupons, { fields: [couponScope.couponId], references: [coupons.id] }),
  collection: one(collections, {
    fields: [couponScope.collectionId],
    references: [collections.id],
  }),
  product: one(products, {
    fields: [couponScope.productId],
    references: [products.id],
  }),
}));

export const couponRedemptionsRelations = relations(couponRedemptions, ({ one }) => ({
  coupon: one(coupons, {
    fields: [couponRedemptions.couponId],
    references: [coupons.id],
  }),
  order: one(orders, { fields: [couponRedemptions.orderId], references: [orders.id] }),
  customer: one(customers, {
    fields: [couponRedemptions.customerId],
    references: [customers.id],
  }),
}));

export const bundlesRelations = relations(bundles, ({ many }) => ({
  items: many(bundleItems),
}));

export const bundleItemsRelations = relations(bundleItems, ({ one }) => ({
  bundle: one(bundles, { fields: [bundleItems.bundleId], references: [bundles.id] }),
  variant: one(productVariants, {
    fields: [bundleItems.variantId],
    references: [productVariants.id],
  }),
}));

export const upsellRulesRelations = relations(upsellRules, ({ one }) => ({
  offerAddOn: one(addOns, {
    fields: [upsellRules.offerAddOnId],
    references: [addOns.id],
  }),
  offerVariant: one(productVariants, {
    fields: [upsellRules.offerVariantId],
    references: [productVariants.id],
  }),
}));

export const loyaltyTiersRelations = relations(loyaltyTiers, ({ many }) => ({
  accounts: many(loyaltyAccounts),
}));

export const loyaltyAccountsRelations = relations(loyaltyAccounts, ({ one }) => ({
  customer: one(customers, {
    fields: [loyaltyAccounts.customerId],
    references: [customers.id],
  }),
  tier: one(loyaltyTiers, {
    fields: [loyaltyAccounts.tierId],
    references: [loyaltyTiers.id],
  }),
}));

export const loyaltyTransactionsRelations = relations(loyaltyTransactions, ({ one }) => ({
  customer: one(customers, {
    fields: [loyaltyTransactions.customerId],
    references: [customers.id],
  }),
  order: one(orders, { fields: [loyaltyTransactions.orderId], references: [orders.id] }),
}));

export const referralsRelations = relations(referrals, ({ one, many }) => ({
  referrer: one(customers, {
    fields: [referrals.referrerCustomerId],
    references: [customers.id],
  }),
  conversions: many(referralConversions),
}));

export const referralConversionsRelations = relations(
  referralConversions,
  ({ one }) => ({
    referral: one(referrals, {
      fields: [referralConversions.referralId],
      references: [referrals.id],
    }),
    invitedCustomer: one(customers, {
      fields: [referralConversions.invitedCustomerId],
      references: [customers.id],
    }),
    firstOrder: one(orders, {
      fields: [referralConversions.firstOrderId],
      references: [orders.id],
    }),
  }),
);

/* ------------------------------------------------------------------ types */

export type Coupon = typeof coupons.$inferSelect;
export type NewCoupon = typeof coupons.$inferInsert;
export type CouponScope = typeof couponScope.$inferSelect;
export type NewCouponScope = typeof couponScope.$inferInsert;
export type CouponRedemption = typeof couponRedemptions.$inferSelect;
export type NewCouponRedemption = typeof couponRedemptions.$inferInsert;
export type AutoDiscount = typeof autoDiscounts.$inferSelect;
export type NewAutoDiscount = typeof autoDiscounts.$inferInsert;
export type Bundle = typeof bundles.$inferSelect;
export type NewBundle = typeof bundles.$inferInsert;
export type BundleItem = typeof bundleItems.$inferSelect;
export type NewBundleItem = typeof bundleItems.$inferInsert;
export type UpsellRule = typeof upsellRules.$inferSelect;
export type NewUpsellRule = typeof upsellRules.$inferInsert;
export type LoyaltyTier = typeof loyaltyTiers.$inferSelect;
export type NewLoyaltyTier = typeof loyaltyTiers.$inferInsert;
export type LoyaltyAccount = typeof loyaltyAccounts.$inferSelect;
export type NewLoyaltyAccount = typeof loyaltyAccounts.$inferInsert;
export type LoyaltyTransaction = typeof loyaltyTransactions.$inferSelect;
export type NewLoyaltyTransaction = typeof loyaltyTransactions.$inferInsert;
export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
export type ReferralConversion = typeof referralConversions.$inferSelect;
export type NewReferralConversion = typeof referralConversions.$inferInsert;
