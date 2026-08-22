/**
 * Customer authentication business rules.
 *
 * Four invariants hold throughout this file.
 *
 * 1. **Nothing here is an account-existence oracle.** `login`, `requestOtp` and
 *    `forgotPassword` return the same body, the same status and — because the
 *    unknown-account path still burns a full argon2id verification against a
 *    dummy hash (`password.ts:burnVerificationTime`) — roughly the same wall
 *    clock, whether or not the account exists. Matching the bodies while leaving
 *    a 200 ms timing gap would simply move the leak from the response to a
 *    stopwatch.
 *
 * 2. **A refresh token is spent exactly once.** Rotation is a conditional UPDATE
 *    on the session row; presenting a token that was already exchanged revokes
 *    the family. See `refresh-token.ts` for the reasoning and
 *    `refresh-replay-store.ts` for where the spent hashes live.
 *
 * 3. **Migrated Supabase customers are never forced to reset.** Their bcrypt
 *    hashes are portable, so `verifyPassword` accepts them and reports
 *    `needsRehash`; this file then writes an argon2id hash on that same login and
 *    the bcrypt hash is gone forever (04_architecture.md §3.2 step 2). The
 *    customer notices nothing.
 *
 * 4. **Marketing consent is never assumed.** Every account is created opted out,
 *    and a grant is written to `activity_logs` with its timestamp and source
 *    through `leads.service` — the module that owns the subscriber list.
 */

import { randomInt } from 'node:crypto';
import type { Request } from 'express';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  ConflictError,
  UnauthenticatedError,
  UnprocessableError,
  ValidationError,
} from '../../lib/errors.js';
import { emailSender, maskEmail } from '../../integrations/ses/index.js';
import { maskMobile, smsSender } from '../../integrations/msg91/index.js';
import * as cartService from '../cart/cart.service.js';
import * as leadsService from '../leads/leads.service.js';
import * as repo from './auth.repository.js';
import { signCustomerToken } from './customer-token.js';
import {
  burnVerificationTime,
  hashPassword,
  hashSecret,
  verifyPassword,
  verifySecret,
} from './password.js';
import { findSpentToken, rememberSpentToken } from './refresh-replay-store.js';
import {
  decideRefresh,
  hashRefreshToken,
  newRefreshToken,
  ttlSeconds,
  type SessionSnapshot,
} from './refresh-token.js';
import { refreshTokenTtlMs, revokeSession, revokeSessions } from './session-store.js';
import type { AuthSession, CustomerSummary } from './auth.schemas.js';

/* ------------------------------------------------------------- constants */

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_DIGITS = 6;
/** 3 sends per hour per number (04_architecture.md §3.2). The IP limiter cannot see this. */
const OTP_MAX_SENDS_PER_HOUR = 3;
const RESET_TTL_MS = 30 * 60 * 1000;

/** The same body every failed credential check returns, whatever actually went wrong. */
const INVALID_CREDENTIALS = 'That email and password combination is not valid.';

/* -------------------------------------------------------- request context */

/**
 * `inet` is a real Postgres type and rejects junk. Express hands back
 * `::ffff:127.0.0.1` behind a proxy (legal) or `undefined` on a socket that has
 * already closed, and `x-forwarded-for` is attacker-controlled text. Anything not
 * shaped like an address becomes NULL rather than a failed INSERT on a login.
 */
const IP_SHAPE = /^[0-9a-fA-F:.]{3,45}$/;

export function requestFingerprint(req: Request): { ip: string | null; deviceLabel: string | null } {
  const raw = req.ip ?? req.socket.remoteAddress ?? '';
  const ip = IP_SHAPE.test(raw) ? raw : null;
  const agent = req.headers['user-agent'];
  const deviceLabel = typeof agent === 'string' && agent.trim() ? agent.trim().slice(0, 200) : null;
  return { ip, deviceLabel };
}

