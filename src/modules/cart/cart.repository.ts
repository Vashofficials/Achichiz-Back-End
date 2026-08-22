/**
 * Drizzle queries for the cart. No business rules, no HTTP.
 *
 * The one thing worth reading closely is `findPricingLines`. Everything the
 * pricing engine needs is resolved LIVE in that single query — the variant's
 * current price, the GST rate that applies to its HSN on today's supply date,
 * the collections the coupon scope is tested against, and the available stock.
 * None of it is read from `cart_lines`, which holds only ids, quantities and a
 * price snapshot kept for display.
 *
 * The correlated sub-selects are deliberate for the same reason they are in
 * `catalogue.repository.ts`: a flat join over variants × inventory × collections
 * multiplies rows and makes every aggregate wrong.
 */

import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import {
  addOns,
  cartLineAddOns,
  cartLines,
  carts,
  couponScope,
  coupons,
  couponRedemptions,
  mediaAssets,
  orders,
  productMedia,
  products,
  productVariants,
} from '../../db/schema/index.js';

/* ------------------------------------------------------------------ types */

export type CartRow = typeof carts.$inferSelect;

export type CartPricingLineRow = {
  id: string;
  lineKey: string;
  variantId: string;
  productId: string;
  productHandle: string;
  title: string;
  variantLabel: string;
  sku: string;
  imageUrl: string | null;
  quantity: number;
  /** LIVE `product_variants.price_paise`. */
  unitPricePaise: number;
  /** `cart_lines.unit_price_paise` — the display snapshot taken at add-to-cart. */
  snapshotUnitPricePaise: number;
  personalisation: Record<string, string> | null;
  hsnCode: string | null;
  gstRateBp: number;
  cessRateBp: number;
  collectionIds: string[];
  availableQty: number;
  sellable: boolean;
  createdAt: Date;
};

export type CartLineAddOnRow = {
  cartLineId: string;
  addOnId: string;
  code: string;
  name: string;
  /** LIVE `add_ons.price_paise`. */
  pricePaise: number;
  inputText: string | null;
  active: boolean;
};

export type AddOnRow = {
  id: string;
  code: string;
  name: string;
  pricePaise: number;
  requiresInput: boolean;
  inputCharLimit: number | null;
};

export type VariantForAddRow = {
  variantId: string;
  productId: string;
  productHandle: string;
  title: string;
  variantLabel: string;
  sku: string;
  pricePaise: number;
  isPersonalisable: boolean;
  sellable: boolean;
  availableQty: number;
};

export type CouponRowWithScope = {
  id: string;
  code: string;
  discountType: 'percent' | 'flat' | 'free_shipping' | 'bogo' | 'free_gift';
  discountBp: number | null;
  discountPaise: number | null;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
  appliesTo: 'all' | 'collections' | 'products' | 'first_order';
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  maxRedemptions: number | null;
  maxRedemptionsPerCustomer: number;
  redemptionCount: number;
  scopeProductIds: string[];
  scopeCollectionIds: string[];
  excludedProductIds: string[];
  excludedCollectionIds: string[];
};

/* ------------------------------------------------------------ sql helpers */

/**
 * The rate in force for this HSN on the supply date. Historised, so a reissued
 * invoice reproduces the rate that applied when the supply happened — putting a
 * mutable `gst` integer on the product makes that impossible the first time a
 * slab moves (03_schema.md §3.3).
 */
const gstRateFor = (hsn: unknown, column: 'rate_bp' | 'cess_bp'): ReturnType<typeof sql<number>> =>
  sql<number>`coalesce((
    SELECT gr.${sql.raw(column)} FROM gst_rates gr
     WHERE gr.hsn_code = ${hsn}
       AND gr.effective_from <= current_date
       AND (gr.effective_to IS NULL OR gr.effective_to > current_date)
     ORDER BY gr.effective_from DESC
     LIMIT 1), 0)`;

