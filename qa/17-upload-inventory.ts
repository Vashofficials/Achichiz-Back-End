/**
 * Upload the WEBSITE INVENTORY workbook into the catalogue.
 *
 * The workbook is the authority for what exists and how it is described:
 * category, product name, short description, long description, delivery time.
 * It has NO price column, so prices are joined from the front-end's own
 * catalogue (`Fron-End/src/data/catalog.ts`), which is where the numbers shown
 * on the live site actually come from.
 *
 * WHAT HAPPENS WHEN A PRICE CANNOT BE FOUND: the product is created as `draft`
 * with no variant, and listed at the end for someone to price. It is never
 * given a guessed price. A wrong number on a live shop is worse than a missing
 * product, and a draft is invisible to shoppers but fully visible in the Admin
 * Panel, which is exactly where the decision belongs.
 *
 * Written through admin-resources.service, so every row passes the same
 * validation, CHECK constraints and audit path an operator's create would.
 * Idempotent by handle: re-running updates rather than duplicating.
 *
 * IMAGES are not attached. `products` has no image column — media lives in
 * `media_assets`/`product_media` behind an upload pipeline, and the files in
 * `Fron-End/src/assets` are 29 generic category shots, not 54 product
 * photographs. Inventing that mapping would attach the wrong picture to most of
 * the catalogue. Flagged as follow-up rather than guessed.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RESOURCES } from '../src/modules/admin-resources/resource.registry.js';
import * as svc from '../src/modules/admin-resources/admin-resources.service.js';
import { db, closeDb } from './lib.js';

const WORKBOOK = 'C:/Users/terab/Downloads/WEBSITE INVENTORY .xlsx';
const FE_CATALOG = 'C:/Achichiz/Website 2.0/Fron-End/src/data/catalog.ts';

/* ------------------------------------------------------- read the workbook */

/** xlsx is a zip of XML; unpacked with the system unzip so no dependency is added. */
function readWorkbook(): Record<string, string>[] {
  const dir = `${process.env.TEMP}/achichiz-xlsx`;
  /*
   * ZipFile.ExtractToDirectory, not Expand-Archive: the latter refuses anything
   * not named `.zip` ("xlsx is not a supported archive file format"), even
   * though an xlsx IS a zip. This reads the container by its contents.
   */
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Remove-Item -Recurse -Force '${dir}' -ErrorAction SilentlyContinue; ` +
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${WORKBOOK}', '${dir}')`,
  ]);

  const decode = (s: string): string =>
    s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  const shared = [...readFileSync(`${dir}/xl/sharedStrings.xml`, 'utf8').matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
    decode([...m[1]!.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]).join('')),
  );

  const sheet = readFileSync(`${dir}/xl/worksheets/sheet1.xml`, 'utf8');
  const rows: Record<string, string>[] = [];
  for (const [, rn, body] of sheet.matchAll(/<row[^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
    const row: Record<string, string> = { _r: rn! };
    for (const c of body!.matchAll(
      /<c r="([A-Z]+)\d+"(?:[^>]*?t="([^"]*)")?[^>]*>(?:<v>(.*?)<\/v>|<is><t[^>]*>(.*?)<\/t><\/is>)?<\/c>/gs,
    )) {
      const [, col, ty, v, inline] = c;
      const val = inline !== undefined ? decode(inline) : ty === 's' ? shared[Number(v)] : v;
      if (val !== undefined && String(val).trim()) row[col!] = String(val).trim();
    }
    if (Object.keys(row).length > 1) rows.push(row);
  }
  return rows;
}

/* ------------------------------------------- prices from the front-end seed */

type Priced = { title: string; price: number; compareAt: number; qty: number };

function readFrontEndPrices(): Priced[] {
  const out: Priced[] = [];
  for (const line of readFileSync(FE_CATALOG, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('["')) continue;
    const title = /^\["([^"]+)"/.exec(t)?.[1];
    const nums = /",\s*(\d+),\s*(\d+),/.exec(t);
    const qty = /,\s*(\d+),\s*"[a-z]*"\s*\]/.exec(t)?.[1];
    if (title && nums) out.push({ title, price: Number(nums[1]), compareAt: Number(nums[2]), qty: Number(qty ?? 0) });
  }
  return out;
}

/* -------------------------------------------------------------- matching */

/**
 * The workbook and the front-end spell the same products differently —
 * `pendent`/`pendant`, `tringular`/`triangular`, `desing`/`design`. Those are
 * typos in the source data, not different products, so they are normalised
 * rather than left to fail.
 */
const fix = (s: string): string =>
  s
    .toLowerCase()
    .replace(/pendent/g, 'pendant')
    .replace(/tringular/g, 'triangular')
    .replace(/desing/g, 'design')
    .replace(/keychchain/g, 'keychain')
    .replace(/kathakkali/g, 'kathakali')
    .replace(/\bn\b/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const STOP = new Set(['and', 'the', 'with', 'set']);
const tokens = (s: string): Set<string> =>
  new Set(fix(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));

/** Token overlap, 0..1. 0.6 was chosen by inspecting the misses it still leaves. */
function similarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(A.size, B.size);
}

const slug = (s: string): string =>
  fix(s).replace(/\s+/g, '-').replace(/^-|-$/g, '').slice(0, 100);

const skuOf = (title: string): string =>
  ('ACH-' + fix(title).split(' ').map((w) => w.slice(0, 3).toUpperCase()).join('-')).slice(0, 60);

/* --------------------------------------------------------------- helpers */

const descriptor = (s: string) => {
  const d = RESOURCES.find((r) => r.slug === s);
  if (!d) throw new Error(`resource '${s}' is not registered`);
  return d;
};

