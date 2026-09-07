# Findings — 2026-09-06 Storefront API Audit

## #1 — P0: No Delivery Zone Pincodes Configured

**Severity**: P0 (order placement completely blocked)  
**Endpoint**: `POST /v1/orders`  
**Error**: `422 destination_not_serviceable — We do not deliver to this PIN code yet.`

The `delivery_zones` table contains one zone (`ZZTEST Zone`) with **zero pincodes** assigned.  
No PIN code in India resolves to a serviceable destination. The checkout quote step (B7) succeeds because quoting is side-effect-free, but the order placement step (B8) correctly refuses.

**Impact**: No customer can place an order through the storefront.  
**Fix**: Assign pincodes to delivery zones via Admin Panel or Admin API.

---

## #2 — P1: Search API 500 (pg_trgm Extension)

**Severity**: P1  
**Endpoint**: `GET /v1/search?q=orange`  
**Error**: `500 Internal Server Error`

The search query uses `similarity()` and the `%` operator from PostgreSQL's `pg_trgm` extension. The extension is not installed or not loaded in the current database.

**Stack trace** (from evidence):
```
Failed query: select "id" from "products" where ...
  (..."products"."title" || ' ' || coalesce("products"."subtitle", '')) % $2)
```

**Impact**: Full-text search is completely non-functional.  
**Fix**: `CREATE EXTENSION IF NOT EXISTS pg_trgm;` on the database, then restart.

---

## #3 — P2: Product HSN Code Validation Requires Existing Record

**Severity**: P2  
**Endpoint**: `POST /v1/admin/products`  
**Error**: `422 — hsnCode: not_found — That hsnCode does not refer to an existing record.`

Creating a product with an arbitrary HSN code fails because the `hsn_codes` table enforces a foreign key. Valid HSN codes (e.g., `4419`) must be pre-seeded.

**Impact**: Products cannot be created without knowing a valid HSN code from the existing `hsn_codes` table.  
**Workaround**: Query `GET /get-hsn` or check existing products for valid HSN codes.

---

## #4 — Info: Cart Token Flow Requires Explicit Management

**Severity**: Info  
**Observation**: `GET /v1/cart` returns an empty cart when called with only a Bearer token — the cart is identified by `X-Cart-Token` header or `cartToken` query parameter, NOT by the authenticated user's session alone.

After signup, the guest cart token must be explicitly merged via `POST /v1/cart/merge` and the new token from the merge response must be used for all subsequent calls.

**Impact**: Frontend must implement explicit cart token management (localStorage) and call merge on login/signup.

---

## #5 — Info: Admin Auth Requires Firebase

**Severity**: Info  
**Observation**: `POST /v1/admin/auth/login` verifies credentials against Firebase Auth (`signInWithPassword`), not just the local `staff_users.password_hash`. A staff user inserted directly into the database with a valid argon2 hash will still fail login if the corresponding Firebase user doesn't exist.

**Impact**: Admin panel testing requires either a real Firebase user or a bypass route.
