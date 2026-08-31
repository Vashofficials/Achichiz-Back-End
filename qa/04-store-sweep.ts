/**
 * Every storefront operation, executed against production.
 *
 * Same two passes as the admin sweep: anonymous (public must serve, protected
 * must refuse) then authenticated with a real customer session.
 *
 * Several storefront routes carry much tighter limiters than the 120/min
 * default and are excluded rather than measured — hammering them tells us
 * nothing and costs real budget:
 *
 *   auth      10 / 15 min   and /login counts toward an account lockout
 *   otp        5 / 15 min   sends real SMS
 *   lead      10 / hour     writes to the sales inbox
 *   checkout  20 / min      creates orders
 *   payment   30 / min      touches Razorpay with LIVE keys
 *
 * Payments and webhooks are excluded for a second reason: the configured
 * Razorpay keys are live, and no test may risk a real financial transaction.
 */

import { readFileSync } from 'node:fs';
import { call, closeDb, unwrap, BASE } from './lib.js';

type Op = { module: string; method: string; path: string; publicOp: boolean };

type Row = Op & {
  anonStatus: number;
  authStatus: number;
  ms: number;
  verdict: 'PASS' | 'AUTH-BYPASS' | 'SERVER-ERROR' | 'FAIL' | 'SKIPPED';
  note: string;
};

const DEMO_CUSTOMER = {
  email: 'api-demo-customer@example.test',
  password: 'ApiDemoPassword123',
  fullName: 'API Demo Customer',
};

/**
 * Routes deliberately not swept, with the reason. Being explicit beats a silent
 * filter: a reader should be able to see WHY a number is 62 and not 70.
 */
