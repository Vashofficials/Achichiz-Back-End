/**
 * `npm run razorpay:preflight`
 *
 * Proves the Razorpay configuration of THIS process is usable — without moving
 * a single paisa. It reads; it never creates an order, a payment or a refund.
 *
 * What it checks, in order:
 *   1. all three variables are present (the boot guard in `config/env.ts` has
 *      already enforced "all or none", this reports which mode you are in);
 *   2. the key mode matches NODE_ENV, so a live key on a laptop is refused here
 *      rather than discovered by a real card being charged;
 *   3. the key id and key secret actually authenticate together, by fetching one
 *      page of the orders list — a read-only call;
 *   4. the webhook secret is present, and prints the exact URL and event list to
 *      configure in the dashboard.
 *
 * It prints the key MODE and nothing else about the key. The key secret and the
 * webhook secret are never printed, logged, or written anywhere, in whole or in
 * part — only whether they are set.
 *
 * Exit code 0 = ready. 1 = something must be fixed before taking payments.
 */

import {
  env,
  razorpayConfigIssues,
  razorpayKeyLabel,
  razorpayKeyMode,
  razorpayLiveKeyError,
  razorpayTestKeyInProductionError,
} from '../config/env.js';
import { razorpay, razorpayConfigured } from '../modules/payments/payments.razorpay.js';

/** The events `webhooks.service.dispatch()` actually acts on. */
export const REQUIRED_WEBHOOK_EVENTS = [
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'refund.failed',
] as const;

/** Acknowledged with a 200 and no state change. Subscribing is harmless, not required. */
export const OPTIONAL_WEBHOOK_EVENTS = ['payment.authorized', 'order.paid', 'refund.created'] as const;

export const webhookUrlFor = (publicUrl: string): string =>
  `${publicUrl.replace(/\/+$/, '')}/v1/webhooks/razorpay`;

/* ----------------------------------------------------------------- output */

// `process.stdout` rather than console: this is a CLI, and `no-console` is an
// error everywhere in src/ for good reason.
const out = (line = ''): void => void process.stdout.write(`${line}\n`);
const ok = (line: string): void => out(`  [ OK ]  ${line}`);
const bad = (line: string): void => out(`  [FAIL]  ${line}`);
const note = (line: string): void => out(`          ${line}`);

/* ------------------------------------------------------------------ check */

export async function preflight(): Promise<number> {
  let failures = 0;
  const fail = (line: string): void => {
    bad(line);
    failures += 1;
  };

  out();
  out('Razorpay preflight — configuration only, no money moves.');
  out('='.repeat(72));
  out();
  out(`  NODE_ENV        ${env.NODE_ENV}`);
  out(`  API_PUBLIC_URL  ${env.API_PUBLIC_URL}`);
  out();

  /* 1 — presence -------------------------------------------------------- */
  out('Configuration');
  const issues = razorpayConfigIssues({
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  });
  for (const issue of issues) fail(issue);

  if (!razorpayConfigured()) {
    fail('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are unset — no payment can be taken.');
    out();
    out('='.repeat(72));
    out('NOT READY. Set the Razorpay variables in .env and run this again.');
    out();
    return 1;
  }

  const mode = razorpayKeyMode(env.RAZORPAY_KEY_ID);
  ok(`RAZORPAY_KEY_ID is set (${razorpayKeyLabel(env.RAZORPAY_KEY_ID)}) — ${mode.toUpperCase()} mode.`);
  if (mode === 'unknown') {
    fail('The key id starts with neither `rzp_test_` nor `rzp_live_`. Is it really a Razorpay key id?');
  }
  ok(`RAZORPAY_KEY_SECRET is set (${env.RAZORPAY_KEY_SECRET.length} characters, never printed).`);

  if (env.RAZORPAY_WEBHOOK_SECRET) {
    ok(`RAZORPAY_WEBHOOK_SECRET is set (${env.RAZORPAY_WEBHOOK_SECRET.length} characters, never printed).`);
  } else {
    fail('RAZORPAY_WEBHOOK_SECRET is empty — every webhook will be rejected with 400 and no order will ever be marked paid.');
  }

  /* 2 — mode vs environment --------------------------------------------- */
  out();
  out('Key mode');
  const liveKeyError = razorpayLiveKeyError(env.RAZORPAY_KEY_ID, env.NODE_ENV);
  const testKeyError = razorpayTestKeyInProductionError(env.RAZORPAY_KEY_ID, env.NODE_ENV);
  if (liveKeyError) fail(liveKeyError);
  if (testKeyError) fail(testKeyError);
  if (!liveKeyError && !testKeyError) {
    ok(`A ${mode} key in NODE_ENV=${env.NODE_ENV} is the right combination.`);
    if (mode === 'live') {
      note('This process CAN move real money. Every capture and refund is real.');
    }
  }

  /* 3 — do the two halves authenticate together? ------------------------- */
  out();
  out('Credentials');
  if (liveKeyError) {
    note('Skipped: the client is refused while a live key is configured outside production.');
  } else {
    try {
      // Read-only. `count: 1` fetches at most one existing order and creates
      // nothing. A wrong secret fails here with a 401 from Razorpay.
      await razorpay().orders.all({ count: 1 });
      ok('The key id and key secret authenticate together against the Razorpay API.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail(`Razorpay rejected these credentials: ${message}`);
      note('A 401 here means the key id and key secret are from different key pairs, or have been rotated.');
    }
  }

  /* 4 — what to configure in the dashboard ------------------------------ */
  out();
  out('Dashboard configuration required (Razorpay → Settings → Webhooks)');
  out();
  out(`  Webhook URL     ${webhookUrlFor(env.API_PUBLIC_URL)}`);
  out('  Active          yes');
  out('  Secret          the value of RAZORPAY_WEBHOOK_SECRET from this .env');
  out('                  (paste it into the dashboard; it is never printed here)');
  out('  Events          required:');
  for (const event of REQUIRED_WEBHOOK_EVENTS) out(`                    - ${event}`);
  out('                  optional (acknowledged, no state change):');
  for (const event of OPTIONAL_WEBHOOK_EVENTS) out(`                    - ${event}`);
  out();
  if (!env.API_PUBLIC_URL.startsWith('https://')) {
    note('API_PUBLIC_URL is not https — Razorpay will not deliver webhooks to a plain-http endpoint in live mode.');
  }

  out('='.repeat(72));
  out(failures === 0 ? 'READY.' : `NOT READY — ${failures} problem${failures === 1 ? '' : 's'} above.`);
  out();
  return failures === 0 ? 0 : 1;
}

/* Only when run directly, so the pure helpers above stay importable by tests. */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href.replace(/\\/g, '/')) {
  process.exitCode = await preflight();
}
