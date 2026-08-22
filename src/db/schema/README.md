# Achichiz — database schema

118 tables, translated from the production DDL design (`03_schema.md` §2) into
Drizzle ORM table definitions.

**The authoritative artifact is `../migrations/0001_initial.sql`.** The TypeScript
files in this directory describe tables, columns, foreign keys, indexes and CHECK
constraints. They do **not** describe domains, functions, triggers, exclusion
constraints or privilege grants — roughly a fifth of the integrity model. Any
statement of the form "the schema guarantees X" must be checked against the SQL
file, not against these files. Every table whose behaviour depends on an
unmodelled object carries a `// SQL-only:` comment pointing at it.

## Conventions

| Concern | Rule |
|---|---|
| Identifiers | DB is `snake_case` plural; TS properties are `camelCase`. The mapping is explicit in every column and this is the only translation point in the codebase. |
| Money | `bigint('..._paise', { mode: 'number' })` — integer paise. Never `numeric`, never float. Safe-integer ceiling is ≈₹90 trillion. |
| Percentages | Integer basis points (`percent_bp`): 300 = 3%, 1800 = 18%, 250 = 2.5%. |
| Entity PKs | `uuid('id').primaryKey().defaultRandom()`. |
| Ledger PKs | `bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity()` on the nine append-only tables. Opaque, never summed, so `mode: 'bigint'` is fine. |
| Timestamps | `timestamp(name, { withTimezone: true })`. Genuine dates (delivery date, expiry) are `date()`. |
| Audit | `created_at` + `updated_at` on every table unless the DDL says otherwise; `deleted_at` only on Tier 2 (soft-deletable) tables. |
| Foreign keys | `ON DELETE` is explicit on every FK, matching the DDL exactly. |
| Enums | **Zero `pgEnum`.** See below. |
| Imports | Relative imports carry `.js` extensions (`NodeNext` module resolution). |

### Statuses: `text()` + CHECK + exported const union — no `pgEnum` anywhere

