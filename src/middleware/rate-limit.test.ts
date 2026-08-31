import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import type * as RateLimitModule from './rate-limit.js';

/**
 * The IP exemption, and specifically what it must NOT exempt.
 *
 * The whole risk in this feature is scope creep: it exists so testing from a
 * known office IP is not throttled, and the failure mode is that it quietly
 * also unthrottles the endpoints that spend real money. `otp` sends live SMS and
 * `payment` carries LIVE Razorpay keys — a test loop against either is a bill,
 * not a bug, so those are asserted individually rather than by counting.
 */

const load = async (skipIps: string): Promise<typeof RateLimitModule> => {
  vi.resetModules();
  vi.doMock('../config/env.js', () => ({
    env: {
      rateLimitSkipIps: skipIps.split(',').map((s) => s.trim()).filter(Boolean),
      isTest: true,
    },
  }));
  vi.doMock('../config/redis.js', () => ({ cache: { call: vi.fn() } }));
  return import('./rate-limit.js');
};

const req = (ip: string, viaProxy = true): Request =>
  ({
    headers: viaProxy ? { 'x-forwarded-for': ip } : {},
    socket: { remoteAddress: viaProxy ? '10.0.0.1' : ip },
  }) as unknown as Request;

const OFFICE = '183.82.162.9';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../config/env.js');
  vi.doUnmock('../config/redis.js');
});

describe('with no allowlist configured (the production default)', () => {
  let mod: typeof RateLimitModule;
  beforeEach(async () => {
    mod = await load('');
  });

  it('exempts nobody from anything', () => {
    for (const name of ['auth', 'default', 'otp', 'payment', 'checkout', 'search'] as const) {
      expect(mod.isExempt(req(OFFICE), name)).toBe(false);
    }
  });
});

describe('with the office IP allowlisted', () => {
  let mod: typeof RateLimitModule;
  beforeEach(async () => {
    mod = await load(OFFICE);
  });

  it('exempts the allowlisted IP from the auth limiter', () => {
    expect(mod.isExempt(req(OFFICE), 'auth')).toBe(true);
  });

  it('does NOT exempt otp — every send costs real money', () => {
    expect(mod.isExempt(req(OFFICE), 'otp')).toBe(false);
  });

  it('does NOT exempt payment — the Razorpay keys are live', () => {
    expect(mod.isExempt(req(OFFICE), 'payment')).toBe(false);
  });

  it('does NOT exempt webhook — that is Razorpay calling us, not an operator', () => {
    expect(mod.isExempt(req(OFFICE), 'webhook')).toBe(false);
  });

  it('exempts nobody else', () => {
    expect(mod.isExempt(req('203.0.113.7'), 'auth')).toBe(false);
  });

  it('matches an IPv4-mapped socket address against a plain IPv4 entry', () => {
    // A direct connection arrives as ::ffff:183.82.162.9; an operator writes the
    // plain form in the allowlist and expects it to match.
    expect(mod.isExempt(req(`::ffff:${OFFICE}`, false), 'auth')).toBe(true);
  });

  it('prefers the first x-forwarded-for entry, which is what nginx sets', () => {
    const chained = {
      headers: { 'x-forwarded-for': `${OFFICE}, 70.41.3.18` },
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as Request;
    expect(mod.isExempt(chained, 'auth')).toBe(true);
  });

  it('does not exempt a request with no address at all', () => {
    const anon = { headers: {}, socket: {} } as unknown as Request;
    expect(mod.isExempt(anon, 'auth')).toBe(false);
  });
});
