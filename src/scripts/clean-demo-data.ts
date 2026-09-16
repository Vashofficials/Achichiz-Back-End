import { db } from '../config/db.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('=== STARTING DATABASE CLEANUP: REMOVING DEMO / DUMMY DATA ===\n');

  // 1. Clean Orders, Payments, and Carts
  console.log('1. Cleaning test orders, carts, and transactions...');
  await db.execute(sql`UPDATE carts SET stage = 'cart', converted_order_id = NULL;`);
  await db.execute(sql`DELETE FROM cart_line_add_ons;`);
  await db.execute(sql`DELETE FROM cart_lines;`);
  await db.execute(sql`DELETE FROM carts;`);
  await db.execute(sql`DELETE FROM order_line_personalisations;`);
  await db.execute(sql`DELETE FROM order_line_add_ons;`);
  await db.execute(sql`DELETE FROM order_lines;`);
  await db.execute(sql`DELETE FROM order_timeline;`);
  await db.execute(sql`DELETE FROM invoice_lines;`);
  await db.execute(sql`DELETE FROM invoices;`);
  await db.execute(sql`DELETE FROM credit_note_lines;`);
  await db.execute(sql`DELETE FROM credit_notes;`);
  await db.execute(sql`DELETE FROM payments;`);
  await db.execute(sql`DELETE FROM orders;`);
  console.log('✓ Orders, order lines, timeline, payments, invoices, and carts cleaned.');

  // 2. Clean Existing Products & Inventory to ensure clean slate
  console.log('\n2. Cleaning any lingering products, variants, and inventory...');
  await db.execute(sql`DELETE FROM product_collections;`);
  await db.execute(sql`DELETE FROM product_media;`);
  await db.execute(sql`DELETE FROM product_content_items;`);
  await db.execute(sql`DELETE FROM product_stats;`);
  await db.execute(sql`DELETE FROM inventory_levels;`);
  await db.execute(sql`DELETE FROM product_variants;`);
  await db.execute(sql`DELETE FROM products;`);
  console.log('✓ Products, variants, inventory levels, and product media cleaned.');

  // 3. Clean Test Customers while preserving verified founder/admin accounts
  console.log('\n3. Cleaning dummy / test customers...');
  await db.execute(sql`
    DELETE FROM customer_sessions WHERE customer_id NOT IN (
      SELECT id FROM customers WHERE email IN ('founder@achichiz.in', 'achichizofficial@gmail.com', 'vashtechnical@gmail.com', 'roview101@gmail.com', 'telu221712@gmail.com')
    );
  `);
  await db.execute(sql`
    DELETE FROM customer_auth_events WHERE customer_id NOT IN (
      SELECT id FROM customers WHERE email IN ('founder@achichiz.in', 'achichizofficial@gmail.com', 'vashtechnical@gmail.com', 'roview101@gmail.com', 'telu221712@gmail.com')
    );
  `);
  await db.execute(sql`
    DELETE FROM customer_stats WHERE customer_id NOT IN (
      SELECT id FROM customers WHERE email IN ('founder@achichiz.in', 'achichizofficial@gmail.com', 'vashtechnical@gmail.com', 'roview101@gmail.com', 'telu221712@gmail.com')
    );
  `);
  await db.execute(sql`
    DELETE FROM wishlist_items WHERE customer_id NOT IN (
      SELECT id FROM customers WHERE email IN ('founder@achichiz.in', 'achichizofficial@gmail.com', 'vashtechnical@gmail.com', 'roview101@gmail.com', 'telu221712@gmail.com')
    );
  `);
  await db.execute(sql`
    DELETE FROM addresses WHERE customer_id NOT IN (
      SELECT id FROM customers WHERE email IN ('founder@achichiz.in', 'achichizofficial@gmail.com', 'vashtechnical@gmail.com', 'roview101@gmail.com', 'telu221712@gmail.com')
    );
  `);
  await db.execute(sql`
    DELETE FROM customers WHERE email NOT IN ('founder@achichiz.in', 'achichizofficial@gmail.com', 'vashtechnical@gmail.com', 'roview101@gmail.com', 'telu221712@gmail.com') OR email IS NULL;
  `);
  console.log('✓ Dummy customer accounts cleaned, preserving production founder/admin accounts.');

  // 4. Clean Dummy Collections
  console.log('\n4. Cleaning QA and demo collections...');
  await db.execute(sql`
    DELETE FROM collections
    WHERE handle LIKE 'qa-%'
       OR handle LIKE 'audit-%'
       OR handle LIKE 'zztest-%'
       OR handle IN (
         'antigravity-collection',
         'api-demo-collection',
         'demo-sustainable-gifts',
         'earth-aroma',
         'drinkware',
         'earrings',
         'eco-stationery',
         'necklaces'
       );
  `);
  console.log('✓ QA / Demo collections removed.');

  // 5. Clean Dummy Designers & Ensure Official Achichiz Brand
  console.log('\n5. Cleaning QA designers and ensuring Achichiz brand...');
  await db.execute(sql`
    DELETE FROM designers
    WHERE handle LIKE 'qa-%'
       OR handle LIKE 'zztest-%'
       OR handle LIKE 'audit-%'
       OR handle = 'api-demo-product';
  `);
  await db.execute(sql`
    DELETE FROM designers WHERE handle = 'achichiz';
    INSERT INTO designers (handle, name, kind, status)
    VALUES ('achichiz', 'Achichiz', 'brand', 'active');
  `);
  console.log('✓ Brand "achichiz" ensured.');

  // 6. Clean Dummy Warehouses
  console.log('\n6. Cleaning QA warehouses and ensuring Main Warehouse...');
  await db.execute(sql`
    DELETE FROM warehouses
    WHERE code LIKE 'QA%'
       OR code LIKE 'qa%'
       OR code IN ('DEMO-LKO-01', 'ZZTEST-WH');
  `);
  await db.execute(sql`
    UPDATE warehouses
    SET is_default = true, status = 'active'
    WHERE code = 'WH-MAIN';
  `);
  console.log('✓ Warehouses cleaned; WH-MAIN is active and default.');

  // 7. Clean Old Orphaned Demo Media Assets
  console.log('\n7. Cleaning old seeded/demo media assets...');
  await db.execute(sql`
    DELETE FROM media_assets
    WHERE storage_key LIKE 'seeded/%'
       OR storage_key LIKE 'uploads/01M1%';
  `);
  console.log('✓ Old stub media assets cleaned.');

  // 8. Ensure HSN Code for Jewellery Exists
  console.log('\n8. Ensuring HSN codes for catalogue exist...');
  await db.execute(sql`
    INSERT INTO hsn_codes (code, description, is_service)
    VALUES 
      ('7117', 'Imitation jewellery; handcrafted terracotta and bead jewellery', false),
      ('3406', 'Candles, tapers and the like', false),
      ('4820', 'Registers, notebooks, diaries and similar articles of paper', false),
      ('4419', 'Tableware and kitchenware of wood and bamboo', false),
      ('4420', 'Wood marquetry; caskets and cases for jewellery or cutlery', false),
      ('4602', 'Basketwork and wickerwork made from bamboo and plaiting materials', false)
    ON CONFLICT (code) DO UPDATE
      SET description = EXCLUDED.description;
  `);
  console.log('✓ HSN codes verified and inserted.');

  // 9. Clean Activity Logs
  console.log('\n9. Cleaning test activity logs...');
  await db.execute(sql`DELETE FROM activity_logs;`);
  console.log('✓ Activity logs reset.');

  console.log('\n=== TASK 1 COMPLETED: ALL DUMMY DATA HAS BEEN CLEANED ===\n');
}

main()
  .catch((err) => {
    console.error('Fatal cleanup error:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