The DDL declares **no** native `CREATE TYPE ... AS ENUM`; §2 states the
convention explicitly ("Status/enum-like columns are `TEXT` + `CHECK`, never
native `ENUM`"). Every one of the ~70 status/kind/type columns is therefore
`text()` with a `check()` reproducing the DDL's `IN (...)` list, plus an exported
`as const` array and a derived union type:

```ts
export const ORDER_STATUSES = ['pending_payment', 'paid', /* ... */] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
// column: text('status').notNull().default('pending_payment').$type<OrderStatus>()
```

Services import the array for validation and the type for narrowing. Adding a
value is an `ALTER TABLE ... DROP/ADD CONSTRAINT` in a new migration plus one
line in the array — no `ALTER TYPE`, no exclusive lock on a rewrite.

### Cross-file references

The twelve context files are mutually recursive (customers ↔ corporate,
catalogue ↔ content, orders ↔ inventory, …). Every `references()` callback is
annotated `(): AnyPgColumn =>` so TypeScript never has to infer a type through a
cycle, and Drizzle resolves the reference lazily at migration/query time.

---

## Table inventory by context

### `tax.ts` — 4 tables
| Table | Purpose |
|---|---|
| `gst_states` | Official 2-digit state codes; place-of-supply is an FK to this, not free text. |
| `hsn_codes` | HSN/SAC classification codes referenced by products, hamper items, add-ons. |
| `gst_rates` | Historised rate per HSN with `effective_from`/`effective_to`, so a reissued invoice reproduces the rate that applied on its supply date. |
| `document_number_series` | Row-locked counters for gapless invoice/credit-note/PO numbering. |

### `identity.ts` — 7 tables
| Table | Purpose |
|---|---|
| `roles` | The 11 admin roles; roles are data, not a string-literal union. |
| `role_permissions` | 12 modules × 9 actions as rows, so the matrix is queryable and auditable. |
| `staff_users` | Admin accounts, MFA, lockout state. |
| `staff_user_warehouses` | Warehouse scoping; zero rows = all warehouses. |
| `staff_sessions` | Refresh-token sessions (hash only) with device/IP/location. |
| `api_keys` | Hashed API keys with scopes and revocation. |
| `otp_challenges` | Shared SMS/email/WhatsApp OTP challenges for login, signup, verification. |

### `customers.ts` — 8 tables
| Table | Purpose |
|---|---|
| `customers` | Storefront accounts; email/mobile/OAuth uid, consent flags, segment, corporate link. |
| `customer_stats` | 1:1 lifetime-aggregate satellite, refreshed by job so order writes never touch the hot read row. |
| `addresses` | Saved addresses with a `state_code` FK (place of supply depends on it). |
| `recipients` | Saved gift recipients with occasion reminder dates. |
| `customer_segments` | Named segments with a JSONB rule DSL plus the original display string. |
| `customer_segment_members` | Materialised segment membership. |
| `wishlist_items` | Customer × product, keyed by id (not handle). |
| `customer_sessions` | Storefront sessions — separate lifetime and revocation policy from staff. |

### `catalogue.ts` — 18 tables
| Table | Purpose |
|---|---|
| `designers` | Brands / designers / celebrities / artisan clusters with commission bp. |
| `collections` | The single taxonomy table, discriminated by `kind` (category, recipient, occasion, festival, designer, edit), self-parenting. |
| `products` | Catalogue root: handle, fulfilment `kind`, HSN, flags, publish state. |
| `product_variants` | The stock-bearing unit. SKU, price (GST-inclusive), cost, dimensions. |
| `product_collections` | M:N taxonomy join; carries manual merchandising order. |
| `product_media` | Ordered images/video per product, optionally per variant. |
| `product_content_items` | The authored "what's inside" bullets. |
| `product_stats` | Ratings/units-sold read model, refreshed by job; safe to rebuild. |
| `hamper_items` | Raw components that go into hampers — stock items, not sellable products. |
| `product_bom_lines` | Bill of materials for a hamper variant. |
| `add_ons` | Gift wrap, cards, engraving — priced, taxed, HSN-bearing supplies. |
| `product_add_ons` | Which add-ons a product offers, with optional price override. |
| `personalisation_templates` | Engraving/embroidery/print methods, turnaround, proof policy. |
| `product_personalisation_templates` | Product × template join. |
| `builder_templates` | Build-your-own-hamper templates. |
| `builder_template_steps` | Per-step min/max choices (a single `slots` int cannot express these). |
| `builder_step_options` | Selectable options per step: hamper item, variant, or packaging. |
| `reviews` | Moderated, product-linked, optionally verified-purchase reviews. |

### `inventory.ts` — 11 tables
| Table | Purpose |
|---|---|
| `warehouses` | Fulfilment locations with state-wise GSTIN and same-day capability. |
| `inventory_levels` | The single source of truth for stock: stockable × warehouse. |
| `inventory_reservations` | Expiring holds, so an abandoned cart releases stock. |
| `stock_movements` | Append-only ledger; every `on_hand_qty` change writes one row. |
| `suppliers` | Procurement vendors with GSTIN/PAN and outstanding balance. |
| `purchase_orders` | POs with money totals in paise. |
| `purchase_order_lines` | Absolute ordered/received quantities (never a percentage). |
| `goods_receipts` | GRNs with QC status and inspector. |
| `goods_receipt_lines` | Accepted/rejected quantities, batch numbers, expiry dates. |
| `stock_transfers` | Inter-warehouse transfers; from ≠ to is enforced. |
| `stock_transfer_lines` | Sent vs received quantities per line. |

### `orders.ts` — 11 tables
| Table | Purpose |
|---|---|
| `carts` | Server-side carts incl. abandonment and recovery state. |
| `cart_lines` | Variant lines or builder configurations, with a dedupe `line_key`. |
| `cart_line_add_ons` | Add-ons chosen per cart line. |
| `orders` | Frozen buyer/recipient/address/tax snapshots plus all money in paise. |
| `order_lines` | Per-line GST breakdown and catalogue snapshots. |
| `order_line_add_ons` | Add-ons as taxable lines, not scalar columns. |
| `order_line_personalisations` | Engraving/print inputs and the proof approval loop. |
| `order_timeline` | Append-only order event log. |
| `returns` | Return requests with reason, refund mode, restock flag. |
| `return_lines` | Line-level returns — partial returns are representable. |
| `exchanges` | Variant-to-variant exchange with a signed price difference. |

### `payments.ts` — 9 tables
| Table | Purpose |
|---|---|
| `payments` | 1:N per order (gift card + UPI, COD part-payment, retries) with settlement columns. |
| `payment_events` | Raw inbound gateway webhooks; `(gateway, event_id)` is the idempotency boundary. |
| `refunds` | Refund attempts with idempotency key and approver. |
| `invoices` | Immutable GST invoices with IRN/e-way fields; corrections are credit notes. |
| `invoice_lines` | Per-HSN breakup — what GSTR-1 actually requires. |
| `credit_notes` | Own statutory series, references the original invoice. |
| `credit_note_lines` | Per-HSN credit-note breakup. |
| `gift_cards` | Hashed codes, balance, expiry. |
| `gift_card_transactions` | Ledger, so the balance is reconstructible and double-spend visible. |

### `corporate.ts` — 8 tables
| Table | Purpose |
|---|---|
| `corporate_leads` | B2B enquiry pipeline from the storefront form and offline sources. |
| `corporate_accounts` | Named accounts with credit limit, terms and negotiated discount. |
| `corporate_account_contacts` | Named contacts, one primary, approval rights. |
| `quotations` | Priced proposals with margin, validity and conversion link. |
| `quotation_lines` | Line items with cost, discount and branding notes. |
| `corporate_campaigns` | A funded gifting programme within a dispatch window. |
| `campaign_recipients` | Real recipient rows (not the mock's three drifting counters). |
| `approvals` | Polymorphic approval queue; self-approval is forbidden. |

### `delivery.ts` — 10 tables
| Table | Purpose |
|---|---|
| `delivery_zones` | Serviceability zones with same-day/midnight/COD capability and cutoff. |
| `delivery_zone_pincodes` | The actual pincodes, keyed for O(1) checkout lookup. |
| `couriers` | Carrier partners, services, tracking URL template, integration link. |
| `courier_performance_daily` | Daily rollup from which on-time/NDR/RTO rates are computed. |
| `shipping_rules` | Priority-ordered JSONB rule engine replacing hardcoded constants. |
| `shipments` | Orders don't ship — shipments ship. AWB, weight, COD, POD. |
| `shipment_lines` | Which order lines are in which box. |
| `shipment_events` | Courier tracking scans, raw payload retained. |
| `delivery_exceptions` | NDR/RTO/damage/lost workflow with owner and reattempt date. |
| `packaging_materials` | Boxes, trunks, potlis; stock lives in `inventory_levels`. |

### `promotions.ts` — 12 tables
| Table | Purpose |
|---|---|
| `coupons` | Machine-readable discount type + value + caps (not a display string). |
| `coupon_scope` | Per-coupon collection/product inclusion and exclusion lists. |
| `coupon_redemptions` | Tier 1 redemption record; reversal on order cancellation. |
| `auto_discounts` | Automatic cart-level promotions with a JSONB rule. |
| `bundles` | Fixed-price multi-variant bundles; savings are derived. |
| `bundle_items` | Bundle composition. |
| `upsell_rules` | Placement-targeted offers (PDP, cart, checkout, post-purchase). |
| `loyalty_tiers` | Silver→Noir thresholds, earn rate, perks. |
| `loyalty_accounts` | Per-customer points balance and tier. |
| `loyalty_transactions` | Append-only points ledger; one 'earn' per order. |
| `referrals` | Per-customer referral codes and reward configuration. |
| `referral_conversions` | Invite → signup → conversion → reward funnel rows. |

### `content.ts` — 12 tables
| Table | Purpose |
|---|---|
| `media_assets` | The media library; every image/video/PDF reference is an FK here. |
| `cms_sections` | Homepage/landing section slots with layout and ordering. |
| `cms_section_items` | Ordered tiles inside a section, linking to collections or products. |
| `banners` | Placement- and device-targeted promotional banners with a schedule. |
| `banner_stats_daily` | Impressions/clicks rollup; CTR is derived. |
| `content_pages` | Occasion landing pages AND policy pages — same shape, `kind` discriminates. |
| `seo_entries` | Polymorphic per-entity or per-route SEO record. |
| `blog_posts` | The journal; body is ordered JSONB blocks. |
| `faqs` | Question **and answer** (the admin type has no answer field at all). |
| `testimonials` | Marketing quotes, B2C and B2B shapes unified, unlinked to products. |
| `menus` | Named navigation menus (header, footer, mobile). |
| `menu_items` | Self-parenting items targeting a collection, page or raw URL. |

### `platform.ts` — 8 tables
| Table | Purpose |
|---|---|
| `activity_logs` | Append-only audit trail with JSONB before/after and changed-field list. |
| `notifications` | Staff and customer notifications with read state. |
| `integrations` | Third-party service config; credentials are a secret-manager pointer. |
| `webhooks` | Outbound webhook subscriptions with a hashed signing secret. |
| `webhook_deliveries` | Delivery attempts, responses and retry schedule. |
| `import_jobs` | Bulk CSV/JSON import runs with row counts. |
| `import_job_errors` | Per-row import failures. |
| `app_settings` | Public/private key-value settings (replaces storefront localStorage). |

**Total: 4 + 7 + 8 + 18 + 11 + 11 + 9 + 8 + 10 + 12 + 12 + 8 = 118.**

---

## SQL-only objects — things Drizzle does not model

All of these live exclusively in `../migrations/0001_initial.sql`.

### Extensions
`pgcrypto`, `citext`, `pg_trgm`, `btree_gist`.

### Domains (11)
`money_paise`, `nonneg_paise`, `qty`, `pincode`, `mobile_in`, `gstin`, `pan_in`,
`handle`, `hsn`, `currency_code`, `percent_bp`.

Drizzle has no domain concept, so these columns appear as `bigint` / `integer` /
`text` / `char` in TypeScript. **The format and range checks are real and are
enforced by the database** — an invalid GSTIN or pincode raises at write time
even though nothing in the TS type says so. Each affected column carries a
`/** DB type: DOMAIN x */` comment.

### Column types Drizzle cannot express natively
`CITEXT` (case-insensitive email) is declared as `text()`. Comparison on
`customers.email`, `staff_users.email`, `suppliers.email` and friends is
case-insensitive **in the database**; do not add `lower()` wrappers in queries,
they defeat the index.

### Generated columns (2)
- `staff_users.avatar_initials`
- `inventory_levels.available_qty` = `on_hand_qty - reserved_qty`

Both are `GENERATED ALWAYS AS ... STORED`. They are declared with Drizzle's
`.generatedAlwaysAs()` so they are typed on select — see "Choices made" below.

### Exclusion constraint (1)
`gst_rate_no_overlap` on `gst_rates`: `EXCLUDE USING gist (hsn_code WITH =,
daterange(effective_from, coalesce(effective_to,'infinity'), '[)') WITH &&)`.
Prevents two overlapping rate windows for the same HSN.

### Functions (6) and the order-number sequence
| Object | Purpose |
|---|---|
| `set_updated_at()` | `BEFORE UPDATE` trigger function attached to every table with `updated_at`. |
| `split_inclusive_tax(gross, rate_bp, interstate)` | Back-computes taxable from a GST-inclusive amount; absorbs the odd paisa into taxable so `cgst = sgst` holds. |
| `indian_fy(ts)` | `'26-27'` financial-year label in Asia/Kolkata. |
| `order_no_seq` + `next_order_no()` | `ACH100000…`. Non-gapless by design. |
| `next_document_number(doc_type, scope)` | Row-locked, transaction-participating, **gapless** — Rule 46(b). |
| `forbid_self_referral()` | §7 correction 4 — replaces an illegal CHECK-with-subquery. |
| `ensure_default_address()` | Guarantees at least one default address survives a delete. |
| `check_order_totals()` | §4.4 invariants I1–I4. |

### Triggers
- `trg_<table>_updated` on all ~90 tables with an `updated_at` column, generated
  by a `DO` loop so none can be forgotten.
- `trg_no_self_referral` — `BEFORE INSERT OR UPDATE ON referral_conversions`.
- `trg_ensure_default_address` — `AFTER INSERT/UPDATE/DELETE ON addresses`.
- **`trg_order_totals_lines` and `trg_order_totals_header` —
  `DEFERRABLE INITIALLY DEFERRED` CONSTRAINT TRIGGERS.** These fire once at
  `COMMIT` and enforce that an order's header money reconciles with its lines.
  This is the single most important integrity rule in the schema and Drizzle
  cannot express constraint triggers at all. Practical consequence: **cancelling
  an order line requires adjusting the header in the same transaction**, or the
  commit fails.

### Privileges
`REVOKE DELETE ON <Tier 1 tables> FROM achichiz_app` — books of account
(invoices, credit notes, payments, refunds, order timeline, stock movements,
activity logs, gift-card and loyalty ledgers, coupon redemptions) cannot be
deleted by the application role even via an ORM cascade. Applied conditionally
if the role exists.

### Concurrency protocols that are code, not schema
Documented in the migration and in file headers, enforced by convention:
- **Oversell**: reserve with `UPDATE ... WHERE on_hand_qty - reserved_qty >= $n`
  and check the row count. Race-free at `READ COMMITTED`. The
  `inventory_no_oversell` CHECK is a backstop, not the mechanism.
- **Deadlocks**: pre-lock multi-line reservations with
  `SELECT id FROM inventory_levels WHERE id = ANY($1) ORDER BY id FOR UPDATE`.
- **Default flags**: a partial unique index cannot be deferred, so clear the old
  default *before* setting the new one. Applies to `uq_one_default_address_per_customer`,
  `uq_one_default_variant_per_product`, `uq_one_default_warehouse`,
  `uq_one_primary_contact`.
- **Coupon per-customer limits**: the `UPDATE coupons ... redemption_count + 1`
  row lock is what serialises the subsequent per-customer count.

---

## The five §7 corrections, and where each landed

1. **Credit-note number format.** Series seeded as `('credit_note','26-27','CN/26-27/',6,1)`
   → `CN/26-27/000001` (15 chars). Backed by new CHECKs `cn_no_max_16` and
   `invoice_no_max_16` so the 16-character Rule 46(b) cap is enforced, not just
   documented. (`payments.ts`, migration §8.)
2. **Soft-delete uniqueness.** Every inline `UNIQUE` on a Tier 2 table became a
   partial unique index `WHERE deleted_at IS NULL`: `products.handle`,
   `collections.handle`, `designers.handle`/`name`, `product_variants.sku`/`barcode`/`(product_id, option_value)`,
   `customers.email`/`mobile`/`auth_provider_uid`, `staff_users.email`,
   `hamper_items.sku`, `add_ons.code`, `personalisation_templates.name`,
   `builder_templates.handle`, `suppliers.code`, `warehouses.code`/`name`,
   `packaging_materials.sku`, `media_assets.storage_key`, `content_pages.slug`,
   `blog_posts.slug`, `coupons.code`, `bundles.handle`,
   `corporate_accounts.company_name`. Document numbers stayed FULL unique.
3. **`customers.email_verified_at` and `customers.mobile_verified_at`** added.
4. **`referral_conversions` self-referral** is `forbid_self_referral()` +
   `trg_no_self_referral`. There is deliberately no `check()` for it in
   `promotions.ts`.
5. **`legacy_ref TEXT`** added to `products`, `customers` and `collections`, each
   with a partial index `WHERE legacy_ref IS NOT NULL`. Drop after cutover.

---

## Choices made where the DDL was ambiguous

**Generated columns are declared in Drizzle as well as SQL.** The brief listed
generated columns as SQL-only. Drizzle ≥0.32 can express them, and omitting
`inventory_levels.available_qty` from the TS table would make the most-read
availability figure invisible to typed queries and would break the
`idx_inventory_low` index definition. Both generated columns are therefore
declared with `.generatedAlwaysAs()`. **The SQL migration remains authoritative
for the expressions**; if the two ever disagree, the migration wins.

**`variant_option_unique_per_product` was converted to a partial index.** The DDL
declared it as an inline table-level `UNIQUE (product_id, option_value)` on a
soft-deletable table. §4.5 lists the columns it names explicitly but ends with
"and the rest"; leaving this one full-unique would let a soft-deleted variant
squat on an option value forever, which is exactly the bug correction 2 exists to
fix. Same reasoning applied to `product_variants.barcode`,
`customers.auth_provider_uid`, `media_assets.storage_key`,
`personalisation_templates.name`, `builder_templates.handle`, `bundles.handle`
and `corporate_accounts.company_name` — all Tier 2, none named in §4.5's list.

**`cms_sections.layout` default.** The DDL wrote `DEFAULT 'grid'`, but `'grid'`
is not in the column's own `CHECK (layout IN ('full_bleed','grid_4','grid_3',
'carousel','split_banner','marquee','list'))` — the default was unsatisfiable and
every insert omitting `layout` would have failed. Changed to `'grid_4'`.

**Ledger PK mode.** §3.1 says ledger primary keys should stay `bigint`/string
since they are opaque and never summed. They are declared
`bigint({ mode: 'bigint' })`, so `StockMovement['id']` is a JS `bigint` while
every `*_paise` column is a `number`. Do not template a ledger id into a string
without `.toString()`.

**Tables the brief named that do not exist under that name.** `abandoned_carts`
is `carts.abandoned_at` + `recovery_state` (a cart does not become a different
entity when it is abandoned). `settlements` is three columns on `payments`.
`occasion_pages` is `content_pages` with `kind = 'occasion'`. `audit_log` is
`activity_logs`. `webhook_events` splits in two: inbound gateway events are
`payment_events` (payments.ts), outbound deliveries are `webhook_deliveries`
(platform.ts). `api_keys` is in `identity.ts` rather than `platform.ts` because
it shares staff credential/revocation semantics; it is re-exported from the
barrel either way.

**`document_number_series` lives in `tax.ts`, not `payments.ts`.** It is
referenced by purchase orders, GRNs, transfers and quotations as well as
invoices, so it belongs with the other reference data.

**`coupon_scope` has no primary key.** The DDL gives it only two partial unique
indexes (one for collection scope, one for product scope), because a single
composite PK cannot express "unique per coupon, on whichever of the two columns
is populated". Reproduced as-is.

## Open business questions that the schema is holding open

The design records fourteen (§7). The four that would change column semantics if
answered differently: **Q3** — how many states HARIVON is GST-registered in
(decides whether IGST or CGST+SGST is the normal case, and how many invoice
series exist); **Q4** — bill-to/ship-to treatment for multi-state corporate
campaigns; **Q5** — whether shipping is a composite supply at the principal rate
(assumption A5) or a separate supply at 18%, in which case it becomes its own
`order_lines` row; **Q7** — the correct GST rate for imitation jewellery, the
largest storefront category. All four need CA sign-off before the first invoice
is issued.
