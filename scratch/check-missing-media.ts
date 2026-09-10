import { pool } from '../src/config/db.js';

async function main() {
  const r = await pool.query(`
    SELECT p.id, p.handle, p.title, count(pm.id) as media_count
    FROM products p
    LEFT JOIN product_media pm ON pm.product_id = p.id
    WHERE p.deleted_at IS NULL AND p.status = 'active'
    GROUP BY p.id, p.handle, p.title
    HAVING count(pm.id) = 0;
  `);

  console.log(`Live active products with 0 media: ${r.rows.length}`);
  console.table(r.rows);

  // Check what media assets exist matching these handles
  for (const row of r.rows) {
    const ma = await pool.query(`
      SELECT id, filename, url, storage_key
      FROM media_assets
      WHERE filename ILIKE $1 OR storage_key ILIKE $1;
    `, [`%${row.handle.replace(/dup-.*?-/, '')}%`]);

    if (ma.rows.length > 0) {
      console.log(`Found matching media for ${row.handle}:`, ma.rows.map(m => m.url));
    }
  }

  await pool.end();
}

main().catch(console.error);
