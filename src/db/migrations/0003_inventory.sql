-- =====================================================================
-- Achichiz — 0003_inventory.sql
--
-- Completes the inventory context. Forward-only; 0001 and 0002 are never edited.
--
-- 0001 ALREADY SHIPS the hard parts, and this migration does not touch them:
--   inventory_levels   — with available_qty as a GENERATED column, so
--                        AVAILABLE = ON_HAND - RESERVED cannot drift (spec §63)
--   inventory_reservations, stock_movements (append-only ledger)
--   warehouses, suppliers
--   purchase_orders + lines, goods_receipts + lines
--   stock_transfers + lines
--   product_bom_lines  — already a real BOM (component + quantity + substitutable)
--   product_variants.barcode
--
-- What was genuinely absent, and is added here:
--   1. movement + reference vocabulary for production, counts, loss/found
--   2. warehouse_locations      (zone -> rack -> shelf -> bin)
--   3. supplier_products        (supplier SKU, cost, MOQ, lead time)
--   4. purchase_returns + lines (return stock to a supplier)
--   5. stock_counts + items     (physical count -> variance -> adjustment)
--   6. production_orders + lines + consumption
--   7. product_bom_lines.waste_pct / .version
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. MOVEMENT VOCABULARY
--
-- The ledger's CHECK constraints are widened, not replaced — every value
-- already in stock_movements stays legal.
--
-- Note what is deliberately NOT added: RESERVATION and RESERVATION_RELEASED
-- from spec §9. A reservation moves `reserved_qty`, never `on_hand_qty`, so it
-- is not a stock movement. Recording it as one would double-count against the
-- balance_after running total and make the ledger disagree with inventory_levels.
-- Reservations have their own table and their own history.
-- ---------------------------------------------------------------------
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
  CHECK (movement_type IN (
    'inbound','outbound','adjustment','transfer_out','transfer_in','damage','return_in',
    -- new
    'production',                -- finished goods created by a production order
    'raw_material_consumption',  -- components consumed by that same order
    'stock_count',               -- variance posted after a count is APPROVED
    'loss',                      -- written off, cause unknown
    'found'                      -- discovered, cause unknown
  ));

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_reference_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reference_type_check
  CHECK (reference_type IN (
    'purchase_order','goods_receipt','order','stock_transfer','return','adjustment','import',
    -- new
    'production_order','stock_count','purchase_return'
  ));

-- ---------------------------------------------------------------------
-- 2. WAREHOUSE LOCATIONS  (spec §18)
--
-- Self-referencing hierarchy rather than four fixed columns: a studio with one
-- room and a shop with racks are the same shape, just different depth.
-- `path` is the materialised full code ('A/R3/S2/B7') so the pick list can show
-- a location without walking parents on every row.
-- ---------------------------------------------------------------------
CREATE TABLE warehouse_locations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  parent_id     UUID REFERENCES warehouse_locations(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL,
  code          TEXT NOT NULL,
  name          TEXT,
  path          TEXT NOT NULL,
  is_pickable   BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  CONSTRAINT warehouse_locations_kind_check
    CHECK (kind IN ('zone','rack','shelf','bin')),
  CONSTRAINT warehouse_locations_code_check
    CHECK (code ~ '^[A-Z0-9][A-Z0-9._-]{0,23}$'),
  CONSTRAINT warehouse_locations_not_self_parent
    CHECK (parent_id IS DISTINCT FROM id)
);

-- Partial: a soft-deleted bin must not squat on its code forever.
CREATE UNIQUE INDEX uq_warehouse_locations_path
  ON warehouse_locations (warehouse_id, path) WHERE deleted_at IS NULL;
CREATE INDEX idx_warehouse_locations_parent ON warehouse_locations (parent_id);
CREATE INDEX idx_warehouse_locations_wh ON warehouse_locations (warehouse_id, kind);

