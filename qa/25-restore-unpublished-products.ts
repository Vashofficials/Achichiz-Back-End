/**
 * REPAIR — undo an over-broad status change made by qa/24-import-website-inventory.ts.
 *
 * The import's update path set `status: 'draft'` on EVERY matched product, including
 * pre-existing, priced, published ones. It should only ever have set draft on rows it
 * created. Roughly 30 live products were unpublished as a result.
 *
 * Restore rule — deliberately narrow:
 *   status = 'draft'  AND  has >= 1 variant  AND  hsn_code IS NOT NULL   ->  'active'
 *
 * Why those three conditions:
 *   - variants  : a product with a variant has a price, so it was a real saleable product.
 *                 Sheet-imported products have no variant and are therefore never touched.
 *   - hsn_code  : the CHECK constraint `product_active_needs_hsn` refuses an active product
 *                 without one. A row missing HSN could never have been active, so it was
 *                 already draft before the import and must stay that way.
 *
 * Each row is updated individually so one constraint failure cannot roll back the rest;
 * failures are reported rather than swallowed.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx --env-file=.env qa/25-restore-unpublished-products.ts
 *   npx tsx --env-file=.env qa/25-restore-unpublished-products.ts
 */

import { db } from '../src/config/db.js';
import { products, productVariants } from '../src/db/schema/index.js';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

const DRY_RUN = process.env['DRY_RUN'] === '1';

async function main(): Promise<void> {
  const candidates = await db
    .select({ id: products.id, handle: products.handle, title: products.title })
    .from(products)
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .where(
      and(
        isNull(products.deletedAt),
        eq(products.status, 'draft'),
        isNotNull(products.hsnCode),
      ),
    )
    .groupBy(products.id)
    .having(sql`count(${productVariants.id}) > 0`);

  console.log(`mode       : ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);
  console.log(`restorable : ${candidates.length}`);
  for (const c of candidates) console.log(`  - ${c.handle} | ${c.title}`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing changed.');
    return;
  }

  let restored = 0;
  const failed: { handle: string; reason: string }[] = [];

  for (const c of candidates) {
    try {
      await db
        .update(products)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(products.id, c.id));
      restored++;
    } catch (err) {
      failed.push({ handle: c.handle, reason: (err as Error).message.split('\n')[0] ?? 'unknown' });
    }
  }

  console.log(`\nrestored to active : ${restored}`);
  if (failed.length) {
    console.log(`failed             : ${failed.length}`);
    failed.forEach((f) => console.log(`  - ${f.handle}: ${f.reason}`));
  }

  // The storefront catalogue is a read-through Redis cache with no write-invalidation,
  // so a direct database change is invisible until the key expires. Clear it, or the
  // change appears not to have worked — which is exactly what happened during the import.
  try {
    const { cache } = await import('../src/config/redis.js');
    const keys = await cache.keys('cat:v1:*');
    if (keys.length) await cache.del(...keys);
    console.log(`catalogue cache    : cleared ${keys.length} key(s)`);
  } catch (err) {
    console.log('catalogue cache    : could not clear —', (err as Error).message);
  }
}

void main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
