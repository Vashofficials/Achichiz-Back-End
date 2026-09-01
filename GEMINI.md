# Achichiz Back-End Engineering Rules

Always follow the `achichiz-backend` skill guidelines and the following strict rules when designing, reading, writing, or refactoring code in this repository:

## 1. Route Definition & OpenAPI
- **Always** mount endpoints using `defineRoute(router, spec)` from `src/lib/openapi/define-route.js`.
- **Never** use bare Express verb methods (`router.get`, `router.post`, etc.).
- Every endpoint must have typed `operationId`, `summary`, `tags`, `auth`, `request` schemas (if any), and `responses` schemas.

## 2. Layered Architecture
- **Routes (`*.routes.ts`)**: HTTP surface only. Validates requests via `defineRoute`, calls service functions, returns standardized response helpers (`ok`, `created`, `noContent`, `paginated`).
- **Service (`*.service.ts`)**: Business logic, transactions, and event orchestration. Throws domain `AppError` subclasses from `src/lib/errors.js`. Never import Express or HTTP response formats.
- **Repository (`*.repository.ts`)**: Pure Drizzle ORM queries. Never import Express, middleware, or HTTP concerns.
- **Schemas (`*.schemas.ts`)**: Zod validation schemas for requests and responses.

## 3. Response Format
- **Single Resource**: `{ type: 'success', result: <data> }`
- **Paginated Collection**: `{ type: 'success', result: <items[]>, meta: { page, perPage, total, totalPages } }`
- **Delete / No Content**: Status `204` (no body, via `noContent()`).
- **Error**: `{ type: 'error', result: { title, status, code, detail, instance, requestId, errors? } }`
- **Rule**: NEVER use a `data` key. The payload key is ALWAYS `result`.

## 4. Money & Tax Invariants
- **All money is integer paise** (`Paise = number`, `149900 = ₹1,499.00`). Never use floats or `NUMERIC`.
- **Percentages are basis points** (`percent_bp: 1800 = 18%`).
- Use `allocate()` from `src/lib/money.js` for zero-loss discount/tax allocation across order lines.

## 5. Database Schema & Drizzle ORM
- Import schema objects **ONLY** from `src/db/schema/index.js`.
- **No `pgEnum`**: Use `text('status').$type<StatusType>()` with SQL `check()` constraint and exported `as const` array + union type.
- Soft delete (`deleted_at`) exists only on Tier 2 tables. Tier 1 accounting books are append-only.
- `CITEXT` columns (emails) are case-insensitive in DB. Do not wrap queries with `lower()`.

## 6. TypeScript & ESM
- `NodeNext` resolution: All relative imports **MUST** include `.js` extensions.
- Use `inline-type-imports` (`import type { ... }`).
- Never leave floating promises unhandled.
