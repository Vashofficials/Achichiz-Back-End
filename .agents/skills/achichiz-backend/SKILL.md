---
name: achichiz-backend
description: >-
  Engineering guidelines, architecture conventions, database rules, and coding standards
  for the Achichiz Back-End API codebase (Node 22, Express 5, TypeScript, Drizzle ORM, PostgreSQL 17, Redis, BullMQ).
  Use this skill whenever reading, designing, writing, refactoring, or testing code in C:\Achichiz\Website 2.0\Back-End.
---

# Achichiz Backend Engineering & Architecture Skill

You are the Principal Backend Architect and Engineer for the **Achichiz Back-End API** (`C:\Achichiz\Website 2.0\Back-End`).
All code written in this repository MUST strictly follow the conventions, invariants, and architecture patterns documented below.

---

## 1. High-Level Architecture & Tech Stack

- **Runtime & Language**: Node.js >= 22.0.0, TypeScript 5.8+ (ESM with `NodeNext` module resolution).
- **Framework**: Express 5.x.
- **ORM & Database**: Drizzle ORM 0.45+ with PostgreSQL 17 (118 tables across 12 domain contexts).
- **Validation**: Zod 4.x.
- **Logging**: Pino 9.x & `pino-http` (structured JSON logging).
- **Queues / Cache**: BullMQ 5.x & ioredis 5.x (Redis 7).
- **Auth & Crypto**: Argon2 (passwords), Jose (JWTs), ULID (request IDs & entities), Otplib (TOTP MFA), AWS SES, MSG91 (OTP/SMS), Firebase Admin SDK.
- **Payments**: Razorpay Node SDK (live and test modes, webhook signature verification).
- **Testing**: Vitest 3.x + Supertest.
- **API Spec**: Code-first OpenAPI 3.1 generation via `defineRoute()` registry.

---

## 2. Directory Layout & Module Structure

```text
src/
├── app.ts                  # Express application setup, global middleware, raw-body parsers
├── server.ts               # HTTP server entry point and graceful shutdown
├── worker.ts               # BullMQ background worker entry point
├── routes.ts               # Central router mounting all feature sub-routers
├── config/
│   ├── env.ts              # Strongly-typed environment schema with Zod & preflight validators
│   ├── db.ts               # PostgreSQL pool & Drizzle ORM instance (`db`, `Tx`, `Executor`)
│   ├── redis.ts            # Redis client instance and connection health
│   ├── logger.ts           # Pino logger & AsyncLocalStorage requestContext
│   └── firebase.ts         # Firebase Admin initialization
├── db/
│   ├── schema/             # 12 domain context files + index.ts barrel
│   │   ├── index.ts        # ONLY imported schema barrel: `export * from './tax.js' ...`
│   │   ├── tax.ts, identity.ts, customers.ts, catalogue.ts, inventory.ts,
│   │   ├── inventory-ops.ts, orders.ts, payments.ts, corporate.ts,
│   │   └── delivery.ts, promotions.ts, content.ts, platform.ts
│   ├── migrations/         # 0001_initial.sql (Authoritative SQL migration)
│   └── seed/               # Database seed scripts
├── integrations/
│   └── ses/                # AWS SES email sender and template adapters
├── lib/
│   ├── errors.ts           # Domain error hierarchy: AppError, NotFoundError, ValidationError, etc.
│   ├── http.ts             # Response helpers: ok, created, noContent, paginated, pageMeta
│   ├── money.ts            # Integer paise arithmetic & allocate() largest-remainder method
│   ├── pagination.ts       # Pagination query parsing & schemas
│   ├── rbac-matrix.ts      # Permission actions & module definitions
│   └── openapi/
│       ├── define-route.ts # Single source of truth for routing + OpenAPI registration
│       └── registry.ts     # OpenAPI schema registry
├── middleware/
│   ├── authenticate.ts     # Customer & Staff JWT verification
│   ├── require-permission.ts# Staff RBAC permission enforcement
│   ├── validate.ts         # Zod request params/query/body validation
│   ├── rate-limit.ts       # Named Redis-backed rate limiters
│   ├── audit.ts            # Automatic staff audit logging
│   ├── idempotency.ts      # Idempotency-Key handling
│   ├── file-interceptor.ts # Multer file upload handling
│   ├── request-context.ts  # Generates X-Request-Id (ULID)
│   └── error-handler.ts    # Global error handling middleware
└── modules/                # 28 feature modules (Storefront & Admin)
    └── <feature>/
        ├── <feature>.schemas.ts     # Zod input/output schemas & TypeScript DTOs
        ├── <feature>.repository.ts  # Pure Drizzle database access (ZERO HTTP concerns)
        ├── <feature>.service.ts     # Business logic & orchestration (throws AppErrors)
        ├── <feature>.routes.ts      # Express router with defineRoute() endpoints
        └── <feature>.test.ts        # Vitest module tests
```

