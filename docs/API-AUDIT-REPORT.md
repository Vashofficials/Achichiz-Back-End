# Achichiz Admin and Storefront API verification audit

> Audit date: 2026-08-29 (Asia/Calcutta). This report records the actual route registry, generated OpenAPI documents, static implementation review, safe local runtime probes, and the limits imposed by unavailable integration dependencies.

## Executive result

- **Registered operations:** 282 total — **212 Admin** and **70 Storefront**.
- **OpenAPI documents:** 159 Admin paths / 212 operations and 62 Storefront paths / 70 operations.
- **Safe runtime boundary:** the application booted with localhost-only test connection strings. PostgreSQL and Redis were not running; Docker is not installed (`docker: command not found`).
- **Business endpoint outcome:** no database-backed demo record was created and no valid business flow was marked PASS. The full endpoint run is **BLOCKED** pending an isolated non-production PostgreSQL and Redis environment.
- **No production-like RDS connection was attempted.** The supplied RDS connection details were deliberately not used because the target is not an isolated test environment and the credentials were exposed in the request. Rotate those credentials before any future use.
- **No new API was created.** The only implementation changes are fixes to existing configuration, middleware behavior, Swagger exposure, and existing media-upload routes.

## Safety and test boundary

- Only localhost connection strings and fake test JWT secrets were used for process boot. No real customer, staff, order, product, payment, configuration, or inventory data was touched.
- No real payment, email, SMS, Firebase, S3, courier, or other external integration was called.
- No schema migration was applied. No database record was inserted, updated, deleted, or verified against a live database.
- The repository compose stack specifies PostgreSQL, Redis, Mailpit, and MinIO, but the Docker executable is unavailable in this workspace.
- `GET /readyz` correctly reported the environment as not ready: HTTP 503 with `postgres: false` and `redis: false`.

## Classification summary

| Surface | Registered operations | Auth classification | HTTP methods |
|---|---:|---|---|
| Admin | 212 | 8 public authentication operations; 204 staff-protected operations | GET 96, POST 84, PATCH 19, DELETE 13 |
| Storefront | 70 | 49 public operations; 21 customer-protected operations | GET 38, POST 24, PATCH 3, DELETE 5 |

### Admin module counts

| Module prefix | Operations | Module prefix | Operations |
|---|---:|---|---:|
| `auth` | 10 | `banners` | 7 |
| `barcodes` | 4 | `boms` | 6 |
| `bulk-orders` | 9 | `bundles` | 6 |
| `collections` | 7 | `coupons` | 7 |
| `customers` | 7 | `designers` | 7 |
| `faqs` | 7 | `gift-cards` | 7 |
| `inventory` | 18 | `me` | 1 |
| `media` | 1 | `orders` | 10 |
| `permissions` | 2 | `product-variants` | 7 |
| `production` | 6 | `products` | 7 |
| `purchasing` | 15 | `qr` | 1 |
| `reports` | 10 | `resources` | 1 |
| `roles` | 3 | `sessions` | 2 |
| `stock-counts` | 7 | `suppliers` | 10 |
| `testimonials` | 7 | `transfers` | 7 |
| `warehouses` | 13 | — | — |

### Storefront module counts

| Module prefix | Operations |
|---|---:|
| `account` | 14 |
| `add-ons` | 1 |
| `auth` | 9 |
| `banners` | 1 |
| `blog` | 2 |
| `cart` | 8 |
| `checkout` | 1 |
| `cms` | 1 |
| `collections` | 3 |
| `designers` | 2 |
| `faqs` | 1 |
| `hamper-builder` | 2 |
| `leads` | 2 |
| `menus` | 1 |
| `newsletter` | 1 |
| `orders` | 2 |
| `pages` | 2 |
| `payments` | 2 |
| `personalisation-templates` | 1 |
| `policies` | 1 |
| `products` | 3 |
| `search` | 3 |
| `seo` | 1 |
| `serviceability` | 1 |
| `store` | 1 |
| `testimonials` | 1 |
| `webhooks` | 1 |

## Runtime and contract probes

