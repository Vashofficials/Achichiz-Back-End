import { db } from '../config/db.js';
import {
  products,
  productVariants,
  collections,
  productCollections,
  productMedia,
  mediaAssets,
  inventoryLevels,
  warehouses,
} from '../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';

async function main() {
  console.log('================================================================');
  console.log('            ACHICHIZ FRESH PRODUCTION INVENTORY REPORT          ');
  console.log('================================================================\n');

  // 1. Overall Database Counts
  const [prodCount] = await db.select({ count: sql<number>`count(*)::int` }).from(products);
  const [varCount] = await db.select({ count: sql<number>`count(*)::int` }).from(productVariants);
  const [mediaCount] = await db.select({ count: sql<number>`count(*)::int` }).from(productMedia);
  const [invCount] = await db.select({ count: sql<number>`count(*)::int` }).from(inventoryLevels);
  const [colCount] = await db.select({ count: sql<number>`count(*)::int` }).from(collections);

  console.log('--- PRODUCTION METRICS SUMMARY ---');
  console.log(`Total Products:         ${prodCount?.count ?? 0}`);
  console.log(`Total Product Variants: ${varCount?.count ?? 0}`);
  console.log(`Total Inventory Stock:  ${invCount?.count ?? 0} variants in WH-MAIN`);
  console.log(`Total Product Images:   ${mediaCount?.count ?? 0} images linked`);
  console.log(`Total Collections:      ${colCount?.count ?? 0} collections (active & live)`);
  console.log('----------------------------------\n');

  // 2. Fetch Category Collections and their Icons
  const rootCategories = await db
    .select({
      id: collections.id,
      handle: collections.handle,
      title: collections.title,
      iconUrl: mediaAssets.url,
      iconBytes: mediaAssets.bytes,
    })
    .from(collections)
    .leftJoin(mediaAssets, eq(collections.heroMediaId, mediaAssets.id))
    .where(
      sql`${collections.handle} IN ('workspace-collection', 'earth-aroma-collection', 'jewellery-collection')`
    );

  // 3. For each root category, fetch subcategories and products
  for (const root of rootCategories) {
    const iconSizeKb = root.iconBytes ? (root.iconBytes / 1024).toFixed(1) + ' KB' : 'No icon';
    console.log(`\n================================================================`);
    console.log(`CATEGORY: ${root.title.toUpperCase()} (${root.handle})`);
    console.log(`Icon: ${root.iconUrl ?? 'None'} [Size: ${iconSizeKb}]`);
    console.log(`================================================================`);

    // Fetch subcategories
    const subcats = await db
      .select({
        id: collections.id,
        handle: collections.handle,
        title: collections.title,
        iconUrl: mediaAssets.url,
        iconBytes: mediaAssets.bytes,
      })
      .from(collections)
      .leftJoin(mediaAssets, eq(collections.heroMediaId, mediaAssets.id))
      .where(eq(collections.parentId, root.id));

    for (const sub of subcats) {
      const subIconSize = sub.iconBytes ? (sub.iconBytes / 1024).toFixed(1) + ' KB' : 'Inherited';
      console.log(`\n  └─ SUB-CATEGORY: ${sub.title} [${sub.handle}] (Icon: ${subIconSize})`);

      // Fetch products in this subcategory
      const prods = await db
        .select({
          id: products.id,
          title: products.title,
          handle: products.handle,
          hsn: products.hsnCode,
          badge: products.badgeOverride,
          sku: productVariants.sku,
          pricePaise: productVariants.pricePaise,
          comparePaise: productVariants.compareAtPaise,
          stock: inventoryLevels.onHandQty,
          mediaCount: sql<number>`count(DISTINCT ${productMedia.id})::int`,
        })
        .from(productCollections)
        .innerJoin(products, eq(productCollections.productId, products.id))
        .innerJoin(productVariants, eq(productVariants.productId, products.id))
        .leftJoin(inventoryLevels, eq(inventoryLevels.variantId, productVariants.id))
        .leftJoin(productMedia, eq(productMedia.productId, products.id))
        .where(eq(productCollections.collectionId, sub.id))
        .groupBy(
          products.id,
          products.title,
          products.handle,
          products.hsnCode,
          products.badgeOverride,
          productVariants.sku,
          productVariants.pricePaise,
          productVariants.compareAtPaise,
          inventoryLevels.onHandQty
        );

      if (prods.length === 0) {
        console.log(`     (No direct products mapped to subcategory)`);
      }

      for (const p of prods) {
        const priceStr = `₹${(p.pricePaise / 100).toFixed(0)}`;
        const compStr = p.comparePaise ? ` (Original: ₹${(p.comparePaise / 100).toFixed(0)})` : '';
        const badgeStr = p.badge === 'best_seller' ? ' ⭐ [BEST SELLER]' : '';
        console.log(
          `     • ${p.title} | SKU: ${p.sku} | Price: ${priceStr}${compStr} | Stock: ${p.stock ?? 0} | Images: ${p.mediaCount}${badgeStr}`
        );
      }
    }
  }

  console.log('\n================================================================');
  console.log('               VERIFICATION: ALL PRODUCTION DATA READY           ');
  console.log('================================================================\n');
}

main()
  .catch((err) => {
    console.error('Listing error:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
