import { describe, expect, it, beforeAll } from 'vitest';
import type { Express } from 'express';
import { registry } from '../src/lib/openapi/registry.js';
import { buildDocument } from '../src/lib/openapi/document.js';

/**
 * CI GATE 2 OF 3 — the actual anti-drift mechanism.
 *
 * Walks the real Express router stack and diffs it against the OpenAPI registry
 * in BOTH directions:
 *   - mounted but undocumented → someone bypassed defineRoute
 *   - documented but not mounted → a phantom endpoint in the published spec
 *
 * Because defineRoute is the only registration path, this passes by construction.
 * It goes red the moment someone reaches for a bare `router.post(...)`.
 *
 * (Gate 1: committed openapi.json + `git diff --exit-code`. Gate 3: spectral.)
 */

type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp;
};

function enumerateRoutes(app: Express): string[] {
  const found: string[] = [];

  const walk = (stack: Layer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const path = prefix + layer.route.path;
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled && method !== '_all') found.push(`${method.toUpperCase()} ${path}`);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix);
      }
    }
  };

  // Express 5 keeps the router on app.router
  const stack = ((app as unknown as { router?: { stack?: Layer[] } }).router?.stack ?? []);
  walk(stack, '');
  return [...new Set(found)].sort();
}

describe('OpenAPI ↔ Express coverage', () => {
  let app: Express;

  beforeAll(async () => {
    const { createApp } = await import('../src/app.js');
    app = createApp();
  });

  it('every mounted route is documented', () => {
    const mounted = enumerateRoutes(app).filter((r) => !r.includes('/docs') && !r.includes('/openapi'));
    const documented = new Set(registry.signatures());
    const undocumented = mounted.filter((r) => !documented.has(r));

    expect(
      undocumented,
      `These endpoints are live but absent from the OpenAPI document. ` +
        `They were almost certainly mounted with a bare router call instead of defineRoute().`,
    ).toEqual([]);
  });

  it('every documented route is mounted', () => {
    const mounted = new Set(enumerateRoutes(app));
    const phantom = registry.signatures().filter((r) => !mounted.has(r));

    expect(
      phantom,
      `These endpoints are in the published spec but not mounted. Frontends generated from ` +
        `this document would call them and get a 404.`,
    ).toEqual([]);
  });

  it('every operationId is unique', () => {
    const ids = registry.list().map((r) => r.operationId);
    expect(new Set(ids).size, 'duplicate operationIds break the generated client').toBe(ids.length);
  });

  it('every admin route declares a permission', () => {
    const ungated = registry
      .list('admin')
      .filter((r) => r.auth === 'staff' && !r.permission && !r.path.includes('/admin/auth/'))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);

    expect(ungated, 'an admin route without a permission is an open admin route').toEqual([]);
  });

  /**
   * A required header that the document does not mention is invisible to every
   * consumer of it: Swagger's "Try it out", a generated client, an integrator
   * reading the spec. All of them get a 422 with nothing in the contract
   * explaining it — which is exactly how the admin panel's invite button shipped
   * broken.
   */
  it('every idempotent route documents its Idempotency-Key header', () => {
    for (const surface of ['storefront', 'admin'] as const) {
      const doc = buildDocument(surface) as {
        paths: Record<string, Record<string, { parameters?: { name?: string; required?: boolean }[] }>>;
      };

      const required = registry.list(surface).filter((r) => r.idempotent);
      expect(required.length, `expected ${surface} to have idempotent routes to check`).toBeGreaterThan(0);

      for (const route of required) {
        // The registry stores Express paths; the document uses OpenAPI braces.
        const openApiPath = route.path.replace(/:(\w+)/g, '{$1}');
        const op = doc.paths[openApiPath]?.[route.method];
        const header = op?.parameters?.find((p) => p.name === 'Idempotency-Key');

        expect(header, `${route.operationId} rejects without Idempotency-Key but never documents it`).toBeDefined();
        expect(header?.required, `${route.operationId} documents Idempotency-Key as optional; it is not`).toBe(true);
      }
    }
  });
});
