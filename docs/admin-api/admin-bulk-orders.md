# Admin bulk orders

9 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/bulk-orders`](#get-v1-admin-bulk-orders) — List corporate bulk orders
- [`POST /v1/admin/bulk-orders`](#post-v1-admin-bulk-orders) — Create a corporate bulk order
- [`GET /v1/admin/bulk-orders/:bulkOrderId`](#get-v1-admin-bulk-orders-bulkorderid) — Get a corporate bulk order
- [`PATCH /v1/admin/bulk-orders/:bulkOrderId`](#patch-v1-admin-bulk-orders-bulkorderid) — Update a corporate bulk order
- [`POST /v1/admin/bulk-orders/:bulkOrderId/inventory-check`](#post-v1-admin-bulk-orders-bulkorderid-inventory-check) — Check whether a bulk order can be covered
- [`POST /v1/admin/bulk-orders/:bulkOrderId/reserve`](#post-v1-admin-bulk-orders-bulkorderid-reserve) — Hold stock for a bulk order
- [`POST /v1/admin/bulk-orders/:bulkOrderId/release`](#post-v1-admin-bulk-orders-bulkorderid-release) — Release a bulk order’s held stock
- [`POST /v1/admin/bulk-orders/:bulkOrderId/procurement-plan`](#post-v1-admin-bulk-orders-bulkorderid-procurement-plan) — What to buy to cover a bulk order
- [`GET /v1/admin/bulk-orders/:bulkOrderId/fulfillment-plan`](#get-v1-admin-bulk-orders-bulkorderid-fulfillment-plan) — How a bulk order dispatches

---

### `GET /v1/admin/bulk-orders`

**List corporate bulk orders**

| | |
|---|---|
| operationId | `adminListBulkOrders` |
| Auth | Bearer staff token |
| Permission | `corporate:view` |

Filter by status, account or owner. `reservedUnits` is derived from live reservations, never stored.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `createdAt` (default, descending), `campaignNo`, `name`, `status`, `windowStartOn`, `budgetPaise`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `status` | `string` | no | max 200 | One status or a comma-separated list: `planning`, `recipients_pending`, `in_dispatch`, `completed`, `cancelled`. |
| `accountId` | `uuid` | no | — | Restrict to one corporate account. |
| `ownerId` | `uuid` | no | — | Restrict to one staff owner. |

Example: `/v1/admin/bulk-orders?page=…&perPage=…`

**Response `200`** — A page of bulk orders.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "campaignNo": "PRD-2026-00001",
      "accountId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "accountName": "Brass Diya Set",
      "quotationId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "quotationNo": "PRD-2026-00001",
      "name": "Brass Diya Set",
      "status": "planning",
      "budgetPaise": 149900,
      "windowStartOn": "2026-11-01",
      "windowEndOn": "2026-11-01",
      "ownerId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "recipientCount": 3,
      "assignedRecipientCount": 3,
      "dispatchedRecipientCount": 3,
      "reservedUnits": 1,
      "createdAt": "2026-08-25T10:30:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 25,
    "total": 1,
    "totalPages": 1
  }
}
```

---

### `POST /v1/admin/bulk-orders`

**Create a corporate bulk order**

| | |
|---|---|
| operationId | `adminCreateBulkOrder` |
| Auth | Bearer staff token |
| Permission | `corporate:create` |

Takes its number from the same row-locked series every other document uses. A source quotation must belong to the same account — a campaign pointing at another company’s quotation would put one client’s pricing on another client’s dispatch.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `accountId` | `uuid` | **yes** | — | The corporate account this campaign belongs to. Required — a bulk order without a buyer is not one. |
| `quotationId` | `uuid` | no | — | The quotation this campaign was won from, if any. Must belong to the same account. |
| `name` | `string` | **yes** | min 1, max 200 | What the client calls it — “Diwali 2026”. |
| `budgetPaise` | `integer` | no | default `0`, ≥ 0 | Approved spend, integer paise. Informational: nothing here refuses to exceed it. |
| `windowStartOn` | `string` | no | — | First dispatch date. Procurement lead times are measured back from this. |
| `windowEndOn` | `string` | no | — | Last dispatch date. `CHECK campaign_window` refuses an end before the start. |
| `ownerId` | `uuid` | no | — | Staff owner. Defaults to the caller. |

