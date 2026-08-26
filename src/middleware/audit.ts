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
/**
 * The audit table is `activity_logs`, not `audit_log`.
 *
 * This statement previously named `audit_log` with eleven columns that do not
 * exist anywhere in the schema (`operation_id`, `method`, `path`, `status_code`,
 * `ip_address`, `target_id`, `payload`). Every write therefore failed with
 * `relation "audit_log" does not exist` — and because the write is deliberately
 * fire-and-forget, it failed into a log line instead of a response. The API
 * looked audited and recorded nothing.
 *
 * Column mapping worth stating:
 *  - `action` carries the operationId. operationIds are unique across both
 *    surfaces, so METHOD and PATH are recoverable from it and lose nothing by
 *    having no column of their own.
 *  - `actor_label` is NOT NULL and the request only knows the staff id, so the
 *    name is fetched inline. The fallback keeps the insert alive if the staff
 *    row is gone.
 *  - `entity_id` is UUID. See `uuidish` below — the old code put ANY string
 *    param here, so `/v1/admin/barcodes/:sku` would have tried to store a SKU
 *    in a uuid column.
 */
const INSERT = `
  INSERT INTO activity_logs
    (actor_kind, actor_staff_id, actor_label, actor_role,
     action, entity_type, entity_id, after_data, changed_fields,
     ip, user_agent, request_id)
  VALUES (
    'staff', $1,
    COALESCE((SELECT full_name FROM staff_users WHERE id = $1), 'staff ' || $1::text),
    $2, $3, $4, $5, $6, $7, $8, $9, $10)
`;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidish = (v: unknown): v is string => typeof v === 'string' && UUID_SHAPE.test(v);

/**
 * `/v1/admin/purchase-orders/:id/receive` → `purchase-orders`.
 *
 * `entity_type` is NOT NULL and is what the audit screen groups by, so it has to
 * be something, and the resource segment is the only honest answer available
 * without a per-route declaration.
 */
function entityTypeOf(path: string): string {
  const after = path.replace(/^\/v1\/admin\//, '').replace(/^\/v1\//, '');
  const segment = after.split('/').find((s) => s && !s.startsWith(':'));
  return segment ?? 'admin';
}

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
      // Only a UUID may go into `entity_id`. A route keyed by SKU, handle or
      // report name has no uuid to record, and null is the truthful answer —
      // the old code took the first string it found and would have failed the
      // insert on `/v1/admin/barcodes/:sku`.
      const entityId = uuidish(params.id)
        ? params.id
        : (Object.values(params).find(uuidish) ?? null);

      const body = (req.valid.body ?? {}) as Record<string, unknown>;
      const payload = scrub(body);
      const changedFields = Object.keys(body);

      const routePath = (req.route as { path?: string } | undefined)?.path ?? req.path;

      pool
        .query(INSERT, [
          auth.staffId,
          auth.role,
          operationId,
          entityTypeOf(routePath),
          entityId,
          JSON.stringify(payload),
          changedFields,
          req.ip ?? null,
          req.headers['user-agent'] ?? null,
          req.requestId,
        ])
        .catch((err: unknown) => {
          // Loud, because a silent audit gap is worse than a failed request.
          logger.error({ err, operationId, staffId: auth.staffId }, 'AUDIT WRITE FAILED');
        });
    });

    next();
  };
}
