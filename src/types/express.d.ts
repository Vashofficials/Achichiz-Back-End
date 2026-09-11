import type { CustomerAuth, StaffAuth } from '../lib/openapi/define-route.js';
import type { UploadedAsset } from '../middleware/file-interceptor.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by request-context middleware. Echoed in every error body and log line. */
      requestId: string;
      /** Populated by `validate()`. Empty objects when the route declares no schema. */
      valid: {
        params: unknown;
        query: unknown;
        body: unknown;
      };
      /** Populated by `authenticate()`. `undefined` on public routes. */
      auth: CustomerAuth | StaffAuth | undefined;
      /** Raw body, captured only for signature-verified webhook routes. */
      rawBody?: Buffer;
      /**
       * Every file on a multipart request, already stored, in the order it was sent. Set by
       * `fileInterceptor`, which is the ONLY place a multipart body may be parsed — the stream
       * can be read once, and a handler that runs multer again gets "Unexpected end of form".
       */
      uploadedAssets?: UploadedAsset[];
    }
  }
}

export {};
