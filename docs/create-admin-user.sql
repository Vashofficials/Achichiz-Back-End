-- ===========================================================================
-- Create the main Super Admin
--
--   email    Vashtechnical@gmail.com
--   password 123456780
--
-- Run against the Achichiz database. Safe to run more than once — it upserts.
-- ===========================================================================
--
-- ## Why the hash is pre-computed and not written in SQL
--
-- `staff_users.password_hash` is argon2id. Postgres has no argon2 function, so
-- the hash below was generated with the API's own hasher (`hashPassword` in
-- `src/modules/auth/password.js`, m=19456 t=2 p=1) and round-trip verified
-- against `verifyPassword`. It is byte-compatible with what
-- `POST /v1/admin/auth/login` checks. Do not hand-edit it.
--
-- Argon2id salts every hash, so re-running the generator produces a different
-- string for the same password. That is correct and expected.
--
-- ## Before you run this
--
-- Roles must already exist. If `npm run db:seed` has never been run against this
-- database, the SELECT below finds nothing and the insert fails on the NOT NULL
-- `role_id` — which is the right failure, rather than a staff user with no role.
--
--   npm run db:seed        -- seeds 11 roles and 287 permission grants
--
-- ===========================================================================

BEGIN;

INSERT INTO staff_users (email, full_name, password_hash, role_id, status, mfa_enabled)
SELECT
  'Vashtechnical@gmail.com',
  'Vash',
  -- argon2id of: 123456780
  '$argon2id$v=19$m=19456,t=2,p=1$Jk6gCzNWl3uR9OzuFetZmw$LlSOs7t7zvZFMIpdMTXGI6133k5XE9ON3injk17Nuus',
  r.id,
  'active',
  FALSE                       -- enrols an authenticator on first sign-in
FROM roles r
WHERE r.key = 'super_admin'
-- `uq_staff_email` is PARTIAL (WHERE deleted_at IS NULL), so the predicate has to
-- be repeated here or Postgres cannot match the arbiter index.
ON CONFLICT (email) WHERE deleted_at IS NULL
DO UPDATE SET
  password_hash       = EXCLUDED.password_hash,
  role_id             = EXCLUDED.role_id,
  status              = 'active',
  full_name           = EXCLUDED.full_name,
  -- Clear the lockout counters, so a re-run also rescues an account that has
  -- been locked by failed sign-ins.
  failed_login_count  = 0,
  locked_until        = NULL,
  password_changed_at = now(),
  updated_at          = now();

COMMIT;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

SELECT s.email,
       s.full_name,
       r.name  AS role,
       s.status,
       s.mfa_enabled,
       s.deleted_at
  FROM staff_users s
  JOIN roles r ON r.id = s.role_id
 WHERE s.email = 'Vashtechnical@gmail.com';

-- Expect exactly one row:
--   Vashtechnical@gmail.com | Vash | Super Admin | active | f | NULL
--
-- `email` is CITEXT, so the lookup is case-insensitive — signing in as
-- `vashtechnical@gmail.com` finds the same row.


-- ===========================================================================
-- Stronger password — swap this in instead
-- ===========================================================================
--
-- `123456780` is nine digits. The API's own policy for a staff password is
-- **at least 12 characters with upper case, lower case and a digit**
-- (`newPassword` in admin-auth.schemas.ts). Login only enforces min(1), so the
-- inserted hash above works — but `POST /v1/admin/auth/password/reset` would
-- refuse to ever set that password again through the API.
--
-- This one satisfies the policy. Password: Achichiz@2026Adm
--
-- UPDATE staff_users
--    SET password_hash = '$argon2id$v=19$m=19456,t=2,p=1$VKf2KyiF1444cNYxk8LBew$3Z5PiC0GTZyjUyQhm1xSaFB3ncu9wJfVpfwXl0EXx+M',
--        password_changed_at = now(),
--        updated_at = now()
--  WHERE email = 'Vashtechnical@gmail.com'
--    AND deleted_at IS NULL;


-- ===========================================================================
-- What happens at first sign-in
-- ===========================================================================
--
-- `mfa_enabled` is FALSE, so the console will walk the enrolment branch. There
-- is no way to skip it — a Super Admin cannot obtain a token without an
-- authenticator.
--
--   1. POST /v1/admin/auth/login       { email, password }
--        → 200 { data: { status: "enrolment_required", challengeToken } }
--
--   2. POST /v1/admin/auth/2fa/setup   { challengeToken }
--        → { secret, otpauthUri }        ← scan otpauthUri with Google Authenticator
--
--   3. POST /v1/admin/auth/2fa/enable  { challengeToken, code }
--        → 201 { recoveryCodes[], tokens }
--
-- `secret` and the ten `recoveryCodes` are shown ONCE — only hashes are stored.
-- Save the recovery codes before leaving that screen or the only way back in is
-- another SQL statement.
