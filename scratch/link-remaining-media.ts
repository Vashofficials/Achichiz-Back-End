import { pool } from '../src/config/db.js';
import { cache, closeRedis } from '../src/config/redis.js';

async function main() {
  console.log('Linking remaining product media assets...');

  const r = await pool.query(`
    SELECT p.id, p.handle, p.title
    FROM products p
    LEFT JOIN product_media pm ON pm.product_id = p.id
    WHERE p.deleted_at IS NULL AND p.status = 'active'
    GROUP BY p.id, p.handle, p.title
    HAVING count(pm.id) = 0;
  `);

  console.log(`Found ${r.rows.length} products to link.`);

  let linkedCount = 0;
  for (const prod of r.rows) {
    const rawHandle = prod.handle.replace(/dup-.*?-/, '');
    
    // Find media asset for this handle (prefer s3 webp over picsum)
    const ma = await pool.query(`
      SELECT id, url
      FROM media_assets
      WHERE (filename ILIKE $1 OR storage_key ILIKE $1 OR url ILIKE $1)
      ORDER BY (url ILIKE '%.webp') DESC, (url ILIKE '%achichiz-media%') DESC
      LIMIT 1;
    `, [`%${rawHandle}%`]);

    if (ma.rows.length > 0) {
      const mediaId = ma.rows[0].id;
      await pool.query(`
        INSERT INTO product_media (product_id, media_id, alt_text, position)
        VALUES ($1, $2, $3, 0)
        ON CONFLICT DO NOTHING;
      `, [prod.id, mediaId, prod.title]);
      linkedCount++;
      console.log(`[${linkedCount}] Linked "${prod.title}" (${prod.handle}) -> ${ma.rows[0].url}`);
    } else {
      console.warn(`No media asset found for handle: ${prod.handle}`);
    }
  }

  console.log(`\nSuccessfully linked ${linkedCount} products to their authentic media assets.`);

  // Flush redis cache
  try {
    const keys = await cache.keys('cat:v1:*');
    if (keys.length > 0) {
      await cache.del(...keys);
      console.log(`Flushed ${keys.length} keys from Redis.`);
    }
  } catch (e) {
    console.warn('Redis clear warning:', e);
  }

  await closeRedis();
  await pool.end();
}

main().catch(console.error);
