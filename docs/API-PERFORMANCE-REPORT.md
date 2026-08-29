# Achichiz complete API performance and response test

> Test date: 2026-08-29. This is a truthful performance report for the running local preview. It does **not** claim successful performance testing for business APIs whose required dependencies were unavailable.

## Executive result

- **Actual source-of-truth inventory:** 282 registered operations — 212 Admin and 70 Storefront.
- **Complete valid 10-request performance benchmark:** 1 registered operation (`GET /healthz`).
- **Availability probe:** `GET /readyz` was attempted but timed out while PostgreSQL and Redis were unavailable.
- **Business operations fully benchmarked:** 0/280. They remain explicitly **BLOCKED**, not PASS.
- **No valid dummy records were created.** The local server uses localhost test connection strings only; Docker, PostgreSQL, Redis, MinIO/S3, Firebase, email, queues, and payment sandboxes are unavailable.
- **No remote RDS or production-like credentials were used.**
- **Final status: PARTIAL PASS — infrastructure-limited.**

## Important accounting

Every operation is present in both tables below. `BLOCKED` means no valid benchmark was run because the route could not be exercised safely without its existing dependencies. It is not a claim that the route is slow or broken.

| Metric | Result |
|---|---|
| Total operations | 282 |
| Operations with complete valid 10-request benchmark | 1 |
| Operations attempted as dependency/readiness probe | 1 (`/readyz`) |
| Operations blocked before valid benchmark | 281 |
| Code failures established by this test | 0 |
| Unaccounted/not-listed operations | 0 |
| Records created/updated/deleted | 0 / 0 / 0 |

## Test method

- One warm-up request was sent and excluded for each safe probe.
- Ten sequential benchmark requests were sent for each safe probe.
- The safe probes were health/docs/contract endpoints only. No remote or production state was touched.
- Concurrency was exercised only against the side-effect-free health endpoint at 5, 10, and 25 concurrent requests.
- No business endpoint received fabricated IDs, unauthenticated requests presented as valid performance tests, or destructive payloads.
- The category roll-up in the request was not used to invent routes; the actual `defineRoute()` registry is authoritative. The complete actual route list is the matrix below.

## Safe measured probe results

| Endpoint | Requests | Statuses | Avg | P50 | P95 | P99 | Min | Max | Size | Rating |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| `/healthz` | 10 | 200×10 | 1.47 ms | 1.36 ms | 2.00 ms | 2.24 ms | 1.20 ms | 2.30 ms | 81 B | EXCELLENT |
| `/openapi/storefront.json` | 10 | 200×10 | 4.50 ms | 4.49 ms | 4.91 ms | 5.01 ms | 4.13 ms | 5.04 ms | 389750 B | EXCELLENT |
| `/openapi/admin.json` | 10 | 401×10 | 1.53 ms | 1.57 ms | 1.89 ms | 1.96 ms | 1.14 ms | 1.97 ms | 246 B | HTTP/error probe |
| `/docs/` | 10 | 200×10 | 1.53 ms | 1.37 ms | 2.37 ms | 2.88 ms | 1.17 ms | 3.00 ms | 3895 B | EXCELLENT |
| `/docs/storefront/` | 10 | 200×10 | 1.53 ms | 1.48 ms | 1.84 ms | 1.90 ms | 1.25 ms | 1.92 ms | 3895 B | EXCELLENT |
| `/docs/admin/` | 10 | 401×10 | 1.94 ms | 1.79 ms | 2.91 ms | 3.21 ms | 1.47 ms | 3.28 ms | 239 B | HTTP/error probe |

`/openapi/*` and `/docs/*` are documentation/contract probes rather than members of the 282 business-operation benchmark. The 401 responses for protected Admin documentation are expected security behavior.

## Concurrency results

Only `GET /healthz` was used for concurrency because it is side-effect-free and does not require PostgreSQL, Redis, authentication, or external services.

| Endpoint | Concurrent | Successful | Failed | Avg | P50 | P95 | P99 | Max | Requests/sec |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `/healthz` | 5 | 5 | 0 | 2.42 ms | 2.35 ms | 3.18 ms | 3.22 ms | 3.23 ms | 825.00 |
| `/healthz` | 10 | 10 | 0 | 5.99 ms | 6.50 ms | 7.82 ms | 8.00 ms | 8.05 ms | 655.44 |
| `/healthz` | 25 | 25 | 0 | 10.93 ms | 11.26 ms | 18.29 ms | 19.02 ms | 19.16 ms | 982.25 |

Observed concurrency result: all 5, 10, and 25 requests returned HTTP 200. This is not representative of database-backed or authenticated operations.

## Main performance table — all 282 existing operations

