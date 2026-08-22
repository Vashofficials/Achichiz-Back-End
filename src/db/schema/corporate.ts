/**
 * corporate.ts — §2.8
 *
 * B2B gifting: leads → accounts → quotations → campaigns → recipients, plus
 * the polymorphic approval queue.
 *
 * Naming note: `campaign_recipients` here are the employees/clients a corporate
 * campaign ships to. The per-customer saved gift recipients (`recipients`) are
 * a different table and live in customers.ts.
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN nonneg_paise / money_paise / percent_bp / gstin / pan_in / pincode / mobile_in
 *  - §7 correction 2 — corporate_accounts.company_name uses a PARTIAL unique
 *    index (WHERE deleted_at IS NULL). account_no / lead_no / quotation_no /
 *    campaign_no / approval_no stay FULL unique: they are document numbers.
 *  - CONSTRAINT corp_within_credit_limit — the admin mock seeds `outstanding`
 *    independently of `creditLimit`, producing over-limit 'Active' accounts.
 *    The invariant is enforced instead of documented.
 *  - Bill-to/ship-to place of supply for a multi-state campaign is ONE place of
 *    supply (the buyer's principal place of business, s.10(1)(b)), not one per
 *    recipient. Determined on `orders`, not here. Needs CA sign-off (Q4).
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
  date,
  char,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { gstStates } from './tax.js';
import { staffUsers } from './identity.js';
import { customers } from './customers.js';
import { orders } from './orders.js';
import { productVariants, builderTemplates } from './catalogue.js';
import { mediaAssets } from './content.js';
import { importJobs } from './platform.js';

/* ----------------------------------------------------- corporate_accounts */

export const CORPORATE_PAYMENT_TERMS = [
  'advance',
  'net_15',
  'net_30',
  'net_45',
  'net_60',
] as const;
export type CorporatePaymentTerms = (typeof CORPORATE_PAYMENT_TERMS)[number];

export const CORPORATE_ACCOUNT_STATUSES = [
  'active',
  'credit_hold',
  'prospect',
  'closed',
] as const;
export type CorporateAccountStatus = (typeof CORPORATE_ACCOUNT_STATUSES)[number];

export const corporateAccounts = pgTable(
  'corporate_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Document number: FULL unique. */
    accountNo: text('account_no').notNull().unique(),
    /** Partial-unique (§7 correction 2). */
    companyName: text('company_name').notNull(),
    legalName: text('legal_name'),
    gstin: text('gstin'),
    pan: text('pan'),
    billingLine1: text('billing_line1'),
    billingCity: text('billing_city'),
    billingStateCode: char('billing_state_code', { length: 2 }).references(
      (): AnyPgColumn => gstStates.code,
      { onDelete: 'restrict' },
    ),
    billingPincode: text('billing_pincode'),
    accountManagerId: uuid('account_manager_id').references(
      (): AnyPgColumn => staffUsers.id,
      { onDelete: 'set null' },
    ),
    creditLimitPaise: bigint('credit_limit_paise', { mode: 'number' })
      .notNull()
      .default(0),
    outstandingPaise: bigint('outstanding_paise', { mode: 'number' }).notNull().default(0),
    paymentTerms: text('payment_terms')
      .notNull()
      .default('advance')
      .$type<CorporatePaymentTerms>(),
    discountBp: integer('discount_bp').notNull().default(0),
    status: text('status').notNull().default('prospect').$type<CorporateAccountStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_corp_company_name').on(t.companyName).where(sql`deleted_at IS NULL`),
    index('idx_corp_status').on(t.status).where(sql`deleted_at IS NULL`),
    index('idx_corp_manager').on(t.accountManagerId),
    index('idx_corp_search').using(
      'gin',
      sql`(company_name || ' ' || coalesce(gstin,'')) gin_trgm_ops`,
    ),
    check(
      'corporate_accounts_payment_terms_check',
      sql`payment_terms IN ('advance','net_15','net_30','net_45','net_60')`,
    ),
    check(
      'corporate_accounts_status_check',
      sql`status IN ('active','credit_hold','prospect','closed')`,
    ),
    check(
      'corp_within_credit_limit',
      sql`status = 'credit_hold' OR outstanding_paise <= credit_limit_paise`,
    ),
  ],
);

