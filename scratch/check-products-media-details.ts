import { pool } from '../src/config/db.js';
import fs from 'fs';

async function checkMedia() {
  const parsed = JSON.parse(fs.readFileSync('scratch/inventory_products_parsed.json', 'utf-8'));
  
  const res = await pool.query(`
    SELECT p.id, p.handle, p.title, 
           json_agg(json_build_object('media_id', pm.media_id, 'url', ma.url, 'alt', pm.alt_text)) FILTER (WHERE pm.media_id IS NOT NULL) as media
    FROM products p
    LEFT JOIN product_media pm ON pm.product_id = p.id
    LEFT JOIN media_assets ma ON pm.media_id = ma.id
    GROUP BY p.id, p.handle, p.title;
  `);

  const prodsMap = new Map(res.rows.map(r => [r.handle, r]));
  let hasMediaCount = 0;
  let noMediaCount = 0;

  for (const p of parsed) {
    const handle = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const inDb = prodsMap.get(handle);
    if (inDb && inDb.media && inDb.media.length > 0) {
      hasMediaCount++;
      if (hasMediaCount <= 5) {
        console.log(`Has media: ${p.name} ->`, inDb.media);
      }
    } else {
      noMediaCount++;
    }
  }

  console.log(`Products with media: ${hasMediaCount}, without media: ${noMediaCount}`);
  process.exit(0);
}

checkMedia().catch(e => {
  console.error(e);
  process.exit(1);
});
