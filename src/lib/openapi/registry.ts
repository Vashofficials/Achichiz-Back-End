import type { ZodType } from 'zod';
import type { Action, ModuleKey } from '../rbac-matrix.js';

export type Surface = 'storefront' | 'admin';
export type AuthMode = 'public' | 'customer' | 'staff';
export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

export type ResponseSpec = {
  description: string;
  /**
   * The PAYLOAD schema, not the envelope.
   *
   * `buildDocument` wraps it: a non-array becomes `{ data }`, an array becomes
   * `{ data, meta }` — mirroring what `lib/http.ts` does at runtime. Declare the
   * interesting part; the wrapper is applied for you.
   *
   * Omit for 204.
   */
  schema?: ZodType;
  /** Set false for responses that bypass the envelope (webhook acks, raw writes). */
  envelope?: false;
  /** Optional named example, surfaced in Swagger UI. */
  example?: unknown;
};

export type RegisteredRoute = {
  method: HttpMethod;
  /** Express-style path, e.g. `/v1/products/:handle`. */
  path: string;
  surface: Surface;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: AuthMode;
  permission?: { module: ModuleKey; action: Action };
  deprecated?: boolean;
  /**
   * The route rejects without an `Idempotency-Key` header.
   *
   * Carried into the document as a required header parameter. It used to be
   * applied as middleware only, so eighteen routes 422'd on a missing header
   * that appeared nowhere in the spec — Swagger's "Try it out" and any generated
   * client hit it with no way to know why.
   */
  idempotent?: boolean;
  request: {
    params?: ZodType;
    query?: ZodType;
    body?: ZodType;
    /** Content type for the body. Defaults to application/json. */
    bodyContentType?: string;
  };
  responses: Record<number, ResponseSpec>;
};

/**
 * The single source of truth for what this API exposes.
 *
 * `defineRoute()` is the ONLY thing that writes here, and it is also the only
 * thing that mounts an Express handler — which is what makes the route-coverage
 * test in `tests/openapi-coverage.test.ts` pass by construction, and what makes
 * a bare `router.post(...)` a lint error rather than a silent undocumented endpoint.
 */
class RouteRegistry {
  readonly #routes: RegisteredRoute[] = [];
  readonly #operationIds = new Set<string>();

  add(route: RegisteredRoute): void {
    if (this.#operationIds.has(route.operationId)) {
      throw new Error(
        `Duplicate operationId '${route.operationId}'. operationIds must be unique across both surfaces — ` +
          `the generated frontend client uses them as function names.`,
      );
    }
    this.#operationIds.add(route.operationId);
    this.#routes.push(route);
  }

  list(surface?: Surface): readonly RegisteredRoute[] {
    return surface ? this.#routes.filter((r) => r.surface === surface) : this.#routes;
  }

  /** `['GET /v1/products', ...]` — used by the coverage test. */
  signatures(): string[] {
    return this.#routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
  }

  clear(): void {
    this.#routes.length = 0;
    this.#operationIds.clear();
  }
}

export const registry = new RouteRegistry();
