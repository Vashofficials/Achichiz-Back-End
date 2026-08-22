/**
 * The memory of spent refresh tokens — the half of reuse detection that needs
 * storage.
 *
 * `customer_sessions` holds exactly one hash per session (the current one),
 * because rotation writes over it in place, and the shipped schema has no
 * `rotated_at` column to record the previous value in (`db/schema/customers.ts`,
 * and `src/db/**` is not ours to change). So the superseded hash is remembered
 * here instead, keyed by hash and pointing at the session it belonged to.
 *
 * Redis is the right store for it: the entry is worthless once the token could no
 * longer have been valid anyway, so it wants a TTL rather than a cleanup job, and
 * it is read once per refresh on the request path.
 *
 * Losing a key means an actual replay degrades to a plain 401 instead of a family
 * revocation. Losing the *session row* is what would be dangerous, and that is in
 * Postgres.
 */

import { cache } from '../../config/redis.js';
import { refreshTokenTtlMs } from './session-store.js';

const key = (tokenHash: string): string => `rt:spent:${tokenHash}`;

const TTL_SECONDS = Math.ceil(refreshTokenTtlMs / 1000);

/** Called on every rotation, with the hash of the token just handed in. */
export async function rememberSpentToken(tokenHash: string, sessionId: string): Promise<void> {
  await cache.set(key(tokenHash), sessionId, 'EX', TTL_SECONDS);
}

/** The session a spent token belonged to, or null if this hash was never seen. */
export async function findSpentToken(tokenHash: string): Promise<string | null> {
  return cache.get(key(tokenHash));
}
