import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request, RequestHandler } from 'express';
import { cache } from '../config/redis.js';
import { env } from '../config/env.js';
import { RateLimitError } from '../lib/errors.js';

/**
 * Named limiters, not ad-hoc numbers scattered across routes.
 *
 * Redis-backed so the limit is global rather than per-container — an
 * in-memory limiter multiplies the real ceiling by your instance count, which
 * is exactly wrong for OTP and payment endpoints.
 */
export type LimiterName =
  | 'default'
  | 'auth'
  | 'otp'
  | 'checkout'
  | 'payment'
  | 'lead'
  | 'search'
  | 'export'
  | 'webhook';

type Rule = { windowMs: number; limit: number; byUser?: boolean };

const RULES: Record<LimiterName, Rule> = {
  default: { windowMs: 60_000, limit: 120 },
  // Credential endpoints. Deliberately tight.
  auth: { windowMs: 15 * 60_000, limit: 10 },
  // OTP costs real money per send and is the classic abuse target.
  otp: { windowMs: 15 * 60_000, limit: 5 },
  checkout: { windowMs: 60_000, limit: 20, byUser: true },
  payment: { windowMs: 60_000, limit: 30, byUser: true },
  // Public forms. Bot bait without a captcha in front.
  lead: { windowMs: 60 * 60_000, limit: 10 },
  search: { windowMs: 60_000, limit: 60 },
  // Exports are expensive; a staff member does not need many per hour.
  export: { windowMs: 60 * 60_000, limit: 20, byUser: true },
  // Razorpay retries aggressively on non-2xx. Do not throttle it into a loop.
  webhook: { windowMs: 60_000, limit: 600 },
};

const clientKey = (req: Request, byUser: boolean): string => {
  if (byUser && req.auth) {
    return req.auth.kind === 'customer' ? `c:${req.auth.customerId}` : `s:${req.auth.staffId}`;
  }
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return `ip:${(first ?? req.socket.remoteAddress ?? 'unknown').trim()}`;
};

const limiters = new Map<LimiterName, RateLimitRequestHandler>();

/**
 * Returns a middleware that builds its limiter on FIRST REQUEST, not at call time.
 *
 * `defineRoute` invokes this during module load. `rate-limit-redis` constructs its
 * store eagerly and dials Redis, so building here would mean that merely importing
 * the route graph opens a socket — and `npm run openapi:generate` (CI gate 1) would
 * crash with MaxRetriesPerRequestError on any machine without Redis. Generating a
 * document is metadata work; it must not need infrastructure.
 *
 * Deferring to first request keeps the declaration side-effect-free while the
 * runtime behaviour is identical.
 */
export function namedLimiter(name: LimiterName): RequestHandler {
  return (req, res, next) => {
    let limiter = limiters.get(name);
    if (!limiter) {
      limiter = buildLimiter(name);
      limiters.set(name, limiter);
    }
    limiter(req, res, next);
  };
}

function buildLimiter(name: LimiterName): RateLimitRequestHandler {
  const rule = RULES[name];
  return rateLimit({
    windowMs: rule.windowMs,
    limit: env.isTest ? 100_000 : rule.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    /**
     * FAIL OPEN when Redis is unreachable.
     *
     * Without this the limiter rejects, the rejection escapes as an unhandled
     * promise, and the process dies — a Redis blip takes down the entire API and
     * an unauthenticated request gets a 500 where it should get a 401.
     *
     * A rate limiter that can take down the service it protects is worse than no
     * rate limiter. Degrading to unlimited for the duration of a store outage is
     * the lesser risk; the outage itself is what pages someone.
     */
    passOnStoreError: true,
    keyGenerator: (req) => `${name}:${clientKey(req, rule.byUser ?? false)}`,
    store: new RedisStore({
      // node-redis / ioredis signature bridge
      sendCommand: (...args: string[]) => cache.call(...(args as [string, ...string[]])) as Promise<never>,
      prefix: 'rl:',
    }),
    handler: (_req, _res, next) => {
      next(new RateLimitError('Too many requests. Please wait and try again.'));
    },
  });
}
