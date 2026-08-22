import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { logger } from '../../config/logger.js';

/**
 * Password hashing, and the Supabase bcrypt→argon2id migration path.
 *
 * New hashes are argon2id at the OWASP parameters. bcrypt is never produced
 * here — its 72-byte silent truncation is a footgun — but it is *verified*,
 * because Supabase's GoTrue stores standard `$2a$`/`$2b$` modular-crypt bcrypt
 * in `auth.users.encrypted_password`. Those hashes are portable, which is the
 * whole reason migrating off Supabase Auth does not force a password reset on
 * every existing customer (03_schema.md §5.2).
 *
 * The algorithm is read from the hash prefix rather than from a `password_algo`
 * column. 04_architecture.md §3.2 proposes the column; the shipped schema
 * (`customers.password_hash`) does not have one, and modular crypt format is
 * self-describing anyway — one less field that can disagree with reality.
 */

/** OWASP-recommended argon2id parameters (04_architecture.md §3.3). */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export type PasswordAlgo = 'argon2id' | 'bcrypt' | 'unknown';

/** Modular crypt format is self-describing. `$2a$`/`$2b$`/`$2x$`/`$2y$` are all bcrypt. */
export function passwordAlgo(hash: string): PasswordAlgo {
  if (hash.startsWith('$argon2')) return 'argon2id';
  if (/^\$2[abxy]?\$/.test(hash)) return 'bcrypt';
  return 'unknown';
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * bcrypt verification is injected rather than imported.
 *
 * No bcrypt library is in `package.json`, and adding one is the project owner's
 * call. Everything else on the migration path — detection, verification
 * dispatch, transparent re-hash on successful login, storing the upgraded hash —
 * is built and tested. When the dependency is approved, this is the whole wiring:
 *
 * ```ts
 * import bcrypt from 'bcryptjs';
 * setBcryptVerifier((plain, hash) => bcrypt.compare(plain, hash));
 * ```
 *
 * Until then a migrated customer's first login fails closed with
 * `bcrypt_unsupported` (logged, never surfaced) rather than silently succeeding.
 */
export type BcryptVerifier = (plain: string, hash: string) => Promise<boolean>;

let bcryptVerifier: BcryptVerifier | null = null;

export function setBcryptVerifier(verifier: BcryptVerifier | null): void {
  bcryptVerifier = verifier;
}

export const hasBcryptVerifier = (): boolean => bcryptVerifier !== null;

/**
 * A per-process argon2id hash of random bytes.
 *
 * Login verifies against this when the account does not exist or has no
 * password, so "unknown email" and "wrong password" cost the same wall-clock
 * time. Without it, response latency is an account-enumeration oracle no matter
 * how carefully the response bodies are matched.
 */
let dummyHash: Promise<string> | null = null;
const dummy = (): Promise<string> => (dummyHash ??= argon2.hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS));

/** Burn the same CPU as a real verification, and always return false. */
export async function burnVerificationTime(plain: string): Promise<false> {
  try {
    await argon2.verify(await dummy(), plain);
  } catch {
    /* the dummy never matches; the point is the time, not the answer */
  }
  return false;
}

export type VerifyResult = {
  ok: boolean;
  /** True when the stored hash is bcrypt or uses stale argon2 parameters. */
  needsRehash: boolean;
};

export async function verifyPassword(plain: string, storedHash: string): Promise<VerifyResult> {
  const algo = passwordAlgo(storedHash);

  if (algo === 'bcrypt') {
    if (!bcryptVerifier) {
      logger.error(
        { reason: 'bcrypt_unsupported' },
        'A customer with a migrated Supabase bcrypt hash tried to sign in, but no bcrypt verifier is registered. ' +
          'Register one with setBcryptVerifier() — see modules/auth/password.ts.',
      );
      await burnVerificationTime(plain);
      return { ok: false, needsRehash: false };
    }
    const ok = await bcryptVerifier(plain, storedHash);
    // A verified bcrypt hash is upgraded to argon2id on this login and never seen again.
    return { ok, needsRehash: ok };
  }

  if (algo === 'unknown') {
    logger.error({ reason: 'unknown_password_algo' }, 'Stored password hash is in an unrecognised format');
    await burnVerificationTime(plain);
    return { ok: false, needsRehash: false };
  }

  let ok = false;
  try {
    ok = await argon2.verify(storedHash, plain);
  } catch {
    // A corrupt or truncated hash is a failed login, not a 500.
    ok = false;
  }
  return { ok, needsRehash: ok && argon2.needsRehash(storedHash, ARGON2_OPTIONS) };
}

/**
 * OTP codes and reset-token secrets are argon2id-hashed too.
 *
 * A 6-digit code has a 10^6 search space — sha256 of it is trivially reversed
 * from a table dump. argon2id makes that cost real. The verification happens at
 * most `max_attempts` times per challenge, so the ~50 ms is bounded.
 */
export async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, ARGON2_OPTIONS);
}

export async function verifySecret(secret: string, storedHash: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, secret);
  } catch {
    return false;
  }
}
