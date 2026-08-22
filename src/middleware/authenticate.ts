import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requestContext } from '../config/logger.js';
import { UnauthenticatedError } from '../lib/errors.js';
import { verifyCustomerToken } from '../modules/auth/customer-token.js';
import { verifyStaffToken } from '../modules/admin-auth/staff-token.js';
import { isSessionRevoked } from '../modules/auth/session-store.js';

function bearer(req: Request): string {
  const header = req.headers.authorization;
  if (!header) throw new UnauthenticatedError('Authorization header is missing.');
  if (!header.startsWith('Bearer ')) throw new UnauthenticatedError('Only Bearer tokens are accepted.');
  const token = header.slice(7).trim();
  if (!token) throw new UnauthenticatedError('Bearer token is empty.');
  return token;
}

/**
 * Verifies the token for the audience the route declared.
 *
 * Revocation: tokens are short-lived and stateless, but a "sign out everywhere"
 * or a compromised session must take effect immediately, so every request checks
 * a Redis denylist keyed by session id. That is one O(1) Redis GET, not a
 * database round-trip.
 */
export function authenticate(kind: 'customer' | 'staff'): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = bearer(req);

      if (kind === 'customer') {
        const claims = await verifyCustomerToken(token);
        if (await isSessionRevoked(claims.sessionId)) {
          throw new UnauthenticatedError('This session has been signed out.');
        }
        req.auth = { kind: 'customer', customerId: claims.customerId, sessionId: claims.sessionId };
        const ctx = requestContext.getStore();
        if (ctx) {
          ctx.actorId = claims.customerId;
          ctx.actorKind = 'customer';
        }
      } else {
        const claims = await verifyStaffToken(token);
        if (await isSessionRevoked(claims.sessionId)) {
          throw new UnauthenticatedError('This session has been signed out.');
        }
        req.auth = {
          kind: 'staff',
          staffId: claims.staffId,
          sessionId: claims.sessionId,
          role: claims.role,
          permissions: claims.permissions,
        };
        const ctx = requestContext.getStore();
        if (ctx) {
          ctx.actorId = claims.staffId;
          ctx.actorKind = 'staff';
        }
      }

      next();
    } catch (err) {
      // jose throws typed errors (expired, signature, audience). They all mean the
      // same thing to a client, and distinguishing them leaks information.
      next(err instanceof UnauthenticatedError ? err : new UnauthenticatedError('Invalid or expired token.'));
    }
  };
}
