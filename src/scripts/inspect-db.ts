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
  customers,
  orders,
  carts,
  reviews,
} from '../db/schema/index.js';
import { sql } from 'drizzle-orm';

async function main() {
  try {
    console.log('--- Inspecting Database Counts ---');
    const getCount = async (name: string, table: any) => {
      try {
        const res = await db.select({ count: sql<number>`count(*)::int` }).from(table);
        console.log(`${name}: ${res[0]?.count ?? 0}`);
      } catch (e: any) {
        console.log(`${name}: error (${e.message})`);
      }
    };

    await getCount('products', products);
    await getCount('productVariants', productVariants);
    await getCount('collections', collections);
    await getCount('productCollections', productCollections);
    await getCount('productMedia', productMedia);
    await getCount('mediaAssets', mediaAssets);
    await getCount('inventoryLevels', inventoryLevels);
    await getCount('warehouses', warehouses);
    await getCount('customers', customers);
    await getCount('orders', orders);
    await getCount('carts', carts);
    await getCount('reviews', reviews);

    console.log('\n--- Sample Collections ---');
    const existingCols = await db.select({ id: collections.id, handle: collections.handle, title: collections.title, kind: collections.kind, status: collections.status }).from(collections).limit(10);
    console.log(existingCols);

    console.log('\n--- Sample Products ---');
    const existingProds = await db.select({ id: products.id, handle: products.handle, title: products.title, status: products.status }).from(products).limit(10);
    console.log(existingProds);

    console.log('\n--- Warehouses ---');
    const existingWh = await db.select().from(warehouses);
    console.log(existingWh);

  } catch (err) {
    console.error('Inspect error:', err);
  } finally {
    process.exit(0);
  }
}

main();
