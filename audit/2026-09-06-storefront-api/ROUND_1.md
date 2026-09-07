# Round 1 — 2026-09-06 Storefront API Audit

## Failures from Task A (Data Round-Trip)

| # | Step | Status | Root Cause | Fixable Here? |
|---|---|---|---|---|
| A16 | Search API (`/v1/search?q=orange`) | ❌ 500 | `pg_trgm` extension not installed in local Postgres | Yes — `CREATE EXTENSION pg_trgm` |

All other Task A steps (A1–A15, A17–A20) passed.

## Failures from Task B (Golden Path)

| # | Step | Status | Root Cause | Fixable Here? |
|---|---|---|---|---|
| B8 | Place COD order (`POST /v1/orders`) | ❌ 422 `destination_not_serviceable` | Delivery zone has 0 pincodes assigned | Yes — seed pincodes into delivery zone |

All prior steps (B1–B7: add-to-cart, signup, merge, address, quote) passed.

## Fixes Applied

### Fix 1: pg_trgm Extension

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Status: **PENDING** — requires DB superuser access or docker exec.

### Fix 2: Delivery Zone Pincodes

Need to assign test pincodes (e.g., 400053) to the existing `ZZTEST Zone` delivery zone.

Status: **PENDING** — requires Admin API call or direct DB insert.

## Next Steps

1. Apply Fix 1 and Fix 2
2. Re-run `audit_runner.js`
3. If B8 passes, verify B9–B11 (order in account, order detail, track order)
4. Generate ROUND_2.md with results
