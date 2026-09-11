/**
 * Product gallery endpoints.
 *
 * `POST .../media/upload` is the important one: it takes the files, pushes them to S3,
 * creates the `media_assets` rows AND attaches them to the product in a single call, then
 * returns the finished gallery with resolved URLs. Previously an admin had to upload via
 * `POST /v1/admin/media/upload`, note the returned id, and then had nowhere to put it —
 * `product_media` had no write path at all.
 */

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, noContent, ok } from '../../lib/http.js';
import { BadRequestError } from '../../lib/errors.js';
import { UPLOAD_LIMITS } from '../../middleware/file-interceptor.js';
import * as service from './product-media.service.js';
import {
  attachProductMediaBody,
  productContents,
  productContentsBody,
  productIdParam,
  productMediaIdParam,
  productMediaItem,
  reorderProductMediaBody,
  updateProductMediaBody,
} from './product-media.schemas.js';

export const productMediaRouter: Router = Router();

const MB = 1024 * 1024;
const gallery = z.array(productMediaItem);

defineRoute(productMediaRouter, {
  method: 'get',
  path: '/v1/admin/products/:productId/media',
  surface: 'admin',
  operationId: 'listProductMedia',
  summary: 'List a product gallery',
  description: 'Gallery entries in display order, each joined to its asset so the URL is present.',
  tags: ['Admin / Catalogue'],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'view' },
  request: { params: productIdParam },
  responses: {
    200: { description: 'The gallery, ordered by position.', schema: gallery },
    404: { description: 'No such product.' },
  },
  handler: async ({ params }) => ok(await service.list(params.productId)),
});

defineRoute(productMediaRouter, {
  method: 'post',
  path: '/v1/admin/products/:productId/media/upload',
  surface: 'admin',
  operationId: 'uploadProductMedia',
  summary: 'Upload images or short videos and attach them to a product',
  description:
    `Multipart upload of up to ${UPLOAD_LIMITS.maxFiles} files (field name \`files\`). Images up to ` +
    `${UPLOAD_LIMITS.imageBytes / MB} MB (JPG, PNG, WEBP, GIF, AVIF), short videos up to ` +
    `${UPLOAD_LIMITS.videoBytes / MB} MB (MP4, WEBM, MOV). The whole batch is validated before ` +
    'anything is stored. Each file is stored in S3, recorded as a media asset, and appended to the product gallery ' +
    'in one call. Returns the complete gallery with resolved URLs — no second request needed ' +
    'to render the result.',
  tags: ['Admin / Catalogue'],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'edit' },
  request: { params: productIdParam, bodyContentType: 'multipart/form-data' },
  responses: {
    201: { description: 'The gallery after the upload.', schema: gallery },
    400: { description: 'No files provided, or a file was too large.' },
    404: { description: 'No such product.' },
  },
  // The files were parsed, validated and stored by `fileInterceptor` before this runs. This
  // handler used to call multer again over the consumed stream, so any upload — and reliably
  // a multi-file one — failed with "Unexpected end of form".
  handler: async ({ req, params }) => {
    const assets = req.uploadedAssets ?? [];
    if (assets.length === 0) {
      throw new BadRequestError('No files provided. Send one or more parts named `files`.');
    }
    return created(
      await service.attach(params.productId, { items: assets.map((a) => ({ mediaId: a.id })) }),
    );
  },
});

defineRoute(productMediaRouter, {
  method: 'post',
  path: '/v1/admin/products/:productId/media',
  surface: 'admin',
  operationId: 'attachProductMedia',
  summary: 'Attach existing assets to a product',
  description:
    'Attaches assets already in the media library — use this when picking from the library ' +
    'rather than uploading. For a fresh upload use `POST .../media/upload` instead. ' +
    'Re-attaching an asset already in the gallery is a no-op, not an error.',
  tags: ['Admin / Catalogue'],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'edit' },
  request: { params: productIdParam, body: attachProductMediaBody },
  responses: {
    201: { description: 'The gallery after attaching.', schema: gallery },
    404: { description: 'No such product.' },
    422: { description: 'Unknown media asset, or a variant that is not on this product.' },
  },
  handler: async ({ params, body }) => created(await service.attach(params.productId, body)),
});

