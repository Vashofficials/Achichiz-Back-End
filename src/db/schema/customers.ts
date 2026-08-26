/**
 * customers.ts — §2.2 (+ customer_sessions from §2.12)
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN mobile_in / pincode / gstin / nonneg_paise
 *  - CITEXT on customers.email — declared text() here
 *  - TRIGGER trg_ensure_default_address (AFTER INSERT/UPDATE/DELETE on addresses)
 *    enforces "at least one default address"; the partial unique index
 *    uq_one_default_address_per_customer enforces "at most one".
 *    WRITE-ORDER GOTCHA: clear the old default BEFORE setting the new one, in
 *    the same transaction — a partial unique index cannot be deferred.
 *  - §7 correction 2: customers.email / customers.mobile / auth_provider_uid use
 *    PARTIAL unique indexes (WHERE deleted_at IS NULL).
 *  - §7 correction 3: email_verified_at + mobile_verified_at added.
 *  - §7 correction 5: legacy_ref TEXT added for import traceability; drop it
 *    after cutover.
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
  inet,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { gstStates } from './tax.js';
import { corporateAccounts } from './corporate.js';
import { products } from './catalogue.js';
import { orders } from './orders.js';

/* -------------------------------------------------------------- customers */

export const CUSTOMER_GENDERS = ['female', 'male', 'other', 'undisclosed'] as const;
export type CustomerGender = (typeof CUSTOMER_GENDERS)[number];

export const CUSTOMER_SEGMENTS = [
  'vip',
  'loyal',
  'new',
  'at_risk',
  'corporate_buyer',
] as const;
export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** DB type: CITEXT. Partial-unique (§7 correction 2). */
    email: text('email'),
    /** DB type: DOMAIN mobile_in. Partial-unique. */
    mobile: text('mobile'),
    fullName: text('full_name'),
    birthday: date('birthday'),
    gender: text('gender').$type<CustomerGender>(),
    passwordHash: text('password_hash'),
    /** Supabase auth.users.id, if that path is kept (§5.2). Partial-unique. */
    authProviderUid: uuid('auth_provider_uid'),
    /**
     * Firebase Auth UID — added by 0005. TEXT, not uuid: a Firebase UID is a
     * ~28-character base62 string like `k2Jd8fLpQ4Xb9RtY7mNc3VwZ1aBs`, so it
     * cannot share `auth_provider_uid` (UUID, sized for Supabase). An account
     * migrated from Supabase and later linked to Firebase carries both.
     * Partial-unique among live rows.
     */
    firebaseUid: text('firebase_uid'),
    /** §7 correction 3 — carries auth.users.email_confirmed_at. */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** §7 correction 3 — OTP login. */
    mobileVerifiedAt: timestamp('mobile_verified_at', { withTimezone: true }),
    marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
    whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(false),
    segment: text('segment').$type<CustomerSegment>(),
    corporateAccountId: uuid('corporate_account_id').references(
      (): AnyPgColumn => corporateAccounts.id,
      { onDelete: 'set null' },
    ),
    /** DB type: DOMAIN gstin. */
    defaultBillingGstin: text('default_billing_gstin'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    acceptsCod: boolean('accepts_cod').notNull().default(true),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    blockedReason: text('blocked_reason'),
    firstOrderAt: timestamp('first_order_at', { withTimezone: true }),
    lastOrderAt: timestamp('last_order_at', { withTimezone: true }),
    /** §7 correction 5 — import traceability; drop after cutover. */
    legacyRef: text('legacy_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_customers_email').on(t.email).where(sql`deleted_at IS NULL`),
    uniqueIndex('uq_customers_mobile').on(t.mobile).where(sql`deleted_at IS NULL`),
    uniqueIndex('uq_customers_auth_uid')
      .on(t.authProviderUid)
      .where(sql`auth_provider_uid IS NOT NULL AND deleted_at IS NULL`),
    // 0005. Partial like its siblings: a soft-deleted customer must not burn a
    // Firebase UID forever — the same person signing up again gets the same UID
    // back from Google, and a full unique index would refuse them.
    uniqueIndex('uq_customers_firebase_uid')
      .on(t.firebaseUid)
      .where(sql`firebase_uid IS NOT NULL AND deleted_at IS NULL`),
    index('idx_customers_segment').on(t.segment).where(sql`deleted_at IS NULL`),
    index('idx_customers_last_order').on(sql`last_order_at DESC NULLS LAST`),
    index('idx_customers_corporate')
      .on(t.corporateAccountId)
      .where(sql`corporate_account_id IS NOT NULL`),
    index('idx_customers_tags').using('gin', t.tags),
    index('idx_customers_search_trgm').using(
      'gin',
      sql`(coalesce(full_name,'') || ' ' || coalesce(email::text,'') || ' ' || coalesce(mobile,'')) gin_trgm_ops`,
    ),
    index('idx_customers_legacy_ref').on(t.legacyRef).where(sql`legacy_ref IS NOT NULL`),
    check('customers_gender_check', sql`gender IN ('female','male','other','undisclosed')`),
    check(
      'customers_segment_check',
      sql`segment IN ('vip','loyal','new','at_risk','corporate_buyer')`,
    ),
    check('customer_needs_a_handle', sql`email IS NOT NULL OR mobile IS NOT NULL`),
    // Google documents a UID only as "a string up to 128 characters"; 28 is
    // merely what it emits today. The bound is the documented one, not the
    // observed one.
    check(
      'customers_firebase_uid_check',
      sql`firebase_uid IS NULL OR (length(firebase_uid) BETWEEN 8 AND 128)`,
    ),
  ],
);

