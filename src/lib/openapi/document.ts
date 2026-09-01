import { z, type ZodType } from 'zod';
import { env } from '../../config/env.js';
import { registry, type RegisteredRoute, type Surface } from './registry.js';

/**
 * OpenAPI 3.1 documents, generated from the same zod schemas that validate
 * requests at runtime.
 *
 * We use zod 4's native `z.toJSONSchema({ target: 'draft-2020-12' })` rather than
 * a bridge library: OpenAPI 3.1 components ARE JSON Schema 2020-12, so the
 * conversion is lossless and needs no third-party dependency that has to keep
 * pace with zod's releases.
 */
type JsonSchema = Record<string, unknown>;

/**
 * zod emits a `$schema` dialect declaration on every schema, which is right for a
 * standalone JSON Schema document and wrong inside OpenAPI: the document's own
 * `openapi: 3.1.0` already fixes the dialect, so a per-schema `$schema` is
 * redundant, bloats the spec, and trips some validators. Strip it recursively —
 * nested object/array schemas carry it too.
 */
function stripDialect(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDialect);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === '$schema') continue;
    out[k] = stripDialect(v);
  }
  return out;
}

const toJson = (schema: ZodType, io: 'input' | 'output'): JsonSchema =>
  stripDialect(
    z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }),
  ) as JsonSchema;

/** `/v1/orders/:orderId` → `/v1/orders/{orderId}` */
const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function parametersFrom(schema: ZodType | undefined, location: 'path' | 'query'): unknown[] {
  if (!schema) return [];
  const json = toJson(schema, 'input');
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required ?? []) as string[]);

  return Object.entries(properties).map(([name, propSchema]) => {
    const { description, ...rest } = propSchema;
    return {
      name,
      in: location,
      // Path params are always required, whatever the schema says.
      required: location === 'path' ? true : required.has(name),
      ...(description ? { description } : {}),
      schema: rest,
    };
  });
}

const PAGE_META: JsonSchema = {
  type: 'object',
  required: ['page', 'perPage', 'total', 'totalPages'],
  properties: {
    page: { type: 'integer', description: '1-indexed page number.' },
    perPage: { type: 'integer', description: 'Items in this page.' },
    total: { type: 'integer', description: 'Total items matching the query.' },
    totalPages: { type: 'integer', description: 'Total pages at this `perPage`.' },
  },
};

/**
 * Wrap a declared response schema in the response envelope.
 *
 * Routes declare the PAYLOAD — `productSummary`, or `z.array(productSummary)` —
 * because that is the interesting part and repeating `{ type, result }` in 200+
 * route declarations would be noise nobody maintains. The envelope itself is
 * applied uniformly by `lib/http.ts` at runtime, so it is applied uniformly here.
 *
 * Without this the published contract was wrong for EVERY endpoint: a generated
 * client typed `listProducts` as returning a bare array when it actually returns
 * `{ type, result, meta }`, and every access in the frontend would have been a
 * type error against a spec that looked authoritative. The route-coverage test
 * proves an endpoint EXISTS; nothing proved its response SHAPE — this is the gap
 * that closes it.
 */
function envelope(payload: JsonSchema): JsonSchema {
  const isList = payload.type === 'array';
  return {
    type: 'object',
    required: isList ? ['type', 'result', 'meta'] : ['type', 'result'],
    properties: {
      type: { type: 'string', example: 'success' },
      result: payload,
      ...(isList ? { meta: PAGE_META } : {}),
    },
    additionalProperties: false,
  };
}

const PROBLEM_DETAILS: JsonSchema = {
  type: 'object',
  description: 'Standard error envelope. Every error from this API has this shape.',
  required: ['type', 'result'],
  properties: {
    type: { type: 'string', example: 'error' },
    result: {
      type: 'object',
      required: ['title', 'status', 'code'],
      properties: {
        title: { type: 'string', example: 'Validation failed' },
        status: { type: 'integer', example: 422 },
        code: {
          type: 'string',
          description: 'Stable machine-readable error code. Frontends switch on this, not on `title`.',
          example: 'validation_failed',
        },
        detail: { type: 'string', example: '2 fields are invalid.' },
        instance: { type: 'string', example: '/v1/checkout/orders' },
        requestId: { type: 'string', example: '01JK8QP2XM9TZ4W7B3C5D6E7F8' },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'code', 'message'],
            properties: {
              path: { type: 'string', example: 'shippingAddress.pincode' },
              code: { type: 'string', example: 'invalid_string' },
              message: { type: 'string', example: 'Pincode must be 6 digits' },
            },
          },
        },
      },
    },
  },
};

const problemResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ProblemDetails' } } },
});

function implicitErrorResponses(route: RegisteredRoute): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (route.request.params || route.request.query || route.request.body) {
    out['422'] = problemResponse('Validation failed.');
  }
  if (route.auth !== 'public') {
    out['401'] = problemResponse('Missing, malformed or expired token.');
  }
  if (route.permission) {
    out['403'] = problemResponse(
      `Authenticated, but the staff role lacks \`${route.permission.module}:${route.permission.action}\`.`,
    );
  }
  return out;
}

