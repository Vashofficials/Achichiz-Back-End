/**
 * Collection products mapping — request and response schemas.
 */

import { z } from 'zod';

export const collectionIdParam = z.object({
  collectionId: z.uuid().describe('`collections.id`'),
});

export const collectionProductItem = z.object({
  productId: z.uuid(),
  title: z.string(),
  handle: z.string(),
  thumbnailUrl: z.string().nullable(),
  pricePaise: z.number().int().nullable(),
  isMapped: z.boolean(),
  position: z.number().int(),
});

export type CollectionProductItem = z.infer<typeof collectionProductItem>;

export const syncCollectionProductsBody = z.object({
  productIds: z.array(z.uuid()).describe('Product IDs to be mapped to this collection.'),
});

export type SyncCollectionProductsBody = z.infer<typeof syncCollectionProductsBody>;

export const syncCollectionProductsResponse = z.object({
  collectionId: z.uuid(),
  mappedCount: z.number().int(),
});

export type SyncCollectionProductsResponse = z.infer<typeof syncCollectionProductsResponse>;
