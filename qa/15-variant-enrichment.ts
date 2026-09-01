/**
 * Does the variants list still show a raw UUID where the product name belongs?
 *
 * Also checks the thing the fix could plausibly get wrong: N+1. The enrichment
 * runs two queries per PAGE, so asking for more rows must not ask the database
 * more times. Query count is counted at the driver, not inferred.
 *
 * Read-only.
 */

import { resourceBySlug } from '../src/modules/admin-resources/resource.registry.js';
import * as svc from '../src/modules/admin-resources/admin-resources.service.js';
import { pool } from '../src/config/db.js';
import { closeDb } from './lib.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`);
};

const descriptor = resourceBySlug('product-variants')!;

/* Count at the pg Pool, which is the last thing before the wire. An earlier
   version wrapped drizzle's session.execute and counted ZERO for every page —
   a check that passes because it measures nothing. */
let queries = 0;
const originalQuery = pool.query.bind(pool);
(pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
  queries++;
  return (originalQuery as (...a: unknown[]) => unknown)(...args);
};

const page = async (perPage: number): Promise<{ rows: Record<string, unknown>[]; queries: number }> => {
  queries = 0;
  const res = await svc.listRows(descriptor, { page: 1, perPage } as never, {});
  return { rows: res.items as Record<string, unknown>[], queries };
};

console.log('--- product relation ---');
const small = await page(5);
if (small.rows.length === 0) {
  console.log('  (no variants in the database — nothing to assert)');
} else {
  const row = small.rows[0]!;
  check('productId is still present', typeof row['productId'] === 'string');
  check(
    'productTitle is a name, not a UUID',
    typeof row['productTitle'] === 'string' &&
      !/^[0-9a-f-]{36}$/i.test(row['productTitle']),
    `productTitle=${String(row['productTitle'])}`,
  );
  check('productHandle is present', typeof row['productHandle'] === 'string');
  check('barcode is exposed in the list', 'barcode' in row);
  check('availableStock is a number', typeof row['availableStock'] === 'number');
  check('reservedStock is a number', typeof row['reservedStock'] === 'number');
  check(
    'availableStock is never negative',
    (row['availableStock'] as number) >= 0,
    `availableStock=${String(row['availableStock'])}`,
  );
}

console.log('\n--- no N+1 ---');
const big = await page(50);
console.log(`  ${small.rows.length} rows -> ${small.queries} queries`);
console.log(`  ${big.rows.length} rows -> ${big.queries} queries`);
if (big.rows.length === small.rows.length) {
  /*
   * Both pages returned the same rows, so this comparison proves nothing about
   * scaling — it would pass for a per-row implementation too. Say so rather
   * than print a green tick: the enrichment is two queries BY CONSTRUCTION (two
   * `inArray` selects), and that is the claim, not this measurement.
   */
  console.log(
    `  INCONCLUSIVE  only ${small.rows.length} variant(s) exist, so both pages are identical.\n` +
      `                ${small.queries} queries either way: list, count, products, inventory.`,
  );
} else {
  check(
    'query count does not grow with the number of rows',
    big.queries === small.queries,
    `${small.rows.length} rows cost ${small.queries}, ${big.rows.length} rows cost ${big.queries} — enrichment is running per row`,
  );
}

console.log(`\n${pass}/${pass + fail} checks passed`);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
