# Admin purchase returns

5 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/purchasing/purchase-returns`](#get-v1-admin-purchasing-purchase-returns) — List purchase returns
- [`POST /v1/admin/purchasing/purchase-returns`](#post-v1-admin-purchasing-purchase-returns) — Raise a purchase return
- [`GET /v1/admin/purchasing/purchase-returns/:returnId`](#get-v1-admin-purchasing-purchase-returns-returnid) — Get one purchase return
- [`POST /v1/admin/purchasing/purchase-returns/:returnId/approve`](#post-v1-admin-purchasing-purchase-returns-returnid-approve) — Approve a purchase return
- [`POST /v1/admin/purchasing/purchase-returns/:returnId/dispatch`](#post-v1-admin-purchasing-purchase-returns-returnid-dispatch) — Dispatch an approved return to the supplier

---

### `GET /v1/admin/purchasing/purchase-returns`

**List purchase returns**

| | |
|---|---|
| operationId | `adminListPurchaseReturns` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Stock going back to a supplier. Filter by status (comma-separated), supplier, warehouse and reason. `?q=` matches the return number.

Unlike purchase orders, all six lifecycle statuses exist in the database for returns — `draft`, `pending_approval`, `approved`, `dispatched`, `completed`, `cancelled` — so no derivation is needed and `status` means exactly what it says.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-createdAt` (default), `createdAt`, `returnNo`, `status`, `totalPaise`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `status` | `string` | no | max 200 | One status or a comma-separated list. |
| `supplierId` | `uuid` | no | — | Restrict to one supplier. |
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `reason` | `"damaged" \| "wrong_item" \| "quality" \| "excess" \| "expired" \| "other"` | no | — | Restrict to one reason. |

Example: `/v1/admin/purchasing/purchase-returns?page=…&perPage=…`

**Response `200`** — A page of purchase returns.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "returnNo": "PRD-2026-00001",
      "status": "draft",
      "reason": "damaged",
      "supplierId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "supplierName": "Kraft & Co Packaging",
      "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "warehouseName": "Mumbai — Andheri East",
      "goodsReceiptId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "subtotalPaise": 149900,
      "taxPaise": 149900,
      "totalPaise": 149900,
      "lineCount": 3,
      "totalQty": 10,
      "approvedAt": "2026-08-25T10:30:00.000Z",
      "dispatchedAt": "2026-08-25T10:30:00.000Z",
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

**Errors**

| Status | Meaning |
|---|---|
| `400` | An unrecognised status value. |

---

### `POST /v1/admin/purchasing/purchase-returns`

**Raise a purchase return**

| | |
|---|---|
| operationId | `adminCreatePurchaseReturn` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

Creates the return in `draft`. **No stock moves** — a return is a request until it is approved and dispatched.

Lines name an `inventoryLevelId`, not a SKU. That is what `purchase_return_lines` stores and it is the right shape: a return takes stock out of one specific warehouse, and naming a SKU would leave the question of which one open. Get the ids from `GET /v1/admin/warehouses/{warehouseId}/inventory`. Every line’s level must be in this return’s warehouse — anything else is 422 `level_warehouse_mismatch`.

Totals are computed from the lines: `subtotalPaise` is the sum of `quantity × unitCostPaise`, and `totalPaise` adds the `taxPaise` you are reversing. Integer paise.

The number comes from the `purchase_return` series added by migration 0003 — `PRET-2026-00001`.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `supplierId` | `uuid` | **yes** | — | Who the goods are going back to. |
| `warehouseId` | `uuid` | **yes** | — | Where they are leaving from. Every line’s level must be in this warehouse. |
| `goodsReceiptId` | `uuid` | no | — | The receipt being returned against, when it is known. |
| `reason` | `"damaged" \| "wrong_item" \| "quality" \| "excess" \| "expired" \| "other"` | **yes** | — | Why the goods are going back. Fixed vocabulary, enforced by a CHECK. |
| `note` | `string` | no | max 2000 | Free text. |
| `taxPaise` | `integer` | no | default `0`, ≥ 0 | Integer paise. GST to reverse, if any. Zero when the goods were never taxed to us. |
| `lines` | `object[]` | **yes** | min 1 items, max 500 items | At least one line. |

Example request:

```json
{
  "supplierId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "goodsReceiptId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "reason": "damaged",
  "note": "Damaged in transit",
  "taxPaise": 0,
  "lines": [
    {
      "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "quantity": 10,
      "unitCostPaise": 0,
      "note": "Damaged in transit"
    }
  ]
}
```