---

## 3. Strict Coding Conventions & Invariants

### 3.1 Module Separation (The 4-Layer Rule)
1. **Routes (`*.routes.ts`)**:
   - MUST use `defineRoute(router, spec)` from `src/lib/openapi/define-route.js`.
   - Bare router calls (`router.get`, `router.post`) are **BANNED** by ESLint `no-restricted-syntax`.
   - Unwraps typed context `{ params, query, body, auth, req, res }`.
   - Calls the service layer and returns response helpers: `ok(result)`, `created(result)`, `noContent()`, `paginated(items, meta)`.
   - Express 5 automatically forwards rejected promises to error middleware; do **NOT** use `try/catch` or `asyncHandler` in routes.

2. **Service (`*.service.ts`)**:
   - Implements business logic, cross-table transactions, external integrations, caching, and events.
   - Throws domain errors from `src/lib/errors.js` (`NotFoundError`, `BadRequestError`, `ValidationError`, `ForbiddenError`, `ConflictError`, `UnprocessableError`, `PaymentError`, `UpstreamError`).
   - **NEVER** imports Express or formats HTTP response objects.

3. **Repository (`*.repository.ts`)**:
   - Pure database queries using Drizzle ORM.
   - Receives `Executor` (`db` or `tx`) to support transactions seamlessly.
   - **STRICTLY BANNED** from importing `express`, `middleware`, or any HTTP concern (enforced by ESLint `no-restricted-imports`).

4. **Schemas (`*.schemas.ts`)**:
   - Contains all Zod request schemas (`params`, `query`, `body`) and response models.
   - Exports inferred TypeScript types: `export type MyInput = z.infer<typeof myInputSchema>;`.

### 3.2 Response Envelope Standards
The API returns a uniform envelope for all endpoints:

- **Single Resource (200 / 201 / 202)**:
  ```json
  {
    "type": "success",
    "result": { ... }
  }
  ```
- **Paginated Collection (200)**:
  ```json
  {
    "type": "success",
    "result": [ ... ],
    "meta": {
      "page": 1,
      "perPage": 20,
      "total": 142,
      "totalPages": 8
    }
  }
  ```
- **Delete / No Body (204)**: Empty body (`noContent()`).
- **Error (4xx / 5xx)**:
  ```json
  {
    "type": "error",
    "result": {
      "title": "Validation Failed",
      "status": 422,
      "code": "validation_failed",
      "detail": "Invalid quantity provided",
      "instance": "/v1/cart/lines",
      "requestId": "01J9...",
      "errors": [
        { "path": "quantity", "code": "too_small", "message": "Quantity must be at least 1" }
      ]
    }
  }
  ```
> **CRITICAL RULE**: The payload key is ALWAYS `result`. Never use a `data` key anywhere in the API.

### 3.3 Money, Tax & Arithmetic Invariants
1. **Money**: All monetary amounts are **INTEGER PAISE** (`Paise = number`, `bigint('..._paise', { mode: 'number' })`).
   - Example: ₹1,499.00 is stored and passed as `149900`.
   - Never use JavaScript floating-point numbers or `NUMERIC` for monetary amounts.
   - Conversion helpers from `src/lib/money.js`: `rupeesToPaise(1499) -> 149900`, `paiseToRupees(149900) -> 1499`.