-- inventory_levels already carries a free-text `bin_location`. Add the FK so a
-- level can point at a real location, while leaving the text column in place for
-- rows that predate this migration.
ALTER TABLE inventory_levels
  ADD COLUMN location_id UUID REFERENCES warehouse_locations(id) ON DELETE SET NULL;
CREATE INDEX idx_inventory_levels_location ON inventory_levels (location_id);

-- ---------------------------------------------------------------------
-- 3. SUPPLIER PRODUCTS  (spec §22)
--
-- The join that makes reordering possible: what this supplier calls the SKU,
-- what they charge, their minimum, and how long they take.
-- ---------------------------------------------------------------------
CREATE TABLE supplier_products (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id           UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  variant_id            UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  hamper_item_id        UUID REFERENCES hamper_items(id) ON DELETE CASCADE,
  packaging_id          UUID REFERENCES packaging_materials(id) ON DELETE CASCADE,
  supplier_sku          TEXT,
  unit_cost_paise       BIGINT NOT NULL DEFAULT 0,
  currency              CHAR(3) NOT NULL DEFAULT 'INR',
  moq                   INTEGER NOT NULL DEFAULT 1,
  lead_time_days        INTEGER NOT NULL DEFAULT 0,
  is_preferred          BOOLEAN NOT NULL DEFAULT false,
  last_purchase_at      TIMESTAMPTZ,
  last_purchase_cost_paise BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  -- Exactly one target, mirroring the polymorphism inventory_levels already uses.
  CONSTRAINT supplier_products_one_target CHECK (
    (variant_id IS NOT NULL)::int + (hamper_item_id IS NOT NULL)::int
      + (packaging_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT supplier_products_cost_check CHECK (unit_cost_paise >= 0),
  CONSTRAINT supplier_products_moq_check CHECK (moq >= 1),
  CONSTRAINT supplier_products_lead_check CHECK (lead_time_days >= 0)
);

CREATE UNIQUE INDEX uq_supplier_products_variant
  ON supplier_products (supplier_id, variant_id) WHERE variant_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_supplier_products_hamper
  ON supplier_products (supplier_id, hamper_item_id) WHERE hamper_item_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_supplier_products_packaging
  ON supplier_products (supplier_id, packaging_id) WHERE packaging_id IS NOT NULL AND deleted_at IS NULL;
-- At most one preferred supplier per variant — the reorder engine picks blindly otherwise.
CREATE UNIQUE INDEX uq_supplier_products_preferred_variant
  ON supplier_products (variant_id) WHERE is_preferred AND variant_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_supplier_products_supplier ON supplier_products (supplier_id);

-- ---------------------------------------------------------------------
-- 4. PURCHASE RETURNS  (spec §27)
-- ---------------------------------------------------------------------
CREATE TABLE purchase_returns (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_no          TEXT NOT NULL,
  supplier_id        UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  warehouse_id       UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  goods_receipt_id   UUID REFERENCES goods_receipts(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'draft',
  reason             TEXT NOT NULL,
  subtotal_paise     BIGINT NOT NULL DEFAULT 0,
  tax_paise          BIGINT NOT NULL DEFAULT 0,
  total_paise        BIGINT NOT NULL DEFAULT 0,
  note               TEXT,
  created_by         UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  approved_by        UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  approved_at        TIMESTAMPTZ,
  dispatched_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchase_returns_status_check
    CHECK (status IN ('draft','pending_approval','approved','dispatched','completed','cancelled')),
  CONSTRAINT purchase_returns_reason_check
    CHECK (reason IN ('damaged','wrong_item','quality','excess','expired','other'))
);
CREATE UNIQUE INDEX uq_purchase_returns_no ON purchase_returns (return_no);
CREATE INDEX idx_purchase_returns_supplier ON purchase_returns (supplier_id, created_at DESC);
CREATE INDEX idx_purchase_returns_status ON purchase_returns (status, created_at DESC);

CREATE TABLE purchase_return_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_return_id  UUID NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  inventory_level_id  UUID NOT NULL REFERENCES inventory_levels(id) ON DELETE RESTRICT,
  quantity            INTEGER NOT NULL,
  unit_cost_paise     BIGINT NOT NULL DEFAULT 0,
  line_total_paise    BIGINT NOT NULL DEFAULT 0,
  note                TEXT,
  CONSTRAINT purchase_return_lines_qty_check CHECK (quantity > 0)
);
CREATE INDEX idx_purchase_return_lines_return ON purchase_return_lines (purchase_return_id);

-- ---------------------------------------------------------------------
-- 5. STOCK COUNTS  (spec §39-40)
--
-- The rule that makes a count trustworthy: `system_qty` is FROZEN when the
-- item is first counted, so the variance is against what the system believed at
-- that moment, not against a number that moved while the counter walked the aisle.
-- Approval posts an adjustment movement; nothing overwrites on_hand directly.
-- ---------------------------------------------------------------------
CREATE TABLE stock_counts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  count_no       TEXT NOT NULL,
  warehouse_id   UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  location_id    UUID REFERENCES warehouse_locations(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL DEFAULT 'cycle',
  status         TEXT NOT NULL DEFAULT 'draft',
  scheduled_for  DATE,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  approved_at    TIMESTAMPTZ,
  created_by     UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  counted_by     UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  approved_by    UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_counts_kind_check CHECK (kind IN ('full','cycle','spot')),
  CONSTRAINT stock_counts_status_check
    CHECK (status IN ('draft','in_progress','completed','approved','cancelled')),
  -- An approved count must name its approver. Anonymous approval defeats the point.
  CONSTRAINT stock_counts_approved_by_required
    CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_stock_counts_no ON stock_counts (count_no);
CREATE INDEX idx_stock_counts_wh ON stock_counts (warehouse_id, status, created_at DESC);

CREATE TABLE stock_count_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_count_id      UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  inventory_level_id  UUID NOT NULL REFERENCES inventory_levels(id) ON DELETE RESTRICT,
  system_qty          INTEGER NOT NULL,
  counted_qty         INTEGER,
  -- Generated, so a variance can never be mis-typed or fall out of step.
  variance_qty        INTEGER GENERATED ALWAYS AS (COALESCE(counted_qty, 0) - system_qty) STORED,
  recount_qty         INTEGER,
  reason              TEXT,
  counted_at          TIMESTAMPTZ,
  counted_by          UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT stock_count_items_counted_check CHECK (counted_qty IS NULL OR counted_qty >= 0),
  CONSTRAINT stock_count_items_recount_check CHECK (recount_qty IS NULL OR recount_qty >= 0)
);
CREATE UNIQUE INDEX uq_stock_count_items ON stock_count_items (stock_count_id, inventory_level_id);
CREATE INDEX idx_stock_count_items_variance
  ON stock_count_items (stock_count_id) WHERE counted_qty IS NOT NULL;

-- ---------------------------------------------------------------------
-- 6. PRODUCTION  (spec §46)
--
-- Completing a production order consumes components and creates finished stock
-- in ONE transaction. The consumption table records what was actually taken,
-- which will differ from the BOM whenever waste differs from the estimate —
-- that difference is the only honest way to tune waste_pct later.
-- ---------------------------------------------------------------------
CREATE TABLE production_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_no       TEXT NOT NULL,
  warehouse_id        UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  output_variant_id   UUID REFERENCES product_variants(id) ON DELETE RESTRICT,
  output_hamper_item_id UUID REFERENCES hamper_items(id) ON DELETE RESTRICT,
  planned_qty         INTEGER NOT NULL,
  produced_qty        INTEGER NOT NULL DEFAULT 0,
  scrapped_qty        INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'draft',
  batch_no            TEXT,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_by          UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT production_orders_one_output CHECK (
    (output_variant_id IS NOT NULL)::int + (output_hamper_item_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT production_orders_status_check
    CHECK (status IN ('draft','planned','in_progress','completed','cancelled')),
  CONSTRAINT production_orders_planned_check CHECK (planned_qty > 0),
  CONSTRAINT production_orders_produced_check CHECK (produced_qty >= 0 AND scrapped_qty >= 0)
);
CREATE UNIQUE INDEX uq_production_orders_no ON production_orders (production_no);
CREATE INDEX idx_production_orders_status ON production_orders (status, created_at DESC);
CREATE INDEX idx_production_orders_wh ON production_orders (warehouse_id, created_at DESC);

CREATE TABLE production_order_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id  UUID NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  inventory_level_id   UUID NOT NULL REFERENCES inventory_levels(id) ON DELETE RESTRICT,
  planned_qty          NUMERIC(12,3) NOT NULL,
  consumed_qty         NUMERIC(12,3) NOT NULL DEFAULT 0,
  unit                 TEXT NOT NULL DEFAULT 'piece',
  CONSTRAINT production_order_lines_unit_check
    CHECK (unit IN ('piece','gram','kg','ml','litre','meter')),
  CONSTRAINT production_order_lines_planned_check CHECK (planned_qty > 0),
  CONSTRAINT production_order_lines_consumed_check CHECK (consumed_qty >= 0)
);
CREATE UNIQUE INDEX uq_production_order_lines
  ON production_order_lines (production_order_id, inventory_level_id);

-- ---------------------------------------------------------------------
-- 7. BOM EXTENSIONS  (spec §45, §93)
--
-- waste_pct is a column, not a constant: 5% on wax and 0% on a bottle are both
-- real, and the spec is explicit that waste must not be hard-coded.
-- ---------------------------------------------------------------------
ALTER TABLE product_bom_lines
  ADD COLUMN waste_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN version   INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN unit      TEXT NOT NULL DEFAULT 'piece';

ALTER TABLE product_bom_lines
  ADD CONSTRAINT product_bom_lines_waste_check CHECK (waste_pct >= 0 AND waste_pct < 100),
  ADD CONSTRAINT product_bom_lines_version_check CHECK (version >= 1),
  ADD CONSTRAINT product_bom_lines_unit_check
    CHECK (unit IN ('piece','gram','kg','ml','litre','meter'));

-- ---------------------------------------------------------------------
-- 8. DOCUMENT NUMBER SERIES
--
-- Reuse the existing gapless series mechanism rather than inventing per-table
-- counters. Gaps are acceptable on these (they are internal documents, not GST
-- invoices), but sharing the mechanism keeps one code path.
--
-- `doc_type` carries its own allowlist from 0001, so it has to be widened before
-- the new series can be inserted — the CHECK is what caught this, exactly as it
-- should. Widened, never replaced: every existing doc_type stays legal.
-- ---------------------------------------------------------------------
ALTER TABLE document_number_series DROP CONSTRAINT IF EXISTS document_number_series_doc_type_check;
ALTER TABLE document_number_series ADD CONSTRAINT document_number_series_doc_type_check
  CHECK (doc_type IN (
    'order','invoice','credit_note','refund','return','exchange',
    'purchase_order','goods_receipt','stock_transfer','quotation',
    -- new in 0003
    'purchase_return','stock_count','production'
  ));

INSERT INTO document_number_series (doc_type, scope_key, prefix, pad_width, next_value) VALUES
  ('purchase_return', '2026', 'PRET-2026-', 5, 1),
  ('stock_count',     '2026', 'CNT-2026-',  5, 1),
  ('production',      '2026', 'PRD-2026-',  5, 1)
ON CONFLICT (doc_type, scope_key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 9. updated_at triggers, matching every other table in 0001
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_warehouse_locations_updated BEFORE UPDATE ON warehouse_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_supplier_products_updated BEFORE UPDATE ON supplier_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_purchase_returns_updated BEFORE UPDATE ON purchase_returns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_stock_counts_updated BEFORE UPDATE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_production_orders_updated BEFORE UPDATE ON production_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
