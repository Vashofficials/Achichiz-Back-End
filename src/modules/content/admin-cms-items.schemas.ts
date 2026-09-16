/**
 * Admin CMS section items — request and response validation schemas.
 */

import { z } from 'zod';

export const sectionIdParam = z.object({
  sectionId: z.string().uuid().describe('`cms_sections.id`'),
});

export const sectionItemIdParam = z.object({
  sectionId: z.string().uuid().describe('`cms_sections.id`'),
  itemId: z.string().uuid().describe('`cms_section_items.id`'),
});

export const createCmsItemBody = z.object({
  label: z.string().min(1).max(200).describe('Card label / title.'),
  sublabel: z.string().max(300).nullable().optional(),
  mediaId: z.string().uuid().nullable().optional().describe('Referenced image asset.'),
  linkUrl: z.string().max(500).nullable().optional().describe('Custom link URL.'),
  collectionId: z.string().uuid().nullable().optional().describe('Target collection for product browsing.'),
  productId: z.string().uuid().nullable().optional().describe('Target product if linking directly.'),
  position: z.number().int().optional().describe('Order index within the section.'),
  isVisible: z.boolean().optional().default(true),
});

export type CreateCmsItemBody = z.infer<typeof createCmsItemBody>;

export const updateCmsItemBody = createCmsItemBody.partial();

export type UpdateCmsItemBody = z.infer<typeof updateCmsItemBody>;

export const reorderCmsItemsBody = z.object({
  itemIds: z.array(z.string().uuid()).describe('Ordered array of item UUIDs.'),
});

export type ReorderCmsItemsBody = z.infer<typeof reorderCmsItemsBody>;

export const adminCmsItemDetail = z.object({
  id: z.string().uuid(),
  sectionId: z.string().uuid(),
  position: z.number().int(),
  label: z.string().nullable(),
  sublabel: z.string().nullable(),
  mediaId: z.string().uuid().nullable(),
  mediaUrl: z.string().nullable(),
  linkUrl: z.string().nullable(),
  collectionId: z.string().uuid().nullable(),
  collectionTitle: z.string().nullable(),
  collectionHandle: z.string().nullable(),
  productId: z.string().uuid().nullable(),
  productTitle: z.string().nullable(),
  productHandle: z.string().nullable(),
  isVisible: z.boolean(),
});

export type AdminCmsItemDetail = z.infer<typeof adminCmsItemDetail>;