const availableQtyFor = (variantId: unknown): ReturnType<typeof sql<number>> =>
  sql<number>`coalesce((
    SELECT sum(il.available_qty) FROM inventory_levels il
     WHERE il.variant_id = ${variantId}), 0)`;

const collectionIdsFor = (productId: unknown): ReturnType<typeof sql<string[]>> =>
  sql<string[]>`coalesce((
    SELECT array_agg(pc.collection_id) FROM product_collections pc
     WHERE pc.product_id = ${productId}), '{}')`;

const primaryImageFor = (productId: unknown): ReturnType<typeof sql<string | null>> =>
  sql<string | null>`(
    SELECT coalesce(${mediaAssets.cdnUrl}, ${mediaAssets.url})
      FROM ${productMedia}
      JOIN ${mediaAssets} ON ${mediaAssets.id} = ${productMedia.mediaId} AND ${mediaAssets.deletedAt} IS NULL
     WHERE ${productMedia.productId} = ${productId}
     ORDER BY ${productMedia.position} ASC
     LIMIT 1)`;

/** A variant a shopper is allowed to buy: both it and its product live and published. */
const sellableExpr = sql<boolean>`(
  ${productVariants.status} = 'active' AND ${productVariants.deletedAt} IS NULL
  AND ${products.status} = 'active' AND ${products.deletedAt} IS NULL)`;

/* ------------------------------------------------------------------ carts */

export async function findCartByToken(token: string, exec: Executor = db): Promise<CartRow | null> {
  const rows = await exec.select().from(carts).where(eq(carts.anonToken, token)).limit(1);
  return rows[0] ?? null;
}

export async function findCartById(cartId: string, exec: Executor = db): Promise<CartRow | null> {
  const rows = await exec.select().from(carts).where(eq(carts.id, cartId)).limit(1);
  return rows[0] ?? null;
}

/** The customer's live cart. A converted cart is history and must never be reopened. */
export async function findOpenCartByCustomer(
  customerId: string,
  exec: Executor = db,
): Promise<CartRow | null> {
  const rows = await exec
    .select()
    .from(carts)
    .where(and(eq(carts.customerId, customerId), ne(carts.stage, 'converted')))
    .orderBy(sql`${carts.updatedAt} DESC`)
    .limit(1);
  return rows[0] ?? null;
}

export async function createCart(
  input: { anonToken: string; customerId?: string | null; couponCode?: string | null },
  exec: Executor = db,
): Promise<CartRow> {
  const rows = await exec
    .insert(carts)
    .values({
      anonToken: input.anonToken,
      customerId: input.customerId ?? null,
      couponCode: input.couponCode ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('cart insert returned no row');
  return row;
}

export async function updateCart(
  cartId: string,
  patch: Partial<{
    customerId: string | null;
    couponCode: string | null;
    stage: 'cart' | 'address' | 'payment' | 'converted';
    convertedOrderId: string | null;
    email: string | null;
    mobile: string | null;
  }>,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(carts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(carts.id, cartId));
}

export async function touchCart(cartId: string, exec: Executor = db): Promise<void> {
  await exec.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cartId));
}

/**
 * Hard delete. Carts are Tier 3 (03_schema.md §4.5) — derived state with no
 * independent meaning. Only ever called on a guest cart that has just been
 * merged into a customer cart; a converted cart is kept, because `orders.cart_id`
 * points at it.
 */
export async function deleteCart(cartId: string, exec: Executor = db): Promise<void> {
  await exec.delete(carts).where(eq(carts.id, cartId));
}

/* ------------------------------------------------------------------ lines */

