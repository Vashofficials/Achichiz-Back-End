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

import type { Request } from 'express';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  ConflictError,
  UnauthenticatedError,
  UnprocessableError,
  ValidationError,
} from '../../lib/errors.js';
import { maskEmail } from '../../integrations/email/index.js';
import * as cartService from '../cart/cart.service.js';
import * as leadsService from '../leads/leads.service.js';
import * as repo from './auth.repository.js';
import { signCustomerToken } from './customer-token.js';
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

/**
 * Issue a session for a customer some OTHER flow has already authenticated.
 *
 * The Firebase path resolves the customer itself — Google verified the OTP, and
 * `firebase-auth.service.ts` decided which row that identity maps to. What it
 * must not do is mint its own session: rotation, the denylist and the cart merge
 * all live here, and a second implementation of them is a second set of bugs.
 *
 * Deliberately takes an already-loaded row rather than an id: the caller has just
 * written to it, and re-reading would open a window where a row that was linked
 * one moment is signed into in a different state the next.
 */
export async function issueSessionForCustomer(
  customer: repo.CustomerRow,
  cartToken: string | undefined,
  fingerprint: { ip: string | null; deviceLabel: string | null },
): Promise<IssuedSession> {
  await mergeGuestCart(customer.id, cartToken);
  return issueSession(customer, fingerprint);
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
  if (await repo.findCustomerByEmail(input.email)) {
    throw new ConflictError('An account already exists for that email address. Try signing in instead.');
  }
  if (input.mobile && (await repo.findCustomerByMobile(input.mobile))) {
    throw new ConflictError('An account already exists for that mobile number. Try signing in instead.');
  }

  // Create Firebase User
  try {
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirebaseApp } = await import('../../config/firebase.js');
    await getAuth(getFirebaseApp()).createUser({
      email: input.email,
      password: input.password,
      displayName: input.fullName,
      ...(input.mobile ? { phoneNumber: '+91' + input.mobile } : {}),
    });
  } catch (err) {
    logger.error({ err, email: input.email }, 'auth.firebase_create_user_failed');
    /*
     * Firebase Admin throws `FirebaseAuthError`, whose `code` and `message` are
     * the only parts contracted. Narrowing beats `any`: an unexpected shape then
     * falls through to the generic message instead of reading undefined.
     */
    const fb = err as { code?: string; message?: string };
    if (fb.code === 'auth/email-already-exists') {
      throw new ConflictError('An account already exists in Firebase for that email address.');
    }
    if (fb.code === 'auth/phone-number-already-exists') {
      throw new ConflictError('An account already exists in Firebase for that mobile number.');
    }
    throw new UnprocessableError('Could not create Firebase account: ' + (fb.message ?? 'unknown error'));
  }

  const customer = await repo.insertCustomer({
    fullName: input.fullName,
    email: input.email,
    mobile: input.mobile ?? null,
    passwordHash: null,
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
  input: { emailOrMobile: string; password: string; cartToken?: string | undefined },
  fingerprint: { ip: string | null; deviceLabel: string | null },
): Promise<IssuedSession> {
  let email = input.emailOrMobile;

  // Resolve mobile to email if a 10-digit number is provided.
  if (/^\d{10}$/.test(input.emailOrMobile)) {
    try {
      const { getAuth } = await import('firebase-admin/auth');
      const { getFirebaseApp } = await import('../../config/firebase.js');
      const userRecord = await getAuth(getFirebaseApp()).getUserByPhoneNumber('+91' + input.emailOrMobile);
      if (userRecord.email) {
        email = userRecord.email;
      } else {
        throw new UnauthenticatedError(INVALID_CREDENTIALS);
      }
    } catch (err) {
      // The response must not distinguish causes, but an operator still needs
      // to see WHY — a Firebase outage and a wrong password look identical.
      logger.warn({ err }, 'auth.firebase_signin_failed');
      throw new UnauthenticatedError(INVALID_CREDENTIALS);
    }
  }

  // Verify via Identity Toolkit
  try {
    const firebaseRest = await import('./firebase-rest.js');
    const { email: verifiedEmail } = await firebaseRest.signInWithPassword(email, input.password);
    email = verifiedEmail;
  } catch (err) {
    logger.warn({ err }, 'auth.firebase_password_signin_failed');
    throw new UnauthenticatedError(INVALID_CREDENTIALS);
  }

  const customer = await repo.findCustomerByEmail(email);
  if (!customer) {
    throw new UnauthenticatedError(INVALID_CREDENTIALS);
  }

  assertUsable(customer);

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

  try {
    const firebaseRest = await import('./firebase-rest.js');
    await firebaseRest.sendPasswordResetEmail(emailAddress);
  } catch (err) {
    logger.error({ err, email: maskEmail(emailAddress) }, 'auth.firebase_password_reset_failed');
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  let email: string;
  try {
    const firebaseRest = await import('./firebase-rest.js');
    const result = await firebaseRest.confirmPasswordReset(token, newPassword);
    email = result.email;
  } catch (err) {
    logger.debug({ err }, 'auth.password_reset_code_rejected');
    throw new ValidationError('That reset link is invalid or has expired. Request a new one.', {
      issues: [{ path: 'token', code: 'invalid', message: 'This reset link is no longer usable.' }],
    });
  }

  const customer = await repo.findCustomerByEmail(email);
  if (!customer) return;

  await repo.updateCustomer(customer.id, {
    ...(customer.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
  });

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
