import { pool } from '../src/config/db.js';
import { cache, closeRedis } from '../src/config/redis.js';

async function main() {
  console.log('Checking media links between handle variants...');

  const pairs: [string, string][] = [
    ['bamboo-desing-pendent-black-base', 'bamboo-design-pendant-black-base'],
    ['bluish-green-pendent', 'bluish-green-pendant'],
    ['circle-pendent-necklace-black', 'circle-pendant-necklace-black'],
    ['circle-pendent-necklace-pink-and-black', 'circle-pendant-necklace-pink-and-black'],
    ['circular-pendent-lavender', 'circular-pendant-lavender'],
    ['cork-keychchain', 'cork-keychain'],
    ['golden-n-blue-choker', 'golden-and-blue-choker'],
    ['green-n-blue-set', 'green-and-blue-set'],
    ['hexagonal-pendent-golden-n-black', 'hexagonal-pendant-golden-and-black'],
    ['hollow-circular-pendent-lavender', 'hollow-circular-pendant-lavender'],
    ['kathakkali-theme-pendent-black-base', 'kathakali-pendant-necklace-black-base'],
    ['kathakkali-theme-pendent-black-base', 'kathakali-theme-pendant-black-base'],
    ['orange-yellow-pendant', 'orange-yellow-pendent'],
    ['pink-n-silver-set', 'pink-and-silver-set'],
    ['red-rectangle-pendent', 'red-rectangle-pendant'],
    ['semicircle-pendent', 'semicircle-pendant'],
    ['bird-shaped-jhumka', 'bird-jhumka'],
    ['tringular-bead-choker-golden', 'triangular-bead-choker-golden'],
    ['tringular-bead-choker-silver', 'triangular-bead-choker-silver'],
    ['premium-bamboo-pen-with-gift-box', 'premium-bamboo-pen-with-box'],
  ];

  let synced = 0;
  for (const [h1, h2] of pairs) {
    const r1 = await pool.query(`
      SELECT p.id as product_id, pm.media_id, pm.alt_text, pm.position
      FROM products p
      JOIN product_media pm ON pm.product_id = p.id
      WHERE p.handle = $1;
    `, [h1]);

    const r2 = await pool.query(`
      SELECT p.id as product_id, pm.media_id, pm.alt_text, pm.position
      FROM products p
      JOIN product_media pm ON pm.product_id = p.id
      WHERE p.handle = $1;
    `, [h2]);

    const p1 = await pool.query(`SELECT id FROM products WHERE handle = $1 AND deleted_at IS NULL;`, [h1]);
    const p2 = await pool.query(`SELECT id FROM products WHERE handle = $1 AND deleted_at IS NULL;`, [h2]);

    if (r1.rows.length === 0 && r2.rows.length > 0 && p1.rows.length > 0) {
      for (const m of r2.rows) {
        const exists = await pool.query(`
          SELECT id FROM product_media WHERE product_id = $1 AND media_id = $2;
        `, [p1.rows[0].id, m.media_id]);
        if (exists.rows.length === 0) {
          await pool.query(`
            INSERT INTO product_media (product_id, media_id, alt_text, position)
            VALUES ($1, $2, $3, $4);
          `, [p1.rows[0].id, m.media_id, m.alt_text, m.position]);
          synced++;
          console.log(`Copied media from ${h2} -> ${h1}`);
        }
      }
    } else if (r2.rows.length === 0 && r1.rows.length > 0 && p2.rows.length > 0) {
      for (const m of r1.rows) {
        const exists = await pool.query(`
          SELECT id FROM product_media WHERE product_id = $1 AND media_id = $2;
        `, [p2.rows[0].id, m.media_id]);
        if (exists.rows.length === 0) {
          await pool.query(`
            INSERT INTO product_media (product_id, media_id, alt_text, position)
            VALUES ($1, $2, $3, $4);
          `, [p2.rows[0].id, m.media_id, m.alt_text, m.position]);
          synced++;
          console.log(`Copied media from ${h1} -> ${h2}`);
        }
      }
    }
  }

  console.log(`Synced ${synced} media records.`);

  try {
    const keys = await cache.keys('cat:v1:*');
    if (keys.length > 0) {
      await cache.del(...keys);
      console.log(`Flushed ${keys.length} keys from Redis cache.`);
    }
  } catch (e) {
    console.warn('Redis flush error:', e);
  }

  await closeRedis();
  await pool.end();
}

main().catch(console.error);