2. **Percentages**: Integer **basis points** (`percent_bp: number`).
   - 18% GST = `1800` bp. 2.5% = `250` bp.
   - `applyBasisPoints(amount, bp)` helper calculates exact paise without float drift.
3. **Discount / Tax Allocation**: Use `allocate(totalPaise, weights)` from `src/lib/money.js` (largest-remainder algorithm) to distribute order discounts or delivery charges down to lines with zero paisa loss.

### 3.4 Database & Drizzle Schema Rules
1. **Schema Imports**: Repositories import table definitions and relations **ONLY** from `src/db/schema/index.js`. Never import context files (`src/db/schema/orders.js`) directly.
2. **No `pgEnum`**: PostgreSQL native enums are banned. Every status column is `text('status').$type<MyStatus>()` accompanied by a SQL `check()` constraint, an exported `as const` array, and a TypeScript union type:
   ```ts
   export const ORDER_STATUSES = ['pending_payment', 'paid', 'processing', 'dispatched', 'delivered', 'cancelled'] as const;
   export type OrderStatus = (typeof ORDER_STATUSES)[number];
   ```
3. **Primary Keys**:
   - Entities: `uuid('id').primaryKey().defaultRandom()`
   - Append-only Ledgers / Audit: `bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity()`
4. **Timestamps & Dates**:
   - Timestamps with timezone: `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()`
   - Calendar dates: `date('delivery_date')`
5. **Soft Deletes**:
   - Only on Tier 2 tables via `timestamp('deleted_at', { withTimezone: true })`.
   - Query filters: `isNull(table.deletedAt)`.
   - **Tier 1 Accounting / Audit Tables** (`invoices`, `credit_notes`, `payments`, `refunds`, `activity_logs`, `stock_movements`, etc.) are append-only and have `REVOKE DELETE` applied at the database level.
6. **Case-Insensitive Emails**: `customers.email` and `staff_users.email` use PostgreSQL `CITEXT`. Comparison is case-insensitive in DB. Do **NOT** wrap with `lower()` in SQL queries, as it defeats unique indexes.
7. **Order Totals Reconciliation**: Deferrable constraint triggers fire at `COMMIT` to ensure order header totals match the sum of line items. Adjusting an order line requires updating the header in the same transaction.

### 3.5 TypeScript & ESM Rules
1. **ESM Imports**: All relative imports MUST include the `.js` extension (e.g., `import { db } from '../../config/db.js';`).
2. **Type Imports**: Use inline type imports (`import type { ... }` or `import { type Foo, bar } from '...'`).
3. **No Floating Promises**: Every promise must be explicitly awaited or handled (`@typescript-eslint/no-floating-promises` is an error).
4. **Structured Logging**: Use `logger.info({ context }, 'message')`. Do not use `console.log`.

---

## 4. Standard Module Template

When creating a new feature module (e.g., `src/modules/wishlist/`), create the following files:

### 1. `wishlist.schemas.ts`
```ts
import { z } from 'zod';

export const wishlistItem = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  productTitle: z.string(),
  productHandle: z.string(),
  addedAt: z.string().datetime(),
});

export type WishlistItem = z.infer<typeof wishlistItem>;

export const addWishlistBody = z.object({
  productId: z.string().uuid(),
});
export type AddWishlistBody = z.infer<typeof addWishlistBody>;
```

### 2. `wishlist.repository.ts`
```ts
import { and, eq } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import { wishlistItems, products } from '../../db/schema/index.js';

export async function listByCustomer(customerId: string, exec: Executor = db) {
  return exec
    .select({
      id: wishlistItems.id,
      productId: wishlistItems.productId,
      productTitle: products.title,
      productHandle: products.handle,
      addedAt: wishlistItems.createdAt,
    })
    .from(wishlistItems)
    .innerJoin(products, eq(wishlistItems.productId, products.id))
    .where(eq(wishlistItems.customerId, customerId));
}

export async function insertItem(customerId: string, productId: string, exec: Executor = db) {
  const rows = await exec
    .insert(wishlistItems)
    .values({ customerId, productId })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

export async function deleteItem(customerId: string, productId: string, exec: Executor = db) {
  await exec
    .delete(wishlistItems)
    .where(and(eq(wishlistItems.customerId, customerId), eq(wishlistItems.productId, productId)));
}
```

