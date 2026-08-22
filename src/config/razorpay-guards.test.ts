import { describe, expect, it } from 'vitest';
import {
  razorpayConfigIssues,
  razorpayKeyLabel,
  razorpayKeyMode,
  razorpayLiveKeyError,
  razorpayTestKeyInProductionError,
} from './env.js';

/**
 * These guards exist because of a real incident shape: live Razorpay credentials
 * were pasted into a chat window and a plaintext CSV. The guards cannot prevent a
 * leak — only rotation does that — but they make the *consequence* of a
 * misplaced live key loud and immediate rather than silent and expensive.
 *
 * Every function under test is pure, so none of this needs a gateway, a key or a
 * network. No real credential appears anywhere in this file.
 */

const LIVE = 'rzp_live_XXXXXXXXXXXXXX';
const TEST = 'rzp_test_XXXXXXXXXXXXXX';

describe('razorpayKeyMode', () => {
  it('reads the mode off the key id itself, not a separate flag', () => {
    expect(razorpayKeyMode(LIVE)).toBe('live');
    expect(razorpayKeyMode(TEST)).toBe('test');
  });

  it('reports unknown rather than guessing', () => {
    // A truncated paste, a placeholder left in .env, or a key from another gateway.
    expect(razorpayKeyMode('')).toBe('unknown');
    expect(razorpayKeyMode('rzp_')).toBe('unknown');
    expect(razorpayKeyMode('sk_live_something')).toBe('unknown');
  });

  it('does not treat a live prefix appearing mid-string as a live key', () => {
    expect(razorpayKeyMode('prefix_rzp_live_abc')).toBe('unknown');
  });
});

describe('razorpayKeyLabel', () => {
  it('never returns the key body', () => {
    const label = razorpayKeyLabel(LIVE);
    expect(label).not.toContain('XXXXXXXXXXXXXX');
    expect(label).toBe('rzp_live_…');
  });

  it('still says which mode it is, because that is the useful half', () => {
    expect(razorpayKeyLabel(TEST)).toBe('rzp_test_…');
  });

  it('handles an unset key without throwing', () => {
    expect(razorpayKeyLabel('')).toBe('(unset)');
  });

  it('truncates an unrecognised key rather than echoing it', () => {
    expect(razorpayKeyLabel('sk_live_abcdefghijklmnop')).toBe('sk_l…');
  });
});

describe('razorpayLiveKeyError — the guard that matters', () => {
  it('REFUSES a live key in development', () => {
    const err = razorpayLiveKeyError(LIVE, 'development');
    expect(err).not.toBeNull();
    expect(err).toContain('REFUSING');
  });

  it('REFUSES a live key in test', () => {
    expect(razorpayLiveKeyError(LIVE, 'test')).not.toBeNull();
  });

  it('allows a live key in production — that is the whole point of the key', () => {
    expect(razorpayLiveKeyError(LIVE, 'production')).toBeNull();
  });

  it('allows a test key anywhere', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
      expect(razorpayLiveKeyError(TEST, nodeEnv)).toBeNull();
    }
  });

  it('does not fire when no key is configured at all', () => {
    // CI, openapi:generate and the test suite all run with no gateway.
    expect(razorpayLiveKeyError('', 'development')).toBeNull();
  });

  it('does not leak the key into the error message', () => {
    expect(razorpayLiveKeyError(LIVE, 'development')).not.toContain('XXXXXXXXXXXXXX');
  });
});

describe('razorpayTestKeyInProductionError — the mirror', () => {
  it('flags a test key in production, where no payment could ever succeed', () => {
    const err = razorpayTestKeyInProductionError(TEST, 'production');
    expect(err).not.toBeNull();
    expect(err).toContain('TEST key');
  });

  it('stays quiet for a test key outside production', () => {
    expect(razorpayTestKeyInProductionError(TEST, 'development')).toBeNull();
  });

  it('stays quiet for a live key in production', () => {
    expect(razorpayTestKeyInProductionError(LIVE, 'production')).toBeNull();
  });
});

describe('razorpayConfigIssues — all three, or none', () => {
  const full = { keyId: TEST, keySecret: 'secret', webhookSecret: 'whsec' };

  it('accepts a fully configured gateway', () => {
    expect(razorpayConfigIssues(full)).toEqual([]);
  });

  it('accepts nothing configured — CI and the docs generator run without a gateway', () => {
    expect(razorpayConfigIssues({ keyId: '', keySecret: '', webhookSecret: '' })).toEqual([]);
  });

  it('rejects a MISSING WEBHOOK SECRET, which is the dangerous half-configuration', () => {
    // Checkout would succeed and charge the customer, then every webhook would be
    // rejected as unsigned, so the order never becomes paid and nobody notices
    // until someone complains. This must fail at boot.
    const issues = razorpayConfigIssues({ ...full, webhookSecret: '' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('RAZORPAY_WEBHOOK_SECRET');
  });

  it('rejects a missing key secret', () => {
    expect(razorpayConfigIssues({ ...full, keySecret: '' })[0]).toContain('RAZORPAY_KEY_SECRET');
  });

  it('reports every missing variable, not just the first', () => {
    const issues = razorpayConfigIssues({ keyId: TEST, keySecret: '', webhookSecret: '' });
    expect(issues).toHaveLength(2);
  });

  it('never echoes a secret value in the issue text', () => {
    const issues = razorpayConfigIssues({ ...full, webhookSecret: '' });
    expect(issues.join(' ')).not.toContain('secret');
  });
});
