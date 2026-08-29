import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created } from '../../lib/http.js';
import * as service from './media.service.js';
import { mediaAssetSummary } from './media.schemas.js';

export const mediaRouter = Router();

// `defineRoute` installs the shared multipart interceptor for these routes. It
// uploads the file once, replaces `req.body.file` with the resulting asset ID,
// and then the normal route validation/handler pipeline runs.
const uploadedMediaBody = z.object({
  file: z.string().uuid(),
});

defineRoute(mediaRouter, {
  method: 'post',
  path: '/v1/admin/media/upload',
  surface: 'admin',
  operationId: 'uploadMedia',
  summary: 'Upload a media asset',
  description: 'Uploads a file to S3 and creates a media asset record. The returned `id` can be used as an `imageRef` or `mediaId` in other Admin APIs.',
  tags: ['Admin / Media'],
  auth: 'staff',
  permission: { module: 'dashboard', action: 'view' },
  request: {
    body: uploadedMediaBody,
    bodyContentType: 'multipart/form-data',
  },
  responses: {
    201: {
      description: 'The uploaded media asset.',
      schema: z.object({
        data: mediaAssetSummary,
      }),
    },
    400: { description: 'Malformed multipart payload or file too large.' },
  },
  handler: async ({ body }) => created(await service.getMedia(body.file)),
});

defineRoute(mediaRouter, {
  method: 'post',
  path: '/v1/store/media/upload',
  surface: 'storefront',
  operationId: 'uploadCustomerMedia',
  summary: 'Upload a media asset',
  description: 'Uploads a file to S3 and creates a media asset record. The returned `id` can be used in storefront APIs (like reviews or custom orders).',
  tags: ['Store / Media'],
  auth: 'customer',
  request: {
    body: uploadedMediaBody,
    bodyContentType: 'multipart/form-data',
  },
  responses: {
    201: {
      description: 'The uploaded media asset.',
      schema: z.object({
        data: mediaAssetSummary,
      }),
    },
    400: { description: 'Malformed multipart payload or file too large.' },
  },
  handler: async ({ body }) => created(await service.getMedia(body.file)),
});