| Request | Result | Evidence |
|---|---|---|
| `GET /healthz` | **PASS** | HTTP 200 success envelope. |
| `GET /readyz` | **PASS — expected degraded result** | HTTP 503; readiness correctly identified `postgres: false` and `redis: false`. |
| `GET /openapi/storefront.json` | **PASS** | HTTP 200; document contains 62 paths / 70 operations. |
| `GET /openapi/admin.json` without staff token | **PASS — protected** | HTTP 401 after the Swagger security fix. |
| `GET /docs` | **PASS — existing redirect** | HTTP 301; `/docs/` returns the public Storefront Swagger UI with HTTP 200. |
| `GET /docs/storefront/` | **PASS — documented alias** | HTTP 200; public Storefront Swagger UI. |
| `GET /docs/admin/` without staff token | **PASS — protected** | HTTP 401; admin document is not embedded for unauthenticated users. |
| `GET /v1/admin/me` without Authorization | **PASS — negative auth** | HTTP 401, stable `unauthenticated` error envelope. |
| `POST /v1/admin/auth/login` with `{}` | **PASS — negative validation** | HTTP 422, two field issues for `email` and `password`. |
| `GET /v1/not-an-endpoint` | **PASS — negative routing** | HTTP 404, stable `route_not_found` error envelope. |
| CORS preflight with `X-Cart-Token` | **PASS** | HTTP 204; allow and expose headers include `X-Cart-Token`. |

The probes above are contract/security checks only. They are not a substitute for a valid staff/customer token, database fixtures, Redis, or external sandbox credentials.

## Complete endpoint test matrix

The following matrix contains every operation from the actual `defineRoute()` registry. `BLOCKED` means the route was not executed through a valid business path because the required integration environment was unavailable; it does not mean the implementation returned a failure. A selected negative request may be recorded as PASS in the evidence column while the full endpoint remains BLOCKED.

