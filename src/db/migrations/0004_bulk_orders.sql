-- 0004_bulk_orders.sql
--
-- Corporate bulk orders (spec §88, build phase 5).
--
-- Phase 5 needs one thing the schema does not yet provide: a reservation that
-- belongs to a CAMPAIGN. Everything else it needs already exists —
-- `corporate_campaigns`, `campaign_recipients`, `quotations`, `approvals`,
-- `inventory_levels`, `inventory_reservations`.
--
-- ## Why `inventory_reservations` needs a `campaign_id`
--
-- A bulk reservation has to be RELEASABLE. Without an owner column the only
-- reason an admin hold may carry is `manual_hold` (see the CHECK below), which
-- has no back-reference to anything — so a campaign could place a thousand-unit
-- hold and then have no way to find it again except by remembering the ids in
-- application state. That is not a reservation system, it is a leak.
--
-- ## The latent bug this also fixes
--
-- `inventory_reservations_reason_check` has always allowed `reason = 'quotation'`,
-- while `reservation_has_owner` demands `cart_id IS NOT NULL OR order_id IS NOT
-- NULL OR reason = 'manual_hold'`. The two together make `'quotation'`
-- UNINSERTABLE: it satisfies the first CHECK and violates the second, for every
-- possible row. A value in an enum that no row can ever hold is a promise the
-- schema cannot keep. Adding `campaign_id` to the owner CHECK makes it reachable.
--
-- Both constraints are WIDENED, never replaced with something narrower — every
-- row that was legal before is still legal.

-- ---------------------------------------------------------------------------
-- inventory_reservations.campaign_id
-- ---------------------------------------------------------------------------

ALTER TABLE inventory_reservations
  ADD COLUMN IF NOT EXISTS campaign_id UUID
    REFERENCES corporate_campaigns (id) ON DELETE CASCADE;

COMMENT ON COLUMN inventory_reservations.campaign_id IS
  'The corporate campaign holding this stock. Set for bulk-order reservations; '
  'NULL for cart, order and manual holds. ON DELETE CASCADE: deleting a campaign '
  'must not strand rows that keep reserved_qty elevated forever.';

-- Releasing a campaign''s hold is the hot path: one index, partial on unreleased.
CREATE INDEX IF NOT EXISTS idx_reservations_campaign
  ON inventory_reservations (campaign_id)
  WHERE campaign_id IS NOT NULL AND released_at IS NULL;

-- ---------------------------------------------------------------------------
-- Widen reservation_has_owner
-- ---------------------------------------------------------------------------

ALTER TABLE inventory_reservations
  DROP CONSTRAINT IF EXISTS reservation_has_owner;

ALTER TABLE inventory_reservations
  ADD CONSTRAINT reservation_has_owner CHECK (
    cart_id IS NOT NULL
    OR order_id IS NOT NULL
    OR campaign_id IS NOT NULL
    OR reason = 'manual_hold'
  );

-- ---------------------------------------------------------------------------
-- A campaign hold must say so
-- ---------------------------------------------------------------------------
--
-- Not merely tidiness: `reserved_qty` is decremented by whoever releases the
-- hold, and a campaign hold mislabelled `cart` would be swept by the cart-expiry
-- job — silently releasing stock a corporate customer has already been quoted on.

ALTER TABLE inventory_reservations
  DROP CONSTRAINT IF EXISTS reservation_campaign_reason;

ALTER TABLE inventory_reservations
  ADD CONSTRAINT reservation_campaign_reason CHECK (
    campaign_id IS NULL OR reason IN ('quotation', 'manual_hold')
  );

-- ---------------------------------------------------------------------------
-- Campaign reservations never expire on a clock
-- ---------------------------------------------------------------------------
--
-- A cart hold expires because an abandoned cart must not hold stock forever. A
-- corporate campaign is the opposite case: the whole point of reserving 800 units
-- against a Diwali dispatch is that they are still there in three weeks. It is
-- released explicitly, by POST /release or by fulfilment — never by a timer.

ALTER TABLE inventory_reservations
  DROP CONSTRAINT IF EXISTS reservation_campaign_no_expiry;

ALTER TABLE inventory_reservations
  ADD CONSTRAINT reservation_campaign_no_expiry CHECK (
    campaign_id IS NULL OR expires_at IS NULL
  );

-- ---------------------------------------------------------------------------
-- document_number_series: 'campaign'
-- ---------------------------------------------------------------------------
--
-- Campaign numbers (CMP-2026-00001) come from the same row-locked gapless series
-- every other document uses. Improvising a number in application code would
-- collide with the real series the first time both ran.
--
-- WIDENED, never replaced: all thirteen existing values are carried through.

ALTER TABLE document_number_series DROP CONSTRAINT IF EXISTS document_number_series_doc_type_check;
ALTER TABLE document_number_series ADD CONSTRAINT document_number_series_doc_type_check
  CHECK (doc_type IN (
    'order','invoice','credit_note','refund','return','exchange',
    'purchase_order','goods_receipt','stock_transfer','quotation',
    -- 0003
    'purchase_return','stock_count','production',
    -- 0004
    'campaign'
  ));