Example request:

```json
{
  "accountId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "quotationId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "name": "Brass Diya Set",
  "budgetPaise": 0,
  "windowStartOn": "2026-11-01",
  "windowEndOn": "2026-11-01",
  "ownerId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
}
```

**Response `201`** — The bulk order, with demand aggregated from its recipients.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "campaignNo": "PRD-2026-00001",
    "accountId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "accountName": "Brass Diya Set",
    "quotationId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "quotationNo": "PRD-2026-00001",
    "name": "Brass Diya Set",
    "status": "planning",
    "budgetPaise": 149900,
    "windowStartOn": "2026-11-01",
    "windowEndOn": "2026-11-01",
    "ownerId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "recipientCount": 3,
    "assignedRecipientCount": 3,
    "dispatchedRecipientCount": 3,
    "reservedUnits": 1,
    "createdAt": "2026-08-25T10:30:00.000Z",
    "totalRequiredQty": 10,
    "unassignedRecipientCount": 3,
    "demand": [
      {
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "requiredQty": 10,
        "recipientCount": 3
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | Account or quotation not found. |
| `422` | Quotation belongs to another account, or the window ends before it starts. |

---

### `GET /v1/admin/bulk-orders/:bulkOrderId`

**Get a corporate bulk order**

| | |
|---|---|
| operationId | `adminGetBulkOrder` |
| Auth | Bearer staff token |
| Permission | `corporate:view` |

The campaign plus its demand — one line per distinct gift, aggregated from the recipient list.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bulkOrderId` | `uuid` | **yes** | — | Corporate campaign id. |

**Response `200`** — The bulk order.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "campaignNo": "PRD-2026-00001",
    "accountId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "accountName": "Brass Diya Set",
    "quotationId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "quotationNo": "PRD-2026-00001",
    "name": "Brass Diya Set",
    "status": "planning",
    "budgetPaise": 149900,
    "windowStartOn": "2026-11-01",
    "windowEndOn": "2026-11-01",
    "ownerId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "recipientCount": 3,
    "assignedRecipientCount": 3,
    "dispatchedRecipientCount": 3,
    "reservedUnits": 1,
    "createdAt": "2026-08-25T10:30:00.000Z",
    "totalRequiredQty": 10,
    "unassignedRecipientCount": 3,
    "demand": [
      {
        "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "requiredQty": 10,
        "recipientCount": 3
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bulk order. |

---

### `PATCH /v1/admin/bulk-orders/:bulkOrderId`

**Update a corporate bulk order**

| | |
|---|---|
| operationId | `adminUpdateBulkOrder` |
| Auth | Bearer staff token |
| Permission | `corporate:edit` |

Moving to `cancelled` does NOT release held stock. Call POST /release first, or the units stay reserved against a campaign nobody is running — invisible everywhere except a stockout three weeks later.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bulkOrderId` | `uuid` | **yes** | — | Corporate campaign id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `name` | `string` | no | min 1, max 200 | — |
| `budgetPaise` | `integer` | no | ≥ 0 | — |
| `windowStartOn` | `string` | no | — | — |
| `windowEndOn` | `string` | no | — | — |
| `ownerId` | `uuid` | no | — | — |
| `status` | `"planning" \| "recipients_pending" \| "in_dispatch" \| "completed" \| "cancelled"` | no | — | Moving to `cancelled` does NOT release held stock — call POST /release first, or the units stay reserved against a campaign nobody is running. |

Example request:

```json
{
  "name": "Brass Diya Set",
  "budgetPaise": 149900,
  "windowStartOn": "2026-11-01",
  "windowEndOn": "2026-11-01",
  "ownerId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "status": "planning"
}
```

**Response `200`** — The bulk order after the change.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "campaignNo": "PRD-2026-00001",
    "accountId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "accountName": "Brass Diya Set",
    "quotationId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "quotationNo": "PRD-2026-00001",
    "name": "Brass Diya Set",
    "status": "planning",
    "budgetPaise": 149900,
    "windowStartOn": "2026-11-01",
    "windowEndOn": "2026-11-01",
    "ownerId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "recipientCount": 3,
    "assignedRecipientCount": 3,
    "dispatchedRecipientCount": 3,
    "reservedUnits": 1,
    "createdAt": "2026-08-25T10:30:00.000Z",
    "totalRequiredQty": 10,
    "unassignedRecipientCount": 3,
    "demand": [
      {
        "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "requiredQty": 10,
        "recipientCount": 3
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bulk order. |
| `422` | The dispatch window ends before it starts. |

---

### `POST /v1/admin/bulk-orders/:bulkOrderId/inventory-check`

**Check whether a bulk order can be covered**

| | |
|---|---|
| operationId | `adminBulkOrderInventoryCheck` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Aggregates the recipient list into per-gift demand, then allocates it across the warehouses that hold each gift — largest stock first, so a campaign draws from as few sites as possible.

**Reserves nothing.** The allocation it returns is a plan against stock that a checkout can take a microsecond later; POST /reserve re-plans under lock, which is what makes the hold honest.

Recipients with no gift assigned are reported in `unassignedRecipientCount` rather than skipped: “we cannot plan for 43 people” is the answer a planner needs.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bulkOrderId` | `uuid` | **yes** | — | Corporate campaign id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | no | — | Check against one warehouse only. Omit to consider every warehouse. |

Example request:

```json
{
  "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
}
```

**Response `200`** — Demand, allocation and shortfall.

```json
{
  "type": "success",
  "result": {
    "bulkOrderId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "recipientCount": 3,
    "unassignedRecipientCount": 3,
    "totalRequiredQty": 10,
    "totalAllocatableQty": 10,
    "totalShortageQty": 10,
    "canFulfil": false,
    "lines": [
      {
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "requiredQty": 10,
        "recipientCount": 3,
        "availableQty": 10,
        "allocatedQty": 10,
        "shortageQty": 10,
        "allocations": [
          {
            "inventoryLevelId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
            "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
            "warehouseName": "Mumbai — Andheri East",
            "quantity": 10
          }
        ]
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bulk order. |

---

### `POST /v1/admin/bulk-orders/:bulkOrderId/reserve`

**Hold stock for a bulk order**

| | |
|---|---|
| operationId | `adminReserveBulkOrderStock` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

ONE transaction. Locks every level in ascending id order, re-plans the allocation under those locks so the numbers cannot move again, then applies the conditional `UPDATE … WHERE on_hand − reserved >= n` per level. Any refusal rolls the whole thing back.

**All-or-nothing by default.** A shortfall on any gift reserves nothing, because a half-reserved campaign hides the gap until dispatch day. Pass `allowPartial: true` to hold what is there — the right call when the rest is already on a purchase order.

A reservation moves `reserved_qty` and nothing else. No `stock_movements` row is written: the ledger tracks physical movement, and a hold in it would double-count when the goods actually ship.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bulkOrderId` | `uuid` | **yes** | — | Corporate campaign id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | no | — | Draw only from this warehouse. Omit to allocate across all of them, largest first. |
| `allowPartial` | `boolean` | no | default `false` | By default a shortfall on ANY variant reserves NOTHING — a half-reserved campaign is worse than an unreserved one, because the shortfall is invisible until dispatch. Set true to hold what is available and accept the gap, which is the right call when the rest is on a PO. |
| `note` | `string` | no | max 2000 | Why this hold was placed. `corporate_campaigns` has no note column, so this is recorded in the ADMIN AUDIT LOG against this operation rather than on the campaign — which is where the reason for a stock hold belongs anyway. |

Example request:

```json
{
  "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "allowPartial": false,
  "note": "Damaged in transit"
}
```

**Response `200`** — What is now held.

```json
{
  "type": "success",
  "result": {
    "bulkOrderId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "reservedUnits": 1,
    "newlyReservedUnits": 1,
    "shortageQty": 10,
    "partial": false,
    "reservationIds": [
      "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e"
    ],
    "lines": [
      {
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "requiredQty": 10,
        "recipientCount": 3,
        "availableQty": 10,
        "allocatedQty": 10,
        "shortageQty": 10,
        "allocations": [
          {
            "inventoryLevelId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
            "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
            "warehouseName": "Mumbai — Andheri East",
            "quantity": 10
          }
        ]
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bulk order. |
| `422` | Campaign closed (`campaign_closed`), no gifts assigned (`no_demand`), or short without `allowPartial` (`insufficient_stock`). Nothing was reserved in any case. |

---

### `POST /v1/admin/bulk-orders/:bulkOrderId/release`

**Release a bulk order’s held stock**

| | |
|---|---|
| operationId | `adminReleaseBulkOrderStock` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Closes every unreleased reservation for the campaign and gives the units back to sellable stock.

Idempotent by construction: `released_at IS NULL` in the UPDATE’s WHERE means a second call closes nothing and decrements nothing. That matters — release is exactly the call somebody retries after a timeout, and a double decrement would push `reserved_qty` below zero and let the next checkout oversell.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bulkOrderId` | `uuid` | **yes** | — | Corporate campaign id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `reason` | `string` | no | max 2000 | Why the hold was given up. Recorded in the admin audit log, not on the campaign. |

Example request:

```json
{
  "reason": "Damaged in transit"
}
```

**Response `200`** — What was released.

```json
{
  "type": "success",
  "result": {
    "bulkOrderId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "releasedUnits": 1,
    "releasedReservationCount": 3,
    "remainingReservedUnits": 1
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bulk order. |
| `422` | `reserved_qty` is lower than the reservation claims (`reservation_inconsistent`). |

---

### `POST /v1/admin/bulk-orders/:bulkOrderId/procurement-plan`

**What to buy to cover a bulk order**

| | |
|---|---|
| operationId | `adminBulkOrderProcurementPlan` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Turns the shortfall into purchase lines: the preferred supplier per gift (or the cheapest when none is marked preferred), the quantity rounded UP to their MOQ, and the date each line must be ordered by to land before the dispatch window opens.

**Creates no purchase orders.** It is a plan — POST /v1/admin/purchase-orders is what commits money.

A line that cannot arrive in time is marked `meetsWindow: false` with an `orderByDate` in the past. That is stated rather than softened, because the decision it drives — split the campaign, substitute the gift, move the date — belongs to a human and needs the real number. `estimatedTotalPaise` is null if ANY line lacks a cost.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bulkOrderId` | `uuid` | **yes** | — | Corporate campaign id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | no | — | Measure the shortfall against one warehouse only. |

Example request:

```json
{
  "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
}
```

**Response `200`** — The procurement plan.

```json
{
  "type": "success",
  "result": {
    "bulkOrderId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "windowStartOn": "2026-11-01",
    "totalOrderQty": 10,
    "estimatedTotalPaise": 149900,
    "lateLineCount": 3,
    "longestLeadTimeDays": 30,
    "lines": [
      {
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "shortageQty": 10,
        "orderQty": 10,
        "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "supplierName": "Kraft & Co Packaging",
        "leadTimeDays": 30,
        "estimatedCostPaise": 149900,
        "orderByDate": "2026-11-01",
        "meetsWindow": false
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bulk order. |

---

### `GET /v1/admin/bulk-orders/:bulkOrderId/fulfillment-plan`

**How a bulk order dispatches**

| | |
|---|---|
| operationId | `adminBulkOrderFulfillmentPlan` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Groups the campaign for dispatch: by `warehouse` (the picking view), by `state` (the courier view), or by `variant`.

§88 — `plannedUnits` must equal `reservedUnits`. `balanced: false` means the two disagree, and the campaign should be reserved or released before anyone picks against this plan. A plan that dispatches 799 against a hold of 800 has one recipient nobody will ever ship to, and every individual number in it looks reasonable.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bulkOrderId` | `uuid` | **yes** | — | Corporate campaign id. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `groupBy` | `"warehouse" \| "state" \| "variant"` | no | default `"warehouse"` | How to group the dispatch plan. `warehouse` is the picking view; `state` is the courier view. |

**Response `200`** — The dispatch plan.

```json
{
  "type": "success",
  "result": {
    "bulkOrderId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "groupBy": "warehouse",
    "reservedUnits": 1,
    "plannedUnits": 1,
    "balanced": false,
    "unreservedUnits": 1,
    "groups": [
      {
        "key": "inventory",
        "label": "In progress",
        "recipientCount": 3,
        "unitCount": 3
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bulk order. |

---
