import { pool } from '../src/config/db.js';

async function main() {
  const collections = await pool.query(`
    SELECT c.id, c.handle, c.title, c.kind, c.parent_id,
           COUNT(pc.product_id) as total_products,
           COUNT(CASE WHEN p.status = 'active' AND p.deleted_at IS NULL AND p.published_at <= NOW() THEN 1 END) as live_products
    FROM collections c
    LEFT JOIN product_collections pc ON pc.collection_id = c.id
    LEFT JOIN products p ON p.id = pc.product_id
    GROUP BY c.id, c.handle, c.title, c.kind, c.parent_id
    ORDER BY c.title;
  `);

  console.log(`Total collections in DB: ${collections.rows.length}`);
  for (const row of collections.rows) {
    console.log(`- [${row.kind}] "${row.title}" (handle: "${row.handle}"): total=${row.total_products}, live=${row.live_products}`);
  }

  process.exit(0);
}

main().catch(console.error);
