/**
 * Put products in the two rails the homepage is built around.
 *
 * `best-sellers` and `signature-picks` both had ZERO products. They are the
 * homepage's main merchandising rails — "Best Sellers" and "Signature Picks"
 * render a heading, a "view all" link and then nothing at all, on the most
 * visited page of the shop.
 *
 * This is not new breakage. `16-seed-storefront.ts` created both collections
 * but assigned every product to `drinkware`, `eco-stationery`,
 * `workspace-collection`, `necklaces`, `earrings` or `earth-aroma`, and
 * `18-purge-nonsheet.ts` repopulated only those four. Nothing ever wrote a row
 * linking a product to either rail, so both have been empty since the day they
 * were created.
 *
 * `earth-aroma` is filled for the same reason: it held ONE product while the
 * catalogue has a dozen candles.
 *
 * WHAT GOES IN A RAIL IS A MERCHANDISING DECISION, and these rules are a
 * starting point, not an opinion about what sells — there is no order history
 * to compute a real best-seller from yet. They pick priced, in-stock products
 * across every category so the rails are useful on day one, and an operator
 * can curate them properly in the Admin Panel, which is the whole point of the
 * rows living in the database rather than in a fixture.
 */

import { db, closeDb } from './lib.js';

const DRY = process.env.DRY_RUN === '1';
if (DRY) console.log('*** DRY RUN — nothing will be written ***\n');

type Product = { id: string; title: string; price: number };

const { rows: live } = await db().query<Product>(
  `select p.id, p.title, coalesce(max(v.price_paise), 0) / 100 as price
     from products p
     join product_variants v on v.product_id = p.id and v.deleted_at is null
    where p.deleted_at is null and p.status = 'active'
      and p.published_at is not null and p.published_at <= now()
      and v.price_paise > 0
    group by p.id, p.title
    order by p.title`,
);
console.log(`${live.length} live, priced products\n`);

/** One product per category keeps a rail from becoming all necklaces. */
const CATEGORY = [
  { name: 'drinkware', match: /bottle|tumbler|mug/i },
  { name: 'stationery', match: /diary|pen\b|card ?holder/i },
  { name: 'candles', match: /candle|sachet|tea ?light/i },
  { name: 'necklaces', match: /necklace|pendant|choker|set\b/i },
  { name: 'earrings', match: /earring|jhumka|dangler|hoop/i },
  { name: 'keychains', match: /keychain/i },
];

/** Spread a selection across categories, taking `perCategory` from each. */
function spread(perCategory: number, skip = 0): Product[] {
  const out: Product[] = [];
  for (const c of CATEGORY) {
    const inCat = live.filter((p) => c.match.test(p.title));
    out.push(...inCat.slice(skip, skip + perCategory));
  }
  // A product can match two rules (a "necklace set" is also a "set"); dedupe.
  return [...new Map(out.map((p) => [p.id, p])).values()];
}

const RAILS: { handle: string; label: string; pick: () => Product[] }[] = [
  { handle: 'best-sellers', label: 'Best Sellers', pick: () => spread(2, 0) },
  { handle: 'signature-picks', label: 'Signature Picks', pick: () => spread(2, 2) },
  {
    handle: 'earth-aroma',
    label: 'Earth & Aroma',
    // Not a curated rail — this is a category, so it takes every candle.
    pick: () => live.filter((p) => /candle|sachet|tea ?light|aroma/i.test(p.title)),
  },
];

for (const rail of RAILS) {
  const { rows: col } = await db().query<{ id: string }>(
    'select id from collections where handle = $1 and deleted_at is null limit 1',
    [rail.handle],
  );
  if (!col[0]) {
    console.log(`  SKIP  ${rail.handle} — no such collection`);
    continue;
  }

  const picks = rail.pick();
  if (picks.length === 0) {
    console.log(`  SKIP  ${rail.handle} — nothing matched`);
    continue;
  }

  console.log(`  ${rail.label}  (${picks.length})`);
  for (const p of picks) console.log(`      Rs${String(p.price).padStart(5)}  ${p.title}`);

  if (!DRY) {
    let linked = 0;
    for (const p of picks) {
      const res = await db().query(
        'insert into product_collections (product_id, collection_id) values ($1,$2) on conflict do nothing',
        [p.id, col[0].id],
      );
      linked += res.rowCount ?? 0;
    }
    console.log(`      -> ${linked} newly linked`);
  }
  console.log('');
}

if (!DRY) {
  const { rows: check } = await db().query<{ handle: string; n: number }>(
    `select c.handle, count(pc.product_id)::int as n
       from collections c
       left join product_collections pc on pc.collection_id = c.id
      where c.deleted_at is null and c.status = 'live'
      group by c.handle
      order by n desc, c.handle`,
  );
  console.log('products per live collection:');
  for (const r of check) console.log(`  ${String(r.n).padStart(3)}  ${r.handle}`);
}

await closeDb();
