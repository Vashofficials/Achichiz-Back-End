-- =====================================================================
-- Achichiz — 0001_initial.sql
-- HARIVON ENTERPRISES PRIVATE LIMITED · PostgreSQL 16+
--
-- Forward-only initial migration. Translated verbatim from
--   docs/03_schema.md §2 (Full DDL)
-- with the five corrections recorded in §7 applied:
--   1. credit-note series prefix shortened to 'CN/26-27/' (Rule 46(b), 16 chars)
--   2. inline UNIQUE on soft-deletable (Tier 2) tables -> PARTIAL unique
--      indexes WHERE deleted_at IS NULL                       (§4.5)
--   3. customers.email_verified_at + customers.mobile_verified_at (§5.2)
--   4. referral self-referral rule is forbid_self_referral() trigger,
--      not a CHECK containing a subquery                      (§2.10)
--   5. optional legacy_ref TEXT on products / customers / collections (§3.4)
--
-- HAND-EDITED. Do not regenerate over this file with drizzle-kit.
-- Section order: extensions -> domains -> functions -> tables ->
--                indexes -> triggers -> reference seed.
-- =====================================================================

BEGIN;

-- =====================================================================
-- 1. EXTENSIONS
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram search for admin list screens
CREATE EXTENSION IF NOT EXISTS btree_gist; -- exclusion constraints on scheduling

-- =====================================================================
-- 2. DOMAINS
-- Drizzle cannot express CREATE DOMAIN. These live here only; the TS
-- schema declares the underlying storage type (bigint / integer / text).
-- =====================================================================

CREATE DOMAIN money_paise    AS BIGINT;                              -- may be negative
CREATE DOMAIN nonneg_paise   AS BIGINT  CHECK (VALUE >= 0);
CREATE DOMAIN qty            AS INTEGER CHECK (VALUE >= 0);
CREATE DOMAIN pincode        AS TEXT    CHECK (VALUE ~ '^[1-9][0-9]{5}$');
CREATE DOMAIN mobile_in      AS TEXT    CHECK (VALUE ~ '^[6-9][0-9]{9}$');
CREATE DOMAIN gstin          AS TEXT    CHECK (VALUE ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$');
CREATE DOMAIN pan_in         AS TEXT    CHECK (VALUE ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');
CREATE DOMAIN handle         AS TEXT    CHECK (VALUE ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(VALUE) BETWEEN 2 AND 120);
CREATE DOMAIN hsn            AS TEXT    CHECK (VALUE ~ '^[0-9]{4}([0-9]{2}([0-9]{2})?)?$');
CREATE DOMAIN currency_code  AS CHAR(3) CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN percent_bp     AS INTEGER CHECK (VALUE BETWEEN 0 AND 10000);  -- basis points

-- =====================================================================
-- 3. FUNCTIONS WITH NO TABLE DEPENDENCIES
-- =====================================================================

-- ---------------------------------------------------------------- updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- §3.2 — back-compute taxable value from a GST-INCLUSIVE gross amount and
-- split the tax. Post-condition in both branches:
--   taxable + cgst + sgst + igst = gross
-- The odd paisa on an intrastate split is absorbed into taxable so that
-- cgst = sgst holds exactly (assumption A11).
CREATE OR REPLACE FUNCTION split_inclusive_tax(
  p_gross      BIGINT,
  p_rate_bp    INTEGER,
  p_interstate BOOLEAN)
RETURNS TABLE (taxable BIGINT, cgst BIGINT, sgst BIGINT, igst BIGINT)
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE v_taxable BIGINT; v_tax BIGINT; v_half BIGINT;
BEGIN
  v_taxable := round(p_gross::numeric * 10000 / (10000 + p_rate_bp));
  v_tax     := p_gross - v_taxable;

  IF p_interstate THEN
    RETURN QUERY SELECT v_taxable, 0::BIGINT, 0::BIGINT, v_tax;
  ELSE
    v_half    := v_tax / 2;                 -- integer division, floors
    v_taxable := p_gross - (2 * v_half);    -- the odd paisa lands in taxable
    RETURN QUERY SELECT v_taxable, v_half, v_half, 0::BIGINT;
  END IF;
END $fn$;

-- §3.5 — Indian financial year label. 2026-03-31 -> '25-26'; 2026-04-01 -> '26-27'
CREATE OR REPLACE FUNCTION indian_fy(p_ts TIMESTAMPTZ) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN extract(month FROM p_ts AT TIME ZONE 'Asia/Kolkata') >= 4
      THEN to_char(p_ts AT TIME ZONE 'Asia/Kolkata', 'YY') || '-' ||
           to_char((p_ts AT TIME ZONE 'Asia/Kolkata') + interval '1 year', 'YY')
    ELSE to_char((p_ts AT TIME ZONE 'Asia/Kolkata') - interval '1 year', 'YY') || '-' ||
         to_char(p_ts AT TIME ZONE 'Asia/Kolkata', 'YY')
  END;
$fn$;

-- §3.5 — order numbers need not be gapless, so a plain sequence is used.
CREATE SEQUENCE order_no_seq START WITH 100000 INCREMENT BY 1 NO CYCLE;

CREATE OR REPLACE FUNCTION next_order_no() RETURNS TEXT
LANGUAGE sql VOLATILE AS $fn$
  SELECT 'ACH' || lpad(nextval('order_no_seq')::text, 6, '0');
$fn$;

-- =====================================================================
-- 4. TABLES  (dependency order)
-- =====================================================================

-- ------------------------------------------------------------ 4.0 reference
CREATE TABLE gst_states (
  code            CHAR(2)  PRIMARY KEY,          -- '27'
  name            TEXT     NOT NULL UNIQUE,      -- 'Maharashtra'
  is_union_terr   BOOLEAN  NOT NULL DEFAULT false
);

CREATE TABLE hsn_codes (
  code         hsn PRIMARY KEY,
  description  TEXT NOT NULL,
  is_service   BOOLEAN NOT NULL DEFAULT false,   -- true => SAC
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rates change by notification and MUST be historised.
CREATE TABLE gst_rates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hsn_code              hsn NOT NULL REFERENCES hsn_codes(code) ON DELETE RESTRICT,
  rate_bp               percent_bp NOT NULL,     -- 300 = 3%, 1800 = 18%
  cess_bp               percent_bp NOT NULL DEFAULT 0,
  effective_from        DATE NOT NULL,
  effective_to          DATE,
  price_band_max_paise  nonneg_paise,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gst_rate_window CHECK (effective_to IS NULL OR effective_to > effective_from)
);
-- No two overlapping rates for the same HSN+band. (SQL-only: EXCLUDE USING gist)
ALTER TABLE gst_rates ADD CONSTRAINT gst_rate_no_overlap EXCLUDE USING gist (
  hsn_code WITH =,
  daterange(effective_from, coalesce(effective_to,'infinity'::date), '[)') WITH &&
);

-- §3.5 — safe concurrent generation of human-facing document numbers.
CREATE TABLE document_number_series (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type       TEXT NOT NULL CHECK (doc_type IN (
                   'order','invoice','credit_note','refund','return','exchange',
                   'purchase_order','goods_receipt','stock_transfer','quotation')),
  scope_key      TEXT NOT NULL,          -- '' | '26-27' | '26-27:27' (FY:state)
  prefix         TEXT NOT NULL,          -- 'ACH' | 'ACH/26-27/'
  suffix         TEXT NOT NULL DEFAULT '',
  pad_width      SMALLINT NOT NULL DEFAULT 6 CHECK (pad_width BETWEEN 1 AND 12),
  next_value     BIGINT NOT NULL DEFAULT 1 CHECK (next_value > 0),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_type, scope_key)
);

-- ------------------------------------------------------------ 4.1 identity
CREATE TABLE roles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]+$'),  -- 'operations_manager'
  name         TEXT NOT NULL UNIQUE,                                -- 'Operations Manager'
  description  TEXT,
  is_system    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The 12 modules x 9 actions matrix, stored as rows so it is queryable.
CREATE TABLE role_permissions (
  role_id  UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  module   TEXT NOT NULL CHECK (module IN (
             'dashboard','orders','catalogue','inventory','customers','corporate',
             'delivery','promotions','content','reports','settings','finance')),
  action   TEXT NOT NULL CHECK (action IN (
             'view','create','edit','delete','export','approve','refund','cancel','manage-settings')),
  PRIMARY KEY (role_id, module, action)
);

CREATE TABLE staff_users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               CITEXT NOT NULL,          -- §7.2: partial unique, not inline UNIQUE
  full_name           TEXT NOT NULL,
  password_hash       TEXT,                     -- NULL while status='invited'
  role_id             UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  phone               mobile_in,
  -- SQL-only: GENERATED ALWAYS AS ... STORED
  avatar_initials     TEXT GENERATED ALWAYS AS (
                        upper(left(split_part(full_name,' ',1),1) ||
                              coalesce(left(nullif(split_part(full_name,' ',2),''),1),''))
                      ) STORED,
  mfa_enabled         BOOLEAN NOT NULL DEFAULT false,
  mfa_secret          TEXT,
  status              TEXT NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('active','invited','suspended')),
  last_active_at      TIMESTAMPTZ,
  invited_at          TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  failed_login_count  SMALLINT NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT staff_active_needs_password
    CHECK (status <> 'active' OR password_hash IS NOT NULL)
);

CREATE TABLE staff_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id      UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,      -- store the hash, never the token
  device_label       TEXT,                      -- 'MacBook Pro · Chrome'
  user_agent         TEXT,
  ip                 INET,
  location_label     TEXT,                      -- 'Mumbai, India'
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  CONSTRAINT staff_session_window CHECK (expires_at > issued_at)
);

CREATE TABLE api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label         TEXT NOT NULL,
  key_prefix    TEXT NOT NULL UNIQUE,   -- 'ach_live_7f3a' — shown in the UI
  key_hash      TEXT NOT NULL,          -- argon2/bcrypt of the full key; never the key
  environment   TEXT NOT NULL DEFAULT 'live' CHECK (environment IN ('live','test')),
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  created_by    UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE otp_challenges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel       TEXT NOT NULL CHECK (channel IN ('sms','email','whatsapp')),
  destination   TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  purpose       TEXT NOT NULL CHECK (purpose IN ('login','signup','verify','password_reset','order_track')),
  attempts      SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  SMALLINT NOT NULL DEFAULT 5,
  consumed_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ 4.11 media
-- media_assets is created early: catalogue, content, delivery and finance
-- tables all reference it.
CREATE TABLE media_assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key     TEXT NOT NULL,            -- §7.2: partial unique
  url             TEXT NOT NULL,
  cdn_url         TEXT,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('image','video','pdf','other')),
  bytes           BIGINT NOT NULL CHECK (bytes > 0),
  width_px        INTEGER,
  height_px       INTEGER,
  duration_ms     INTEGER,
  blurhash        TEXT,
  alt_text        TEXT,
  folder          TEXT,
  checksum_sha256 TEXT,
  uploaded_by     UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- ------------------------------------------------------------ 4.12 platform (early deps)
CREATE TABLE integrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             handle NOT NULL UNIQUE,     -- 'razorpay' | 'wati' | 'cloudinary'
  name            TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN (
                    'payments','shipping','messaging','storage','analytics','accounting','crm')),
  config          JSONB NOT NULL DEFAULT '{}',   -- non-secret settings
  credentials_ref TEXT,       -- pointer into a secret manager, NOT the secret
  status          TEXT NOT NULL DEFAULT 'not_connected'
                    CHECK (status IN ('connected','not_connected','error')),
  last_error      TEXT,
  last_sync_at    TIMESTAMPTZ,
  event_count     BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_error_has_message CHECK (status <> 'error' OR last_error IS NOT NULL)
);

CREATE TABLE import_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity                TEXT NOT NULL CHECK (entity IN (
                          'products','variants','inventory','customers',
                          'campaign_recipients','pincodes','collections')),
  mode                  TEXT NOT NULL DEFAULT 'upsert' CHECK (mode IN ('insert','upsert','update')),
  source_media_id       UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  filename              TEXT NOT NULL,
  total_rows            INTEGER NOT NULL DEFAULT 0,
  succeeded_rows        INTEGER NOT NULL DEFAULT 0,
  failed_rows           INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  error_report_media_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  actor_id              UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT import_row_math CHECK (succeeded_rows + failed_rows <= total_rows)
);

CREATE TABLE import_job_errors (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_job_id UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number    INTEGER NOT NULL,
  column_name   TEXT,
  raw_value     TEXT,
  message       TEXT NOT NULL
);

-- ------------------------------------------------------------ 4.5 warehouses / suppliers
CREATE TABLE warehouses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL,                 -- 'WH-MUM-AND'  §7.2 partial unique
  name              TEXT NOT NULL,                 -- 'Mumbai Atelier (Andheri)'
  line1             TEXT NOT NULL,
  city              TEXT NOT NULL,
  state_code        CHAR(2) NOT NULL REFERENCES gst_states(code) ON DELETE RESTRICT,
  pincode           pincode NOT NULL,
  gstin             gstin,       -- one GSTIN per state of operation; see Q3
  manager_id        UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  capacity_units    INTEGER CHECK (capacity_units IS NULL OR capacity_units > 0),
  supports_same_day BOOLEAN NOT NULL DEFAULT false,
  is_default        BOOLEAN NOT NULL DEFAULT false,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','maintenance','closed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE TABLE staff_user_warehouses (
  staff_user_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  warehouse_id  UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_user_id, warehouse_id)
);

