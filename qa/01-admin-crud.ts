/**
 * Full CRUD lifecycle for every resource the Admin Panel's generic engine drives.
 *
 * The panel calls exactly seven operations per resource:
 *   GET /schema · GET list · POST create · GET one · PATCH one · POST bulk · DELETE one
 *
 * Request bodies are GENERATED FROM EACH RESOURCE'S OWN `/schema` rather than
 * hand-written. Hand-written bodies drift from the contract the moment a field
 * changes, and generating them proves the schema endpoint is itself trustworthy:
 * if a body built strictly from `/schema` is rejected, the schema and the
 * validator disagree, and that IS the bug.
 */

import { adminLogin, call, closeDb, unwrap, BASE, type Res } from './lib.js';

type Field = {
  key: string;
  label: string;
  kind: string;
  required?: boolean;
  readOnly?: boolean;
  options?: string[] | null;
  reference?: { resource?: string; slug?: string } | null;
};

type Schema = {
  slug: string;
  fields: Field[];
  listColumns?: string[];
  createUnsupported?: string | null;
  bulkActions?: { action: string; destructive?: boolean }[];
};

type Step = {
  resource: string;
  op: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  ok: boolean;
  note: string;
};
const steps: Step[] = [];

function record(resource: string, op: string, method: string, path: string, res: Res, want: number[]): boolean {
  const ok = want.includes(res.status);
  steps.push({
    resource,
    op,
    method,
    path,
    status: res.status,
    ms: Math.round(res.ms),
    ok,
    note: ok ? '' : res.text.replace(/\s+/g, ' ').slice(0, 240),
  });
  return ok;
}

/** Unique per run so a re-run never collides on a unique index. */
const STAMP = Date.now().toString(36);

/**
 * Conditional requirements the DATABASE enforces that no schema marks required.
 * A real client learns these from the 422; encoded here so the rest of the
 * lifecycle can be reached.
 */
const CONDITIONAL: Record<string, Record<string, unknown>> = {
  products: { hsnCode: '4602', publishedAt: new Date().toISOString() },
  coupons: { discountBp: 1000 },
  // Nothing is schema-required, but a customer with no identity is meaningless
  // and the API rightly refuses an empty body.
  customers: { fullName: 'API Demo Customer', email: `api-demo-${STAMP}@example.test` },
};

/** `null` means omit — an empty string for an optional uuid/enum is rejected. */
function valueFor(field: Field, resource: string, refs: Record<string, string>): unknown {
  const { key, kind, options } = field;

  if (options && options.length > 0) {
    // Never create something pre-archived.
    return options.find((o) => !/archive|delete|inactive|block/i.test(o)) ?? options[0];
  }

  if (kind === 'boolean') return false;
  if (kind === 'number') return 1;
  if (kind === 'money') return 10000;
  if (kind === 'date' || kind === 'datetime') return new Date().toISOString();
  if (kind === 'array') return [];

  if (kind === 'reference') {
    const slug = field.reference?.resource ?? field.reference?.slug ?? '';
    return refs[slug] ?? refs[key] ?? null;
  }

  // The `handle` DOMAIN is `^[a-z0-9]+(-[a-z0-9]+)*$` and governs more than
  // columns literally called "handle" — SKUs and optionValue too.
  if (/^(handle|slug|sku)$/i.test(key)) return `qa-${resource.replace(/[^a-z]/g, '').slice(0, 6)}-${STAMP}`;
  if (/^code$/i.test(key)) return `QA${resource.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase()}${STAMP.toUpperCase()}`;
  if (/optionValue/i.test(key)) return 'standard';
  if (/email/i.test(key)) return `qa-${STAMP}@example.test`;
  if (/mobile|phone/i.test(key)) return '9876543210';
  if (/pincode/i.test(key)) return '226010';
  if (/stateCode/i.test(key)) return '09';
  if (/hsn/i.test(key)) return '4602';
  if (/url|link/i.test(key)) return 'https://example.test/qa';
  return `API Demo ${resource} ${STAMP}`;
}

function createBody(schema: Schema, resource: string, refs: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of schema.fields) {
    if (f.readOnly || f.key === 'id' || !f.required) continue;
    const v = valueFor(f, resource, refs);
    if (v !== null) body[f.key] = v;
  }
  return { ...body, ...(CONDITIONAL[resource] ?? {}) };
}

function patchBody(schema: Schema, resource: string): Record<string, unknown> {
  const target = schema.fields.find(
    (f) => !f.readOnly && f.kind === 'text' && !/^(handle|slug|code|sku|id)$/i.test(f.key) && !f.options,
  );
  return target ? { [target.key]: `API Demo ${resource} patched ${STAMP}` } : {};
}

