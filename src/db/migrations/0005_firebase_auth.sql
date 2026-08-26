-- 0005_firebase_auth.sql
--
-- Firebase phone authentication.
--
-- OTP delivery moves from MSG91 to Firebase Auth. The important consequence is
-- WHERE the secret lives: with MSG91 we generated a code, hashed it into
-- `otp_challenges`, and verified it ourselves. With Firebase, Google holds the
-- challenge and we never see the code at all. The backend's job shrinks to one
-- thing — verify the signed ID token the client presents, and map it onto a
-- customer row.
--
-- ## Why `auth_provider_uid` cannot be reused
--
-- `customers.auth_provider_uid` is `UUID`, sized for Supabase, whose user ids
-- genuinely are UUIDs. A Firebase UID is not: it is a 28-character
-- base62-ish string such as `k2Jd8fLpQ4Xb9RtY7mNc3VwZ1aBs`. Casting one into a
-- UUID column is not a tight fit that needs a longer field — it is a type error
-- that every insert would reject. So this adds a separate `firebase_uid TEXT`
-- and leaves the Supabase column alone; an account migrated from Supabase and
-- later linked to Firebase legitimately carries both.
--
-- ## Why the unique index is partial
--
-- Same shape as `uq_customers_email` and `uq_customers_mobile`: unique among
-- LIVE rows only. A soft-deleted customer must not permanently burn a Firebase
-- UID — the same person signing up again with the same phone gets the same UID
-- back from Google, and a full unique index would refuse them forever.
--
-- ## Why `customer_auth_events` exists
--
-- The requirement is that Firebase verifies, and we still record it ourselves.
-- `otp_challenges` cannot serve: its columns describe a challenge WE issued —
-- `code_hash`, `attempts`, `expires_at` — and for a Firebase login every one of
-- them would be NULL or a lie. Writing a row that claims we hashed a code we
-- never saw would corrupt the one table that is supposed to be evidence.
--
-- So Firebase logins get their own append-only trail recording what actually
-- happened: which provider asserted the identity, which UID, which number, and
-- whether the login linked an existing account or created one. That last field
-- is the one worth having — account LINKING is the step where a takeover would
-- occur, and without a record there is no way to audit it after the fact.

-- ---------------------------------------------------------------------------
-- customers.firebase_uid
-- ---------------------------------------------------------------------------

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS firebase_uid TEXT;

COMMENT ON COLUMN customers.firebase_uid IS
  'Firebase Auth UID (28-char string, NOT a UUID — see auth_provider_uid for the '
  'Supabase one). Set on first Firebase sign-in. Partial-unique among live rows.';

-- Firebase UIDs are 28 chars today, but Google documents them only as "a string
-- up to 128 characters". The CHECK bounds the column without pinning it to a
-- length Google never promised.
ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS customers_firebase_uid_check;

ALTER TABLE customers
  ADD CONSTRAINT customers_firebase_uid_check
    CHECK (firebase_uid IS NULL OR (length(firebase_uid) BETWEEN 8 AND 128));

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_firebase_uid
  ON customers (firebase_uid)
  WHERE firebase_uid IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- customer_auth_events
-- ---------------------------------------------------------------------------
--
-- Append-only. There is deliberately no UPDATE path and no `deleted_at`: an
-- audit trail that can be edited is not one.

CREATE TABLE IF NOT EXISTS customer_auth_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   UUID REFERENCES customers (id) ON DELETE SET NULL,

  -- Who asserted the identity. 'password' and 'otp_msg91' are the pre-Firebase
  -- paths, kept so the trail is continuous across the cutover.
  provider      TEXT NOT NULL
                CHECK (provider IN ('firebase_phone','firebase_google','password','otp_msg91')),

  -- What happened to the account, not merely that a login occurred.
  -- 'linked' is the interesting one: an existing customer row gained a new
  -- credential. That is where an account takeover would show up.
  outcome       TEXT NOT NULL
                CHECK (outcome IN ('signed_in','linked','created','rejected')),

  firebase_uid  TEXT,
  mobile        TEXT,
  email         TEXT,

  -- Why a 'rejected' row was rejected. Non-null exactly when outcome='rejected',
  -- so a refusal can never be recorded without a reason.
  reason        TEXT,

  ip            INET,
  user_agent    TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT auth_event_reason_required
    CHECK ((outcome = 'rejected') = (reason IS NOT NULL))
);

COMMENT ON TABLE customer_auth_events IS
  'Append-only record of customer authentication outcomes. Written for every '
  'Firebase sign-in because Firebase holds the OTP challenge and otp_challenges '
  'cannot honestly describe a code we never issued.';

CREATE INDEX idx_auth_events_customer
  ON customer_auth_events (customer_id, occurred_at DESC);

CREATE INDEX idx_auth_events_uid
  ON customer_auth_events (firebase_uid)
  WHERE firebase_uid IS NOT NULL;

-- Rejections and links are what anyone reads this table for; the index is
-- partial so it stays small next to the mass of ordinary sign-ins.
CREATE INDEX idx_auth_events_notable
  ON customer_auth_events (occurred_at DESC)
  WHERE outcome IN ('linked','rejected');
