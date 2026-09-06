import { db, closeDb } from '../src/config/db.js';
import { collections, products, productVariants } from '../src/db/schema/catalogue.js';
import { mediaAssets } from '../src/db/schema/content.js';
import { warehouses, inventoryLevels } from '../src/db/schema/inventory.js';
import { sql, eq } from 'drizzle-orm';
import fs from 'fs';

async function seed() {
  console.log('Reading inventory dump...');
  const dump = JSON.parse(fs.readFileSync('inventory_dump.json', 'utf-8'));
  const items = dump.Sheet1 || [];

  let currentCategory: string | null = null;
  let currentSubCategory: string | null = null;
  let currentCategoryId: string | null = null;
  let currentSubCategoryId: string | null = null;

  // Get or Create Main Warehouse
  let warehouse = await db.query.warehouses.findFirst({
    where: eq(warehouses.isDefault, true)
  });
  if (!warehouse) {
    [warehouse] = await db.insert(warehouses).values({
      code: 'WH-MAIN',
      name: 'Main Warehouse',
      line1: '123 Main St',
      city: 'Mumbai',
      stateCode: '27',
      pincode: '400001',
      isDefault: true,
    }).returning();
  }
  const warehouseId = warehouse.id;
  console.log(`Using warehouse: ${warehouse.name} (${warehouseId})`);

  for (const row of items) {
    if (row['CATAGORIES']) {
      currentCategory = row['CATAGORIES'].trim();
      const handle = currentCategory.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      
      let col = await db.query.collections.findFirst({ where: eq(collections.handle, handle) });
      if (!col) {
        [col] = await db.insert(collections).values({
          handle,
          kind: 'category',
          title: currentCategory,
          status: 'live'
        }).returning();
        console.log(`Created Category: ${currentCategory}`);
      }
      currentCategoryId = col.id;
      currentSubCategoryId = null;
    }
    if (row['SUB CATEGORIES']) {
      currentSubCategory = row['SUB CATEGORIES'].trim();
      const handle = currentSubCategory.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      let col = await db.query.collections.findFirst({ where: eq(collections.handle, handle) });
      if (!col) {
        [col] = await db.insert(collections).values({
          handle,
          kind: 'category',
          title: currentSubCategory,
          parentId: currentCategoryId,
          status: 'live'
        }).returning();
        console.log(`Created Sub Category: ${currentSubCategory}`);
      }
      currentSubCategoryId = col.id;
    }

    if (row['PRODUCT NAME']) {
      const name = row['PRODUCT NAME'].trim();
      const shortDesc = row['SHORT DESCRIPTION'] || '';
      const longDesc = row['LONG DESCRIPTION'] || '';
      const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      
      let hsn = '4419'; // Default bamboo/wood
      if (name.toLowerCase().includes('diary')) hsn = '4820';
      if (name.toLowerCase().includes('candle')) hsn = '3406';
      if (currentCategory?.toLowerCase().includes('jewel') || name.toLowerCase().includes('pendent') || name.toLowerCase().includes('earring')) hsn = '7418';

      const collectionId = currentSubCategoryId || currentCategoryId;

      // Create or get media
      const storageKey = `seeded/${handle}.jpg`;
      const mediaUrl = `https://picsum.photos/seed/${handle}/800/800`;
      let media = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.storageKey, storageKey) });
      if (!media) {
        [media] = await db.insert(mediaAssets).values({
          storageKey,
          url: mediaUrl,
          filename: `${handle}.jpg`,
          mimeType: 'image/jpeg',
          kind: 'image',
          bytes: 150000,
          altText: name,
        }).returning();
      }

      // Create or get product
      let product = await db.query.products.findFirst({ where: eq(products.handle, handle) });
      if (!product) {
        console.log(`Creating Product: ${name}`);
        [product] = await db.insert(products).values({
          handle,
          title: name,
          description: longDesc || shortDesc,
          subtitle: shortDesc.substring(0, 100),
          primaryCollectionId: collectionId,
          hsnCode: hsn,
          status: 'active',
          publishedAt: new Date(),
          kind: 'single_gift',
        }).returning();
      }

      // Generate variant
      const sku = `${handle}-std`.toUpperCase();
      let variant = await db.query.productVariants.findFirst({ where: eq(productVariants.productId, product.id) });
      if (!variant) {
        [variant] = await db.insert(productVariants).values({
          productId: product.id,
          sku,
          pricePaise: 99900 + Math.floor(Math.random() * 200000), // Random price 999 - 2999
          status: 'active',
          weightGrams: 500,
        }).returning();
      }

      let invLevel = await db.query.inventoryLevels.findFirst({
        where: sql`variant_id = ${variant.id} AND warehouse_id = ${warehouseId}`
      });
      if (!invLevel) {
        await db.insert(inventoryLevels).values({
          variantId: variant.id,
          warehouseId,
          onHandQty: 100,
          incomingQty: 0,
          reorderPoint: 10,
          reorderQty: 50
        });
      }
      
      // Update the product's primary media
      try {
        await db.execute(sql`
          INSERT INTO product_media (product_id, media_id, position)
          VALUES (${product.id}, ${media.id}, 0)
          ON CONFLICT DO NOTHING
        `);
      } catch (e) {
        // Ignored
      }
    }
  }

  console.log('Seeding complete.');
  await closeDb();
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
