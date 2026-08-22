/**
 * payments.ts — §2.7
 *
 * Payments (1:N per order — gift card + UPI, COD part-payment, retries), raw
 * gateway webhook receipts, refunds, GST invoices and credit notes with their
 * per-HSN line breakup, and gift cards with their ledger.
 *
 * Two naming notes for anyone looking for a table that is not here:
 *  - "webhook_events" for payment gateways is `payment_events`. Outbound
 *    webhooks the platform SENDS live in platform.ts (webhooks /
 *    webhook_deliveries).
 *  - There is no `settlements` table. Settlement is three columns on
 *    `payments` (is_settled, settled_at, settlement_ref) because a gateway
 *    settles individual captures, not an aggregate the platform owns.
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN nonneg_paise / money_paise / percent_bp / gstin / hsn
 *  - FUNCTION next_document_number('invoice' | 'credit_note', '26-27') —
 *    row-locked, transaction-participating, therefore GAPLESS as Rule 46(b)
 *    requires. Call it as LATE as possible in the transaction and never do
 *    external I/O (IRN, PDF, email) while it holds the series row lock.
 *  - §7 correction 1 — the credit-note series is 'CN/26-27/' + pad_width 6.
 *    'ACHCN/26-27/000001' is 18 chars against the 16-char statutory cap.
 *    CHECK cn_no_max_16 / invoice_no_max_16 enforce the cap in the database.
 *  - Tier 1 throughout: no deleted_at anywhere in this file, and DELETE is
 *    REVOKEd from the application role. "Cancellation" is a status transition.
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
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { gstStates, documentNumberSeries } from './tax.js';
import { staffUsers } from './identity.js';
import { customers } from './customers.js';
import { orders, orderLines, returns } from './orders.js';
import { mediaAssets } from './content.js';

/* ------------------------------------------------------------- gift_cards */

export const GIFT_CARD_STATUSES = ['active', 'redeemed', 'expired', 'void'] as const;
export type GiftCardStatus = (typeof GIFT_CARD_STATUSES)[number];

export const giftCards = pgTable(
  'gift_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Hash, never the plaintext code. */
    codeHash: text('code_hash').notNull().unique(),
    /** For admin display only. */
    codeLast4: char('code_last4', { length: 4 }).notNull(),
    initialValuePaise: bigint('initial_value_paise', { mode: 'number' }).notNull(),
    balancePaise: bigint('balance_paise', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    issuedToName: text('issued_to_name'),
    /** DB type: CITEXT. */
    issuedToEmail: text('issued_to_email'),
    issuedToCustomerId: uuid('issued_to_customer_id').references(
      (): AnyPgColumn => customers.id,
      { onDelete: 'set null' },
    ),
    /** The order this card was BOUGHT on, if it was sold rather than issued. */
    purchaseOrderId: uuid('purchase_order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'set null',
    }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresOn: date('expires_on'),
    status: text('status').notNull().default('active').$type<GiftCardStatus>(),
    createdBy: uuid('created_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_gift_cards_status').on(t.status, t.expiresOn),
    index('idx_gift_cards_customer').on(t.issuedToCustomerId),
    check('gift_cards_initial_value_check', sql`initial_value_paise > 0`),
    check(
      'gift_cards_status_check',
      sql`status IN ('active','redeemed','expired','void')`,
    ),
    check('giftcard_balance_bounds', sql`balance_paise <= initial_value_paise`),
    check(
      'giftcard_redeemed_is_zero',
      sql`status <> 'redeemed' OR balance_paise = 0`,
    ),
  ],
);

/* --------------------------------------------------------------- payments */

export const PAYMENT_GATEWAYS = [
  'razorpay',
  'payu',
  'cashfree',
  'gift_card',
  'cod',
  'manual',
  'bank_transfer',
] as const;
export type PaymentGateway = (typeof PAYMENT_GATEWAYS)[number];

