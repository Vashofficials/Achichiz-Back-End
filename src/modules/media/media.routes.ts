import { Router } from 'express';
import type { Request } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created } from '../../lib/http.js';
import { BadRequestError } from '../../lib/errors.js';
import { mediaAssetSummary } from './media.schemas.js';

export const mediaRouter = Router();

/**
 * The multipart body has already been parsed and every file stored by `fileInterceptor`
 * (mounted by `defineRoute` because these routes declare `multipart/form-data`). These
 * handlers used to run multer a second time over the already-consumed stream, which is why
 * every upload through them failed with "Unexpected end of form".
 */
const firstUpload = (req: Request) => {
  const asset = req.uploadedAssets?.[0];
  if (!asset) throw new BadRequestError('No file provided. Send it in a multipart field named "file".');
  return asset;
};

defineRoute(mediaRouter, {
  method: 'post',
  path: '/v1/admin/media/upload',
  surface: 'admin',
  operationId: 'uploadMedia',
  summary: 'Upload a media asset',
  description:
    'Uploads a file to S3 and creates a media asset record. The returned `id` can be used as an `imageRef` or `mediaId` in other Admin APIs. Images up to 5 MB (JPG, PNG, WEBP, GIF, AVIF, SVG), video up to 50 MB (MP4, WEBM, MOV), PDF up to 10 MB.',
  tags: ['Admin / Media'],
  auth: 'staff',
  permission: { module: 'dashboard', action: 'view' },
  request: {
    bodyContentType: 'multipart/form-data',
  },
  responses: {
    201: {
      description: 'The uploaded media asset.',
      schema: mediaAssetSummary,
    },
    400: { description: 'No file provided or file too large.' },
    422: { description: 'Unsupported file type, or larger than the limit for its type.' },
  },
  handler: ({ req }) => created(firstUpload(req)),
});

defineRoute(mediaRouter, {
  method: 'post',
  path: '/v1/store/media/upload',
  surface: 'storefront',
  operationId: 'uploadCustomerMedia',
  summary: 'Upload a media asset',
  description:
    'Uploads a file to S3 and creates a media asset record. The returned `id` can be used in storefront APIs (like reviews or custom orders).',
  tags: ['Store / Media'],
  auth: 'customer',
  request: {
    bodyContentType: 'multipart/form-data',
  },
  responses: {
    201: {
      description: 'The uploaded media asset.',
      schema: mediaAssetSummary,
    },
    400: { description: 'No file provided or file too large.' },
    422: { description: 'Unsupported file type, or larger than the limit for its type.' },
  },
  handler: ({ req }) => created(firstUpload(req)),
});
