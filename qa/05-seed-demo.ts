/**
 * Durable demo catalogue, so storefront detail routes have something to serve.
 *
 * The CRUD harness deliberately deletes everything it creates, which leaves the
 * catalogue empty and makes `/v1/products/{handle}` a 404 — the route answers,
 * but its handler never runs. These records are created ONCE and left in place.
 *
 * Idempotent: it looks for the handle first and reuses what it finds, so
 * re-running never produces duplicates. Everything is prefixed `api-demo-` and
 * is trivially identifiable in the database.
 */

import { adminLogin, call, closeDb, unwrap, BASE } from './lib.js';

const DEMO = {
  collection: { handle: 'api-demo-collection', title: 'API Demo Collection' },
  product: { handle: 'api-demo-product', title: 'API Demo Product' },
  variantSku: 'api-demo-001',
};

async function findByHandle(slug: string, handle: string, token: string): Promise<string | null> {
  const r = await call('GET', `/v1/admin/${slug}?perPage=100`, { token });
  const rows = (unwrap(r.body) as { id: string; handle?: string; sku?: string }[]) ?? [];
  return rows.find((x) => x.handle === handle || x.sku === handle)?.id ?? null;
}

async function main(): Promise<void> {
  console.log(`target: ${BASE}\n`);
  const admin = await adminLogin();
  const t = { token: admin.access };

  /* --------------------------------------------------------- collection */
  let collectionId = await findByHandle('collections', DEMO.collection.handle, admin.access);
  if (collectionId) {
    console.log(`  reused  collection ${collectionId}`);
  } else {
    const r = await call('POST', '/v1/admin/collections', {
      ...t,
      body: {
        handle: DEMO.collection.handle,
        kind: 'category',
        title: DEMO.collection.title,
        heading: DEMO.collection.title,
        subtext: 'Production API integration test record.',
        status: 'live',
      },
    });
    collectionId = (unwrap(r.body) as { id?: string })?.id ?? null;
    console.log(`  created collection ${r.status} ${collectionId ?? r.text.slice(0, 120)}`);
  }

  /* ------------------------------------------------------------ product */
  let productId = await findByHandle('products', DEMO.product.handle, admin.access);
  if (productId) {
    console.log(`  reused  product    ${productId}`);
  } else {
    const r = await call('POST', '/v1/admin/products', {
      ...t,
      body: {
        handle: DEMO.product.handle,
        title: DEMO.product.title,
        subtitle: 'Production API integration test record',
        kind: 'single_gift',
        status: 'active',
        // An active product needs both of these — enforced by CHECK constraints
        // that no schema marks required.
        hsnCode: '4602',
        publishedAt: new Date().toISOString(),
        ...(collectionId ? { primaryCollectionId: collectionId } : {}),
      },
    });
    productId = (unwrap(r.body) as { id?: string })?.id ?? null;
    console.log(`  created product    ${r.status} ${productId ?? r.text.slice(0, 160)}`);
  }

  /* ------------------------------------------------------------ variant */
  if (productId) {
    const variantId = await findByHandle('product-variants', DEMO.variantSku, admin.access);
    if (variantId) {
      console.log(`  reused  variant    ${variantId}`);
    } else {
      const r = await call('POST', '/v1/admin/product-variants', {
        ...t,
        body: {
          productId,
          // The `handle` domain governs SKUs and optionValue too: lowercase,
          // digits, single hyphens.
          sku: DEMO.variantSku,
          optionLabel: 'Size',
          optionValue: 'standard',
          pricePaise: 149900,
          status: 'active',
          isDefault: true,
        },
      });
      console.log(`  created variant    ${r.status} ${(unwrap(r.body) as { id?: string })?.id ?? r.text.slice(0, 160)}`);
    }
  }

  /* ------------------------------------------- is it visible to the storefront? */
  console.log('\nstorefront visibility:');
  for (const path of ['/v1/products', `/v1/products/${DEMO.product.handle}`, '/v1/collections']) {
    const r = await call('GET', path);
    const body = unwrap(r.body);
    const count = Array.isArray(body) ? `${body.length} row(s)` : 'single';
    console.log(`  ${String(r.status).padEnd(4)} ${path.padEnd(34)} ${r.status === 200 ? count : r.text.slice(0, 80)}`);
  }

  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(2);
});