/* -------------------------------------------------- customer_auth_events */
/**
 * Append-only record of how each customer authenticated — added by 0005.
 *
 * `otp_challenges` cannot serve this. Its columns describe a challenge WE
 * issued (`code_hash`, `attempts`, `expires_at`), and for a Firebase login
 * every one of them would be NULL or a fabrication — Google holds the
 * challenge and we never see the code. Writing a row claiming we hashed a code
 * we never issued would corrupt the one table meant to be evidence.
 *
 * There is deliberately no update path and no `deleted_at`: an audit trail that
 * can be edited is not one.
 */
export const AUTH_EVENT_PROVIDERS = [
  'firebase_phone',
  'firebase_google',
  'password',
  'otp_msg91',
] as const;
export type AuthEventProvider = (typeof AUTH_EVENT_PROVIDERS)[number];

export const AUTH_EVENT_OUTCOMES = ['signed_in', 'linked', 'created', 'rejected'] as const;
export type AuthEventOutcome = (typeof AUTH_EVENT_OUTCOMES)[number];

export const customerAuthEvents = pgTable(
  'customer_auth_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Null for a rejection that never resolved to an account. */
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull().$type<AuthEventProvider>(),
    /**
     * `linked` is the row anyone actually reads this table for: an existing
     * customer gained a new credential, which is where an account takeover
     * would appear.
     */
    outcome: text('outcome').notNull().$type<AuthEventOutcome>(),
    firebaseUid: text('firebase_uid'),
    mobile: text('mobile'),
    email: text('email'),
    /** Non-null exactly when `outcome = 'rejected'` — a refusal always has a reason. */
    reason: text('reason'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_auth_events_customer').on(t.customerId, t.occurredAt.desc()),
    index('idx_auth_events_uid').on(t.firebaseUid).where(sql`firebase_uid IS NOT NULL`),
    // Partial so it stays small beside the mass of ordinary sign-ins.
    index('idx_auth_events_notable')
      .on(t.occurredAt.desc())
      .where(sql`outcome IN ('linked','rejected')`),
    check(
      'customer_auth_events_provider_check',
      sql`provider IN ('firebase_phone','firebase_google','password','otp_msg91')`,
    ),
    check(
      'customer_auth_events_outcome_check',
      sql`outcome IN ('signed_in','linked','created','rejected')`,
    ),
    check('auth_event_reason_required', sql`(outcome = 'rejected') = (reason IS NOT NULL)`),
  ],
);

