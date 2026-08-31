import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { BadRequestError } from '../lib/errors.js';
import * as mediaService from '../modules/media/media.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

/** Multer hands back its own `MulterError` for limits, or a storage error. */
const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : 'The upload could not be read.';

/**
 * Accepts any multipart files on the request, stores each through the existing
 * media service, and replaces the field with the resulting asset id — so a route
 * whose body schema expects `mediaId` receives one whether the console sent a
 * file or an id it already had.
 *
 * The multer callback is typed `(err: any) => void`, so the async work is run
 * inside it rather than passed as it: handing multer a promise-returning
 * function means rejections are unhandled and `next()` may fire twice.
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
      if (files.length === 0) {
        next();
        resolve();
        return;
      }

      void (async () => {
        try {
          const staffId = req.auth?.kind === 'staff' ? req.auth.staffId : null;
          const body = (req.body ?? {}) as Record<string, unknown>;

          for (const file of files) {
            const asset = await mediaService.uploadMedia(file, staffId);
            // The field keeps its name; only the value changes from a file to
            // the id the route's schema actually validates.
            body[file.fieldname] = asset.id;
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