export const PAYMENT_METHODS = [
  'upi',
  'credit_card',
  'debit_card',
  'net_banking',
  'wallet',
  'cod',
  'corporate_credit',
  'gift_card',
  'emi',
  'bank_transfer',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = [
  'created',
  'authorised',
  'captured',
  'failed',
  'cancelled',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    gateway: text('gateway').notNull().$type<PaymentGateway>(),
    method: text('method').notNull().$type<PaymentMethod>(),
    /** 'pay_XXXXXXXX' */
    gatewayPaymentId: text('gateway_payment_id'),
    gatewayOrderId: text('gateway_order_id'),
    gatewaySignature: text('gateway_signature'),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    feePaise: bigint('fee_paise', { mode: 'number' }).notNull().default(0),
    taxOnFeePaise: bigint('tax_on_fee_paise', { mode: 'number' }).notNull().default(0),
    currency: char('currency', { length: 3 }).notNull().default('INR'),
    status: text('status').notNull().default('created').$type<PaymentStatus>(),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    /** Settlement is these three columns; there is no settlements table. */
    isSettled: boolean('is_settled').notNull().default(false),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    settlementRef: text('settlement_ref'),
    authorisedAt: timestamp('authorised_at', { withTimezone: true }),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    /** Prevents double-capture on retry. */
    idempotencyKey: text('idempotency_key').unique(),
    giftCardId: uuid('gift_card_id').references((): AnyPgColumn => giftCards.id, {
      onDelete: 'set null',
    }),
    rawPayload: jsonb('raw_payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_payments_gateway_id')
      .on(t.gateway, t.gatewayPaymentId)
      .where(sql`gateway_payment_id IS NOT NULL`),
    index('idx_payments_order').on(t.orderId, t.createdAt.desc()),
    index('idx_payments_status').on(t.status, t.createdAt.desc()),
    index('idx_payments_settle')
      .on(t.isSettled, t.capturedAt)
      .where(sql`status = 'captured'`),
    index('idx_payments_gateway').on(t.gateway, t.createdAt.desc()),
    check('payments_amount_paise_check', sql`amount_paise > 0`),
    check(
      'payments_gateway_check',
      sql`gateway IN ('razorpay','payu','cashfree','gift_card','cod','manual','bank_transfer')`,
    ),
    check(
      'payments_method_check',
      sql`method IN ('upi','credit_card','debit_card','net_banking','wallet','cod','corporate_credit','gift_card','emi','bank_transfer')`,
    ),
    check(
      'payments_status_check',
      sql`status IN ('created','authorised','captured','failed','cancelled','refunded')`,
    ),
    check(
      'payment_captured_has_time',
      sql`status <> 'captured' OR captured_at IS NOT NULL`,
    ),
    check(
      'payment_failed_has_reason',
      sql`status <> 'failed' OR failure_reason IS NOT NULL`,
    ),
    check(
      'payment_giftcard_link',
      sql`method <> 'gift_card' OR gift_card_id IS NOT NULL`,
    ),
  ],
);

/* --------------------------------------------------------- payment_events */
/**
 * Raw gateway webhook receipts, kept separately so a replay or duplicate never
 * mutates `payments` twice. UNIQUE (gateway, gateway_event_id) is the
 * idempotency boundary.
 */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    gateway: text('gateway').notNull(),
    gatewayEventId: text('gateway_event_id').notNull(),
    eventType: text('event_type').notNull(),
    paymentId: uuid('payment_id').references((): AnyPgColumn => payments.id, {
      onDelete: 'set null',
    }),
    orderId: uuid('order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'set null',
    }),
    signatureValid: boolean('signature_valid').notNull().default(false),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processError: text('process_error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_events_gateway_gateway_event_id_key').on(
      t.gateway,
      t.gatewayEventId,
    ),
    index('idx_payment_events_unprocessed')
      .on(t.receivedAt)
      .where(sql`processed_at IS NULL`),
  ],
);

/* ---------------------------------------------------------------- refunds */

export const REFUND_PAYOUT_MODES = [
  'original',
  'store_credit',
  'bank_transfer',
  'gift_card',
] as const;
export type RefundPayoutMode = (typeof REFUND_PAYOUT_MODES)[number];

