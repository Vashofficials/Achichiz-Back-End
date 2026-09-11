/**
 * Product gallery — business rules.
 *
 * Closes a real hole: `product_media` was read by the storefront (PDP, cart thumbnails,
 * order history) but had no write path, so an uploaded asset could never be attached to a
 * product. Every response here returns the resolved asset URL rather than a bare id, so the
 * console can render the gallery straight from the call that changed it.
 */

import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import * as repo from './product-media.repository.js';
import type {
  AttachProductMediaBody,
  ProductContentsBody,
  ProductMediaItem,
  ReorderProductMediaBody,
  UpdateProductMediaBody,
} from './product-media.schemas.js';

type Row = Awaited<ReturnType<typeof repo.listForProduct>>[number];

const toItem = (r: Row): ProductMediaItem => ({
  id: r.id,
  mediaId: r.mediaId,
  url: r.url,
  mimeType: r.mimeType,
  kind: r.kind,
  altText: r.altText,
  position: r.position,
  variantId: r.variantId,
  createdAt: r.createdAt.toISOString(),
});

async function assertProduct(productId: string): Promise<void> {
  if (!(await repo.productExists(productId))) throw new NotFoundError('Product', productId);
}

export async function list(productId: string): Promise<ProductMediaItem[]> {
  await assertProduct(productId);
  return (await repo.listForProduct(productId)).map(toItem);
}

export async function attach(
  productId: string,
  body: AttachProductMediaBody,
): Promise<ProductMediaItem[]> {
  await assertProduct(productId);

  // Reject unknown assets up front rather than surfacing a foreign-key violation as a 500.
  const mediaIds = body.items.map((i) => i.mediaId);
  const known = await repo.existingMediaIds(mediaIds);
  const missing = mediaIds.filter((id) => !known.has(id));
  if (missing.length) {
    throw new UnprocessableError(
      `Unknown or deleted media asset(s): ${missing.join(', ')}`,
      'unknown_media_asset',
    );
  }

  // A variant-scoped image must belong to THIS product, or one product's gallery could
  // silently reference another product's variant.
  const variantIds = body.items.map((i) => i.variantId).filter((v): v is string => Boolean(v));
  if (variantIds.length) {
    const owned = await repo.variantIdsOfProduct(productId, variantIds);
    const foreign = variantIds.filter((v) => !owned.has(v));
    if (foreign.length) {
      throw new UnprocessableError(
        `Variant(s) do not belong to this product: ${foreign.join(', ')}`,
        'variant_not_on_product',
      );
    }
  }

  // Append after whatever is already there unless the caller pinned a position.
  let next = (await repo.maxPosition(productId)) + 1;
  const values = body.items.map((i) => ({
    productId,
    mediaId: i.mediaId,
    altText: i.altText ?? null,
    position: i.position ?? next++,
    variantId: i.variantId ?? null,
  }));

  await repo.attach(values);
  return (await repo.listForProduct(productId)).map(toItem);
}

export async function update(
  productId: string,
  linkId: string,
  body: UpdateProductMediaBody,
): Promise<ProductMediaItem> {
  await assertProduct(productId);
  if (!(await repo.findLink(productId, linkId))) throw new NotFoundError('Gallery item', linkId);

  if (body.variantId) {
    const owned = await repo.variantIdsOfProduct(productId, [body.variantId]);
    if (!owned.has(body.variantId)) {
      throw new UnprocessableError(
        'That variant does not belong to this product.',
        'variant_not_on_product',
      );
    }
  }

  await repo.updateLink(linkId, body);
  const row = (await repo.listForProduct(productId)).find((r) => r.id === linkId);
  if (!row) throw new NotFoundError('Gallery item', linkId);
  return toItem(row);
}

export async function detach(productId: string, linkId: string): Promise<void> {
  await assertProduct(productId);
  const removed = await repo.detach(productId, linkId);
  if (removed === 0) throw new NotFoundError('Gallery item', linkId);
}

export async function listContents(productId: string): Promise<{ items: string[] }> {
  await assertProduct(productId);
  return { items: await repo.listContents(productId) };
}

export async function replaceContents(
  productId: string,
  body: ProductContentsBody,
): Promise<{ items: string[] }> {
  await assertProduct(productId);
  await repo.replaceContents(productId, body.items);
  return { items: await repo.listContents(productId) };
}

export async function reorder(
  productId: string,
  body: ReorderProductMediaBody,
): Promise<ProductMediaItem[]> {
  await assertProduct(productId);

  // Every id must already be in this gallery — a stale drag-and-drop payload should 422,
  // not silently renumber a subset and leave the order half-applied.
  const current = await repo.listForProduct(productId);
  const currentIds = new Set(current.map((r) => r.id));
  const unknown = body.order.filter((id) => !currentIds.has(id));
  if (unknown.length) {
    throw new UnprocessableError(
      `Gallery item(s) not on this product: ${unknown.join(', ')}`,
      'unknown_gallery_item',
    );
  }
  if (body.order.length !== current.length) {
    throw new UnprocessableError(
      `Reorder must list every gallery item — expected ${current.length}, received ${body.order.length}.`,
      'incomplete_reorder',
    );
  }

  await repo.reorder(productId, body.order);
  return (await repo.listForProduct(productId)).map(toItem);
}