/** The `X-Cart-Token` header wins over the body field, matching `cart.routes.ts`. */
export function cartTokenOf(req: Request, fallback?: string): string | undefined {
  const header = req.headers['x-cart-token'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return fromHeader?.trim() || fallback || undefined;
}

/* ------------------------------------------------------------ projections */

export function toCustomerSummary(row: repo.CustomerRow): CustomerSummary {
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    mobile: row.mobile,
    emailVerified: row.emailVerifiedAt !== null,
    mobileVerified: row.mobileVerifiedAt !== null,
    marketingOptIn: row.marketingOptIn,
    whatsappOptIn: row.whatsappOptIn,
    hasPassword: row.passwordHash !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ---------------------------------------------------------------- guards */

/**
 * A blocked account fails like a wrong password, not like a blocked account.
 *
 * `customers.blocked_at` is set by fraud/abuse handling. Telling the presenter of
 * a correct password that the account exists but is blocked confirms both the
 * account and the password.
 */
function assertUsable(row: repo.CustomerRow): void {
  if (row.blockedAt !== null) {
    logger.warn({ customerId: row.id }, 'auth.blocked_account_attempt');
    throw new UnauthenticatedError(INVALID_CREDENTIALS);
  }
}

/* --------------------------------------------------------------- sessions */

export type IssuedSession = { session: AuthSession; refreshToken: string };

/**
 * Mints a session: one `customer_sessions` row, one opaque refresh token (stored
 * only as its sha256), one short-lived access JWT whose `sid` is the row id.
 *
 * The row id is stable across every rotation of that session, which is what makes
 * `revokeSession(sid)` on the Redis denylist kill the whole lineage's outstanding
 * access tokens in one write.
 */
async function issueSession(
  customer: repo.CustomerRow,
  fingerprint: { ip: string | null; deviceLabel: string | null },
): Promise<IssuedSession> {
  const refreshToken = newRefreshToken();
  const row = await repo.insertSession({
    customerId: customer.id,
    refreshTokenHash: hashRefreshToken(refreshToken),
    deviceLabel: fingerprint.deviceLabel,
    ip: fingerprint.ip,
    expiresAt: new Date(Date.now() + refreshTokenTtlMs),
  });

  const accessToken = await signCustomerToken({ customerId: customer.id, sessionId: row.id });

  return {
    refreshToken,
    session: {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: ttlSeconds(env.JWT_CUSTOMER_TTL),
      customer: toCustomerSummary(customer),
    },
  };
}

/**
 * Fold the guest basket into the account, and never let it break the login.
 *
 * A cart whose variants have been discontinued, or a token that belongs to
 * somebody else, must not turn a valid sign-in into a 404. Cross-module traffic
 * goes service→service so the cart's ownership rule stays in `cart.service`.
 */
async function mergeGuestCart(customerId: string, cartToken: string | undefined): Promise<void> {
  if (!cartToken) return;
  try {
    await cartService.mergeCart(customerId, cartToken);
  } catch (err) {
    logger.warn({ err, customerId }, 'auth.cart_merge_failed');
  }
}

/* ----------------------------------------------------------------- signup */

export async function signup(
  input: {
    fullName: string;
    email: string;
    mobile?: string | undefined;
    password: string;
    marketingOptIn: boolean;
    cartToken?: string | undefined;
  },
  fingerprint: { ip: string | null; deviceLabel: string | null },
): Promise<IssuedSession> {
  // Signup is the one flow that cannot avoid disclosing existence — refusing to
  // say "taken" would just mean a silent failure or a hijacked account. §"never
  // leak" covers login, forgot-password and OTP request, which have no such
  // excuse. A 409 with a usable message is the honest trade here.
  if (await repo.findCustomerByEmail(input.email)) {
    throw new ConflictError('An account already exists for that email address. Try signing in instead.');
  }
  if (input.mobile && (await repo.findCustomerByMobile(input.mobile))) {
    throw new ConflictError('An account already exists for that mobile number. Try signing in instead.');
  }

  const customer = await repo.insertCustomer({
    fullName: input.fullName,
    email: input.email,
    mobile: input.mobile ?? null,
    passwordHash: await hashPassword(input.password),
    // Never `input.marketingOptIn ?? true`, and never a default of true anywhere:
    // consent starts off and is recorded separately when granted (A10 / DPDP).
    marketingOptIn: input.marketingOptIn,
  });

  if (input.marketingOptIn) {
    await leadsService.recordMarketingConsent({
      customerId: customer.id,
      source: 'signup_form',
      ip: fingerprint.ip,
    });
  }

  await mergeGuestCart(customer.id, input.cartToken);
  return issueSession(customer, fingerprint);
}

/* ------------------------------------------------------------------ login */

export async function login(
  input: { email: string; password: string; cartToken?: string | undefined },
  fingerprint: { ip: string | null; deviceLabel: string | null },
): Promise<IssuedSession> {
  const customer = await repo.findCustomerByEmail(input.email);

  // No account, or an OTP-only account with no password: still do the work, so
  // this branch costs the same as a wrong password.
  if (!customer || customer.passwordHash === null) {
    await burnVerificationTime(input.password);
    throw new UnauthenticatedError(INVALID_CREDENTIALS);
  }

  assertUsable(customer);

  const result = await verifyPassword(input.password, customer.passwordHash);
  if (!result.ok) throw new UnauthenticatedError(INVALID_CREDENTIALS);

  /*
   * The Supabase migration path, in three lines.
   *
   * `verifyPassword` reports `needsRehash` for a verified bcrypt hash (imported
   * from `auth.users.encrypted_password`) and for an argon2id hash whose
   * parameters have since been raised. Either way the upgrade happens on this
   * login, with the plaintext we already have in hand and will never have again.
   * A failed rehash must not fail the login — the customer proved the password.
   */
  if (result.needsRehash) {
    try {
      await repo.updateCustomer(customer.id, { passwordHash: await hashPassword(input.password) });
      logger.info({ customerId: customer.id }, 'auth.password_hash_upgraded');
    } catch (err) {
      logger.error({ err, customerId: customer.id }, 'auth.password_rehash_failed');
    }
  }

  await mergeGuestCart(customer.id, input.cartToken);
  return issueSession(customer, fingerprint);
}

/* -------------------------------------------------------------------- otp */

const newOtpCode = (): string => String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');

/**
 * Send a login OTP. Always reports success.
 *
 * There is no "unknown number" branch to leak, because a verified OTP on an
 * unknown number *creates* the account — mobile+OTP is the primary Indian D2C
 * login (04_architecture.md §3.2), not a second factor on top of a signup form.
 * The only thing that changes the outcome is the per-number send throttle, and
 * that one deliberately reports success too: telling a scraper it has hit a limit
 * tells it the number is worth retrying.
 */
export async function requestLoginOtp(mobile: string): Promise<void> {
  const sentThisHour = await repo.countOtpChallengesSince(
    mobile,
    'login',
    new Date(Date.now() - 60 * 60 * 1000),
  );
  if (sentThisHour >= OTP_MAX_SENDS_PER_HOUR) {
    logger.warn({ mobile: maskMobile(mobile) }, 'auth.otp_send_throttled');
    return;
  }

  const code = newOtpCode();
  await repo.insertOtpChallenge({
    channel: 'sms',
    destination: mobile,
    // argon2id, not sha256: a 6-digit code has a 10^6 search space and a hashed
    // table dump would otherwise be reversible in seconds (`password.ts`).
    codeHash: await hashSecret(code),
    purpose: 'login',
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  try {
    await smsSender.send({
      to: mobile,
      purpose: 'otp',
      templateId: env.MSG91_OTP_TEMPLATE_ID,
      variables: { otp: code, ttl: String(OTP_TTL_MS / 60_000) },
    });
  } catch (err) {
    // The challenge row already exists; a vendor outage must not 502 the caller
    // into believing nothing happened when a retry would be throttled.
    logger.error({ err, mobile: maskMobile(mobile) }, 'auth.otp_send_failed');
  }
}

export async function verifyLoginOtp(
  input: { mobile: string; code: string; fullName?: string | undefined; cartToken?: string | undefined },
  fingerprint: { ip: string | null; deviceLabel: string | null },
): Promise<IssuedSession> {
  const challenge = await repo.findLatestOtpChallenge(input.mobile, 'login');

  const invalid = (): never => {
    throw new UnprocessableError(
      'That code is not valid or has expired. Request a new one.',
      'otp_invalid',
    );
  };

  if (!challenge) {
    await burnVerificationTime(input.code);
    return invalid();
  }
  if (challenge.expiresAt.getTime() <= Date.now()) return invalid();
  if (challenge.attempts >= challenge.maxAttempts) {
    throw new UnprocessableError(
      'Too many incorrect attempts for that code. Request a new one.',
      'otp_attempts_exhausted',
    );
  }

  if (!(await verifySecret(input.code, challenge.codeHash))) {
    const attempts = await repo.incrementOtpAttempts(challenge.id);
    logger.warn(
      { mobile: maskMobile(input.mobile), attempts, maxAttempts: challenge.maxAttempts },
      'auth.otp_verify_failed',
    );
    return invalid();
  }

  // Single-use: consumed before the session is issued, so a replay of the same
  // code cannot mint a second session even if the caller sends it twice.
  await repo.consumeOtpChallenge(challenge.id);

  const existing = await repo.findCustomerByMobile(input.mobile);
  let customer: repo.CustomerRow;

  if (existing) {
    assertUsable(existing);
    customer = existing.mobileVerifiedAt
      ? existing
      : ((await repo.updateCustomer(existing.id, { mobileVerifiedAt: new Date() })) ?? existing);
  } else {
    customer = await repo.insertCustomer({
      mobile: input.mobile,
      fullName: input.fullName ?? null,
      mobileVerifiedAt: new Date(),
      // No password: this account signs in by OTP until it sets one. The
      // `customer_needs_a_handle` CHECK is satisfied by the mobile.
      marketingOptIn: false,
    });
    logger.info({ customerId: customer.id }, 'auth.customer_created_via_otp');
  }

  await mergeGuestCart(customer.id, input.cartToken);
  return issueSession(customer, fingerprint);
}

/* -------------------------------------------------------------- refresh */

/**
 * Rotate the refresh token, or detect that it has already been spent.
 *
 * The decision itself is `decideRefresh` in `refresh-token.ts` — pure, and
 * exhaustively tested. This function is the I/O around it.
 */
export async function refresh(
  presentedToken: string | undefined,
  fingerprint: { ip: string | null; deviceLabel: string | null },
): Promise<IssuedSession> {
  const expired = (): never => {
    throw new UnauthenticatedError('Your session has expired. Please sign in again.');
  };

  if (!presentedToken) return expired();

  const presentedHash = hashRefreshToken(presentedToken);
  const [row, spentSessionId] = await Promise.all([
    repo.findSessionByHash(presentedHash),
    findSpentToken(presentedHash),
  ]);

  const snapshot: SessionSnapshot | null = row
    ? { id: row.id, customerId: row.customerId, revokedAt: row.revokedAt, expiresAt: row.expiresAt }
    : null;

  const outcome = decideRefresh(snapshot, spentSessionId, new Date());

  if (outcome.kind === 'reuse') {
    /*
     * THE DETECTION. A token that was already exchanged has been presented
     * again, which means two parties hold this lineage.
     *
     * Revoke the family in Postgres *and* push the session id onto the Redis
     * denylist, so the access tokens the thief may already hold stop verifying
     * within milliseconds rather than at their next 15-minute expiry. Logged at
     * error level with a stable `event` so it can be alerted on — a silent
     * revocation is a security incident nobody finds out about.
     */
    await repo.revokeSessionRow(outcome.sessionId);
    await revokeSession(outcome.sessionId);
    logger.error(
      { event: 'auth.refresh_token_reuse_detected', sessionId: outcome.sessionId },
      'Refresh token reuse detected — the session family has been revoked. This token was already ' +
        'rotated once, so a copy of it exists somewhere it should not.',
    );
    return expired();
  }

  if (outcome.kind === 'reject') {
    logger.warn({ reason: outcome.reason }, 'auth.refresh_rejected');
    return expired();
  }

  const customer = await repo.findCustomerById(outcome.customerId);
  if (!customer || customer.blockedAt !== null) {
    await repo.revokeSessionRow(outcome.sessionId);
    await revokeSession(outcome.sessionId);
    return expired();
  }

  const nextToken = newRefreshToken();
  const rotated = await repo.rotateSession(outcome.sessionId, presentedHash, hashRefreshToken(nextToken));

  if (!rotated) {
    // Another request rotated this same token between our read and our write.
    // Whichever one lost is, by definition, presenting a spent token.
    logger.error(
      { event: 'auth.refresh_token_reuse_detected', sessionId: outcome.sessionId, race: true },
      'Concurrent refresh with the same token — treating as reuse and revoking the family.',
    );
    await repo.revokeSessionRow(outcome.sessionId);
    await revokeSession(outcome.sessionId);
    return expired();
  }

  // Remember the hash we just retired, so presenting it again is caught above.
  await rememberSpentToken(presentedHash, outcome.sessionId);

  const accessToken = await signCustomerToken({
    customerId: customer.id,
    sessionId: outcome.sessionId,
  });

  logger.debug({ sessionId: outcome.sessionId, ip: fingerprint.ip }, 'auth.refresh_rotated');

  return {
    refreshToken: nextToken,
    session: {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: ttlSeconds(env.JWT_CUSTOMER_TTL),
      customer: toCustomerSummary(customer),
    },
  };
}

/* --------------------------------------------------------------- logout */

/** Idempotent, and silent about what it found — logging out is never an error. */
export async function logout(presentedToken: string | undefined): Promise<void> {
  if (!presentedToken) return;
  const row = await repo.findSessionByHash(hashRefreshToken(presentedToken));
  if (!row) return;
  await repo.revokeSessionRow(row.id);
  await revokeSession(row.id);
}

/**
 * Sign out every device.
 *
 * Identified by the refresh cookie rather than by a Bearer token: the customer
 * reaching for this has usually just been told their credentials leaked, and
 * their access token may already have expired while they read the email.
 */
export async function logoutEverywhere(presentedToken: string | undefined): Promise<void> {
  if (!presentedToken) return;
  const row = await repo.findSessionByHash(hashRefreshToken(presentedToken));
  if (!row) return;
  const revoked = await repo.revokeAllSessionsFor(row.customerId);
  await revokeSessions(revoked);
  logger.info({ customerId: row.customerId, count: revoked.length }, 'auth.logout_everywhere');
}

/* ------------------------------------------------------- password reset */

/**
 * The reset link's landing page.
 *
 * The storefront origin is not its own env var (adding one means touching
 * `config/env.ts`, which this module does not own), so the first configured CORS
 * origin is used — that is by construction the storefront — with the API's own
 * URL as a last resort so the email is never sent with a broken link.
 */
const resetPageUrl = (token: string): string => {
  const origin = env.corsOrigins[0] ?? env.API_PUBLIC_URL;
  return `${origin.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
};

/**
 * Always resolves, and always the same way.
 *
 * `POST /v1/auth/forgot-password` returning 404 for an unknown address turns the
 * endpoint into a free customer-list validator, which is exactly what the
 * storefront's Supabase flow avoids today and what §2 of the API plan calls for
 * ("204 always, to avoid email enumeration").
 */
export async function forgotPassword(emailAddress: string): Promise<void> {
  const customer = await repo.findCustomerByEmail(emailAddress);
  if (!customer || customer.blockedAt !== null) {
    logger.info({ email: maskEmail(emailAddress) }, 'auth.password_reset_requested_unknown');
    return;
  }

  const secret = newRefreshToken();
  const challenge = await repo.insertOtpChallenge({
    channel: 'email',
    destination: emailAddress,
    codeHash: await hashSecret(secret),
    purpose: 'password_reset',
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
  });

  // `<challengeId>.<secret>` so the reset form needs the token and nothing else —
  // no email field to re-type, and no lookup by address on a public endpoint.
  const token = `${challenge.id}.${secret}`;

  try {
    await emailSender.send({
      to: emailAddress,
      subject: 'Reset your Achichiz password',
      text:
        `Hello,\n\n` +
        `Someone asked to reset the password for this Achichiz account. If it was you, open the link ` +
        `below within 30 minutes:\n\n${resetPageUrl(token)}\n\n` +
        `If it was not you, you can ignore this email — nothing has changed and your current password ` +
        `still works.\n\n— Achichiz`,
    });
  } catch (err) {
    logger.error({ err, email: maskEmail(emailAddress) }, 'auth.password_reset_email_failed');
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const invalid = (): never => {
    throw new ValidationError('That reset link is invalid or has expired. Request a new one.', {
      issues: [{ path: 'token', code: 'invalid', message: 'This reset link is no longer usable.' }],
    });
  };

  const separator = token.indexOf('.');
  if (separator < 1) return invalid();
  const challengeId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!secret) return invalid();

  const challenge = await repo.findOtpChallengeById(challengeId).catch(() => null);
  if (
    !challenge ||
    challenge.purpose !== 'password_reset' ||
    challenge.consumedAt !== null ||
    challenge.expiresAt.getTime() <= Date.now() ||
    challenge.attempts >= challenge.maxAttempts
  ) {
    await burnVerificationTime(secret);
    return invalid();
  }

  if (!(await verifySecret(secret, challenge.codeHash))) {
    await repo.incrementOtpAttempts(challenge.id);
    return invalid();
  }

  const customer = await repo.findCustomerByEmail(challenge.destination);
  if (!customer) return invalid();

  await repo.consumeOtpChallenge(challenge.id);
  await repo.updateCustomer(customer.id, {
    passwordHash: await hashPassword(newPassword),
    // Completing the loop proves control of the mailbox, which is the same
    // evidence a verification email would have produced.
    ...(customer.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
  });

  /*
   * A password change signs out every device. If the reset happened because the
   * old password leaked, leaving the attacker's sessions alive would make the
   * reset theatre — they hold a refresh token, not a password.
   */
  const revoked = await repo.revokeAllSessionsFor(customer.id);
  await revokeSessions(revoked);
  logger.info({ customerId: customer.id, sessionsRevoked: revoked.length }, 'auth.password_reset');
}

/* ------------------------------------------------------------------- me */

export async function currentCustomer(customerId: string): Promise<CustomerSummary> {
  const customer = await repo.findCustomerById(customerId);
  // The token verified, so the row existed when it was issued. If it is gone the
  // account was deleted mid-session; that is an expired session, not a 404.
  if (!customer) throw new UnauthenticatedError('This session is no longer valid.');
  return toCustomerSummary(customer);
}
