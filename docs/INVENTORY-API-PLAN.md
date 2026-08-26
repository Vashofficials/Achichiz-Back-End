# Achichiz — Inventory Management API Plan

Derived from the 100-point spec, **mapped against the existing 118-table schema**.
Nothing here duplicates an existing table or endpoint.

**Legend**
`EXISTS` — already live, do not rebuild · `BUILD` — to be written · `EXTEND` — existing table needs a column

**Permissions** use the existing RBAC matrix (12 modules × 9 actions), not the spec's dot-notation.
`inventory:view` · `inventory:create` · `inventory:edit` · `inventory:delete` · `inventory:export` · `inventory:approve`

**Conventions inherited from the existing API** — `{data}` / `{data, meta}` envelope, RFC 9457
`application/problem+json` errors with a stable `code`, `page`/`perPage` (max 100), money in
integer paise, `Idempotency-Key` on stock-changing POSTs.

---

## 0. Schema gap — 6 tables to create

| Table | Why | Spec |
|---|---|---|
| `warehouse_locations` | Zone → Rack → Shelf → Bin hierarchy | §18 |
| `supplier_products` | Supplier SKU, cost, MOQ, lead time, preferred flag | §22 |
| `purchase_returns` + `_lines` | Return stock to supplier | §27 |
| `stock_counts` + `_items` | Physical count → variance → adjustment | §39–40 |
| `production_orders` + `_lines` | BOM consumption → finished stock | §46 |
| `barcode_registry` | Only if you need more than `product_variants.barcode` | §41 |

**EXTEND** — `product_bom_lines` needs `waste_pct` (§93) and `version` (§45).
`inventory_levels` already has `available_qty` as a **generated column**, so §63 is enforced by the database.

---

## 1. Inventory core — `/v1/admin/inventory`

| Method | Path | Permission | Status | Tables |
|---|---|---|---|---|
| GET | `/v1/admin/inventory/dashboard` | `inventory:view` | BUILD | inventory_levels, purchase_orders |
| GET | `/v1/admin/inventory` | `inventory:view` | BUILD | inventory_levels + variants |
| GET | `/v1/admin/inventory/:sku` | `inventory:view` | BUILD | inventory_levels, stock_movements |
| GET | `/v1/admin/inventory/:sku/availability` | `inventory:view` | BUILD | inventory_levels |
| GET | `/v1/admin/inventory/movements` | `inventory:view` | BUILD | stock_movements |
| GET | `/v1/admin/inventory/movements/:movementId` | `inventory:view` | BUILD | stock_movements |
| POST | `/v1/admin/inventory/adjustments` | `inventory:edit` | BUILD | inventory_levels, stock_movements, activity_logs |
| POST | `/v1/admin/inventory/bulk-adjust` | `inventory:edit` | BUILD | same, batched |
| GET | `/v1/admin/inventory/alerts/low-stock` | `inventory:view` | BUILD | inventory_levels |
| GET | `/v1/admin/inventory/alerts/out-of-stock` | `inventory:view` | BUILD | inventory_levels |
| GET | `/v1/admin/inventory/reorder` | `inventory:view` | BUILD | inventory_levels, supplier_products |
| POST | `/v1/admin/inventory/reorder/purchase-draft` | `inventory:create` | BUILD | purchase_orders (DRAFT) |
| GET | `/v1/admin/inventory/audit` | `inventory:view` | BUILD | activity_logs |
| GET | `/v1/admin/inventory/notifications` | `inventory:view` | BUILD | notifications |
| GET | `/v1/admin/inventory/export` | `inventory:export` | BUILD | inventory_levels |

**Reservations** (§12–14) — the tables and the checkout path already exist; these expose them:

| Method | Path | Permission | Status |
|---|---|---|---|
| GET | `/v1/admin/inventory/reservations` | `inventory:view` | BUILD |
| POST | `/v1/admin/inventory/reservations` | `inventory:edit` | BUILD |
| POST | `/v1/admin/inventory/reservations/:id/release` | `inventory:edit` | BUILD |

> `inventory_reservations` already carries typed reasons — `cart` · `order` · `manual_hold` · `quotation`.

---

## 2. Warehouses — `/v1/admin/warehouses`

| Method | Path | Permission | Status |
|---|---|---|---|
| GET · POST | `/v1/admin/warehouses` | view / create | **EXISTS** |
| GET | `/v1/admin/warehouses/schema` | view | **EXISTS** |
| POST | `/v1/admin/warehouses/bulk` | edit | **EXISTS** |
| GET · PATCH · DELETE | `/v1/admin/warehouses/:id` | view / edit / delete | **EXISTS** |
| GET | `/v1/admin/warehouses/:id/inventory` | `inventory:view` | BUILD |
| GET · POST | `/v1/admin/warehouses/:id/locations` | view / create | BUILD |
| GET · PATCH | `/v1/admin/warehouses/:id/locations/:locId` | view / edit | BUILD |
| POST | `/v1/admin/warehouses/:id/locations/:locId/archive` | `inventory:delete` | BUILD |

