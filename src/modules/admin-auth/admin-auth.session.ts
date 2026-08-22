/**
 * Staff session plumbing: the refresh cookie, the opaque refresh token, the
 * short-lived MFA challenge token, and the step-up re-auth window.
 *
 * Three distinct credentials live here and they are deliberately incompatible:
 *
 *  - **access token** — `staff-token.ts`, audience `admin`, ten minutes.
 *  - **challenge token** — audience `admin-mfa`, five minutes, issued after a
 *    correct password but BEFORE the second factor. It carries no permissions
 *    and `verifyStaffToken` rejects it on audience, so a half-authenticated
 *    holder cannot reach a single admin route with it.
 *  - **refresh token** — 256 opaque bits in an httpOnly cookie, only the sha256
 *    is written to `staff_sessions.refresh_token_hash`.
 *
 * Step-up lives in Redis rather than in a claim: it must be revocable and it
 * must expire on wall-clock time, not on whenever the holder next refreshes.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import { cache } from '../../config/redis.js';
import { UnauthenticatedError } from '../../lib/errors.js';

const secret = new TextEncoder().encode(env.JWT_STAFF_SECRET);

/* ------------------------------------------------------------ refresh token */

/** `ach_art` — admin refresh token. Must not collide with the storefront's `ach_rt`. */
export const STAFF_REFRESH_COOKIE = 'ach_art';

/** Scoped so the cookie is not attached to the other ~90 admin requests. */
export const STAFF_REFRESH_COOKIE_PATH = '/v1/admin/auth';

export const staffRefreshTtlMs = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export const newStaffRefreshToken = (): string => randomBytes(32).toString('base64url');

export const hashStaffRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Minimal `Cookie` header parse. Splitting on the FIRST `=` matters: a base64url
 * token can legally end in `=` padding and splitting on every one truncates it.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export const readStaffRefreshCookie = (req: Request): string | undefined =>
  parseCookieHeader(req.headers.cookie)[STAFF_REFRESH_COOKIE];

export function setStaffRefreshCookie(res: Response, token: string): void {
  res.cookie(STAFF_REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    // The admin console is a first-party subdomain. If it ever moves to a
    // third-party host this must become `None; Secure` — put it on a subdomain
    // instead, which is strictly stronger.
    sameSite: 'lax',
    path: STAFF_REFRESH_COOKIE_PATH,
    maxAge: staffRefreshTtlMs,
  });
}

export function clearStaffRefreshCookie(res: Response): void {
  res.clearCookie(STAFF_REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: STAFF_REFRESH_COOKIE_PATH,
  });
}

/* --------------------------------------------------------- challenge token */

const CHALLENGE_AUDIENCE = 'admin-mfa';

/**
 * `verify` — the account already has TOTP and must present a code.
 * `enrol`  — the account is write-capable and has NO TOTP yet; it must enrol
 *            before it can obtain a session at all.
 */
export type ChallengePurpose = 'verify' | 'enrol';

export type ChallengeClaims = { staffId: string; purpose: ChallengePurpose };

export async function signChallengeToken(claims: ChallengeClaims): Promise<string> {
  return new SignJWT({ purpose: claims.purpose })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.staffId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(CHALLENGE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

export async function verifyChallengeToken(token: string): Promise<ChallengeClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: env.JWT_ISSUER,
      audience: CHALLENGE_AUDIENCE,
      algorithms: ['HS256'],
    });
    const sub = payload.sub;
    const purpose = payload.purpose;
    if (typeof sub !== 'string' || (purpose !== 'verify' && purpose !== 'enrol')) {
      throw new Error('malformed challenge token');
    }
    return { staffId: sub, purpose };
  } catch {
    // Expiry, signature and audience all mean the same thing to the client, and
    // distinguishing them is an oracle.
    throw new UnauthenticatedError('That sign-in attempt has expired. Start again.');
  }
}

/* ------------------------------------------------------------------ step-up */

/**
 * Money movement asks for the password again.
 *
 * `settings.security.tsx` proposes "require re-auth for refunds" as a policy
 * toggle; it is unconditional here. Ten minutes of access-token life is a long
 * time for an unattended laptop, and a refund is irreversible.
 */
export const STEP_UP_TTL_SECONDS = 5 * 60;

const stepUpKey = (sessionId: string): string => `stepup:${sessionId}`;

export async function markStepUp(sessionId: string): Promise<void> {
  await cache.set(stepUpKey(sessionId), '1', 'EX', STEP_UP_TTL_SECONDS);
}

export async function hasRecentStepUp(sessionId: string): Promise<boolean> {
  return (await cache.exists(stepUpKey(sessionId))) === 1;
}

export async function clearStepUp(sessionId: string): Promise<void> {
  await cache.del(stepUpKey(sessionId));
}
