/* eslint-disable no-console */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Generates the reference documentation FROM the built artifacts, so it cannot
 * drift the way hand-written docs do.
 *
 *   docs/API-REFERENCE.md  ← openapi/openapi.{storefront,admin}.json
 *   docs/DATABASE.md       ← src/db/migrations/*.sql
 *
 * Run `npm run openapi:generate` first so the specs are current. This script
 * reads only; it never touches src/.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const DOCS = resolve(ROOT, 'docs');

/* ------------------------------------------------------------------ types */

type Schema = Record<string, unknown>;
type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: Schema }[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema }> }>;
  security?: Record<string, unknown>[];
};

/* ------------------------------------------------------- schema rendering */

/** A one-line type for a JSON Schema node, e.g. `string` / `integer` / `array<string>`. */
function typeOf(s: Schema | undefined): string {
  if (!s) return '—';
  if (Array.isArray(s.anyOf)) return (s.anyOf as Schema[]).map(typeOf).join(' \\| ');
  if (Array.isArray(s.oneOf)) return (s.oneOf as Schema[]).map(typeOf).join(' \\| ');
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  if (Array.isArray(s.enum)) return (s.enum as unknown[]).map((v) => `\`${String(v)}\``).join(' \\| ');
  const t = typeof s.type === 'string' ? s.type : Array.isArray(s.type) ? (s.type as string[]).join('|') : 'object';
  if (t === 'array') return `array<${typeOf(s.items as Schema)}>`;
  return t;
}

/** Constraints worth documenting: min/max, length, pattern, format, default. */
function constraintsOf(s: Schema | undefined): string {
  if (!s) return '';
  const bits: string[] = [];
  if (typeof s.minimum === 'number') bits.push(`min ${s.minimum}`);
  if (typeof s.maximum === 'number') bits.push(`max ${s.maximum}`);
  if (typeof s.minLength === 'number') bits.push(`minLen ${s.minLength}`);
  if (typeof s.maxLength === 'number') bits.push(`maxLen ${s.maxLength}`);
  if (typeof s.format === 'string') bits.push(String(s.format));
  if (typeof s.pattern === 'string') bits.push(`pattern \`${String(s.pattern).slice(0, 40)}\``);
  if (s.default !== undefined) bits.push(`default \`${JSON.stringify(s.default)}\``);
  return bits.join(', ');
}

/** Markdown-safe one-liner. Non-strings are JSON-encoded rather than stringified to `[object Object]`. */
const esc = (v: unknown): string => {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
};

/** Flatten an object schema one level into documentable rows. */
function fieldRows(s: Schema | undefined): string[] {
  if (!s || typeof s !== 'object') return [];
  const props = s.properties as Record<string, Schema> | undefined;
  if (!props) return [];
  const required = new Set((s.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, prop]) => {
    const c = constraintsOf(prop);
    return `| \`${name}\` | ${typeOf(prop)} | ${required.has(name) ? '**yes**' : 'no'} | ${esc(prop.description)}${c ? ` <br><sub>${c}</sub>` : ''} |`;
  });
}

/* ---------------------------------------------------------- api reference */

