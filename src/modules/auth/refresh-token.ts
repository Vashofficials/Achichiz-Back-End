/**
 * Opaque rotating refresh tokens, and the reuse detector.
 *
 * ## Why opaque, and why hashed
 *
 * A refresh token is a bearer credential with a 30-day life. It is 256 bits of
 * CSPRNG, not a JWT — there is nothing to read out of it, nothing to forge, and
 * no signature to get wrong. Only `sha256(token)` is ever written to
 * `customer_sessions.refresh_token_hash`; a database dump yields hashes that
 * cannot be replayed. sha256 (not argon2) is correct *here* precisely because the
 * input is 256 random bits — there is no dictionary to grind, and refresh runs on
 * the request path every 15 minutes.
 *
 * ## Rotation, and what "the family" means in this schema
 *
 * Every `/refresh` mints a new token and writes its hash **over** the old one on
 * the same `customer_sessions` row. The row therefore *is* the family: its `id`
 * is the stable `sid` inside every access token the session ever issues, so
 * revoking the row revokes the whole lineage in one write — including the
 * outstanding access tokens, via the Redis denylist in `session-store.ts`.
 *
 * The shipped schema has no `rotated_at` column and no family/parent column
 * (`customers.ts` — and `src/db/**` is not ours to change), so the memory of
 * *superseded* hashes lives in Redis under `rt:rotated:<hash> → sessionId`, with
 * a TTL equal to the refresh lifetime. That is enough to answer the only question
 * reuse detection asks: *has this exact token already been spent?*
 *
 * ## The detector
 *
 * - hash matches a live session row → rotate, hand back a new token.
 * - hash matches nothing, but Redis remembers it as spent → **replay.** Somebody
 *   is holding a token that was already exchanged, which means two parties hold
 *   the lineage and one of them is not the customer. Revoke the family, deny the
 *   access tokens, log loudly, force a fresh login.
 * - anything else → a flat 401 that says nothing.
 *
 * Rotation without this check buys almost nothing: a stolen token stays useful
 * for its full 30 days as long as the thief refreshes it. The known cost is a
 * false positive when a client loses the rotation *response* in flight and
 * retries with a token the server already spent. That signs the customer out
 * once. It is the accepted trade (§3.1: "non-negotiable"), and a grace window
 * would reopen exactly the hole being closed.
 *
 * If Redis has lost the key, an actual replay degrades to a plain 401 rather than
 * to a silent success — the failure mode is closed, not open.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { refreshTokenTtlMs } from './session-store.js';

/** Cookie name from 04_architecture.md §3.1. Staff use `ach_art`; the names must not collide. */
export const REFRESH_COOKIE = 'ach_rt';

/**
 * Scoped to the auth routes, so the cookie is not attached to every catalogue
 * and cart request. A credential that travels on requests which cannot use it is
 * a credential with a needlessly large exposure surface.
 */
export const REFRESH_COOKIE_PATH = '/v1/auth';

/** 256 bits, URL-safe. The only handle to a session. */
export const newRefreshToken = (): string => randomBytes(32).toString('base64url');

export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/* ------------------------------------------------------------- cookie i/o */

/**
 * Parses a `Cookie` header without adding `cookie-parser` as a dependency.
 *
 * Exported because it is worth testing directly: a cookie value may legally
 * contain `=`, and splitting on every `=` instead of the first one silently
 * truncates base64url tokens that happen to carry padding.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
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
      // A malformed percent-escape is not a reason to 500 the request.
      out[name] = value;
    }
  }
  return out;
}

export const readRefreshCookie = (req: Request): string | undefined =>
  parseCookies(req.headers.cookie)[REFRESH_COOKIE];

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    // Plain HTTP in local development would otherwise drop the cookie entirely.
    secure: env.isProduction,
    // `Lax` is enough because both frontends sit under `.achichiz.com` (§3.1).
    // If the admin ever moves to a `netlify.app` host this must become
    // `None; Secure`, which is strictly weaker — put it on a subdomain instead.
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: refreshTokenTtlMs,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
  });
}

/* -------------------------------------------------------- the pure decision */

/** Just enough of a `customer_sessions` row to decide what a presented token means. */
export type SessionSnapshot = {
  id: string;
  customerId: string;
  revokedAt: Date | null;
  expiresAt: Date;
};

export type RefreshOutcome =
  | { kind: 'rotate'; sessionId: string; customerId: string }
  /** A token that was already exchanged. Treat as theft. */
  | { kind: 'reuse'; sessionId: string }
  | { kind: 'reject'; reason: 'unknown' | 'revoked' | 'expired' };

/**
 * The whole decision, as a pure function — no database, no Redis, no clock of
 * its own. Every branch is covered in `auth.test.ts`; this is the piece that must
 * not be wrong.
 *
 * @param session       the row whose `refresh_token_hash` equals the presented
 *                      token's hash, or null when nothing matches.
 * @param spentSessionId the session id Redis remembers for this hash, or null.
 */
export function decideRefresh(
  session: SessionSnapshot | null,
  spentSessionId: string | null,
  now: Date,
): RefreshOutcome {
  if (session) {
    // A live row wins over the replay memory: this is the current token.
    if (session.revokedAt !== null) return { kind: 'reject', reason: 'revoked' };
    if (session.expiresAt.getTime() <= now.getTime()) return { kind: 'reject', reason: 'expired' };
    return { kind: 'rotate', sessionId: session.id, customerId: session.customerId };
  }

  // No live row, but this exact token was spent in a previous rotation. Somebody
  // kept a copy. That is the signal.
  if (spentSessionId) return { kind: 'reuse', sessionId: spentSessionId };

  return { kind: 'reject', reason: 'unknown' };
}

/** `15m` / `900s` / `2h` / `7d` → seconds. Mirrors the subset of `jose` durations env uses. */
export function ttlSeconds(ttl: string, fallback = 900): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(ttl.trim());
  if (!match?.[1]) return fallback;
  const value = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const multiplier = unit === 'd' ? 86_400 : unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1;
  return value * multiplier;
}