export const REFUND_STATUSES = [
  'initiated',
  'processing',
  'completed',
  'failed',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    refundNo: text('refund_no').notNull().unique(),
    paymentId: uuid('payment_id').references((): AnyPgColumn => payments.id, {
      onDelete: 'restrict',
    }),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    returnId: uuid('return_id').references((): AnyPgColumn => returns.id, {
      onDelete: 'set null',
    }),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    mode: text('mode').notNull().default('original').$type<RefundPayoutMode>(),
    gatewayRefundId: text('gateway_refund_id'),
    status: text('status').notNull().default('initiated').$type<RefundStatus>(),
    reason: text('reason').notNull(),
    approvedBy: uuid('approved_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_refunds_order').on(t.orderId),
    index('idx_refunds_payment').on(t.paymentId),
    index('idx_refunds_status').on(t.status, t.initiatedAt.desc()),
    check('refunds_amount_paise_check', sql`amount_paise > 0`),
    check(
      'refunds_mode_check',
      sql`mode IN ('original','store_credit','bank_transfer','gift_card')`,
    ),
    check(
      'refunds_status_check',
      sql`status IN ('initiated','processing','completed','failed')`,
    ),
  ],
);

/* --------------------------------------------------------------- invoices */

export const INVOICE_STATUSES = ['issued', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'ACH/26-27/000001' — exactly 16 chars, at the Rule 46(b) limit. */
    invoiceNo: text('invoice_no').notNull().unique(),
    seriesId: uuid('series_id')
      .notNull()
      .references((): AnyPgColumn => documentNumberSeries.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    supplierGstin: text('supplier_gstin'),
    supplierStateCode: char('supplier_state_code', { length: 2 })
      .notNull()
      .references((): AnyPgColumn => gstStates.code, { onDelete: 'restrict' }),
    buyerName: text('buyer_name').notNull(),
    /** NULL means "this buyer has no GSTIN" — never the mock's '—' sentinel. */
    buyerGstin: text('buyer_gstin'),
    buyerAddress: text('buyer_address').notNull(),
    placeOfSupplyStateCode: char('place_of_supply_state_code', { length: 2 })
      .notNull()
      .references((): AnyPgColumn => gstStates.code, { onDelete: 'restrict' }),
    isReverseCharge: boolean('is_reverse_charge').notNull().default(false),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    cessPaise: bigint('cess_paise', { mode: 'number' }).notNull().default(0),
    roundOffPaise: bigint('round_off_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
    /** e-invoice IRN; obtained AFTER commit, never inside the numbering txn. */
    irn: text('irn').unique(),
    irnAckNo: text('irn_ack_no'),
    irnAckDate: timestamp('irn_ack_date', { withTimezone: true }),
    qrPayload: text('qr_payload'),
    ewayBillNo: text('eway_bill_no'),
    pdfMediaId: uuid('pdf_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    /** '26-27' */
    financialYear: text('financial_year').notNull(),
    status: text('status').notNull().default('issued').$type<InvoiceStatus>(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_invoice_per_order').on(t.orderId).where(sql`status = 'issued'`),
    index('idx_invoices_issued').on(t.issuedAt.desc()),
    index('idx_invoices_fy').on(t.financialYear, t.invoiceNo),
    index('idx_invoices_gstin').on(t.buyerGstin).where(sql`buyer_gstin IS NOT NULL`),
    check('invoices_financial_year_check', sql`financial_year ~ '^[0-9]{2}-[0-9]{2}$'`),
    check('invoices_status_check', sql`status IN ('issued','cancelled')`),
    check(
      'invoice_tax_split',
      sql`(igst_paise = 0) OR (cgst_paise = 0 AND sgst_paise = 0)`,
    ),
    check('invoice_cgst_equals_sgst', sql`cgst_paise = sgst_paise`),
    check(
      'invoice_total_balances',
      sql`total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise + cess_paise + round_off_paise`,
    ),
    check(
      'invoice_cancel_reason',
      sql`status <> 'cancelled' OR cancel_reason IS NOT NULL`,
    ),
    // §7 correction 1 — Rule 46(b) 16-character cap.
    check('invoice_no_max_16', sql`length(invoice_no) <= 16`),
  ],
);

/** Per-HSN breakup is what GSTR-1 needs; an order-level total is not enough. */
export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references((): AnyPgColumn => invoices.id, { onDelete: 'cascade' }),
    orderLineId: uuid('order_line_id').references((): AnyPgColumn => orderLines.id, {
      onDelete: 'set null',
    }),
    description: text('description').notNull(),
    /** DB type: DOMAIN hsn. Indexed — GSTR-1 requires an HSN-wise summary. */
    hsnCode: text('hsn_code').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
    unit: text('unit').notNull().default('PCS'),
    unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
    discountPaise: bigint('discount_paise', { mode: 'number' }).notNull().default(0),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
    gstRateBp: integer('gst_rate_bp').notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    cessPaise: bigint('cess_paise', { mode: 'number' }).notNull().default(0),
    lineTotalPaise: bigint('line_total_paise', { mode: 'number' }).notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('idx_invoice_lines_invoice').on(t.invoiceId, t.position),
    index('idx_invoice_lines_hsn').on(t.hsnCode),
    check('invoice_lines_quantity_check', sql`quantity > 0`),
  ],
);

/* ----------------------------------------------------------- credit_notes */
/**
 * A separate table, not `invoices.type = 'Credit Note'`. Credit notes have
 * their own statutory numbering series, must reference the original invoice,
 * and appear in a different GSTR-1 table.
 */

export const CREDIT_NOTE_REASONS = [
  'sales_return',
  'post_sale_discount',
  'deficiency_in_service',
  'correction_in_invoice',
  'order_cancelled',
  'other',
] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];