/**
 * The header an idempotent route rejects without.
 *
 * Declared here rather than hand-written on each route so the middleware and the
 * document cannot disagree: `idempotent: true` is the single switch that turns
 * both on.
 */
const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'A UUID identifying this logical operation. REUSE it when retrying — that is what makes the retry safe. ' +
    'A new key on a retry is treated as a new operation and will duplicate the effect.',
  schema: { type: 'string', format: 'uuid' },
} as const;

function operationFor(route: RegisteredRoute): Record<string, unknown> {
  const parameters = [
    ...parametersFrom(route.request.params, 'path'),
    ...parametersFrom(route.request.query, 'query'),
    ...(route.idempotent ? [IDEMPOTENCY_HEADER] : []),
  ];

  const responses: Record<string, unknown> = { ...implicitErrorResponses(route) };
  for (const [status, spec] of Object.entries(route.responses)) {
    responses[status] = spec.schema
      ? {
          description: spec.description,
          content: {
            'application/json': {
              // `envelope: false` opts a route out — webhook acks and anything
              // that writes to `res` directly are not wrapped by lib/http.ts.
              schema:
                spec.envelope === false
                  ? toJson(spec.schema, 'output')
                  : envelope(toJson(spec.schema, 'output')),
              ...(spec.example !== undefined ? { example: spec.example } : {}),
            },
          },
        }
      : { description: spec.description };
  }

  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    tags: route.tags,
    ...(route.deprecated ? { deprecated: true } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(route.request.body || route.request.bodyContentType === 'multipart/form-data'
      ? {
          requestBody: {
            required: true,
            content: {
              [route.request.bodyContentType ?? 'application/json']: {
                schema: (() => {
                  const s = route.request.body ? toJson(route.request.body, 'input') : { type: 'object', properties: {} };
                  if (route.request.bodyContentType === 'multipart/form-data' && s.type === 'object') {
                    s.properties = {
                      ...(typeof s.properties === 'object' && s.properties !== null ? s.properties : {}),
                      file: { type: 'string', format: 'binary' },
                    };
                  }
                  return s;
                })(),
              },
            },
          },
        }
      : {}),
    responses,
    security:
      route.auth === 'public'
        ? []
        : route.auth === 'customer'
          ? [{ bearerAuth: [] }]
          : [{ adminBearerAuth: [] }],
  };
}

const SURFACE_META: Record<Surface, { title: string; description: string }> = {
  storefront: {
    title: 'Achichiz Storefront API',
    description: [
      'Public and customer-authenticated API powering the Achichiz storefront.',
      '',
      '**Money is always an integer number of paise.** `"total": 149900` means ₹1,499.00.',
      '',
      'Errors return a consistent `{ type: "error", result: {...} }` format carrying a stable `code`.',
      'Switch on `result.code`, never on `title`.',
    ].join('\n'),
  },
  admin: {
    title: 'Achichiz Admin API',
    description: [
      'Staff-authenticated operations API for the Achichiz admin console.',
      '',
      'Every endpoint is gated by a `module:action` permission resolved server-side from the',
      "staff member's role. A 403 means the token was valid and the role was not.",
      '',
      '**Money is always an integer number of paise.**',
    ].join('\n'),
  },
};

export function buildDocument(surface: Surface): Record<string, unknown> {
  const routes = registry.list(surface);
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const path = toOpenApiPath(route.path);
    paths[path] ??= {};
    paths[path][route.method] = operationFor(route);
  }

  const tags = [...new Set(routes.flatMap((r) => r.tags))].sort().map((name) => ({ name }));

  return {
    openapi: '3.1.0',
    info: {
      ...SURFACE_META[surface],
      version: process.env.npm_package_version ?? '0.1.0',
      contact: { name: 'Achichiz Engineering', email: 'connect@achiachi.in' },
    },
    servers: [
      { url: env.API_PUBLIC_URL, description: env.isProduction ? 'Production' : 'Local' },
      ...(env.isProduction
        ? []
        : [{ url: 'https://api.achichiz.com', description: 'Production' }]),
      ...(!env.isProduction
        ? []
        : [{ url: 'http://localhost:4000', description: 'Local' }]),
    ],
    tags,
    paths,
    components: {
      schemas: { ProblemDetails: PROBLEM_DETAILS },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Customer access token from `POST /v1/auth/otp/verify` or `POST /v1/auth/login`. ' +
            'Expires in 15 minutes; refresh via the httpOnly `ach_rt` cookie at `POST /v1/auth/refresh`.',
        },
        adminBearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Staff access token from `POST /v1/admin/auth/2fa/verify`. Expires in 10 minutes. ' +
            'Carries `aud: "admin"` — a customer token is rejected on every /v1/admin route.',
        },
      },
    },
  };
}

export const buildAllDocuments = (): Record<Surface, Record<string, unknown>> => ({
  storefront: buildDocument('storefront'),
  admin: buildDocument('admin'),
});
