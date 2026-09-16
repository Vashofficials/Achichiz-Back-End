/**
 * Collection products mapping — data access.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import {
  collections,
  productCollections,
  products,
} from '../../db/schema/index.js';
import type { CollectionProductItem } from './collection-products.schemas.js';

export async function collectionExists(collectionId: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.id, collectionId), isNull(collections.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

export async function listProductsForCollection(
  collectionId: string,
  exec: Executor = db,
): Promise<CollectionProductItem[]> {
  const rows = await exec
    .select({
      productId: products.id,
      title: products.title,
      handle: products.handle,
      mappedCollectionId: productCollections.collectionId,
      position: sql<number>`coalesce(${productCollections.position}, 0)`,
      pricePaise: sql<number | null>`(
        SELECT pv.price_paise FROM product_variants pv
        WHERE pv.product_id = ${products.id} AND pv.deleted_at IS NULL
        ORDER BY pv.is_default DESC, pv.position ASC, pv.created_at ASC
        LIMIT 1
      )`,
      thumbnailUrl: sql<string | null>`(
        SELECT ma.url FROM product_media pm
        JOIN media_assets ma ON ma.id = pm.media_id
        WHERE pm.product_id = ${products.id} AND ma.deleted_at IS NULL
        ORDER BY pm.position ASC, pm.created_at ASC
        LIMIT 1
      )`,
    })
    .from(products)
    .leftJoin(
      productCollections,
      and(
        eq(productCollections.productId, products.id),
        eq(productCollections.collectionId, collectionId),
      ),
    )
    .where(isNull(products.deletedAt))
    .orderBy(
      sql`(${productCollections.collectionId} IS NOT NULL) DESC`,
      asc(productCollections.position),
      asc(products.title),
    );

  return rows.map((r) => ({
    productId: r.productId,
    title: r.title,
    handle: r.handle,
    thumbnailUrl: r.thumbnailUrl,
    pricePaise: r.pricePaise ? Number(r.pricePaise) : null,
    isMapped: Boolean(r.mappedCollectionId),
    position: Number(r.position) || 0,
  }));
}

export async function syncCollectionProducts(
  collectionId: string,
  productIds: string[],
): Promise<number> {
  return await db.transaction(async (tx) => {
    await tx
      .delete(productCollections)
      .where(eq(productCollections.collectionId, collectionId));

    if (productIds.length === 0) return 0;

    const uniqueIds = Array.from(new Set(productIds));
    const inserts = uniqueIds.map((pid, idx) => ({
      collectionId,
      productId: pid,
      position: idx,
    }));

    await tx.insert(productCollections).values(inserts);
    return inserts.length;
  });
}