export const creditNotes = pgTable(
  'credit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** §7 correction 1 — 'CN/26-27/000001', 15 chars. NOT 'ACHCN/...'. */
    creditNoteNo: text('credit_note_no').notNull().unique(),
    seriesId: uuid('series_id')
      .notNull()
      .references((): AnyPgColumn => documentNumberSeries.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references((): AnyPgColumn => invoices.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    returnId: uuid('return_id').references((): AnyPgColumn => returns.id, {
      onDelete: 'set null',
    }),
    reason: text('reason').notNull().$type<CreditNoteReason>(),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    cessPaise: bigint('cess_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
    irn: text('irn').unique(),
    financialYear: text('financial_year').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    issuedBy: uuid('issued_by').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    pdfMediaId: uuid('pdf_media_id').references((): AnyPgColumn => mediaAssets.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_credit_notes_invoice').on(t.invoiceId),
    index('idx_credit_notes_fy').on(t.financialYear, t.creditNoteNo),
    check(
      'credit_notes_reason_check',
      sql`reason IN ('sales_return','post_sale_discount','deficiency_in_service','correction_in_invoice','order_cancelled','other')`,
    ),
    check(
      'credit_notes_financial_year_check',
      sql`financial_year ~ '^[0-9]{2}-[0-9]{2}$'`,
    ),
    check('cn_tax_split', sql`(igst_paise = 0) OR (cgst_paise = 0 AND sgst_paise = 0)`),
    check('cn_cgst_equals_sgst', sql`cgst_paise = sgst_paise`),
    // §7 correction 1 — Rule 46(b) 16-character cap.
    check('cn_no_max_16', sql`length(credit_note_no) <= 16`),
  ],
);

export const creditNoteLines = pgTable(
  'credit_note_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creditNoteId: uuid('credit_note_id')
      .notNull()
      .references((): AnyPgColumn => creditNotes.id, { onDelete: 'cascade' }),
    invoiceLineId: uuid('invoice_line_id').references(
      (): AnyPgColumn => invoiceLines.id,
      { onDelete: 'set null' },
    ),
    description: text('description').notNull(),
    hsnCode: text('hsn_code').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
    taxablePaise: bigint('taxable_paise', { mode: 'number' }).notNull(),
    gstRateBp: integer('gst_rate_bp').notNull(),
    cgstPaise: bigint('cgst_paise', { mode: 'number' }).notNull().default(0),
    sgstPaise: bigint('sgst_paise', { mode: 'number' }).notNull().default(0),
    igstPaise: bigint('igst_paise', { mode: 'number' }).notNull().default(0),
    cessPaise: bigint('cess_paise', { mode: 'number' }).notNull().default(0),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('idx_cn_lines_cn').on(t.creditNoteId, t.position),
    check('credit_note_lines_quantity_check', sql`quantity > 0`),
  ],
);

/* ------------------------------------------------- gift_card_transactions */
/** Ledger, so the balance is reconstructible and double-spend is visible. */

export const GIFT_CARD_TXN_KINDS = [
  'issue',
  'redeem',
  'refund',
  'adjustment',
  'expiry',
] as const;
export type GiftCardTxnKind = (typeof GIFT_CARD_TXN_KINDS)[number];

export const giftCardTransactions = pgTable(
  'gift_card_transactions',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    giftCardId: uuid('gift_card_id')
      .notNull()
      .references((): AnyPgColumn => giftCards.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'set null',
    }),
    paymentId: uuid('payment_id').references((): AnyPgColumn => payments.id, {
      onDelete: 'set null',
    }),
    /** DOMAIN money_paise — negative on redemption. */
    deltaPaise: bigint('delta_paise', { mode: 'number' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    kind: text('kind').notNull().$type<GiftCardTxnKind>(),
    note: text('note'),
    actorId: uuid('actor_id').references((): AnyPgColumn => staffUsers.id, {
      onDelete: 'set null',
    }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_gc_txn_card').on(t.giftCardId, t.occurredAt.desc()),
    uniqueIndex('uq_gc_redeem_once_per_payment')
      .on(t.paymentId)
      .where(sql`payment_id IS NOT NULL AND kind = 'redeem'`),
    check('gift_card_transactions_delta_check', sql`delta_paise <> 0`),
    check(
      'gift_card_transactions_kind_check',
      sql`kind IN ('issue','redeem','refund','adjustment','expiry')`,
    ),
  ],
);

/* -------------------------------------------------------------- relations */

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
  giftCard: one(giftCards, {
    fields: [payments.giftCardId],
    references: [giftCards.id],
  }),
  events: many(paymentEvents),
  refunds: many(refunds),
}));

