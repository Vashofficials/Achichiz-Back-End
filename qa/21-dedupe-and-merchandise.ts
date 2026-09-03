/**
 * Two live commercial faults: the same product listed twice at different
 * prices, and ten linked collections that do not exist.
 *
 * ── 1. DUPLICATE LISTINGS ──────────────────────────────────────────────────
 *
 * Eighteen products are listed TWICE, once under the workbook's spelling and
 * once under the corrected one, at prices that differ by up to fifteen times:
 *
 *     cork-keychchain                        Rs 1561
 *     cork-keychain                          Rs   99
 *
 *     circle-pendent-necklace-pink-and-black Rs 2957
 *     circle-pendant-necklace-pink-and-black Rs  549
 *
 * A shopper could buy the same necklace for Rs 549 or Rs 2957 depending on
 * which listing they landed on.
 *
 * The prices are not merely inconsistent, they are FABRICATED. The workbook has
 * no price column at all, so `17-upload-inventory.ts` fuzzy-matched prices from
 * the front-end catalogue at a 0.6 similarity threshold, and where a match was
 * wrong nobody noticed. Every one of the high prices — 2849, 2504, 1561, 1630,
 * 2957, 1970, 2924 — appears in NO source file anywhere. Every one of the low
 * prices does.
 *
 * So the rule below is evidence, not a guess: THE SURVIVOR IS THE LISTING WHOSE
 * PRICE EXISTS IN THE FRONT-END CATALOGUE, which is the only place a human ever
 * wrote these numbers down. If neither price can be corroborated the pair is
 * skipped and reported, never resolved by picking the cheaper one.
 *
 * The workbook's descriptions are the good half of the duplicate — the sheet
 * has real copy the correctly-spelled row often lacks — so they are COPIED
 * ACROSS before the duplicate is retired. Retiring is `deleteRow` through the
 * admin service: the same soft delete the Admin Panel performs, reversible by
 * clearing `deleted_at`.
 *
 * ── 2. MISSING COLLECTIONS ─────────────────────────────────────────────────
 *
 * The homepage, footer, hero slider, cart drawer and checkout link to ten
 * collections that were never created — every link a 404. They are created here
 * AND POPULATED from the existing catalogue, because a category page with
 * nothing in it reads as a broken shop rather than a working one.
 *
 * Set DRY_RUN=1 to print the plan and change nothing.
 */

import { readFileSync } from 'node:fs';
import { RESOURCES } from '../src/modules/admin-resources/resource.registry.js';
import * as svc from '../src/modules/admin-resources/admin-resources.service.js';
import { db, closeDb } from './lib.js';

const DRY = process.env.DRY_RUN === '1';
const productsRes = RESOURCES.find((r) => r.slug === 'products')!;
const collectionsRes = RESOURCES.find((r) => r.slug === 'collections')!;

const FE_CATALOG = 'C:/Achichiz/Website 2.0/Fron-End/src/data/catalog.ts';

if (DRY) console.log('*** DRY RUN — nothing will be written ***\n');

/* ------------------------------ the only place prices were written by hand */

/**
 * Every price that appears in the front-end catalogue seed.
 *
 * Used only to ADJUDICATE between two existing rows — never to set a price. A
 * number that is not in here was not written by a person.
 */
function knownGoodPrices(): Set<number> {
  const out = new Set<number>();
  for (const line of readFileSync(FE_CATALOG, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('["')) continue;
    const nums = /",\s*(\d+),\s*(\d+),/.exec(t);
    if (nums) out.add(Number(nums[1]));
  }
  return out;
}

const GOOD = knownGoodPrices();
console.log(`${GOOD.size} corroborated prices found in the front-end catalogue`);

/* ------------------------------------------------------ 1. deduplicate */

type Row = {
  id: string;
  handle: string;
  title: string;
  price: number;
  subtitle: string | null;
  description: string | null;
};

const { rows } = await db().query<Row>(
  `select p.id, p.handle, p.title, p.subtitle, p.description,
          coalesce(max(v.price_paise), 0) / 100 as price
     from products p
     left join product_variants v on v.product_id = p.id and v.deleted_at is null
    where p.deleted_at is null
    group by p.id, p.handle, p.title, p.subtitle, p.description`,
);

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/pendent/g, 'pendant')
    .replace(/tringular/g, 'triangular')
    .replace(/desing/g, 'design')
    .replace(/keychchain/g, 'keychain')
    .replace(/\bn\b/g, 'and')
    .replace(/[^a-z0-9]/g, '');

const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = norm(r.title);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}

console.log('\n--- duplicate listings ---');
let retired = 0;
const unresolved: string[] = [];

for (const [, pair] of groups) {
  if (pair.length < 2) continue;

  const corroborated = pair.filter((p) => p.price > 0 && GOOD.has(p.price));

  if (corroborated.length !== 1) {
    // Either both prices look real or neither does. Not something to guess at
    // with live money, so it is reported for a human instead.
    unresolved.push(pair.map((p) => `${p.handle} (Rs${p.price})`).join('  vs  '));
    continue;
  }

  const keep = corroborated[0]!;
  const drop = pair.filter((p) => p.id !== keep.id);

  for (const d of drop) {
    // The workbook row carries the sheet's real copy; don't lose it.
    const patch: Record<string, unknown> = {};
    if (!keep.subtitle && d.subtitle) patch.subtitle = d.subtitle;
    if (!keep.description && d.description) patch.description = d.description;

    console.log(`  keep  ${keep.handle}  Rs${keep.price}`);
    console.log(
      `  drop  ${d.handle}  Rs${d.price}${Object.keys(patch).length ? '   (copying its description across)' : ''}`,
    );

    if (!DRY) {
      if (Object.keys(patch).length > 0) await svc.updateRow(productsRes, keep.id, patch);
      await svc.deleteRow(productsRes, d.id);
    }
    retired++;
  }
}