export type CustomerAuthEvent = typeof customerAuthEvents.$inferSelect;
export type NewCustomerAuthEvent = typeof customerAuthEvents.$inferInsert;

/* --------------------------------------------------------- customer_stats */
/** 1:1 satellite. Refreshed by job so order writes never touch `customers`. */
export const customerStats = pgTable('customer_stats', {
  customerId: uuid('customer_id')
    .primaryKey()
    .references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
  orderCount: integer('order_count').notNull().default(0),
  lifetimeSpendPaise: bigint('lifetime_spend_paise', { mode: 'number' }).notNull().default(0),
  aovPaise: bigint('aov_paise', { mode: 'number' }).notNull().default(0),
  returnCount: integer('return_count').notNull().default(0),
  loyaltyPoints: integer('loyalty_points').notNull().default(0),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------- addresses */

export const addresses = pgTable(
  'addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
    /** Home | Office | Parents | Farmhouse */
    label: text('label').notNull().default('Home'),
    contactName: text('contact_name').notNull(),
    /** DB type: DOMAIN mobile_in. */
    mobile: text('mobile').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    area: text('area'),
    city: text('city').notNull(),
    stateCode: char('state_code', { length: 2 })
      .notNull()
      .references((): AnyPgColumn => gstStates.code, { onDelete: 'restrict' }),
    /** DB type: DOMAIN pincode. */
    pincode: text('pincode').notNull(),
    countryCode: char('country_code', { length: 2 }).notNull().default('IN'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // §4.3 — exactly one default per customer, enforced by the database.
    uniqueIndex('uq_one_default_address_per_customer')
      .on(t.customerId)
      .where(sql`is_default AND deleted_at IS NULL`),
    index('idx_addresses_customer').on(t.customerId).where(sql`deleted_at IS NULL`),
    index('idx_addresses_pincode').on(t.pincode),
  ],
);

/* ------------------------------------------------------------- recipients */
/** Gift recipients with reminder dates (admin's saved-recipients screen). */
export const recipients = pgTable(
  'recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Spouse | Mother | Client | ... */
    relation: text('relation'),
    mobile: text('mobile'),
    addressId: uuid('address_id').references((): AnyPgColumn => addresses.id, {
      onDelete: 'set null',
    }),
    occasion: text('occasion'),
    nextDate: date('next_date'),
    reminderOn: boolean('reminder_on').notNull().default(true),
    giftsSent: integer('gifts_sent').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_recipients_customer').on(t.customerId).where(sql`deleted_at IS NULL`),
    index('idx_recipients_reminder')
      .on(t.nextDate)
      .where(sql`reminder_on AND deleted_at IS NULL`),
  ],
);

/* ------------------------------------------------------- customer_segments */

export const SEGMENT_STATUSES = ['active', 'draft', 'archived'] as const;
export type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

export const customerSegments = pgTable(
  'customer_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    /** Executable rule DSL (§1.4). */
    rule: jsonb('rule').notNull(),
    /** 'lifetime_spend > 200000' — human display only. */
    ruleText: text('rule_text'),
    isDynamic: boolean('is_dynamic').notNull().default(true),
    status: text('status').notNull().default('draft').$type<SegmentStatus>(),
    memberCount: integer('member_count').notNull().default(0),
    revenuePaise: bigint('revenue_paise', { mode: 'number' }).notNull().default(0),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('customer_segments_status_check', sql`status IN ('active','draft','archived')`),
  ],
);

export const customerSegmentMembers = pgTable(
  'customer_segment_members',
  {
    segmentId: uuid('segment_id')
      .notNull()
      .references((): AnyPgColumn => customerSegments.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.customerId] }),
    index('idx_segment_members_customer').on(t.customerId),
  ],
);

