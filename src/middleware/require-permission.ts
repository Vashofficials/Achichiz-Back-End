import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors.js';
import { permissionKey, type Action, type ModuleKey } from '../lib/rbac-matrix.js';

/**
 * The authorization boundary.
 *
 * `defineRoute` supplies module + action from the route declaration, so a
 * permission gate cannot be forgotten by omission — an admin route without one
 * throws at startup, not at runtime.
 *
 * The permission set comes from the verified JWT (embedded at login from
 * `role_permissions`). No database round-trip on the hot path.
 */
export function requirePermission(module: ModuleKey, action: Action): RequestHandler {
  const required = permissionKey(module, action);

  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;

    if (!auth) {
      next(new UnauthenticatedError('Authentication is required.'));
      return;
    }
    if (auth.kind !== 'staff') {
      // A valid customer token on an admin route. Not a 401 — the token is fine,
      // it is simply not a staff token.
      next(new ForbiddenError('This endpoint is restricted to staff accounts.'));
      return;
    }
    if (!auth.permissions.has(required)) {
      next(
        new ForbiddenError(
          `Your role (${auth.role}) does not have permission to ${action} ${module}.`,
          { context: { required, role: auth.role } },
        ),
      );
      return;
    }

    next();
  };
}
