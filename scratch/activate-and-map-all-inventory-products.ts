import fs from 'fs';
import { pool } from '../src/config/db.js';
import { cache, closeRedis } from '../src/config/redis.js';

async function main() {
  console.log('🚀 Starting activation and comprehensive category/subcategory mapping...');

  // 1. Get default warehouse
  let whRes = await pool.query('SELECT id FROM warehouses LIMIT 1;');
  let warehouseId: string;
  if (whRes.rows.length === 0) {
    const newWh = await pool.query(`
      INSERT INTO warehouses (code, name, kind, is_active)
      VALUES ('WH-MAIN', 'Main Lucknow Warehouse', 'primary', true)
      RETURNING id;
    `);
    warehouseId = newWh.rows[0].id;
  } else {
    warehouseId = whRes.rows[0].id;
  }
  console.log(`Using Warehouse ID: ${warehouseId}`);

  // 2. Fetch all collections in DB
  const colRes = await pool.query('SELECT id, handle, title FROM collections;');
  const colMap = new Map<string, string>(); // handle -> id
  for (const c of colRes.rows) {
    colMap.set(c.handle, c.id);
  }
  console.log(`Loaded ${colMap.size} collections from DB.`);

  // 3. Define the taxonomy mapping: handle -> collection handles
  const taxonomy: Record<string, string[]> = {
    // Workspace (12)
    'bamboo-bottle': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'drinkware'],
    'bamboo-tumbler-with-handle': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'drinkware'],
    'wheat-fiber-mug': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'drinkware'],
    'mdf-diary': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'eco-stationery'],
    'cork-diary': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'eco-stationery'],
    'cork-flap-diary': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'eco-stationery'],
    'bamboo-diary': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'eco-stationery'],
    'bamboo-keychain': ['workspace-collection', 'all-bamboo-product-workspace-collection'],
    'cork-keychain': ['workspace-collection', 'all-bamboo-product-workspace-collection'],
    'cork-keychchain': ['workspace-collection', 'all-bamboo-product-workspace-collection'],
    'premium-bamboo-pen-with-box': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'eco-stationery'],
    'premium-bamboo-pen-with-gift-box': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'eco-stationery'],
    'cork-pen': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'eco-stationery'],
    'cork-card-holder': ['workspace-collection', 'all-bamboo-product-workspace-collection', 'eco-stationery'],

    // Earth & Aroma (8)
    'coconut-shell-candle': ['earth-aroma-collection', 'earth-aroma'],
    'cinnamon-stick-candle': ['earth-aroma-collection', 'earth-aroma'],
    'wooden-boat-candle': ['earth-aroma-collection', 'earth-aroma'],
    'soywax-sachet-hanging': ['earth-aroma-collection', 'earth-aroma'],
    'rose-candle': ['earth-aroma-collection', 'earth-aroma'],
    'daisy-jar-candle': ['earth-aroma-collection', 'earth-aroma'],
    'daisy-candle': ['earth-aroma-collection', 'earth-aroma'],
    'tea-light-candle': ['earth-aroma-collection', 'earth-aroma'],

    // Long Necklaces & Pendants (9)
    'circle-pendent-necklace-black': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'circle-pendant-necklace-black': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'hexagonal-pendent-golden-n-black': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'hexagonal-pendant-golden-and-black': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'kathakkali-theme-pendent-black-base': ['jewellery-collection', 'necklaces', 'necklaces-long', 'temple-jewellery'],
    'kathakali-pendant-necklace-black-base': ['jewellery-collection', 'necklaces', 'necklaces-long', 'temple-jewellery'],
    'kathakali-theme-pendant-black-base': ['jewellery-collection', 'necklaces', 'necklaces-long', 'temple-jewellery'],
    'bamboo-desing-pendent-black-base': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'bamboo-design-pendant-black-base': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'semicircle-pendent': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'semicircle-pendant': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'bluish-green-pendent': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'bluish-green-pendant': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'orange-yellow-pendent': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'orange-yellow-pendant': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'red-rectangle-pendent': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'red-rectangle-pendant': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'circle-pendent-necklace-pink-and-black': ['jewellery-collection', 'necklaces', 'necklaces-long'],
    'circle-pendant-necklace-pink-and-black': ['jewellery-collection', 'necklaces', 'necklaces-long'],

    // Necklace Sets Long (6)
    'grey-and-golden-set': ['jewellery-collection', 'necklaces', 'necklace-set-long'],
    'circular-bead-necklace-set-set-and-golden': ['jewellery-collection', 'necklaces', 'necklace-set-long'],
    'circular-bead-necklace-set-red-golden': ['jewellery-collection', 'necklaces', 'necklace-set-long'],
    'hollow-circular-pendent-lavender': ['jewellery-collection', 'necklaces', 'necklace-set-long'],
    'hollow-circular-pendant-lavender': ['jewellery-collection', 'necklaces', 'necklace-set-long'],
    'circular-pendent-lavender': ['jewellery-collection', 'necklaces', 'necklace-set-long'],
    'circular-pendant-lavender': ['jewellery-collection', 'necklaces', 'necklace-set-long'],
    'chain-pendent-set': ['jewellery-collection', 'necklaces', 'necklace-set-long'],
    'chain-pendant-set': ['jewellery-collection', 'necklaces', 'necklace-set-long'],
    'green-n-blue-set': ['jewellery-collection', 'necklaces', 'necklace-set-long'],
    'green-and-blue-set': ['jewellery-collection', 'necklaces', 'necklace-set-long'],

    // Short Necklace Sets & Chokers (6)
    'tringular-bead-choker-golden': ['jewellery-collection', 'necklaces', 'short-necklace-set'],
    'triangular-bead-choker-golden': ['jewellery-collection', 'necklaces', 'short-necklace-set'],
    'tringular-bead-choker-silver': ['jewellery-collection', 'necklaces', 'short-necklace-set'],
    'triangular-bead-choker-silver': ['jewellery-collection', 'necklaces', 'short-necklace-set'],
    'golden-n-blue-choker': ['jewellery-collection', 'necklaces', 'short-necklace-set'],
    'golden-and-blue-choker': ['jewellery-collection', 'necklaces', 'short-necklace-set'],
    'pink-n-silver-set': ['jewellery-collection', 'necklaces', 'short-necklace-set'],
    'pink-and-silver-set': ['jewellery-collection', 'necklaces', 'short-necklace-set'],
    'beaded-necklace-set': ['jewellery-collection', 'necklaces', 'short-necklace-set'],
    'silver-necklace-set': ['jewellery-collection', 'necklaces', 'short-necklace-set'],

    // Temple Jewellery (1)
    'temple-jewellery-set': ['jewellery-collection', 'necklaces', 'temple-jewellery'],

    // Drop Earrings (2)
    'circular-hoop-drop-earring': ['jewellery-collection', 'earrings', 'drop-earring'],
    'red-black-earring': ['jewellery-collection', 'earrings', 'drop-earring'],

    // Jhumkas (3)
    'bird-shaped-jhumka': ['jewellery-collection', 'earrings', 'jhumkas'],
    'bird-jhumka': ['jewellery-collection', 'earrings', 'jhumkas'],
    'striped-jhumka-mini-black-base': ['jewellery-collection', 'earrings', 'jhumkas'],
    'yellow-jhumka': ['jewellery-collection', 'earrings', 'jhumkas'],

    // Danglers (7)
    'blue-danglers-black-base': ['jewellery-collection', 'earrings', 'danglers'],
    'flower-dangler-black-and-golden': ['jewellery-collection', 'earrings', 'danglers'],
    'dotted-danglers': ['jewellery-collection', 'earrings', 'danglers'],
    'green-silver-danglers': ['jewellery-collection', 'earrings', 'danglers'],
    'pink-danglers': ['jewellery-collection', 'earrings', 'danglers'],
    'flower-drop-dangler-silver': ['jewellery-collection', 'earrings', 'danglers'],
    'silver-danglers': ['jewellery-collection', 'earrings', 'danglers'],
  };

  // 4. Update products, variants, inventory, and collection mappings
  let activatedCount = 0;
  const targetHandles = Object.keys(taxonomy);

  function getHsnForHandle(h: string): string {
    if (h.includes('candle') || h.includes('soywax')) return '3406';
    if (h.includes('diary') || h.includes('pen') || h.includes('card-holder')) return '4820';
    if (h.includes('bottle') || h.includes('tumbler') || h.includes('mug')) return '4419';
    if (h.includes('pendent') || h.includes('pendant') || h.includes('choker') || 
        h.includes('necklace') || h.includes('earring') || h.includes('jhumka') || 
        h.includes('dangler') || h.includes('set')) return '7418';
    return '4602';
  }

  for (const handle of targetHandles) {
    const hsn = getHsnForHandle(handle);

    // Check if a live product already exists for this handle
    const liveCheck = await pool.query(`
      SELECT id, handle, title, status, deleted_at, published_at, hsn_code
      FROM products
      WHERE handle = $1 AND deleted_at IS NULL;
    `, [handle]);

    let prod: any;

    if (liveCheck.rows.length > 0) {
      prod = liveCheck.rows[0];
      // Make sure it is active with valid HSN
      await pool.query(`
        UPDATE products
        SET status = 'active',
            hsn_code = COALESCE(hsn_code, $2),
            published_at = COALESCE(published_at, NOW())
        WHERE id = $1;
      `, [prod.id, hsn]);
    } else {
      // Find candidate rows for this handle
      const candidateRes = await pool.query(`
        SELECT id, handle, title, status, deleted_at, published_at, hsn_code
        FROM products
        WHERE handle = $1
        ORDER BY (status = 'active') DESC, (published_at IS NOT NULL) DESC;
      `, [handle]);

      if (candidateRes.rows.length === 0) {
        console.warn(`⚠️ No product found with handle: ${handle}`);
        continue;
      }

      prod = candidateRes.rows[0];

      // If other candidate rows exist with same handle, archive them first so un-deleting won't violate unique constraint
      for (let i = 1; i < candidateRes.rows.length; i++) {
        const dup = candidateRes.rows[i];
        await pool.query(`
          UPDATE products
          SET handle = 'dup-' || substring(id::text from 1 for 8) || '-' || $1
          WHERE id = $2;
        `, [handle, dup.id]);
      }

      // Now safely activate and un-delete the primary row with valid HSN
      await pool.query(`
        UPDATE products
        SET status = 'active',
            deleted_at = NULL,
            hsn_code = COALESCE(hsn_code, $2),
            published_at = COALESCE(published_at, NOW())
        WHERE id = $1;
      `, [prod.id, hsn]);
    }

    // Ensure active variant
    let varRes = await pool.query(`
      SELECT id, price_paise, status FROM product_variants WHERE product_id = $1 ORDER BY is_default DESC, id LIMIT 1;
    `, [prod.id]);

    let variantId: string;
    if (varRes.rows.length === 0) {
      const sku = `ACH-${handle.toUpperCase().replace(/[^A-Z0-9]/g, '-').slice(0, 15)}-STD`;
      // Check if SKU already exists
      const skuCheck = await pool.query(`SELECT id FROM product_variants WHERE sku = $1 LIMIT 1;`, [sku]);
      if (skuCheck.rows.length > 0) {
        variantId = skuCheck.rows[0].id;
        await pool.query(`
          UPDATE product_variants
          SET product_id = $1, status = 'active', deleted_at = NULL, is_default = true
          WHERE id = $2;
        `, [prod.id, variantId]);
      } else {
        const newVar = await pool.query(`
          INSERT INTO product_variants (product_id, sku, option_label, option_value, price_paise, is_default, position, status)
          VALUES ($1, $2, 'Standard', 'standard', 49900, true, 0, 'active')
          RETURNING id;
        `, [prod.id, sku]);
        variantId = newVar.rows[0].id;
      }
    } else {
      variantId = varRes.rows[0].id;
      await pool.query(`
        UPDATE product_variants
        SET status = 'active',
            deleted_at = NULL,
            is_default = true
        WHERE id = $1;
      `, [variantId]);
    }

    // Ensure inventory level
    const invCheck = await pool.query(`
      SELECT id, on_hand_qty, available_qty FROM inventory_levels WHERE variant_id = $1 AND warehouse_id = $2;
    `, [variantId, warehouseId]);

    if (invCheck.rows.length === 0) {
      await pool.query(`
        INSERT INTO inventory_levels (variant_id, warehouse_id, on_hand_qty, reserved_qty)
        VALUES ($1, $2, 50, 0)
        ON CONFLICT DO NOTHING;
      `, [variantId, warehouseId]);
    } else if (invCheck.rows[0].on_hand_qty < 10) {
      await pool.query(`
        UPDATE inventory_levels SET on_hand_qty = 50, reserved_qty = 0 WHERE id = $1;
      `, [invCheck.rows[0].id]);
    }

    // Map to collections
    const targetColHandles = taxonomy[handle] || [];
    for (const ch of targetColHandles) {
      const colId = colMap.get(ch);
      if (colId) {
        await pool.query(`
          INSERT INTO product_collections (product_id, collection_id, position)
          VALUES ($1, $2, 0)
          ON CONFLICT (product_id, collection_id) DO NOTHING;
        `, [prod.id, colId]);
      }
    }

    activatedCount++;
    console.log(`[${activatedCount}] Active & Mapped "${prod.title}" (${handle}) -> [${targetColHandles.join(', ')}]`);
  }

  // 5. Ensure the 5 collection headers and descriptions are clean in DB
  const colDetails: Record<string, { heading: string, subtext: string }> = {
    'all-bamboo-product-workspace-collection': {
      heading: 'All Bamboo Product (Workspace Collection)',
      subtext: 'Sustainable bamboo bottles, tumblers, notebooks, pens, and desk essentials.'
    },
    'eco-stationery': {
      heading: 'Eco Stationery',
      subtext: 'Handcrafted cork and bamboo diaries, flap notebooks, card holders, and pens.'
    },
    'earth-aroma-collection': {
      heading: 'Earth & Aroma Collection',
      subtext: 'Artisan soy wax scented candles poured into natural coconut shells and boat bowls.'
    },
    'jhumkas': {
      heading: 'Jhumkas',
      subtext: 'Lightweight handcrafted terracotta jhumkas with hand-painted ethnic patterns.'
    },
    'temple-jewellery': {
      heading: 'Temple Jewellery',
      subtext: 'Heritage-inspired temple jewellery sets and kathakali motif pendant designs.'
    }
  };

  for (const [ch, info] of Object.entries(colDetails)) {
    await pool.query(`
      UPDATE collections
      SET heading = $1, subtext = $2, status = 'live'
      WHERE handle = $3;
    `, [info.heading, info.subtext, ch]);
  }

  // 6. Flush Redis cache
  console.log('\n--- Invalidate Redis Catalogue Cache ---');
  try {
    const keys = await cache.keys('cat:v1:*');
    if (keys.length > 0) {
      await cache.del(...keys);
      console.log(`Flushed ${keys.length} keys from Redis.`);
    } else {
      console.log('No keys matched cat:v1:*.');
    }
  } catch (err) {
    console.warn('Redis clear warning:', err);
  }

  // 7. Verify live count for affected collections
  console.log('\n=== Verification: Live Products Per Collection ===');
  const verifyCols = [
    'all-bamboo-product-workspace-collection',
    'eco-stationery',
    'earth-aroma-collection',
    'jhumkas',
    'temple-jewellery',
    'drinkware',
    'earrings',
    'danglers',
    'drop-earring',
    'workspace-collection',
    'jewellery-collection',
    'necklaces',
    'necklaces-long',
    'necklace-set-long',
    'short-necklace-set',
  ];

  for (const ch of verifyCols) {
    const r = await pool.query(`
      SELECT c.title, c.handle,
             COUNT(DISTINCT p.id) as live_count,
             MIN(v.price_paise) as min_price,
             MAX(v.price_paise) as max_price
      FROM collections c
      LEFT JOIN product_collections pc ON pc.collection_id = c.id
      LEFT JOIN products p ON p.id = pc.product_id 
           AND p.status = 'active' 
           AND p.deleted_at IS NULL 
           AND p.published_at <= NOW()
      LEFT JOIN product_variants v ON v.product_id = p.id 
           AND v.status = 'active' 
           AND v.deleted_at IS NULL
      WHERE c.handle = $1
      GROUP BY c.title, c.handle;
    `, [ch]);

    if (r.rows.length > 0) {
      const row = r.rows[0];
      console.log(`✅ Collection "${row.title}" (${row.handle}): ${row.live_count} live products (Price: ₹${(row.min_price || 0) / 100} - ₹${(row.max_price || 0) / 100})`);
    }
  }

  await closeRedis();
  await pool.end();
  console.log('\n🎉 ALL COLLECTIONS SUCCESSFULLY ACTIVATED & SYNCHRONIZED!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
