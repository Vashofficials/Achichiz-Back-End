import type { Request, Response, Router } from 'express';
import type { ZodType, infer as ZodInfer } from 'zod';
import { registry, type AuthMode, type HttpMethod, type ResponseSpec, type Surface } from './registry.js';
import type { Action, ModuleKey } from '../rbac-matrix.js';
import type { HandlerResult } from '../http.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { namedLimiter, type LimiterName } from '../../middleware/rate-limit.js';
import { auditMutation } from '../../middleware/audit.js';
import { idempotency } from '../../middleware/idempotency.js';

/** Narrowed per `auth` so a public handler cannot read `auth.customerId`. */
export type CustomerAuth = { kind: 'customer'; customerId: string; sessionId: string };
export type StaffAuth = {
  kind: 'staff';
  staffId: string;
  sessionId: string;
  role: string;
  permissions: ReadonlySet<string>;
};
export type AuthFor<M extends AuthMode> = M extends 'customer'
  ? CustomerAuth
  : M extends 'staff'
    ? StaffAuth
    : undefined;

type Z<T extends ZodType | undefined> = T extends ZodType ? ZodInfer<T> : undefined;

export type RouteContext<P extends ZodType | undefined, Q extends ZodType | undefined, B extends ZodType | undefined, M extends AuthMode> = {
  params: Z<P>;
  query: Z<Q>;
  body: Z<B>;
  auth: AuthFor<M>;
  req: Request;
  res: Response;
};

export type RouteSpec<
  P extends ZodType | undefined,
  Q extends ZodType | undefined,
  B extends ZodType | undefined,
  M extends AuthMode,
> = {
  method: HttpMethod;
  /** Express path with `:params`, e.g. `/v1/orders/:orderId`. */
  path: string;
  surface: Surface;
  /** Unique across BOTH surfaces — it becomes the generated client's function name. */
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: M;
  /** Required when `auth: 'staff'`. Omitted only for staff routes every role may call (e.g. /admin/me). */
  permission?: { module: ModuleKey; action: Action };
  deprecated?: boolean;
  request?: { params?: P; query?: Q; body?: B; bodyContentType?: string };
  responses: Record<number, ResponseSpec>;
  rateLimit?: LimiterName;
  /** Require an `Idempotency-Key` header and replay the stored response. */
  idempotent?: boolean;
  /** Skip the automatic audit-log write for a staff mutation. Use sparingly. */
  skipAudit?: boolean;
  /**
   * Sync return is allowed so a handler that does no I/O (probes, static
   * lookups) is not forced into a pointless `async`, which `require-await`
   * would then flag. `defineRoute` awaits either shape.
   */
  handler: (ctx: RouteContext<P, Q, B, M>) => HandlerResult | Promise<HandlerResult>;
};

/**
 * Registers an Express handler AND the OpenAPI operation from one declaration.
 *
 * They cannot drift, because they are the same object. This is the only
 * sanctioned way to add an endpoint — `eslint no-restricted-syntax` bans bare
 * `router.get/post/...` outside this directory, and `tests/openapi-coverage.test.ts`
 * diffs the mounted router against the registry in both directions.
 */
export function defineRoute<
  P extends ZodType | undefined = undefined,
  Q extends ZodType | undefined = undefined,
  B extends ZodType | undefined = undefined,
  M extends AuthMode = 'public',
>(router: Router, spec: RouteSpec<P, Q, B, M>): void {
  if (spec.auth === 'staff' && spec.surface !== 'admin') {
    throw new Error(`${spec.operationId}: staff auth is only valid on the admin surface.`);
  }
  if (spec.surface === 'admin' && spec.auth === 'staff' && !spec.permission && !spec.path.includes('/admin/auth/')) {
    throw new Error(
      `${spec.operationId}: admin routes must declare a permission. If it is genuinely open to every ` +
        `authenticated staff member, say so explicitly with permission: { module: 'dashboard', action: 'view' }.`,
    );
  }

  registry.add({
    method: spec.method,
    path: spec.path,
    surface: spec.surface,
    operationId: spec.operationId,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    tags: spec.tags,
    auth: spec.auth,
    ...(spec.permission ? { permission: spec.permission } : {}),
    ...(spec.deprecated ? { deprecated: spec.deprecated } : {}),
    request: {
      ...(spec.request?.params ? { params: spec.request.params } : {}),
      ...(spec.request?.query ? { query: spec.request.query } : {}),
      ...(spec.request?.body ? { body: spec.request.body } : {}),
      ...(spec.request?.bodyContentType ? { bodyContentType: spec.request.bodyContentType } : {}),
    },
    responses: spec.responses,
  });

  const chain = [
    spec.rateLimit ? namedLimiter(spec.rateLimit) : undefined,
    spec.auth !== 'public' ? authenticate(spec.auth) : undefined,
    spec.permission ? requirePermission(spec.permission.module, spec.permission.action) : undefined,
    spec.idempotent ? idempotency() : undefined,
    validate({
      params: spec.request?.params,
      query: spec.request?.query,
      body: spec.request?.body,
    }),
    spec.surface === 'admin' && spec.method !== 'get' && !spec.skipAudit
      ? auditMutation(spec.operationId)
      : undefined,
  ].filter(Boolean);

  // Express 5 forwards async rejections to the error middleware automatically.
  // No asyncHandler wrapper, no per-route try/catch.
  const terminal = async (req: Request, res: Response): Promise<void> => {
    const ctx = {
      params: req.valid.params,
      query: req.valid.query,
      body: req.valid.body,
      auth: req.auth,
      req,
      res,
    } as RouteContext<P, Q, B, M>;

    const result = await spec.handler(ctx);

    if (result.kind === 'raw') return;
    if (result.kind === 'noContent') {
      res.status(204).end();
      return;
    }
    res.status(result.status).json(result.body);
  };

  router[spec.method](spec.path, ...(chain as never[]), terminal);
}
