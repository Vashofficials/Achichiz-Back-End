import { afterEach, describe, expect, it } from 'vitest';
import {
  hashPassword,
  hashSecret,
  passwordAlgo,
  setBcryptVerifier,
  verifyPassword,
  verifySecret,
} from './password.js';
import {
  decideRefresh,
  hashRefreshToken,
  newRefreshToken,
  parseCookies,
  ttlSeconds,
  type SessionSnapshot,
} from './refresh-token.js';
import {
  loginBody,
  otpVerifyBody,
  resetPasswordBody,
  signupBody,
} from './auth.schemas.js';
import { toCustomerSummary } from './auth.service.js';
import type { CustomerRow } from './auth.repository.js';

/**
 * Pure tests. No Postgres, no Redis, no SMS gateway.
 *
 * What is worth testing here is the part that decides whether a credential is
 * accepted — the refresh rotation state machine, the bcrypt→argon2id upgrade
 * decision, and the request contracts. The database round trips around them are
 * thin; the decisions are not.
 */

/* -------------------------------------------------------------- fixtures */

const NOW = new Date('2026-08-08T10:00:00.000Z');

const session = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id: 'session-1',
  customerId: 'customer-1',
  revokedAt: null,
  expiresAt: new Date('2026-09-07T10:00:00.000Z'),
  ...overrides,
});

const customerRow = (overrides: Partial<CustomerRow> = {}): CustomerRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'arjun@example.com',
  mobile: '9820012345',
  fullName: 'Arjun Mehta',
  birthday: null,
  gender: null,
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
  authProviderUid: null,
  firebaseUid: null,
  emailVerifiedAt: null,
  mobileVerifiedAt: null,
  marketingOptIn: false,
  whatsappOptIn: false,
  segment: null,
  corporateAccountId: null,
  defaultBillingGstin: null,
  tags: [],
  acceptsCod: true,
  blockedAt: null,
  blockedReason: null,
  firstOrderAt: null,
  lastOrderAt: null,
  legacyRef: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

/* ------------------------------------------------------ rotation + reuse */

describe('decideRefresh — rotation and reuse detection', () => {
  it('rotates a live session', () => {
    expect(decideRefresh(session(), null, NOW)).toEqual({
      kind: 'rotate',
      sessionId: 'session-1',
      customerId: 'customer-1',
    });
  });

  it('flags a token that was already spent as reuse', () => {
    // No live row holds this hash any more, but Redis remembers issuing it.
    // Somebody kept a copy of a token that was exchanged — that is the signal.
    expect(decideRefresh(null, 'session-9', NOW)).toEqual({ kind: 'reuse', sessionId: 'session-9' });
  });

  it('rejects an unknown token without claiming reuse', () => {
    // A token nobody has ever seen is a guess or a stale client, not a replay.
    // Calling it reuse would let anyone revoke a session by posting garbage —
    // except there is no session to name, which is exactly why it must not.
    expect(decideRefresh(null, null, NOW)).toEqual({ kind: 'reject', reason: 'unknown' });
  });

  it('rejects a revoked session', () => {
    expect(decideRefresh(session({ revokedAt: NOW }), null, NOW)).toEqual({
      kind: 'reject',
      reason: 'revoked',
    });
  });

  it('rejects an expired session', () => {
    const expired = session({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(decideRefresh(expired, null, NOW)).toEqual({ kind: 'reject', reason: 'expired' });
  });

  it('treats expiry as exclusive — a token expiring exactly now is dead', () => {
    const boundary = session({ expiresAt: new Date(NOW.getTime()) });
    expect(decideRefresh(boundary, null, NOW)).toEqual({ kind: 'reject', reason: 'expired' });
  });

  it('prefers the live row when the same hash is also remembered as spent', () => {
    // Belt and braces: a stale Redis key must never revoke a session whose row
    // still holds that hash, or every legitimate refresh after a Redis quirk
    // would sign the customer out.
    expect(decideRefresh(session(), 'session-1', NOW)).toMatchObject({ kind: 'rotate' });
  });

  it('does not rotate a revoked session even when the hash is the current one', () => {
    // Sign-out sets revoked_at without clearing the hash. The most recently
    // issued token must stop working the moment the session is revoked.
    expect(decideRefresh(session({ revokedAt: NOW }), 'session-1', NOW)).toEqual({
      kind: 'reject',
      reason: 'revoked',
    });
  });
});

describe('refresh token minting', () => {
  it('mints unguessable, distinct tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newRefreshToken()));
    expect(tokens.size).toBe(200);
    // 32 bytes of base64url — no padding, URL-safe alphabet only.
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically, and never stores the token itself', () => {
    const token = newRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(token)).not.toContain(token);
  });

  it('produces different hashes for tokens differing in one character', () => {
    expect(hashRefreshToken('aaaa')).not.toBe(hashRefreshToken('aaab'));
  });
});