CREATE TABLE suppliers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL,                 -- §7.2 partial unique
  name              TEXT NOT NULL,
  contact_name      TEXT,
  email             CITEXT,
  mobile            mobile_in,
  line1             TEXT,
  city              TEXT,
  state_code        CHAR(2) REFERENCES gst_states(code) ON DELETE RESTRICT,
  pincode           pincode,
  gstin             gstin,
  pan               pan_in,
  category          TEXT,        -- Gourmet | Packaging | Decor | Fragrance | Logistics
  lead_time_days    INTEGER CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  payment_terms     TEXT,
  rating            NUMERIC(2,1) CHECK (rating IS NULL OR rating BETWEEN 1.0 AND 5.0),
  outstanding_paise money_paise NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','archived')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE TABLE packaging_materials (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku                TEXT NOT NULL,                -- §7.2 partial unique
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('box','trunk','potli','wrap','card','filler','tape')),
  length_mm          INTEGER,
  width_mm           INTEGER,
  height_mm          INTEGER,
  max_weight_grams   INTEGER,
  cost_paise         nonneg_paise NOT NULL DEFAULT 0,
  supports_gift_note BOOLEAN NOT NULL DEFAULT false,
  supplier_id        UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','discontinued')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

-- ------------------------------------------------------------ 4.8 corporate accounts (customers depends on it)
CREATE TABLE corporate_accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_no         TEXT NOT NULL UNIQUE,          -- document number: full unique
  company_name       TEXT NOT NULL,                 -- §7.2 partial unique
  legal_name         TEXT,
  gstin              gstin,
  pan                pan_in,
  billing_line1      TEXT,
  billing_city       TEXT,
  billing_state_code CHAR(2) REFERENCES gst_states(code) ON DELETE RESTRICT,
  billing_pincode    pincode,
  account_manager_id UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  credit_limit_paise nonneg_paise NOT NULL DEFAULT 0,
  outstanding_paise  nonneg_paise NOT NULL DEFAULT 0,
  payment_terms      TEXT NOT NULL DEFAULT 'advance'
                       CHECK (payment_terms IN ('advance','net_15','net_30','net_45','net_60')),
  discount_bp        percent_bp NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'prospect'
                       CHECK (status IN ('active','credit_hold','prospect','closed')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT corp_within_credit_limit CHECK (
    status = 'credit_hold' OR outstanding_paise <= credit_limit_paise)
);

-- ------------------------------------------------------------ 4.2 customers
CREATE TABLE customers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 CITEXT,                      -- §7.2 partial unique
  mobile                mobile_in,                   -- §7.2 partial unique
  full_name             TEXT,
  birthday              DATE,
  gender                TEXT CHECK (gender IN ('female','male','other','undisclosed')),
  password_hash         TEXT,
  auth_provider_uid     UUID,                        -- §7.2 partial unique
  email_verified_at     TIMESTAMPTZ,                 -- §7.3 correction
  mobile_verified_at    TIMESTAMPTZ,                 -- §7.3 correction
  marketing_opt_in      BOOLEAN NOT NULL DEFAULT false,
  whatsapp_opt_in       BOOLEAN NOT NULL DEFAULT false,
  segment               TEXT CHECK (segment IN ('vip','loyal','new','at_risk','corporate_buyer')),
  corporate_account_id  UUID REFERENCES corporate_accounts(id) ON DELETE SET NULL,
  default_billing_gstin gstin,
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  accepts_cod           BOOLEAN NOT NULL DEFAULT true,
  blocked_at            TIMESTAMPTZ,
  blocked_reason        TEXT,
  first_order_at        TIMESTAMPTZ,
  last_order_at         TIMESTAMPTZ,
  legacy_ref            TEXT,                        -- §7.5 import traceability; drop after cutover
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  CONSTRAINT customer_needs_a_handle CHECK (email IS NOT NULL OR mobile IS NOT NULL)
);

CREATE TABLE customer_stats (
  customer_id          UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  order_count          INTEGER NOT NULL DEFAULT 0,
  lifetime_spend_paise nonneg_paise NOT NULL DEFAULT 0,
  aov_paise            nonneg_paise NOT NULL DEFAULT 0,
  return_count         INTEGER NOT NULL DEFAULT 0,
  loyalty_points       INTEGER NOT NULL DEFAULT 0,
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT 'Home',
  contact_name TEXT NOT NULL,
  mobile       mobile_in NOT NULL,
  line1        TEXT NOT NULL,
  line2        TEXT,
  area         TEXT,
  city         TEXT NOT NULL,
  state_code   CHAR(2) NOT NULL REFERENCES gst_states(code) ON DELETE RESTRICT,
  pincode      pincode NOT NULL,
  country_code CHAR(2) NOT NULL DEFAULT 'IN',
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE recipients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  relation    TEXT,
  mobile      mobile_in,
  address_id  UUID REFERENCES addresses(id) ON DELETE SET NULL,
  occasion    TEXT,
  next_date   DATE,
  reminder_on BOOLEAN NOT NULL DEFAULT true,
  gifts_sent  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE customer_segments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  rule          JSONB NOT NULL,     -- executable DSL
  rule_text     TEXT,               -- 'lifetime_spend > 200000' — display only
  is_dynamic    BOOLEAN NOT NULL DEFAULT true,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('active','draft','archived')),
  member_count  INTEGER NOT NULL DEFAULT 0,
  revenue_paise nonneg_paise NOT NULL DEFAULT 0,
  refreshed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_segment_members (
  segment_id  UUID NOT NULL REFERENCES customer_segments(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, customer_id)
);

CREATE TABLE customer_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  device_label       TEXT,
  ip                 INET,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ
);

-- ------------------------------------------------------------ 4.3 catalogue
CREATE TABLE designers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        handle NOT NULL,                 -- §7.2 partial unique
  name          TEXT NOT NULL,                   -- §7.2 partial unique
  kind          TEXT NOT NULL DEFAULT 'brand'
                  CHECK (kind IN ('designer','brand','celebrity','artisan_cluster')),
  bio           TEXT,
  logo_media_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  commission_bp percent_bp,
  contact_email CITEXT,
  contact_phone mobile_in,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- §1.2 — one taxonomy table, discriminated by `kind`.
CREATE TABLE collections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle          handle NOT NULL,                 -- §7.2 partial unique
  kind            TEXT NOT NULL CHECK (kind IN
                    ('category','recipient','occasion','festival','designer','edit')),
  parent_id       UUID REFERENCES collections(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  heading         TEXT,
  subtext         TEXT,
  seo_description TEXT,
  hero_media_id   UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  designer_id     UUID REFERENCES designers(id) ON DELETE SET NULL,
  curator         TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_featured     BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('live','scheduled','draft','archived')),
  starts_on       TIMESTAMPTZ,
  ends_on         TIMESTAMPTZ,
  legacy_ref      TEXT,                            -- §7.5
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT collection_no_self_parent CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT collection_window CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on > starts_on),
  CONSTRAINT collection_designer_kind CHECK (kind = 'designer' OR designer_id IS NULL),
  CONSTRAINT collection_scheduled_needs_start CHECK (status <> 'scheduled' OR starts_on IS NOT NULL)
);

CREATE TABLE products (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle                handle NOT NULL,          -- §7.2 partial unique; storefront route key
  title                 TEXT NOT NULL,
  subtitle              TEXT,
  description           TEXT,
  kind                  TEXT NOT NULL DEFAULT 'single_gift' CHECK (kind IN
                          ('hamper','single_gift','personalised','gourmet','add_on','builder')),
  designer_id           UUID REFERENCES designers(id) ON DELETE SET NULL,
  primary_collection_id UUID REFERENCES collections(id) ON DELETE SET NULL,
  hsn_code              hsn REFERENCES hsn_codes(code) ON DELETE RESTRICT,
  is_personalisable     BOOLEAN NOT NULL DEFAULT false,
  is_perishable         BOOLEAN NOT NULL DEFAULT false,
  is_fragile            BOOLEAN NOT NULL DEFAULT false,
  requires_shipping     BOOLEAN NOT NULL DEFAULT true,
  low_stock_threshold   INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
  badge_override        TEXT CHECK (badge_override IN ('best_seller','new','limited','none')),
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('active','draft','archived')),
  published_at          TIMESTAMPTZ,
  legacy_ref            TEXT,                     -- §7.5
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_by            UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  deleted_at            TIMESTAMPTZ,
  CONSTRAINT product_active_needs_publish CHECK (status <> 'active' OR published_at IS NOT NULL),
  CONSTRAINT product_active_needs_hsn     CHECK (status <> 'active' OR hsn_code IS NOT NULL)
);

CREATE TABLE product_variants (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku              TEXT NOT NULL,                 -- §7.2 partial unique
  option_label     TEXT NOT NULL DEFAULT 'Standard',
  option_value     handle NOT NULL DEFAULT 'standard',
  price_paise      nonneg_paise NOT NULL,         -- GST-INCLUSIVE, see §3.2
  compare_at_paise nonneg_paise,
  cost_paise       nonneg_paise,                  -- never exposed publicly
  weight_grams     INTEGER CHECK (weight_grams IS NULL OR weight_grams > 0),
  length_mm        INTEGER,
  width_mm         INTEGER,
  height_mm        INTEGER,
  barcode          TEXT,                          -- §7.2 partial unique
  is_default       BOOLEAN NOT NULL DEFAULT false,
  position         INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT variant_compare_at_sane
    CHECK (compare_at_paise IS NULL OR compare_at_paise >= price_paise)
  -- variant_option_unique_per_product: converted to a partial unique index (§7.2)
);

CREATE TABLE product_collections (
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, collection_id)
);

CREATE TABLE product_media (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  media_id   UUID NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  alt_text   TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product_content_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);

-- Denormalised read-model. Refreshed by job; safe to TRUNCATE and rebuild.
CREATE TABLE product_stats (
  product_id     UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  rating_avg     NUMERIC(2,1) CHECK (rating_avg IS NULL OR rating_avg BETWEEN 1.0 AND 5.0),
  review_count   INTEGER NOT NULL DEFAULT 0,
  units_sold     INTEGER NOT NULL DEFAULT 0,
  units_sold_30d INTEGER NOT NULL DEFAULT 0,
  return_rate_bp percent_bp NOT NULL DEFAULT 0,
  revenue_paise  nonneg_paise NOT NULL DEFAULT 0,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wishlist_items (
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);

-- Raw components that go INTO hampers. Stock items, not sellable products.
CREATE TABLE hamper_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             TEXT NOT NULL,                 -- §7.2 partial unique
  name            TEXT NOT NULL,
  supplier_id     UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  category        TEXT,
  cost_paise      nonneg_paise NOT NULL DEFAULT 0,
  unit            TEXT NOT NULL DEFAULT 'pcs' CHECK (unit IN ('pcs','box','pack','kg','g','ml','l')),
  weight_grams    INTEGER,
  hsn_code        hsn REFERENCES hsn_codes(code) ON DELETE RESTRICT,
  is_perishable   BOOLEAN NOT NULL DEFAULT false,
  shelf_life_days INTEGER,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE product_bom_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id           UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  hamper_item_id       UUID REFERENCES hamper_items(id) ON DELETE RESTRICT,
  component_variant_id UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity             NUMERIC(10,3) NOT NULL CHECK (quantity > 0),
  is_substitutable     BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT bom_exactly_one_component CHECK (
    (hamper_item_id IS NOT NULL)::int + (component_variant_id IS NOT NULL)::int = 1),
  CONSTRAINT bom_no_self_reference CHECK (component_variant_id IS DISTINCT FROM variant_id)
);

CREATE TABLE add_ons (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             handle NOT NULL,               -- §7.2 partial unique
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'other' CHECK (kind IN
                     ('packaging','message','fresh','bakery','digital','engraving','other')),
  price_paise      nonneg_paise NOT NULL,
  hsn_code         hsn REFERENCES hsn_codes(code) ON DELETE RESTRICT,
  requires_input   BOOLEAN NOT NULL DEFAULT false,
  input_char_limit INTEGER,
  lead_time_hours  INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);

CREATE TABLE product_add_ons (
  product_id           UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  add_on_id            UUID NOT NULL REFERENCES add_ons(id) ON DELETE CASCADE,
  price_override_paise nonneg_paise,
  position             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, add_on_id)
);

CREATE TABLE personalisation_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,                -- §7.2 partial unique
  method           TEXT NOT NULL CHECK (method IN ('engraving','embroidery','print','digital','laser')),
  turnaround_hours INTEGER NOT NULL DEFAULT 24 CHECK (turnaround_hours > 0),
  char_limit       INTEGER CHECK (char_limit IS NULL OR char_limit > 0),
  allows_image     BOOLEAN NOT NULL DEFAULT false,
  proof_required   BOOLEAN NOT NULL DEFAULT false,
  surcharge_paise  nonneg_paise NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('active','draft','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);

CREATE TABLE product_personalisation_templates (
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES personalisation_templates(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, template_id)
);

CREATE TABLE builder_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle           handle NOT NULL,              -- §7.2 partial unique
  name             TEXT NOT NULL,
  base_price_paise nonneg_paise NOT NULL DEFAULT 0,
  max_weight_grams INTEGER,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live','draft','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);

CREATE TABLE builder_template_steps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES builder_templates(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  title       TEXT NOT NULL,          -- 'Snacks & chocolates'
  note        TEXT,                   -- 'Choose 2 to 4'
  min_choices INTEGER NOT NULL DEFAULT 0 CHECK (min_choices >= 0),
  max_choices INTEGER NOT NULL DEFAULT 1 CHECK (max_choices >= 1),
  step_kind   TEXT NOT NULL DEFAULT 'items'
                CHECK (step_kind IN ('packaging','items','personalisation','review')),
  CONSTRAINT builder_step_range CHECK (max_choices >= min_choices),
  UNIQUE (template_id, position)
);

