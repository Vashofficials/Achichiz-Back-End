/**
 * Leave the catalogue holding the workbook's products and nothing else.
 *
 * Three kinds of row are removed, and the distinction matters:
 *
 *  1. TEST ARTIFACTS — `api-demo-product`, `api-demo-collection`,
 *     `demo-sustainable-gifts`. Never real.
 *
 *  2. DUPLICATES of workbook products under a different spelling. An earlier
 *     seed created `bird-jhumka`; the workbook calls the same thing
 *     `bird_shaped_jhumka`, so both existed. The workbook spelling is kept and
 *     verified FIRST to carry the same price, so nothing is lost by dropping
 *     the other.
 *
 *  3. PRODUCTS ABSENT FROM THE WORKBOOK entirely — `cork-laptop-sleeve`.
 *
 * Removal is `deleteRow` through the admin service, i.e. the same soft delete
 * the Admin Panel's delete button performs. Rows keep their history and can be
 * restored by clearing `deleted_at`; nothing is destroyed.
 *
 * COLLECTIONS ARE KEPT. The site's navigation needs Bamboo Drinkware, Eco
 * Stationery, Necklaces and Earrings, and the workbook does not describe that
 * sub-structure — its column B names one sub-category. Per the instruction to
 * reuse existing data where the sheet is silent, they stay, and are repopulated
 * FROM WORKBOOK PRODUCTS so they stop being near-empty: `drinkware` held two
 * products because an earlier seed linked only its own.
 */

import { RESOURCES } from '../src/modules/admin-resources/resource.registry.js';
import * as svc from '../src/modules/admin-resources/admin-resources.service.js';
import { db, closeDb } from './lib.js';

const productsRes = RESOURCES.find((r) => r.slug === 'products')!;
const collectionsRes = RESOURCES.find((r) => r.slug === 'collections')!;

/* -------------------------------------------------------------- removals */

/** Workbook spelling → the duplicate an earlier seed created. */
const DUPLICATES: Record<string, string> = {
  'bird-shaped-jhumka': 'bird-jhumka',
  'circular-bead-necklace-set-set-and-golden': 'circular-bead-necklace-set-red-golden',
  'kathakali-theme-pendant-black-base': 'kathakali-pendant-necklace-black-base',
  'premium-bamboo-pen-with-box': 'premium-bamboo-pen-with-gift-box',
};

const TEST_ARTIFACT_PRODUCTS = ['api-demo-product'];
const NOT_IN_WORKBOOK = ['cork-laptop-sleeve'];
const TEST_ARTIFACT_COLLECTIONS = ['api-demo-collection', 'demo-sustainable-gifts'];

let removed = 0;
const skipped: string[] = [];

async function removeProduct(handle: string, why: string): Promise<void> {
  const { rows } = await db().query<{ id: string }>(
    'select id from products where handle = $1 and deleted_at is null limit 1',
    [handle],
  );
  if (!rows[0]) {
    skipped.push(`${handle} (already gone)`);
    return;
  }
  await svc.deleteRow(productsRes, rows[0].id);
  removed++;
  console.log(`  removed  ${handle.padEnd(44)} ${why}`);
}

console.log('--- duplicates of workbook products ---');
for (const [keep, drop] of Object.entries(DUPLICATES)) {
  // Refuse to drop the duplicate unless the workbook spelling really is there
  // and priced. Otherwise this would delete the only copy.
  const { rows } = await db().query<{ n: number }>(
    `select count(v.id)::int n from products p
       join product_variants v on v.product_id = p.id and v.deleted_at is null
      where p.handle = $1 and p.deleted_at is null`,
    [keep],
  );
  if (!rows[0]?.n) {
    skipped.push(`${drop} (kept — workbook version '${keep}' has no priced variant)`);
    continue;
  }
  await removeProduct(drop, `→ kept as '${keep}'`);
}

console.log('\n--- test artifacts ---');
for (const h of TEST_ARTIFACT_PRODUCTS) await removeProduct(h, 'test artifact');

console.log('\n--- not in the workbook ---');
for (const h of NOT_IN_WORKBOOK) await removeProduct(h, 'absent from the sheet');

console.log('\n--- demo collections ---');
for (const h of TEST_ARTIFACT_COLLECTIONS) {
  const { rows } = await db().query<{ id: string }>(
    'select id from collections where handle = $1 and deleted_at is null limit 1',
    [h],
  );
  if (!rows[0]) {
    skipped.push(`${h} (already gone)`);
    continue;
  }
  await svc.deleteRow(collectionsRes, rows[0].id);
  removed++;
  console.log(`  removed  ${h}`);
}

/* ------------------------------------------- repopulate the sub-collections */

/*
 * Keyword → collection, applied to the WORKBOOK's own product names. The
 * sub-structure is the site's, the membership is the sheet's.
 */
const RULES: { handle: string; match: RegExp }[] = [
  { handle: 'drinkware', match: /bottle|tumbler|mug/i },
  { handle: 'eco-stationery', match: /diary|pen\b|card ?holder/i },
  { handle: 'necklaces', match: /necklace|pendant|choker|set\b/i },
  { handle: 'earrings', match: /earring|jhumka|dangler|hoop/i },
];

console.log('\n--- repopulate site sub-collections from workbook products ---');
for (const rule of RULES) {
  const { rows: col } = await db().query<{ id: string }>(
    'select id from collections where handle = $1 and deleted_at is null limit 1',
    [rule.handle],
  );
  if (!col[0]) {
    console.log(`  skip     ${rule.handle} (no such collection)`);
    continue;
  }
  const { rows: prods } = await db().query<{ id: string; title: string }>(
    `select id, title from products where deleted_at is null and status = 'active'`,
  );
  const wanted = prods.filter((p) => rule.match.test(p.title));
  let linked = 0;
  for (const p of wanted) {
    const res = await db().query(
      'insert into product_collections (product_id, collection_id) values ($1,$2) on conflict do nothing',
      [p.id, col[0].id],
    );
    linked += res.rowCount ?? 0;
  }
  console.log(`  ${rule.handle.padEnd(16)} ${String(wanted.length).padStart(3)} products (${linked} newly linked)`);
}

/* ---------------------------------------------------------------- report */

console.log(`\nremoved ${removed} row(s)`);
if (skipped.length) {
  console.log('skipped:');
  for (const s of skipped) console.log('  ' + s);
}

const live = await db().query<{ n: number }>(
  `select count(*)::int n from products
    where status='active' and deleted_at is null and published_at <= now()`,
);
const drafts = await db().query<{ n: number }>(
  `select count(*)::int n from products where status='draft' and deleted_at is null`,
);
const cols = await db().query<{ n: number }>(
  'select count(*)::int n from collections where deleted_at is null',
);
console.log(`\nlive products : ${live.rows[0]!.n}`);
console.log(`draft (unpriced): ${drafts.rows[0]!.n}`);
console.log(`collections   : ${cols.rows[0]!.n}`);

await closeDb();
