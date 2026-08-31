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

/**
 * `exemptible` marks a limiter an allowlisted IP may skip.
 *
 * The split is between limiters that exist to stop ABUSE and limiters that
 * exist to cap COST. `auth` throttles credential guessing, so a trusted network
 * can reasonably be exempt. `otp` spends real money on every SMS and `payment`
 * touches live Razorpay keys — the spend is identical whoever makes the call,
 * and a testing loop is exactly how that bill runs away. `webhook` is Razorpay
 * calling us, so an operator IP is meaningless there.
 *
 * It is a flag per rule rather than a list kept somewhere else, so adding a
 * limiter forces an explicit decision about which kind it is.
 */
type Rule = { windowMs: number; limit: number; byUser?: boolean; exemptible?: boolean };

const RULES: Record<LimiterName, Rule> = {
  default: { windowMs: 60_000, limit: 120, exemptible: true },
  // Credential endpoints. Deliberately tight.
  auth: { windowMs: 15 * 60_000, limit: 10, exemptible: true },
  // OTP costs real money per send and is the classic abuse target. NOT exempt.
  otp: { windowMs: 15 * 60_000, limit: 5 },
  checkout: { windowMs: 60_000, limit: 20, byUser: true, exemptible: true },
  // Live Razorpay keys. NOT exempt.
  payment: { windowMs: 60_000, limit: 30, byUser: true },
  // Public forms. Bot bait without a captcha in front.
  lead: { windowMs: 60 * 60_000, limit: 10, exemptible: true },
  search: { windowMs: 60_000, limit: 60, exemptible: true },
  // Exports are expensive; a staff member does not need many per hour.
  export: { windowMs: 60 * 60_000, limit: 20, byUser: true, exemptible: true },
  // Razorpay retries aggressively on non-2xx. Do not throttle it into a loop.
  webhook: { windowMs: 60_000, limit: 600 },
};

/**
 * The caller's address, as nginx reports it.
 *
 * `x-forwarded-for` is a client-settable header, which is why the exemption
 * below is a narrow convenience and not a security boundary — see `isExempt`.
 * The `::ffff:` prefix is stripped so an IPv4-mapped socket address compares
 * equal to the plain IPv4 an operator would put in the allowlist.
 */
const requestIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return (first ?? req.socket.remoteAddress ?? 'unknown').trim().replace(/^::ffff:/, '');
};

const clientKey = (req: Request, byUser: boolean): string => {
  if (byUser && req.auth) {
    return req.auth.kind === 'customer' ? `c:${req.auth.customerId}` : `s:${req.auth.staffId}`;
  }
  return `ip:${requestIp(req)}`;
};

/**
 * Should this request skip its limiter entirely?
 *
 * Only for `exemptible` limiters, and only from an allowlisted address. Empty
 * allowlist (the default, and what production should run with) means this is
 * always false and the limiters behave exactly as before.
 *
 * NOT a security boundary: `x-forwarded-for` can be spoofed by anyone who
 * reaches the app directly, so this is worth only as much as the proxy in front
 * of it. It removes a throttle for a known operator; it grants no access and
 * bypasses no authentication. The account lockout after five failed passwords is
 * untouched and still applies to an exempt IP.
 */
export function isExempt(req: Request, name: LimiterName): boolean {
  if (env.rateLimitSkipIps.length === 0) return false;
  if (!RULES[name].exemptible) return false;
  return env.rateLimitSkipIps.includes(requestIp(req));
}

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
    skip: (req) => isExempt(req, name),
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