> The 7 warehouse CRUD endpoints come free from the generic resource engine. **Do not rewrite them.**
> §17 says never hard-delete a warehouse with history — the engine already soft-deletes.

---

## 3. Transfers — `/v1/admin/transfers`

| Method | Path | Permission | Status |
|---|---|---|---|
| GET · POST | `/v1/admin/transfers` | view / create | BUILD |
| GET | `/v1/admin/transfers/:id` | `inventory:view` | BUILD |
| POST | `/v1/admin/transfers/:id/approve` | `inventory:approve` | BUILD |
| POST | `/v1/admin/transfers/:id/dispatch` | `inventory:edit` | BUILD |
| POST | `/v1/admin/transfers/:id/receive` | `inventory:edit` | BUILD |
| POST | `/v1/admin/transfers/:id/cancel` | `inventory:edit` | BUILD |

Lifecycle `DRAFT → APPROVED → DISPATCHED → IN_TRANSIT → RECEIVED → COMPLETED`.
Tables `stock_transfers` + `stock_transfer_lines` already exist.

---

## 4. Suppliers — `/v1/admin/suppliers`

| Method | Path | Permission | Status |
|---|---|---|---|
| GET · POST · PATCH · DELETE + schema + bulk | `/v1/admin/suppliers…` | — | **EXISTS** (7 endpoints) |
| GET · POST | `/v1/admin/suppliers/:id/products` | view / create | BUILD |
| PATCH | `/v1/admin/suppliers/:id/products/:spId` | `inventory:edit` | BUILD |

---

## 5. Purchasing — `/v1/admin/purchasing`

| Method | Path | Permission | Status |
|---|---|---|---|
| GET · POST | `/purchase-orders` | view / create | BUILD |
| GET · PATCH | `/purchase-orders/:poId` | view / edit | BUILD |
| POST | `/purchase-orders/:poId/approve` | `inventory:approve` | BUILD |
| POST | `/purchase-orders/:poId/send` | `inventory:edit` | BUILD |
| POST | `/purchase-orders/:poId/cancel` | `inventory:edit` | BUILD |
| GET · POST | `/goods-receipts` | view / create | BUILD |
| GET | `/goods-receipts/:grnId` | `inventory:view` | BUILD |
| GET · POST | `/purchase-returns` | view / create | BUILD |
| GET | `/purchase-returns/:id` | `inventory:view` | BUILD |
| POST | `/purchase-returns/:id/approve` | `inventory:approve` | BUILD |
| POST | `/purchase-returns/:id/dispatch` | `inventory:edit` | BUILD |

> **PO and GRN cannot use the generic resource engine.** They are parent+lines documents with a
> receive workflow and stock side-effects — bespoke, like `admin-orders`.

---

## 6. Stock counts — `/v1/admin/stock-counts`

| Method | Path | Permission | Status |
|---|---|---|---|
| GET · POST | `/v1/admin/stock-counts` | view / create | BUILD |
| GET | `/v1/admin/stock-counts/:id` | `inventory:view` | BUILD |
| POST | `/v1/admin/stock-counts/:id/start` | `inventory:edit` | BUILD |
| POST | `/v1/admin/stock-counts/:id/items` | `inventory:edit` | BUILD |
| POST | `/v1/admin/stock-counts/:id/complete` | `inventory:edit` | BUILD |
| POST | `/v1/admin/stock-counts/:id/approve` | `inventory:approve` | BUILD |

> §40 — a count never overwrites system stock. It computes variance, and **approval** creates an
> adjustment movement. That is what makes the ledger trustworthy.

---

## 7. BOM & production

| Method | Path | Permission | Status |
|---|---|---|---|
| GET · POST | `/v1/admin/boms` | view / create | BUILD (table EXTEND) |
| GET · PATCH | `/v1/admin/boms/:bomId` | view / edit | BUILD |
| POST | `/v1/admin/boms/:bomId/archive` | `inventory:delete` | BUILD |
| GET · POST | `/v1/admin/production/orders` | view / create | BUILD |
| GET | `/v1/admin/production/orders/:id` | `inventory:view` | BUILD |
| POST | `/v1/admin/production/orders/:id/start` | `inventory:edit` | BUILD |
| POST | `/v1/admin/production/orders/:id/complete` | `inventory:edit` | BUILD |
| POST | `/v1/admin/production/orders/:id/cancel` | `inventory:edit` | BUILD |

---

## 8. Bundles — `/v1/admin/bundles`

| Method | Path | Permission | Status |
|---|---|---|---|
| GET · POST · PATCH · archive | `/v1/admin/bundles…` | view / create / edit | BUILD |
| GET | `/v1/admin/bundles/:id/availability` | `inventory:view` | BUILD |

> Tables `bundles` + `bundle_items` already exist under promotions.
> §91 — bundle stock is **computed from components**, never stored independently.

---

## 9. Corporate bulk orders — `/v1/admin/bulk-orders`