async function main(): Promise<void> {
  console.log(`target: ${BASE}\n`);
  const admin = await adminLogin();
  const t = { token: admin.access };

  const reg = await call('GET', '/v1/admin/resources', t);
  const slugs = (unwrap(reg.body) as { slug: string }[]).map((r) => r.slug);
  console.log(`registry reports ${slugs.length} generic resources\n`);

  // Build dependency refs first so `reference` fields resolve to real rows.
  const refs: Record<string, string> = {};
  for (const slug of ['collections', 'designers', 'products']) {
    const list = await call('GET', `/v1/admin/${slug}?perPage=1`, t);
    const first = (unwrap(list.body) as { id?: string }[])?.[0];
    if (first?.id) refs[slug] = first.id;
  }

  for (const slug of slugs) {
    const sc = await call('GET', `/v1/admin/${slug}/schema`, t);
    record(slug, 'schema', 'GET', `/v1/admin/${slug}/schema`, sc, [200]);
    if (sc.status !== 200) continue;
    const schema = unwrap(sc.body) as Schema;

    const list = await call('GET', `/v1/admin/${slug}?perPage=5`, t);
    record(slug, 'list', 'GET', `/v1/admin/${slug}`, list, [200]);

    if (schema.createUnsupported) {
      steps.push({
        resource: slug, op: 'create', method: 'POST', path: `/v1/admin/${slug}`,
        status: 0, ms: 0, ok: true, note: 'create not supported by design: ' + schema.createUnsupported,
      });
      continue;
    }

    const body = createBody(schema, slug, refs);
    const post = await call('POST', `/v1/admin/${slug}`, { ...t, body });
    if (!record(slug, 'create', 'POST', `/v1/admin/${slug}`, post, [200, 201])) {
      console.log(`  ${slug} create body: ${JSON.stringify(body).slice(0, 180)}`);
      continue;
    }

    const id = (unwrap(post.body) as { id: string }).id;

    const one = await call('GET', `/v1/admin/${slug}/${id}`, t);
    record(slug, 'detail', 'GET', `/v1/admin/${slug}/{id}`, one, [200]);

    const patch = patchBody(schema, slug);
    if (Object.keys(patch).length > 0) {
      const p = await call('PATCH', `/v1/admin/${slug}/${id}`, { ...t, body: patch });
      record(slug, 'update', 'PATCH', `/v1/admin/${slug}/{id}`, p, [200]);
    }

    // Each resource declares its own vocabulary — 'archive' is not universal.
    const action = (schema.bulkActions ?? []).find((a) => !a.destructive)?.action ?? schema.bulkActions?.[0]?.action;
    if (action) {
      const bulk = await call('POST', `/v1/admin/${slug}/bulk`, { ...t, body: { action, ids: [id] } });
      record(slug, 'bulk', 'POST', `/v1/admin/${slug}/bulk (${action})`, bulk, [200, 202]);
    }

    const del = await call('DELETE', `/v1/admin/${slug}/${id}`, t);
    record(slug, 'delete', 'DELETE', `/v1/admin/${slug}/{id}`, del, [200, 204]);
  }

  /* ---------------------------------------------------------------- report */
  const byResource = new Map<string, Step[]>();
  for (const s of steps) byResource.set(s.resource, [...(byResource.get(s.resource) ?? []), s]);

  console.log('resource            schema list  create detail update bulk  delete');
  console.log('------------------- ------ ----- ------ ------ ------ ----- ------');
  for (const [resource, rows] of byResource) {
    const cell = (op: string) => {
      const r = rows.find((x) => x.op === op);
      if (!r) return '  -  ';
      return r.ok ? ' ok  ' : ` ${r.status} `;
    };
    console.log(
      `${resource.padEnd(19)} ${cell('schema').padEnd(6)} ${cell('list').padEnd(5)} ${cell('create').padEnd(6)} ${cell('detail').padEnd(6)} ${cell('update').padEnd(6)} ${cell('bulk').padEnd(5)} ${cell('delete')}`,
    );
  }

  const fails = steps.filter((s) => !s.ok);
  const times = steps.filter((s) => s.ms > 0).map((s) => s.ms).sort((a, b) => a - b);
  console.log(`\n${steps.length - fails.length}/${steps.length} operations passed`);
  console.log(
    `latency: median ${Math.round(times[Math.floor(times.length / 2)] ?? 0)}ms  ` +
      `p95 ${Math.round(times[Math.floor(times.length * 0.95)] ?? 0)}ms  max ${Math.round(times[times.length - 1] ?? 0)}ms`,
  );

  if (fails.length) {
    console.log('\n--- FAILURES ---');
    for (const f of fails) console.log(`  ${f.status} ${f.method} ${f.path}\n      ${f.note}`);
  }
  console.log(`\n5xx (backend defects): ${fails.filter((f) => f.status >= 500).length}`);

  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(2);
});
