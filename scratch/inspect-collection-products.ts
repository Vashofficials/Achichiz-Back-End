import { pool } from '../src/config/db.js';

async function main() {
  const handles = [
    'all-bamboo-product-workspace-collection',
    'eco-stationery',
    'earth-aroma-collection',
    'jhumkas',
    'temple-jewellery',
    'workspace-collection',
  ];

  for (const h of handles) {
    const r = await pool.query(`
      SELECT p.id, p.handle, p.title, p.status, p.deleted_at, p.published_at,
             (SELECT count(*) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active') as variant_count
      FROM collections c
      JOIN product_collections pc ON pc.collection_id = c.id
      JOIN products p ON p.id = pc.product_id
      WHERE c.handle = $1
      LIMIT 10;
    `, [h]);

    console.log(`\n=== Collection "${h}" (${r.rows.length} sample products) ===`);
    for (const p of r.rows) {
      console.log(` - [${p.id}] "${p.title}" (${p.handle}): status=${p.status}, deleted_at=${p.deleted_at}, published_at=${p.published_at}, variants=${p.variant_count}`);
    }
  }

  process.exit(0);
}

main().catch(console.error);