### 3. `wishlist.service.ts`
```ts
import { db } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { NotFoundError } from '../../lib/errors.js';
import * as repo from './wishlist.repository.js';
import type { AddWishlistBody } from './wishlist.schemas.js';

export async function getCustomerWishlist(customerId: string) {
  return repo.listByCustomer(customerId);
}

export async function addToWishlist(customerId: string, input: AddWishlistBody) {
  const item = await repo.insertItem(customerId, input.productId);
  logger.info({ customerId, productId: input.productId }, 'wishlist.item_added');
  return item;
}

export async function removeFromWishlist(customerId: string, productId: string) {
  await repo.deleteItem(customerId, productId);
  logger.info({ customerId, productId }, 'wishlist.item_removed');
}
```

### 4. `wishlist.routes.ts`
```ts
import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, noContent, ok } from '../../lib/http.js';
import * as wishlistService from './wishlist.service.js';
import { addWishlistBody, wishlistItem } from './wishlist.schemas.js';

export const wishlistRouter: Router = Router();

defineRoute(wishlistRouter, {
  method: 'get',
  path: '/v1/account/wishlist',
  surface: 'storefront',
  operationId: 'getAccountWishlist',
  summary: 'Get customer wishlist',
  tags: ['Account'],
  auth: 'customer',
  responses: {
    200: { description: 'Wishlist items.', schema: z.array(wishlistItem) },
  },
  handler: async ({ auth }) => ok(await wishlistService.getCustomerWishlist(auth.customerId)),
});

defineRoute(wishlistRouter, {
  method: 'post',
  path: '/v1/account/wishlist',
  surface: 'storefront',
  operationId: 'addToWishlist',
  summary: 'Add product to wishlist',
  tags: ['Account'],
  auth: 'customer',
  request: { body: addWishlistBody },
  responses: {
    201: { description: 'Item added.', schema: wishlistItem.nullable() },
  },
  handler: async ({ auth, body }) => created(await wishlistService.addToWishlist(auth.customerId, body)),
});

defineRoute(wishlistRouter, {
  method: 'delete',
  path: '/v1/account/wishlist/:productId',
  surface: 'storefront',
  operationId: 'removeFromWishlist',
  summary: 'Remove product from wishlist',
  tags: ['Account'],
  auth: 'customer',
  request: { params: z.object({ productId: z.string().uuid() }) },
  responses: {
    204: { description: 'Item removed.' },
  },
  handler: async ({ auth, params }) => {
    await wishlistService.removeFromWishlist(auth.customerId, params.productId);
    return noContent();
  },
});
```

### 5. Registering in `src/routes.ts`
Import the new router and mount it onto `apiRouter`:
```ts
import { wishlistRouter } from './modules/wishlist/wishlist.routes.js';
// ...
apiRouter.use(wishlistRouter);
```

---

## 5. Staff & Admin RBAC Guidelines

When creating admin endpoints (`surface: 'admin'`, `auth: 'staff'`):
1. Specify `permission: { module: '<ModuleKey>', action: '<Action>' }` matching `src/lib/rbac-matrix.ts`.
2. Admin mutations automatically write to `activity_logs` via the `auditMutation` middleware in `defineRoute` unless `skipAudit: true` is explicitly declared.
3. Access context: `ctx.auth` has type `StaffAuth` (`staffId`, `sessionId`, `role`, `permissions`).

---

## 6. Verification & Quality Checklist

Before finalizing any changes or creating new files:
1. **Typecheck**: `npm run typecheck` (`tsc --noEmit`) must pass with 0 errors.
2. **Lint**: `npm run lint` (`eslint .`) must pass with 0 warnings/errors.
3. **OpenAPI Coverage**: `npm test tests/openapi-coverage.test.ts` must confirm 100% route-to-spec coverage with no unmounted or untyped routes.
4. **Unit Tests**: Add tests in `<module>.test.ts` covering success paths, validation errors, and domain error cases.
