/**
 * TOTP second factor and recovery codes — pure logic, no I/O.
 *
 * The rule this file exists to encode: **every write-capable role must carry a
 * second factor.** The admin console's own RBAC matrix decides what "write
 * capable" means — a role whose grants are nothing but `view` and `export`
 * cannot change anything, so forcing an authenticator app on a Read-only Analyst
 * buys no security and costs adoption. Everyone else is gated.
 *
 * That check runs against the permission set resolved at login, not against a
 * hardcoded role list, so adding a grant to a role automatically pulls it into
 * the 2FA requirement instead of quietly leaving a hole.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { authenticator } from 'otplib';

/**
 * One step of clock drift either way. `otplib`'s default is 0, which is a
 * support ticket generator; a window of 3 or more meaningfully widens the
 * brute-force surface on a six-digit code.
 */
authenticator.options = { window: 1 };

/** Actions that cannot change anything. Everything else makes a role write-capable. */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(['view', 'export']);

/**
 * True when the permission set contains at least one grant that mutates state.
 *
 * Takes the `module:action` wire format stored in `role_permissions` and embedded
 * in the staff JWT, so it works identically at login and mid-session.
 */
export function isWriteCapable(permissions: Iterable<string>): boolean {
  for (const permission of permissions) {
    const action = permission.slice(permission.indexOf(':') + 1);
    if (!READ_ONLY_ACTIONS.has(action)) return true;
  }
  return false;
}

/**
 * What a correct password entitles you to — the whole 2FA policy, as a pure
 * function so it can be tested without a database, a clock or a Redis.
 *
 *  - `mfa_required`   the account has an authenticator; present a code.
 *  - `enrol_required` the account can change things but has no second factor.
 *                     No session is issued. This is the hard gate.
 *  - `session`        read-only role, or 2FA already satisfied.
 */
export type LoginOutcome = 'session' | 'mfa_required' | 'enrol_required';

export function decideLoginOutcome(input: {
  mfaEnabled: boolean;
  permissions: Iterable<string>;
}): LoginOutcome {
  if (input.mfaEnabled) return 'mfa_required';
  return isWriteCapable(input.permissions) ? 'enrol_required' : 'session';
}

/** Base32 shared secret for an authenticator app. */
export const newTotpSecret = (): string => authenticator.generateSecret();

/** The `otpauth://` URI a QR code encodes. */
export const totpKeyUri = (email: string, secret: string, issuer = 'Achichiz Admin'): string =>
  authenticator.keyuri(email, issuer, secret);

/**
 * Verify a six-digit code.
 *
 * `otplib` throws on a malformed secret rather than returning false, and a
 * corrupt secret column must be a failed login, not a 500.
 */
export function verifyTotp(code: string, secret: string): boolean {
  try {
    return authenticator.check(code.trim(), secret);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------- recovery codes */

/** Unambiguous alphabet: no O/0, no I/1/L. These get read off paper. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;
const GROUP = 5;

/** `A3K9F-2XQM7` — ten of these are issued when 2FA is enabled. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(GROUP * 2);
  let out = '';
  for (let i = 0; i < GROUP * 2; i += 1) {
    if (i === GROUP) out += '-';
    // `bytes[i]` is in range by construction; noUncheckedIndexedAccess still
    // types it as possibly undefined, hence the coalesce.
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return out;
}

export const newRecoveryCodes = (count = RECOVERY_CODE_COUNT): string[] =>
  Array.from({ length: count }, () => newRecoveryCode());

/** Uppercase, strip separators — so `a3k9f 2xqm7` matches `A3K9F-2XQM7`. */
export const normaliseRecoveryCode = (code: string): string =>
  code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * sha256 of the normalised code — the same reasoning as the refresh tokens in
 * `modules/auth/refresh-token.ts`. A recovery code is ~49 bits of CSPRNG from a
 * fixed alphabet, so there is no dictionary to grind and argon2's cost would buy
 * nothing but ten slow verifications per attempt. Only the digest is stored.
 */
export const hashRecoveryCode = (code: string): string =>
  createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');

/**
 * Constant-time comparison against a stored digest.
 *
 * The candidate is checked against up to ten digests in a loop; an early-exit
 * `===` would leak which index matched through timing.
 */
export function recoveryCodeMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashRecoveryCode(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