const EXCLUDED: { match: RegExp; reason: string }[] = [
  { match: /^\/v1\/auth\//, reason: 'auth limiter 10/15min + account lockout' },
  { match: /otp/i, reason: 'otp limiter 5/15min, sends real SMS' },
  { match: /^\/v1\/leads/, reason: 'lead limiter 10/hour, writes to the sales inbox' },
  { match: /^\/v1\/checkout/, reason: 'creates real orders' },
  { match: /^\/v1\/payments/, reason: 'Razorpay keys are LIVE — never touched by a test' },
  { match: /webhook/i, reason: 'signature-authenticated; an unsigned call proves nothing' },
];

const FAKE_UUID = '00000000-0000-4000-8000-000000000000';
const PACE_MS = 620;
let lastCall = 0;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, lastCall + PACE_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

function loadOps(): Op[] {
  const j = JSON.parse(readFileSync('openapi/openapi.storefront.json', 'utf8')) as {
    paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>>;
  };
  const out: Op[] = [];
  for (const [path, ops] of Object.entries(j.paths))
    for (const [method, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      out.push({
        module: (op.tags ?? ['-'])[0] as string,
        method: method.toUpperCase(),
        path,
        publicOp: Array.isArray(op.security) && op.security.length === 0,
      });
    }
  return out;
}

async function customerToken(): Promise<string | null> {
  const login = await paced(() =>
    call('POST', '/v1/auth/login', {
      body: { emailOrMobile: DEMO_CUSTOMER.email, password: DEMO_CUSTOMER.password },
    }),
  );
  if (login.status === 200) return (unwrap(login.body) as { accessToken?: string }).accessToken ?? null;

  // Not there yet — create it once, then sign in.
  const signup = await paced(() => call('POST', '/v1/auth/signup', { body: DEMO_CUSTOMER }));
  if (signup.status >= 200 && signup.status < 300) {
    const again = await paced(() =>
      call('POST', '/v1/auth/login', {
        body: { emailOrMobile: DEMO_CUSTOMER.email, password: DEMO_CUSTOMER.password },
      }),
    );
    return (unwrap(again.body) as { accessToken?: string }).accessToken ?? null;
  }
  console.log(`  could not obtain a customer token: login ${login.status}, signup ${signup.status}`);
  return null;
}

async function main(): Promise<void> {
  console.log(`target: ${BASE}\n`);

  const token = await customerToken();
  console.log(`customer session: ${token ? 'acquired' : 'UNAVAILABLE — protected rows will be inconclusive'}\n`);

  /* Real handles so detail routes reach their handlers. */
  const productsRes = await paced(() => call('GET', '/v1/products?perPage=1'));
  const collectionsRes = await paced(() => call('GET', '/v1/collections?perPage=1'));
  const productHandle = (unwrap(productsRes.body) as { handle?: string }[])?.[0]?.handle ?? 'qa-nonexistent';
  const collectionHandle = (unwrap(collectionsRes.body) as { handle?: string }[])?.[0]?.handle ?? 'qa-nonexistent';
  console.log(`handles: product=${productHandle} collection=${collectionHandle}\n`);

  const fill = (path: string): string =>
    path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const n = name.toLowerCase();
      if (n.includes('collection')) return collectionHandle;
      if (n.includes('handle') || n.includes('slug')) return productHandle;
      return FAKE_UUID;
    });

  const all = loadOps();
  const rows: Row[] = [];

  for (const op of all) {
    const excluded = EXCLUDED.find((e) => e.match.test(op.path));
    if (excluded) {
      rows.push({ ...op, anonStatus: 0, authStatus: 0, ms: 0, verdict: 'SKIPPED', note: excluded.reason });
      continue;
    }

    const url = fill(op.path);
    const isRead = op.method === 'GET';

    const anon = await paced(() => call(op.method, url));
    const auth = token
      ? await paced(() => call(op.method, url, { token, ...(isRead ? {} : { body: {} }) }))
      : anon;

    let verdict: Row['verdict'] = 'PASS';
    let note = '';

    if (!op.publicOp && anon.status >= 200 && anon.status < 400) {
      verdict = 'AUTH-BYPASS';
      note = `protected route returned ${anon.status} with no credentials`;
    } else if (auth.status >= 500 || anon.status >= 500) {
      verdict = 'SERVER-ERROR';
      note = (auth.status >= 500 ? auth.text : anon.text).replace(/\s+/g, ' ').slice(0, 200);
    } else if (op.publicOp && isRead && ![200, 204, 404, 422].includes(anon.status)) {
      verdict = 'FAIL';
      note = `public read returned ${anon.status}: ${anon.text.replace(/\s+/g, ' ').slice(0, 140)}`;
    }

    rows.push({ ...op, anonStatus: anon.status, authStatus: auth.status, ms: Math.round(auth.ms), verdict, note });
  }

  /* ---------------------------------------------------------------- report */
  const byModule = new Map<string, Row[]>();
  for (const r of rows) byModule.set(r.module, [...(byModule.get(r.module) ?? []), r]);

  console.log('module                  ops  tested  skipped  5xx  bypass');
  console.log('----------------------- ---  ------  -------  ---  ------');
  for (const [module, rs] of [...byModule].sort()) {
    console.log(
      `${module.padEnd(23)} ${String(rs.length).padStart(3)}  ` +
        `${String(rs.filter((r) => r.verdict !== 'SKIPPED').length).padStart(6)}  ` +
        `${String(rs.filter((r) => r.verdict === 'SKIPPED').length).padStart(7)}  ` +
        `${String(rs.filter((r) => r.verdict === 'SERVER-ERROR').length).padStart(3)}  ` +
        `${String(rs.filter((r) => r.verdict === 'AUTH-BYPASS').length).padStart(6)}`,
    );
  }

  const tested = rows.filter((r) => r.verdict !== 'SKIPPED');
  const times = tested.map((r) => r.ms).filter((m) => m > 0).sort((a, b) => a - b);
  console.log(`\ntotal store operations : ${rows.length}`);
  console.log(`tested                 : ${tested.length}`);
  console.log(`skipped (with reason)  : ${rows.length - tested.length}`);
  console.log(`auth bypasses          : ${rows.filter((r) => r.verdict === 'AUTH-BYPASS').length}`);
  console.log(`server errors (5xx)    : ${rows.filter((r) => r.verdict === 'SERVER-ERROR').length}`);
  console.log(`other failures         : ${rows.filter((r) => r.verdict === 'FAIL').length}`);
  if (times.length) {
    console.log(`latency median/p95     : ${times[Math.floor(times.length / 2)]}ms / ${times[Math.floor(times.length * 0.95)]}ms`);
  }

  for (const label of ['AUTH-BYPASS', 'SERVER-ERROR', 'FAIL'] as const) {
    const list = rows.filter((r) => r.verdict === label);
    if (list.length === 0) continue;
    console.log(`\n--- ${label} ---`);
    for (const r of list) console.log(`  ${r.method} ${r.path}  anon=${r.anonStatus} auth=${r.authStatus}\n      ${r.note}`);
  }

  console.log('\n--- skipped, and why ---');
  for (const r of rows.filter((r) => r.verdict === 'SKIPPED')) console.log(`  ${r.method.padEnd(6)} ${r.path.padEnd(42)} ${r.note}`);

  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(2);
});