console.log(`\n  retired ${retired} duplicate listing(s)`);
if (unresolved.length) {
  console.log('\n  NEEDS A HUMAN — neither price could be corroborated, both left live:');
  for (const u of unresolved) console.log('    ' + u);
}

/* --------------------------------------------- 2. the missing collections */

type Spec = {
  handle: string;
  title: string;
  kind: string;
  heading: string;
  subtext: string;
  match: RegExp;
};

/*
 * Membership is by rule against the REAL catalogue, so each of these pages
 * opens with stock in it. The rules are deliberately broad — a gift category
 * that shows six things is still a working page; one that shows none is not.
 */
const SPECS: Spec[] = [
  {
    handle: 'for-her',
    title: 'For Her',
    kind: 'recipient',
    heading: 'Gifts for her',
    subtext: 'Handcrafted jewellery and natural candles.',
    match: /necklace|pendant|pendent|jhumka|earring|dangler|choker|candle|set\b/i,
  },
  {
    handle: 'for-him',
    title: 'For Him',
    kind: 'recipient',
    heading: 'Gifts for him',
    subtext: 'Bamboo and cork essentials for desk and travel.',
    match: /bottle|tumbler|mug|diary|pen\b|keychain|card ?holder/i,
  },
  {
    handle: 'for-parents',
    title: 'For Parents',
    kind: 'recipient',
    heading: 'Gifts for parents',
    subtext: 'Warm, useful and made to last.',
    match: /candle|mug|diary|tumbler|bottle|sachet/i,
  },
  {
    handle: 'corporate-connection',
    title: 'Corporate Connection',
    kind: 'edit',
    heading: 'Corporate gifting',
    subtext: 'Brandable, bulk-ready and plastic-free.',
    match: /bottle|tumbler|mug|diary|pen\b|keychain|card ?holder/i,
  },
  {
    handle: 'wedding-gifting',
    title: 'Wedding Gifting',
    kind: 'occasion',
    heading: 'Wedding gifting',
    subtext: 'Keepsakes for the couple and the party.',
    match: /candle|necklace|pendant|pendent|set\b|temple/i,
  },
  {
    handle: 'birthday',
    title: 'Birthday',
    kind: 'occasion',
    heading: 'Birthday gifts',
    subtext: 'Something thoughtful, whatever the year.',
    match: /candle|mug|diary|keychain|jhumka|earring|dangler/i,
  },
  {
    handle: 'anniversary',
    title: 'Anniversary',
    kind: 'occasion',
    heading: 'Anniversary gifts',
    subtext: 'Marking the years with something made by hand.',
    match: /candle|necklace|pendant|pendent|choker|set\b/i,
  },
  {
    handle: 'festivals-diwali',
    title: 'Diwali',
    kind: 'festival',
    heading: 'Diwali gifting',
    subtext: 'Light, warmth and plastic-free packaging.',
    match: /candle|sachet|tea ?light|diya|necklace|pendant|pendent/i,
  },
  {
    handle: 'festivals-raksha-bandhan',
    title: 'Raksha Bandhan',
    kind: 'festival',
    heading: 'Raksha Bandhan',
    subtext: 'For the sibling who deserves more than a card.',
    match: /candle|keychain|diary|pen\b|mug|jhumka|earring/i,
  },
];

console.log('\n--- missing collections ---');

const { rows: live } = await db().query<{ id: string; title: string }>(
  `select id, title from products
    where deleted_at is null and status = 'active'
      and published_at is not null and published_at <= now()`,
);
console.log(`  ${live.length} live products to draw from`);

for (const s of SPECS) {
  const { rows: existing } = await db().query<{ id: string }>(
    'select id from collections where handle = $1 and deleted_at is null limit 1',
    [s.handle],
  );

  const members = live.filter((p) => s.match.test(p.title));
  if (members.length === 0) {
    // Creating an empty category page would swap a 404 for a dead end.
    console.log(`  SKIP  ${s.handle.padEnd(26)} nothing in the catalogue matches`);
    continue;
  }

  let id = existing[0]?.id;
  if (DRY) {
    console.log(
      `  ${existing[0] ? 'reuse' : 'create'} ${s.handle.padEnd(26)} ${String(members.length).padStart(3)} products`,
    );
    continue;
  }

  if (id) {
    await svc.updateRow(collectionsRes, id, { title: s.title, heading: s.heading, status: 'live' });
  } else {
    const row = (await svc.createRow(collectionsRes, {
      handle: s.handle,
      kind: s.kind,
      title: s.title,
      heading: s.heading,
      subtext: s.subtext,
      status: 'live',
    })) as { id: string };
    id = row.id;
  }

  let linked = 0;
  for (const p of members) {
    const res = await db().query(
      'insert into product_collections (product_id, collection_id) values ($1,$2) on conflict do nothing',
      [p.id, id],
    );
    linked += res.rowCount ?? 0;
  }
  console.log(
    `  ok    ${s.handle.padEnd(26)} ${String(members.length).padStart(3)} products (${linked} newly linked)`,
  );
}

/* ---------------------------------------------------------------- verify */

if (!DRY) {
  const { rows: after } = await db().query<{ prods: number; cols: number }>(
    `select (select count(*)::int from products
              where deleted_at is null and status='active' and published_at <= now()) as prods,
            (select count(*)::int from collections
              where deleted_at is null and status='live') as cols`,
  );
  console.log(`\nlive products    : ${after[0]!.prods}`);
  console.log(`live collections : ${after[0]!.cols}`);
}

await closeDb();
