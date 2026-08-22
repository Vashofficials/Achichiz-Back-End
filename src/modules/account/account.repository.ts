/**
 * Drizzle queries for the account. No business rules, no HTTP.
 *
 * The wishlist read resolves price, image and availability LIVE through
 * correlated sub-selects rather than a flat join, for the same reason
 * `cart.repository.ts` does: a product has many variants, many images and many
 * inventory rows, and joining all three multiplies rows until every aggregate is
 * wrong.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import {
  customers,
  mediaAssets,
  productMedia,
  products,
  wishlistItems,
} from '../../db/schema/index.js';

export type CustomerRow = typeof customers.$inferSelect;

export type WishlistRow = {
  productId: string;
  handle: string;
  title: string;
  imageUrl: string | null;
  fromPricePaise: number | null;
  availableQty: number;
  available: boolean;
  addedAt: Date;
};

/* -------------------------------------------------------------- customers */

export async function findCustomerById(
  customerId: string,
  exec: Executor = db,
): Promise<CustomerRow | null> {
  const rows = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** CITEXT comparison — case-insensitive in the database, no `lower()` wrapper. */
export async function emailBelongsToAnother(
  email: string,
  customerId: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.email, email), isNull(customers.deletedAt)))
    .limit(1);
  const row = rows[0];
  return row !== undefined && row.id !== customerId;
}

export async function mobileBelongsToAnother(
  mobile: string,
  customerId: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.mobile, mobile), isNull(customers.deletedAt)))
    .limit(1);
  const row = rows[0];
  return row !== undefined && row.id !== customerId;
}

export async function updateCustomer(
  customerId: string,
  patch: Partial<typeof customers.$inferInsert>,
  exec: Executor = db,
): Promise<CustomerRow | null> {
  const rows = await exec
    .update(customers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(customers.id, customerId))
    .returning();
  return rows[0] ?? null;
}

/* --------------------------------------------------------------- wishlist */

const primaryImageFor = (productId: unknown): ReturnType<typeof sql<string | null>> =>
  sql<string | null>`(
    SELECT coalesce(${mediaAssets.cdnUrl}, ${mediaAssets.url})
      FROM ${productMedia}
      JOIN ${mediaAssets} ON ${mediaAssets.id} = ${productMedia.mediaId} AND ${mediaAssets.deletedAt} IS NULL
     WHERE ${productMedia.productId} = ${productId}
     ORDER BY ${productMedia.position} ASC
     LIMIT 1)`;

/** The "from ₹X" figure: cheapest variant a shopper could actually buy. */
const fromPriceFor = (productId: unknown): ReturnType<typeof sql<number | null>> =>
  sql<number | null>`(
    SELECT min(pv.price_paise) FROM product_variants pv
     WHERE pv.product_id = ${productId}
       AND pv.status = 'active' AND pv.deleted_at IS NULL)`;

const availableQtyFor = (productId: unknown): ReturnType<typeof sql<number>> =>
  sql<number>`coalesce((
    SELECT sum(il.available_qty) FROM inventory_levels il
      JOIN product_variants pv ON pv.id = il.variant_id
     WHERE pv.product_id = ${productId}
       AND pv.status = 'active' AND pv.deleted_at IS NULL), 0)`;

export async function listWishlist(
  customerId: string,
  page: { limit: number; offset: number },
  exec: Executor = db,
): Promise<WishlistRow[]> {
  return exec
    .select({
      productId: products.id,
      handle: products.handle,
      title: products.title,
      imageUrl: primaryImageFor(products.id),
      fromPricePaise: fromPriceFor(products.id),
      availableQty: availableQtyFor(products.id),
      available: sql<boolean>`(${products.status} = 'active' AND ${products.deletedAt} IS NULL)`,
      addedAt: wishlistItems.addedAt,
    })
    .from(wishlistItems)
    .innerJoin(products, eq(wishlistItems.productId, products.id))
    .where(eq(wishlistItems.customerId, customerId))
    .orderBy(desc(wishlistItems.addedAt))
    .limit(page.limit)
    .offset(page.offset);
}

export async function countWishlist(customerId: string, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(wishlistItems)
    .where(eq(wishlistItems.customerId, customerId));
  return rows[0]?.n ?? 0;
}

export async function findWishlistRow(
  customerId: string,
  productId: string,
  exec: Executor = db,
): Promise<WishlistRow | null> {
  const rows = await exec
    .select({
      productId: products.id,
      handle: products.handle,
      title: products.title,
      imageUrl: primaryImageFor(products.id),
      fromPricePaise: fromPriceFor(products.id),
      availableQty: availableQtyFor(products.id),
      available: sql<boolean>`(${products.status} = 'active' AND ${products.deletedAt} IS NULL)`,
      addedAt: wishlistItems.addedAt,
    })
    .from(wishlistItems)
    .innerJoin(products, eq(wishlistItems.productId, products.id))
    .where(and(eq(wishlistItems.customerId, customerId), eq(wishlistItems.productId, productId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Publishable products only — a wishlist should not be able to hold a draft. */
export async function findPublishedProduct(
  productId: string,
  exec: Executor = db,
): Promise<{ id: string } | null> {
  const rows = await exec
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.status, 'active'), isNull(products.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `wishlist_items` is keyed by `(customer_id, product_id)`, so saving something
 * twice is a primary-key collision rather than a duplicate row. `DO NOTHING`
 * makes the second tap idempotent — which is what a heart icon that has already
 * been tapped should do.
 */
export async function upsertWishlistItem(
  customerId: string,
  productId: string,
  exec: Executor = db,
): Promise<void> {
  await exec.insert(wishlistItems).values({ customerId, productId }).onConflictDoNothing();
}

export async function deleteWishlistItem(
  customerId: string,
  productId: string,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .delete(wishlistItems)
    .where(and(eq(wishlistItems.customerId, customerId), eq(wishlistItems.productId, productId)))
    .returning({ productId: wishlistItems.productId });
  return rows.length;
}
