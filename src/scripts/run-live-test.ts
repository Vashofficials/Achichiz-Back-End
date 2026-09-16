import http from 'node:http';
import { pool, closeDb } from '../config/db.js';
import { cache } from '../config/redis.js';
import { createApp } from '../app.js';

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  detail?: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, suite: string, name: string, detail?: string) {
  if (condition) {
    results.push({ suite, name, passed: true });
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    results.push({ suite, name, passed: false, detail });
    console.error(`  ❌ [FAIL] ${name}: ${detail ?? 'Assertion failed'}`);
  }
}

async function runLiveTest() {
  console.log('================================================================');
  console.log('         ACHICHIZ PRODUCTION LIVE SYSTEM VERIFICATION           ');
  console.log('================================================================\n');

  // ──────────────────────────────────────────────────────────────────────────
  // 1. DATABASE DATA INTEGRITY & CLEANUP VERIFICATION
  // ──────────────────────────────────────────────────────────────────────────
  console.log('🔍 SUITE 1: Production Database State & Cleanup Integrity');

  // 1.1 Customer accounts preserved
  const { rows: customers } = await pool.query<{ email: string }>(
    `SELECT email FROM customers WHERE deleted_at IS NULL ORDER BY email;`
  );
  assert(
    customers.length === 5,
    'Database Integrity',
    'Exactly 5 genuine customer accounts preserved',
    `Found ${customers.length} customers: ${customers.map((c) => c.email).join(', ')}`
  );

  // 1.2 Super admin accounts preserved
  const { rows: admins } = await pool.query<{ email: string }>(
    `SELECT su.email FROM staff_users su JOIN roles r ON r.id = su.role_id WHERE r.key = 'super_admin' AND su.deleted_at IS NULL;`
  );
  assert(
    admins.length === 3,
    'Database Integrity',
    'Exactly 3 genuine active super admin accounts preserved',
    `Found ${admins.length} admins: ${admins.map((a) => a.email).join(', ')}`
  );

  // 1.3 Dummy test staff purged
  const { rows: testStaff } = await pool.query<{ count: string }>(
    `SELECT count(*)::text as count FROM staff_users WHERE email LIKE '%@example.test';`
  );
  assert(
    testStaff[0]?.count === '0',
    'Database Integrity',
    'All dummy QA test staff accounts purged (0 found)',
    `Found ${testStaff[0]?.count ?? '0'} test staff accounts`
  );

  // 1.4 Dummy transactions purged (orders, carts, payments)
  const { rows: orderCount } = await pool.query<{ count: string }>(`SELECT count(*)::text as count FROM orders;`);
  const { rows: cartCount } = await pool.query<{ count: string }>(`SELECT count(*)::text as count FROM carts;`);
  const { rows: paymentCount } = await pool.query<{ count: string }>(`SELECT count(*)::text as count FROM payments;`);
  assert(
    orderCount[0]?.count === '0',
    'Database Integrity',
    'Orders table purged of dummy/test orders (0 found)',
    `Found ${orderCount[0]?.count ?? '0'} orders`
  );
  assert(
    cartCount[0]?.count === '0',
    'Database Integrity',
    'Carts table purged of dummy/test carts (0 found)',
    `Found ${cartCount[0]?.count ?? '0'} carts`
  );
  assert(
    paymentCount[0]?.count === '0',
    'Database Integrity',
    'Payments table purged of dummy/test payments (0 found)',
    `Found ${paymentCount[0]?.count ?? '0'} payments`
  );

  // 1.5 Products count
  const { rows: prodCount } = await pool.query<{ count: string }>(
    `SELECT count(*)::text as count FROM products WHERE status = 'active' AND deleted_at IS NULL;`
  );
  assert(
    prodCount[0]?.count === '54',
    'Database Integrity',
    'Fresh production catalogue has exactly 54 active products',
    `Found ${prodCount[0]?.count ?? '0'} active products`
  );

  // 1.6 Product variants count & pricing
  const { rows: varCount } = await pool.query<{ count: string; min_price: number; max_price: number }>(
    `SELECT count(*)::text as count, min(price_paise)::int as min_price, max(price_paise)::int as max_price
     FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     WHERE p.status = 'active';`
  );
  assert(
    varCount[0]?.count === '54',
    'Database Integrity',
    'All 54 active products have default variants created',
    `Found ${varCount[0]?.count ?? '0'} variants`
  );
  assert(
    (varCount[0]?.min_price ?? 0) > 0,
    'Database Integrity',
    'All variants have valid positive integer paise prices (min > ₹0)',
    `Min price: ₹${(varCount[0]?.min_price ?? 0) / 100}, Max price: ₹${(varCount[0]?.max_price ?? 0) / 100}`
  );

  // 1.7 Inventory levels count & available quantity
  const { rows: invCount } = await pool.query<{ count: string; min_avail: number }>(
    `SELECT count(*)::text as count, min(available_qty)::int as min_avail
     FROM inventory_levels il
     JOIN product_variants pv ON pv.id = il.variant_id
     JOIN warehouses w ON w.id = il.warehouse_id
     WHERE w.code = 'WH-MAIN';`
  );
  assert(
    invCount[0]?.count === '54',
    'Database Integrity',
    'All 54 variants mapped in WH-MAIN warehouse',
    `Found ${invCount[0]?.count ?? '0'} inventory records`
  );
  assert(
    invCount[0]?.min_avail === 50,
    'Database Integrity',
    'All warehouse inventory levels initialized with available_qty = 50',
    `Min available qty: ${invCount[0]?.min_avail ?? 0}`
  );

  // 1.8 Product collections & media links
  const { rows: collLinks } = await pool.query<{ count: string }>(`SELECT count(*)::text as count FROM product_collections;`);
  const { rows: mediaLinks } = await pool.query<{ count: string }>(`SELECT count(*)::text as count FROM product_media;`);
  assert(
    parseInt(collLinks[0]?.count ?? '0', 10) >= 54,
    'Database Integrity',
    `Product-Collection mappings intact (${collLinks[0]?.count ?? '0'} links found)`
  );
  assert(
    parseInt(mediaLinks[0]?.count ?? '0', 10) >= 100,
    'Database Integrity',
    `Product-Media mappings intact (${mediaLinks[0]?.count ?? '0'} images linked)`
  );

  // 1.9 CMS Content (Banners, Sections, Testimonials, FAQs)
  const { rows: bannerCount } = await pool.query<{ count: string }>(
    `SELECT count(*)::text as count FROM banners WHERE status = 'live';`
  );
  const { rows: faqCount } = await pool.query<{ count: string }>(
    `SELECT count(*)::text as count FROM faqs WHERE deleted_at IS NULL;`
  );
  const { rows: testCount } = await pool.query<{ count: string }>(
    `SELECT count(*)::text as count FROM testimonials;`
  );
  assert(
    bannerCount[0]?.count === '5',
    'Database Integrity',
    'Exactly 5 live storefront banners configured',
    `Found ${bannerCount[0]?.count ?? '0'} banners`
  );
  assert(
    faqCount[0]?.count === '13',
    'Database Integrity',
    'Storefront active FAQs populated (13 active FAQs found)',
    `Found ${faqCount[0]?.count ?? '0'} FAQs`
  );
  assert(
    testCount[0]?.count === '8',
    'Database Integrity',
    'Storefront Testimonials populated (8 testimonials found)',
    `Found ${testCount[0]?.count ?? '0'} testimonials`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // 2. CATEGORY ICON FILE SIZE & FORMAT (< 30KB VERIFICATION)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n🎨 SUITE 2: Category Icon Size Constraint (< 30KB)');

  const { rows: categoryIcons } = await pool.query<{
    handle: string;
    title: string;
    url: string;
    bytes: number;
    mime: string;
  }>(`
    SELECT c.handle, c.title, m.url, m.bytes, m.mime_type as mime
    FROM collections c
    JOIN media_assets m ON m.id = c.hero_media_id
    WHERE c.deleted_at IS NULL
    ORDER BY c.title;
  `);

  assert(
    categoryIcons.length >= 10,
    'Icon Constraints',
    `Found ${categoryIcons.length} collections with linked icon media`,
    `Total collections with icons: ${categoryIcons.length}`
  );

  let allIconsUnder30Kb = true;
  let allIconsWebp = true;

  for (const icon of categoryIcons) {
    const sizeKb = (icon.bytes / 1024).toFixed(1);
    const isUnder30 = icon.bytes < 30 * 1024;
    const isWebp = icon.mime === 'image/webp' || icon.url.endsWith('.webp');
    if (!isUnder30) allIconsUnder30Kb = false;
    if (!isWebp) allIconsWebp = false;

    console.log(`    • ${icon.title.padEnd(28)} -> ${sizeKb.padStart(4)} KB [${icon.mime}] ${isUnder30 ? '✅' : '❌'}`);
  }

  assert(
    allIconsUnder30Kb,
    'Icon Constraints',
    'ALL category & subcategory icons are strictly UNDER 30KB',
    'Every icon file size in S3 media_assets is < 30,720 bytes'
  );
  assert(
    allIconsWebp,
    'Icon Constraints',
    'ALL category icons use modern WebP format for fast web delivery',
    'MIME type image/webp verified'
  );

  // ──────────────────────────────────────────────────────────────────────────
  // 3. LIVE HTTP API ENDPOINTS TEST (STANDALONE EXPRESS INSTANCE)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n🌐 SUITE 3: Live Express API Endpoints & Contract Verification');

  // Stub cache for live test if redis is offline locally
  (cache as any).call = async (...args: any[]) => {
    const cmd = String(args[0] ?? '').toUpperCase();
    if (cmd === 'SCRIPT') {
      return 'b3f5e27a9c1d0e4f8b2a5c7d9e1f3a5b7c9d1e3f';
    }
    if (cmd === 'EVALSHA' || cmd === 'EVAL') {
      return [1, 60000];
    }
    return 'OK';
  };
  (cache as any).get = async () => null;
  (cache as any).set = async () => 'OK';
  (cache as any).del = async () => 1;

  const app = createApp();
  const testPort = 39871;
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(testPort, '127.0.0.1', () => {
      resolve();
    });
  });

  const baseUrl = `http://127.0.0.1:${testPort}`;

  try {
    // 3.1 Healthz Liveness
    const resHealth = await fetch(`${baseUrl}/healthz`);
    const jsonHealth = (await resHealth.json()) as any;
    assert(
      resHealth.status === 200 && jsonHealth.type === 'success' && jsonHealth.result?.status === 'ok',
      'API Endpoints',
      'GET /healthz returns 200 OK with success envelope',
      JSON.stringify(jsonHealth)
    );

    // 3.2 Storefront Products
    const resProd = await fetch(`${baseUrl}/v1/products?perPage=5`);
    const jsonProd = (await resProd.json()) as any;
    assert(
      resProd.status === 200 && jsonProd.type === 'success' && Array.isArray(jsonProd.result),
      'API Endpoints',
      'GET /v1/products returns 200 OK with standardized { type: success, result } payload',
      `Items returned: ${jsonProd.result?.length}`
    );
    assert(
      jsonProd.result?.length === 5,
      'API Endpoints',
      'GET /v1/products?perPage=5 returns exactly 5 items',
      `Count: ${jsonProd.result?.length}`
    );

    // Verify first product item structure
    const firstProduct = jsonProd.result[0];
    assert(
      firstProduct && typeof firstProduct.title === 'string' && typeof firstProduct.handle === 'string',
      'API Endpoints',
      `Product structure valid (${firstProduct?.title}, handle: ${firstProduct?.handle})`
    );

    // 3.3 Storefront Product Detail by Handle
    const resDetail = await fetch(`${baseUrl}/v1/products/bamboo-bottle`);
    const jsonDetail = (await resDetail.json()) as any;
    assert(
      resDetail.status === 200 && jsonDetail.type === 'success' && jsonDetail.result?.handle === 'bamboo-bottle',
      'API Endpoints',
      'GET /v1/products/bamboo-bottle returns 200 OK with full product details',
      `Title: ${jsonDetail.result?.title}`
    );

    // 3.4 Storefront Collections
    const resColls = await fetch(`${baseUrl}/v1/collections`);
    const jsonColls = (await resColls.json()) as any;
    assert(
      resColls.status === 200 && jsonColls.type === 'success' && Array.isArray(jsonColls.result),
      'API Endpoints',
      'GET /v1/collections returns 200 OK with collections list',
      `Collections count: ${jsonColls.result?.length}`
    );

    // 3.5 Specific Root Category Collections
    const rootCategories = ['jewellery-collection', 'workspace-collection', 'earth-aroma-collection'];
    for (const catHandle of rootCategories) {
      const resCat = await fetch(`${baseUrl}/v1/collections/${catHandle}`);
      const jsonCat = (await resCat.json()) as any;
      const coll = jsonCat.result?.collection ?? jsonCat.result;
      assert(
        resCat.status === 200 && jsonCat.type === 'success' && coll?.handle === catHandle,
        'API Endpoints',
        `GET /v1/collections/${catHandle} returns 200 OK (${coll?.title})`
      );
    }

    // 3.6 Storefront Banners
    const resBanners = await fetch(`${baseUrl}/v1/banners`);
    const jsonBanners = (await resBanners.json()) as any;
    assert(
      resBanners.status === 200 && jsonBanners.type === 'success' && Array.isArray(jsonBanners.result),
      'API Endpoints',
      'GET /v1/banners returns 200 OK with active live banners',
      `Live banners: ${jsonBanners.result?.length}`
    );

    // 3.7 Storefront FAQs
    const resFaqs = await fetch(`${baseUrl}/v1/faqs`);
    const jsonFaqs = (await resFaqs.json()) as any;
    assert(
      resFaqs.status === 200 && jsonFaqs.type === 'success' && Array.isArray(jsonFaqs.result),
      'API Endpoints',
      'GET /v1/faqs returns 200 OK with published FAQs',
      `FAQs count: ${jsonFaqs.result?.length}`
    );

    // 3.8 Storefront Testimonials
    const resTest = await fetch(`${baseUrl}/v1/testimonials`);
    const jsonTest = (await resTest.json()) as any;
    assert(
      resTest.status === 200 && jsonTest.type === 'success' && Array.isArray(jsonTest.result),
      'API Endpoints',
      'GET /v1/testimonials returns 200 OK with published testimonials',
      `Testimonials count: ${jsonTest.result?.length}`
    );

    // 3.9 Navigation Menus
    const resMenu = await fetch(`${baseUrl}/v1/menus/header`);
    const jsonMenu = (await resMenu.json()) as any;
    assert(
      resMenu.status === 200 && jsonMenu.type === 'success' && jsonMenu.result?.key === 'header',
      'API Endpoints',
      'GET /v1/menus/header returns 200 OK with structured navigation menu',
      `Menu key: ${jsonMenu.result?.key}`
    );

    // 3.10 Protected Admin Endpoint Security
    const resAdmin = await fetch(`${baseUrl}/v1/admin/products`);
    assert(
      resAdmin.status === 401,
      'API Endpoints',
      'GET /v1/admin/products is protected and returns 401 Unauthorized without admin token',
      `Received status: ${resAdmin.status}`
    );

    // 3.11 Pincode Serviceability
    const resPincode = await fetch(`${baseUrl}/v1/serviceability?pincode=226024`);
    const jsonPincode = (await resPincode.json()) as any;
    assert(
      resPincode.status === 200 && jsonPincode.type === 'success',
      'API Endpoints',
      'GET /v1/serviceability?pincode=226024 returns serviceability status',
      JSON.stringify(jsonPincode.result)
    );

  } finally {
    server.close();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────────────────────
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  console.log('\n================================================================');
  console.log(`TOTAL CHECKS: ${total} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================');

  if (failed > 0) {
    console.error(`\n⚠️  ${failed} checks failed!`);
    process.exit(1);
  } else {
    console.log('\n🎉 ALL PRODUCTION CHECKS AND LIVE ENDPOINTS PASSED SUCCESSFULLY!');
  }
}

runLiveTest()
  .catch((err) => {
    console.error('Fatal error during live test:', err);
    process.exit(1);
  })
  .finally(async () => {
    await closeDb();
  });
