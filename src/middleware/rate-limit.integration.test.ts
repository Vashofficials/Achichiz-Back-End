import { describe, expect, it, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * A minimal counting store, standing in for `rate-limit-redis`.
 *
 * Aliasing express-rate-limit's own `MemoryStore` looked simpler but its `init`
 * expects the validator object the library injects and threw
 * `this.validations?.windowMs is not a function`; the suite still went green
 * because the limiter is configured to FAIL OPEN on store errors, which is
 * exactly the kind of test that proves nothing. This implements the store
 * contract directly so a 429 here means counting really happened.
 */
class CountingStore {
  private readonly hits = new Map<string, number>();
  windowMs = 0;

  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
  }

  increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
    const totalHits = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, totalHits);
    return Promise.resolve({ totalHits, resetTime: new Date(Date.now() + this.windowMs) });
  }

  decrement(key: string): Promise<void> {
    this.hits.set(key, Math.max(0, (this.hits.get(key) ?? 0) - 1));
    return Promise.resolve();
  }

  resetKey(key: string): Promise<void> {
    this.hits.delete(key);
    return Promise.resolve();
  }
}

/**
 * The exemption wired through the REAL limiter, not just the decision function.
 *
 * `isExempt` being correct proves nothing on its own — the bug that matters is
 * `skip` not being passed to `rateLimit()` at all, which no unit test on the
 * predicate would catch. So this mounts `namedLimiter('auth')` itself and
 * exercises it over HTTP.
 *
 * Only the STORE is swapped: `rate-limit-redis` needs a live server and Lua
 * scripting, and this is a test of our skip logic, not of Redis. Everything else
 * — the rule table, the key generator, the handler — is the shipping code.
 */

// The limiter is built lazily on first request (see the note in rate-limit.ts),
// which trips express-rate-limit's creation-stack validator. That check is off
// under NODE_ENV=production, where this code actually runs; set it before the
// library is imported so a real failure is not lost in the warning noise.
process.env.NODE_ENV = 'production';

const OFFICE = '183.82.162.9';
const AUTH_LIMIT = 10;

async function appWith(skipIps: string): Promise<express.Express> {
  vi.resetModules();
  vi.doMock('../config/env.js', () => ({
    env: {
      rateLimitSkipIps: skipIps.split(',').map((s) => s.trim()).filter(Boolean),
      // NOT isTest: that path raises the limit to 100_000 and would mask
      // everything this file is trying to assert.
      isTest: false,
    },
  }));
  vi.doMock('../config/redis.js', () => ({ cache: { call: vi.fn() } }));
  vi.doMock('rate-limit-redis', () => ({ RedisStore: CountingStore }));

  const { namedLimiter } = await import('./rate-limit.js');
  const app = express();
  app.set('trust proxy', true);
  // A throwaway harness app for exercising the limiter in isolation. It mounts
  // no real route and never reaches the OpenAPI document, which is what the
  // defineRoute rule below protects.
  // eslint-disable-next-line no-restricted-syntax
  app.get('/login', namedLimiter('auth'), (_req, res) => {
    res.status(200).json({ ok: true });
  });
  // Mirror the app's envelope shape closely enough to assert the status.
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ type: 'error' });
  });
  return app;
}

const hit = (app: express.Express, ip: string) =>
  request(app).get('/login').set('x-forwarded-for', ip);

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../config/env.js');
  vi.doUnmock('../config/redis.js');
  vi.doUnmock('rate-limit-redis');
});

describe('auth limiter, no allowlist', () => {
  it('still returns 429 after the 10th request — the limiter is intact', async () => {
    const app = await appWith('');
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMIT + 2; i++) statuses.push((await hit(app, OFFICE)).status);

    expect(statuses.slice(0, AUTH_LIMIT)).toEqual(Array(AUTH_LIMIT).fill(200));
    expect(statuses.slice(AUTH_LIMIT)).toEqual([429, 429]);
  });
});

describe('auth limiter, office IP allowlisted', () => {
  it('never throttles the allowlisted IP', async () => {
    const app = await appWith(OFFICE);
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMIT * 3; i++) statuses.push((await hit(app, OFFICE)).status);

    expect(new Set(statuses)).toEqual(new Set([200]));
  });

  it('still throttles everyone else — the exemption is not global', async () => {
    const app = await appWith(OFFICE);
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMIT + 1; i++) statuses.push((await hit(app, '203.0.113.7')).status);

    expect(statuses.at(-1)).toBe(429);
  });
});