/* -------------------------------------------------------- corporate_leads */

export const LEAD_STAGES = [
  'new',
  'qualified',
  'proposal_sent',
  'negotiation',
  'won',
  'lost',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/**
 * The storefront's corporate form collects only name, company, email, quantity
 * and brief — nine of these fields will be NULL on every web-sourced lead until
 * that form is extended.
 */
export const corporateLeads = pgTable(
  'corporate_leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadNo: text('lead_no').notNull().unique(),
    companyName: text('company_name').notNull(),
    contactName: text('contact_name').notNull(),
    /** DB type: CITEXT. */
    email: text('email').notNull(),
    mobile: text('mobile'),
    city: text('city'),
    stateCode: char('state_code', { length: 2 }).references(
      (): AnyPgColumn => gstStates.code,
      { onDelete: 'restrict' },
    ),
    employeeCount: integer('employee_count'),
    quantityNeeded: integer('quantity_needed'),
    budgetPaise: bigint('budget_paise', { mode: 'number' }),
    occasion: text('occasion'),
    /** The storefront's free-text textarea. */
    brief: text('brief'),
    /** Website form | Referral | LinkedIn | Trade show */
    source: text('source'),
    stage: text('stage').notNull().default('new').$type<LeadStage>(),
    lostReason: text('lost_reason'),
    ownerId: uuid('owner_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    accountId: uuid('account_id').references((): AnyPgColumn => corporateAccounts.id, {
      onDelete: 'set null',
    }),
    nextFollowUpOn: date('next_follow_up_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_leads_stage').on(t.stage, t.createdAt.desc()).where(sql`deleted_at IS NULL`),
    index('idx_leads_owner').on(t.ownerId, t.nextFollowUpOn),
    index('idx_leads_followup')
      .on(t.nextFollowUpOn)
      .where(sql`stage NOT IN ('won','lost') AND deleted_at IS NULL`),
    index('idx_leads_search').using(
      'gin',
      sql`(company_name || ' ' || contact_name || ' ' || email::text) gin_trgm_ops`,
    ),
    check(
      'corporate_leads_stage_check',
      sql`stage IN ('new','qualified','proposal_sent','negotiation','won','lost')`,
    ),
    check(
      'corporate_leads_employee_count_check',
      sql`employee_count IS NULL OR employee_count > 0`,
    ),
    check(
      'corporate_leads_quantity_needed_check',
      sql`quantity_needed IS NULL OR quantity_needed > 0`,
    ),
    check('lead_lost_has_reason', sql`stage <> 'lost' OR lost_reason IS NOT NULL`),
  ],
);

/* ---------------------------------------------- corporate_account_contacts */

export const corporateAccountContacts = pgTable(
  'corporate_account_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references((): AnyPgColumn => corporateAccounts.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    /** DB type: CITEXT. */
    email: text('email').notNull(),
    mobile: text('mobile'),
    designation: text('designation'),
    isPrimary: boolean('is_primary').notNull().default(false),
    canApprove: boolean('can_approve').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Same partial-unique-index pattern as the default address / default variant.
    uniqueIndex('uq_one_primary_contact').on(t.accountId).where(sql`is_primary`),
    index('idx_corp_contacts_account').on(t.accountId),
  ],
);

/* ------------------------------------------------------------- quotations */