| Method | Path | Permission | Status |
|---|---|---|---|
| GET · POST · PATCH | `/v1/admin/bulk-orders…` | `corporate:*` | BUILD |
| POST | `/:id/inventory-check` | `inventory:view` | BUILD |
| POST | `/:id/reserve` | `inventory:edit` | BUILD |
| POST | `/:id/release` | `inventory:edit` | BUILD |
| POST | `/:id/procurement-plan` | `inventory:view` | BUILD |
| GET | `/:id/fulfillment-plan` | `inventory:view` | BUILD |

> Maps onto existing `corporate_campaigns`, `campaign_recipients`, `quotations`, `approvals`.
> Multi-address allocation (§88) must sum exactly to the reserved total.

---

## 10. Reports — `/v1/admin/reports`

| Method | Path | Permission | Status |
|---|---|---|---|
| GET | `/inventory-aging` | `inventory:view` | BUILD |
| GET | `/dead-stock` | `inventory:view` | BUILD |
| GET | `/inventory-valuation` | `inventory:view` | BUILD |
| GET | `/stock-movements` | `inventory:view` | BUILD |
| GET | `/product-performance` | `inventory:view` | BUILD |
| GET | `/supplier-performance` | `inventory:view` | BUILD |
| GET | `/inventory-health` | `inventory:view` | BUILD |
| GET | `/stock-velocity` | `inventory:view` | BUILD |
| GET | `/purchase-forecast` | `inventory:view` | BUILD |
| GET | `/{report}/export` | `inventory:export` | BUILD |

> §74 — when history is insufficient, return `INSUFFICIENT_DATA`. Do not invent a forecast.
> Reports connect through the read-only pool (`DATABASE_READONLY_URL`).

---

## 11. Barcode / QR

| Method | Path | Permission | Status |
|---|---|---|---|
| GET | `/v1/admin/barcodes/:sku` | `inventory:view` | BUILD |
| POST | `/v1/admin/barcodes/generate` | `inventory:edit` | BUILD |
| POST | `/v1/admin/barcodes/bulk-generate` | `inventory:edit` | BUILD |
| POST | `/v1/admin/barcodes/scan` | `inventory:edit` | BUILD |
| GET · POST | `/v1/admin/qr/…` | view / edit | BUILD |

> `product_variants.barcode` already exists — a registry table is only needed for multiple
> barcodes per SKU or scan history.

---

## 12. Product inventory settings

| Method | Path | Permission | Status |
|---|---|---|---|
| GET · PATCH | `/v1/admin/products/:id/inventory-settings` | view / edit | BUILD |
| GET | `/v1/admin/products/:id/inventory` | `inventory:view` | BUILD |
| POST | `/v1/admin/products/import/preview` | `catalogue:create` | BUILD |
| POST | `/v1/admin/products/import/confirm` | `catalogue:create` | BUILD |

> `reorder_point` and `reorder_qty` are already columns on `inventory_levels`.

---

## 13. Integration — modify, never duplicate

| Existing endpoint | Change |
|---|---|
| `GET /v1/products/:handle/variants` | Read availability from the inventory service. Expose only `in`/`low`/`out` (§16) |
| `POST /v1/cart/lines` · `PATCH /v1/cart/lines/:id` | Validate availability; do **not** reserve on add-to-cart |
| `POST /v1/checkout/quote` · order creation | Final availability check, then reserve inside the order transaction |
| `POST /v1/webhooks/razorpay` | Already idempotent. **Do not create a second webhook** (§60) |
| `POST /v1/admin/orders/:id/cancel` | Release reservation |
| returns / exchanges | Subscribe to completion → QC → `AVAILABLE` or `DAMAGED` (§87) |

---

## Totals

| | Endpoints |
|---|---|
| Already live (warehouses + suppliers via the generic engine) | **14** |
| To build | **~92** |
| Existing endpoints to modify | 6 |

## Build order (spec §99)

| Phase | Scope | Endpoints |
|---|---|---|
| **1** | Inventory core: list, SKU detail, movements, adjustments, dashboard, alerts | 15 |
| **2** | Locations, transfers, supplier products, PO, GRN, purchase returns | 24 |
| **3** | Reservations, order/cart/checkout integration, returns, bundle availability | 12 |
| **4** | BOM, production, raw materials | 11 |
| **5** | Corporate bulk orders, procurement + fulfilment planning | 9 |
| **6** | Stock counts, barcode, QR, scanning | 12 |
| **7** | Reports, aging, dead stock, valuation, velocity, forecasting | 10 |

## Non-negotiables carried from the spec

- **§62 concurrency** — conditional `UPDATE … WHERE on_hand - reserved >= qty`, deterministic lock
  ordering. Race-free at READ COMMITTED. `available_qty` is generated, so it cannot drift.
- **§80 transactions** — adjustments, reservations, GRN, transfers, production completion, stock-count
  approval, bulk reservation are all-or-nothing.
- **§10 immutable ledger** — never update a movement. Corrections are reversing movements.
- **§61 idempotency** — reuses the existing `Idempotency-Key` middleware.
- **§64** — negative sellable stock returns `INSUFFICIENT_STOCK`, never silently allowed.
- **§81** — PostgreSQL is the source of truth; Redis caches availability and is invalidated after commit.
- **§96 soft delete** — nothing with movement history is ever hard-deleted.
