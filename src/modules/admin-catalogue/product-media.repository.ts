/**
 * Product gallery — data access. No new tables: `product_media` and `media_assets` both
 * already exist; this module only supplies the write path they never had.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import { mediaAssets, productMedia, products, productVariants } from '../../db/schema/index.js';

export async function productExists(productId: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), isNull(products.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

/** Which of these media ids exist and are not soft-deleted. */
export async function existingMediaIds(ids: string[], exec: Executor = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await exec
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(inArray(mediaAssets.id, ids), isNull(mediaAssets.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

/** Which of these variant ids belong to the given product — guards cross-product leakage. */
export async function variantIdsOfProduct(
  productId: string,
  ids: string[],
  exec: Executor = db,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await exec
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), inArray(productVariants.id, ids)));
  return new Set(rows.map((r) => r.id));
}

export async function listForProduct(productId: string, exec: Executor = db) {
  return exec
    .select({
      id: productMedia.id,
      mediaId: productMedia.mediaId,
      url: mediaAssets.url,
      mimeType: mediaAssets.mimeType,
      kind: mediaAssets.kind,
      altText: sql<string | null>`coalesce(${productMedia.altText}, ${mediaAssets.altText})`,
      position: productMedia.position,
      variantId: productMedia.variantId,
      createdAt: productMedia.createdAt,
    })
    .from(productMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, productMedia.mediaId))
    .where(and(eq(productMedia.productId, productId), isNull(mediaAssets.deletedAt)))
    .orderBy(asc(productMedia.position), asc(productMedia.createdAt));
}

/** Highest position currently used, or -1 when the gallery is empty. */
export async function maxPosition(productId: string, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ max: sql<number | null>`max(${productMedia.position})` })
    .from(productMedia)
    .where(eq(productMedia.productId, productId));
  return rows[0]?.max ?? -1;
}

export async function attach(
  values: {
    productId: string;
    mediaId: string;
    altText?: string | null;
    position: number;
    variantId?: string | null;
  }[],
  exec: Executor = db,
): Promise<string[]> {
  if (values.length === 0) return [];
  // `uq_product_media_once` (product, media, coalesce(variant)) makes re-attaching the same
  // asset a no-op rather than a 500 — the console retrying an upload must not error.
  const rows = await exec
    .insert(productMedia)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: productMedia.id });
  return rows.map((r) => r.id);
}

export async function findLink(productId: string, linkId: string, exec: Executor = db) {
  const rows = await exec
    .select({ id: productMedia.id })
    .from(productMedia)
    .where(and(eq(productMedia.id, linkId), eq(productMedia.productId, productId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateLink(
  linkId: string,
  values: { altText?: string | null; position?: number; variantId?: string | null },
  exec: Executor = db,
): Promise<void> {
  await exec.update(productMedia).set(values).where(eq(productMedia.id, linkId));
}

export async function detach(productId: string, linkId: string, exec: Executor = db): Promise<number> {
  const rows = await exec
    .delete(productMedia)
    .where(and(eq(productMedia.id, linkId), eq(productMedia.productId, productId)))
    .returning({ id: productMedia.id });
  return rows.length;
}

/** Rewrite positions from an ordered list of link ids, inside one transaction. */
export async function reorder(productId: string, orderedLinkIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, linkId] of orderedLinkIds.entries()) {
      await tx
        .update(productMedia)
        .set({ position: index })
        .where(and(eq(productMedia.id, linkId), eq(productMedia.productId, productId)));
    }
  });
}
