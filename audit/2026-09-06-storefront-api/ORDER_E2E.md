# Golden Path E2E — 2026-09-06

## Method
Executed a complete checkout flow using the storefront API (`http://localhost:4000`) with real Postgres + Redis.  
Endpoints verified from source code route files before each call.

## Flow

| # | Step | Endpoint | Result | Detail |
|---|---|---|---|---|
| B1 | Add to cart (guest) | `POST /v1/cart/lines` | ✅ PASS | variantId=ee53e3d7, qty=1, cartToken received |
| B2 | View cart | `GET /v1/cart` (X-Cart-Token) | ✅ PASS | 1 line, total=₹2,229.00 |
| B3 | Signup | `POST /v1/auth/signup` (with cartToken) | ✅ PASS | customerId created, accessToken received |
| B4 | Merge cart | `POST /v1/cart/merge` | ✅ PASS | Guest cart bound to account, 1 line |
| B5 | Verify merged cart | `GET /v1/cart` | ✅ PASS | 1 line, total=₹2,229.00 |
| B6 | Create address | `POST /v1/account/addresses` | ✅ PASS | addressId received, pincode 400053 |
| B7 | Checkout quote | `POST /v1/checkout/quote` (COD) | ✅ PASS | Total computed, COD eligibility checked |
| B8 | Place COD order | `POST /v1/orders` (Idempotency-Key) | ❌ BLOCKED | `destination_not_serviceable` |

## B8 Failure Analysis

The order placement step failed with:
```json
{
  "status": 422,
  "code": "destination_not_serviceable",
  "detail": "We do not deliver to this PIN code yet."
}
```

**Root Cause**: The `delivery_zones` table has a single zone (`ZZTEST Zone`) with **zero pincodes** assigned. No PIN code in India is serviceable. This is a **data issue**, not a code bug.

**Quote succeeded** (B7) because quoting is side-effect-free and computes totals even for unserviceable destinations. Order placement correctly refuses.

## Verification Steps Not Reached (due to B8)

| # | Step | Endpoint | Result |
|---|---|---|---|
| B9 | Order in account | `GET /v1/account/orders` | ⏭ SKIPPED |
| B10 | Order detail | `GET /v1/account/orders/:id` | ⏭ SKIPPED |
| B11 | Track order | `GET /v1/orders/track` | ⏭ SKIPPED |

## Summary

**7/8 steps PASS** — Order placement is BLOCKED by missing delivery zone pincode configuration, not by a code defect.

To unblock: assign at least one pincode to the `ZZTEST Zone` delivery zone via `POST /v1/admin/delivery-zones/{id}/pincodes` or direct DB insert.