CREATE TABLE builder_step_options (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id        UUID NOT NULL REFERENCES builder_template_steps(id) ON DELETE CASCADE,
  hamper_item_id UUID REFERENCES hamper_items(id) ON DELETE CASCADE,
  variant_id     UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  packaging_id   UUID REFERENCES packaging_materials(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  price_paise    nonneg_paise NOT NULL,
  weight_grams   INTEGER,
  position       INTEGER NOT NULL DEFAULT 0,
  is_available   BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT builder_option_exactly_one_source CHECK (
    (hamper_item_id IS NOT NULL)::int + (variant_id IS NOT NULL)::int
    + (packaging_id IS NOT NULL)::int = 1)
);

-- ------------------------------------------------------------ 4.5 inventory
-- The single source of truth for stock.
CREATE TABLE inventory_levels (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id       UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  hamper_item_id   UUID REFERENCES hamper_items(id) ON DELETE CASCADE,
  packaging_id     UUID REFERENCES packaging_materials(id) ON DELETE CASCADE,
  warehouse_id     UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  on_hand_qty      INTEGER NOT NULL DEFAULT 0 CHECK (on_hand_qty >= 0),
  reserved_qty     INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  -- SQL-only: GENERATED ALWAYS AS ... STORED
  available_qty    INTEGER GENERATED ALWAYS AS (on_hand_qty - reserved_qty) STORED,
  incoming_qty     INTEGER NOT NULL DEFAULT 0 CHECK (incoming_qty >= 0),
  reorder_point    INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  reorder_qty      INTEGER NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
  bin_location     TEXT,
  last_movement_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 4.1: the oversell guard, in the database.
  CONSTRAINT inventory_no_oversell CHECK (reserved_qty <= on_hand_qty),
  CONSTRAINT inventory_exactly_one_stockable CHECK (
    (variant_id IS NOT NULL)::int + (hamper_item_id IS NOT NULL)::int
    + (packaging_id IS NOT NULL)::int = 1)
);

-- ------------------------------------------------------------ 4.6 carts
CREATE TABLE carts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID REFERENCES customers(id) ON DELETE CASCADE,
  anon_token         TEXT UNIQUE,          -- logged-out carts
  currency           currency_code NOT NULL DEFAULT 'INR',
  coupon_code        TEXT,
  email              CITEXT,
  mobile             mobile_in,
  stage              TEXT NOT NULL DEFAULT 'cart'
                       CHECK (stage IN ('cart','address','payment','converted')),
  converted_order_id UUID,   -- FK added after `orders` exists (carts <-> orders cycle)
  abandoned_at       TIMESTAMPTZ,
  recovery_state     TEXT NOT NULL DEFAULT 'not_sent' CHECK (recovery_state IN
                       ('not_sent','email_sent','whatsapp_sent','recovered')),
  recovery_sent_at   TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cart_has_owner CHECK (customer_id IS NOT NULL OR anon_token IS NOT NULL),
  CONSTRAINT cart_converted_has_order CHECK (stage <> 'converted' OR converted_order_id IS NOT NULL)
);

CREATE TABLE cart_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id             UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id          UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  builder_template_id UUID REFERENCES builder_templates(id) ON DELETE CASCADE,
  builder_config      JSONB,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_paise    nonneg_paise NOT NULL,   -- snapshot at add-to-cart
  personalisation     JSONB,
  line_key            TEXT NOT NULL,           -- dedupe key
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cart_line_exactly_one_kind CHECK (
    (variant_id IS NOT NULL)::int + (builder_template_id IS NOT NULL)::int = 1),
  CONSTRAINT cart_line_builder_has_config CHECK (
    builder_template_id IS NULL OR builder_config IS NOT NULL)
);

CREATE TABLE cart_line_add_ons (
  cart_line_id UUID NOT NULL REFERENCES cart_lines(id) ON DELETE CASCADE,
  add_on_id    UUID NOT NULL REFERENCES add_ons(id) ON DELETE CASCADE,
  price_paise  nonneg_paise NOT NULL,
  input_text   TEXT,
  PRIMARY KEY (cart_line_id, add_on_id)
);

-- ------------------------------------------------------------ 4.6 orders
CREATE TABLE orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no             TEXT NOT NULL UNIQUE CHECK (order_no ~ '^ACH[0-9]{6,}$'),
  customer_id          UUID REFERENCES customers(id) ON DELETE RESTRICT,
  corporate_account_id UUID REFERENCES corporate_accounts(id) ON DELETE SET NULL,
  cart_id              UUID REFERENCES carts(id) ON DELETE SET NULL,
  channel              TEXT NOT NULL DEFAULT 'website' CHECK (channel IN
                         ('website','mobile_app','whatsapp','corporate_portal','phone','admin')),
  currency             currency_code NOT NULL DEFAULT 'INR',

  -- Buyer snapshot: an order is a legal record and must not mutate.
  buyer_name           TEXT NOT NULL,
  buyer_email          CITEXT,
  buyer_mobile         mobile_in,

  recipient_name       TEXT,
  recipient_mobile     mobile_in,
  is_anonymous_gift    BOOLEAN NOT NULL DEFAULT false,
  gift_message         TEXT,

  ship_line1           TEXT NOT NULL,
  ship_line2           TEXT,
  ship_area            TEXT,
  ship_city            TEXT NOT NULL,
  ship_state_code      CHAR(2) NOT NULL REFERENCES gst_states(code) ON DELETE RESTRICT,
  ship_pincode         pincode NOT NULL,
  ship_country_code    CHAR(2) NOT NULL DEFAULT 'IN',

  bill_same_as_ship    BOOLEAN NOT NULL DEFAULT true,
  bill_name            TEXT,
  bill_line1           TEXT,
  bill_city            TEXT,
  bill_state_code      CHAR(2) REFERENCES gst_states(code) ON DELETE RESTRICT,
  bill_pincode         pincode,
  bill_gstin           gstin,

  -- Tax determination, frozen at order time
  place_of_supply_state_code CHAR(2) NOT NULL REFERENCES gst_states(code) ON DELETE RESTRICT,
  supplier_gstin       gstin,
  supplier_state_code  CHAR(2) REFERENCES gst_states(code) ON DELETE RESTRICT,
  is_interstate        BOOLEAN NOT NULL,
  is_export            BOOLEAN NOT NULL DEFAULT false,

  delivery_type        TEXT NOT NULL DEFAULT 'standard' CHECK (delivery_type IN
                         ('standard','scheduled','same_day','midnight','international')),
  requested_delivery_date DATE,
  delivery_slot        TEXT,
  fulfilment_warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,

  -- Money: all paise, line prices GST-inclusive
  subtotal_paise         nonneg_paise NOT NULL DEFAULT 0,
  coupon_discount_paise  nonneg_paise NOT NULL DEFAULT 0,
  auto_discount_paise    nonneg_paise NOT NULL DEFAULT 0,
  loyalty_discount_paise nonneg_paise NOT NULL DEFAULT 0,
  shipping_paise         nonneg_paise NOT NULL DEFAULT 0,
  cod_fee_paise          nonneg_paise NOT NULL DEFAULT 0,
  taxable_paise          nonneg_paise NOT NULL DEFAULT 0,
  cgst_paise             nonneg_paise NOT NULL DEFAULT 0,
  sgst_paise             nonneg_paise NOT NULL DEFAULT 0,
  igst_paise             nonneg_paise NOT NULL DEFAULT 0,
  cess_paise             nonneg_paise NOT NULL DEFAULT 0,
  round_off_paise        money_paise  NOT NULL DEFAULT 0
                           CHECK (round_off_paise BETWEEN -50 AND 50),
  total_paise            nonneg_paise NOT NULL DEFAULT 0,
  amount_paid_paise      nonneg_paise NOT NULL DEFAULT 0,
  amount_refunded_paise  nonneg_paise NOT NULL DEFAULT 0,

  coupon_code          TEXT,
  status               TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
                         'pending_payment','paid','confirmed','in_production',
                         'personalisation_pending','quality_check','packed','ready_to_ship',
                         'shipped','out_for_delivery','delivered','failed_delivery','rto',
                         'cancelled','refund_initiated','refunded')),
  payment_status       TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN
                         ('pending','paid','failed','partially_refunded','refunded','cod_due')),
  fulfilment_status    TEXT NOT NULL DEFAULT 'unfulfilled' CHECK (fulfilment_status IN
                         ('unfulfilled','partially_fulfilled','fulfilled','returned')),
  priority             TEXT NOT NULL DEFAULT 'standard'
                         CHECK (priority IN ('standard','high','vip')),
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  internal_notes       TEXT,

  placed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at         TIMESTAMPTZ,
  shipped_at           TIMESTAMPTZ,
  delivered_at         TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  cancel_reason        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           UUID REFERENCES staff_users(id) ON DELETE SET NULL,

  CONSTRAINT order_tax_split_consistent CHECK (
    (is_interstate AND cgst_paise = 0 AND sgst_paise = 0)
    OR (NOT is_interstate AND igst_paise = 0)),
  CONSTRAINT order_cgst_equals_sgst     CHECK (cgst_paise = sgst_paise),
  CONSTRAINT order_refund_not_over_paid CHECK (amount_refunded_paise <= amount_paid_paise),
  CONSTRAINT order_cancel_has_reason    CHECK (cancelled_at IS NULL OR cancel_reason IS NOT NULL),
  CONSTRAINT order_billing_complete     CHECK (
    bill_same_as_ship OR (bill_name IS NOT NULL AND bill_line1 IS NOT NULL
                          AND bill_state_code IS NOT NULL))
);

-- close the carts <-> orders cycle
ALTER TABLE carts ADD CONSTRAINT carts_converted_order_id_fkey
  FOREIGN KEY (converted_order_id) REFERENCES orders(id) ON DELETE SET NULL;

CREATE TABLE order_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id          UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  builder_template_id UUID REFERENCES builder_templates(id) ON DELETE RESTRICT,
  builder_config      JSONB,

  -- Snapshots: the catalogue will change; the order must not.
  sku_snapshot           TEXT NOT NULL,
  title_snapshot         TEXT NOT NULL,
  variant_label_snapshot TEXT,
  image_url_snapshot     TEXT,
  hsn_snapshot           hsn,

  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_paise    nonneg_paise NOT NULL,      -- GST-inclusive
  line_discount_paise nonneg_paise NOT NULL DEFAULT 0,
  allocated_order_discount_paise nonneg_paise NOT NULL DEFAULT 0,
  gross_paise         nonneg_paise NOT NULL,      -- qty*unit - discounts
  gst_rate_bp         percent_bp NOT NULL DEFAULT 0,
  taxable_paise       nonneg_paise NOT NULL DEFAULT 0,
  cgst_paise          nonneg_paise NOT NULL DEFAULT 0,
  sgst_paise          nonneg_paise NOT NULL DEFAULT 0,
  igst_paise          nonneg_paise NOT NULL DEFAULT 0,
  cess_paise          nonneg_paise NOT NULL DEFAULT 0,

  fulfilment_status   TEXT NOT NULL DEFAULT 'unfulfilled' CHECK (fulfilment_status IN
                        ('unfulfilled','allocated','picked','packed','fulfilled',
                         'cancelled','returned')),
  fulfilled_qty       INTEGER NOT NULL DEFAULT 0 CHECK (fulfilled_qty >= 0),
  returned_qty        INTEGER NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  position            INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_line_exactly_one_kind CHECK (
    (variant_id IS NOT NULL)::int + (builder_template_id IS NOT NULL)::int = 1),
  CONSTRAINT order_line_fulfil_bounds   CHECK (fulfilled_qty <= quantity),
  CONSTRAINT order_line_return_bounds   CHECK (returned_qty <= quantity),
  CONSTRAINT order_line_discount_bounds CHECK (
    line_discount_paise + allocated_order_discount_paise <= unit_price_paise * quantity),
  CONSTRAINT order_line_tax_split CHECK (
    (igst_paise = 0) OR (cgst_paise = 0 AND sgst_paise = 0))
);

CREATE TABLE order_line_add_ons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id UUID NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  add_on_id     UUID REFERENCES add_ons(id) ON DELETE SET NULL,
  name_snapshot TEXT NOT NULL,
  price_paise   nonneg_paise NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  input_text    TEXT,
  gst_rate_bp   percent_bp NOT NULL DEFAULT 0,
  hsn_snapshot  hsn
);

CREATE TABLE order_line_personalisations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id  UUID NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  template_id    UUID REFERENCES personalisation_templates(id) ON DELETE SET NULL,
  method         TEXT NOT NULL,
  input_text     TEXT,
  input_media_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  proof_media_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  proof_status   TEXT NOT NULL DEFAULT 'not_required' CHECK (proof_status IN
                   ('not_required','pending','sent','approved','rejected')),
  approved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only (Tier 1).
CREATE TABLE order_timeline (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type     TEXT NOT NULL,        -- 'order.placed' | 'payment.captured' | ...
  label          TEXT NOT NULL,
  note           TEXT,
  actor_kind     TEXT NOT NULL DEFAULT 'system'
                   CHECK (actor_kind IN ('customer','staff','system','courier','gateway')),
  actor_staff_id UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  actor_label    TEXT,                 -- 'Razorpay' | 'Blue Dart'
  metadata       JSONB
);

CREATE TABLE reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id   UUID REFERENCES customers(id) ON DELETE SET NULL,
  order_line_id UUID REFERENCES order_lines(id) ON DELETE SET NULL,  -- verified purchase
  author_name   TEXT NOT NULL,
  rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title         TEXT,
  body          TEXT,
  is_featured   BOOLEAN NOT NULL DEFAULT false,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','published','rejected')),
  moderated_by  UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  moderated_at  TIMESTAMPTZ,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE returns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_no    TEXT NOT NULL UNIQUE,          -- 'RET-2026-00001'
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  customer_id  UUID REFERENCES customers(id) ON DELETE SET NULL,
  reason       TEXT NOT NULL CHECK (reason IN
                 ('damaged_in_transit','wrong_item','late_delivery',
                  'quality_not_as_expected','changed_mind','personalisation_error','other')),
  reason_note  TEXT,
  status       TEXT NOT NULL DEFAULT 'requested' CHECK (status IN
                 ('requested','approved','picked_up','received','refunded','rejected')),
  refund_mode  TEXT NOT NULL DEFAULT 'original'
                 CHECK (refund_mode IN ('original','store_credit','bank_transfer')),
  refund_paise nonneg_paise NOT NULL DEFAULT 0,
  restock      BOOLEAN NOT NULL DEFAULT true,
  pickup_awb   TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  approved_by  UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE return_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id     UUID NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_line_id UUID NOT NULL REFERENCES order_lines(id) ON DELETE RESTRICT,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  refund_paise  nonneg_paise NOT NULL DEFAULT 0,
  condition     TEXT CHECK (condition IN ('sellable','damaged','opened','missing_parts')),
  UNIQUE (return_id, order_line_id)
);

