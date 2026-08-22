import { cache } from '../../config/redis.js';
import { env } from '../../config/env.js';

/**
 * Session revocation denylist.
 *
 * Access tokens are stateless and short-lived, but "sign out everywhere" and a
 * compromised-session response must be immediate. A revoked session id sits here
 * until slightly past the longest possible access-token lifetime, after which the
 * token cannot verify anyway and the key is dead weight.
 */
const key = (sessionId: string): string => `revoked:${sessionId}`;

/** Comfortably longer than any access token TTL. */
const REVOCATION_TTL_SECONDS = 60 * 60;

export async function revokeSession(sessionId: string): Promise<void> {
  await cache.set(key(sessionId), '1', 'EX', REVOCATION_TTL_SECONDS);
}

export async function revokeSessions(sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const pipeline = cache.pipeline();
  for (const id of sessionIds) pipeline.set(key(id), '1', 'EX', REVOCATION_TTL_SECONDS);
  await pipeline.exec();
}

export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  return (await cache.exists(key(sessionId))) === 1;
}

export const refreshTokenTtlMs = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