/* --------------------------------------------------------- wishlist_items */

export const wishlistItems = pgTable(
  'wishlist_items',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.productId] })],
);

/* ------------------------------------------------------ customer_sessions */
/** Separate from staff_sessions: different lifetime, revocation, blast radius. */
export const customerSessions = pgTable(
  'customer_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references((): AnyPgColumn => customers.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    deviceLabel: text('device_label'),
    ip: inet('ip'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_customer_sessions').on(t.customerId).where(sql`revoked_at IS NULL`),
    index('idx_customer_sessions_exp').on(t.expiresAt).where(sql`revoked_at IS NULL`),
  ],
);

/* -------------------------------------------------------------- relations */

export const customersRelations = relations(customers, ({ one, many }) => ({
  corporateAccount: one(corporateAccounts, {
    fields: [customers.corporateAccountId],
    references: [corporateAccounts.id],
  }),
  stats: one(customerStats, {
    fields: [customers.id],
    references: [customerStats.customerId],
  }),
  addresses: many(addresses),
  recipients: many(recipients),
  orders: many(orders),
  sessions: many(customerSessions),
  wishlist: many(wishlistItems),
  segmentMemberships: many(customerSegmentMembers),
}));

export const addressesRelations = relations(addresses, ({ one, many }) => ({
  customer: one(customers, {
    fields: [addresses.customerId],
    references: [customers.id],
  }),
  state: one(gstStates, {
    fields: [addresses.stateCode],
    references: [gstStates.code],
  }),
  recipients: many(recipients),
}));

export const recipientsRelations = relations(recipients, ({ one }) => ({
  customer: one(customers, {
    fields: [recipients.customerId],
    references: [customers.id],
  }),
  address: one(addresses, {
    fields: [recipients.addressId],
    references: [addresses.id],
  }),
}));

export const customerStatsRelations = relations(customerStats, ({ one }) => ({
  customer: one(customers, {
    fields: [customerStats.customerId],
    references: [customers.id],
  }),
}));

export const customerSessionsRelations = relations(customerSessions, ({ one }) => ({
  customer: one(customers, {
    fields: [customerSessions.customerId],
    references: [customers.id],
  }),
}));

export const wishlistItemsRelations = relations(wishlistItems, ({ one }) => ({
  customer: one(customers, {
    fields: [wishlistItems.customerId],
    references: [customers.id],
  }),
  product: one(products, {
    fields: [wishlistItems.productId],
    references: [products.id],
  }),
}));

export const customerSegmentsRelations = relations(customerSegments, ({ many }) => ({
  members: many(customerSegmentMembers),
}));

export const customerSegmentMembersRelations = relations(
  customerSegmentMembers,
  ({ one }) => ({
    segment: one(customerSegments, {
      fields: [customerSegmentMembers.segmentId],
      references: [customerSegments.id],
    }),
    customer: one(customers, {
      fields: [customerSegmentMembers.customerId],
      references: [customers.id],
    }),
  }),
);

/* ------------------------------------------------------------------ types */

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type CustomerStat = typeof customerStats.$inferSelect;
export type NewCustomerStat = typeof customerStats.$inferInsert;
export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
export type Recipient = typeof recipients.$inferSelect;
export type NewRecipient = typeof recipients.$inferInsert;
export type CustomerSegmentRow = typeof customerSegments.$inferSelect;
export type NewCustomerSegmentRow = typeof customerSegments.$inferInsert;
export type CustomerSegmentMember = typeof customerSegmentMembers.$inferSelect;
export type NewCustomerSegmentMember = typeof customerSegmentMembers.$inferInsert;
export type WishlistItem = typeof wishlistItems.$inferSelect;
export type NewWishlistItem = typeof wishlistItems.$inferInsert;
export type CustomerSession = typeof customerSessions.$inferSelect;
export type NewCustomerSession = typeof customerSessions.$inferInsert;