CREATE TABLE exchanges (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_no          TEXT NOT NULL UNIQUE,
  order_id             UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  order_line_id        UUID REFERENCES order_lines(id) ON DELETE SET NULL,
  from_variant_id      UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  to_variant_id        UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity             INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  price_diff_paise     money_paise NOT NULL DEFAULT 0,   -- may be negative
  status               TEXT NOT NULL DEFAULT 'requested' CHECK (status IN
                         ('requested','approved','dispatched','completed','rejected')),
  replacement_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exchange_variants_differ CHECK (from_variant_id IS DISTINCT FROM to_variant_id)
);

-- ------------------------------------------------------------ 4.7 payments, invoicing & credit
CREATE TABLE gift_cards (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash             TEXT NOT NULL UNIQUE,     -- hash, never the plaintext code
  code_last4            CHAR(4) NOT NULL,
  initial_value_paise   nonneg_paise NOT NULL CHECK (initial_value_paise > 0),
  balance_paise         nonneg_paise NOT NULL,
  currency              currency_code NOT NULL DEFAULT 'INR',
  issued_to_name        TEXT,
  issued_to_email       CITEXT,
  issued_to_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  purchase_order_id     UUID REFERENCES orders(id) ON DELETE SET NULL,
  issued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_on            DATE,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','redeemed','expired','void')),
  created_by            UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT giftcard_balance_bounds   CHECK (balance_paise <= initial_value_paise),
  CONSTRAINT giftcard_redeemed_is_zero CHECK (status <> 'redeemed' OR balance_paise = 0)
);

CREATE TABLE payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  gateway            TEXT NOT NULL CHECK (gateway IN
                       ('razorpay','payu','cashfree','gift_card','cod','manual','bank_transfer')),
  method             TEXT NOT NULL CHECK (method IN
                       ('upi','credit_card','debit_card','net_banking','wallet',
                        'cod','corporate_credit','gift_card','emi','bank_transfer')),
  gateway_payment_id TEXT,     -- 'pay_XXXXXXXX'
  gateway_order_id   TEXT,
  gateway_signature  TEXT,
  amount_paise       nonneg_paise NOT NULL CHECK (amount_paise > 0),
  fee_paise          nonneg_paise NOT NULL DEFAULT 0,
  tax_on_fee_paise   nonneg_paise NOT NULL DEFAULT 0,
  currency           currency_code NOT NULL DEFAULT 'INR',
  status             TEXT NOT NULL DEFAULT 'created' CHECK (status IN
                       ('created','authorised','captured','failed','cancelled','refunded')),
  failure_code       TEXT,
  failure_reason     TEXT,
  is_settled         BOOLEAN NOT NULL DEFAULT false,
  settled_at         TIMESTAMPTZ,
  settlement_ref     TEXT,
  authorised_at      TIMESTAMPTZ,
  captured_at        TIMESTAMPTZ,
  idempotency_key    TEXT UNIQUE,          -- prevents double-capture on retry
  gift_card_id       UUID REFERENCES gift_cards(id) ON DELETE SET NULL,
  raw_payload        JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_captured_has_time CHECK (status <> 'captured' OR captured_at IS NOT NULL),
  CONSTRAINT payment_failed_has_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
  CONSTRAINT payment_giftcard_link     CHECK (method <> 'gift_card' OR gift_card_id IS NOT NULL)
);

-- Raw webhook receipts. The unique event id is the idempotency boundary.
CREATE TABLE payment_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway          TEXT NOT NULL,
  gateway_event_id TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  payment_id       UUID REFERENCES payments(id) ON DELETE SET NULL,
  order_id         UUID REFERENCES orders(id) ON DELETE SET NULL,
  signature_valid  BOOLEAN NOT NULL DEFAULT false,
  payload          JSONB NOT NULL,
  processed_at     TIMESTAMPTZ,
  process_error    TEXT,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway, gateway_event_id)
);

CREATE TABLE refunds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_no         TEXT NOT NULL UNIQUE,
  payment_id        UUID REFERENCES payments(id) ON DELETE RESTRICT,
  order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  return_id         UUID REFERENCES returns(id) ON DELETE SET NULL,
  amount_paise      nonneg_paise NOT NULL CHECK (amount_paise > 0),
  mode              TEXT NOT NULL DEFAULT 'original'
                      CHECK (mode IN ('original','store_credit','bank_transfer','gift_card')),
  gateway_refund_id TEXT,
  status            TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN
                      ('initiated','processing','completed','failed')),
  reason            TEXT NOT NULL,
  approved_by       UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  initiated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  idempotency_key   TEXT UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable once issued (Tier 1): corrections are credit notes, never UPDATEs.
CREATE TABLE invoices (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no                 TEXT NOT NULL UNIQUE,     -- 'ACH/26-27/000001' (16 chars)
  series_id                  UUID NOT NULL REFERENCES document_number_series(id) ON DELETE RESTRICT,
  order_id                   UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  supplier_gstin             gstin,
  supplier_state_code        CHAR(2) NOT NULL REFERENCES gst_states(code) ON DELETE RESTRICT,
  buyer_name                 TEXT NOT NULL,
  buyer_gstin                gstin,
  buyer_address              TEXT NOT NULL,
  place_of_supply_state_code CHAR(2) NOT NULL REFERENCES gst_states(code) ON DELETE RESTRICT,
  is_reverse_charge          BOOLEAN NOT NULL DEFAULT false,
  taxable_paise              nonneg_paise NOT NULL,
  cgst_paise                 nonneg_paise NOT NULL DEFAULT 0,
  sgst_paise                 nonneg_paise NOT NULL DEFAULT 0,
  igst_paise                 nonneg_paise NOT NULL DEFAULT 0,
  cess_paise                 nonneg_paise NOT NULL DEFAULT 0,
  round_off_paise            money_paise NOT NULL DEFAULT 0,
  total_paise                nonneg_paise NOT NULL,
  irn                        TEXT UNIQUE,
  irn_ack_no                 TEXT,
  irn_ack_date               TIMESTAMPTZ,
  qr_payload                 TEXT,
  eway_bill_no               TEXT,
  pdf_media_id               UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  issued_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  financial_year             TEXT NOT NULL CHECK (financial_year ~ '^[0-9]{2}-[0-9]{2}$'),
  status                     TEXT NOT NULL DEFAULT 'issued'
                               CHECK (status IN ('issued','cancelled')),
  cancelled_at               TIMESTAMPTZ,
  cancel_reason              TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoice_tax_split CHECK (
    (igst_paise = 0) OR (cgst_paise = 0 AND sgst_paise = 0)),
  CONSTRAINT invoice_cgst_equals_sgst CHECK (cgst_paise = sgst_paise),
  CONSTRAINT invoice_total_balances CHECK (
    total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise
                  + cess_paise + round_off_paise),
  CONSTRAINT invoice_cancel_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
  CONSTRAINT invoice_no_max_16 CHECK (length(invoice_no) <= 16)
);

CREATE TABLE invoice_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_line_id    UUID REFERENCES order_lines(id) ON DELETE SET NULL,
  description      TEXT NOT NULL,
  hsn_code         hsn NOT NULL,
  quantity         NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit             TEXT NOT NULL DEFAULT 'PCS',
  unit_price_paise nonneg_paise NOT NULL,
  discount_paise   nonneg_paise NOT NULL DEFAULT 0,
  taxable_paise    nonneg_paise NOT NULL,
  gst_rate_bp      percent_bp NOT NULL,
  cgst_paise       nonneg_paise NOT NULL DEFAULT 0,
  sgst_paise       nonneg_paise NOT NULL DEFAULT 0,
  igst_paise       nonneg_paise NOT NULL DEFAULT 0,
  cess_paise       nonneg_paise NOT NULL DEFAULT 0,
  line_total_paise nonneg_paise NOT NULL,
  position         INTEGER NOT NULL DEFAULT 0
);

-- CORRECTION 1 (7.1): the series prefix is 'CN/26-27/' with pad_width 6, giving
-- 'CN/26-27/000001' = 15 chars. The original 'ACHCN/26-27/000001' was 18 and
-- breached the 16-character cap in Rule 46(b) of the CGST Rules.
CREATE TABLE credit_notes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_no TEXT NOT NULL UNIQUE,     -- 'CN/26-27/000001'
  series_id      UUID NOT NULL REFERENCES document_number_series(id) ON DELETE RESTRICT,
  invoice_id     UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  return_id      UUID REFERENCES returns(id) ON DELETE SET NULL,
  reason         TEXT NOT NULL CHECK (reason IN
                   ('sales_return','post_sale_discount','deficiency_in_service',
                    'correction_in_invoice','order_cancelled','other')),
  taxable_paise  nonneg_paise NOT NULL,
  cgst_paise     nonneg_paise NOT NULL DEFAULT 0,
  sgst_paise     nonneg_paise NOT NULL DEFAULT 0,
  igst_paise     nonneg_paise NOT NULL DEFAULT 0,
  cess_paise     nonneg_paise NOT NULL DEFAULT 0,
  total_paise    nonneg_paise NOT NULL,
  irn            TEXT UNIQUE,
  financial_year TEXT NOT NULL CHECK (financial_year ~ '^[0-9]{2}-[0-9]{2}$'),
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  pdf_media_id   UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cn_tax_split         CHECK ((igst_paise = 0) OR (cgst_paise = 0 AND sgst_paise = 0)),
  CONSTRAINT cn_cgst_equals_sgst  CHECK (cgst_paise = sgst_paise),
  CONSTRAINT cn_no_max_16         CHECK (length(credit_note_no) <= 16)
);

CREATE TABLE credit_note_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id  UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  invoice_line_id UUID REFERENCES invoice_lines(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  hsn_code        hsn NOT NULL,
  quantity        NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  taxable_paise   nonneg_paise NOT NULL,
  gst_rate_bp     percent_bp NOT NULL,
  cgst_paise      nonneg_paise NOT NULL DEFAULT 0,
  sgst_paise      nonneg_paise NOT NULL DEFAULT 0,
  igst_paise      nonneg_paise NOT NULL DEFAULT 0,
  cess_paise      nonneg_paise NOT NULL DEFAULT 0,
  position        INTEGER NOT NULL DEFAULT 0
);

-- Ledger, so the balance is always reconstructible.
CREATE TABLE gift_card_transactions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gift_card_id  UUID NOT NULL REFERENCES gift_cards(id) ON DELETE RESTRICT,
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  payment_id    UUID REFERENCES payments(id) ON DELETE SET NULL,
  delta_paise   money_paise NOT NULL CHECK (delta_paise <> 0),
  balance_after nonneg_paise NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('issue','redeem','refund','adjustment','expiry')),
  note          TEXT,
  actor_id      UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ 4.5 inventory movement & procurement
CREATE TABLE inventory_reservations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_level_id UUID NOT NULL REFERENCES inventory_levels(id) ON DELETE CASCADE,
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  cart_id            UUID REFERENCES carts(id) ON DELETE CASCADE,
  order_id           UUID REFERENCES orders(id) ON DELETE CASCADE,
  reason             TEXT NOT NULL DEFAULT 'cart'
                       CHECK (reason IN ('cart','order','manual_hold','quotation')),
  expires_at         TIMESTAMPTZ,     -- NULL for order-backed reservations
  released_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reservation_has_owner CHECK (
    cart_id IS NOT NULL OR order_id IS NOT NULL OR reason = 'manual_hold'),
  CONSTRAINT reservation_cart_expires CHECK (reason <> 'cart' OR expires_at IS NOT NULL)
);

-- Append-only ledger. Every change to on_hand_qty writes exactly one row.
CREATE TABLE stock_movements (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_level_id UUID NOT NULL REFERENCES inventory_levels(id) ON DELETE RESTRICT,
  movement_type      TEXT NOT NULL CHECK (movement_type IN
                       ('inbound','outbound','adjustment','transfer_out','transfer_in',
                        'damage','return_in')),
  quantity_delta     INTEGER NOT NULL CHECK (quantity_delta <> 0),
  balance_after      INTEGER NOT NULL CHECK (balance_after >= 0),
  reference_type     TEXT CHECK (reference_type IN
                       ('purchase_order','goods_receipt','order','stock_transfer',
                        'return','adjustment','import')),
  reference_id       UUID,
  reference_label    TEXT,        -- 'PO-2291' / 'ACH104422' for display
  note               TEXT,
  actor_id           UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no          TEXT NOT NULL UNIQUE,           -- 'PO-2026-02291'
  supplier_id    UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  warehouse_id   UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                   ('draft','sent','partially_received','received','cancelled')),
  currency       currency_code NOT NULL DEFAULT 'INR',
  subtotal_paise nonneg_paise NOT NULL DEFAULT 0,
  tax_paise      nonneg_paise NOT NULL DEFAULT 0,
  total_paise    nonneg_paise NOT NULL DEFAULT 0,
  expected_on    DATE,
  sent_at        TIMESTAMPTZ,
  closed_at      TIMESTAMPTZ,
  notes          TEXT,
  created_by     UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_order_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  hamper_item_id    UUID REFERENCES hamper_items(id) ON DELETE RESTRICT,
  variant_id        UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  packaging_id      UUID REFERENCES packaging_materials(id) ON DELETE RESTRICT,
  description       TEXT NOT NULL,
  ordered_qty       INTEGER NOT NULL CHECK (ordered_qty > 0),
  received_qty      INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  unit_cost_paise   nonneg_paise NOT NULL,
  gst_rate_bp       percent_bp NOT NULL DEFAULT 0,
  line_total_paise  nonneg_paise NOT NULL,
  position          INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT po_line_exactly_one_item CHECK (
    (hamper_item_id IS NOT NULL)::int + (variant_id IS NOT NULL)::int
    + (packaging_id IS NOT NULL)::int = 1),
  CONSTRAINT po_line_no_over_receipt CHECK (received_qty <= ordered_qty)
);

