import { pool } from '../src/config/db.js';
import fs from 'fs';

async function verify() {
  const parsed = JSON.parse(fs.readFileSync('scratch/inventory_products_parsed.json', 'utf-8'));
  console.log(`Checking ${parsed.length} products in DB...`);

  let countWithS3 = 0;
  let countWithNull = 0;
  const sampleResults: any[] = [];

  for (const p of parsed) {
    let handle = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

    const res = await pool.query(`
      SELECT p.id, p.handle, p.title,
             json_agg(json_build_object('url', ma.url, 'pos', pm.position, 'bytes', ma.bytes)) as media
      FROM products p
      JOIN product_media pm ON pm.product_id = p.id
      JOIN media_assets ma ON pm.media_id = ma.id
      WHERE p.handle = $1 OR p.handle = $2
      GROUP BY p.id, p.handle, p.title;
    `, [handle, handle.replace('-pendent-', '-pendant-')]);

    if (res.rows.length > 0 && res.rows[0].media) {
      countWithS3++;
      if (sampleResults.length < 8 || handle.includes('chain-pend')) {
        sampleResults.push({
          title: res.rows[0].title,
          handle: res.rows[0].handle,
          mediaCount: res.rows[0].media.length,
          primaryUrl: res.rows[0].media[0]?.url,
          bytes: res.rows[0].media[0]?.bytes,
        });
      }
    } else {
      countWithNull++;
      console.warn(`Missing media for: ${p.name} (${handle})`);
    }
  }

  console.log(`\nVerification Summary:`);
  console.log(`✅ Products with S3 Media: ${countWithS3} / ${parsed.length}`);
  console.log(`❌ Products without Media: ${countWithNull}`);
  console.log('\nSample Verified Products:');
  console.log(JSON.stringify(sampleResults, null, 2));

  process.exit(0);
}

verify().catch(e => {
  console.error(e);
  process.exit(1);
});