export const QUOTATION_STATUSES = [
  'draft',
  'sent',
  'awaiting_approval',
  'approved',
  'rejected',
  'converted',
  'expired',
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

export const quotations = pgTable(
  'quotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'QT/26-27/00001'. Document number: FULL unique. */
    quotationNo: text('quotation_no').notNull().unique(),
    accountId: uuid('account_id').references((): AnyPgColumn => corporateAccounts.id, {
      onDelete: 'set null',
    }),
    leadId: uuid('lead_id').references((): AnyPgColumn => corporateLeads.id, {
      onDelete: 'set null',
    }),
    /** Snapshot — the account may be renamed or the lead deleted. */
    companyName: text('company_name').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    subtotalPaise: bigint('subtotal_paise', { mode: 'number' }).notNull().default(0),
    discountPaise: bigint('discount_paise', { mode: 'number' }).notNull().default(0),
    taxPaise: bigint('tax_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull().default(0),
    marginBp: integer('margin_bp'),
    status: text('status').notNull().default('draft').$type<QuotationStatus>(),
    validTill: date('valid_till'),
    ownerId: uuid('owner_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    convertedOrderId: uuid('converted_order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'set null',
    }),
    pdfMediaId: uuid('pdf_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_quotations_status')
      .on(t.status, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
    index('idx_quotations_account').on(t.accountId),
    index('idx_quotations_owner').on(t.ownerId, t.validTill),
    check(
      'quotations_status_check',
      sql`status IN ('draft','sent','awaiting_approval','approved','rejected','converted','expired')`,
    ),
    check(
      'quotation_lead_or_account',
      sql`account_id IS NOT NULL OR lead_id IS NOT NULL`,
    ),
    check(
      'quotation_converted_has_order',
      sql`status <> 'converted' OR converted_order_id IS NOT NULL`,
    ),
  ],
);

export const quotationLines = pgTable(
  'quotation_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    quotationId: uuid('quotation_id')
      .notNull()
      .references((): AnyPgColumn => quotations.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'set null',
    }),
    builderTemplateId: uuid('builder_template_id').references(
      (): AnyPgColumn => builderTemplates.id,
      { onDelete: 'set null' },
    ),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    unitCostPaise: bigint('unit_cost_paise', { mode: 'number' }),
    discountBp: integer('discount_bp').notNull().default(0),
    gstRateBp: integer('gst_rate_bp').notNull().default(0),
    lineTotalPaise: bigint('line_total_paise', { mode: 'number' }).notNull(),
    /** 'Printed with your logo' */
    brandingNote: text('branding_note'),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('idx_quotation_lines_q').on(t.quotationId, t.position),
    check('quotation_lines_quantity_check', sql`quantity > 0`),
  ],
);

/* ---------------------------------------------------- corporate_campaigns */