CREATE TABLE goods_receipts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_no              TEXT NOT NULL UNIQUE,          -- 'GRN-2026-00912'
  purchase_order_id   UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  warehouse_id        UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  received_on         DATE NOT NULL DEFAULT CURRENT_DATE,
  qc_status           TEXT NOT NULL DEFAULT 'passed'
                        CHECK (qc_status IN ('passed','partial','failed')),
  inspector_id        UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  supplier_invoice_no TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE goods_receipt_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id UUID NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  po_line_id       UUID NOT NULL REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  accepted_qty     INTEGER NOT NULL DEFAULT 0 CHECK (accepted_qty >= 0),
  rejected_qty     INTEGER NOT NULL DEFAULT 0 CHECK (rejected_qty >= 0),
  rejection_reason TEXT,
  batch_no         TEXT,
  expiry_on        DATE,
  CONSTRAINT grn_line_some_qty          CHECK (accepted_qty + rejected_qty > 0),
  CONSTRAINT grn_rejection_needs_reason CHECK (rejected_qty = 0 OR rejection_reason IS NOT NULL)
);

CREATE TABLE stock_transfers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no       TEXT NOT NULL UNIQUE,        -- 'TRF-2026-00061'
  from_warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  to_warehouse_id   UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  status            TEXT NOT NULL DEFAULT 'requested' CHECK (status IN
                      ('requested','approved','in_transit','received','cancelled')),
  dispatched_at     TIMESTAMPTZ,
  eta_on            DATE,
  received_at       TIMESTAMPTZ,
  requested_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transfer_distinct_warehouses CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE stock_transfer_lines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id    UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  variant_id     UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  hamper_item_id UUID REFERENCES hamper_items(id) ON DELETE RESTRICT,
  sent_qty       INTEGER NOT NULL CHECK (sent_qty > 0),
  received_qty   INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  CONSTRAINT transfer_line_exactly_one     CHECK (
    (variant_id IS NOT NULL)::int + (hamper_item_id IS NOT NULL)::int = 1),
  CONSTRAINT transfer_line_no_over_receipt CHECK (received_qty <= sent_qty)
);

-- ------------------------------------------------------------ 4.8 corporate gifting
CREATE TABLE corporate_leads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_no           TEXT NOT NULL UNIQUE,
  company_name      TEXT NOT NULL,
  contact_name      TEXT NOT NULL,
  email             CITEXT NOT NULL,
  mobile            mobile_in,
  city              TEXT,
  state_code        CHAR(2) REFERENCES gst_states(code) ON DELETE RESTRICT,
  employee_count    INTEGER CHECK (employee_count IS NULL OR employee_count > 0),
  quantity_needed   INTEGER CHECK (quantity_needed IS NULL OR quantity_needed > 0),
  budget_paise      nonneg_paise,
  occasion          TEXT,
  brief             TEXT,
  source            TEXT,
  stage             TEXT NOT NULL DEFAULT 'new' CHECK (stage IN
                      ('new','qualified','proposal_sent','negotiation','won','lost')),
  lost_reason       TEXT,
  owner_id          UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  account_id        UUID REFERENCES corporate_accounts(id) ON DELETE SET NULL,
  next_follow_up_on DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT lead_lost_has_reason CHECK (stage <> 'lost' OR lost_reason IS NOT NULL)
);

CREATE TABLE corporate_account_contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES corporate_accounts(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  email       CITEXT NOT NULL,
  mobile      mobile_in,
  designation TEXT,
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  can_approve BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quotations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_no       TEXT NOT NULL UNIQUE,        -- 'QT/26-27/00001'
  account_id         UUID REFERENCES corporate_accounts(id) ON DELETE SET NULL,
  lead_id            UUID REFERENCES corporate_leads(id) ON DELETE SET NULL,
  company_name       TEXT NOT NULL,               -- snapshot
  currency           currency_code NOT NULL DEFAULT 'INR',
  subtotal_paise     nonneg_paise NOT NULL DEFAULT 0,
  discount_paise     nonneg_paise NOT NULL DEFAULT 0,
  tax_paise          nonneg_paise NOT NULL DEFAULT 0,
  total_paise        nonneg_paise NOT NULL DEFAULT 0,
  margin_bp          percent_bp,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                       ('draft','sent','awaiting_approval','approved','rejected','converted','expired')),
  valid_till         DATE,
  owner_id           UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  converted_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  pdf_media_id       UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  sent_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT quotation_lead_or_account      CHECK (account_id IS NOT NULL OR lead_id IS NOT NULL),
  CONSTRAINT quotation_converted_has_order  CHECK (
    status <> 'converted' OR converted_order_id IS NOT NULL)
);

CREATE TABLE quotation_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id        UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  variant_id          UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  builder_template_id UUID REFERENCES builder_templates(id) ON DELETE SET NULL,
  description         TEXT NOT NULL,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_paise    nonneg_paise NOT NULL,
  unit_cost_paise     nonneg_paise,
  discount_bp         percent_bp NOT NULL DEFAULT 0,
  gst_rate_bp         percent_bp NOT NULL DEFAULT 0,
  line_total_paise    nonneg_paise NOT NULL,
  branding_note       TEXT,       -- 'Printed with your logo'
  position            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE corporate_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_no     TEXT NOT NULL UNIQUE,
  account_id      UUID NOT NULL REFERENCES corporate_accounts(id) ON DELETE RESTRICT,
  quotation_id    UUID REFERENCES quotations(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  budget_paise    nonneg_paise NOT NULL DEFAULT 0,
  window_start_on DATE,
  window_end_on   DATE,
  status          TEXT NOT NULL DEFAULT 'planning' CHECK (status IN
                    ('planning','recipients_pending','in_dispatch','completed','cancelled')),
  owner_id        UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campaign_window CHECK (
    window_end_on IS NULL OR window_start_on IS NULL OR window_end_on >= window_start_on)
);