export async function findPricingLines(
  cartId: string,
  exec: Executor = db,
): Promise<CartPricingLineRow[]> {
  const rows = await exec
    .select({
      id: cartLines.id,
      lineKey: cartLines.lineKey,
      variantId: productVariants.id,
      productId: products.id,
      productHandle: products.handle,
      title: products.title,
      variantLabel: productVariants.optionLabel,
      sku: productVariants.sku,
      imageUrl: primaryImageFor(products.id),
      quantity: cartLines.quantity,
      unitPricePaise: productVariants.pricePaise,
      snapshotUnitPricePaise: cartLines.unitPricePaise,
      personalisation: sql<Record<string, string> | null>`${cartLines.personalisation}`,
      hsnCode: products.hsnCode,
      gstRateBp: gstRateFor(products.hsnCode, 'rate_bp'),
      cessRateBp: gstRateFor(products.hsnCode, 'cess_bp'),
      collectionIds: collectionIdsFor(products.id),
      availableQty: availableQtyFor(productVariants.id),
      sellable: sellableExpr,
      createdAt: cartLines.createdAt,
    })
    .from(cartLines)
    .innerJoin(productVariants, eq(cartLines.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(cartLines.cartId, cartId))
    .orderBy(asc(cartLines.createdAt), asc(cartLines.id));

  return rows;
}

export async function findLineAddOns(
  lineIds: readonly string[],
  exec: Executor = db,
): Promise<CartLineAddOnRow[]> {
  if (lineIds.length === 0) return [];
  return exec
    .select({
      cartLineId: cartLineAddOns.cartLineId,
      addOnId: addOns.id,
      code: addOns.code,
      name: addOns.name,
      pricePaise: addOns.pricePaise,
      inputText: cartLineAddOns.inputText,
      active: sql<boolean>`(${addOns.status} = 'active' AND ${addOns.deletedAt} IS NULL)`,
    })
    .from(cartLineAddOns)
    .innerJoin(addOns, eq(cartLineAddOns.addOnId, addOns.id))
    .where(inArray(cartLineAddOns.cartLineId, [...lineIds]))
    .orderBy(asc(addOns.code));
}

export async function findLineByKey(
  cartId: string,
  lineKey: string,
  exec: Executor = db,
): Promise<{ id: string; quantity: number } | null> {
  const rows = await exec
    .select({ id: cartLines.id, quantity: cartLines.quantity })
    .from(cartLines)
    .where(and(eq(cartLines.cartId, cartId), eq(cartLines.lineKey, lineKey)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findLineInCart(
  cartId: string,
  lineId: string,
  exec: Executor = db,
): Promise<{ id: string; quantity: number; variantId: string | null } | null> {
  const rows = await exec
    .select({ id: cartLines.id, quantity: cartLines.quantity, variantId: cartLines.variantId })
    .from(cartLines)
    .where(and(eq(cartLines.cartId, cartId), eq(cartLines.id, lineId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertLine(
  input: {
    cartId: string;
    variantId: string;
    quantity: number;
    unitPricePaise: number;
    lineKey: string;
    personalisation: Record<string, string> | null;
  },
  exec: Executor = db,
): Promise<string> {
  const rows = await exec.insert(cartLines).values(input).returning({ id: cartLines.id });
  const row = rows[0];
  if (!row) throw new Error('cart line insert returned no row');
  return row.id;
}

export async function insertLineAddOns(
  cartLineId: string,
  rows: readonly { addOnId: string; pricePaise: number; inputText: string | null }[],
  exec: Executor = db,
): Promise<void> {
  if (rows.length === 0) return;
  await exec.insert(cartLineAddOns).values(rows.map((r) => ({ ...r, cartLineId })));
}

export async function setLineQuantity(
  lineId: string,
  quantity: number,
  exec: Executor = db,
): Promise<void> {
  await exec.update(cartLines).set({ quantity, updatedAt: new Date() }).where(eq(cartLines.id, lineId));
}

export async function setLinePersonalisation(
  lineId: string,
  personalisation: Record<string, string> | null,
  lineKey: string,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(cartLines)
    .set({ personalisation, lineKey, updatedAt: new Date() })
    .where(eq(cartLines.id, lineId));
}

export async function deleteLine(lineId: string, exec: Executor = db): Promise<void> {
  await exec.delete(cartLines).where(eq(cartLines.id, lineId));
}

export async function deleteAllLines(cartId: string, exec: Executor = db): Promise<void> {
  await exec.delete(cartLines).where(eq(cartLines.cartId, cartId));
}

/** Move guest lines onto the customer cart. Conflicting keys are handled by the caller. */
export async function moveLine(lineId: string, toCartId: string, exec: Executor = db): Promise<void> {
  await exec
    .update(cartLines)
    .set({ cartId: toCartId, updatedAt: new Date() })
    .where(eq(cartLines.id, lineId));
}

/* --------------------------------------------------------------- variants */

export async function findVariantForAdd(
  variantId: string,
  exec: Executor = db,
): Promise<VariantForAddRow | null> {
  const rows = await exec
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productHandle: products.handle,
      title: products.title,
      variantLabel: productVariants.optionLabel,
      sku: productVariants.sku,
      pricePaise: productVariants.pricePaise,
      isPersonalisable: products.isPersonalisable,
      sellable: sellableExpr,
      availableQty: availableQtyFor(productVariants.id),
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(eq(productVariants.id, variantId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findAddOnsByIds(ids: readonly string[], exec: Executor = db): Promise<AddOnRow[]> {
  if (ids.length === 0) return [];
  return exec
    .select({
      id: addOns.id,
      code: addOns.code,
      name: addOns.name,
      pricePaise: addOns.pricePaise,
      requiresInput: addOns.requiresInput,
      inputCharLimit: addOns.inputCharLimit,
    })
    .from(addOns)
    .where(and(inArray(addOns.id, [...ids]), eq(addOns.status, 'active'), isNull(addOns.deletedAt)));
}

/* ---------------------------------------------------------------- coupons */

export async function findCouponByCode(
  code: string,
  exec: Executor = db,
): Promise<CouponRowWithScope | null> {
  const rows = await exec
    .select({
      id: coupons.id,
      code: coupons.code,
      discountType: coupons.discountType,
      discountBp: coupons.discountBp,
      discountPaise: coupons.discountPaise,
      maxDiscountPaise: coupons.maxDiscountPaise,
      minOrderPaise: coupons.minOrderPaise,
      appliesTo: coupons.appliesTo,
      status: coupons.status,
      startsAt: coupons.startsAt,
      endsAt: coupons.endsAt,
      maxRedemptions: coupons.maxRedemptions,
      maxRedemptionsPerCustomer: coupons.maxRedemptionsPerCustomer,
      redemptionCount: coupons.redemptionCount,
    })
    .from(coupons)
    .where(and(eq(coupons.code, code.toUpperCase()), isNull(coupons.deletedAt)))
    .limit(1);

  const coupon = rows[0];
  if (!coupon) return null;

  const scope = await exec
    .select({
      collectionId: couponScope.collectionId,
      productId: couponScope.productId,
      isExclusion: couponScope.isExclusion,
    })
    .from(couponScope)
    .where(eq(couponScope.couponId, coupon.id));

  return {
    ...coupon,
    scopeProductIds: scope.filter((s) => !s.isExclusion && s.productId).map((s) => s.productId as string),
    scopeCollectionIds: scope
      .filter((s) => !s.isExclusion && s.collectionId)
      .map((s) => s.collectionId as string),
    excludedProductIds: scope.filter((s) => s.isExclusion && s.productId).map((s) => s.productId as string),
    excludedCollectionIds: scope
      .filter((s) => s.isExclusion && s.collectionId)
      .map((s) => s.collectionId as string),
  };
}

/** Drives `applies_to = 'first_order'`. Cancelled orders do not count as a first order. */
export async function countCustomerOrders(customerId: string, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), ne(orders.status, 'cancelled')));
  return rows[0]?.n ?? 0;
}

export async function countCustomerRedemptions(
  couponId: string,
  customerId: string,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(couponRedemptions)
    .where(
      and(
        eq(couponRedemptions.couponId, couponId),
        eq(couponRedemptions.customerId, customerId),
        isNull(couponRedemptions.reversedAt),
      ),
    );
  return rows[0]?.n ?? 0;
}
