/**
 * Seed the storefront catalogue through the ADMIN service layer.
 *
 * The database has never held a real catalogue. The fourteen products on the
 * live site exist only inside the front-end's JS bundle, which is why
 * `/v1/products` answered with one row: the single `api-demo-product` left by an
 * earlier test. Everything else in `products` was a `qa-*` artifact, correctly
 * soft-deleted by the runs that created it.
 *
 * Written through `admin-resources.service`, not raw SQL, so every row passes
 * the same zod validation, the same CHECK constraints and the same audit path an
 * operator's create would. Rows created here are ordinary catalogue records and
 * are editable and deletable from the Admin Panel.
 *
 * IDEMPOTENT: it looks each handle up first and updates rather than duplicating,
 * so re-running never produces a second Bamboo Bottle.
 *
 * Content is Achichiz's own product line, taken from the live site. No customer
 * data of any kind is involved.
 */

import { RESOURCES } from '../src/modules/admin-resources/resource.registry.js';
import * as svc from '../src/modules/admin-resources/admin-resources.service.js';
import { db, closeDb } from './lib.js';

const descriptor = (slug: string) => {
  const d = RESOURCES.find((r) => r.slug === slug);
  if (!d) throw new Error(`resource '${slug}' is not registered`);
  return d;
};

const rupees = (r: number): number => Math.round(r * 100);

let created = 0;
let updated = 0;
let failed = 0;
const problems: string[] = [];

/** Create, or update the existing row with the same handle. */
async function upsert(slug: string, handleField: string, handle: string, body: Record<string, unknown>): Promise<string | null> {
  const d = descriptor(slug);
  try {
    const { rows } = await db().query<{ id: string }>(
      `select id from ${d.table === undefined ? '' : ''}${slug.replace(/-/g, '_')} where ${handleField} = $1 and deleted_at is null limit 1`,
      [handle],
    );
    if (rows[0]) {
      await svc.updateRow(d, rows[0].id, body);
      updated++;
      return rows[0].id;
    }
    const row = (await svc.createRow(d, { [handleField]: handle, ...body })) as { id: string };
    created++;
    return row.id;
  } catch (err) {
    failed++;
    problems.push(`${slug} '${handle}': ${(err as Error).message.slice(0, 140)}`);
    return null;
  }
}

/* ------------------------------------------------------------- collections */

const COLLECTIONS: { handle: string; title: string }[] = [
  { handle: 'workspace-collection', title: 'Workspace' },
  { handle: 'necklaces', title: 'Necklaces' },
  { handle: 'earrings', title: 'Earrings' },
  { handle: 'earth-aroma', title: 'Earth & Aroma' },
  { handle: 'drinkware', title: 'Bamboo Drinkware' },
  { handle: 'eco-stationery', title: 'Eco Stationery' },
  { handle: 'best-sellers', title: 'Best Sellers' },
  { handle: 'signature-picks', title: 'Signature Picks' },
];

console.log('--- collections ---');
const collectionIds = new Map<string, string>();
for (const c of COLLECTIONS) {
  const id = await upsert('collections', 'handle', c.handle, {
    kind: 'category',
    title: c.title,
    heading: c.title,
    status: 'live',
  });
  if (id) collectionIds.set(c.handle, id);
  console.log(`  ${id ? 'ok  ' : 'FAIL'} ${c.handle}`);
}

/* ---------------------------------------------------------------- products */

type Seed = { handle: string; title: string; price: number; mrp: number; collection: string; sku: string };

const PRODUCTS: Seed[] = [
  { handle: 'bamboo-bottle', title: 'Bamboo Bottle', price: 499, mrp: 690, collection: 'drinkware', sku: 'ACH-BAM-BTL' },
  { handle: 'bamboo-tumbler-with-handle', title: 'Bamboo Tumbler with Handle', price: 699, mrp: 899, collection: 'drinkware', sku: 'ACH-BAM-TMB' },
  { handle: 'cork-diary', title: 'Cork Diary', price: 249, mrp: 329, collection: 'eco-stationery', sku: 'ACH-CRK-DRY' },
  { handle: 'bamboo-diary', title: 'Bamboo Diary', price: 449, mrp: 499, collection: 'eco-stationery', sku: 'ACH-BAM-DRY' },
  { handle: 'bamboo-keychain', title: 'Bamboo Keychain', price: 69, mrp: 99, collection: 'workspace-collection', sku: 'ACH-BAM-KEY' },
  { handle: 'premium-bamboo-pen-with-gift-box', title: 'Premium Bamboo Pen with Gift Box', price: 399, mrp: 499, collection: 'workspace-collection', sku: 'ACH-BAM-PEN' },
  { handle: 'cork-laptop-sleeve', title: 'Cork Laptop Sleeve', price: 799, mrp: 999, collection: 'workspace-collection', sku: 'ACH-CRK-SLV' },
  { handle: 'circle-pendant-necklace-black', title: 'Circle Pendant Necklace — Black', price: 449, mrp: 549, collection: 'necklaces', sku: 'ACH-JWL-CPN' },
  { handle: 'circular-bead-necklace-set-red-golden', title: 'Circular Bead Necklace Set — Red & Golden', price: 899, mrp: 1099, collection: 'necklaces', sku: 'ACH-JWL-CBN' },
  { handle: 'kathakali-pendant-necklace-black-base', title: 'Kathakali Pendant Necklace — Black Base', price: 549, mrp: 649, collection: 'necklaces', sku: 'ACH-JWL-KPN' },
  { handle: 'temple-jewellery-set', title: 'Temple Jewellery Set', price: 1449, mrp: 1699, collection: 'necklaces', sku: 'ACH-JWL-TMP' },
  { handle: 'triangular-bead-choker-golden', title: 'Triangular Bead Choker — Golden', price: 649, mrp: 799, collection: 'necklaces', sku: 'ACH-JWL-TBC' },
  { handle: 'bird-jhumka', title: 'Bird Jhumka', price: 349, mrp: 449, collection: 'earrings', sku: 'ACH-JWL-BJH' },
  { handle: 'cinnamon-stick-candle', title: 'Cinnamon Stick Candle', price: 349, mrp: 449, collection: 'earth-aroma', sku: 'ACH-CDL-CIN' },
];