CREATE TABLE campaign_recipients (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES corporate_campaigns(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  email            CITEXT,
  mobile           mobile_in,
  employee_code    TEXT,
  line1            TEXT,
  line2            TEXT,
  city             TEXT,
  state_code       CHAR(2) REFERENCES gst_states(code) ON DELETE RESTRICT,
  pincode          pincode,
  variant_id       UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  gift_message     TEXT,
  order_id         UUID REFERENCES orders(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN
                     ('uploaded','validated','invalid','ordered','dispatched','delivered','failed')),
  validation_error TEXT,
  import_job_id    UUID REFERENCES import_jobs(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campaign_recipient_invalid_has_error CHECK (
    status <> 'invalid' OR validation_error IS NOT NULL)
);

-- Polymorphic approval queue.
CREATE TABLE approvals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_no   TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('quotation_discount','credit_limit','refund','price_change','bulk_cancellation')),
  subject_table TEXT NOT NULL CHECK (subject_table IN
                  ('quotations','corporate_accounts','refunds','product_variants','orders')),
  subject_id    UUID NOT NULL,
  subject_label TEXT,                 -- 'QT/26-27/00001' for display
  amount_paise  money_paise,
  justification TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','withdrawn')),
  requested_by  UUID NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  approver_id   UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  CONSTRAINT approval_decided_has_approver CHECK (
    status IN ('pending','withdrawn') OR (approver_id IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT approval_not_self_approved CHECK (approver_id IS DISTINCT FROM requested_by)
);

-- ------------------------------------------------------------ 4.9 delivery & fulfilment
CREATE TABLE delivery_zones (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,           -- 'Mumbai Metro'
  city              TEXT,
  state_code        CHAR(2) REFERENCES gst_states(code) ON DELETE RESTRICT,
  tier              TEXT CHECK (tier IN ('metro','tier_1','tier_2','tier_3','remote','international')),
  supports_same_day BOOLEAN NOT NULL DEFAULT false,
  supports_midnight BOOLEAN NOT NULL DEFAULT false,
  supports_cod      BOOLEAN NOT NULL DEFAULT true,
  base_fee_paise    nonneg_paise NOT NULL DEFAULT 0,
  same_day_cutoff   TIME,                    -- '15:00'
  standard_tat_days SMALLINT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serviceability needs the actual pincodes, indexed for O(1) lookup at checkout.
CREATE TABLE delivery_zone_pincodes (
  pincode        pincode PRIMARY KEY,
  zone_id        UUID NOT NULL REFERENCES delivery_zones(id) ON DELETE CASCADE,
  city           TEXT,
  state_code     CHAR(2) REFERENCES gst_states(code) ON DELETE RESTRICT,
  is_serviceable BOOLEAN NOT NULL DEFAULT true,
  cod_allowed    BOOLEAN NOT NULL DEFAULT true,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE couriers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   TEXT NOT NULL UNIQUE,      -- 'bluedart'
  name                   TEXT NOT NULL UNIQUE,
  services               TEXT[] NOT NULL DEFAULT '{}',
  supports_cod           BOOLEAN NOT NULL DEFAULT true,
  supports_international BOOLEAN NOT NULL DEFAULT false,
  tracking_url_template  TEXT,     -- 'https://.../track?awb={awb}'
  api_integration_id     UUID REFERENCES integrations(id) ON DELETE SET NULL,
  base_cost_paise        nonneg_paise NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'disconnected'
                           CHECK (status IN ('connected','disconnected','error')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- onTime / ndrRate / rtoRate are computed metrics, not stored.
CREATE TABLE courier_performance_daily (
  courier_id UUID NOT NULL REFERENCES couriers(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  shipments  INTEGER NOT NULL DEFAULT 0,
  on_time    INTEGER NOT NULL DEFAULT 0,
  ndr_count  INTEGER NOT NULL DEFAULT 0,
  rto_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (courier_id, day)
);

CREATE TABLE shipping_rules (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  priority             INTEGER NOT NULL,       -- lower wins; evaluated in order
  conditions           JSONB NOT NULL,         -- executable DSL
  condition_text       TEXT,                   -- 'order_total >= 2999' — display only
  charge_kind          TEXT NOT NULL CHECK (charge_kind IN ('free','flat','percent','per_kg','table')),
  charge_paise         nonneg_paise NOT NULL DEFAULT 0,
  charge_bp            percent_bp,
  preferred_courier_id UUID REFERENCES couriers(id) ON DELETE SET NULL,
  stops_evaluation     BOOLEAN NOT NULL DEFAULT true,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_no          TEXT NOT NULL UNIQUE,
  order_id             UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  warehouse_id         UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  courier_id           UUID REFERENCES couriers(id) ON DELETE SET NULL,
  awb                  TEXT,
  label_media_id       UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  packaging_id         UUID REFERENCES packaging_materials(id) ON DELETE SET NULL,
  weight_grams         INTEGER CHECK (weight_grams IS NULL OR weight_grams > 0),
  declared_value_paise nonneg_paise,
  shipping_cost_paise  nonneg_paise NOT NULL DEFAULT 0,
  is_cod               BOOLEAN NOT NULL DEFAULT false,
  cod_amount_paise     nonneg_paise NOT NULL DEFAULT 0,
  cod_remitted_at      TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'label_created' CHECK (status IN
                         ('label_created','picked_up','in_transit','out_for_delivery',
                          'delivered','exception','rto_initiated','rto_delivered','cancelled')),
  attempts             SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  dispatched_at        TIMESTAMPTZ,
  eta_on               DATE,
  delivered_at         TIMESTAMPTZ,
  delivered_to         TEXT,
  pod_media_id         UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipment_cod_amount         CHECK (is_cod OR cod_amount_paise = 0),
  CONSTRAINT shipment_delivered_has_time CHECK (status <> 'delivered' OR delivered_at IS NOT NULL)
);

CREATE TABLE shipment_lines (
  shipment_id   UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_line_id UUID NOT NULL REFERENCES order_lines(id) ON DELETE RESTRICT,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (shipment_id, order_line_id)
);

CREATE TABLE shipment_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id  UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  occurred_at  TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL,
  location     TEXT,
  description  TEXT,
  courier_code TEXT,
  raw_payload  JSONB,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE delivery_exceptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_no    TEXT NOT NULL UNIQUE,
  shipment_id     UUID REFERENCES shipments(id) ON DELETE CASCADE,
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  kind            TEXT NOT NULL CHECK (kind IN ('ndr','rto','delay','damage','address_issue','lost')),
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN
                    ('open','customer_contacted','reattempt_scheduled','resolved','written_off')),
  owner_id        UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  reattempt_on    DATE,
  raised_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ 4.10 promotions & loyalty
CREATE TABLE coupons (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 TEXT NOT NULL CHECK (code = upper(code) AND code ~ '^[A-Z0-9_-]{3,32}$'),
  description          TEXT,
  discount_type        TEXT NOT NULL CHECK (discount_type IN
                         ('percent','flat','free_shipping','bogo','free_gift')),
  discount_bp          percent_bp,          -- for 'percent'
  discount_paise       nonneg_paise,        -- for 'flat'
  max_discount_paise   nonneg_paise,        -- caps a percent coupon
  min_order_paise      nonneg_paise NOT NULL DEFAULT 0,
  bogo_buy_qty         SMALLINT,
  bogo_get_qty         SMALLINT,
  free_gift_variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  applies_to           TEXT NOT NULL DEFAULT 'all'
                         CHECK (applies_to IN ('all','collections','products','first_order')),
  channels             TEXT[] NOT NULL DEFAULT '{}',   -- {} = all channels
  max_redemptions      INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  max_redemptions_per_customer INTEGER NOT NULL DEFAULT 1
                         CHECK (max_redemptions_per_customer > 0),
  redemption_count     INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  stackable            BOOLEAN NOT NULL DEFAULT false,
  starts_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at              TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('active','scheduled','expired','paused','draft')),
  created_by           UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ,
  CONSTRAINT coupon_within_limit CHECK (
    max_redemptions IS NULL OR redemption_count <= max_redemptions),
  CONSTRAINT coupon_window            CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT coupon_percent_needs_bp  CHECK (discount_type <> 'percent' OR discount_bp IS NOT NULL),
  CONSTRAINT coupon_flat_needs_paise  CHECK (discount_type <> 'flat' OR discount_paise IS NOT NULL),
  CONSTRAINT coupon_bogo_needs_qty    CHECK (
    discount_type <> 'bogo' OR (bogo_buy_qty IS NOT NULL AND bogo_get_qty IS NOT NULL)),
  CONSTRAINT coupon_gift_needs_variant CHECK (
    discount_type <> 'free_gift' OR free_gift_variant_id IS NOT NULL)
);

CREATE TABLE coupon_scope (
  coupon_id     UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  collection_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  product_id    UUID REFERENCES products(id) ON DELETE CASCADE,
  is_exclusion  BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT coupon_scope_exactly_one CHECK (
    (collection_id IS NOT NULL)::int + (product_id IS NOT NULL)::int = 1)
);

CREATE TABLE coupon_redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id       UUID NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  discount_paise  nonneg_paise NOT NULL,
  redeemed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at     TIMESTAMPTZ,     -- set when the order is cancelled
  reversal_reason TEXT
);

CREATE TABLE auto_discounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  rule           JSONB NOT NULL,
  rule_text      TEXT,             -- 'cart_items >= 2 AND category = hampers'
  discount_type  TEXT NOT NULL CHECK (discount_type IN
                   ('percent','flat','free_shipping','free_gift_wrap','free_gift')),
  discount_bp    percent_bp,
  discount_paise nonneg_paise,
  priority       INTEGER NOT NULL DEFAULT 100,
  stackable      BOOLEAN NOT NULL DEFAULT false,
  starts_at      TIMESTAMPTZ,
  ends_at        TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('active','draft','expired')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE TABLE bundles (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle             handle NOT NULL,          -- partial unique (soft-deletable)
  name               TEXT NOT NULL,
  bundle_price_paise nonneg_paise NOT NULL,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('active','draft','archived')),
  starts_at          TIMESTAMPTZ,
  ends_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

CREATE TABLE bundle_items (
  bundle_id  UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bundle_id, variant_id)
);

CREATE TABLE upsell_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  trigger           JSONB NOT NULL,
  trigger_text      TEXT,          -- 'Hamper added to cart'
  offer_kind        TEXT NOT NULL CHECK (offer_kind IN
                      ('add_on','product','discount','free_shipping')),
  offer_add_on_id   UUID REFERENCES add_ons(id) ON DELETE CASCADE,
  offer_variant_id  UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  offer_price_paise nonneg_paise,
  offer_discount_bp percent_bp,
  placement         TEXT NOT NULL CHECK (placement IN
                      ('pdp','cart','cart_drawer','checkout','post_purchase')),
  priority          INTEGER NOT NULL DEFAULT 100,
  status            TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('active','paused')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_tiers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL UNIQUE,        -- Silver | Gold | Platinum | Noir
  rank                 SMALLINT NOT NULL UNIQUE,
  threshold_paise      nonneg_paise NOT NULL,       -- lifetime spend to qualify
  points_per_100_paise NUMERIC(6,3) NOT NULL DEFAULT 1,
  perks                TEXT,
  is_invite_only       BOOLEAN NOT NULL DEFAULT false,
  free_same_day        BOOLEAN NOT NULL DEFAULT false,
  free_gift_wrap       BOOLEAN NOT NULL DEFAULT false,
  discount_bp          percent_bp NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_accounts (
  customer_id     UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  tier_id         UUID REFERENCES loyalty_tiers(id) ON DELETE SET NULL,
  points_balance  INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  points_lifetime INTEGER NOT NULL DEFAULT 0 CHECK (points_lifetime >= 0),
  tier_since      DATE,
  tier_expires_on DATE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_transactions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  points_delta  INTEGER NOT NULL CHECK (points_delta <> 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  kind          TEXT NOT NULL CHECK (kind IN
                  ('earn','redeem','expire','adjustment','referral_bonus','signup_bonus')),
  note          TEXT,
  expires_on    DATE,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE referrals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  code                 TEXT NOT NULL UNIQUE,
  reward_kind          TEXT NOT NULL DEFAULT 'points'
                         CHECK (reward_kind IN ('points','coupon','store_credit')),
  reward_value         INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CORRECTION 4 (7.4): the self-referral rule is the forbid_self_referral()
-- BEFORE INSERT OR UPDATE trigger below, NOT a CHECK containing a subquery
-- (PostgreSQL rejects subqueries in CHECK constraints).
CREATE TABLE referral_conversions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id         UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  invited_email       CITEXT,
  invited_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  first_order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('invited','signed_up','converted','rewarded','void')),
  reward_issued_paise nonneg_paise NOT NULL DEFAULT 0,
  invited_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted_at        TIMESTAMPTZ
);

-- ------------------------------------------------------------ 4.11 content & CMS
CREATE TABLE cms_sections (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key        handle NOT NULL UNIQUE,     -- 'hero-carousel' | 'shop-by-occasion'
  page_key   TEXT NOT NULL DEFAULT 'home',
  title      TEXT NOT NULL,
  layout     TEXT NOT NULL DEFAULT 'grid_4' CHECK (layout IN
               ('full_bleed','grid_4','grid_3','carousel','split_banner','marquee','list')),
  position   INTEGER NOT NULL DEFAULT 0,
  is_visible BOOLEAN NOT NULL DEFAULT true,
  settings   JSONB NOT NULL DEFAULT '{}',
  updated_by UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cms_section_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id    UUID NOT NULL REFERENCES cms_sections(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  label         TEXT,
  sublabel      TEXT,
  media_id      UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  link_url      TEXT,
  collection_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  product_id    UUID REFERENCES products(id) ON DELETE CASCADE,
  is_visible    BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE banners (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  subtitle        TEXT,
  placement       TEXT NOT NULL CHECK (placement IN
                    ('homepage_hero','category_top','cart_strip','pdp_ribbon','announcement_bar')),
  device          TEXT NOT NULL DEFAULT 'all' CHECK (device IN ('all','desktop','mobile')),
  media_id        UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  mobile_media_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  link_url        TEXT,
  collection_id   UUID REFERENCES collections(id) ON DELETE SET NULL,
  cta_label       TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('live','scheduled','expired','draft')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT banner_window CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE banner_stats_daily (
  banner_id   UUID NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (banner_id, day)
);

CREATE TABLE content_pages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          handle NOT NULL,          -- partial unique (soft-deletable)
  kind          TEXT NOT NULL CHECK (kind IN ('occasion','policy','landing','about','static')),
  title         TEXT NOT NULL,
  heading       TEXT,
  body_blocks   JSONB NOT NULL DEFAULT '[]',   -- ordered rich-text blocks
  collection_id UUID REFERENCES collections(id) ON DELETE SET NULL,
  hero_media_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('published','draft','archived')),
  published_at  TIMESTAMPTZ,
  created_by    UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_by    UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- Polymorphic SEO record. Every routable thing gets at most one.
CREATE TABLE seo_entries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      TEXT NOT NULL CHECK (entity_type IN
                     ('product','collection','content_page','blog_post','route')),
  entity_id        UUID,
  route_path       TEXT,                   -- for entity_type='route', e.g. '/'
  meta_title       TEXT,
  meta_description TEXT,
  canonical_url    TEXT,
  og_media_id      UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  focus_keyword    TEXT,
  robots_index     BOOLEAN NOT NULL DEFAULT true,
  robots_follow    BOOLEAN NOT NULL DEFAULT true,
  structured_data  JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT seo_target CHECK (
    (entity_type = 'route' AND route_path IS NOT NULL AND entity_id IS NULL)
    OR (entity_type <> 'route' AND entity_id IS NOT NULL))
);

CREATE TABLE blog_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            handle NOT NULL,          -- partial unique (soft-deletable)
  title           TEXT NOT NULL,
  excerpt         TEXT,
  body_blocks     JSONB NOT NULL DEFAULT '[]',
  category        TEXT,
  author_staff_id UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  author_name     TEXT,          -- for guest authors
  hero_media_id   UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  read_minutes    SMALLINT,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('published','draft','scheduled','archived')),
  published_at    TIMESTAMPTZ,
  view_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT blog_published_has_date CHECK (status <> 'published' OR published_at IS NOT NULL),
  CONSTRAINT blog_has_author         CHECK (author_staff_id IS NOT NULL OR author_name IS NOT NULL)
);

CREATE TABLE faqs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  category        TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  helpful_count   INTEGER NOT NULL DEFAULT 0,
  unhelpful_count INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('published','draft')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE testimonials (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_name TEXT NOT NULL,
  author_city TEXT,               -- storefront shape
  company     TEXT,               -- admin shape (B2B)
  designation TEXT,
  quote       TEXT NOT NULL,
  rating      SMALLINT CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  media_id    UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  is_featured BOOLEAN NOT NULL DEFAULT false,
  position    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('published','pending','rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE menus (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key        handle NOT NULL UNIQUE,   -- 'header' | 'footer' | 'mobile'
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE menu_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id         UUID NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  parent_id       UUID REFERENCES menu_items(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  url             TEXT,
  collection_id   UUID REFERENCES collections(id) ON DELETE CASCADE,
  content_page_id UUID REFERENCES content_pages(id) ON DELETE CASCADE,
  media_id        UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  is_visible      BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT menu_item_no_self_parent CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT menu_item_has_target CHECK (
    url IS NOT NULL OR collection_id IS NOT NULL OR content_page_id IS NOT NULL
    OR parent_id IS NULL)   -- top-level groups may be non-clickable
);

-- ------------------------------------------------------------ 4.12 platform
-- Append-only audit trail.
CREATE TABLE activity_logs (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_kind        TEXT NOT NULL DEFAULT 'staff'
                      CHECK (actor_kind IN ('staff','customer','system','api_key')),
  actor_staff_id    UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  actor_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  actor_api_key_id  UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  actor_label       TEXT NOT NULL,
  actor_role        TEXT,
  action            TEXT NOT NULL,        -- 'product.price_changed'
  entity_type       TEXT NOT NULL,
  entity_id         UUID,
  entity_label      TEXT,                 -- 'Cork Diary' for the list screen
  before_data       JSONB,
  after_data        JSONB,
  changed_fields    TEXT[],
  ip                INET,
  user_agent        TEXT,
  request_id        TEXT
);
-- Partition by month once this table exceeds ~50M rows: PARTITION BY RANGE (occurred_at)

CREATE TABLE notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience      TEXT NOT NULL DEFAULT 'staff' CHECK (audience IN ('staff','customer')),
  staff_user_id UUID REFERENCES staff_users(id) ON DELETE CASCADE,
  customer_id   UUID REFERENCES customers(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('order','inventory','delivery','corporate','payment','system','marketing')),
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  title         TEXT NOT NULL,
  body          TEXT,
  link_url      TEXT,
  entity_type   TEXT,
  entity_id     UUID,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_target CHECK (
    (audience = 'staff'    AND customer_id IS NULL)
 OR (audience = 'customer' AND customer_id IS NOT NULL AND staff_user_id IS NULL))
);

CREATE TABLE webhooks (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_url         TEXT NOT NULL,
  description          TEXT,
  events               TEXT[] NOT NULL CHECK (cardinality(events) > 0),
  secret_hash          TEXT NOT NULL,      -- HMAC signing secret, hashed at rest
  status               TEXT NOT NULL DEFAULT 'healthy'
                         CHECK (status IN ('healthy','failing','paused','disabled')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_delivery_at     TIMESTAMPTZ,
  created_by           UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id      UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  event_id        UUID NOT NULL,
  payload         JSONB NOT NULL,
  attempt         SMALLINT NOT NULL DEFAULT 1 CHECK (attempt > 0),
  response_status SMALLINT,
  response_body   TEXT,
  duration_ms     INTEGER,
  succeeded       BOOLEAN NOT NULL DEFAULT false,
  next_retry_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  is_public   BOOLEAN NOT NULL DEFAULT false,   -- exposed to the storefront?
  updated_by  UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- 5. INDEXES
--
-- CORRECTION 2 (7.2): every uniqueness rule on a soft-deletable (Tier 2)
-- table is a PARTIAL unique index `WHERE deleted_at IS NULL`, so a deleted
-- row does not permanently squat on its handle / SKU / email. Document
-- numbers (order_no, invoice_no, credit_note_no, po_no, ...) stay as FULL
-- unique constraints declared inline above: they are Tier 1 and must never
-- be reused.
-- =====================================================================

-- ---------------------------------------------------------- 5.1 identity
CREATE UNIQUE INDEX uq_staff_email        ON staff_users (email)  WHERE deleted_at IS NULL;
CREATE INDEX idx_role_permissions_module  ON role_permissions (module, action);
CREATE INDEX idx_staff_users_role         ON staff_users (role_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_staff_users_status       ON staff_users (status)  WHERE deleted_at IS NULL;
CREATE INDEX idx_staff_users_name_trgm    ON staff_users USING gin (full_name gin_trgm_ops);
CREATE INDEX idx_staff_sessions_user      ON staff_sessions (staff_user_id, last_active_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_staff_sessions_expiry    ON staff_sessions (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_active          ON api_keys (key_prefix) WHERE revoked_at IS NULL;
CREATE INDEX idx_otp_dest                 ON otp_challenges (destination, purpose, created_at DESC)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------- 5.2 customers
CREATE UNIQUE INDEX uq_customers_email    ON customers (email)  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_customers_mobile   ON customers (mobile) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_customers_auth_uid ON customers (auth_provider_uid)
  WHERE auth_provider_uid IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_customers_segment        ON customers (segment) WHERE deleted_at IS NULL;
CREATE INDEX idx_customers_last_order     ON customers (last_order_at DESC NULLS LAST);
CREATE INDEX idx_customers_corporate      ON customers (corporate_account_id)
  WHERE corporate_account_id IS NOT NULL;
CREATE INDEX idx_customers_tags           ON customers USING gin (tags);
CREATE INDEX idx_customers_search_trgm    ON customers USING gin (
  (coalesce(full_name,'') || ' ' || coalesce(email::text,'') || ' ' || coalesce(mobile,'')) gin_trgm_ops);
CREATE INDEX idx_customers_legacy_ref     ON customers (legacy_ref) WHERE legacy_ref IS NOT NULL;

-- 4.3 — exactly one default address per customer, enforced by the database.
CREATE UNIQUE INDEX uq_one_default_address_per_customer
  ON addresses (customer_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX idx_addresses_customer       ON addresses (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_addresses_pincode        ON addresses (pincode);

CREATE INDEX idx_recipients_customer      ON recipients (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_recipients_reminder      ON recipients (next_date)
  WHERE reminder_on AND deleted_at IS NULL;

CREATE INDEX idx_segment_members_customer ON customer_segment_members (customer_id);
CREATE INDEX idx_customer_sessions        ON customer_sessions (customer_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_customer_sessions_exp    ON customer_sessions (expires_at)  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------- 5.3 catalogue
CREATE UNIQUE INDEX uq_designers_handle   ON designers (handle) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_designers_name     ON designers (name)   WHERE deleted_at IS NULL;
CREATE INDEX idx_designers_status         ON designers (status) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX uq_collections_handle ON collections (handle) WHERE deleted_at IS NULL;
CREATE INDEX idx_collections_kind         ON collections (kind, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX idx_collections_parent       ON collections (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_collections_live         ON collections (status)
  WHERE status = 'live' AND deleted_at IS NULL;
CREATE INDEX idx_collections_legacy_ref   ON collections (legacy_ref) WHERE legacy_ref IS NOT NULL;

CREATE UNIQUE INDEX uq_products_handle    ON products (handle) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_status          ON products (status, published_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_designer        ON products (designer_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_kind            ON products (kind) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_tags            ON products USING gin (tags);
CREATE INDEX idx_products_new             ON products (published_at DESC)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX idx_products_search_trgm     ON products USING gin (
  (title || ' ' || coalesce(subtitle,'')) gin_trgm_ops);
CREATE INDEX idx_products_fts             ON products USING gin (
  to_tsvector('english', title || ' ' || coalesce(description,'')));
CREATE INDEX idx_products_legacy_ref      ON products (legacy_ref) WHERE legacy_ref IS NOT NULL;

CREATE UNIQUE INDEX uq_variants_sku       ON product_variants (sku)     WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_variants_barcode   ON product_variants (barcode)
  WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_variant_option_per_product
  ON product_variants (product_id, option_value) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_one_default_variant_per_product
  ON product_variants (product_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX idx_variants_product         ON product_variants (product_id, position) WHERE deleted_at IS NULL;
CREATE INDEX idx_variants_sku_trgm        ON product_variants USING gin (sku gin_trgm_ops);

-- The storefront's hottest query: products in a collection, ordered.
CREATE INDEX idx_product_collections_listing ON product_collections (collection_id, position, product_id);

CREATE INDEX idx_product_media_product    ON product_media (product_id, position);
CREATE UNIQUE INDEX uq_product_media_once ON product_media
  (product_id, media_id, coalesce(variant_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_product_content_product  ON product_content_items (product_id, position);
CREATE INDEX idx_product_stats_bestsellers ON product_stats (units_sold_30d DESC);

CREATE UNIQUE INDEX uq_hamper_items_sku   ON hamper_items (sku) WHERE deleted_at IS NULL;
CREATE INDEX idx_hamper_items_supplier    ON hamper_items (supplier_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_bom_variant              ON product_bom_lines (variant_id);
CREATE INDEX idx_bom_item                 ON product_bom_lines (hamper_item_id);

CREATE UNIQUE INDEX uq_add_ons_code       ON add_ons (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_personalisation_templates_name
  ON personalisation_templates (name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_builder_templates_handle
  ON builder_templates (handle) WHERE deleted_at IS NULL;
CREATE INDEX idx_builder_options_step     ON builder_step_options (step_id, position);

CREATE INDEX idx_reviews_product          ON reviews (product_id, status, submitted_at DESC);
CREATE INDEX idx_reviews_queue            ON reviews (submitted_at DESC) WHERE status = 'pending';
CREATE UNIQUE INDEX uq_review_one_per_line ON reviews (order_line_id)
  WHERE order_line_id IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------- 5.4 tax
CREATE INDEX idx_gst_rates_lookup         ON gst_rates (hsn_code, effective_from DESC);

-- ---------------------------------------------------------- 5.5 inventory
CREATE UNIQUE INDEX uq_warehouses_code    ON warehouses (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_warehouses_name    ON warehouses (name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_one_default_warehouse ON warehouses (is_default)
  WHERE is_default AND deleted_at IS NULL;
CREATE INDEX idx_warehouses_state         ON warehouses (state_code) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX uq_inventory_variant_wh   ON inventory_levels (variant_id, warehouse_id)
  WHERE variant_id IS NOT NULL;
CREATE UNIQUE INDEX uq_inventory_item_wh      ON inventory_levels (hamper_item_id, warehouse_id)
  WHERE hamper_item_id IS NOT NULL;
CREATE UNIQUE INDEX uq_inventory_packaging_wh ON inventory_levels (packaging_id, warehouse_id)
  WHERE packaging_id IS NOT NULL;
CREATE INDEX idx_inventory_warehouse      ON inventory_levels (warehouse_id);
CREATE INDEX idx_inventory_low            ON inventory_levels (warehouse_id, available_qty)
  WHERE available_qty <= reorder_point;

CREATE INDEX idx_reservations_expiry      ON inventory_reservations (expires_at)
  WHERE released_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX idx_reservations_level       ON inventory_reservations (inventory_level_id)
  WHERE released_at IS NULL;
CREATE INDEX idx_reservations_order       ON inventory_reservations (order_id) WHERE order_id IS NOT NULL;

CREATE INDEX idx_stock_movements_level    ON stock_movements (inventory_level_id, occurred_at DESC);
CREATE INDEX idx_stock_movements_ref      ON stock_movements (reference_type, reference_id);
CREATE INDEX idx_stock_movements_time     ON stock_movements (occurred_at DESC);

CREATE UNIQUE INDEX uq_suppliers_code     ON suppliers (code) WHERE deleted_at IS NULL;
CREATE INDEX idx_suppliers_status         ON suppliers (status) WHERE deleted_at IS NULL;
CREATE INDEX idx_suppliers_search         ON suppliers USING gin (
  (name || ' ' || coalesce(contact_name,'') || ' ' || coalesce(city,'')
   || ' ' || coalesce(gstin,'')) gin_trgm_ops);

CREATE INDEX idx_po_supplier              ON purchase_orders (supplier_id, created_at DESC);
CREATE INDEX idx_po_status                ON purchase_orders (status, expected_on);
CREATE INDEX idx_po_warehouse             ON purchase_orders (warehouse_id);
CREATE INDEX idx_po_lines_po              ON purchase_order_lines (purchase_order_id, position);
CREATE INDEX idx_grn_po                   ON goods_receipts (purchase_order_id);
CREATE INDEX idx_grn_lines_grn            ON goods_receipt_lines (goods_receipt_id);
CREATE INDEX idx_grn_lines_expiry         ON goods_receipt_lines (expiry_on) WHERE expiry_on IS NOT NULL;
CREATE INDEX idx_transfers_status         ON stock_transfers (status, eta_on);
CREATE INDEX idx_transfer_lines_transfer  ON stock_transfer_lines (transfer_id);

CREATE UNIQUE INDEX uq_packaging_sku      ON packaging_materials (sku) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------- 5.6 cart & orders
CREATE INDEX idx_carts_customer           ON carts (customer_id) WHERE stage <> 'converted';
CREATE INDEX idx_carts_abandoned          ON carts (abandoned_at DESC)
  WHERE stage <> 'converted' AND abandoned_at IS NOT NULL;
CREATE INDEX idx_carts_expiry             ON carts (expires_at) WHERE stage <> 'converted';
CREATE UNIQUE INDEX uq_cart_line_key      ON cart_lines (cart_id, line_key);
CREATE INDEX idx_cart_lines_cart          ON cart_lines (cart_id);

CREATE INDEX idx_orders_customer          ON orders (customer_id, placed_at DESC);
CREATE INDEX idx_orders_status            ON orders (status, placed_at DESC);
CREATE INDEX idx_orders_payment           ON orders (payment_status, placed_at DESC);
CREATE INDEX idx_orders_placed            ON orders (placed_at DESC);
CREATE INDEX idx_orders_delivery          ON orders (requested_delivery_date)
  WHERE status NOT IN ('delivered','cancelled','refunded');
CREATE INDEX idx_orders_corporate         ON orders (corporate_account_id)
  WHERE corporate_account_id IS NOT NULL;
CREATE INDEX idx_orders_warehouse         ON orders (fulfilment_warehouse_id, status);
CREATE INDEX idx_orders_channel           ON orders (channel, placed_at DESC);
CREATE INDEX idx_orders_tags              ON orders USING gin (tags);
CREATE INDEX idx_orders_priority          ON orders (priority, placed_at DESC)
  WHERE priority <> 'standard';
CREATE INDEX idx_orders_search_trgm       ON orders USING gin (
  (order_no || ' ' || buyer_name || ' ' || coalesce(buyer_email::text,'')
   || ' ' || coalesce(buyer_mobile,'')) gin_trgm_ops);

CREATE INDEX idx_order_lines_order        ON order_lines (order_id, position);
CREATE INDEX idx_order_lines_variant_time ON order_lines (variant_id, created_at DESC);
CREATE INDEX idx_order_line_addons_line   ON order_line_add_ons (order_line_id);
CREATE INDEX idx_personalisation_queue    ON order_line_personalisations (proof_status)
  WHERE proof_status IN ('pending','sent');
CREATE INDEX idx_order_timeline_order     ON order_timeline (order_id, occurred_at);

CREATE INDEX idx_returns_order            ON returns (order_id);
CREATE INDEX idx_returns_status           ON returns (status, requested_at DESC);
CREATE INDEX idx_return_lines_order_line  ON return_lines (order_line_id);
CREATE INDEX idx_exchanges_order          ON exchanges (order_id);
CREATE INDEX idx_exchanges_status         ON exchanges (status, requested_at DESC);

-- ---------------------------------------------------------- 5.7 payments
CREATE UNIQUE INDEX uq_payments_gateway_id ON payments (gateway, gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;
CREATE INDEX idx_payments_order           ON payments (order_id, created_at DESC);
CREATE INDEX idx_payments_status          ON payments (status, created_at DESC);
CREATE INDEX idx_payments_settle          ON payments (is_settled, captured_at) WHERE status = 'captured';
CREATE INDEX idx_payments_gateway         ON payments (gateway, created_at DESC);
CREATE INDEX idx_payment_events_unprocessed ON payment_events (received_at) WHERE processed_at IS NULL;

CREATE INDEX idx_refunds_order            ON refunds (order_id);
CREATE INDEX idx_refunds_payment          ON refunds (payment_id);
CREATE INDEX idx_refunds_status           ON refunds (status, initiated_at DESC);

CREATE UNIQUE INDEX uq_invoice_per_order  ON invoices (order_id) WHERE status = 'issued';
CREATE INDEX idx_invoices_issued          ON invoices (issued_at DESC);
CREATE INDEX idx_invoices_fy              ON invoices (financial_year, invoice_no);
CREATE INDEX idx_invoices_gstin           ON invoices (buyer_gstin) WHERE buyer_gstin IS NOT NULL;
CREATE INDEX idx_invoice_lines_invoice    ON invoice_lines (invoice_id, position);
CREATE INDEX idx_invoice_lines_hsn        ON invoice_lines (hsn_code);

CREATE INDEX idx_credit_notes_invoice     ON credit_notes (invoice_id);
CREATE INDEX idx_credit_notes_fy          ON credit_notes (financial_year, credit_note_no);
CREATE INDEX idx_cn_lines_cn              ON credit_note_lines (credit_note_id, position);

CREATE INDEX idx_gift_cards_status        ON gift_cards (status, expires_on);
CREATE INDEX idx_gift_cards_customer      ON gift_cards (issued_to_customer_id);
CREATE INDEX idx_gc_txn_card              ON gift_card_transactions (gift_card_id, occurred_at DESC);
CREATE UNIQUE INDEX uq_gc_redeem_once_per_payment ON gift_card_transactions (payment_id)
  WHERE payment_id IS NOT NULL AND kind = 'redeem';

-- ---------------------------------------------------------- 5.8 corporate
CREATE INDEX idx_leads_stage              ON corporate_leads (stage, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_owner              ON corporate_leads (owner_id, next_follow_up_on);
CREATE INDEX idx_leads_followup           ON corporate_leads (next_follow_up_on)
  WHERE stage NOT IN ('won','lost') AND deleted_at IS NULL;
CREATE INDEX idx_leads_search             ON corporate_leads USING gin (
  (company_name || ' ' || contact_name || ' ' || email::text) gin_trgm_ops);

CREATE UNIQUE INDEX uq_corp_company_name  ON corporate_accounts (company_name) WHERE deleted_at IS NULL;
CREATE INDEX idx_corp_status              ON corporate_accounts (status) WHERE deleted_at IS NULL;
CREATE INDEX idx_corp_manager             ON corporate_accounts (account_manager_id);
CREATE INDEX idx_corp_search              ON corporate_accounts USING gin (
  (company_name || ' ' || coalesce(gstin,'')) gin_trgm_ops);

CREATE UNIQUE INDEX uq_one_primary_contact ON corporate_account_contacts (account_id) WHERE is_primary;
CREATE INDEX idx_corp_contacts_account    ON corporate_account_contacts (account_id);

CREATE INDEX idx_quotations_status        ON quotations (status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_quotations_account       ON quotations (account_id);
CREATE INDEX idx_quotations_owner         ON quotations (owner_id, valid_till);
CREATE INDEX idx_quotation_lines_q        ON quotation_lines (quotation_id, position);

CREATE INDEX idx_campaigns_account        ON corporate_campaigns (account_id, status);
CREATE INDEX idx_campaign_recipients      ON campaign_recipients (campaign_id, status);
CREATE INDEX idx_campaign_recip_order     ON campaign_recipients (order_id) WHERE order_id IS NOT NULL;

CREATE INDEX idx_approvals_pending        ON approvals (requested_at) WHERE status = 'pending';
CREATE INDEX idx_approvals_subject        ON approvals (subject_table, subject_id);

-- ---------------------------------------------------------- 5.9 delivery
CREATE INDEX idx_zones_status             ON delivery_zones (status, state_code);
CREATE INDEX idx_zone_pincodes_zone       ON delivery_zone_pincodes (zone_id);
CREATE UNIQUE INDEX uq_shipping_rule_priority ON shipping_rules (priority) WHERE status = 'active';

CREATE UNIQUE INDEX uq_shipments_awb      ON shipments (courier_id, awb) WHERE awb IS NOT NULL;
CREATE INDEX idx_shipments_order          ON shipments (order_id);
CREATE INDEX idx_shipments_status         ON shipments (status, dispatched_at DESC);
CREATE INDEX idx_shipments_awb            ON shipments (awb) WHERE awb IS NOT NULL;
CREATE INDEX idx_shipments_eta            ON shipments (eta_on)
  WHERE status NOT IN ('delivered','cancelled','rto_delivered');
CREATE INDEX idx_shipment_events          ON shipment_events (shipment_id, occurred_at DESC);

CREATE INDEX idx_exceptions_open          ON delivery_exceptions (raised_at)
  WHERE status NOT IN ('resolved','written_off');
CREATE INDEX idx_exceptions_order         ON delivery_exceptions (order_id);
CREATE INDEX idx_exceptions_owner         ON delivery_exceptions (owner_id, status);

-- ---------------------------------------------------------- 5.10 promotions
CREATE UNIQUE INDEX uq_coupons_code       ON coupons (code) WHERE deleted_at IS NULL;
CREATE INDEX idx_coupons_status           ON coupons (status, ends_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_coupons_active           ON coupons (code) WHERE status = 'active' AND deleted_at IS NULL;

CREATE UNIQUE INDEX uq_coupon_scope_col   ON coupon_scope (coupon_id, collection_id)
  WHERE collection_id IS NOT NULL;
CREATE UNIQUE INDEX uq_coupon_scope_prod  ON coupon_scope (coupon_id, product_id)
  WHERE product_id IS NOT NULL;

-- 4.2: one redemption per coupon per order, at the storage layer.
CREATE UNIQUE INDEX uq_coupon_once_per_order ON coupon_redemptions (coupon_id, order_id);
CREATE INDEX idx_coupon_redemptions_customer ON coupon_redemptions (coupon_id, customer_id)
  WHERE reversed_at IS NULL;

CREATE INDEX idx_auto_discounts_active    ON auto_discounts (priority)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_bundles_handle     ON bundles (handle) WHERE deleted_at IS NULL;
CREATE INDEX idx_upsell_placement         ON upsell_rules (placement, priority) WHERE status = 'active';

CREATE INDEX idx_loyalty_tier             ON loyalty_accounts (tier_id);
CREATE INDEX idx_loyalty_txn_customer     ON loyalty_transactions (customer_id, occurred_at DESC);
CREATE UNIQUE INDEX uq_loyalty_earn_per_order ON loyalty_transactions (order_id)
  WHERE order_id IS NOT NULL AND kind = 'earn';

CREATE UNIQUE INDEX uq_referral_invitee   ON referral_conversions (invited_customer_id)
  WHERE invited_customer_id IS NOT NULL;
CREATE INDEX idx_referral_conv            ON referral_conversions (referral_id, status);

-- ---------------------------------------------------------- 5.11 content
CREATE UNIQUE INDEX uq_media_storage_key  ON media_assets (storage_key) WHERE deleted_at IS NULL;
CREATE INDEX idx_media_kind               ON media_assets (kind, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_media_folder             ON media_assets (folder) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_media_checksum     ON media_assets (checksum_sha256)
  WHERE checksum_sha256 IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_cms_sections_page        ON cms_sections (page_key, position) WHERE is_visible;
CREATE INDEX idx_cms_items_section        ON cms_section_items (section_id, position);
CREATE INDEX idx_banners_live             ON banners (placement, position) WHERE status = 'live';

CREATE UNIQUE INDEX uq_content_pages_slug ON content_pages (slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_content_pages_kind       ON content_pages (kind, status);

CREATE UNIQUE INDEX uq_seo_entity         ON seo_entries (entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE UNIQUE INDEX uq_seo_route          ON seo_entries (route_path) WHERE route_path IS NOT NULL;

CREATE UNIQUE INDEX uq_blog_posts_slug    ON blog_posts (slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_blog_published           ON blog_posts (published_at DESC)
  WHERE status = 'published' AND deleted_at IS NULL;
CREATE INDEX idx_blog_category            ON blog_posts (category, published_at DESC);

CREATE INDEX idx_faqs_category            ON faqs (category, position) WHERE status = 'published';
CREATE INDEX idx_testimonials_pub         ON testimonials (position) WHERE status = 'published';
CREATE INDEX idx_menu_items               ON menu_items (menu_id, parent_id, position) WHERE is_visible;

-- ---------------------------------------------------------- 5.12 platform
CREATE INDEX idx_activity_time            ON activity_logs (occurred_at DESC);
CREATE INDEX idx_activity_entity          ON activity_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX idx_activity_actor           ON activity_logs (actor_staff_id, occurred_at DESC);
CREATE INDEX idx_activity_action          ON activity_logs (action, occurred_at DESC);
CREATE INDEX idx_notifications_staff      ON notifications (staff_user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX idx_notifications_cust       ON notifications (customer_id, created_at DESC);
CREATE INDEX idx_webhooks_events          ON webhooks USING gin (events);
CREATE INDEX idx_webhook_deliveries       ON webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX idx_webhook_retry            ON webhook_deliveries (next_retry_at)
  WHERE NOT succeeded AND next_retry_at IS NOT NULL;
CREATE INDEX idx_import_jobs              ON import_jobs (status, created_at DESC);
CREATE INDEX idx_import_errors            ON import_job_errors (import_job_id, row_number);

-- =====================================================================
-- 6. TABLE-DEPENDENT FUNCTIONS AND TRIGGERS
-- Everything in this section is invisible to Drizzle. The TS schema files
-- carry `// SQL-only:` comments pointing back here.
-- =====================================================================

-- ------------------------------------------------- 6.1 document numbering
-- Gapless, transaction-participating counter. Rule 46(b) requires a
-- consecutive serial number unique within a financial year; nextval() burns
-- a value on rollback, so a sequence cannot be used for invoices.
CREATE OR REPLACE FUNCTION next_document_number(p_doc_type TEXT, p_scope TEXT)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE v_prefix TEXT; v_suffix TEXT; v_pad SMALLINT; v_issued BIGINT;
BEGIN
  UPDATE document_number_series
     SET next_value = next_value + 1,
         updated_at = now()
   WHERE doc_type = p_doc_type
     AND scope_key = p_scope
     AND is_active
  RETURNING prefix, suffix, pad_width, next_value - 1
       INTO v_prefix, v_suffix, v_pad, v_issued;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active numbering series for doc_type=% scope=%',
      p_doc_type, p_scope
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_prefix || lpad(v_issued::text, v_pad, '0') || v_suffix;
END $fn$;

-- ------------------------------------------------- 6.2 self-referral guard
-- CORRECTION 4 (7.4). A CHECK cannot contain a subquery in PostgreSQL.
CREATE OR REPLACE FUNCTION forbid_self_referral() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE ref_owner UUID;
BEGIN
  IF NEW.invited_customer_id IS NULL THEN RETURN NEW; END IF;
  SELECT referrer_customer_id INTO ref_owner FROM referrals WHERE id = NEW.referral_id;
  IF ref_owner = NEW.invited_customer_id THEN
    RAISE EXCEPTION 'self-referral is not permitted (customer %)', ref_owner;
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER trg_no_self_referral BEFORE INSERT OR UPDATE ON referral_conversions
  FOR EACH ROW EXECUTE FUNCTION forbid_self_referral();

-- ------------------------------------------------- 6.3 default address
-- "At most one" is the partial unique index uq_one_default_address_per_customer.
-- "At least one" is this trigger.
-- WRITE-ORDER GOTCHA: a partial unique INDEX cannot be deferred, so setting a
-- new default must clear the old one FIRST, in the same transaction.
CREATE OR REPLACE FUNCTION ensure_default_address() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE v_customer UUID := coalesce(NEW.customer_id, OLD.customer_id);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM addresses
                  WHERE customer_id = v_customer
                    AND is_default AND deleted_at IS NULL) THEN
    UPDATE addresses SET is_default = true
     WHERE id = (SELECT id FROM addresses
                  WHERE customer_id = v_customer AND deleted_at IS NULL
                  ORDER BY created_at LIMIT 1);
  END IF;
  RETURN NULL;
END $fn$;

CREATE TRIGGER trg_ensure_default_address
AFTER INSERT OR UPDATE OF is_default, deleted_at OR DELETE ON addresses
FOR EACH ROW EXECUTE FUNCTION ensure_default_address();

-- ------------------------------------------------- 6.4 order totals (4.4)
-- I1  orders.subtotal_paise = SUM(order_lines.gross_paise)
-- I2  coupon+auto+loyalty discount = SUM(allocated_order_discount_paise)
-- I3  total = subtotal + shipping + cod_fee + round_off
-- I4  order tax rollup = SUM(line tax)
-- DEFERRABLE INITIALLY DEFERRED: the header is inserted before its lines.
CREATE OR REPLACE FUNCTION check_order_totals() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE o RECORD; s RECORD;
BEGIN
  SELECT * INTO o FROM orders WHERE id = coalesce(NEW.order_id, NEW.id);
  IF NOT FOUND THEN RETURN NULL; END IF;   -- order deleted in this txn

  SELECT coalesce(sum(gross_paise),0)                    AS gross,
         coalesce(sum(allocated_order_discount_paise),0) AS alloc,
         coalesce(sum(taxable_paise),0)                  AS taxable,
         coalesce(sum(cgst_paise),0)                     AS cgst,
         coalesce(sum(sgst_paise),0)                     AS sgst,
         coalesce(sum(igst_paise),0)                     AS igst,
         coalesce(sum(cess_paise),0)                     AS cess
    INTO s
    FROM order_lines
   WHERE order_id = o.id AND fulfilment_status <> 'cancelled';

  IF o.subtotal_paise <> s.gross THEN
    RAISE EXCEPTION 'order % subtotal %, lines sum to % (I1)',
      o.order_no, o.subtotal_paise, s.gross;
  END IF;

  IF o.coupon_discount_paise + o.auto_discount_paise
     + o.loyalty_discount_paise <> s.alloc THEN
    RAISE EXCEPTION 'order % header discounts % <> allocated % (I2)',
      o.order_no,
      o.coupon_discount_paise + o.auto_discount_paise + o.loyalty_discount_paise,
      s.alloc;
  END IF;

  IF o.total_paise <> o.subtotal_paise + o.shipping_paise
                      + o.cod_fee_paise + o.round_off_paise THEN
    RAISE EXCEPTION 'order % total % does not reconcile (I3)',
      o.order_no, o.total_paise;
  END IF;

  IF o.taxable_paise + o.cgst_paise + o.sgst_paise + o.igst_paise + o.cess_paise
     <> s.taxable + s.cgst + s.sgst + s.igst + s.cess THEN
    RAISE EXCEPTION 'order % tax rollup does not match lines (I4)', o.order_no;
  END IF;

  RETURN NULL;
END $fn$;

CREATE CONSTRAINT TRIGGER trg_order_totals_lines
AFTER INSERT OR UPDATE OR DELETE ON order_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_order_totals();

CREATE CONSTRAINT TRIGGER trg_order_totals_header
AFTER INSERT OR UPDATE OF subtotal_paise, total_paise, shipping_paise,
  cod_fee_paise, round_off_paise, coupon_discount_paise, auto_discount_paise,
  loyalty_discount_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise, cess_paise
ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_order_totals();

-- ------------------------------------------------- 6.5 updated_at everywhere
-- 4.6: the set_updated_at() trigger is generated for EVERY table that has an
-- updated_at column. A CI check asserts none are missing.
DO $do$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'updated_at'
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', r.relname, r.relname);
  END LOOP;
END $do$;

-- =====================================================================
-- 7. TIER 1 WRITE PROTECTION (4.5)
-- Books of account: retained 8 years under s.128 Companies Act 2013 and
-- required for GST assessment. Cancellation is a status transition, never a
-- row removal. Applied only if the application role already exists.
-- =====================================================================

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'achichiz_app') THEN
    EXECUTE 'REVOKE DELETE ON invoices, invoice_lines, credit_notes, credit_note_lines,
                               payments, payment_events, refunds, order_timeline,
                               stock_movements, activity_logs, gift_card_transactions,
                               loyalty_transactions, coupon_redemptions
               FROM achichiz_app';
  END IF;
END $do$;

-- =====================================================================
-- 8. REFERENCE SEED — document numbering series
--
-- CORRECTION 1 (7.1): the credit-note series is 'CN/26-27/' + pad_width 6
-- => 'CN/26-27/000001' (15 chars). The original design's
-- 'ACHCN/26-27/000001' is 18 characters and breaches the 16-character cap
-- in Rule 46(b) of the CGST Rules. The invoice series 'ACH/26-27/' + 6 =
-- 'ACH/26-27/000001' is exactly 16 and is unchanged.
-- =====================================================================

INSERT INTO document_number_series (doc_type, scope_key, prefix, pad_width, next_value) VALUES
  ('invoice',        '26-27', 'ACH/26-27/', 6, 1),
  ('credit_note',    '26-27', 'CN/26-27/',  6, 1),
  ('quotation',      '26-27', 'QT/26-27/',  5, 1),
  ('purchase_order', '2026',  'PO-2026-',   5, 1),
  ('goods_receipt',  '2026',  'GRN-2026-',  5, 1),
  ('return',         '2026',  'RET-2026-',  5, 1),
  ('exchange',       '2026',  'EXC-2026-',  5, 1),
  ('refund',         '2026',  'REF-2026-',  5, 1),
  ('stock_transfer', '2026',  'TRF-2026-',  5, 1)
ON CONFLICT (doc_type, scope_key) DO NOTHING;

COMMIT;