function renderOperation(method: string, path: string, op: Operation): string[] {
  const out: string[] = [];
  const auth =
    !op.security || op.security.length === 0
      ? 'public'
      : op.security.some((s) => 'adminBearerAuth' in s)
        ? '`adminBearerAuth` (staff)'
        : '`bearerAuth` (customer)';

  out.push(`#### \`${method.toUpperCase()} ${path}\``, '');
  out.push(`> ${op.summary ?? ''}`, '');
  if (op.description) out.push(op.description, '');
  out.push(`| | |`, `|---|---|`);
  out.push(`| operationId | \`${op.operationId ?? '—'}\` |`);
  out.push(`| Auth | ${auth} |`, '');

  const pathParams = (op.parameters ?? []).filter((p) => p.in === 'path');
  const queryParams = (op.parameters ?? []).filter((p) => p.in === 'query');

  for (const [label, list] of [
    ['Path parameters', pathParams],
    ['Query parameters', queryParams],
  ] as const) {
    if (list.length === 0) continue;
    out.push(`**${label}**`, '');
    out.push('| Name | Type | Required | Notes |', '|---|---|---|---|');
    for (const p of list) {
      const c = constraintsOf(p.schema);
      out.push(
        `| \`${p.name}\` | ${typeOf(p.schema)} | ${p.required ? '**yes**' : 'no'} | ${esc(p.description)}${c ? ` <br><sub>${c}</sub>` : ''} |`,
      );
    }
    out.push('');
  }

  const body = op.requestBody?.content?.['application/json']?.schema;
  const bodyRows = fieldRows(body);
  if (bodyRows.length > 0) {
    out.push('**Request body** — `application/json`', '');
    out.push('| Field | Type | Required | Description |', '|---|---|---|---|', ...bodyRows, '');
  }

  const responses = Object.entries(op.responses ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  if (responses.length > 0) {
    out.push('**Responses**', '');
    out.push('| Status | Meaning |', '|---|---|');
    for (const [code, r] of responses) out.push(`| \`${code}\` | ${esc(r.description)} |`);
    out.push('');

    const ok = responses.find(([c]) => c.startsWith('2'));
    const okSchema = ok?.[1]?.content?.['application/json']?.schema;
    const okRows = fieldRows(okSchema);
    if (okRows.length > 0) {
      out.push(`<details><summary>Success payload — the <code>data</code> field of the envelope</summary>`, '');
      out.push('| Field | Type | Always present | Description |', '|---|---|---|---|', ...okRows, '');
      out.push('</details>', '');
    }
  }

  out.push('---', '');
  return out;
}

function buildApiReference(): string {
  const preamble = `# Achichiz API Reference

> **Generated** from \`openapi/openapi.storefront.json\` and \`openapi/openapi.admin.json\`.
> Regenerate with \`npm run openapi:generate && npm run docs:generate\` — do not hand-edit.

## Conventions

**Envelope.** A single resource returns \`{ "data": { … } }\`. A collection returns
\`{ "data": [ … ], "meta": { "page", "perPage", "total", "totalPages" } }\`. Deletes return \`204\`
with no body. The tables below describe the **inner \`data\` payload**, not the wrapper.

**Money is always an integer number of paise.** \`"totalPaise": 149900\` means ₹1,499.00. There are
no float rupee values anywhere in this API. Percentages are integer basis points (250 = 2.5%).

**Errors** follow RFC 9457 with \`Content-Type: application/problem+json\`:

\`\`\`json
{
  "type": "https://api.achichiz.com/errors/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "code": "validation_failed",
  "detail": "1 field is invalid.",
  "instance": "/v1/products",
  "requestId": "01KZGXZP18APANE6GJGZZXB00Y",
  "errors": [{ "path": "perPage", "code": "too_big", "message": "Too big: expected number to be <=100" }]
}
\`\`\`

Switch on \`code\` — it is stable. \`title\` is human-facing and may be reworded.

**Pagination.** List endpoints accept \`page\` (1-indexed) and \`perPage\` (**max 100**), plus
\`sort\` (field name, \`-\` prefix for descending; validated against a per-resource allowlist) and
\`q\` for free-text search.

**Auth.** Two schemes, different secrets and different \`aud\` claims:

| Scheme | Audience | Obtained from | Lifetime |
|---|---|---|---|
| \`bearerAuth\` | customer | \`POST /v1/auth/login\` or \`/v1/auth/otp/verify\` | 15 min, refresh via httpOnly \`ach_rt\` cookie |
| \`adminBearerAuth\` | staff | \`POST /v1/admin/auth/2fa/verify\` | 10 min |

A customer token is rejected on every \`/v1/admin\` route. Admin routes additionally require a
\`module:action\` permission resolved from the staff member's role.

**Common error codes.** \`401\` unauthenticated · \`403\` forbidden (valid token, wrong role) ·
\`404\` not_found · \`409\` conflict / already_exists · \`422\` validation_failed or unprocessable ·
\`429\` rate_limited · \`500\` internal_error.

`;

  const parts: string[] = [preamble];

  for (const surface of ['storefront', 'admin'] as const) {
    const file = resolve(ROOT, `openapi/openapi.${surface}.json`);
    if (!existsSync(file)) {
      parts.push(`## ${surface}\n\n_Spec not found — run \`npm run openapi:generate\`._\n`);
      continue;
    }
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      paths: Record<string, Record<string, Operation>>;
    };

    const byTag = new Map<string, { method: string; path: string; op: Operation }[]>();
    let count = 0;
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const tag = op.tags?.[0] ?? 'Untagged';
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag)!.push({ method, path, op });
        count++;
      }
    }

    parts.push(
      `\n---\n\n# ${surface === 'storefront' ? 'Storefront surface' : 'Admin surface'}\n`,
      `**${count} operations** · Swagger UI at \`/docs/${surface}\`${surface === 'admin' ? ' (gated — requires a staff token with `settings:view`)' : ''}\n`,
    );

    // Index first, so the doc is navigable.
    parts.push('| Group | Operations |', '|---|---|');
    for (const tag of [...byTag.keys()].sort()) parts.push(`| ${tag} | ${byTag.get(tag)!.length} |`);
    parts.push('');

    for (const tag of [...byTag.keys()].sort()) {
      parts.push(`\n## ${tag}\n`);
      const ops = byTag.get(tag)!.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
      for (const { method, path, op } of ops) parts.push(...renderOperation(method, path, op));
    }
  }

  return parts.join('\n');
}

