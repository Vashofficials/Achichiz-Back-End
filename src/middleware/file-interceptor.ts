import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { BadRequestError, UnprocessableError } from '../lib/errors.js';
import * as mediaService from '../modules/media/media.service.js';

export type UploadedAsset = Awaited<ReturnType<typeof mediaService.uploadMedia>>;

/**
 * What may be uploaded, and how large it may be.
 *
 * Images keep the 5 MB ceiling they always had. Short product videos are the reason the
 * multer limit is higher than that: multer only knows one global `fileSize`, so it is set to
 * the largest kind and each file is then re-checked against its own kind's ceiling.
 *
 * Everything is held in memory until it reaches S3 (`media.service` uploads `file.buffer`).
 * At 10 files × 50 MB the worst case is ~500 MB for one request, so the file count and the
 * video ceiling are the two numbers to lower first if the API host is memory-constrained.
 */
const MB = 1024 * 1024;
export const UPLOAD_LIMITS = {
  maxFiles: 10,
  imageBytes: 5 * MB,
  videoBytes: 50 * MB,
  pdfBytes: 10 * MB,
} as const;

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMITS.videoBytes, files: UPLOAD_LIMITS.maxFiles },
});

/** Multer hands back its own `MulterError` for limits, or a storage error. */
const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : 'The upload could not be read.';

const ceilingFor = (mime: string): number =>
  mime.startsWith('video/')
    ? UPLOAD_LIMITS.videoBytes
    : mime === 'application/pdf'
      ? UPLOAD_LIMITS.pdfBytes
      : UPLOAD_LIMITS.imageBytes;

const human = (bytes: number): string => `${Math.round(bytes / MB)} MB`;

/**
 * THE ONLY PLACE A MULTIPART BODY IS PARSED.
 *
 * `defineRoute` mounts this automatically for any route declaring
 * `bodyContentType: 'multipart/form-data'`. A request stream can be read exactly once, so a
 * handler that runs multer again sees an empty stream and busboy fails with
 * "Unexpected end of form" — which is precisely how multi-image product uploads broke.
 * Handlers read `req.uploadedAssets` instead.
 *
 * Every file is validated BEFORE any is stored, so a batch with one bad file uploads nothing
 * rather than leaving the good ones orphaned in S3 with no row pointing at them.
 *
 * Body fields keep their names with the file swapped for the stored asset id. A field sent
 * more than once becomes an array of ids — it used to be overwritten on every iteration, so
 * four files named `files` produced one id.
 *
 * The multer callback is typed `(err: any) => void`, so the async work runs inside it rather
 * than being passed as it: a promise-returning callback leaves rejections unhandled and can
 * call `next()` twice.
 */
export const fileInterceptor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  return new Promise<void>((resolve) => {
    upload.any()(req, res, (err: unknown) => {
      if (err) {
        next(new BadRequestError(messageOf(err)));
        resolve();
        return;
      }

      const files = Array.isArray(req.files) ? req.files : [];
      req.uploadedAssets = [];
      if (files.length === 0) {
        next();
        resolve();
        return;
      }

      // Validate the whole batch first.
      for (const file of files) {
        if (!ALLOWED_MIME.has(file.mimetype)) {
          next(
            new UnprocessableError(
              `"${file.originalname}" is not a supported file type (${file.mimetype}). ` +
                'Use JPG, PNG, WEBP, GIF, AVIF or SVG images, MP4/WEBM/MOV video, or PDF.',
              'unsupported_media_type',
            ),
          );
          resolve();
          return;
        }
        const ceiling = ceilingFor(file.mimetype);
        if (file.size > ceiling) {
          next(
            new UnprocessableError(
              `"${file.originalname}" is ${human(file.size)}; the limit for this type is ${human(ceiling)}.`,
              'media_too_large',
            ),
          );
          resolve();
          return;
        }
      }

      void (async () => {
        try {
          const staffId = req.auth?.kind === 'staff' ? req.auth.staffId : null;
          const body = (req.body ?? {}) as Record<string, unknown>;
          const byField = new Map<string, string[]>();

          for (const file of files) {
            const asset = await mediaService.uploadMedia(file, staffId);
            req.uploadedAssets!.push(asset);

            const ids = byField.get(file.fieldname) ?? [];
            ids.push(asset.id);
            byField.set(file.fieldname, ids);

            if (['image', 'attachment', 'logo', 'file'].includes(file.fieldname)) {
              body.imageUrl = asset.url;
              body.attachmentUrl = asset.url;
            }
          }

          for (const [field, ids] of byField) {
            body[field] = ids.length === 1 ? ids[0] : ids;
          }

          req.body = body;
          next();
        } catch (error) {
          next(error);
        } finally {
          resolve();
        }
      })();
    });
  });
};