/* ----------------------------------------------------------------- cookies */

describe('parseCookies', () => {
  it('returns an empty map for a missing header', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('splits on the FIRST "=" only', () => {
    // base64 (not base64url) values legitimately end in "=". Splitting on every
    // "=" silently truncates the token and every refresh 401s.
    expect(parseCookies('ach_rt=abc==')).toEqual({ ach_rt: 'abc==' });
  });

  it('reads one cookie out of several', () => {
    expect(parseCookies('theme=dark; ach_rt=tok123; other=x')).toEqual({
      theme: 'dark',
      ach_rt: 'tok123',
      other: 'x',
    });
  });

  it('decodes percent-encoding, and survives a malformed escape', () => {
    expect(parseCookies('a=one%20two')).toEqual({ a: 'one two' });
    expect(parseCookies('a=%E0%A4')).toEqual({ a: '%E0%A4' });
  });

  it('ignores valueless fragments rather than inventing keys', () => {
    expect(parseCookies('; =novalue; ach_rt=t')).toEqual({ ach_rt: 't' });
  });
});

describe('ttlSeconds', () => {
  it('parses the jose duration subset used by env', () => {
    expect(ttlSeconds('15m')).toBe(900);
    expect(ttlSeconds('10m')).toBe(600);
    expect(ttlSeconds('30s')).toBe(30);
    expect(ttlSeconds('2h')).toBe(7200);
    expect(ttlSeconds('7d')).toBe(604_800);
    expect(ttlSeconds('45')).toBe(45);
  });

  it('falls back rather than reporting a nonsense expiry', () => {
    // `expiresIn: NaN` would make an SPA's silent-refresh timer fire immediately
    // or never. A wrong-but-sane number is strictly better.
    expect(ttlSeconds('not-a-duration')).toBe(900);
    expect(ttlSeconds('')).toBe(900);
  });
});

/* ------------------------------------------------- password + supabase path */

describe('passwordAlgo — reading the algorithm out of the hash', () => {
  it('recognises argon2id', () => {
    expect(passwordAlgo('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe('argon2id');
  });

  it('recognises every bcrypt modular-crypt prefix Supabase might emit', () => {
    for (const prefix of ['$2a$', '$2b$', '$2x$', '$2y$']) {
      expect(passwordAlgo(`${prefix}10$abcdefghijklmnopqrstuv`)).toBe('bcrypt');
    }
  });

  it('refuses to guess at anything else', () => {
    expect(passwordAlgo('5f4dcc3b5aa765d61d8327deb882cf99')).toBe('unknown');
    expect(passwordAlgo('')).toBe('unknown');
  });
});

describe('verifyPassword', () => {
  afterEach(() => {
    setBcryptVerifier(null);
  });

  it('accepts a correct argon2id password and does not ask for a rehash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('Correct horse battery staple', hash)).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('fails closed on a corrupt hash instead of throwing a 500', async () => {
    await expect(verifyPassword('anything', '$argon2id$truncated')).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('fails closed on an unrecognised hash format', async () => {
    await expect(verifyPassword('anything', 'plaintext-oh-no')).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  describe('the Supabase bcrypt migration path', () => {
    const BCRYPT = '$2b$10$abcdefghijklmnopqrstuv';

    it('asks for a rehash after a successful bcrypt verification', async () => {
      // This is what stops a migrated customer ever being told to reset: their
      // bcrypt hash verifies, and `needsRehash` tells the service to write an
      // argon2id hash on this same login, using the plaintext it will not see again.
      setBcryptVerifier((plain) => Promise.resolve(plain === 'legacy-supabase-password'));
      await expect(verifyPassword('legacy-supabase-password', BCRYPT)).resolves.toEqual({
        ok: true,
        needsRehash: true,
      });
    });

    it('does not ask for a rehash when the bcrypt password was wrong', async () => {
      setBcryptVerifier(() => Promise.resolve(false));
      await expect(verifyPassword('wrong', BCRYPT)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
    });

    it('fails closed when no bcrypt verifier is registered', async () => {
      // No bcrypt library is a dependency yet. Until one is approved, a migrated
      // login must fail — never succeed by skipping verification.
      await expect(verifyPassword('legacy-supabase-password', BCRYPT)).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
    });
  });
});

describe('hashSecret / verifySecret — OTP codes and reset tokens', () => {
  it('round-trips a six-digit code without storing it', async () => {
    const hash = await hashSecret('482913');
    expect(hash).not.toContain('482913');
    await expect(verifySecret('482913', hash)).resolves.toBe(true);
    await expect(verifySecret('482914', hash)).resolves.toBe(false);
  });
});

/* ---------------------------------------------------------------- contracts */

describe('auth request schemas', () => {
  it('defaults marketing consent to OFF when the field is absent', () => {
    const parsed = signupBody.parse({
      fullName: 'Arjun Mehta',
      email: 'arjun@example.com',
      password: 'a-long-enough-password',
    });
    // A10 / DPDP: consent is never pre-ticked and never inferred from silence.
    expect(parsed.marketingOptIn).toBe(false);
  });

  it('keeps an explicit opt-in', () => {
    const parsed = signupBody.parse({
      fullName: 'Arjun Mehta',
      email: 'arjun@example.com',
      password: 'a-long-enough-password',
      marketingOptIn: true,
    });
    expect(parsed.marketingOptIn).toBe(true);
  });

  it('rejects a short password at the edge', () => {
    const base = { fullName: 'Arjun Mehta', email: 'arjun@example.com' };
    expect(signupBody.safeParse({ ...base, password: 'a'.repeat(9) }).success).toBe(false);
    expect(signupBody.safeParse({ ...base, password: 'a'.repeat(10) }).success).toBe(true);
  });

  it('bounds password length so hashing cost cannot be driven by the client', () => {
    const base = { fullName: 'Arjun Mehta', email: 'arjun@example.com' };
    expect(signupBody.safeParse({ ...base, password: 'a'.repeat(257) }).success).toBe(false);
  });

  it('rejects a malformed email', () => {
    expect(
      signupBody.safeParse({ fullName: 'Arjun Mehta', email: 'arjun@', password: 'longenough1' })
        .success,
    ).toBe(false);
  });

  it('does not cap login password length the way signup does', () => {
    // Signup bounds the plaintext because it will be hashed; login must still
    // accept a long-but-wrong string, and reject it as a credential rather than
    // as a validation error — a 422 here would leak that the format was unusual.
    expect(loginBody.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(true);
  });

  it('accepts a six-digit OTP and nothing else', () => {
    const base = { mobile: '9820012345' };
    expect(otpVerifyBody.safeParse({ ...base, code: '482913' }).success).toBe(true);
    expect(otpVerifyBody.safeParse({ ...base, code: '48291' }).success).toBe(false);
    expect(otpVerifyBody.safeParse({ ...base, code: '4829133' }).success).toBe(false);
    expect(otpVerifyBody.safeParse({ ...base, code: '48291a' }).success).toBe(false);
  });

  it('rejects a mobile number that is not an Indian ten-digit one', () => {
    for (const bad of ['5820012345', '98200123', '+919820012345', '09820012345']) {
      expect(otpVerifyBody.safeParse({ mobile: bad, code: '482913' }).success).toBe(false);
    }
    expect(otpVerifyBody.safeParse({ mobile: '9820012345', code: '482913' }).success).toBe(true);
  });

  it('requires a reset token long enough to carry a challenge id and a secret', () => {
    expect(resetPasswordBody.safeParse({ token: 'short', password: 'longenough1' }).success).toBe(false);
    expect(
      resetPasswordBody.safeParse({
        token: `${'1'.repeat(36)}.${'a'.repeat(43)}`,
        password: 'longenough1',
      }).success,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------- projection */

describe('toCustomerSummary', () => {
  it('reports verification as booleans and never exposes the password hash', () => {
    const summary = toCustomerSummary(
      customerRow({ emailVerifiedAt: NOW, mobileVerifiedAt: null }),
    );
    expect(summary).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      fullName: 'Arjun Mehta',
      email: 'arjun@example.com',
      mobile: '9820012345',
      emailVerified: true,
      mobileVerified: false,
      marketingOptIn: false,
      whatsappOptIn: false,
      hasPassword: true,
      createdAt: NOW.toISOString(),
    });
    expect(JSON.stringify(summary)).not.toContain('argon2');
  });

  it('tells the storefront when an OTP-only account has no password yet', () => {
    expect(toCustomerSummary(customerRow({ passwordHash: null })).hasPassword).toBe(false);
  });
});
