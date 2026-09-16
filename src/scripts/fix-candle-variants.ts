import { db } from '../config/db.js';
import { products, productVariants, inventoryLevels, warehouses } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

async function main() {
  console.log('--- Fixing Candle Prices & Multiple Pack Variants ---');

  const [wh] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, 'WH-MAIN'));
  if (!wh) throw new Error('Warehouse WH-MAIN not found');
  const whId = wh.id;

  // 1. Fix Daisy Jar Candle
  const [jarCandle] = await db.select().from(products).where(eq(products.handle, 'daisy-jar-candle'));
  if (jarCandle) {
    await db
      .update(productVariants)
      .set({
        pricePaise: 14900,
        compareAtPaise: 17200,
        optionLabel: 'Pack of 2',
        optionValue: 'pack-of-2',
      })
      .where(eq(productVariants.productId, jarCandle.id));
    console.log('✓ Fixed Daisy Jar Candle: ₹149 (was ₹1492)');
  }

  // 2. Fix Tea Light Candle (Add Pack of 6 and Pack of 12)
  const [teaLight] = await db.select().from(products).where(eq(products.handle, 'tea-light-candle'));
  if (teaLight) {
    // Delete existing variants
    const oldVars = await db.select().from(productVariants).where(eq(productVariants.productId, teaLight.id));
    for (const ov of oldVars) {
      await db.delete(inventoryLevels).where(eq(inventoryLevels.variantId, ov.id));
    }
    await db.delete(productVariants).where(eq(productVariants.productId, teaLight.id));

    // Variant 1: Pack of 6
    const [v1] = await db
      .insert(productVariants)
      .values({
        productId: teaLight.id,
        sku: 'ACH-TEAL-CND-PK6-008',
        optionLabel: 'Pack of 6',
        optionValue: 'pack-of-6',
        pricePaise: 4900,
        compareAtPaise: 6000,
        isDefault: true,
        position: 0,
        status: 'active',
      })
      .returning();

    if (v1) {
      await db.insert(inventoryLevels).values({
        variantId: v1.id,
        warehouseId: whId,
        onHandQty: 50,
        reservedQty: 0,
      });
    }

    // Variant 2: Pack of 12
    const [v2] = await db
      .insert(productVariants)
      .values({
        productId: teaLight.id,
        sku: 'ACH-TEAL-CND-PK12-008',
        optionLabel: 'Pack of 12',
        optionValue: 'pack-of-12',
        pricePaise: 9900,
        compareAtPaise: 11000,
        isDefault: false,
        position: 1,
        status: 'active',
      })
      .returning();

    if (v2) {
      await db.insert(inventoryLevels).values({
        variantId: v2.id,
        warehouseId: whId,
        onHandQty: 50,
        reservedQty: 0,
      });
    }

    console.log('✓ Fixed Tea Light Candle: Pack of 6 (₹49) & Pack of 12 (₹99)');
  }

  // 3. Fix Daisy Candle (Single, Pack of 6, Pack of 12)
  const [daisyCandle] = await db.select().from(products).where(eq(products.handle, 'daisy-candle'));
  if (daisyCandle) {
    const oldVars = await db.select().from(productVariants).where(eq(productVariants.productId, daisyCandle.id));
    for (const ov of oldVars) {
      await db.delete(inventoryLevels).where(eq(inventoryLevels.variantId, ov.id));
    }
    await db.delete(productVariants).where(eq(productVariants.productId, daisyCandle.id));

    // Variant 1: Single Piece
    const [dv1] = await db
      .insert(productVariants)
      .values({
        productId: daisyCandle.id,
        sku: 'ACH-DAIS-CND-SGL-007',
        optionLabel: 'Single Piece',
        optionValue: 'single-piece',
        pricePaise: 3000,
        compareAtPaise: 3500,
        isDefault: true,
        position: 0,
        status: 'active',
      })
      .returning();

    if (dv1) {
      await db.insert(inventoryLevels).values({
        variantId: dv1.id,
        warehouseId: whId,
        onHandQty: 50,
        reservedQty: 0,
      });
    }

    // Variant 2: Pack of 6
    const [dv2] = await db
      .insert(productVariants)
      .values({
        productId: daisyCandle.id,
        sku: 'ACH-DAIS-CND-PK6-007',
        optionLabel: 'Pack of 6',
        optionValue: 'pack-of-6',
        pricePaise: 14900,
        compareAtPaise: 17500,
        isDefault: false,
        position: 1,
        status: 'active',
      })
      .returning();

    if (dv2) {
      await db.insert(inventoryLevels).values({
        variantId: dv2.id,
        warehouseId: whId,
        onHandQty: 50,
        reservedQty: 0,
      });
    }

    // Variant 3: Pack of 12
    const [dv3] = await db
      .insert(productVariants)
      .values({
        productId: daisyCandle.id,
        sku: 'ACH-DAIS-CND-PK12-007',
        optionLabel: 'Pack of 12',
        optionValue: 'pack-of-12',
        pricePaise: 20000,
        compareAtPaise: 23000,
        isDefault: false,
        position: 2,
        status: 'active',
      })
      .returning();

    if (dv3) {
      await db.insert(inventoryLevels).values({
        variantId: dv3.id,
        warehouseId: whId,
        onHandQty: 50,
        reservedQty: 0,
      });
    }

    console.log('✓ Fixed Daisy Candle: Single (₹30), Pack of 6 (₹149), Pack of 12 (₹200)');
  }

  // 4. Fix Temple Jewellery SKU
  const [templeJewel] = await db.select().from(products).where(eq(products.handle, 'temple-jewellery-set'));
  if (templeJewel) {
    await db
      .update(productVariants)
      .set({ sku: 'ACH-TERR-TMP-NKL-022' })
      .where(eq(productVariants.productId, templeJewel.id));
    console.log('✓ Fixed Temple Jewellery SKU: ACH-TERR-TMP-NKL-022');
  }

  console.log('\n--- All Candle and SKU Corrections Completed ---');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