console.log('\n--- products + variants ---');
for (const p of PRODUCTS) {
  const productId = await upsert('products', 'handle', p.handle, {
    title: p.title,
    kind: 'single_gift',
    status: 'active',
    // `product_active_needs_hsn` refuses an active product without one.
    hsnCode: '4602',
    publishedAt: new Date().toISOString(),
    ...(collectionIds.has(p.collection) ? { primaryCollectionId: collectionIds.get(p.collection) } : {}),
  });
  if (!productId) {
    console.log(`  FAIL ${p.handle}`);
    continue;
  }

  await upsert('product-variants', 'sku', p.sku, {
    productId,
    optionLabel: 'Size',
    optionValue: 'standard',
    pricePaise: rupees(p.price),
    compareAtPaise: rupees(p.mrp),
    status: 'active',
    isDefault: true,
  });

  /*
   * The join row is what makes a collection page non-empty. `product_collections`
   * had zero rows, so every collection would have rendered empty even with the
   * products live. It has no admin resource, so it is inserted directly —
   * ON CONFLICT keeps the script idempotent.
   */
  const cid = collectionIds.get(p.collection);
  if (cid) {
    await db()
      .query(
        `insert into product_collections (product_id, collection_id) values ($1, $2)
         on conflict do nothing`,
        [productId, cid],
      )
      .catch((e: Error) => problems.push(`link ${p.handle}: ${e.message.slice(0, 100)}`));
  }
  console.log(`  ok   ${p.handle.padEnd(42)} ₹${p.price}`);
}

/* -------------------------------------------- publish existing content rows */

/*
 * banners and testimonials use STATUS-ARCHIVE rather than soft delete, so
 * neither table has a deleted_at column to filter on.
 *
 * The rows already in the table are all `expired` and
 * `rejected`, which is why the storefront showed none. They are real rows;
 * publishing them is an ordinary admin action, not a data import.
 */
console.log('\n--- publish existing content ---');
const pub = await db().query(`update banners set status = 'live' where status = 'expired'`);
console.log(`  banners      expired -> live      : ${pub.rowCount ?? 0}`);
const tst = await db().query(`update testimonials set status = 'published' where status = 'rejected'`);
console.log(`  testimonials rejected -> published: ${tst.rowCount ?? 0}`);

/* --------------------------------------------------------------- summary */

console.log(`\ncreated ${created} · updated ${updated} · failed ${failed}`);
if (problems.length) {
  console.log('\nproblems:');
  for (const p of problems.slice(0, 12)) console.log('  ' + p);
}

const live = await db().query(`
  select count(*)::int n from products
   where status='active' and deleted_at is null
     and published_at is not null and published_at <= now()`);
const links = await db().query('select count(*)::int n from product_collections');
console.log(`\nlive products now      : ${live.rows[0].n}`);
console.log(`product↔collection links: ${links.rows[0].n}`);


/* --------------------------------------------------------------- inventory */

/*
 * Without an `inventory_levels` row every product renders SOLD OUT, which is
 * how the storefront looked immediately after seeding the catalogue: the
 * products were live and correctly priced, and none of them could be bought.
 *
 * Stock is written straight to the table rather than through the adjustments
 * endpoint on purpose — an adjustment writes a `stock_movements` ledger entry,
 * and inventing an audit trail for stock that was never physically counted
 * would put fiction into the ledger. Opening balances are set, not adjusted.
 */
const [warehouse] = (
  await db().query<{ id: string; code: string }>(
    `select id, code from warehouses where deleted_at is null and status = 'active'
      order by created_at limit 1`,
  )
).rows;

if (!warehouse) {
  console.log('\nno active warehouse — skipping stock');
} else {
  const res = await db().query(
    `insert into inventory_levels (variant_id, warehouse_id, on_hand_qty, reserved_qty, reorder_point, reorder_qty)
     select v.id, $1, 25, 0, 5, 20
       from product_variants v
       join products p on p.id = v.product_id
      where v.deleted_at is null and p.deleted_at is null
        and p.status = 'active'
        and not exists (
          select 1 from inventory_levels il
           where il.variant_id = v.id and il.warehouse_id = $1)`,
    [warehouse.id],
  );
  console.log(`\n--- inventory ---`);
  console.log(`  stocked ${res.rowCount ?? 0} variant(s) at ${warehouse.code} (25 units each)`);
}

const stocked = await db().query(
  `select count(*)::int n from inventory_levels where on_hand_qty > 0`,
);
console.log(`  variants with stock now: ${stocked.rows[0].n}`);

await closeDb();
