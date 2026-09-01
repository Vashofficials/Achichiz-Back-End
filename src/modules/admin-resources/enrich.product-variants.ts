/**
 * Derived fields for the product-variants list.
 *
 * The console showed a raw `productId` UUID as the product column, because the
 * variants table is all it had. Stock was not shown at all.
 *
 * Both are added here rather than as `columns` entries: `columns` is
 * `Record<string, PgColumn>` because `filterable` and `sortable` index into it
 * and hand the result to `eq()` and `orderBy()`, so a joined expression cannot
 * live there without letting a filter compile against something that is not a
 * column.
 *
 * TWO queries per page, whatever the page size — one for the products, one for
 * the inventory totals. Not one per row.
 */

import { inArray, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { inventoryLevels, products } from '../../db/schema/index.js';

type Row = Record<string, unknown>;

const idsIn = (rows: Row[], key: string): string[] => [
  ...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === 'string')),
];

export async function enrichProductVariants(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  const productIds = idsIn(rows, 'productId');
  const variantIds = idsIn(rows, 'id');

  const [productRows, stockRows] = await Promise.all([
    productIds.length
      ? db
          .select({ id: products.id, title: products.title, handle: products.handle, status: products.status })
          .from(products)
          .where(inArray(products.id, productIds))
      : Promise.resolve([]),
    variantIds.length
      ? db
          .select({
            variantId: inventoryLevels.variantId,
            // `on_hand` is what is physically there; `reserved` is spoken for by
            // orders that have not shipped. Available is the difference, floored
            // at zero — an oversell can make it negative in the raw columns and
            // a negative "available" on a console screen reads as a bug.
            onHand: sql<number>`coalesce(sum(${inventoryLevels.onHandQty}), 0)::int`,
            reserved: sql<number>`coalesce(sum(${inventoryLevels.reservedQty}), 0)::int`,
          })
          .from(inventoryLevels)
          .where(inArray(inventoryLevels.variantId, variantIds))
          .groupBy(inventoryLevels.variantId)
      : Promise.resolve([]),
  ]);

  const productById = new Map(productRows.map((p) => [p.id, p]));
  const stockByVariant = new Map(stockRows.map((s) => [s.variantId, s]));

  return rows.map((row) => {
    const product = typeof row['productId'] === 'string' ? productById.get(row['productId']) : undefined;
    const stock = typeof row['id'] === 'string' ? stockByVariant.get(row['id']) : undefined;
    const onHand = stock?.onHand ?? 0;
    const reserved = stock?.reserved ?? 0;

    return {
      ...row,
      // Flat fields, per the task brief's preferred shape. `productId` is
      // untouched, so nothing that already reads it breaks.
      productTitle: product?.title ?? null,
      productHandle: product?.handle ?? null,
      productStatus: product?.status ?? null,
      availableStock: Math.max(0, onHand - reserved),
      reservedStock: reserved,
    };
  });
}