**Response `201`** — The created return.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "returnNo": "PRD-2026-00001",
    "status": "draft",
    "reason": "damaged",
    "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseName": "Mumbai — Andheri East",
    "goodsReceiptId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lineCount": 3,
    "totalQty": 10,
    "approvedAt": "2026-08-25T10:30:00.000Z",
    "dispatchedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "note": "Damaged in transit",
    "createdBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "approvedBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "inventoryLevelId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "quantity": 10,
        "unitCostPaise": 149900,
        "lineTotalPaise": 149900,
        "note": "Damaged in transit"
      }
    ],
    "availableActions": [
      {
        "action": "approve",
        "to": "draft",
        "label": "In progress",
        "movesStock": false,
        "sideEffects": [
          "string"
        ]
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such supplier or warehouse. |
| `422` | A line naming a level that is not in this warehouse. |

---

### `GET /v1/admin/purchasing/purchase-returns/:returnId`

**Get one purchase return**

| | |
|---|---|
| operationId | `adminGetPurchaseReturn` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The return with its lines and `availableActions`. `totalPaise` is the credit expected from the supplier once they receive the goods.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `returnId` | `uuid` | **yes** | — | Purchase return id. |

**Response `200`** — The purchase return.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "returnNo": "PRD-2026-00001",
    "status": "draft",
    "reason": "damaged",
    "supplierId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "warehouseName": "Mumbai — Andheri East",
    "goodsReceiptId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lineCount": 3,
    "totalQty": 10,
    "approvedAt": "2026-08-25T10:30:00.000Z",
    "dispatchedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "note": "Damaged in transit",
    "createdBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "approvedBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "inventoryLevelId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "quantity": 10,
        "unitCostPaise": 149900,
        "lineTotalPaise": 149900,
        "note": "Damaged in transit"
      }
    ],
    "availableActions": [
      {
        "action": "approve",
        "to": "draft",
        "label": "In progress",
        "movesStock": false,
        "sideEffects": [
          "string"
        ]
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such purchase return. |

---

### `POST /v1/admin/purchasing/purchase-returns/:returnId/approve`

**Approve a purchase return**

| | |
|---|---|
| operationId | `adminApprovePurchaseReturn` |
| Auth | Bearer staff token |
| Permission | `inventory:approve` |

Gated on `inventory:approve`. Legal from `draft` and `pending_approval`; stamps `approvedBy` and `approvedAt`. No stock moves — approval authorises the dispatch, it does not perform it.

A return with no lines is refused here rather than at dispatch, because an approved empty document authorises sending nothing back.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `returnId` | `uuid` | **yes** | — | Purchase return id. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The approved return.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "returnNo": "PRD-2026-00001",
    "status": "draft",
    "reason": "damaged",
    "supplierId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "warehouseName": "Mumbai — Andheri East",
    "goodsReceiptId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lineCount": 3,
    "totalQty": 10,
    "approvedAt": "2026-08-25T10:30:00.000Z",
    "dispatchedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "note": "Damaged in transit",
    "createdBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "approvedBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "quantity": 10,
        "unitCostPaise": 149900,
        "lineTotalPaise": 149900,
        "note": "Damaged in transit"
      }
    ],
    "availableActions": [
      {
        "action": "approve",
        "to": "draft",
        "label": "In progress",
        "movesStock": false,
        "sideEffects": [
          "string"
        ]
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such purchase return. |
| `422` | Illegal transition, or the return has no lines. |

---

### `POST /v1/admin/purchasing/purchase-returns/:returnId/dispatch`

**Dispatch an approved return to the supplier**

| | |
|---|---|
| operationId | `adminDispatchPurchaseReturn` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

`approved` → `dispatched`, and the only edge on a return that touches stock. In ONE transaction, for every line: decrement on-hand through the conditional `UPDATE … WHERE on_hand_qty - reserved_qty >= n`, and write an `outbound` movement with `referenceType: "purchase_return"` carrying the balance that update returned.

Reserved units belong to open carts and orders and cannot be sent back to a supplier, so a level with 10 on hand and 8 reserved can return 2. Short is 422 `insufficient_stock`, naming the SKU, and the whole dispatch rolls back — a return that shipped three of its four lines is a parcel the supplier will dispute and a ledger nobody can reconcile.

Levels are locked in ascending id order, so concurrent returns and transfers queue rather than deadlock.

A dispatched return cannot be cancelled: the stock has left. Requires an `Idempotency-Key`.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `returnId` | `uuid` | **yes** | — | Purchase return id. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The dispatched return.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "returnNo": "PRD-2026-00001",
    "status": "draft",
    "reason": "damaged",
    "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseName": "Mumbai — Andheri East",
    "goodsReceiptId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lineCount": 3,
    "totalQty": 10,
    "approvedAt": "2026-08-25T10:30:00.000Z",
    "dispatchedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "note": "Damaged in transit",
    "createdBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "approvedBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "inventoryLevelId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "quantity": 10,
        "unitCostPaise": 149900,
        "lineTotalPaise": 149900,
        "note": "Damaged in transit"
      }
    ],
    "availableActions": [
      {
        "action": "approve",
        "to": "draft",
        "label": "In progress",
        "movesStock": false,
        "sideEffects": [
          "string"
        ]
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such purchase return. |
| `422` | Not approved, already dispatched, or `insufficient_stock`. |

---
