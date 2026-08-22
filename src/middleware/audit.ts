import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';

/**
 * Writes an audit row for every staff mutation.
 *
 * Applied automatically by `defineRoute` to every non-GET admin route, so
 * "did anyone remember to audit this endpoint" is not a question anyone has to
 * ask. Opt out with `skipAudit: true` and a reason.
 *
 * Deliberately fire-and-forget AFTER the response: an audit-log outage must not
 * fail a refund that already succeeded. The write is logged loudly if it fails.
 *
 * Raw SQL rather than Drizzle on purpose — this middleware must not depend on
 * the schema module graph, so it keeps working during migrations that touch it.
 */
const INSERT = `
  INSERT INTO audit_log
    (actor_staff_id, actor_role, operation_id, method, path, status_code,
     request_id, ip_address, user_agent, target_id, payload)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`;

/** Never persist these, even inside an audit payload. */
const SENSITIVE = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'otp',
  'token',
  'refreshToken',
  'accessToken',
  'secret',
  'apiKey',
  'cvv',
  'card',
]);

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SENSITIVE.has(k) ? '[redacted]' : scrub(v, depth + 1),
    ]),
  );
}

export function auditMutation(operationId: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      // Only record what actually changed something.
      if (res.statusCode >= 400) return;
      const auth = req.auth;
      if (!auth || auth.kind !== 'staff') return;

      const params = (req.valid.params ?? {}) as Record<string, unknown>;
      const targetId =
        typeof params.id === 'string'
          ? params.id
          // Type predicate rather than an assertion — this actually narrows,
          // where `as string | undefined` only silenced the compiler.
          : (Object.values(params).find((v): v is string => typeof v === 'string') ?? null);

      const payload = scrub(req.valid.body ?? {});

      pool
        .query(INSERT, [
          auth.staffId,
          auth.role,
          operationId,
          req.method,
          (req.route as { path?: string } | undefined)?.path ?? req.path,
          res.statusCode,
          req.requestId,
          req.ip ?? null,
          req.headers['user-agent'] ?? null,
          targetId,
          JSON.stringify(payload),
        ])
        .catch((err: unknown) => {
          // Loud, because a silent audit gap is worse than a failed request.
          logger.error({ err, operationId, staffId: auth.staffId }, 'AUDIT WRITE FAILED');
        });
    });

    next();
  };
}
