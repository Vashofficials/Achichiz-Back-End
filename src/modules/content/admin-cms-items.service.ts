/**
 * Admin CMS section items — business rules and domain logic.
 */

import { NotFoundError } from '../../lib/errors.js';
import { cache } from '../../config/redis.js';
import { logger } from '../../config/logger.js';
import * as repo from './admin-cms-items.repository.js';
import type {
  AdminCmsItemDetail,
  CreateCmsItemBody,
  UpdateCmsItemBody,
} from './admin-cms-items.schemas.js';

async function invalidateCmsCache(): Promise<void> {
  try {
    const keys = await cache.keys('content:v1:sections:*');
    if (keys.length > 0) {
      await cache.del(...keys);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to invalidate CMS sections cache');
  }
}

async function assertSection(sectionId: string): Promise<void> {
  if (!(await repo.sectionExists(sectionId))) {
    throw new NotFoundError('CMS Section', sectionId);
  }
}

async function assertItem(sectionId: string, itemId: string): Promise<void> {
  if (!(await repo.itemExists(sectionId, itemId))) {
    throw new NotFoundError('CMS Section Item', itemId);
  }
}

export async function list(sectionId: string): Promise<AdminCmsItemDetail[]> {
  await assertSection(sectionId);
  return repo.listItemsForSection(sectionId);
}

export async function create(
  sectionId: string,
  data: CreateCmsItemBody,
): Promise<AdminCmsItemDetail> {
  await assertSection(sectionId);
  const created = await repo.createItem(sectionId, data);
  await invalidateCmsCache();
  return created;
}

export async function update(
  sectionId: string,
  itemId: string,
  data: UpdateCmsItemBody,
): Promise<AdminCmsItemDetail> {
  await assertSection(sectionId);
  await assertItem(sectionId, itemId);
  const updated = await repo.updateItem(sectionId, itemId, data);
  if (!updated) {
    throw new NotFoundError('CMS Section Item', itemId);
  }
  await invalidateCmsCache();
  return updated;
}

export async function remove(
  sectionId: string,
  itemId: string,
): Promise<void> {
  await assertSection(sectionId);
  await assertItem(sectionId, itemId);
  await repo.deleteItem(sectionId, itemId);
  await invalidateCmsCache();
}

export async function reorder(
  sectionId: string,
  itemIds: string[],
): Promise<AdminCmsItemDetail[]> {
  await assertSection(sectionId);
  await repo.reorderItems(sectionId, itemIds);
  await invalidateCmsCache();
  return repo.listItemsForSection(sectionId);
}
