/**
 * Every one of the 212 admin operations, executed against production.
 *
 * Two passes per operation:
 *   1. ANONYMOUS  — must be refused. A 2xx here is an auth bypass.
 *   2. AUTHENTICATED — reachability, and the 5xx hunt.
 *
 * Reads are called with real ids where the dependency chain provides one, so a
 * handler does its actual work instead of short-circuiting on a 404.
 *
 * Writes are NOT given generated bodies here — that is `01-admin-crud.ts`'s job
 * for the generic engine, and the dedicated action endpoints (/approve,
 * /dispatch, /receive) mutate stock and are covered separately. Sending an empty
 * body reaches auth + validation and stops there, which is a real executed
 * request and a real latency, but it does NOT exercise the handler. Every such
 * row is labelled `validation-only` rather than being counted as a pass.
 */

import { readFileSync } from 'node:fs';
import { adminLogin, call, closeDb, unwrap, BASE } from './lib.js';

type Op = { module: string; method: string; path: string; protectedOp: boolean };

type Row = Op & {
  anonStatus: number;
  authStatus: number;
  ms: number;
  depth: 'full' | 'validation-only' | 'refused';
  verdict: 'PASS' | 'AUTH-BYPASS' | 'SERVER-ERROR' | 'FAIL';
  note: string;
};

function loadOps(): Op[] {
  const j = JSON.parse(readFileSync('openapi/openapi.admin.json', 'utf8')) as {
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
        protectedOp: op.security === undefined || (op.security as unknown[]).length > 0,
      });
    }
  return out;
}

const FAKE_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * `/v1/admin/auth/*` is excluded from the bulk sweep, deliberately.
 *
 * Those routes carry `rateLimit: 'auth'` — TEN requests per FIFTEEN minutes —
 * so sweeping thirteen of them twice does not measure anything: it exhausts the
 * budget and then locks the harness out of logging in at all, which is exactly
 * what happened on the first run.
 *
 * Worse, `/login` counts failed attempts toward a five-attempt account lockout.
 * Hammering it risks locking the only admin account out of production. The
 * limiter and the lockout are both working as designed; the sweep is what has
 * to adapt.
 *
 * Auth is instead exercised once, properly, by `adminLogin()` below — password,
 * MFA challenge, real TOTP — which is the flow that actually matters.
 */
const isAuthRoute = (path: string): boolean => path.startsWith('/v1/admin/auth/');

/**
 * Production allows 120 requests/min. This sweep makes two per operation, so
 * an unthrottled run trips the limiter and every later result is a 429 instead
 * of the endpoint's real answer — which is the limiter working, but useless as
 * a measurement. 620ms between requests keeps the whole run just under.
 */
const PACE_MS = 620;
let lastCall = 0;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, lastCall + PACE_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

