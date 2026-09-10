import { pool } from '../src/config/db.js';
import { cache, closeRedis } from '../src/config/redis.js';

async function main() {
  console.log('🔄 Syncing dual handles and ensuring live status...');

  // Check chain-pendant-set and chain-pendent-set
  const prods = await pool.query(`
    SELECT p.id, p.handle, p.title, p.status, p.deleted_at, p.published_at,
           (SELECT count(*) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active') as variant_count,
           (SELECT count(*) FROM product_media pm WHERE pm.product_id = p.id) as media_count
    FROM products p
    WHERE p.handle IN ('chain-pendant-set', 'chain-pendent-set')
       OR p.handle LIKE '%pendant%' OR p.handle LIKE '%pendent%';
  `);

  console.log('Found pendant/pendent products:', prods.rows.length);
  for (const row of prods.rows) {
    console.log(`- ${row.handle}: status=${row.status}, published_at=${row.published_at}, variants=${row.variant_count}, media=${row.media_count}`);
  }

  // Ensure chain-pendant-set and chain-pendent-set both have published_at <= NOW(), status = 'active', deleted_at = null
  // Also ensure variants exist if 0
  const primaryChain = prods.rows.find(p => p.handle === 'chain-pendant-set' && Number(p.variant_count) > 0);
  const secondaryChain = prods.rows.find(p => p.handle === 'chain-pendent-set');

  if (primaryChain && secondaryChain) {
    // Sync status and published_at
    await pool.query(`
      UPDATE products
      SET status = 'active',
          published_at = COALESCE(published_at, NOW()),
          deleted_at = NULL
      WHERE id IN ($1, $2);
    `, [primaryChain.id, secondaryChain.id]);

    // If secondary has 0 variants, clone or link variants
    if (Number(secondaryChain.variant_count) === 0) {
      console.log('Cloning variants from primary to secondary chain...');
      const primaryVariants = await pool.query(`
        SELECT sku, title, option_label, option_value, price_paise, compare_at_paise, cost_paise, weight_grams, is_default, position, status
        FROM product_variants
        WHERE product_id = $1 AND status = 'active';
      `, [primaryChain.id]);

      for (const v of primaryVariants.rows) {
        await pool.query(`
          INSERT INTO product_variants (product_id, sku, title, option_label, option_value, price_paise, compare_at_paise, cost_paise, weight_grams, is_default, position, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (sku) DO NOTHING;
        `, [secondaryChain.id, `${v.sku}-ALT`, v.title, v.option_label, v.option_value, v.price_paise, v.compare_at_paise, v.cost_paise, v.weight_grams, v.is_default, v.position, v.status]);
      }
    }
  }

  // Make sure ALL active products have published_at set
  const pubFix = await pool.query(`
    UPDATE products
    SET published_at = NOW()
    WHERE status = 'active' AND published_at IS NULL
    RETURNING id, handle;
  `);
  console.log(`Updated published_at for ${pubFix.rows.length} products.`);

  // Flush redis cache
  const keys = await cache.keys('cat:v1:*');
  if (keys.length > 0) {
    await cache.del(...keys);
    console.log(`Flushed ${keys.length} keys from Redis.`);
  }

  await closeRedis();
  await pool.end();
  console.log('✅ Done!');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
