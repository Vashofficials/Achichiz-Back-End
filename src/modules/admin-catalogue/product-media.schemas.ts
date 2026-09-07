/**
 * Product gallery — request/response schemas.
 *
 * `product_media` already existed and is read by the storefront (PDP, cart line thumbnails,
 * account order history) but nothing ever wrote it: an admin could upload a file to S3 via
 * `POST /v1/admin/media/upload` and had no way to attach the result to a product. These
 * schemas back the endpoints that close that gap.
 */

import { z } from 'zod';

export const productIdParam = z.object({
  productId: z.uuid().describe('`products.id`.'),
});

export const productMediaIdParam = z.object({
  productId: z.uuid().describe('`products.id`.'),
  linkId: z.uuid().describe('`product_media.id` — the gallery entry, NOT the media asset id.'),
});

/** One gallery entry, joined to its asset so the console can render it without a second call. */
export const productMediaItem = z.object({
  id: z.uuid().describe('`product_media.id`. Use this to reorder or detach.'),
  mediaId: z.uuid().describe('`media_assets.id`.'),
  url: z.string().describe('Public URL of the asset.'),
  mimeType: z.string(),
  kind: z.enum(['image', 'video', 'pdf', 'other']),
  altText: z.string().nullable().describe('Per-product alt text; falls back to the asset default.'),
  position: z.number().int().describe('0-based gallery order. Position 0 is the primary image.'),
  variantId: z.uuid().nullable().describe('Set to show this image only for one variant.'),
  createdAt: z.string(),
});

/**
 * Attach one or more assets. An array because the common case is a bulk upload — the
 * console uploads four photos and attaches them in one call rather than four round trips.
 */
export const attachProductMediaBody = z.object({
  items: z
    .array(
      z.object({
        mediaId: z.uuid().describe('An id returned by `POST /v1/admin/media/upload`.'),
        altText: z
          .string()
          .max(300)
          .optional()
          .describe('Accessible description. Strongly recommended — it is also SEO text.'),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Omit to append to the end of the gallery.'),
        variantId: z.uuid().optional().describe('Restrict this image to a single variant.'),
      }),
    )
    .min(1)
    .max(20)
    .describe('Up to 20 assets per call.'),
});

export const updateProductMediaBody = z
  .object({
    altText: z.string().max(300).nullable().optional(),
    position: z.number().int().min(0).optional(),
    variantId: z.uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to change.' });

/** Whole-gallery reorder — what a drag-and-drop UI sends after a drop. */
export const reorderProductMediaBody = z.object({
  order: z
    .array(z.uuid())
    .min(1)
    .max(50)
    .describe('`product_media.id` values in the desired order. Position is the array index.'),
});

export type ProductMediaItem = z.infer<typeof productMediaItem>;
export type AttachProductMediaBody = z.infer<typeof attachProductMediaBody>;
export type UpdateProductMediaBody = z.infer<typeof updateProductMediaBody>;
export type ReorderProductMediaBody = z.infer<typeof reorderProductMediaBody>;
