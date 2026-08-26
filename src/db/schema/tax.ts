/**
 * tax.ts — §2.0 / §2.4 / §3.5
 *
 * GST reference data and the document numbering series.
 *
 * SQL-only objects backing this file (see migrations/0001_initial.sql):
 *  - DOMAIN hsn        — TEXT + regex, used by hsn_codes.code and every hsn_code FK
 *  - DOMAIN percent_bp — INTEGER 0..10000, used by rate_bp / cess_bp
 *  - EXCLUDE USING gist gst_rate_no_overlap — prevents overlapping rate windows
 *    for the same HSN. Drizzle cannot express exclusion constraints.
 *  - FUNCTION next_document_number(doc_type, scope) — gapless, row-locked
 *    counter over document_number_series. Rule 46(b) requires gapless invoice
 *    numbers, so a sequence cannot be used.
 *  - FUNCTION indian_fy(ts) — '26-27' financial-year label
 *  - FUNCTION split_inclusive_tax(gross, rate_bp, interstate)
 */

import { sql } from 'drizzle-orm';
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
  char,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------- gst_states */

export const gstStates = pgTable('gst_states', {
  /** Official 2-digit GST state code, e.g. '27'. */
  code: char('code', { length: 2 }).primaryKey(),
  name: text('name').notNull().unique(),
  isUnionTerr: boolean('is_union_terr').notNull().default(false),
});

/* -------------------------------------------------------------- hsn_codes */

export const hsnCodes = pgTable('hsn_codes', {
  /** DB type: DOMAIN hsn (TEXT, 4/6/8 digits). */
  code: text('code').primaryKey(),
  description: text('description').notNull(),
  /** true => the code is a SAC (service accounting code). */
  isService: boolean('is_service').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------- gst_rates */

export const gstRates = pgTable(
  'gst_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hsnCode: text('hsn_code')
      .notNull()
      .references(() => hsnCodes.code, { onDelete: 'restrict' }),
    /** Basis points: 300 = 3%, 1800 = 18%. DB type: DOMAIN percent_bp. */
    rateBp: integer('rate_bp').notNull(),
    cessBp: integer('cess_bp').notNull().default(0),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    /** For goods whose rate depends on price. DB type: DOMAIN nonneg_paise. */
    priceBandMaxPaise: bigint('price_band_max_paise', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_gst_rates_lookup').on(t.hsnCode, t.effectiveFrom.desc()),
    check(
      'gst_rate_window',
      sql`effective_to IS NULL OR effective_to > effective_from`,
    ),
    // SQL-only: CONSTRAINT gst_rate_no_overlap EXCLUDE USING gist
    //           (hsn_code WITH =, daterange(...) WITH &&)
  ],
);

/* -------------------------------------------------- document_number_series */

export const DOCUMENT_NUMBER_DOC_TYPES = [
  'order',
  'invoice',
  'credit_note',
  'refund',
  'return',
  'exchange',
  'purchase_order',
  'goods_receipt',
  'stock_transfer',
  'quotation',
] as const;
export type DocumentNumberDocType = (typeof DOCUMENT_NUMBER_DOC_TYPES)[number];

export const documentNumberSeries = pgTable(
  'document_number_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    docType: text('doc_type').notNull().$type<DocumentNumberDocType>(),
    /** '' | '26-27' | '26-27:27' (financial year : state). */
    scopeKey: text('scope_key').notNull(),
    /**
     * 'ACH/26-27/' | 'CN/26-27/'.
     * §7 correction 1: the credit-note prefix is 'CN/26-27/' with pad_width 6
     * ('CN/26-27/000001', 15 chars). 'ACHCN/26-27/000001' is 18 and breaches
     * the 16-character cap in Rule 46(b) of the CGST Rules.
     */
    prefix: text('prefix').notNull(),
    suffix: text('suffix').notNull().default(''),
    padWidth: smallint('pad_width').notNull().default(6),
    nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_number_series_doc_type_scope_key_key').on(t.docType, t.scopeKey),
    check(
      'document_number_series_doc_type_check',
      // The SQL migration is authoritative and this list must be kept in step
      // with it. `purchase_return`, `stock_count` and `production` were added by
      // 0003; `campaign` by 0004. Both widenings were missing here until 0004 —
      // harmless, because nothing reads this list at runtime, but it made the
      // schema file lie about what the database accepts.
      sql`doc_type IN ('order','invoice','credit_note','refund','return','exchange','purchase_order','goods_receipt','stock_transfer','quotation','purchase_return','stock_count','production','campaign')`,
    ),
    check('document_number_series_pad_width_check', sql`pad_width BETWEEN 1 AND 12`),
    check('document_number_series_next_value_check', sql`next_value > 0`),
  ],
);

/* ------------------------------------------------------------------ types */

export type GstState = typeof gstStates.$inferSelect;
export type NewGstState = typeof gstStates.$inferInsert;
export type HsnCode = typeof hsnCodes.$inferSelect;
export type NewHsnCode = typeof hsnCodes.$inferInsert;
export type GstRate = typeof gstRates.$inferSelect;
export type NewGstRate = typeof gstRates.$inferInsert;
export type DocumentNumberSeries = typeof documentNumberSeries.$inferSelect;
export type NewDocumentNumberSeries = typeof documentNumberSeries.$inferInsert;