| # | Type | Module | Method | Endpoint | Status | Avg | P50 | P95 | P99 | Min | Max | Size | RPS | Rating |
|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | STORE | System | GET | `/healthz` | PASS | 1.47 ms | 1.36 ms | 2.00 ms | 2.24 ms | 1.20 ms | 2.30 ms | 81 B | 681.15 | EXCELLENT |
| 2 | STORE | System | GET | `/readyz` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 3 | STORE | Products | GET | `/v1/products` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 4 | STORE | Products | GET | `/v1/products/:handle` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 5 | STORE | Products | GET | `/v1/products/:handle/variants` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 6 | STORE | Collections | GET | `/v1/collections` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 7 | STORE | Collections | GET | `/v1/collections/:handle` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 8 | STORE | Collections | GET | `/v1/collections/:handle/products` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 9 | STORE | Designers | GET | `/v1/designers` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 10 | STORE | Designers | GET | `/v1/designers/:handle` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 11 | STORE | Add Ons | GET | `/v1/add-ons` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 12 | STORE | Personalisation Templates | GET | `/v1/personalisation-templates` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 13 | STORE | Hamper Builder | GET | `/v1/hamper-builder/templates` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 14 | STORE | Hamper Builder | GET | `/v1/hamper-builder/templates/:handle` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 15 | STORE | Serviceability | GET | `/v1/serviceability` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 16 | STORE | Search | GET | `/v1/search` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 17 | STORE | Search | GET | `/v1/search/suggest` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 18 | STORE | Search | GET | `/v1/search/suggestions` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 19 | STORE | Blog | GET | `/v1/blog/posts` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 20 | STORE | Blog | GET | `/v1/blog/posts/:slug` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 21 | STORE | Pages | GET | `/v1/pages` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 22 | STORE | Pages | GET | `/v1/pages/:slug` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 23 | STORE | Policies | GET | `/v1/policies/:slug` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 24 | STORE | Faqs | GET | `/v1/faqs` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 25 | STORE | Testimonials | GET | `/v1/testimonials` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 26 | STORE | Cms | GET | `/v1/cms/sections` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 27 | STORE | Banners | GET | `/v1/banners` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 28 | STORE | Seo | GET | `/v1/seo` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 29 | STORE | Menus | GET | `/v1/menus/:key` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 30 | STORE | Cart | GET | `/v1/cart` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 31 | STORE | Cart | POST | `/v1/cart/lines` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 32 | STORE | Cart | PATCH | `/v1/cart/lines/:lineId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 33 | STORE | Cart | DELETE | `/v1/cart/lines/:lineId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 34 | STORE | Cart | DELETE | `/v1/cart` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 35 | STORE | Cart | POST | `/v1/cart/coupon` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 36 | STORE | Cart | DELETE | `/v1/cart/coupon` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 37 | STORE | Cart | POST | `/v1/cart/merge` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 38 | STORE | Checkout | POST | `/v1/checkout/quote` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 39 | STORE | Orders | POST | `/v1/orders` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 40 | STORE | Account | GET | `/v1/account/orders` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 41 | STORE | Account | GET | `/v1/account/orders/:orderId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 42 | STORE | Account | POST | `/v1/account/orders/:orderId/cancel` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 43 | STORE | Orders | GET | `/v1/orders/track` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 44 | STORE | Payments | POST | `/v1/payments/razorpay/order` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 45 | STORE | Payments | POST | `/v1/payments/razorpay/verify` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 46 | STORE | Webhooks | POST | `/v1/webhooks/razorpay` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 47 | STORE | Auth | POST | `/v1/auth/signup` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 48 | STORE | Auth | POST | `/v1/auth/login` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 49 | STORE | Auth | POST | `/v1/auth/firebase` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 50 | STORE | Auth | POST | `/v1/auth/refresh` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 51 | STORE | Auth | POST | `/v1/auth/logout` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 52 | STORE | Auth | POST | `/v1/auth/logout-all` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 53 | STORE | Auth | POST | `/v1/auth/forgot-password` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 54 | STORE | Auth | POST | `/v1/auth/reset-password` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 55 | STORE | Auth | GET | `/v1/auth/me` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 56 | STORE | Account | GET | `/v1/account/profile` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 57 | STORE | Account | PATCH | `/v1/account/profile` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 58 | STORE | Account | GET | `/v1/account/wishlist` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 59 | STORE | Account | POST | `/v1/account/wishlist` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 60 | STORE | Account | DELETE | `/v1/account/wishlist/:productId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 61 | STORE | Account | GET | `/v1/account/addresses` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 62 | STORE | Account | GET | `/v1/account/addresses/:addressId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 63 | STORE | Account | POST | `/v1/account/addresses` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 64 | STORE | Account | PATCH | `/v1/account/addresses/:addressId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 65 | STORE | Account | POST | `/v1/account/addresses/:addressId/default` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 66 | STORE | Account | DELETE | `/v1/account/addresses/:addressId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 67 | STORE | Leads | POST | `/v1/leads/contact` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 68 | STORE | Leads | POST | `/v1/leads/corporate-gifting` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 69 | STORE | Newsletter | POST | `/v1/newsletter/subscribe` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 70 | ADMIN | Admin / auth | POST | `/v1/admin/auth/login` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 71 | ADMIN | Admin / auth | POST | `/v1/admin/auth/2fa/setup` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 72 | ADMIN | Admin / auth | POST | `/v1/admin/auth/2fa/enable` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 73 | ADMIN | Admin / auth | POST | `/v1/admin/auth/2fa/verify` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 74 | ADMIN | Admin / auth | POST | `/v1/admin/auth/refresh` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 75 | ADMIN | Admin / auth | POST | `/v1/admin/auth/logout` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 76 | ADMIN | Admin / auth | POST | `/v1/admin/auth/password/forgot` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 77 | ADMIN | Admin / auth | POST | `/v1/admin/auth/password/reset` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 78 | ADMIN | Admin / auth | POST | `/v1/admin/auth/step-up` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 79 | ADMIN | Admin / auth | POST | `/v1/admin/auth/2fa/recovery-codes` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 80 | ADMIN | Admin / me | GET | `/v1/admin/me` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 81 | ADMIN | Admin / sessions | GET | `/v1/admin/sessions` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 82 | ADMIN | Admin / sessions | DELETE | `/v1/admin/sessions/:sessionId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 83 | ADMIN | Admin / roles | GET | `/v1/admin/roles` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 84 | ADMIN | Admin / roles | GET | `/v1/admin/roles/:roleId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 85 | ADMIN | Admin / permissions | GET | `/v1/admin/permissions` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 86 | ADMIN | Admin / permissions | GET | `/v1/admin/permissions/matrix` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 87 | ADMIN | Admin / roles | POST | `/v1/admin/roles/sync` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 88 | ADMIN | Admin / resources | GET | `/v1/admin/resources` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 89 | ADMIN | Admin / products | GET | `/v1/admin/products` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 90 | ADMIN | Admin / products | GET | `/v1/admin/products/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 91 | ADMIN | Admin / products | POST | `/v1/admin/products/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 92 | ADMIN | Admin / products | POST | `/v1/admin/products` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 93 | ADMIN | Admin / products | GET | `/v1/admin/products/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 94 | ADMIN | Admin / products | PATCH | `/v1/admin/products/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 95 | ADMIN | Admin / products | DELETE | `/v1/admin/products/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 96 | ADMIN | Admin / product-variants | GET | `/v1/admin/product-variants` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 97 | ADMIN | Admin / product-variants | GET | `/v1/admin/product-variants/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 98 | ADMIN | Admin / product-variants | POST | `/v1/admin/product-variants/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 99 | ADMIN | Admin / product-variants | POST | `/v1/admin/product-variants` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 100 | ADMIN | Admin / product-variants | GET | `/v1/admin/product-variants/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 101 | ADMIN | Admin / product-variants | PATCH | `/v1/admin/product-variants/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 102 | ADMIN | Admin / product-variants | DELETE | `/v1/admin/product-variants/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 103 | ADMIN | Admin / collections | GET | `/v1/admin/collections` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 104 | ADMIN | Admin / collections | GET | `/v1/admin/collections/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 105 | ADMIN | Admin / collections | POST | `/v1/admin/collections/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 106 | ADMIN | Admin / collections | POST | `/v1/admin/collections` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 107 | ADMIN | Admin / collections | GET | `/v1/admin/collections/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 108 | ADMIN | Admin / collections | PATCH | `/v1/admin/collections/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 109 | ADMIN | Admin / collections | DELETE | `/v1/admin/collections/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 110 | ADMIN | Admin / designers | GET | `/v1/admin/designers` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 111 | ADMIN | Admin / designers | GET | `/v1/admin/designers/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 112 | ADMIN | Admin / designers | POST | `/v1/admin/designers/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 113 | ADMIN | Admin / designers | POST | `/v1/admin/designers` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 114 | ADMIN | Admin / designers | GET | `/v1/admin/designers/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 115 | ADMIN | Admin / designers | PATCH | `/v1/admin/designers/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 116 | ADMIN | Admin / designers | DELETE | `/v1/admin/designers/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 117 | ADMIN | Admin / customers | GET | `/v1/admin/customers` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 118 | ADMIN | Admin / customers | GET | `/v1/admin/customers/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 119 | ADMIN | Admin / customers | POST | `/v1/admin/customers/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 120 | ADMIN | Admin / customers | POST | `/v1/admin/customers` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 121 | ADMIN | Admin / customers | GET | `/v1/admin/customers/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 122 | ADMIN | Admin / customers | PATCH | `/v1/admin/customers/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 123 | ADMIN | Admin / customers | DELETE | `/v1/admin/customers/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 124 | ADMIN | Admin / coupons | GET | `/v1/admin/coupons` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 125 | ADMIN | Admin / coupons | GET | `/v1/admin/coupons/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 126 | ADMIN | Admin / coupons | POST | `/v1/admin/coupons/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 127 | ADMIN | Admin / coupons | POST | `/v1/admin/coupons` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 128 | ADMIN | Admin / coupons | GET | `/v1/admin/coupons/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 129 | ADMIN | Admin / coupons | PATCH | `/v1/admin/coupons/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 130 | ADMIN | Admin / coupons | DELETE | `/v1/admin/coupons/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 131 | ADMIN | Admin / gift-cards | GET | `/v1/admin/gift-cards` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 132 | ADMIN | Admin / gift-cards | GET | `/v1/admin/gift-cards/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 133 | ADMIN | Admin / gift-cards | POST | `/v1/admin/gift-cards/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 134 | ADMIN | Admin / gift-cards | POST | `/v1/admin/gift-cards` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 135 | ADMIN | Admin / gift-cards | GET | `/v1/admin/gift-cards/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 136 | ADMIN | Admin / gift-cards | PATCH | `/v1/admin/gift-cards/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 137 | ADMIN | Admin / gift-cards | DELETE | `/v1/admin/gift-cards/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 138 | ADMIN | Admin / banners | GET | `/v1/admin/banners` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 139 | ADMIN | Admin / banners | GET | `/v1/admin/banners/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 140 | ADMIN | Admin / banners | POST | `/v1/admin/banners/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 141 | ADMIN | Admin / banners | POST | `/v1/admin/banners` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 142 | ADMIN | Admin / banners | GET | `/v1/admin/banners/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 143 | ADMIN | Admin / banners | PATCH | `/v1/admin/banners/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 144 | ADMIN | Admin / banners | DELETE | `/v1/admin/banners/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 145 | ADMIN | Admin / faqs | GET | `/v1/admin/faqs` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 146 | ADMIN | Admin / faqs | GET | `/v1/admin/faqs/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 147 | ADMIN | Admin / faqs | POST | `/v1/admin/faqs/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 148 | ADMIN | Admin / faqs | POST | `/v1/admin/faqs` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 149 | ADMIN | Admin / faqs | GET | `/v1/admin/faqs/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 150 | ADMIN | Admin / faqs | PATCH | `/v1/admin/faqs/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 151 | ADMIN | Admin / faqs | DELETE | `/v1/admin/faqs/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 152 | ADMIN | Admin / testimonials | GET | `/v1/admin/testimonials` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 153 | ADMIN | Admin / testimonials | GET | `/v1/admin/testimonials/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 154 | ADMIN | Admin / testimonials | POST | `/v1/admin/testimonials/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 155 | ADMIN | Admin / testimonials | POST | `/v1/admin/testimonials` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 156 | ADMIN | Admin / testimonials | GET | `/v1/admin/testimonials/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 157 | ADMIN | Admin / testimonials | PATCH | `/v1/admin/testimonials/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 158 | ADMIN | Admin / testimonials | DELETE | `/v1/admin/testimonials/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 159 | ADMIN | Admin / suppliers | GET | `/v1/admin/suppliers` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 160 | ADMIN | Admin / suppliers | GET | `/v1/admin/suppliers/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 161 | ADMIN | Admin / suppliers | POST | `/v1/admin/suppliers/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 162 | ADMIN | Admin / suppliers | POST | `/v1/admin/suppliers` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 163 | ADMIN | Admin / suppliers | GET | `/v1/admin/suppliers/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 164 | ADMIN | Admin / suppliers | PATCH | `/v1/admin/suppliers/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 165 | ADMIN | Admin / suppliers | DELETE | `/v1/admin/suppliers/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 166 | ADMIN | Admin / warehouses | GET | `/v1/admin/warehouses` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 167 | ADMIN | Admin / warehouses | GET | `/v1/admin/warehouses/schema` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 168 | ADMIN | Admin / warehouses | POST | `/v1/admin/warehouses/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 169 | ADMIN | Admin / warehouses | POST | `/v1/admin/warehouses` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 170 | ADMIN | Admin / warehouses | GET | `/v1/admin/warehouses/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 171 | ADMIN | Admin / warehouses | PATCH | `/v1/admin/warehouses/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 172 | ADMIN | Admin / warehouses | DELETE | `/v1/admin/warehouses/:id` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 173 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/dashboard` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 174 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 175 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/movements` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 176 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/movements/:movementId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 177 | ADMIN | Admin / inventory | POST | `/v1/admin/inventory/adjustments` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 178 | ADMIN | Admin / inventory | POST | `/v1/admin/inventory/bulk-adjust` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 179 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/alerts/low-stock` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 180 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/alerts/out-of-stock` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 181 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/reorder` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 182 | ADMIN | Admin / inventory | POST | `/v1/admin/inventory/reorder/purchase-draft` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 183 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/reservations` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 184 | ADMIN | Admin / inventory | POST | `/v1/admin/inventory/reservations` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 185 | ADMIN | Admin / inventory | POST | `/v1/admin/inventory/reservations/:id/release` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 186 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/audit` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 187 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/notifications` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 188 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/export` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 189 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/:sku/availability` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 190 | ADMIN | Admin / inventory | GET | `/v1/admin/inventory/:sku` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 191 | ADMIN | Admin / warehouses | GET | `/v1/admin/warehouses/:warehouseId/locations` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 192 | ADMIN | Admin / warehouses | POST | `/v1/admin/warehouses/:warehouseId/locations` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 193 | ADMIN | Admin / warehouses | GET | `/v1/admin/warehouses/:warehouseId/locations/:locationId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 194 | ADMIN | Admin / warehouses | PATCH | `/v1/admin/warehouses/:warehouseId/locations/:locationId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 195 | ADMIN | Admin / warehouses | POST | `/v1/admin/warehouses/:warehouseId/locations/:locationId/archive` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 196 | ADMIN | Admin / warehouses | GET | `/v1/admin/warehouses/:warehouseId/inventory` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 197 | ADMIN | Admin / transfers | GET | `/v1/admin/transfers` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 198 | ADMIN | Admin / transfers | POST | `/v1/admin/transfers` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 199 | ADMIN | Admin / transfers | GET | `/v1/admin/transfers/:transferId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 200 | ADMIN | Admin / transfers | POST | `/v1/admin/transfers/:transferId/approve` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 201 | ADMIN | Admin / transfers | POST | `/v1/admin/transfers/:transferId/dispatch` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 202 | ADMIN | Admin / transfers | POST | `/v1/admin/transfers/:transferId/receive` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 203 | ADMIN | Admin / transfers | POST | `/v1/admin/transfers/:transferId/cancel` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 204 | ADMIN | Admin / suppliers | GET | `/v1/admin/suppliers/:supplierId/products` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 205 | ADMIN | Admin / suppliers | POST | `/v1/admin/suppliers/:supplierId/products` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 206 | ADMIN | Admin / suppliers | PATCH | `/v1/admin/suppliers/:supplierId/products/:supplierProductId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 207 | ADMIN | Admin / purchasing | GET | `/v1/admin/purchasing/purchase-orders` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 208 | ADMIN | Admin / purchasing | POST | `/v1/admin/purchasing/purchase-orders` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 209 | ADMIN | Admin / purchasing | GET | `/v1/admin/purchasing/purchase-orders/:poId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 210 | ADMIN | Admin / purchasing | PATCH | `/v1/admin/purchasing/purchase-orders/:poId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 211 | ADMIN | Admin / purchasing | POST | `/v1/admin/purchasing/purchase-orders/:poId/approve` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 212 | ADMIN | Admin / purchasing | POST | `/v1/admin/purchasing/purchase-orders/:poId/send` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 213 | ADMIN | Admin / purchasing | POST | `/v1/admin/purchasing/purchase-orders/:poId/cancel` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 214 | ADMIN | Admin / purchasing | GET | `/v1/admin/purchasing/goods-receipts` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 215 | ADMIN | Admin / purchasing | POST | `/v1/admin/purchasing/goods-receipts` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 216 | ADMIN | Admin / purchasing | GET | `/v1/admin/purchasing/goods-receipts/:grnId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 217 | ADMIN | Admin / purchasing | GET | `/v1/admin/purchasing/purchase-returns` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 218 | ADMIN | Admin / purchasing | POST | `/v1/admin/purchasing/purchase-returns` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 219 | ADMIN | Admin / purchasing | GET | `/v1/admin/purchasing/purchase-returns/:returnId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 220 | ADMIN | Admin / purchasing | POST | `/v1/admin/purchasing/purchase-returns/:returnId/approve` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 221 | ADMIN | Admin / purchasing | POST | `/v1/admin/purchasing/purchase-returns/:returnId/dispatch` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 222 | ADMIN | Admin / bundles | GET | `/v1/admin/bundles` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 223 | ADMIN | Admin / bundles | POST | `/v1/admin/bundles` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 224 | ADMIN | Admin / bundles | GET | `/v1/admin/bundles/:bundleId/availability` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 225 | ADMIN | Admin / bundles | POST | `/v1/admin/bundles/:bundleId/archive` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 226 | ADMIN | Admin / bundles | GET | `/v1/admin/bundles/:bundleId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 227 | ADMIN | Admin / bundles | PATCH | `/v1/admin/bundles/:bundleId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 228 | ADMIN | Admin / boms | GET | `/v1/admin/boms` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 229 | ADMIN | Admin / boms | POST | `/v1/admin/boms` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 230 | ADMIN | Admin / boms | GET | `/v1/admin/boms/:bomId/explosion` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 231 | ADMIN | Admin / boms | GET | `/v1/admin/boms/:bomId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 232 | ADMIN | Admin / boms | PATCH | `/v1/admin/boms/:bomId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 233 | ADMIN | Admin / boms | POST | `/v1/admin/boms/:bomId/archive` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 234 | ADMIN | Admin / production | GET | `/v1/admin/production/orders` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 235 | ADMIN | Admin / production | POST | `/v1/admin/production/orders` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 236 | ADMIN | Admin / production | GET | `/v1/admin/production/orders/:productionId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 237 | ADMIN | Admin / production | POST | `/v1/admin/production/orders/:productionId/start` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 238 | ADMIN | Admin / production | POST | `/v1/admin/production/orders/:productionId/complete` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 239 | ADMIN | Admin / production | POST | `/v1/admin/production/orders/:productionId/cancel` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 240 | ADMIN | Admin / stock-counts | GET | `/v1/admin/stock-counts` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 241 | ADMIN | Admin / stock-counts | POST | `/v1/admin/stock-counts` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 242 | ADMIN | Admin / stock-counts | GET | `/v1/admin/stock-counts/:countId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 243 | ADMIN | Admin / stock-counts | POST | `/v1/admin/stock-counts/:countId/start` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 244 | ADMIN | Admin / stock-counts | POST | `/v1/admin/stock-counts/:countId/items` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 245 | ADMIN | Admin / stock-counts | POST | `/v1/admin/stock-counts/:countId/complete` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 246 | ADMIN | Admin / stock-counts | POST | `/v1/admin/stock-counts/:countId/approve` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 247 | ADMIN | Admin / barcodes | GET | `/v1/admin/barcodes/:sku` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 248 | ADMIN | Admin / barcodes | POST | `/v1/admin/barcodes/generate` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 249 | ADMIN | Admin / barcodes | POST | `/v1/admin/barcodes/bulk-generate` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 250 | ADMIN | Admin / barcodes | POST | `/v1/admin/barcodes/scan` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 251 | ADMIN | Admin / qr | GET | `/v1/admin/qr/:sku` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 252 | ADMIN | Admin / bulk-orders | GET | `/v1/admin/bulk-orders` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 253 | ADMIN | Admin / bulk-orders | POST | `/v1/admin/bulk-orders` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 254 | ADMIN | Admin / bulk-orders | GET | `/v1/admin/bulk-orders/:bulkOrderId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 255 | ADMIN | Admin / bulk-orders | PATCH | `/v1/admin/bulk-orders/:bulkOrderId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 256 | ADMIN | Admin / bulk-orders | POST | `/v1/admin/bulk-orders/:bulkOrderId/inventory-check` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 257 | ADMIN | Admin / bulk-orders | POST | `/v1/admin/bulk-orders/:bulkOrderId/reserve` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 258 | ADMIN | Admin / bulk-orders | POST | `/v1/admin/bulk-orders/:bulkOrderId/release` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 259 | ADMIN | Admin / bulk-orders | POST | `/v1/admin/bulk-orders/:bulkOrderId/procurement-plan` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 260 | ADMIN | Admin / bulk-orders | GET | `/v1/admin/bulk-orders/:bulkOrderId/fulfillment-plan` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 261 | ADMIN | Admin / orders | GET | `/v1/admin/orders` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 262 | ADMIN | Admin / orders | GET | `/v1/admin/orders/transitions` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 263 | ADMIN | Admin / orders | POST | `/v1/admin/orders/bulk` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 264 | ADMIN | Admin / orders | GET | `/v1/admin/orders/:orderId` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 265 | ADMIN | Admin / orders | PATCH | `/v1/admin/orders/:orderId/status` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 266 | ADMIN | Admin / orders | POST | `/v1/admin/orders/:orderId/cancel` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 267 | ADMIN | Admin / orders | POST | `/v1/admin/orders/:orderId/refund` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 268 | ADMIN | Admin / orders | POST | `/v1/admin/orders/:orderId/invoice` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 269 | ADMIN | Admin / orders | POST | `/v1/admin/orders/:orderId/courier` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 270 | ADMIN | Admin / orders | POST | `/v1/admin/orders/:orderId/notes` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 271 | ADMIN | Admin / media | POST | `/v1/admin/media/upload` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 272 | STORE | Store | POST | `/v1/store/media/upload` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 273 | ADMIN | Admin / reports | GET | `/v1/admin/reports/inventory-aging` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 274 | ADMIN | Admin / reports | GET | `/v1/admin/reports/dead-stock` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 275 | ADMIN | Admin / reports | GET | `/v1/admin/reports/inventory-valuation` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 276 | ADMIN | Admin / reports | GET | `/v1/admin/reports/stock-movements` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 277 | ADMIN | Admin / reports | GET | `/v1/admin/reports/product-performance` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 278 | ADMIN | Admin / reports | GET | `/v1/admin/reports/supplier-performance` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 279 | ADMIN | Admin / reports | GET | `/v1/admin/reports/inventory-health` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 280 | ADMIN | Admin / reports | GET | `/v1/admin/reports/stock-velocity` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 281 | ADMIN | Admin / reports | GET | `/v1/admin/reports/purchase-forecast` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |
| 282 | ADMIN | Admin / reports | GET | `/v1/admin/reports/:report/export` | BLOCKED — dependency unavailable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | BLOCKED / N/A |

### Matrix interpretation

- `PASS` is used only for the actual health benchmark, whose HTTP 200 response was received and measured.
- `BLOCKED` is used for all other registered operations because valid business requests require unavailable PostgreSQL/Redis and, for some routes, storage, queues, authentication, or external sandboxes.
- No average, percentile, response size, or RPS value was fabricated for blocked operations.

## Per-operation execution detail — all 282 operations

| # | Endpoint | Authentication | Demo data | Requests | Successful | Failed | Response validation | Database | Redis | File storage | Notes |
|---:|---|---|---|---:|---:|---:|---|---|---|---|---|
| 1 | `/healthz` | `public` | N/A | 10 benchmark | 10 | 0 | PASS — expected health envelope | N/A | N/A | N/A | 10 measured requests; see safe probe table |
| 2 | `/readyz` | `public` | None created | availability attempt | 0 | timeout | N/A — dependency timeout | BLOCKED | BLOCKED | N/A | PostgreSQL and Redis unavailable |
| 3 | `/v1/products` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 4 | `/v1/products/:handle` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 5 | `/v1/products/:handle/variants` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 6 | `/v1/collections` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 7 | `/v1/collections/:handle` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 8 | `/v1/collections/:handle/products` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 9 | `/v1/designers` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 10 | `/v1/designers/:handle` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 11 | `/v1/add-ons` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 12 | `/v1/personalisation-templates` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 13 | `/v1/hamper-builder/templates` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 14 | `/v1/hamper-builder/templates/:handle` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 15 | `/v1/serviceability` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 16 | `/v1/search` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 17 | `/v1/search/suggest` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 18 | `/v1/search/suggestions` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 19 | `/v1/blog/posts` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 20 | `/v1/blog/posts/:slug` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 21 | `/v1/pages` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 22 | `/v1/pages/:slug` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 23 | `/v1/policies/:slug` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 24 | `/v1/faqs` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 25 | `/v1/testimonials` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 26 | `/v1/cms/sections` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 27 | `/v1/banners` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 28 | `/v1/seo` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 29 | `/v1/menus/:key` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 30 | `/v1/cart` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 31 | `/v1/cart/lines` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 32 | `/v1/cart/lines/:lineId` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 33 | `/v1/cart/lines/:lineId` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 34 | `/v1/cart` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 35 | `/v1/cart/coupon` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 36 | `/v1/cart/coupon` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 37 | `/v1/cart/merge` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 38 | `/v1/checkout/quote` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 39 | `/v1/orders` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 40 | `/v1/account/orders` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 41 | `/v1/account/orders/:orderId` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 42 | `/v1/account/orders/:orderId/cancel` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 43 | `/v1/orders/track` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 44 | `/v1/payments/razorpay/order` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 45 | `/v1/payments/razorpay/verify` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 46 | `/v1/webhooks/razorpay` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 47 | `/v1/auth/signup` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 48 | `/v1/auth/login` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 49 | `/v1/auth/firebase` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 50 | `/v1/auth/refresh` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 51 | `/v1/auth/logout` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 52 | `/v1/auth/logout-all` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 53 | `/v1/auth/forgot-password` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 54 | `/v1/auth/reset-password` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 55 | `/v1/auth/me` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 56 | `/v1/account/profile` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 57 | `/v1/account/profile` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 58 | `/v1/account/wishlist` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 59 | `/v1/account/wishlist` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 60 | `/v1/account/wishlist/:productId` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 61 | `/v1/account/addresses` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 62 | `/v1/account/addresses/:addressId` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 63 | `/v1/account/addresses` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 64 | `/v1/account/addresses/:addressId` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 65 | `/v1/account/addresses/:addressId/default` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 66 | `/v1/account/addresses/:addressId` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 67 | `/v1/leads/contact` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 68 | `/v1/leads/corporate-gifting` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 69 | `/v1/newsletter/subscribe` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 70 | `/v1/admin/auth/login` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 71 | `/v1/admin/auth/2fa/setup` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 72 | `/v1/admin/auth/2fa/enable` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 73 | `/v1/admin/auth/2fa/verify` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 74 | `/v1/admin/auth/refresh` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 75 | `/v1/admin/auth/logout` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 76 | `/v1/admin/auth/password/forgot` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 77 | `/v1/admin/auth/password/reset` | `public` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 78 | `/v1/admin/auth/step-up` | `staff` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 79 | `/v1/admin/auth/2fa/recovery-codes` | `staff` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 80 | `/v1/admin/me` | `staff / dashboard:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 81 | `/v1/admin/sessions` | `staff / dashboard:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 82 | `/v1/admin/sessions/:sessionId` | `staff / dashboard:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 83 | `/v1/admin/roles` | `staff / settings:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 84 | `/v1/admin/roles/:roleId` | `staff / settings:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 85 | `/v1/admin/permissions` | `staff / settings:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 86 | `/v1/admin/permissions/matrix` | `staff / settings:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 87 | `/v1/admin/roles/sync` | `staff / settings:manage-settings` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 88 | `/v1/admin/resources` | `staff / dashboard:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 89 | `/v1/admin/products` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 90 | `/v1/admin/products/schema` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 91 | `/v1/admin/products/bulk` | `staff / catalogue:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 92 | `/v1/admin/products` | `staff / catalogue:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 93 | `/v1/admin/products/:id` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 94 | `/v1/admin/products/:id` | `staff / catalogue:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 95 | `/v1/admin/products/:id` | `staff / catalogue:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 96 | `/v1/admin/product-variants` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 97 | `/v1/admin/product-variants/schema` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 98 | `/v1/admin/product-variants/bulk` | `staff / catalogue:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 99 | `/v1/admin/product-variants` | `staff / catalogue:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 100 | `/v1/admin/product-variants/:id` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 101 | `/v1/admin/product-variants/:id` | `staff / catalogue:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 102 | `/v1/admin/product-variants/:id` | `staff / catalogue:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 103 | `/v1/admin/collections` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 104 | `/v1/admin/collections/schema` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 105 | `/v1/admin/collections/bulk` | `staff / catalogue:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 106 | `/v1/admin/collections` | `staff / catalogue:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 107 | `/v1/admin/collections/:id` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 108 | `/v1/admin/collections/:id` | `staff / catalogue:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 109 | `/v1/admin/collections/:id` | `staff / catalogue:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 110 | `/v1/admin/designers` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 111 | `/v1/admin/designers/schema` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 112 | `/v1/admin/designers/bulk` | `staff / catalogue:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 113 | `/v1/admin/designers` | `staff / catalogue:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 114 | `/v1/admin/designers/:id` | `staff / catalogue:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 115 | `/v1/admin/designers/:id` | `staff / catalogue:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 116 | `/v1/admin/designers/:id` | `staff / catalogue:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 117 | `/v1/admin/customers` | `staff / customers:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 118 | `/v1/admin/customers/schema` | `staff / customers:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 119 | `/v1/admin/customers/bulk` | `staff / customers:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 120 | `/v1/admin/customers` | `staff / customers:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 121 | `/v1/admin/customers/:id` | `staff / customers:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 122 | `/v1/admin/customers/:id` | `staff / customers:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 123 | `/v1/admin/customers/:id` | `staff / customers:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 124 | `/v1/admin/coupons` | `staff / promotions:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 125 | `/v1/admin/coupons/schema` | `staff / promotions:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 126 | `/v1/admin/coupons/bulk` | `staff / promotions:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 127 | `/v1/admin/coupons` | `staff / promotions:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 128 | `/v1/admin/coupons/:id` | `staff / promotions:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 129 | `/v1/admin/coupons/:id` | `staff / promotions:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 130 | `/v1/admin/coupons/:id` | `staff / promotions:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 131 | `/v1/admin/gift-cards` | `staff / promotions:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 132 | `/v1/admin/gift-cards/schema` | `staff / promotions:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 133 | `/v1/admin/gift-cards/bulk` | `staff / promotions:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 134 | `/v1/admin/gift-cards` | `staff / promotions:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 135 | `/v1/admin/gift-cards/:id` | `staff / promotions:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 136 | `/v1/admin/gift-cards/:id` | `staff / promotions:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 137 | `/v1/admin/gift-cards/:id` | `staff / promotions:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 138 | `/v1/admin/banners` | `staff / content:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 139 | `/v1/admin/banners/schema` | `staff / content:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 140 | `/v1/admin/banners/bulk` | `staff / content:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 141 | `/v1/admin/banners` | `staff / content:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 142 | `/v1/admin/banners/:id` | `staff / content:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 143 | `/v1/admin/banners/:id` | `staff / content:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 144 | `/v1/admin/banners/:id` | `staff / content:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 145 | `/v1/admin/faqs` | `staff / content:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 146 | `/v1/admin/faqs/schema` | `staff / content:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 147 | `/v1/admin/faqs/bulk` | `staff / content:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 148 | `/v1/admin/faqs` | `staff / content:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 149 | `/v1/admin/faqs/:id` | `staff / content:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 150 | `/v1/admin/faqs/:id` | `staff / content:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 151 | `/v1/admin/faqs/:id` | `staff / content:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 152 | `/v1/admin/testimonials` | `staff / content:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 153 | `/v1/admin/testimonials/schema` | `staff / content:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 154 | `/v1/admin/testimonials/bulk` | `staff / content:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 155 | `/v1/admin/testimonials` | `staff / content:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 156 | `/v1/admin/testimonials/:id` | `staff / content:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 157 | `/v1/admin/testimonials/:id` | `staff / content:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 158 | `/v1/admin/testimonials/:id` | `staff / content:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 159 | `/v1/admin/suppliers` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 160 | `/v1/admin/suppliers/schema` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 161 | `/v1/admin/suppliers/bulk` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 162 | `/v1/admin/suppliers` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 163 | `/v1/admin/suppliers/:id` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 164 | `/v1/admin/suppliers/:id` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 165 | `/v1/admin/suppliers/:id` | `staff / inventory:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 166 | `/v1/admin/warehouses` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 167 | `/v1/admin/warehouses/schema` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 168 | `/v1/admin/warehouses/bulk` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 169 | `/v1/admin/warehouses` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 170 | `/v1/admin/warehouses/:id` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 171 | `/v1/admin/warehouses/:id` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 172 | `/v1/admin/warehouses/:id` | `staff / inventory:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 173 | `/v1/admin/inventory/dashboard` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 174 | `/v1/admin/inventory` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 175 | `/v1/admin/inventory/movements` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 176 | `/v1/admin/inventory/movements/:movementId` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 177 | `/v1/admin/inventory/adjustments` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 178 | `/v1/admin/inventory/bulk-adjust` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 179 | `/v1/admin/inventory/alerts/low-stock` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 180 | `/v1/admin/inventory/alerts/out-of-stock` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 181 | `/v1/admin/inventory/reorder` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 182 | `/v1/admin/inventory/reorder/purchase-draft` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 183 | `/v1/admin/inventory/reservations` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 184 | `/v1/admin/inventory/reservations` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 185 | `/v1/admin/inventory/reservations/:id/release` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 186 | `/v1/admin/inventory/audit` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 187 | `/v1/admin/inventory/notifications` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 188 | `/v1/admin/inventory/export` | `staff / inventory:export` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 189 | `/v1/admin/inventory/:sku/availability` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 190 | `/v1/admin/inventory/:sku` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 191 | `/v1/admin/warehouses/:warehouseId/locations` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 192 | `/v1/admin/warehouses/:warehouseId/locations` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 193 | `/v1/admin/warehouses/:warehouseId/locations/:locationId` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 194 | `/v1/admin/warehouses/:warehouseId/locations/:locationId` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 195 | `/v1/admin/warehouses/:warehouseId/locations/:locationId/archive` | `staff / inventory:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 196 | `/v1/admin/warehouses/:warehouseId/inventory` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 197 | `/v1/admin/transfers` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 198 | `/v1/admin/transfers` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 199 | `/v1/admin/transfers/:transferId` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 200 | `/v1/admin/transfers/:transferId/approve` | `staff / inventory:approve` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 201 | `/v1/admin/transfers/:transferId/dispatch` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 202 | `/v1/admin/transfers/:transferId/receive` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 203 | `/v1/admin/transfers/:transferId/cancel` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 204 | `/v1/admin/suppliers/:supplierId/products` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 205 | `/v1/admin/suppliers/:supplierId/products` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 206 | `/v1/admin/suppliers/:supplierId/products/:supplierProductId` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 207 | `/v1/admin/purchasing/purchase-orders` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 208 | `/v1/admin/purchasing/purchase-orders` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 209 | `/v1/admin/purchasing/purchase-orders/:poId` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 210 | `/v1/admin/purchasing/purchase-orders/:poId` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 211 | `/v1/admin/purchasing/purchase-orders/:poId/approve` | `staff / inventory:approve` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 212 | `/v1/admin/purchasing/purchase-orders/:poId/send` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 213 | `/v1/admin/purchasing/purchase-orders/:poId/cancel` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 214 | `/v1/admin/purchasing/goods-receipts` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 215 | `/v1/admin/purchasing/goods-receipts` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 216 | `/v1/admin/purchasing/goods-receipts/:grnId` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 217 | `/v1/admin/purchasing/purchase-returns` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 218 | `/v1/admin/purchasing/purchase-returns` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 219 | `/v1/admin/purchasing/purchase-returns/:returnId` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 220 | `/v1/admin/purchasing/purchase-returns/:returnId/approve` | `staff / inventory:approve` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 221 | `/v1/admin/purchasing/purchase-returns/:returnId/dispatch` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 222 | `/v1/admin/bundles` | `staff / promotions:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 223 | `/v1/admin/bundles` | `staff / promotions:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 224 | `/v1/admin/bundles/:bundleId/availability` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 225 | `/v1/admin/bundles/:bundleId/archive` | `staff / promotions:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 226 | `/v1/admin/bundles/:bundleId` | `staff / promotions:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 227 | `/v1/admin/bundles/:bundleId` | `staff / promotions:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 228 | `/v1/admin/boms` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 229 | `/v1/admin/boms` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 230 | `/v1/admin/boms/:bomId/explosion` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 231 | `/v1/admin/boms/:bomId` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 232 | `/v1/admin/boms/:bomId` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 233 | `/v1/admin/boms/:bomId/archive` | `staff / inventory:delete` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 234 | `/v1/admin/production/orders` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 235 | `/v1/admin/production/orders` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 236 | `/v1/admin/production/orders/:productionId` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 237 | `/v1/admin/production/orders/:productionId/start` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 238 | `/v1/admin/production/orders/:productionId/complete` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 239 | `/v1/admin/production/orders/:productionId/cancel` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 240 | `/v1/admin/stock-counts` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 241 | `/v1/admin/stock-counts` | `staff / inventory:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 242 | `/v1/admin/stock-counts/:countId` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 243 | `/v1/admin/stock-counts/:countId/start` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 244 | `/v1/admin/stock-counts/:countId/items` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 245 | `/v1/admin/stock-counts/:countId/complete` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 246 | `/v1/admin/stock-counts/:countId/approve` | `staff / inventory:approve` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 247 | `/v1/admin/barcodes/:sku` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 248 | `/v1/admin/barcodes/generate` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 249 | `/v1/admin/barcodes/bulk-generate` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 250 | `/v1/admin/barcodes/scan` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 251 | `/v1/admin/qr/:sku` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 252 | `/v1/admin/bulk-orders` | `staff / corporate:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 253 | `/v1/admin/bulk-orders` | `staff / corporate:create` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 254 | `/v1/admin/bulk-orders/:bulkOrderId` | `staff / corporate:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 255 | `/v1/admin/bulk-orders/:bulkOrderId` | `staff / corporate:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 256 | `/v1/admin/bulk-orders/:bulkOrderId/inventory-check` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 257 | `/v1/admin/bulk-orders/:bulkOrderId/reserve` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 258 | `/v1/admin/bulk-orders/:bulkOrderId/release` | `staff / inventory:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 259 | `/v1/admin/bulk-orders/:bulkOrderId/procurement-plan` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 260 | `/v1/admin/bulk-orders/:bulkOrderId/fulfillment-plan` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 261 | `/v1/admin/orders` | `staff / orders:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 262 | `/v1/admin/orders/transitions` | `staff / orders:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 263 | `/v1/admin/orders/bulk` | `staff / orders:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 264 | `/v1/admin/orders/:orderId` | `staff / orders:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 265 | `/v1/admin/orders/:orderId/status` | `staff / orders:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 266 | `/v1/admin/orders/:orderId/cancel` | `staff / orders:cancel` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 267 | `/v1/admin/orders/:orderId/refund` | `staff / orders:refund` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 268 | `/v1/admin/orders/:orderId/invoice` | `staff / orders:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 269 | `/v1/admin/orders/:orderId/courier` | `staff / delivery:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 270 | `/v1/admin/orders/:orderId/notes` | `staff / orders:edit` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 271 | `/v1/admin/media/upload` | `staff / dashboard:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | BLOCKED | Safe execution blocked by missing local dependencies |
| 272 | `/v1/store/media/upload` | `customer` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | BLOCKED | Safe execution blocked by missing local dependencies |
| 273 | `/v1/admin/reports/inventory-aging` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 274 | `/v1/admin/reports/dead-stock` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 275 | `/v1/admin/reports/inventory-valuation` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 276 | `/v1/admin/reports/stock-movements` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 277 | `/v1/admin/reports/product-performance` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 278 | `/v1/admin/reports/supplier-performance` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 279 | `/v1/admin/reports/inventory-health` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 280 | `/v1/admin/reports/stock-velocity` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 281 | `/v1/admin/reports/purchase-forecast` | `staff / inventory:view` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |
| 282 | `/v1/admin/reports/:report/export` | `staff / inventory:export` | None created | 0 valid | 0 | 0 | N/A — no valid response received | BLOCKED | BLOCKED | N/A | Safe execution blocked by missing local dependencies |

## Slowest measured probes

Only six safe probes produced benchmark samples; a TOP-20 business-API ranking cannot be calculated without valid dependency-backed traffic. The following is the complete ranking of measured probes.

| Rank | Method | Endpoint | Avg | P95 | P99 | Possible bottleneck |
|---:|---|---|---:|---:|---:|---|
| 1 | GET | `/openapi/storefront.json` | 4.50 ms | 4.91 ms | 5.01 ms | OpenAPI document serialization/payload size |
| 2 | GET | `/docs/admin/` | 1.94 ms | 2.91 ms | 3.21 ms | Static HTML/Express response path |
| 3 | GET | `/docs/` | 1.53 ms | 2.37 ms | 2.88 ms | Static HTML/Express response path |
| 4 | GET | `/openapi/admin.json` | 1.53 ms | 1.89 ms | 1.96 ms | OpenAPI document serialization/payload size |
| 5 | GET | `/docs/storefront/` | 1.53 ms | 1.84 ms | 1.90 ms | Static HTML/Express response path |
| 6 | GET | `/healthz` | 1.47 ms | 2.00 ms | 2.24 ms | Static HTML/Express response path |

## Fastest measured probes

| Rank | Method | Endpoint | Avg | P95 | P99 |
|---:|---|---|---:|---:|---:|
| 1 | GET | `/healthz` | 1.47 ms | 2.00 ms | 2.24 ms |
| 2 | GET | `/docs/storefront/` | 1.53 ms | 1.84 ms | 1.90 ms |
| 3 | GET | `/openapi/admin.json` | 1.53 ms | 1.89 ms | 1.96 ms |
| 4 | GET | `/docs/` | 1.53 ms | 2.37 ms | 2.88 ms |
| 5 | GET | `/docs/admin/` | 1.94 ms | 2.91 ms | 3.21 ms |
| 6 | GET | `/openapi/storefront.json` | 4.50 ms | 4.91 ms | 5.01 ms |

## Error report

| Class | Endpoint(s) | Observed result | Classification |
|---|---|---|---|
| 4xx | `/openapi/admin.json`, `/docs/admin/` | HTTP 401 on all 10 requests | Expected authentication guard; not a code failure. |
| 5xx | None in measured safe probes | 0 observed | No 5xx conclusion for blocked business APIs. |
| Timeout | `/readyz` | No response within the safe 3-second probe timeout while PG/Redis were unavailable | Environment/dependency blocked. |
| Validation/auth | Not benchmarked as valid business traffic | No valid authenticated test identity or test database available | Blocked, not PASS. |
| Database/external | All dependency-backed operations | Not reached safely | Environment/external-service blocked. |

## Performance summary

| Metric | Result |
|---|---|
| Total APIs | 282 |
| Complete performance-tested operations | 1 |
| Successful complete benchmark | 1 (`/healthz`) |
| Failed code benchmark | 0 established |
| Blocked | 281 |
| Not tested/unaccounted | 0 — every operation appears in the matrix; blocked is explicit |
| Average across complete valid API set | N/A — only 1/282 had a valid benchmark |
| Measured `/healthz` average | 1.47 ms |
| Measured `/healthz` P50/P95/P99 | 1.36 ms / 2.00 ms / 2.24 ms |
| Fastest measured probe | See fastest-probe table; no business API ranking is claimed. |
| Slowest measured probe | `/openapi/storefront.json` at 4.50 ms average |
| 5xx rate | 0% among measured safe HTTP probes; business API rate unavailable |
| 4xx rate | Expected 401 only for protected documentation probes; business API rate unavailable |
| Timeout rate | `/readyz` dependency probe timed out; complete business API rate unavailable |

## Performance classification

| Class | Count among complete registered-operation benchmarks |
|---|---:|
| Excellent (<200ms) | 1 (`/healthz`) |
| Good (200–500ms) | 0 |
| Acceptable (500ms–1s) | 0 |
| Slow (1–2s) | 0 |
| Critical (>2s) | 0 |
| Unclassified because blocked | 281 |

## Database, Redis, authentication, and file impact

- **Database impact:** unavailable. No valid DB-backed latency sample exists; query, join, transaction, index, and N+1 conclusions cannot be made from this run.
- **Redis/cache impact:** unavailable. No cache-hit/cache-miss comparison was safe or possible.
- **Authentication overhead:** no valid customer or staff token was available. Protected business APIs were not timed with guards bypassed.
- **File uploads:** not executed. The existing media routes require storage and database dependencies; no upload timing or generated URL was claimed.
- **External services:** Firebase, Razorpay, S3/MinIO, email, courier, and queue processing were not invoked.

## Optimization report

No business-API optimization recommendation is supported by measured latency in this run. The only evidence-backed observations are:

1. `GET /openapi/storefront.json` returned approximately 389.75 KB and averaged 4.50 ms in the local process. Consider HTTP compression and cache headers for documentation payloads if documentation traffic matters; this is not a business API bottleneck.
2. `/healthz` remained below 20 ms P99 under 25 concurrent local requests. This does not predict database-backed concurrency behavior.
3. `/readyz` can stall when dependencies are absent. Readiness health checks should have bounded dependency timeouts and should be monitored separately from user-facing latency; no API contract was changed for this observation.

Existing static-risk items from the prior audit — payment/cart races, warehouse scope checks, staff-session atomicity, media hardening, missing worker, lint, and dependency vulnerabilities — require a safe integration environment before performance attribution or remediation.

## API creation and data-safety confirmation

- NEW API CREATED: **NO**
- NEW ENDPOINT CREATED: **NO**
- V2 API CREATED: **NO**
- DUPLICATE API CREATED: **NO**
- TEST/MOCK ROUTE CREATED: **NO**
- DATABASE TABLE CREATED: **NO**
- DATABASE RECORDS CREATED/UPDATED/DELETED: **0 / 0 / 0**
- NEW STORAGE SYSTEM CREATED: **NO**
- NEW AUTH SYSTEM CREATED: **NO**

## Final status

**PARTIAL PASS — infrastructure-limited.**

This report intentionally does **not** say “ALL 282 APIs PERFORMANCE TESTED,” because only one registered operation had a valid dependency-independent benchmark. The remaining 281 operations are individually accounted for as BLOCKED and require an isolated PostgreSQL/Redis/storage/integration environment before real performance claims can be made.