let created = 0;
let updated = 0;
const failures: string[] = [];

async function upsert(slugName: string, table: string, keyCol: string, key: string, body: Record<string, unknown>): Promise<string | null> {
  const d = descriptor(slugName);
  try {
    const { rows } = await db().query<{ id: string }>(
      `select id from ${table} where ${keyCol} = $1 and deleted_at is null limit 1`,
      [key],
    );
    if (rows[0]) {
      await svc.updateRow(d, rows[0].id, body);
      updated++;
      return rows[0].id;
    }
    const row = (await svc.createRow(d, { [keyCol === 'handle' ? 'handle' : keyCol]: key, ...body })) as { id: string };
    created++;
    return row.id;
  } catch (err) {
    failures.push(`${slugName} '${key}': ${(err as Error).message.slice(0, 120)}`);
    return null;
  }
}

/* ------------------------------------------------------------------ main */

const sheet = readWorkbook();
const prices = readFrontEndPrices();

/** Category rows carry column A; product rows carry column C beneath them. */
type Item = { category: string; name: string; short?: string; long?: string; delivery?: string };
const items: Item[] = [];
let currentCategory = '';
for (const row of sheet) {
  if (row['_r'] === '1') continue;
  if (row['A']) currentCategory = row['A'];
  if (row['C']) {
    const it: Item = { category: currentCategory, name: row['C'] };
    if (row['E']) it.short = row['E'];
    if (row['F']) it.long = row['F'];
    if (row['G']) it.delivery = row['G'];
    items.push(it);
  }
}

console.log(`workbook: ${items.length} products across ${new Set(items.map((i) => i.category)).size} categories`);

/* collections */
console.log('\n--- collections ---');
const collectionIds = new Map<string, string>();
for (const name of new Set(items.map((i) => i.category))) {
  const title = name.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/Collection/i, 'Collection');
  const id = await upsert('collections', 'collections', 'handle', slug(name), {
    kind: 'category',
    title,
    heading: title,
    status: 'live',
  });
  if (id) collectionIds.set(name, id);
  console.log(`  ${id ? 'ok  ' : 'FAIL'} ${slug(name)}`);
}

/* products */
console.log('\n--- products ---');
const unpriced: string[] = [];
let priced = 0;

for (const item of items) {
  const exact = prices.find((p) => fix(p.title) === fix(item.name));
  let match = exact ?? null;
  if (!match) {
    let best: Priced | null = null;
    let bestScore = 0;
    for (const p of prices) {
      const s = similarity(item.name, p.title);
      if (s > bestScore) {
        bestScore = s;
        best = p;
      }
    }
    if (best && bestScore >= 0.6) match = best;
  }

  const handle = slug(item.name);
  const body: Record<string, unknown> = {
    title: item.name.replace(/\b\w/g, (c) => c.toUpperCase()),
    kind: 'single_gift',
    ...(item.short ? { subtitle: item.short.slice(0, 300) } : {}),
    ...(item.long ? { description: item.long } : {}),
    ...(collectionIds.has(item.category) ? { primaryCollectionId: collectionIds.get(item.category) } : {}),
  };

  if (match) {
    // Priced: publishable.
    Object.assign(body, { status: 'active', hsnCode: '4602', publishedAt: new Date().toISOString() });
  } else {
    // No price anywhere. Draft, so it reaches the Admin Panel and not the shop.
    Object.assign(body, { status: 'draft' });
    unpriced.push(item.name);
  }

  const productId = await upsert('products', 'products', 'handle', handle, body);
  if (!productId) continue;

  if (match) {
    priced++;
    await upsert('product-variants', 'product_variants', 'sku', skuOf(item.name), {
      productId,
      optionLabel: 'Size',
      optionValue: 'standard',
      pricePaise: match.price * 100,
      ...(match.compareAt > 0 ? { compareAtPaise: match.compareAt * 100 } : {}),
      status: 'active',
      isDefault: true,
    });
  }

  const cid = collectionIds.get(item.category);
  if (cid) {
    await db()
      .query(`insert into product_collections (product_id, collection_id) values ($1,$2) on conflict do nothing`, [productId, cid])
      .catch(() => undefined);
  }
}

console.log(`  priced & active : ${priced}`);
console.log(`  draft (no price): ${unpriced.length}`);

/* stock for everything active that has none */
const [warehouse] = (
  await db().query<{ id: string; code: string }>(
    `select id, code from warehouses where deleted_at is null and status='active' order by created_at limit 1`,
  )
).rows;

if (warehouse) {
  const res = await db().query(
    `insert into inventory_levels (variant_id, warehouse_id, on_hand_qty, reserved_qty, reorder_point, reorder_qty)
     select v.id, $1, 25, 0, 5, 20 from product_variants v
       join products p on p.id = v.product_id
      where v.deleted_at is null and p.deleted_at is null and p.status='active'
        and not exists (select 1 from inventory_levels il where il.variant_id=v.id and il.warehouse_id=$1)`,
    [warehouse.id],
  );
  console.log(`\n--- inventory ---\n  stocked ${res.rowCount ?? 0} new variant(s) at ${warehouse.code}`);
}

/* ---------------------------------------------------------------- report */

console.log(`\ncreated ${created} · updated ${updated} · failed ${failures.length}`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures.slice(0, 15)) console.log('  ' + f);
}
if (unpriced.length) {
  console.log('\nNEEDS A PRICE — created as draft, invisible to shoppers, editable in the Admin Panel:');
  for (const u of unpriced) console.log('  ' + u);
}

const live = await db().query(
  `select count(*)::int n from products where status='active' and deleted_at is null and published_at <= now()`,
);
console.log(`\nlive products now: ${live.rows[0].n}`);

await closeDb();