defineRoute(productMediaRouter, {
  method: 'put',
  path: '/v1/admin/products/:productId/media/order',
  surface: 'admin',
  operationId: 'reorderProductMedia',
  summary: 'Reorder a product gallery',
  description:
    'Rewrites every position from the supplied order — what a drag-and-drop grid sends after ' +
    'a drop. Position 0 is the primary image. The list must name every current gallery item.',
  tags: ['Admin / Catalogue'],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'edit' },
  request: { params: productIdParam, body: reorderProductMediaBody },
  responses: {
    200: { description: 'The reordered gallery.', schema: gallery },
    404: { description: 'No such product.' },
    422: { description: 'The order listed an unknown item, or omitted one.' },
  },
  handler: async ({ params, body }) => ok(await service.reorder(params.productId, body)),
});

defineRoute(productMediaRouter, {
  method: 'patch',
  path: '/v1/admin/products/:productId/media/:linkId',
  surface: 'admin',
  operationId: 'updateProductMedia',
  summary: 'Edit a gallery entry',
  description: 'Change alt text, position, or the variant an image is scoped to.',
  tags: ['Admin / Catalogue'],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'edit' },
  request: { params: productMediaIdParam, body: updateProductMediaBody },
  responses: {
    200: { description: 'The updated entry.', schema: productMediaItem },
    404: { description: 'No such product or gallery entry.' },
    422: { description: 'The variant does not belong to this product.' },
  },
  handler: async ({ params, body }) => ok(await service.update(params.productId, params.linkId, body)),
});

defineRoute(productMediaRouter, {
  method: 'get',
  path: '/v1/admin/products/:productId/contents',
  surface: 'admin',
  operationId: 'getProductContents',
  summary: 'Read the "What\'s inside" list',
  description: 'The bullets the product page shows under "What\'s inside", in display order.',
  tags: ['Admin / Catalogue'],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'view' },
  request: { params: productIdParam },
  responses: {
    200: { description: 'The list.', schema: productContents },
    404: { description: 'No such product.' },
  },
  handler: async ({ params }) => ok(await service.listContents(params.productId)),
});

defineRoute(productMediaRouter, {
  method: 'put',
  path: '/v1/admin/products/:productId/contents',
  surface: 'admin',
  operationId: 'replaceProductContents',
  summary: 'Replace the "What\'s inside" list',
  description:
    'Replaces every bullet with the supplied list, atomically — a failure leaves the old list ' +
    'intact. Send `[]` to clear it. The storefront picks the change up within two minutes ' +
    '(catalogue cache TTL).',
  tags: ['Admin / Catalogue'],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'edit' },
  request: { params: productIdParam, body: productContentsBody },
  responses: {
    200: { description: 'The list as saved.', schema: productContents },
    404: { description: 'No such product.' },
  },
  handler: async ({ params, body }) => ok(await service.replaceContents(params.productId, body)),
});

defineRoute(productMediaRouter, {
  method: 'delete',
  path: '/v1/admin/products/:productId/media/:linkId',
  surface: 'admin',
  operationId: 'detachProductMedia',
  summary: 'Remove an image from a product',
  description:
    'Detaches the asset from this product. The asset itself stays in the media library and ' +
    'any other product using it is unaffected.',
  tags: ['Admin / Catalogue'],
  auth: 'staff',
  permission: { module: 'catalogue', action: 'delete' },
  request: { params: productMediaIdParam },
  responses: {
    204: { description: 'Detached.' },
    404: { description: 'No such product or gallery entry.' },
  },
  handler: async ({ params }) => {
    await service.detach(params.productId, params.linkId);
    return noContent();
  },
});