async function main(): Promise<void> {
  console.log(`target: ${BASE}\n`);
  const admin = await adminLogin();
  const t = { token: admin.access };

  /* Real ids, so path-param routes reach their handlers. */
  const ids: Record<string, string> = {};
  for (const [key, path] of Object.entries({
    products: '/v1/admin/products?perPage=1',
    'product-variants': '/v1/admin/product-variants?perPage=1',
    collections: '/v1/admin/collections?perPage=1',
    customers: '/v1/admin/customers?perPage=1',
    warehouses: '/v1/admin/warehouses?perPage=1',
    suppliers: '/v1/admin/suppliers?perPage=1',
  })) {
    const r = await call('GET', path, t);
    const first = (unwrap(r.body) as { id?: string }[])?.[0];
    if (first?.id) ids[key] = first.id;
  }
  console.log(`dependency ids resolved: ${Object.keys(ids).join(', ') || 'none'}\n`);

  const fill = (path: string): string =>
    path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const n = name.toLowerCase();
      if (n.includes('variant')) return ids['product-variants'] ?? FAKE_UUID;
      if (n.includes('collection')) return ids.collections ?? FAKE_UUID;
      if (n.includes('customer')) return ids.customers ?? FAKE_UUID;
      if (n.includes('warehouse')) return ids.warehouses ?? FAKE_UUID;
      if (n.includes('supplier')) return ids.suppliers ?? FAKE_UUID;
      if (n.includes('product') || n === 'id') return ids.products ?? FAKE_UUID;
      if (n.includes('sku')) return 'qa-nonexistent-sku';
      if (n.includes('report')) return 'inventory-valuation';
      if (n.includes('slug') || n.includes('resource')) return 'products';
      return FAKE_UUID;
    });

  const all = loadOps();
  const skipped = all.filter((o) => isAuthRoute(o.path));
  const ops = all.filter((o) => !isAuthRoute(o.path));
  console.log(`skipping ${skipped.length} auth operations (10 req / 15 min limit + account lockout risk)`);
  console.log(`sweeping ${ops.length} admin operations (anonymous + authenticated)...\n`);

  const rows: Row[] = [];
  const queue = [...ops];

  {
    {
      for (;;) {
        const op = queue.shift();
        if (!op) break;
        const url = fill(op.path);
        const isRead = op.method === 'GET';

        const anon = await paced(() => call(op.method, url));
        const auth = await paced(() => call(op.method, url, { ...t, ...(isRead ? {} : { body: {} }) }));

        let verdict: Row['verdict'] = 'PASS';
        let depth: Row['depth'] = isRead ? 'full' : 'validation-only';
        let note = '';

        if (op.protectedOp && anon.status >= 200 && anon.status < 400) {
          verdict = 'AUTH-BYPASS';
          note = `returned ${anon.status} with no credentials`;
        } else if (auth.status >= 500) {
          verdict = 'SERVER-ERROR';
          note = auth.text.replace(/\s+/g, ' ').slice(0, 200);
        } else if (auth.status === 401 || auth.status === 403) {
          depth = 'refused';
          note = `authenticated request still ${auth.status}`;
          if (isRead) verdict = 'FAIL';
        } else if (isRead && ![200, 204, 400, 404, 422].includes(auth.status)) {
          verdict = 'FAIL';
          note = auth.text.replace(/\s+/g, ' ').slice(0, 160);
        }

        rows.push({ ...op, anonStatus: anon.status, authStatus: auth.status, ms: Math.round(auth.ms), depth, verdict, note });
      }
    }
  }

  /* ---------------------------------------------------------------- report */
  const byModule = new Map<string, Row[]>();
  for (const r of rows) byModule.set(r.module, [...(byModule.get(r.module) ?? []), r]);

  console.log('module                        ops  anon-refused  full  validation  5xx');
  console.log('----------------------------- ---  ------------  ----  ----------  ---');
  for (const [module, rs] of [...byModule].sort()) {
    const refused = rs.filter((r) => !r.protectedOp || r.anonStatus === 401 || r.anonStatus === 403).length;
    console.log(
      `${module.padEnd(29)} ${String(rs.length).padStart(3)}  ${String(refused).padStart(12)}  ` +
        `${String(rs.filter((r) => r.depth === 'full').length).padStart(4)}  ` +
        `${String(rs.filter((r) => r.depth === 'validation-only').length).padStart(10)}  ` +
        `${String(rs.filter((r) => r.verdict === 'SERVER-ERROR').length).padStart(3)}`,
    );
  }

  const bypasses = rows.filter((r) => r.verdict === 'AUTH-BYPASS');
  const servers = rows.filter((r) => r.verdict === 'SERVER-ERROR');
  const fails = rows.filter((r) => r.verdict === 'FAIL');
  const throttled = rows.filter((r) => r.authStatus === 429 || r.anonStatus === 429);
  if (throttled.length > 0) console.log(`
!! ${throttled.length} operations hit the rate limiter — results below are unreliable for those.`);
  const times = rows.map((r) => r.ms).sort((a, b) => a - b);

  console.log(`\ntotal operations   : ${rows.length}`);
  console.log(`auth bypasses      : ${bypasses.length}`);
  console.log(`server errors (5xx): ${servers.length}`);
  console.log(`other failures     : ${fails.length}`);
  console.log(`fully exercised    : ${rows.filter((r) => r.depth === 'full').length}`);
  console.log(`validation-only    : ${rows.filter((r) => r.depth === 'validation-only').length}`);
  console.log(`latency median/p95 : ${times[Math.floor(times.length / 2)]}ms / ${times[Math.floor(times.length * 0.95)]}ms`);

  for (const [label, list] of [['AUTH BYPASS', bypasses], ['SERVER ERROR', servers], ['FAILURE', fails]] as const) {
    if (list.length === 0) continue;
    console.log(`\n--- ${label} ---`);
    for (const r of list) console.log(`  ${r.authStatus} ${r.method} ${r.path}\n      ${r.note}`);
  }

  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(2);
});
