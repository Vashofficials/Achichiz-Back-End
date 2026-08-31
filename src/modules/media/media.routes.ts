import { Router } from 'express';
import multer from 'multer';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created } from '../../lib/http.js';
import { BadRequestError } from '../../lib/errors.js';
import * as service from './media.service.js';
import { mediaAssetSummary } from './media.schemas.js';

export const mediaRouter = Router();

// Buffer in memory (up to 5MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
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
    bodyContentType: 'multipart/form-data',
  },
  responses: {
    201: {
      description: 'The uploaded media asset.',
      schema: mediaAssetSummary,
    },
    400: { description: 'No file provided or file too large.' },
  },
  handler: async ({ req, res, auth }) => {
    return new Promise((resolve, reject) => {
      // Multer's callback is void-returning: running the async work inside it
      // rather than passing an async function keeps rejections handled.
      upload.single('file')(req, res, (err: unknown) => {
        if (err) {
          reject(new BadRequestError(err instanceof Error ? err.message : 'The upload could not be read.'));
          return;
        }
        if (!req.file) {
          reject(new BadRequestError('No file provided'));
          return;
        }
        void service
          .uploadMedia(req.file, auth.staffId)
          .then((asset) => resolve(created(asset)))
          .catch((e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
      });
    });
  },
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
    bodyContentType: 'multipart/form-data',
  },
  responses: {
    201: {
      description: 'The uploaded media asset.',
      schema: mediaAssetSummary,
    },
    400: { description: 'No file provided or file too large.' },
  },
  handler: async ({ req, res }) => {
    return new Promise((resolve, reject) => {
      // Multer's callback is void-returning: running the async work inside it
      // rather than passing an async function keeps rejections handled.
      upload.single('file')(req, res, (err: unknown) => {
        if (err) {
          reject(new BadRequestError(err instanceof Error ? err.message : 'The upload could not be read.'));
          return;
        }
        if (!req.file) {
          reject(new BadRequestError('No file provided'));
          return;
        }
        // Customers don't have a staff ID, so uploadedBy stays null.
        void service
          .uploadMedia(req.file, null)
          .then((asset) => resolve(created(asset)))
          .catch((e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
      });
    });
  },
});

