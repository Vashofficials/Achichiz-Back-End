import { pool } from '../src/config/db.js';

async function test() {
  const r = await pool.query(`
    SELECT p.id, p.handle, p.title, p.status, c.handle as col_handle,
           (SELECT count(*) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active') as variant_count,
           (SELECT json_agg(json_build_object('url', ma.url)) 
            FROM product_media pm JOIN media_assets ma ON pm.media_id = ma.id WHERE pm.product_id = p.id) as media
    FROM products p
    JOIN product_collections pc ON pc.product_id = p.id
    JOIN collections c ON pc.collection_id = c.id
    WHERE c.handle = 'necklaces'
    ORDER BY p.title;
  `);
  console.log('Necklaces products in DB:', JSON.stringify(r.rows, null, 2));

  const chainRes = await pool.query(`
    SELECT p.id, p.handle, p.title, p.status,
           (SELECT count(*) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active') as variant_count,
           (SELECT json_agg(json_build_object('url', ma.url)) 
            FROM product_media pm JOIN media_assets ma ON pm.media_id = ma.id WHERE pm.product_id = p.id) as media
    FROM products p
    WHERE p.handle ILIKE '%chain%' OR p.handle ILIKE '%pendant%' OR p.handle ILIKE '%pendent%';
  `);
  console.log('\nChain/Pendant products in DB:', JSON.stringify(chainRes.rows, null, 2));
  process.exit(0);
}

test().catch(e => {
  console.error(e);
  process.exit(1);
});
