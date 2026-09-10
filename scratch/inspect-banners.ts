import { pool } from '../src/config/db.js';

async function main() {
  const r = await pool.query(`
    SELECT b.id, b.slot, b.title, b.subtitle, b.cta_label, b.sort_order,
           ma1.url as desktop_url, ma2.url as mobile_url
    FROM banners b
    LEFT JOIN media_assets ma1 ON ma1.id = b.media_id
    LEFT JOIN media_assets ma2 ON ma2.id = b.mobile_media_id
    WHERE b.slot = 'homepage_hero'
    ORDER BY b.sort_order;
  `);

  console.log('Homepage Hero Banners:');
  console.table(r.rows);

  await pool.end();
}

main().catch(console.error);