| # | Surface | Method | Route | Auth / grant | Input declarations | Full-run status | Evidence |
|---:|---|---|---|---|---|---|---|
| 1 | storefront | GET | `/healthz` | `public` | — | **PASS** | HTTP 200 probe |
| 2 | storefront | GET | `/readyz` | `public` | — | **PASS*** | HTTP 503 expected while PG/Redis unavailable |
| 3 | storefront | GET | `/v1/products` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 4 | storefront | GET | `/v1/products/:handle` | `public` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 5 | storefront | GET | `/v1/products/:handle/variants` | `public` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 6 | storefront | GET | `/v1/collections` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 7 | storefront | GET | `/v1/collections/:handle` | `public` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 8 | storefront | GET | `/v1/collections/:handle/products` | `public` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 9 | storefront | GET | `/v1/designers` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 10 | storefront | GET | `/v1/designers/:handle` | `public` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 11 | storefront | GET | `/v1/add-ons` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 12 | storefront | GET | `/v1/personalisation-templates` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 13 | storefront | GET | `/v1/hamper-builder/templates` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 14 | storefront | GET | `/v1/hamper-builder/templates/:handle` | `public` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 15 | storefront | GET | `/v1/serviceability` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 16 | storefront | GET | `/v1/search` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 17 | storefront | GET | `/v1/search/suggest` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 18 | storefront | GET | `/v1/search/suggestions` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 19 | storefront | GET | `/v1/blog/posts` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 20 | storefront | GET | `/v1/blog/posts/:slug` | `public` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 21 | storefront | GET | `/v1/pages` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 22 | storefront | GET | `/v1/pages/:slug` | `public` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 23 | storefront | GET | `/v1/policies/:slug` | `public` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 24 | storefront | GET | `/v1/faqs` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 25 | storefront | GET | `/v1/testimonials` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 26 | storefront | GET | `/v1/cms/sections` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 27 | storefront | GET | `/v1/banners` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 28 | storefront | GET | `/v1/seo` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 29 | storefront | GET | `/v1/menus/:key` | `public` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 30 | storefront | GET | `/v1/cart` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 31 | storefront | POST | `/v1/cart/lines` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 32 | storefront | PATCH | `/v1/cart/lines/:lineId` | `public` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 33 | storefront | DELETE | `/v1/cart/lines/:lineId` | `public` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 34 | storefront | DELETE | `/v1/cart` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 35 | storefront | POST | `/v1/cart/coupon` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 36 | storefront | DELETE | `/v1/cart/coupon` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 37 | storefront | POST | `/v1/cart/merge` | `customer` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 38 | storefront | POST | `/v1/checkout/quote` | `customer` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 39 | storefront | POST | `/v1/orders` | `customer` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 40 | storefront | GET | `/v1/account/orders` | `customer` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 41 | storefront | GET | `/v1/account/orders/:orderId` | `customer` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 42 | storefront | POST | `/v1/account/orders/:orderId/cancel` | `customer` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 43 | storefront | GET | `/v1/orders/track` | `public` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 44 | storefront | POST | `/v1/payments/razorpay/order` | `customer` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 45 | storefront | POST | `/v1/payments/razorpay/verify` | `customer` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 46 | storefront | POST | `/v1/webhooks/razorpay` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 47 | storefront | POST | `/v1/auth/signup` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 48 | storefront | POST | `/v1/auth/login` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 49 | storefront | POST | `/v1/auth/firebase` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 50 | storefront | POST | `/v1/auth/refresh` | `public` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 51 | storefront | POST | `/v1/auth/logout` | `public` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 52 | storefront | POST | `/v1/auth/logout-all` | `public` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 53 | storefront | POST | `/v1/auth/forgot-password` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 54 | storefront | POST | `/v1/auth/reset-password` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 55 | storefront | GET | `/v1/auth/me` | `customer` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 56 | storefront | GET | `/v1/account/profile` | `customer` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 57 | storefront | PATCH | `/v1/account/profile` | `customer` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 58 | storefront | GET | `/v1/account/wishlist` | `customer` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 59 | storefront | POST | `/v1/account/wishlist` | `customer` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 60 | storefront | DELETE | `/v1/account/wishlist/:productId` | `customer` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 61 | storefront | GET | `/v1/account/addresses` | `customer` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 62 | storefront | GET | `/v1/account/addresses/:addressId` | `customer` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 63 | storefront | POST | `/v1/account/addresses` | `customer` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 64 | storefront | PATCH | `/v1/account/addresses/:addressId` | `customer` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 65 | storefront | POST | `/v1/account/addresses/:addressId/default` | `customer` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 66 | storefront | DELETE | `/v1/account/addresses/:addressId` | `customer` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 67 | storefront | POST | `/v1/leads/contact` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 68 | storefront | POST | `/v1/leads/corporate-gifting` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 69 | storefront | POST | `/v1/newsletter/subscribe` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 70 | admin | POST | `/v1/admin/auth/login` | `public` | body | **BLOCKED** | Empty-body validation check PASS: HTTP 422 |
| 71 | admin | POST | `/v1/admin/auth/2fa/setup` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 72 | admin | POST | `/v1/admin/auth/2fa/enable` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 73 | admin | POST | `/v1/admin/auth/2fa/verify` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 74 | admin | POST | `/v1/admin/auth/refresh` | `public` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 75 | admin | POST | `/v1/admin/auth/logout` | `public` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 76 | admin | POST | `/v1/admin/auth/password/forgot` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 77 | admin | POST | `/v1/admin/auth/password/reset` | `public` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 78 | admin | POST | `/v1/admin/auth/step-up` | `staff` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 79 | admin | POST | `/v1/admin/auth/2fa/recovery-codes` | `staff` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 80 | admin | GET | `/v1/admin/me` | `staff / dashboard:view` | — | **BLOCKED** | No-auth negative check PASS: HTTP 401 |
| 81 | admin | GET | `/v1/admin/sessions` | `staff / dashboard:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 82 | admin | DELETE | `/v1/admin/sessions/:sessionId` | `staff / dashboard:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 83 | admin | GET | `/v1/admin/roles` | `staff / settings:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 84 | admin | GET | `/v1/admin/roles/:roleId` | `staff / settings:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 85 | admin | GET | `/v1/admin/permissions` | `staff / settings:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 86 | admin | GET | `/v1/admin/permissions/matrix` | `staff / settings:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 87 | admin | POST | `/v1/admin/roles/sync` | `staff / settings:manage-settings` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 88 | admin | GET | `/v1/admin/resources` | `staff / dashboard:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 89 | admin | GET | `/v1/admin/products` | `staff / catalogue:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 90 | admin | GET | `/v1/admin/products/schema` | `staff / catalogue:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 91 | admin | POST | `/v1/admin/products/bulk` | `staff / catalogue:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 92 | admin | POST | `/v1/admin/products` | `staff / catalogue:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 93 | admin | GET | `/v1/admin/products/:id` | `staff / catalogue:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 94 | admin | PATCH | `/v1/admin/products/:id` | `staff / catalogue:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 95 | admin | DELETE | `/v1/admin/products/:id` | `staff / catalogue:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 96 | admin | GET | `/v1/admin/product-variants` | `staff / catalogue:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 97 | admin | GET | `/v1/admin/product-variants/schema` | `staff / catalogue:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 98 | admin | POST | `/v1/admin/product-variants/bulk` | `staff / catalogue:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 99 | admin | POST | `/v1/admin/product-variants` | `staff / catalogue:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 100 | admin | GET | `/v1/admin/product-variants/:id` | `staff / catalogue:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 101 | admin | PATCH | `/v1/admin/product-variants/:id` | `staff / catalogue:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 102 | admin | DELETE | `/v1/admin/product-variants/:id` | `staff / catalogue:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 103 | admin | GET | `/v1/admin/collections` | `staff / catalogue:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 104 | admin | GET | `/v1/admin/collections/schema` | `staff / catalogue:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 105 | admin | POST | `/v1/admin/collections/bulk` | `staff / catalogue:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 106 | admin | POST | `/v1/admin/collections` | `staff / catalogue:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 107 | admin | GET | `/v1/admin/collections/:id` | `staff / catalogue:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 108 | admin | PATCH | `/v1/admin/collections/:id` | `staff / catalogue:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 109 | admin | DELETE | `/v1/admin/collections/:id` | `staff / catalogue:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 110 | admin | GET | `/v1/admin/designers` | `staff / catalogue:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 111 | admin | GET | `/v1/admin/designers/schema` | `staff / catalogue:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 112 | admin | POST | `/v1/admin/designers/bulk` | `staff / catalogue:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 113 | admin | POST | `/v1/admin/designers` | `staff / catalogue:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 114 | admin | GET | `/v1/admin/designers/:id` | `staff / catalogue:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 115 | admin | PATCH | `/v1/admin/designers/:id` | `staff / catalogue:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 116 | admin | DELETE | `/v1/admin/designers/:id` | `staff / catalogue:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 117 | admin | GET | `/v1/admin/customers` | `staff / customers:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 118 | admin | GET | `/v1/admin/customers/schema` | `staff / customers:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 119 | admin | POST | `/v1/admin/customers/bulk` | `staff / customers:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 120 | admin | POST | `/v1/admin/customers` | `staff / customers:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 121 | admin | GET | `/v1/admin/customers/:id` | `staff / customers:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 122 | admin | PATCH | `/v1/admin/customers/:id` | `staff / customers:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 123 | admin | DELETE | `/v1/admin/customers/:id` | `staff / customers:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 124 | admin | GET | `/v1/admin/coupons` | `staff / promotions:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 125 | admin | GET | `/v1/admin/coupons/schema` | `staff / promotions:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 126 | admin | POST | `/v1/admin/coupons/bulk` | `staff / promotions:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 127 | admin | POST | `/v1/admin/coupons` | `staff / promotions:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 128 | admin | GET | `/v1/admin/coupons/:id` | `staff / promotions:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 129 | admin | PATCH | `/v1/admin/coupons/:id` | `staff / promotions:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 130 | admin | DELETE | `/v1/admin/coupons/:id` | `staff / promotions:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 131 | admin | GET | `/v1/admin/gift-cards` | `staff / promotions:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 132 | admin | GET | `/v1/admin/gift-cards/schema` | `staff / promotions:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 133 | admin | POST | `/v1/admin/gift-cards/bulk` | `staff / promotions:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 134 | admin | POST | `/v1/admin/gift-cards` | `staff / promotions:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 135 | admin | GET | `/v1/admin/gift-cards/:id` | `staff / promotions:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 136 | admin | PATCH | `/v1/admin/gift-cards/:id` | `staff / promotions:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 137 | admin | DELETE | `/v1/admin/gift-cards/:id` | `staff / promotions:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 138 | admin | GET | `/v1/admin/banners` | `staff / content:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 139 | admin | GET | `/v1/admin/banners/schema` | `staff / content:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 140 | admin | POST | `/v1/admin/banners/bulk` | `staff / content:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 141 | admin | POST | `/v1/admin/banners` | `staff / content:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 142 | admin | GET | `/v1/admin/banners/:id` | `staff / content:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 143 | admin | PATCH | `/v1/admin/banners/:id` | `staff / content:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 144 | admin | DELETE | `/v1/admin/banners/:id` | `staff / content:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 145 | admin | GET | `/v1/admin/faqs` | `staff / content:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 146 | admin | GET | `/v1/admin/faqs/schema` | `staff / content:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 147 | admin | POST | `/v1/admin/faqs/bulk` | `staff / content:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 148 | admin | POST | `/v1/admin/faqs` | `staff / content:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 149 | admin | GET | `/v1/admin/faqs/:id` | `staff / content:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 150 | admin | PATCH | `/v1/admin/faqs/:id` | `staff / content:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 151 | admin | DELETE | `/v1/admin/faqs/:id` | `staff / content:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 152 | admin | GET | `/v1/admin/testimonials` | `staff / content:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 153 | admin | GET | `/v1/admin/testimonials/schema` | `staff / content:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 154 | admin | POST | `/v1/admin/testimonials/bulk` | `staff / content:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 155 | admin | POST | `/v1/admin/testimonials` | `staff / content:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 156 | admin | GET | `/v1/admin/testimonials/:id` | `staff / content:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 157 | admin | PATCH | `/v1/admin/testimonials/:id` | `staff / content:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 158 | admin | DELETE | `/v1/admin/testimonials/:id` | `staff / content:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 159 | admin | GET | `/v1/admin/suppliers` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 160 | admin | GET | `/v1/admin/suppliers/schema` | `staff / inventory:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 161 | admin | POST | `/v1/admin/suppliers/bulk` | `staff / inventory:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 162 | admin | POST | `/v1/admin/suppliers` | `staff / inventory:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 163 | admin | GET | `/v1/admin/suppliers/:id` | `staff / inventory:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 164 | admin | PATCH | `/v1/admin/suppliers/:id` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 165 | admin | DELETE | `/v1/admin/suppliers/:id` | `staff / inventory:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 166 | admin | GET | `/v1/admin/warehouses` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 167 | admin | GET | `/v1/admin/warehouses/schema` | `staff / inventory:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 168 | admin | POST | `/v1/admin/warehouses/bulk` | `staff / inventory:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 169 | admin | POST | `/v1/admin/warehouses` | `staff / inventory:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 170 | admin | GET | `/v1/admin/warehouses/:id` | `staff / inventory:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 171 | admin | PATCH | `/v1/admin/warehouses/:id` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 172 | admin | DELETE | `/v1/admin/warehouses/:id` | `staff / inventory:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 173 | admin | GET | `/v1/admin/inventory/dashboard` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 174 | admin | GET | `/v1/admin/inventory` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 175 | admin | GET | `/v1/admin/inventory/movements` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 176 | admin | GET | `/v1/admin/inventory/movements/:movementId` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 177 | admin | POST | `/v1/admin/inventory/adjustments` | `staff / inventory:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 178 | admin | POST | `/v1/admin/inventory/bulk-adjust` | `staff / inventory:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 179 | admin | GET | `/v1/admin/inventory/alerts/low-stock` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 180 | admin | GET | `/v1/admin/inventory/alerts/out-of-stock` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 181 | admin | GET | `/v1/admin/inventory/reorder` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 182 | admin | POST | `/v1/admin/inventory/reorder/purchase-draft` | `staff / inventory:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 183 | admin | GET | `/v1/admin/inventory/reservations` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 184 | admin | POST | `/v1/admin/inventory/reservations` | `staff / inventory:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 185 | admin | POST | `/v1/admin/inventory/reservations/:id/release` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 186 | admin | GET | `/v1/admin/inventory/audit` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 187 | admin | GET | `/v1/admin/inventory/notifications` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 188 | admin | GET | `/v1/admin/inventory/export` | `staff / inventory:export` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 189 | admin | GET | `/v1/admin/inventory/:sku/availability` | `staff / inventory:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 190 | admin | GET | `/v1/admin/inventory/:sku` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 191 | admin | GET | `/v1/admin/warehouses/:warehouseId/locations` | `staff / inventory:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 192 | admin | POST | `/v1/admin/warehouses/:warehouseId/locations` | `staff / inventory:create` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 193 | admin | GET | `/v1/admin/warehouses/:warehouseId/locations/:locationId` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 194 | admin | PATCH | `/v1/admin/warehouses/:warehouseId/locations/:locationId` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 195 | admin | POST | `/v1/admin/warehouses/:warehouseId/locations/:locationId/archive` | `staff / inventory:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 196 | admin | GET | `/v1/admin/warehouses/:warehouseId/inventory` | `staff / inventory:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 197 | admin | GET | `/v1/admin/transfers` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 198 | admin | POST | `/v1/admin/transfers` | `staff / inventory:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 199 | admin | GET | `/v1/admin/transfers/:transferId` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 200 | admin | POST | `/v1/admin/transfers/:transferId/approve` | `staff / inventory:approve` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 201 | admin | POST | `/v1/admin/transfers/:transferId/dispatch` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 202 | admin | POST | `/v1/admin/transfers/:transferId/receive` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 203 | admin | POST | `/v1/admin/transfers/:transferId/cancel` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 204 | admin | GET | `/v1/admin/suppliers/:supplierId/products` | `staff / inventory:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 205 | admin | POST | `/v1/admin/suppliers/:supplierId/products` | `staff / inventory:create` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 206 | admin | PATCH | `/v1/admin/suppliers/:supplierId/products/:supplierProductId` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 207 | admin | GET | `/v1/admin/purchasing/purchase-orders` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 208 | admin | POST | `/v1/admin/purchasing/purchase-orders` | `staff / inventory:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 209 | admin | GET | `/v1/admin/purchasing/purchase-orders/:poId` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 210 | admin | PATCH | `/v1/admin/purchasing/purchase-orders/:poId` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 211 | admin | POST | `/v1/admin/purchasing/purchase-orders/:poId/approve` | `staff / inventory:approve` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 212 | admin | POST | `/v1/admin/purchasing/purchase-orders/:poId/send` | `staff / inventory:edit` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 213 | admin | POST | `/v1/admin/purchasing/purchase-orders/:poId/cancel` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 214 | admin | GET | `/v1/admin/purchasing/goods-receipts` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 215 | admin | POST | `/v1/admin/purchasing/goods-receipts` | `staff / inventory:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 216 | admin | GET | `/v1/admin/purchasing/goods-receipts/:grnId` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 217 | admin | GET | `/v1/admin/purchasing/purchase-returns` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 218 | admin | POST | `/v1/admin/purchasing/purchase-returns` | `staff / inventory:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 219 | admin | GET | `/v1/admin/purchasing/purchase-returns/:returnId` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 220 | admin | POST | `/v1/admin/purchasing/purchase-returns/:returnId/approve` | `staff / inventory:approve` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 221 | admin | POST | `/v1/admin/purchasing/purchase-returns/:returnId/dispatch` | `staff / inventory:edit` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 222 | admin | GET | `/v1/admin/bundles` | `staff / promotions:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 223 | admin | POST | `/v1/admin/bundles` | `staff / promotions:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 224 | admin | GET | `/v1/admin/bundles/:bundleId/availability` | `staff / inventory:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 225 | admin | POST | `/v1/admin/bundles/:bundleId/archive` | `staff / promotions:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 226 | admin | GET | `/v1/admin/bundles/:bundleId` | `staff / promotions:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 227 | admin | PATCH | `/v1/admin/bundles/:bundleId` | `staff / promotions:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 228 | admin | GET | `/v1/admin/boms` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 229 | admin | POST | `/v1/admin/boms` | `staff / inventory:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 230 | admin | GET | `/v1/admin/boms/:bomId/explosion` | `staff / inventory:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 231 | admin | GET | `/v1/admin/boms/:bomId` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 232 | admin | PATCH | `/v1/admin/boms/:bomId` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 233 | admin | POST | `/v1/admin/boms/:bomId/archive` | `staff / inventory:delete` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 234 | admin | GET | `/v1/admin/production/orders` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 235 | admin | POST | `/v1/admin/production/orders` | `staff / inventory:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 236 | admin | GET | `/v1/admin/production/orders/:productionId` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 237 | admin | POST | `/v1/admin/production/orders/:productionId/start` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 238 | admin | POST | `/v1/admin/production/orders/:productionId/complete` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 239 | admin | POST | `/v1/admin/production/orders/:productionId/cancel` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 240 | admin | GET | `/v1/admin/stock-counts` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 241 | admin | POST | `/v1/admin/stock-counts` | `staff / inventory:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 242 | admin | GET | `/v1/admin/stock-counts/:countId` | `staff / inventory:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 243 | admin | POST | `/v1/admin/stock-counts/:countId/start` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 244 | admin | POST | `/v1/admin/stock-counts/:countId/items` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 245 | admin | POST | `/v1/admin/stock-counts/:countId/complete` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 246 | admin | POST | `/v1/admin/stock-counts/:countId/approve` | `staff / inventory:approve` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 247 | admin | GET | `/v1/admin/barcodes/:sku` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 248 | admin | POST | `/v1/admin/barcodes/generate` | `staff / inventory:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 249 | admin | POST | `/v1/admin/barcodes/bulk-generate` | `staff / inventory:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 250 | admin | POST | `/v1/admin/barcodes/scan` | `staff / inventory:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 251 | admin | GET | `/v1/admin/qr/:sku` | `staff / inventory:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 252 | admin | GET | `/v1/admin/bulk-orders` | `staff / corporate:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 253 | admin | POST | `/v1/admin/bulk-orders` | `staff / corporate:create` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 254 | admin | GET | `/v1/admin/bulk-orders/:bulkOrderId` | `staff / corporate:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 255 | admin | PATCH | `/v1/admin/bulk-orders/:bulkOrderId` | `staff / corporate:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 256 | admin | POST | `/v1/admin/bulk-orders/:bulkOrderId/inventory-check` | `staff / inventory:view` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 257 | admin | POST | `/v1/admin/bulk-orders/:bulkOrderId/reserve` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 258 | admin | POST | `/v1/admin/bulk-orders/:bulkOrderId/release` | `staff / inventory:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 259 | admin | POST | `/v1/admin/bulk-orders/:bulkOrderId/procurement-plan` | `staff / inventory:view` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 260 | admin | GET | `/v1/admin/bulk-orders/:bulkOrderId/fulfillment-plan` | `staff / inventory:view` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 261 | admin | GET | `/v1/admin/orders` | `staff / orders:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 262 | admin | GET | `/v1/admin/orders/transitions` | `staff / orders:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 263 | admin | POST | `/v1/admin/orders/bulk` | `staff / orders:edit` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 264 | admin | GET | `/v1/admin/orders/:orderId` | `staff / orders:view` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 265 | admin | PATCH | `/v1/admin/orders/:orderId/status` | `staff / orders:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 266 | admin | POST | `/v1/admin/orders/:orderId/cancel` | `staff / orders:cancel` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 267 | admin | POST | `/v1/admin/orders/:orderId/refund` | `staff / orders:refund` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 268 | admin | POST | `/v1/admin/orders/:orderId/invoice` | `staff / orders:edit` | params | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 269 | admin | POST | `/v1/admin/orders/:orderId/courier` | `staff / delivery:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 270 | admin | POST | `/v1/admin/orders/:orderId/notes` | `staff / orders:edit` | params, body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 271 | admin | POST | `/v1/admin/media/upload` | `staff / dashboard:view` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 272 | storefront | POST | `/v1/store/media/upload` | `customer` | body | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 273 | admin | GET | `/v1/admin/reports/inventory-aging` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 274 | admin | GET | `/v1/admin/reports/dead-stock` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 275 | admin | GET | `/v1/admin/reports/inventory-valuation` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 276 | admin | GET | `/v1/admin/reports/stock-movements` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 277 | admin | GET | `/v1/admin/reports/product-performance` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 278 | admin | GET | `/v1/admin/reports/supplier-performance` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 279 | admin | GET | `/v1/admin/reports/inventory-health` | `staff / inventory:view` | — | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 280 | admin | GET | `/v1/admin/reports/stock-velocity` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 281 | admin | GET | `/v1/admin/reports/purchase-forecast` | `staff / inventory:view` | query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |
| 282 | admin | GET | `/v1/admin/reports/:report/export` | `staff / inventory:export` | params, query | **BLOCKED** | Requires isolated PG/Redis and, where applicable, sandbox integrations |

\* Readiness returning 503 is the correct result for this intentionally dependency-free local process; it is not an application regression.

### What remains unexecuted for every BLOCKED operation

- Valid request and response path with actual DTO values.
- Invalid identifiers, malformed values, missing required fields, duplicate/conflict requests, and boundary values beyond the representative checks above.
- Valid staff/customer authentication, permission-denied staff roles, session rotation, MFA/recovery flows, and rate-limit behavior with Redis.
- Database writes, foreign-key relationships, transaction rollback/commit behavior, stock reservations, order/cart/payment state transitions, and idempotent replays.
- Multipart upload to a safe MinIO/S3 sandbox, queue publication/consumption, Mailpit delivery, Firebase sandbox calls, Razorpay test-mode calls, and webhook signature/replay tests.

## Database, Redis, queues, and external integration summary

| Area | Result |
|---|---|
| PostgreSQL connectivity | **BLOCKED** — no local PostgreSQL process; `/readyz` reported false. |
| PostgreSQL schema/migrations | Static inspection only. `npm run db:generate` passed against a localhost URL, enumerated 127 tables, and produced a transient migration that was removed; no migration was applied. Existing committed migrations are `0001_initial.sql` through `0005_firebase_auth.sql`. |
| Records and relationships | No demo records or relationship assertions were made. |
| Redis | **BLOCKED** — no local Redis process; rate limit, idempotency, session denylist, refresh replay, and step-up state were not exercised. |
| Queue worker | **BLOCKED** — `npm run start:worker` cannot run because this checkout has no `dist/worker.js` or source worker entrypoint. |
| Mail/email | Not invoked; production SES sender remains a stub per static review. |
| S3/MinIO media | Not invoked. Media double-parsing was fixed statically, but storage and cleanup behavior require a sandbox. |
| Firebase | Not invoked; no sandbox identity flow was available. |
| Razorpay/courier | Not invoked; no real financial or delivery side effect was allowed. |

## Swagger/OpenAPI summary

- The route registry is the source of truth and generated successfully from the compiled application.
- Manual generator command: `node dist/lib/openapi/generate.js` with localhost test configuration — **PASS**; it wrote 62 Storefront paths and 159 Admin paths. Generated files were restored after comparison because only environment-dependent server ordering differed.
- Committed OpenAPI inventory remains 70 Storefront operations and 212 Admin operations.
- Storefront OpenAPI JSON is public. Admin OpenAPI JSON and `/docs/admin/` now require the existing staff documentation guard; no new business API was introduced.
- `openapi:generate`, `openapi:lint`, and `docs:generate` are not package scripts in this checkout and were not run as npm commands.

## Fixes applied during this audit

| File | Genuine issue fixed | Verification |
|---|---|---|
| `drizzle.config.ts` | Removed the hardcoded remote database fallback; Drizzle now requires `DATABASE_URL` explicitly and fails closed when it is absent. | Typecheck, build, and safe `db:generate` passed. |
| `src/app.ts` | Added `X-Cart-Token` to CORS allowed and exposed headers, matching the existing cart API contract. | CORS preflight returned 204 with the header present. |
| `src/lib/openapi/swagger.ts` | Stopped unauthenticated exposure of the Admin OpenAPI map. Storefront docs remain public; Admin JSON/UI use the existing staff/IP guard. | Admin JSON/UI returned 401 without a token; Storefront UI/JSON remained 200. |
| `src/modules/media/media.routes.ts`, `media.service.ts`, `media.repository.ts` | Removed the second, route-local Multer parser. Existing shared multipart interception now uploads once, validates the generated media ID, and returns the non-deleted asset record. | Typecheck, build, and all 676 unit tests passed; live S3/DB path remains blocked. |

## Package script results

| Command | Result | Exact outcome |
|---|---|---|
| `npm install` | **PASS with warnings** | 627 packages installed; 628 audited; npm reported 10 moderate vulnerabilities including development dependencies. |
| `npm test -- --reporter=dot` | **PASS** | 21 test files passed; 676/676 tests passed. |
| `npm run typecheck` | **PASS** | TypeScript completed with no errors. |
| `npm run build` | **PASS** | Production TypeScript build completed. |
| `npm run db:generate` | **PASS** | Schema introspection/generation completed with the safe localhost URL; generated artifacts were removed because this audit did not intend a migration. |
| `npm run lint` | **FAIL** | 39 errors across environment preparation, error handling, file interception, auth/Firebase REST, and related modules. No broad lint cleanup was attempted. |
| `npm audit --omit=dev --json` | **FAIL** | 6 moderate production dependency vulnerabilities involving Firebase/Google Cloud request/storage dependencies and `uuid`. No dependency upgrade was applied. |
| `npm run start:worker` | **BLOCKED/FAIL** | Script exists, but `dist/worker.js` is absent; no worker entrypoint exists in the checkout. |

Long-lived/watch scripts (`dev`, `dev:worker`, `test:watch`), formatting, database migration/studio/seed, and Razorpay preflight were not run because they either require unavailable infrastructure, external credentials, or intentionally mutate state. No absent npm script was invoked.

## Static findings still requiring a safe integration follow-up

These are static-review findings recorded in `docs/BACKEND-FLOW.md`; they were not converted into PASS/FAIL claims without a live test harness:

- Worker entrypoint is absent and production SES delivery is a rejecting stub.
- Cart line updates/merge and cart conversion have concurrency/serialization risks.
- Payment capture/refund state and amount checks require concurrency and state-machine tests before any remediation is attempted.
- Warehouse scope enforcement is not consistently applied to arbitrary warehouse IDs and cross-scope transfers.
- Staff permission claims can remain stale until token expiry; MFA challenge/recovery and refresh rotation require atomicity/replay tests.
- Firebase account linking/creation has read-then-write and orphan-account failure windows.
- Rate-limit behavior is fail-open when Redis is unavailable, forwarded-IP handling needs deployment validation, and lazy limiter creation emits an express-rate-limit warning in the dependency-free probe.
- Media MIME/extension trust, file count/aggregate limits, customer ownership, and S3/DB orphan cleanup still need sandbox tests and likely remediation.
- Lint, production dependency audit, and missing OpenAPI/docs npm scripts remain unresolved.

## Modified files

- `README.md` — links to the flow map and this audit report.
- `docs/BACKEND-FLOW.md` — implementation flow diagrams and static-review findings; updated for the CORS/media fixes.
- `docs/API-AUDIT-REPORT.md` — this report and the complete 282-operation matrix.
- `drizzle.config.ts` — fail-closed database configuration.
- `src/app.ts` — CORS cart-token headers.
- `src/lib/openapi/swagger.ts` — guarded Admin OpenAPI document/UI.
- `src/modules/media/media.routes.ts` — use the shared multipart interceptor once.
- `src/modules/media/media.service.ts` — shared media summary lookup and deleted-asset protection.
- `src/modules/media/media.repository.ts` — non-deleted media lookup.

No committed OpenAPI JSON file was changed by this audit. No schema file or migration was changed.

## Explicit no-new-API confirmation

**No new Admin API, Storefront API, V2 API, demo/debug/test route, duplicate controller, duplicate service, replacement API, or authentication bypass was created.** The `/docs/admin` path is documentation UI only; it is not a business API and uses the existing route inventory/authorization mechanisms.
