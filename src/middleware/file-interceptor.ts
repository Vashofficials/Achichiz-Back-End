import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { BadRequestError } from '../lib/errors.js';
import * as mediaService from '../modules/media/media.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

export const fileInterceptor = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  return new Promise((resolve) => {
    upload.any()(req, res, async (err: any) => {
      if (err) {
        next(new BadRequestError(err.message));
        return resolve();
      }

      if (req.files && Array.isArray(req.files)) {
        try {
          const staffId = req.auth?.kind === 'staff' ? req.auth.staffId : null;
          
          for (const file of req.files) {
            // Upload to S3 and generate media record
            const asset = await mediaService.uploadMedia(file, staffId);
            
            // Map the media ID back into the body under the original field name
            req.body = req.body || {};
            // The frontend should send the file with the correct field name (e.g. `mediaId` or `file`)
            req.body[file.fieldname] = asset.id;
          }
        } catch (error) {
          next(error);
          return resolve();
        }
      }
      
      next();
      resolve();
    });
  });
};
