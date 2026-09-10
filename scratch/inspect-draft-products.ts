import { pool } from '../src/config/db.js';

async function main() {
  const r = await pool.query(`
    SELECT status, deleted_at IS NOT NULL as is_deleted, COUNT(*) 
    FROM products 
    GROUP BY status, deleted_at IS NOT NULL;
  `);
  console.log('Product status breakdown:', r.rows);

  const inventoryCheck = await pool.query(`
    SELECT p.id, p.handle, p.title, p.status, p.deleted_at, p.published_at,
           COUNT(DISTINCT pc.collection_id) as col_count,
           COUNT(DISTINCT pm.media_id) as media_count,
           COUNT(DISTINCT pv.id) as variant_count
    FROM products p
    LEFT JOIN product_collections pc ON pc.product_id = p.id
    LEFT JOIN product_media pm ON pm.product_id = p.id
    LEFT JOIN product_variants pv ON pv.product_id = p.id
    WHERE p.status = 'draft' AND p.deleted_at IS NULL
    GROUP BY p.id, p.handle, p.title, p.status, p.deleted_at, p.published_at
    ORDER BY p.title;
  `);

  console.log(`\nDraft products not deleted (${inventoryCheck.rows.length}):`);
  for (const row of inventoryCheck.rows) {
    console.log(` - "${row.title}" (${row.handle}): cols=${row.col_count}, media=${row.media_count}, variants=${row.variant_count}, pub=${row.published_at}`);
  }

  process.exit(0);
}

main().catch(console.error);
