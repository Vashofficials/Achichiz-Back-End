/**
 * Collection products mapping — business rules.
 */

import { NotFoundError } from '../../lib/errors.js';
import * as repo from './collection-products.repository.js';
import type {
  CollectionProductItem,
  SyncCollectionProductsResponse,
} from './collection-products.schemas.js';

async function assertCollection(collectionId: string): Promise<void> {
  if (!(await repo.collectionExists(collectionId))) {
    throw new NotFoundError('Collection', collectionId);
  }
}

export async function list(collectionId: string): Promise<CollectionProductItem[]> {
  await assertCollection(collectionId);
  return await repo.listProductsForCollection(collectionId);
}

export async function sync(
  collectionId: string,
  productIds: string[],
): Promise<SyncCollectionProductsResponse> {
  await assertCollection(collectionId);
  const mappedCount = await repo.syncCollectionProducts(collectionId, productIds);
  return {
    collectionId,
    mappedCount,
  };
}
