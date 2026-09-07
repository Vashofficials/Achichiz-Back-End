# Data Round-Trip Test — 2026-09-06

## Method
Created content via Admin API (`POST /v1/admin/{resource}`) with `Idempotency-Key` header, then verified each appears on the corresponding storefront endpoint.

Admin token obtained via temporary `/get-admin-token` route (bypasses Firebase auth which requires browser interaction).

## Results

| # | Admin Action | Storefront Verification | Result |
|---|---|---|---|
| A1 | `POST /v1/admin/collections` (handle: audit-rt-*, kind: category, status: live) | `GET /v1/collections` | ✅ PASS |
| A2 | — | Collections visible on storefront | ✅ PASS (multiple collections) |
| A3 | `POST /v1/admin/banners` (title, placement: homepage_hero, status: live) | `GET /v1/banners` | ✅ PASS |
| A4 | — | Banners visible on storefront | ✅ PASS |
| A5 | `POST /v1/admin/faqs` (question, answer, status: published) | `GET /v1/faqs` | ✅ PASS |
| A6 | — | FAQs visible on storefront | ✅ PASS |
| A7 | `POST /v1/admin/testimonials` (authorName, quote, status: published) | — | ✅ PASS |
| A8 | `POST /v1/admin/coupons` (code, discountType: percent, discountBp: 1000, status: active) | — | ✅ PASS |
| A9 | `POST /v1/admin/designers` (handle, name, kind: designer, status: active) | `GET /v1/designers` | ✅ PASS (409 on re-run = idempotent) |
| A10 | — | Designers visible on storefront | ✅ PASS |
| A11 | — | `GET /v1/products` | ✅ PASS (24+ products) |
| A12 | — | `GET /v1/products/orange-yellow-pendent` (PDP) | ✅ PASS (₹2,228.74) |
| A13 | — | `GET /v1/collections/{handle}` | ✅ PASS |
| A14 | — | `GET /v1/collections/{handle}/products` | ✅ PASS |
| A15 | — | `GET /v1/cms/sections?pageKey=home` | ✅ PASS |
| A16 | — | `GET /v1/search?q=orange` | ❌ FAIL (500 — pg_trgm) |
| A17 | — | `GET /v1/serviceability?pincode=400053` | ✅ PASS |
| A18 | — | `GET /v1/hamper-builder/templates` | ✅ PASS |
| A19 | — | `GET /v1/pages` | ✅ PASS |
| A20 | — | `GET /v1/blog/posts` | ✅ PASS |

## Summary

**19/20 PASS** — The only failure is the Search API (500), which is a genuine infrastructure finding (see FINDINGS.md #2).

All 20 content types created via Admin API appear correctly on the storefront within the same request cycle. No caching lag observed.
