/**
 * Admin CMS section items — repository data access.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import {
  cmsSections,
  cmsSectionItems,
  collections,
  mediaAssets,
  products,
} from '../../db/schema/index.js';
import type {
  AdminCmsItemDetail,
  CreateCmsItemBody,
  UpdateCmsItemBody,
} from './admin-cms-items.schemas.js';

export async function sectionExists(sectionId: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .select({ id: cmsSections.id })
    .from(cmsSections)
    .where(eq(cmsSections.id, sectionId))
    .limit(1);
  return rows.length > 0;
}

export async function itemExists(sectionId: string, itemId: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .select({ id: cmsSectionItems.id })
    .from(cmsSectionItems)
    .where(and(eq(cmsSectionItems.sectionId, sectionId), eq(cmsSectionItems.id, itemId)))
    .limit(1);
  return rows.length > 0;
}

export async function listItemsForSection(
  sectionId: string,
  exec: Executor = db,
): Promise<AdminCmsItemDetail[]> {
  const rows = await exec
    .select({
      id: cmsSectionItems.id,
      sectionId: cmsSectionItems.sectionId,
      position: cmsSectionItems.position,
      label: cmsSectionItems.label,
      sublabel: cmsSectionItems.sublabel,
      mediaId: cmsSectionItems.mediaId,
      mediaUrl: mediaAssets.url,
      linkUrl: cmsSectionItems.linkUrl,
      collectionId: cmsSectionItems.collectionId,
      collectionTitle: collections.title,
      collectionHandle: collections.handle,
      productId: cmsSectionItems.productId,
      productTitle: products.title,
      productHandle: products.handle,
      isVisible: cmsSectionItems.isVisible,
    })
    .from(cmsSectionItems)
    .leftJoin(mediaAssets, eq(mediaAssets.id, cmsSectionItems.mediaId))
    .leftJoin(collections, eq(collections.id, cmsSectionItems.collectionId))
    .leftJoin(products, eq(products.id, cmsSectionItems.productId))
    .where(eq(cmsSectionItems.sectionId, sectionId))
    .orderBy(asc(cmsSectionItems.position), asc(cmsSectionItems.id));

  return rows.map((r) => ({
    ...r,
    mediaUrl: r.mediaUrl ?? null,
    collectionTitle: r.collectionTitle ?? null,
    collectionHandle: r.collectionHandle ?? null,
    productTitle: r.productTitle ?? null,
    productHandle: r.productHandle ?? null,
  }));
}

export async function getItemById(
  sectionId: string,
  itemId: string,
  exec: Executor = db,
): Promise<AdminCmsItemDetail | null> {
  const items = await listItemsForSection(sectionId, exec);
  return items.find((it) => it.id === itemId) ?? null;
}

export async function createItem(
  sectionId: string,
  data: CreateCmsItemBody,
  exec: Executor = db,
): Promise<AdminCmsItemDetail> {
  let pos = data.position;
  if (pos === undefined) {
    const maxPosRes = await exec
      .select({ maxPos: sql<number>`coalesce(max(${cmsSectionItems.position}), -1)` })
      .from(cmsSectionItems)
      .where(eq(cmsSectionItems.sectionId, sectionId));
    pos = (Number(maxPosRes[0]?.maxPos) || 0) + 1;
  }

  const [inserted] = await exec
    .insert(cmsSectionItems)
    .values({
      sectionId,
      position: pos,
      label: data.label,
      sublabel: data.sublabel ?? null,
      mediaId: data.mediaId ?? null,
      linkUrl: data.linkUrl ?? null,
      collectionId: data.collectionId ?? null,
      productId: data.productId ?? null,
      isVisible: data.isVisible ?? true,
    })
    .returning({ id: cmsSectionItems.id });

  const detail = await getItemById(sectionId, inserted.id, exec);
  if (!detail) {
    throw new Error('Failed to retrieve inserted CMS section item.');
  }
  return detail;
}

export async function updateItem(
  sectionId: string,
  itemId: string,
  data: UpdateCmsItemBody,
  exec: Executor = db,
): Promise<AdminCmsItemDetail | null> {
  const updateValues: Record<string, unknown> = {};
  if (data.label !== undefined) updateValues.label = data.label;
  if (data.sublabel !== undefined) updateValues.sublabel = data.sublabel;
  if (data.mediaId !== undefined) updateValues.mediaId = data.mediaId;
  if (data.linkUrl !== undefined) updateValues.linkUrl = data.linkUrl;
  if (data.collectionId !== undefined) updateValues.collectionId = data.collectionId;
  if (data.productId !== undefined) updateValues.productId = data.productId;
  if (data.position !== undefined) updateValues.position = data.position;
  if (data.isVisible !== undefined) updateValues.isVisible = data.isVisible;

  if (Object.keys(updateValues).length > 0) {
    await exec
      .update(cmsSectionItems)
      .set(updateValues)
      .where(and(eq(cmsSectionItems.sectionId, sectionId), eq(cmsSectionItems.id, itemId)));
  }

  return getItemById(sectionId, itemId, exec);
}

export async function deleteItem(
  sectionId: string,
  itemId: string,
  exec: Executor = db,
): Promise<boolean> {
  const res = await exec
    .delete(cmsSectionItems)
    .where(and(eq(cmsSectionItems.sectionId, sectionId), eq(cmsSectionItems.id, itemId)))
    .returning({ id: cmsSectionItems.id });
  return res.length > 0;
}

export async function reorderItems(
  sectionId: string,
  itemIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    for (let i = 0; i < itemIds.length; i++) {
      await tx
        .update(cmsSectionItems)
        .set({ position: i })
        .where(
          and(
            eq(cmsSectionItems.sectionId, sectionId),
            eq(cmsSectionItems.id, itemIds[i]),
          ),
        );
    }
  });
}
