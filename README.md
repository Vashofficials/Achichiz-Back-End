# Achichiz API

Express 5 · TypeScript · PostgreSQL (Drizzle) · Redis · OpenAPI 3.1 + Swagger UI

Serves two API surfaces from one process: the public **storefront** API and the staff **admin** API.

For the complete current request, commerce, payment, authentication, inventory, media, database, webhook, and operations diagrams, see [`docs/BACKEND-FLOW.md`](docs/BACKEND-FLOW.md). For the endpoint inventory and verification results, see [`docs/API-AUDIT-REPORT.md`](docs/API-AUDIT-REPORT.md).

---

## Quick start

```bash
cp .env.example .env          # then fill JWT_* secrets: openssl rand -base64 48
docker compose up -d          # postgres, redis, mailpit, minio
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

- Storefront docs → http://localhost:4000/docs/storefront
- Admin docs → http://localhost:4000/docs/admin (needs a staff token with `settings:view`)
- Liveness → http://localhost:4000/healthz · Readiness → http://localhost:4000/readyz

---

## The one rule

**Every endpoint is declared with `defineRoute()`.** It registers the Express handler *and* the
OpenAPI operation from a single object, so the docs cannot drift from the code — they are the same
declaration. A bare `router.post(...)` is an ESLint error and a failing test.

Three CI gates enforce it:

1. `openapi/*.json` is generated and committed — CI runs `npm run openapi:generate && git diff --exit-code`.
2. `tests/openapi-coverage.test.ts` diffs the live Express router stack against the registry, both directions.
3. `npm run openapi:lint` (spectral) requires `operationId`, `summary`, tags, a 4xx, and `security` on non-public ops.

---

## Adding a module

A module is a folder under `src/modules/<name>/` with up to five files. Copy
`src/modules/health/health.routes.ts` for the route shape.

```
src/modules/catalogue/
├─ catalogue.routes.ts       # defineRoute() calls only — no logic
├─ catalogue.controller.ts   # optional; fold into routes if thin
├─ catalogue.service.ts      # business rules, transactions. No req/res, no SQL.
├─ catalogue.repository.ts   # drizzle queries. No business rules, no req/res.
├─ catalogue.schemas.ts      # zod request/response schemas
└─ catalogue.test.ts
```

Then add one line to `src/routes.ts`.

### Boundaries (ESLint-enforced)

1. A route/controller imports its own **service** and **schemas**. Never a repository, never another module's internals.
2. A service imports its own **repository**, `lib/`, `integrations/`, and **another module's service** — never another module's repository. Cross-module calls go service→service so invariants stay in one place.
3. A repository imports `db/schema` and `config/db`. Nothing else. It returns rows, never HTTP concepts.

`modules/reports/` is the deliberate exception: it may issue raw `sql` against any table and connects
through a read-only role.

### A route declaration

```ts
defineRoute(router, {
  method: 'patch',
  path: '/v1/admin/orders/:orderId/status',   // FULL path, including /v1
  surface: 'admin',                            // 'storefront' | 'admin'
  operationId: 'updateOrderStatus',            // unique across BOTH surfaces
  summary: 'Update order status',
  description: 'Transitions an order. Illegal transitions are rejected with 422.',
  tags: ['Orders'],
  auth: 'staff',                               // 'public' | 'customer' | 'staff'
  permission: { module: 'orders', action: 'edit' },   // required on admin routes
  rateLimit: 'default',
  request: {
    params: z.object({ orderId: z.uuid() }),
    body: updateStatusBody,
  },
  responses: {
    200: { description: 'Updated order.', schema: orderResponse },
    404: { description: 'No such order.' },
  },
  handler: async ({ params, body, auth }) => ok(await orderService.updateStatus(params.orderId, body, auth.staffId)),
});
```

401/403/422/429/500 are added to the document automatically — do not declare them.

### Conventions

| Thing | Rule |
|---|---|
| **Money** | Integer **paise**, always. `BIGINT` in PG, `number` in TS, never float, never `NUMERIC` through JS. Use `lib/money.ts`. |
| Percentages | Integer **basis points** (250 = 2.5%). |
| Response | `{ data }` single · `{ data, meta }` collections · `204` deletes. Use `lib/http.ts` helpers. |
| Errors | Throw from `lib/errors.ts`. Only `error-handler.ts` knows HTTP. Emits RFC 9457 `problem+json`. |
| Async | Express 5 forwards rejections. **No** `asyncHandler`, no per-route try/catch. |
| Naming | Files `kebab-case.ts` · DB `snake_case` plural · JSON `camelCase` · URLs `kebab-case` plural. |
| IDs | `uuid` PKs. Human-facing numbers (`ACH-…`, invoices) come from the DB sequence/series — never `Math.random()`. |
| Validation | zod only, declared on the route. Handlers read `req.valid`, never `req.body`. |

### Writing schemas

`.describe()` on a zod field becomes the OpenAPI description — use it, it is what the frontend team reads.

```ts
export const productResponse = z.object({
  id: z.uuid(),
  handle: z.string().describe('URL slug, e.g. `bamboo-bottle`.'),
  pricePaise: z.number().int().describe('Integer paise. 149900 = ₹1,499.00.'),
});
```

---

## Layout

```
src/
├─ app.ts routes.ts server.ts worker.ts
├─ config/     env db redis logger
├─ db/         schema/ migrations/ seed/
├─ lib/        openapi/ errors money pagination http rbac-matrix
├─ middleware/ authenticate require-permission validate rate-limit audit idempotency error-handler
├─ modules/    <one folder per bounded context>
├─ integrations/ razorpay msg91 ses r2 courier
└─ jobs/       queues schedulers handlers
```

## Scripts

| | |
|---|---|
| `npm run dev` | API with watch |
| `npm run typecheck` / `lint` / `test` | the CI trio |
| `npm run db:generate` | Drizzle → migration SQL (**never** `push`) |
| `npm run db:migrate` / `db:seed` | apply / seed |
| `npm run openapi:generate` | regenerate committed specs |

## Security notes

- `.env` is gitignored on line 1. Never commit real secrets.
- Customer and staff tokens use **different secrets** and different `aud` claims.
- Admin routes without a `permission` throw at startup.
- Every non-GET admin route is audit-logged automatically.
- Order totals are **always** recomputed server-side. A client-supplied price is never trusted.
