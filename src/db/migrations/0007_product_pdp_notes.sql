-- 0007_product_pdp_notes.sql
--
-- Per-product PDP copy that used to be hard-coded in the storefront.
--
-- The product page appended one fixed sentence to EVERY description ("Every gift
-- leaves the studio checked twice, wrapped in tissue and sealed with our
-- signature wax stamp.") and showed one fixed paragraph in the Delivery tab. A
-- jhumka and a candle hamper got identical packaging and delivery promises, and
-- changing either meant a storefront deploy.
--
-- Both become nullable columns on `products` — no new table; this is one short
-- string per product, not a collection. NULL means "use the storefront default",
-- so every existing product renders exactly as it does today until someone edits
-- it in the Admin Panel.
--
-- The "What's inside" bullets already have a home (`product_content_items`) and
-- are not touched here; they gain an admin write path in the API instead.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS care_note TEXT;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS delivery_note TEXT;

COMMENT ON COLUMN products.care_note IS
  'Packaging / care line shown under the PDP description. NULL = storefront default.';
COMMENT ON COLUMN products.delivery_note IS
  'Delivery tab copy on the PDP. NULL = storefront default.';

-- Bounded so a pasted document cannot land in a column rendered on every PDP.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_care_note_check;
ALTER TABLE products
  ADD CONSTRAINT products_care_note_check
    CHECK (care_note IS NULL OR length(care_note) <= 1000);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_delivery_note_check;
ALTER TABLE products
  ADD CONSTRAINT products_delivery_note_check
    CHECK (delivery_note IS NULL OR length(delivery_note) <= 2000);