/* -------------------------------------------------------------- database */

type Table = {
  name: string;
  columns: { name: string; type: string; notes: string }[];
  constraints: string[];
  indexes: string[];
};

/** Split a CREATE TABLE body on top-level commas (parens nest in types and CHECKs). */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const TABLE_CONSTRAINT = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT|EXCLUDE)\b/i;

/**
 * Strip `-- …` line comments before any structural parsing.
 *
 * A comment carries no comma, so `splitTopLevel` merges it into the NEXT column
 * definition and the column's name becomes the tail of the comment. Quote-aware,
 * because a `--` inside a string literal (a CHECK regex, a default) is data.
 */
function stripLineComments(sql: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"') inDouble = !inDouble;
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Everything up to the first modifier keyword is the type; the rest is constraints. */
const TYPE_STOP = /\s+(?:NOT\s+NULL|NULL|DEFAULT|REFERENCES|CHECK|UNIQUE|PRIMARY\s+KEY|GENERATED|COLLATE|CONSTRAINT|DEFERRABLE)\b/i;

function extractType(rest: string): string {
  const stop = TYPE_STOP.exec(rest);
  const head = (stop ? rest.slice(0, stop.index) : rest).trim();
  // A bare type may still carry a precision or array suffix: NUMERIC(10,2), TEXT[].
  const m = /^([A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z]+)?(?:\([^)]*\))?(?:\[\])?)/.exec(head);
  return (m?.[1] ?? head).trim();
}

function parseTables(rawSql: string): Table[] {
  const sql = stripLineComments(rawSql);
  const tables: Table[] = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(sql)) !== null) {
    const name = m[1]!;
    // Walk to the matching close paren.
    let i = re.lastIndex;
    let depth = 1;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    const body = sql.slice(re.lastIndex, i - 1);

    const table: Table = { name, columns: [], constraints: [], indexes: [] };
    for (const raw of splitTopLevel(body)) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line || line.startsWith('--')) continue;
      if (TABLE_CONSTRAINT.test(line)) {
        table.constraints.push(line);
        continue;
      }
      const cm = /^"?([a-z_][a-z0-9_]*)"?\s+(.+)$/i.exec(line);
      if (!cm) continue;
      const rest = cm[2]!;
      const type = extractType(rest);
      const notes: string[] = [];
      if (/\bPRIMARY\s+KEY\b/i.test(rest)) notes.push('PK');
      if (/\bNOT\s+NULL\b/i.test(rest)) notes.push('NOT NULL');
      if (/\bUNIQUE\b/i.test(rest)) notes.push('UNIQUE');
      const dm = /\bDEFAULT\s+([^,]+?)(?=\s+(?:NOT|REFERENCES|CHECK|UNIQUE|GENERATED)\b|$)/i.exec(rest);
      if (dm) notes.push(`default ${dm[1]!.trim()}`);
      const rm = /\bREFERENCES\s+([a-z_][a-z0-9_]*)\s*(?:\(([^)]*)\))?/i.exec(rest);
      if (rm) {
        const od = /\bON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i.exec(rest);
        notes.push(`→ \`${rm[1]}\`${od ? ` (ON DELETE ${od[1]!.toUpperCase()})` : ''}`);
      }
      if (/\bGENERATED\s+ALWAYS\b/i.test(rest)) notes.push('GENERATED');
      table.columns.push({ name: cm[1]!, type, notes: notes.join(' · ') });
    }
    tables.push(table);
  }

  // Attach indexes declared outside the table body.
  const ire = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)\s+ON\s+([a-z_][a-z0-9_]*)([^;]*);/gi;
  let im: RegExpExecArray | null;
  while ((im = ire.exec(sql)) !== null) {
    const t = tables.find((x) => x.name === im![3]);
    if (t) t.indexes.push(`${im[1] ? 'UNIQUE ' : ''}\`${im[2]}\`${im[4]!.replace(/\s+/g, ' ').trim()}`);
  }

  return tables;
}