export const paymentEventsRelations = relations(paymentEvents, ({ one }) => ({
  payment: one(payments, {
    fields: [paymentEvents.paymentId],
    references: [payments.id],
  }),
  order: one(orders, { fields: [paymentEvents.orderId], references: [orders.id] }),
}));

export const refundsRelations = relations(refunds, ({ one }) => ({
  payment: one(payments, { fields: [refunds.paymentId], references: [payments.id] }),
  order: one(orders, { fields: [refunds.orderId], references: [orders.id] }),
  return: one(returns, { fields: [refunds.returnId], references: [returns.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  order: one(orders, { fields: [invoices.orderId], references: [orders.id] }),
  series: one(documentNumberSeries, {
    fields: [invoices.seriesId],
    references: [documentNumberSeries.id],
  }),
  lines: many(invoiceLines),
  creditNotes: many(creditNotes),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
  orderLine: one(orderLines, {
    fields: [invoiceLines.orderLineId],
    references: [orderLines.id],
  }),
}));

export const creditNotesRelations = relations(creditNotes, ({ one, many }) => ({
  invoice: one(invoices, { fields: [creditNotes.invoiceId], references: [invoices.id] }),
  order: one(orders, { fields: [creditNotes.orderId], references: [orders.id] }),
  lines: many(creditNoteLines),
}));

export const creditNoteLinesRelations = relations(creditNoteLines, ({ one }) => ({
  creditNote: one(creditNotes, {
    fields: [creditNoteLines.creditNoteId],
    references: [creditNotes.id],
  }),
  invoiceLine: one(invoiceLines, {
    fields: [creditNoteLines.invoiceLineId],
    references: [invoiceLines.id],
  }),
}));

export const giftCardsRelations = relations(giftCards, ({ one, many }) => ({
  customer: one(customers, {
    fields: [giftCards.issuedToCustomerId],
    references: [customers.id],
  }),
  transactions: many(giftCardTransactions),
}));

export const giftCardTransactionsRelations = relations(
  giftCardTransactions,
  ({ one }) => ({
    giftCard: one(giftCards, {
      fields: [giftCardTransactions.giftCardId],
      references: [giftCards.id],
    }),
    payment: one(payments, {
      fields: [giftCardTransactions.paymentId],
      references: [payments.id],
    }),
  }),
);

/* ------------------------------------------------------------------ types */

export type GiftCard = typeof giftCards.$inferSelect;
export type NewGiftCard = typeof giftCards.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type NewPaymentEvent = typeof paymentEvents.$inferInsert;
export type Refund = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type NewInvoiceLine = typeof invoiceLines.$inferInsert;
export type CreditNote = typeof creditNotes.$inferSelect;
export type NewCreditNote = typeof creditNotes.$inferInsert;
export type CreditNoteLine = typeof creditNoteLines.$inferSelect;
export type NewCreditNoteLine = typeof creditNoteLines.$inferInsert;
export type GiftCardTransaction = typeof giftCardTransactions.$inferSelect;
export type NewGiftCardTransaction = typeof giftCardTransactions.$inferInsert;
