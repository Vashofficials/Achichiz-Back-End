import type { CustomerAuth, StaffAuth } from '../lib/openapi/define-route.js';

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
    }
  }
}

export {};