const DOMAIN_OF: Record<string, string[]> = {
  'Identity & staff': ['roles', 'role_permissions', 'staff_users', 'staff_user_warehouses', 'staff_sessions', 'api_keys', 'otp_challenges'],
  'Customers': ['customers', 'customer_stats', 'addresses', 'recipients', 'customer_segments', 'customer_segment_members', 'wishlist_items', 'customer_sessions'],
  'Catalogue': ['designers', 'collections', 'products', 'product_variants', 'product_collections', 'product_media', 'product_content_items', 'product_stats', 'hamper_items', 'product_bom_lines', 'add_ons', 'product_add_ons', 'personalisation_templates', 'product_personalisation_templates', 'builder_templates', 'builder_template_steps', 'builder_step_options', 'reviews'],
  'Tax reference': ['gst_states', 'hsn_codes', 'gst_rates', 'document_number_series'],
  'Inventory & procurement': ['warehouses', 'inventory_levels', 'inventory_reservations', 'stock_movements', 'suppliers', 'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'stock_transfers', 'stock_transfer_lines'],
  'Cart & orders': ['carts', 'cart_lines', 'cart_line_add_ons', 'orders', 'order_lines', 'order_line_add_ons', 'order_line_personalisations', 'order_timeline', 'returns', 'return_lines', 'exchanges'],
  'Payments & invoicing': ['gift_cards', 'payments', 'payment_events', 'refunds', 'invoices', 'invoice_lines', 'credit_notes', 'credit_note_lines', 'gift_card_transactions'],
  'Corporate gifting': ['corporate_accounts', 'corporate_leads', 'corporate_account_contacts', 'quotations', 'quotation_lines', 'corporate_campaigns', 'campaign_recipients', 'approvals'],
  'Delivery & fulfilment': ['delivery_zones', 'delivery_zone_pincodes', 'couriers', 'courier_performance_daily', 'shipping_rules', 'shipments', 'shipment_lines', 'shipment_events', 'delivery_exceptions', 'packaging_materials'],
  'Promotions & loyalty': ['coupons', 'coupon_scope', 'coupon_redemptions', 'auto_discounts', 'bundles', 'bundle_items', 'upsell_rules', 'loyalty_tiers', 'loyalty_accounts', 'loyalty_transactions', 'referrals', 'referral_conversions'],
  'Content & CMS': ['media_assets', 'cms_sections', 'cms_section_items', 'banners', 'banner_stats_daily', 'content_pages', 'seo_entries', 'blog_posts', 'faqs', 'testimonials', 'menus', 'menu_items'],
  'Platform': ['activity_logs', 'notifications', 'integrations', 'webhooks', 'webhook_deliveries', 'import_jobs', 'import_job_errors', 'app_settings'],
};

function buildDatabaseDoc(tables: Table[]): string {
  const parts: string[] = [];
  const placed = new Set<string>();

  parts.push(`# Achichiz Database Reference

> **Generated** from \`src/db/migrations/*.sql\`, which is the authoritative DDL.
> Regenerate with \`npm run docs:generate\` — do not hand-edit.

**${tables.length} tables.** Names are as they exist in PostgreSQL (\`snake_case\`, plural); Drizzle
maps them to \`camelCase\` at the schema boundary, which is the single translation point in the codebase.

## How money and tax are stored

- **Money is \`BIGINT\` paise**, never \`NUMERIC\` and never a float. Paise fit safely inside
  \`Number.MAX_SAFE_INTEGER\` (₹90,071,992,547), and \`node-postgres\` is configured to parse
  \`INT8\` to a JS number with an explicit safe-integer check.
- **Percentages are integer basis points** (250 = 2.5%), so fractional slabs are expressible.
- **Catalogue prices are GST-inclusive.** Tax is back-computed per line at that line's HSN rate;
  \`taxable\` is derived first and \`tax\` taken as the remainder, so \`taxable + tax = gross\` holds
  by construction rather than by reconciliation.
- **Place of supply** follows s.10(1)(a) for B2C and s.10(1)(b) bill-to/ship-to for corporate
  campaigns, so a 400-recipient campaign gets one tax treatment rather than 400.
- **Document numbers** (invoices, credit notes) come from \`document_number_series\` under a row
  lock — gapless per financial year, as Rule 46(b) requires. Order numbers use a plain sequence,
  where gaps are acceptable.

## Objects Drizzle does not model

The TypeScript schema is not the whole picture. These live only in the SQL migration:

| Object | Why it matters |
|---|---|
| \`check_order_totals()\` — DEFERRABLE constraint trigger | Validates order totals against the sum of lines **at commit**. The single most important invariant in the schema, and completely invisible from the TS side. |
| \`split_inclusive_tax()\` | Splits a GST-inclusive amount; absorbs the odd paisa into taxable value so \`cgst = sgst\` stays true. |
| Domains (\`mobile_in\`, \`gstin\`, \`pincode\`, \`hsn\`, …) | Format checks enforced by the database, invisible to TypeScript. |
| \`CITEXT\` columns | Case-insensitive comparison in the DB; declared as \`text()\` in Drizzle. |
| \`EXCLUDE USING gist\` on \`gst_rates\` | Prevents overlapping rate periods for the same HSN. |
| Generated columns | \`inventory_levels.available_qty\`, \`staff_users.avatar_initials\`. |
| Partial unique indexes \`WHERE deleted_at IS NULL\` | Soft-deleted rows must not squat on a handle forever. |
| \`set_updated_at()\` triggers | On every table carrying \`updated_at\`. |

---
`);

  for (const [domain, names] of Object.entries(DOMAIN_OF)) {
    const inDomain = names.map((n) => tables.find((t) => t.name === n)).filter((t): t is Table => Boolean(t));
    if (inDomain.length === 0) continue;
    parts.push(`\n## ${domain}\n`, `${inDomain.length} tables\n`);
    for (const t of inDomain) {
      placed.add(t.name);
      parts.push(...renderTable(t));
    }
  }

  const orphans = tables.filter((t) => !placed.has(t.name));
  if (orphans.length > 0) {
    parts.push(`\n## Other\n`, `Tables present in the DDL but not mapped to a domain group above.\n`);
    for (const t of orphans) parts.push(...renderTable(t));
  }

  return parts.join('\n');
}

function renderTable(t: Table): string[] {
  const out: string[] = [`\n### \`${t.name}\`\n`];
  out.push('| Column | Type | Notes |', '|---|---|---|');
  for (const c of t.columns) out.push(`| \`${c.name}\` | \`${c.type}\` | ${c.notes} |`);
  out.push('');
  if (t.constraints.length > 0) {
    out.push('<details><summary>Table constraints</summary>', '');
    for (const c of t.constraints) out.push(`- \`${c}\``);
    out.push('', '</details>', '');
  }
  if (t.indexes.length > 0) {
    out.push('<details><summary>Indexes</summary>', '');
    for (const i of t.indexes) out.push(`- ${i}`);
    out.push('', '</details>', '');
  }
  return out;
}

/* ------------------------------------------------------------------ main */

function main(): void {
  mkdirSync(DOCS, { recursive: true });

  const api = buildApiReference();
  writeFileSync(resolve(DOCS, 'API-REFERENCE.md'), api, 'utf8');
  console.log(`docs/API-REFERENCE.md   ${api.split('\n').length} lines`);

  let sql = '';
  for (const f of ['0001_initial.sql', '0002_search.sql']) {
    const p = resolve(ROOT, 'src/db/migrations', f);
    if (existsSync(p)) sql += `\n${readFileSync(p, 'utf8')}`;
  }
  const tables = parseTables(sql);
  const db = buildDatabaseDoc(tables);
  writeFileSync(resolve(DOCS, 'DATABASE.md'), db, 'utf8');
  console.log(`docs/DATABASE.md        ${db.split('\n').length} lines · ${tables.length} tables`);

  process.exit(0);
}

main();
