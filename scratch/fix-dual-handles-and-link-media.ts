import { pool } from '../src/config/db.js';
import { cache } from '../src/config/redis.js';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('🔍 Checking all active products and their media status in PostgreSQL...');

  const activeProducts = await pool.query(`
    SELECT p.id, p.handle, p.title, p.status,
           COUNT(pm.id) as media_count
    FROM products p
    LEFT JOIN product_media pm ON pm.product_id = p.id
    WHERE p.status = 'active'
    GROUP BY p.id, p.handle, p.title, p.status
    ORDER BY p.title;
  `);

  console.log(`Total active products in DB: ${activeProducts.rows.length}`);
  const missing = activeProducts.rows.filter(r => Number(r.media_count) === 0);
  console.log(`Active products missing media: ${missing.length}`);
  for (const m of missing) {
    console.log(` - [${m.id}] handle="${m.handle}", title="${m.title}"`);
  }

  // Get all available media_assets
  const allMedia = await pool.query(`
    SELECT id, storage_key, url, filename FROM media_assets WHERE deleted_at IS NULL;
  `);
  console.log(`Total media assets in DB: ${allMedia.rows.length}`);

  // Create a helper to find media asset by key or filename
  const findAsset = (needle: string) => {
    return allMedia.rows.find(m => 
      m.filename === needle || 
      m.storage_key === needle || 
      m.storage_key === `products/${needle}` ||
      m.url?.endsWith(`/${needle}`)
    );
  };

  // 1. Specifically link chain-pendant-set (with 'a')
  const chainPendantProds = activeProducts.rows.filter(p => p.handle.includes('chain-pendant') || p.handle.includes('chain-pendent'));
  for (const cp of chainPendantProds) {
    console.log(`\nConfiguring gallery for ${cp.handle} (${cp.id})...`);
    // Delete existing product_media to ensure clean positions
    await pool.query('DELETE FROM product_media WHERE product_id = $1', [cp.id]);

    // Position 0: main image
    let mainAsset = findAsset('chain-pendant-set.webp') || findAsset('chain-pendent-set.webp');
    if (mainAsset) {
      await pool.query(`
        INSERT INTO product_media (product_id, media_id, position, alt_text)
        VALUES ($1, $2, 0, $3);
      `, [cp.id, mainAsset.id, cp.title]);
      console.log(` -> Added main image: ${mainAsset.filename} (pos 0)`);
    }

    // Position 1, 2, 3: detail angles
    for (let i = 1; i <= 3; i++) {
      const angleAsset = findAsset(`chain-pendant-set-${i}.webp`);
      if (angleAsset) {
        await pool.query(`
          INSERT INTO product_media (product_id, media_id, position, alt_text)
          VALUES ($1, $2, $3, $4);
        `, [cp.id, angleAsset.id, i, `${cp.title} Detail Angle ${i}`]);
        console.log(` -> Added detail angle: ${angleAsset.filename} (pos ${i})`);
      }
    }
  }

  // 2. Link all other active products that have 0 media
  for (const m of missing) {
    if (m.handle.includes('chain-pendant') || m.handle.includes('chain-pendent')) {
      continue; // already handled
    }

    // Try various candidate filenames
    const candidates = [
      `${m.handle}.webp`,
      `${m.handle.replace('-pendant-', '-pendent-')}.webp`,
      `${m.handle.replace('-pendent-', '-pendant-')}.webp`,
      `${m.handle.replace(/-\([^\)]+\)/g, '')}.webp`,
      `${m.handle.replace('cork-keychchain', 'cork-keychain')}.webp`,
      `${m.handle.replace('cork-keychain', 'cork-keychchain')}.webp`,
    ];

    let matchedAsset = null;
    for (const c of candidates) {
      matchedAsset = findAsset(c);
      if (matchedAsset) break;
    }

    // If still not matched, try matching by finding another active product with same or similar title
    if (!matchedAsset) {
      const counterpart = activeProducts.rows.find(p => 
        p.id !== m.id && 
        Number(p.media_count) > 0 && 
        (p.title.toLowerCase() === m.title.toLowerCase() || 
         p.handle.replace(/-pendant-|-pendent-/, '') === m.handle.replace(/-pendant-|-pendent-/, ''))
      );
      if (counterpart) {
        const cpMedia = await pool.query(`
          SELECT media_id FROM product_media WHERE product_id = $1 ORDER BY position LIMIT 1
        `, [counterpart.id]);
        if (cpMedia.rows.length > 0) {
          const mediaId = cpMedia.rows[0].media_id;
          matchedAsset = allMedia.rows.find(a => a.id === mediaId);
        }
      }
    }

    if (matchedAsset) {
      await pool.query(`
        INSERT INTO product_media (product_id, media_id, position, alt_text)
        VALUES ($1, $2, 0, $3);
      `, [m.id, matchedAsset.id, m.title]);
      console.log(`✅ Fixed missing media for "${m.title}" (${m.handle}) -> linked ${matchedAsset.filename}`);
    } else {
      console.warn(`⚠️ Could not find asset match for "${m.title}" (${m.handle})`);
    }
  }

  // Specific manual mappings for slight title/handle variations in older seed data
  const manualMappings: Record<string, string> = {
    'premium-bamboo-pen-with-gift-box': 'premium-bamboo-pen-with-box.webp',
    'kathakali-pendant-necklace-black-base': 'kathakkali-theme-pendent-black-base.webp',
    'circular-bead-necklace-set-red-golden': 'circular-bead-necklace-set-set-and-golden.webp',
    'bird-jhumka': 'bird-shaped-jhumka.webp',
  };

  for (const [pHandle, assetName] of Object.entries(manualMappings)) {
    const prod = activeProducts.rows.find(p => p.handle === pHandle);
    const asset = findAsset(assetName);
    if (prod && asset) {
      await pool.query('DELETE FROM product_media WHERE product_id = $1', [prod.id]);
      await pool.query(`
        INSERT INTO product_media (product_id, media_id, position, alt_text)
        VALUES ($1, $2, 0, $3);
      `, [prod.id, asset.id, prod.title]);
      console.log(`✅ Linked manual match "${prod.title}" (${prod.handle}) -> ${asset.filename}`);
    }
  }

  // 3. Clear Redis cache completely
  console.log('\n--- Flushing Redis cache ---');
  try {
    const keys = await cache.keys('cat:v1:*');
    if (keys.length > 0) {
      await cache.del(...keys);
      console.log(`Flushed ${keys.length} keys from Redis (cat:v1:*).`);
    } else {
      console.log('No cache keys matched cat:v1:*.');
    }
  } catch (err) {
    console.error('Redis error:', err);
  }

  // 4. Verify results
  const postCheck = await pool.query(`
    SELECT p.id, p.handle, p.title, COUNT(pm.id) as media_count
    FROM products p
    LEFT JOIN product_media pm ON pm.product_id = p.id
    WHERE p.status = 'active'
    GROUP BY p.id, p.handle, p.title
    HAVING COUNT(pm.id) = 0;
  `);

  console.log(`\n🎉 Verification: Active products still missing media = ${postCheck.rows.length}`);
  if (postCheck.rows.length > 0) {
    console.log(postCheck.rows);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
