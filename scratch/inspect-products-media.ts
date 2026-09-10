import { pool } from '../src/config/db.js';

async function test() {
  const products = await pool.query(`
    SELECT p.id, p.handle, p.title, p.category_id,
           (SELECT json_agg(json_build_object('url', ma.url, 'id', ma.id)) 
            FROM product_media pm 
            JOIN media_assets ma ON pm.media_asset_id = ma.id 
            WHERE pm.product_id = p.id) as media
    FROM products p
    WHERE p.handle ILIKE '%pendant%' OR p.handle ILIKE '%chain%' OR p.title ILIKE '%pendant%' OR p.title ILIKE '%chain%'
    LIMIT 10;
  `);
  console.log('Target products:', JSON.stringify(products.rows, null, 2));

  const countResult = await pool.query(`SELECT count(*) FROM products`);
  console.log('Total products in DB:', countResult.rows[0].count);

  const sampleProducts = await pool.query(`
    SELECT p.id, p.handle, p.title,
           (SELECT json_agg(json_build_object('url', ma.url)) 
            FROM product_media pm 
            JOIN media_assets ma ON pm.media_asset_id = ma.id 
            WHERE pm.product_id = p.id) as media
    FROM products p
    LIMIT 5;
  `);
  console.log('Sample products:', JSON.stringify(sampleProducts.rows, null, 2));

  process.exit(0);
}
test().catch(e => {
  console.error(e);
  process.exit(1);
});