export const CAMPAIGN_STATUSES = [
  'planning',
  'recipients_pending',
  'in_dispatch',
  'completed',
  'cancelled',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const corporateCampaigns = pgTable(
  'corporate_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignNo: text('campaign_no').notNull().unique(),
    accountId: uuid('account_id')
      .notNull()
      .references((): AnyPgColumn => corporateAccounts.id, { onDelete: 'restrict' }),
    quotationId: uuid('quotation_id').references((): AnyPgColumn => quotations.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    budgetPaise: bigint('budget_paise', { mode: 'number' }).notNull().default(0),
    windowStartOn: date('window_start_on'),
    windowEndOn: date('window_end_on'),
    status: text('status').notNull().default('planning').$type<CampaignStatus>(),
    ownerId: uuid('owner_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_campaigns_account').on(t.accountId, t.status),
    check(
      'corporate_campaigns_status_check',
      sql`status IN ('planning','recipients_pending','in_dispatch','completed','cancelled')`,
    ),
    check(
      'campaign_window',
      sql`window_end_on IS NULL OR window_start_on IS NULL OR window_end_on >= window_start_on`,
    ),
  ],
);

/* ---------------------------------------------------- campaign_recipients */
/**
 * Real rows, not the mock's three counters (recipients / uploaded / dispatched,
 * where `dispatched` could exceed `uploaded`). The counters become derivable
 * and the invariant automatic.
 */

export const CAMPAIGN_RECIPIENT_STATUSES = [
  'uploaded',
  'validated',
  'invalid',
  'ordered',
  'dispatched',
  'delivered',
  'failed',
] as const;
export type CampaignRecipientStatus = (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references((): AnyPgColumn => corporateCampaigns.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** DB type: CITEXT. */
    email: text('email'),
    mobile: text('mobile'),
    employeeCode: text('employee_code'),
    line1: text('line1'),
    line2: text('line2'),
    city: text('city'),
    stateCode: char('state_code', { length: 2 }).references(
      (): AnyPgColumn => gstStates.code,
      { onDelete: 'restrict' },
    ),
    pincode: text('pincode'),
    variantId: uuid('variant_id').references((): AnyPgColumn => productVariants.id, {
      onDelete: 'set null',
    }),
    giftMessage: text('gift_message'),
    orderId: uuid('order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('uploaded').$type<CampaignRecipientStatus>(),
    validationError: text('validation_error'),
    importJobId: uuid('import_job_id').references((): AnyPgColumn => importJobs.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_campaign_recipients').on(t.campaignId, t.status),
    index('idx_campaign_recip_order').on(t.orderId).where(sql`order_id IS NOT NULL`),
    check(
      'campaign_recipients_status_check',
      sql`status IN ('uploaded','validated','invalid','ordered','dispatched','delivered','failed')`,
    ),
    check(
      'campaign_recipient_invalid_has_error',
      sql`status <> 'invalid' OR validation_error IS NOT NULL`,
    ),
  ],
);

/* -------------------------------------------------------------- approvals */
/** Polymorphic approval queue. `subject_id` is intentionally not an FK. */

export const APPROVAL_KINDS = [
  'quotation_discount',
  'credit_limit',
  'refund',
  'price_change',
  'bulk_cancellation',
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_SUBJECT_TABLES = [
  'quotations',
  'corporate_accounts',
  'refunds',
  'product_variants',
  'orders',
] as const;
export type ApprovalSubjectTable = (typeof APPROVAL_SUBJECT_TABLES)[number];

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    approvalNo: text('approval_no').notNull().unique(),
    kind: text('kind').notNull().$type<ApprovalKind>(),
    subjectTable: text('subject_table').notNull().$type<ApprovalSubjectTable>(),
    /** Polymorphic target id — no FK, guarded by subject_table's CHECK. */
    subjectId: uuid('subject_id').notNull(),
    /** 'QT/26-27/00001' for display. */
    subjectLabel: text('subject_label'),
    /** DOMAIN money_paise — may be negative. */
    amountPaise: bigint('amount_paise', { mode: 'number' }),
    justification: text('justification'),
    status: text('status').notNull().default('pending').$type<ApprovalStatus>(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references((): AnyPgColumn => staffUsers.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    approverId: uuid('approver_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
  },
  (t) => [
    index('idx_approvals_pending').on(t.requestedAt).where(sql`status = 'pending'`),
    index('idx_approvals_subject').on(t.subjectTable, t.subjectId),
    check(
      'approvals_kind_check',
      sql`kind IN ('quotation_discount','credit_limit','refund','price_change','bulk_cancellation')`,
    ),
    check(
      'approvals_subject_table_check',
      sql`subject_table IN ('quotations','corporate_accounts','refunds','product_variants','orders')`,
    ),
    check(
      'approvals_status_check',
      sql`status IN ('pending','approved','rejected','withdrawn')`,
    ),
    check(
      'approval_decided_has_approver',
      sql`status IN ('pending','withdrawn') OR (approver_id IS NOT NULL AND decided_at IS NOT NULL)`,
    ),
    check('approval_not_self_approved', sql`approver_id IS DISTINCT FROM requested_by`),
  ],
);

/* -------------------------------------------------------------- relations */

export const corporateAccountsRelations = relations(
  corporateAccounts,
  ({ one, many }) => ({
    accountManager: one(staffUsers, {
      fields: [corporateAccounts.accountManagerId],
      references: [staffUsers.id],
    }),
    contacts: many(corporateAccountContacts),
    leads: many(corporateLeads),
    quotations: many(quotations),
    campaigns: many(corporateCampaigns),
    orders: many(orders),
    customers: many(customers),
  }),
);

export const corporateLeadsRelations = relations(corporateLeads, ({ one, many }) => ({
  account: one(corporateAccounts, {
    fields: [corporateLeads.accountId],
    references: [corporateAccounts.id],
  }),
  owner: one(staffUsers, {
    fields: [corporateLeads.ownerId],
    references: [staffUsers.id],
  }),
  quotations: many(quotations),
}));

export const corporateAccountContactsRelations = relations(
  corporateAccountContacts,
  ({ one }) => ({
    account: one(corporateAccounts, {
      fields: [corporateAccountContacts.accountId],
      references: [corporateAccounts.id],
    }),
    customer: one(customers, {
      fields: [corporateAccountContacts.customerId],
      references: [customers.id],
    }),
  }),
);

export const quotationsRelations = relations(quotations, ({ one, many }) => ({
  account: one(corporateAccounts, {
    fields: [quotations.accountId],
    references: [corporateAccounts.id],
  }),
  lead: one(corporateLeads, {
    fields: [quotations.leadId],
    references: [corporateLeads.id],
  }),
  convertedOrder: one(orders, {
    fields: [quotations.convertedOrderId],
    references: [orders.id],
  }),
  lines: many(quotationLines),
  campaigns: many(corporateCampaigns),
}));

export const quotationLinesRelations = relations(quotationLines, ({ one }) => ({
  quotation: one(quotations, {
    fields: [quotationLines.quotationId],
    references: [quotations.id],
  }),
  variant: one(productVariants, {
    fields: [quotationLines.variantId],
    references: [productVariants.id],
  }),
}));

export const corporateCampaignsRelations = relations(
  corporateCampaigns,
  ({ one, many }) => ({
    account: one(corporateAccounts, {
      fields: [corporateCampaigns.accountId],
      references: [corporateAccounts.id],
    }),
    quotation: one(quotations, {
      fields: [corporateCampaigns.quotationId],
      references: [quotations.id],
    }),
    recipients: many(campaignRecipients),
  }),
);

export const campaignRecipientsRelations = relations(campaignRecipients, ({ one }) => ({
  campaign: one(corporateCampaigns, {
    fields: [campaignRecipients.campaignId],
    references: [corporateCampaigns.id],
  }),
  order: one(orders, { fields: [campaignRecipients.orderId], references: [orders.id] }),
  variant: one(productVariants, {
    fields: [campaignRecipients.variantId],
    references: [productVariants.id],
  }),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  requester: one(staffUsers, {
    fields: [approvals.requestedBy],
    references: [staffUsers.id],
    relationName: 'approval_requester',
  }),
  approver: one(staffUsers, {
    fields: [approvals.approverId],
    references: [staffUsers.id],
    relationName: 'approval_approver',
  }),
}));

/* ------------------------------------------------------------------ types */

export type CorporateAccount = typeof corporateAccounts.$inferSelect;
export type NewCorporateAccount = typeof corporateAccounts.$inferInsert;
export type CorporateLead = typeof corporateLeads.$inferSelect;
export type NewCorporateLead = typeof corporateLeads.$inferInsert;
export type CorporateAccountContact = typeof corporateAccountContacts.$inferSelect;
export type NewCorporateAccountContact = typeof corporateAccountContacts.$inferInsert;
export type Quotation = typeof quotations.$inferSelect;
export type NewQuotation = typeof quotations.$inferInsert;
export type QuotationLine = typeof quotationLines.$inferSelect;
export type NewQuotationLine = typeof quotationLines.$inferInsert;
export type CorporateCampaign = typeof corporateCampaigns.$inferSelect;
export type NewCorporateCampaign = typeof corporateCampaigns.$inferInsert;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
export type NewCampaignRecipient = typeof campaignRecipients.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
