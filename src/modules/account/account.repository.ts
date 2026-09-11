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
import { db, type Executor, type Tx } from '../../config/db.js';
import {
  customers,
  mediaAssets,
  productMedia,
  products,
  productVariants,
  wishlistItems,
  returns,
  returnLines,
  exchanges,
  orders,
  invoices,
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
     WHERE ${productMedia.productId} = ${productId} AND ${mediaAssets.kind} = 'image'
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

/* ----------------------------------------------------------------- returns & exchanges */

export async function createReturn(
  values: {
    returnNo: string;
    orderId: string;
    customerId: string;
    reason: any;
    reasonNote?: string;
    refundMode: any;
  },
  lines: { orderLineId: string; quantity: number; condition: any }[],
  exec: Executor = db,
) {
  const result = await exec.insert(returns).values(values).returning({ id: returns.id });
  const id = result[0]?.id as string;
  
  if (lines.length > 0) {
    const returnLinesData = lines.map(l => ({ ...l, returnId: id }));
    await exec.insert(returnLines).values(returnLinesData);
  }
  
  return id;
}

export async function createExchange(
  values: {
    exchangeNo: string;
    orderId: string;
    customerId: string;
    orderLineId: string;
    fromVariantId: string;
    toVariantId: string;
    quantity: number;
    priceDiffPaise: number;
  },
  exec: Executor = db,
) {
  const result = await exec.insert(exchanges).values(values).returning({ id: exchanges.id });
  return result[0]?.id as string;
}

export async function listCustomerReturns(customerId: string, exec: Executor = db) {
  return exec
    .select()
    .from(returns)
    .where(eq(returns.customerId, customerId))
    .orderBy(desc(returns.requestedAt));
}

export async function listCustomerExchanges(customerId: string, exec: Executor = db) {
  return exec
    .select({
      id: exchanges.id,
      exchangeNo: exchanges.exchangeNo,
      orderId: exchanges.orderId,
      orderLineId: exchanges.orderLineId,
      fromVariantId: exchanges.fromVariantId,
      toVariantId: exchanges.toVariantId,
      quantity: exchanges.quantity,
      priceDiffPaise: exchanges.priceDiffPaise,
      status: exchanges.status,
      requestedAt: exchanges.requestedAt,
    })
    .from(exchanges)
    .innerJoin(orders, eq(exchanges.orderId, orders.id))
    .where(eq(orders.customerId, customerId))
    .orderBy(desc(exchanges.requestedAt));
}

/* --------------------------------------------------------- ownership check */

/**
 * Verify that the order belongs to this customer.
 *
 * Without this check, any authenticated customer could file a return or exchange
 * against any order by supplying someone else's order ID. The route already
 * scopes to `auth.customerId`, but the order ID comes from the URL path and
 * must be validated.
 */
export async function verifyOrderOwnership(
  customerId: string,
  orderId: string,
  exec: Executor = db,
): Promise<{ id: string } | null> {
  const rows = await exec
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------- document numbers */

/**
 * Gapless return number from `document_number_series`, following the same
 * pattern as `leads.repository.nextLeadNumber` and
 * `checkout.repository.nextOrderNumber`.
 *
 * The series row is created on first use with `ON CONFLICT DO NOTHING`.
 */
export async function nextReturnNumber(tx: Tx): Promise<string> {
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('return', '', 'RET-', '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ return_no: string }>(
    sql`SELECT next_document_number('return', '') AS return_no`,
  );
  const returnNo = result.rows[0]?.return_no;
  if (!returnNo) throw new Error('next_document_number returned no return number');
  return returnNo;
}

export async function nextExchangeNumber(tx: Tx): Promise<string> {
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('exchange', '', 'EXC-', '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ exchange_no: string }>(
    sql`SELECT next_document_number('exchange', '') AS exchange_no`,
  );
  const exchangeNo = result.rows[0]?.exchange_no;
  if (!exchangeNo) throw new Error('next_document_number returned no exchange number');
  return exchangeNo;
}

/* ----------------------------------------------------------- invoice URL */

/**
 * Resolve the actual PDF URL for an order's tax invoice.
 *
 * Joins `invoices` → `media_assets` to get the real S3 URL, replacing the
 * hardcoded mock URL. Returns null when no invoice has been issued yet.
 */
export async function findInvoiceUrl(
  customerId: string,
  orderId: string,
  exec: Executor = db,
): Promise<string | null> {
  const rows = await exec
    .select({ url: mediaAssets.url })
    .from(invoices)
    .innerJoin(orders, eq(invoices.orderId, orders.id))
    .leftJoin(mediaAssets, eq(invoices.pdfMediaId, mediaAssets.id))
    .where(
      and(
        eq(invoices.orderId, orderId),
        eq(orders.customerId, customerId),
        eq(invoices.status, 'issued'),
      ),
    )
    .limit(1);
  return rows[0]?.url ?? null;
}
