import { pool } from '../src/config/db.js';

async function main() {
  const [bannersRes, mediaRes, collectionsRes] = await Promise.all([
    pool.query(`SELECT b.id, b.title, b.subtitle, b.placement, b.status, b.link_url, b.cta_label, b.position, m.url as media_url 
     FROM banners b 
     LEFT JOIN media_assets m ON b.media_id = m.id 
     ORDER BY b.position ASC`),
    pool.query(`SELECT id, storage_key, url, cdn_url, alt_text, bytes, mime_type FROM media_assets ORDER BY created_at DESC LIMIT 10`),
    pool.query(`SELECT id, title, handle, status FROM collections WHERE deleted_at IS NULL ORDER BY title ASC`),
  ]);
  console.log('--- BANNERS ---');
  console.log(JSON.stringify(bannersRes.rows, null, 2));
  console.log('--- MEDIA ASSETS (sample) ---');
  console.log(JSON.stringify(mediaRes.rows, null, 2));
  console.log('--- COLLECTIONS ---');
  console.log(JSON.stringify(collectionsRes.rows, null, 2));
  await pool.end();
}

main().catch(console.error);

