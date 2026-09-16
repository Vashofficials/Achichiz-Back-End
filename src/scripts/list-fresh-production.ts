import { pool, closeDb } from '../config/db.js';

async function listProduction() {
  console.log('================================================================');
  console.log('              ACHICHIZ FRESH PRODUCTION CATALOGUE               ');
  console.log('================================================================\n');

  // Query Collections
  const { rows: collections } = await pool.query<{
    id: string;
    handle: string;
    title: string;
    parent_id: string | null;
    hero_url: string | null;
    hero_bytes: number | null;
  }>(`
    SELECT c.id, c.handle, c.title, c.parent_id, m.url as hero_url, m.bytes as hero_bytes
    FROM collections c
    LEFT JOIN media_assets m ON m.id = c.hero_media_id
    WHERE c.deleted_at IS NULL AND c.kind = 'category'
    ORDER BY c.parent_id NULLS FIRST, c.sort_order, c.title;
  `);

  // Query Products with variants, prices, stock, primary image, and subcategories
  const { rows: products } = await pool.query<{
    id: string;
    handle: string;
    title: string;
    status: string;
    sku: string;
    price_paise: number;
    compare_at_paise: number;
    stock: number;
    primary_image_url: string | null;
    total_images: number;
    primary_collection_id: string | null;
    collection_handles: string[];
  }>(`
    SELECT
      p.id,
      p.handle,
      p.title,
      p.status,
      v.sku,
      v.price_paise,
      v.compare_at_paise,
      coalesce(il.available_qty, 0) as stock,
      (
        SELECT coalesce(m.cdn_url, m.url)
        FROM product_media pm
        JOIN media_assets m ON m.id = pm.media_id
        WHERE pm.product_id = p.id AND m.deleted_at IS NULL
        ORDER BY pm.position, pm.id
        LIMIT 1
      ) as primary_image_url,
      (
        SELECT count(*)::int
        FROM product_media pm
        WHERE pm.product_id = p.id
      ) as total_images,
      p.primary_collection_id,
      array(
        SELECT c.handle
        FROM product_collections pc
        JOIN collections c ON c.id = pc.collection_id
        WHERE pc.product_id = p.id
      ) as collection_handles
    FROM products p
    JOIN product_variants v ON v.product_id = p.id AND v.is_default = true AND v.deleted_at IS NULL
    LEFT JOIN inventory_levels il ON il.variant_id = v.id
    WHERE p.deleted_at IS NULL
    ORDER BY p.title;
  `);

  const roots = collections.filter(c => !c.parent_id);
  const children = collections.filter(c => c.parent_id);

  console.log(`Summary Statistics:`);
  console.log(` - Total Active Products: ${products.length}`);
  console.log(` - Root Categories: ${roots.length}`);
  console.log(` - Subcategories: ${children.length}`);
  console.log('----------------------------------------------------------------\n');

  for (const root of roots) {
    const iconKb = root.hero_bytes ? (root.hero_bytes / 1024).toFixed(1) : 'N/A';
    console.log(`📁 CATEGORY: [${root.title}] (handle: ${root.handle})`);
    console.log(`   Icon: ${root.hero_url || 'No Icon'} (${iconKb} KB, < 30KB: ${root.hero_bytes && root.hero_bytes < 30720 ? '✅' : '❌'})`);

    const subCats = children.filter(c => c.parent_id === root.id);

    for (const sub of subCats) {
      const subIconKb = sub.hero_bytes ? (sub.hero_bytes / 1024).toFixed(1) : 'N/A';
      console.log(`\n   📂 SUBCATEGORY: ${sub.title} (handle: ${sub.handle})`);
      console.log(`      Icon: ${sub.hero_url || 'No Icon'} (${subIconKb} KB, < 30KB: ${sub.hero_bytes && sub.hero_bytes < 30720 ? '✅' : '❌'})`);

      const prodsInSub = products.filter(p => p.collection_handles.includes(sub.handle));
      if (prodsInSub.length === 0) {
        console.log(`      (No direct products in subcategory)`);
      }
      for (const prod of prodsInSub) {
        const priceInr = (prod.price_paise / 100).toFixed(0);
        const compareInr = prod.compare_at_paise ? (prod.compare_at_paise / 100).toFixed(0) : null;
        const discount = compareInr ? ` (${compareInr} -> ₹${priceInr})` : ` (₹${priceInr})`;
        console.log(`       - 🛍️  ${prod.title}`);
        console.log(`            Handle: ${prod.handle} | SKU: ${prod.sku}`);
        console.log(`            Price: ₹${priceInr}${discount} | Stock: ${prod.stock} | Images: ${prod.total_images}`);
        console.log(`            Primary Image: ${prod.primary_image_url || 'No Image'}`);
      }
    }

    // Products belonging to root but not mapped to subcategory
    const rootDirectProds = products.filter(p => 
      p.collection_handles.includes(root.handle) && 
      !subCats.some(s => p.collection_handles.includes(s.handle))
    );

    if (rootDirectProds.length > 0) {
      console.log(`\n   📂 DIRECT PRODUCTS IN ${root.title}:`);
      for (const prod of rootDirectProds) {
        const priceInr = (prod.price_paise / 100).toFixed(0);
        console.log(`       - 🛍️  ${prod.title} | Handle: ${prod.handle} | SKU: ${prod.sku} | ₹${priceInr} | Stock: ${prod.stock} | Images: ${prod.total_images}`);
      }
    }

    console.log('\n================================================================\n');
  }

  await closeDb();
}

listProduction().catch(err => {
  console.error('Failed to list production catalogue:', err);
  process.exit(1);
});
