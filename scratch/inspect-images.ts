import { pool } from '../src/config/db.js';

async function main() {
  const images = await pool.query(`
    SELECT p.id, p.handle, p.title, ma.url, pm.position
    FROM products p
    LEFT JOIN product_media pm ON pm.product_id = p.id
    LEFT JOIN media_assets ma ON ma.id = pm.media_id
    WHERE p.status = 'active' AND p.deleted_at IS NULL
    ORDER BY ma.url IS NULL, p.title;
  `);

  const withImg = images.rows.filter(r => r.url !== null);
  const withoutImg = images.rows.filter(r => r.url === null);

  console.log(`Active products with image: ${withImg.length}`);
  console.log(`Active products WITHOUT image: ${withoutImg.length}`);
  if (withoutImg.length > 0) {
    console.log('Sample without image:');
    console.table(withoutImg.slice(0, 15).map(r => ({ handle: r.handle, title: r.title })));
  }

  // Also check all media_assets
  const allMedia = await pool.query(`
    SELECT id, filename, url, cdn_url
    FROM media_assets
    LIMIT 10;
  `);
  console.log(`Total media_assets sample:`);
  console.table(allMedia.rows);

  await pool.end();
}

main().catch(console.error);
