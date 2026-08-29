# Admin production

6 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/production/orders`](#get-v1-admin-production-orders) — List production orders
- [`POST /v1/admin/production/orders`](#post-v1-admin-production-orders) — Create a production order
- [`GET /v1/admin/production/orders/:productionId`](#get-v1-admin-production-orders-productionid) — Get a production order
- [`POST /v1/admin/production/orders/:productionId/start`](#post-v1-admin-production-orders-productionid-start) — Start a production order
- [`POST /v1/admin/production/orders/:productionId/complete`](#post-v1-admin-production-orders-productionid-complete) — Complete a production order
- [`POST /v1/admin/production/orders/:productionId/cancel`](#post-v1-admin-production-orders-productionid-cancel) — Cancel a production order

---

### `GET /v1/admin/production/orders`

**List production orders**

| | |
|---|---|
| operationId | `adminListProductionOrders` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Filter by status, warehouse, output variant or batch number.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `createdAt` (default, descending), `productionNo`, `plannedQty`, `status`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `status` | `string` | no | max 200 | One status or a comma-separated list: `draft`, `planned`, `in_progress`, `completed`, `cancelled`. |
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `outputVariantId` | `uuid` | no | — | Restrict to one output variant. |
| `batchNo` | `string` | no | max 80 | Exact batch number. |

Example: `/v1/admin/production/orders?page=…&perPage=…`

**Response `200`** — A page of production orders.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "productionNo": "PRD-2026-00001",
      "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "warehouseName": "Mumbai — Andheri East",
      "outputKind": "variant",
      "outputId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "outputSku": "ACH-CAN-001",
      "outputName": "Brass Diya Set",
      "status": "draft",
      "plannedQty": 10,
      "producedQty": 38,
      "scrappedQty": 2,
      "batchNo": "B-2026-11",
      "lineCount": 3,
      "startedAt": "2026-08-25T10:30:00.000Z",
      "completedAt": "2026-08-25T10:30:00.000Z",
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

### `POST /v1/admin/production/orders`

**Create a production order**

| | |
|---|---|
| operationId | `adminCreateProductionOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

Sizes component lines from the BOM at creation time and materialises them on the order. The recipe is captured NOW, so a BOM edited between planning and completion cannot silently change what a half-built batch consumes.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | **yes** | — | Where the components come from and the finished goods land. One warehouse per order. |
| `outputVariantId` | `uuid` | no | — | The finished variant. Exactly one output. |
| `outputHamperItemId` | `uuid` | no | — | The finished hamper item. Exactly one output. |
| `plannedQty` | `integer` | **yes** | > 0, ≤ 1000000 | Units to build. `CHECK (planned_qty > 0)`. Sizes every component line. |
| `batchNo` | `string` | no | max 80 | Batch/lot reference for traceability. |
| `note` | `string` | no | max 2000 | Free text, kept on the order. |
| `status` | `"draft" \| "planned"` | no | default `"planned"` | Where the order starts. `planned` is the normal case; `draft` is for something still being costed. Nothing later may set it back. |
| `mode` | `"full" \| "direct"` | no | default `"full"` | How the component lines are derived from the BOM when `lines` is omitted. `full` explodes to raw materials — an intermediate the warehouse does not stock cannot be consumed. `direct` takes the immediate components only. |
| `lines` | `object[]` | no | min 1 items, max 200 items | Explicit component lines. Omit to derive them from the output’s BOM, which is the normal path. Supply them for a run whose recipe differs from the standing BOM — a substitution, a trial batch. |

Example request:

```json
{
  "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "outputVariantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "outputHamperItemId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "plannedQty": 10,
  "batchNo": "B-2026-11",
  "note": "Damaged in transit",
  "status": "planned",
  "mode": "full",
  "lines": [
    {
      "componentVariantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "hamperItemId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "packagingId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "plannedQty": 10,
      "unit": "piece"
    }
  ]
}
```

**Response `201`** — The order and its component lines.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "productionNo": "PRD-2026-00001",
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "warehouseName": "Mumbai — Andheri East",
    "outputKind": "variant",
    "outputId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "outputSku": "ACH-CAN-001",
    "outputName": "Brass Diya Set",
    "status": "draft",
    "plannedQty": 10,
    "producedQty": 38,
    "scrappedQty": 2,
    "batchNo": "B-2026-11",
    "lineCount": 3,
    "startedAt": "2026-08-25T10:30:00.000Z",
    "completedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "note": "Damaged in transit",
    "canBuild": false,
    "nextActions": [
      "plan"
    ],
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "inventoryLevelId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "componentKind": "variant",
        "componentId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "plannedQty": 10,
        "consumedQty": 10,
        "varianceQty": 10,
        "unit": "piece",
        "availableQty": 10,
        "shortageQty": 10
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | Warehouse or output variant not found. |
| `422` | No output given, both given, or the output has no BOM. |

---

### `GET /v1/admin/production/orders/:productionId`

**Get a production order**

| | |
|---|---|
| operationId | `adminGetProductionOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The order, its component lines with planned vs consumed, and the transitions available from here.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `productionId` | `uuid` | **yes** | — | Production order id. |

**Response `200`** — The production order.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "productionNo": "PRD-2026-00001",
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "warehouseName": "Mumbai — Andheri East",
    "outputKind": "variant",
    "outputId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "outputSku": "ACH-CAN-001",
    "outputName": "Brass Diya Set",
    "status": "draft",
    "plannedQty": 10,
    "producedQty": 38,
    "scrappedQty": 2,
    "batchNo": "B-2026-11",
    "lineCount": 3,
    "startedAt": "2026-08-25T10:30:00.000Z",
    "completedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "note": "Damaged in transit",
    "canBuild": false,
    "nextActions": [
      "plan"
    ],
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "inventoryLevelId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "componentKind": "variant",
        "componentId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "plannedQty": 10,
        "consumedQty": 10,
        "varianceQty": 10,
        "unit": "piece",
        "availableQty": 10,
        "shortageQty": 10
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such production order. |

---

### `POST /v1/admin/production/orders/:productionId/start`

**Start a production order**

| | |
|---|---|
| operationId | `adminStartProductionOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Marks the run in progress and stamps `startedAt`. Consumes nothing — components are taken at completion, when the actual output is known.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `productionId` | `uuid` | **yes** | — | Production order id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `reason` | `string` | no | max 2000 | Why. Appended to the order’s note. |

Example request:

```json
{
  "reason": "Damaged in transit"
}
```

**Response `200`** — The order after starting.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "productionNo": "PRD-2026-00001",
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "warehouseName": "Mumbai — Andheri East",
    "outputKind": "variant",
    "outputId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "outputSku": "ACH-CAN-001",
    "outputName": "Brass Diya Set",
    "status": "draft",
    "plannedQty": 10,
    "producedQty": 38,
    "scrappedQty": 2,
    "batchNo": "B-2026-11",
    "lineCount": 3,
    "startedAt": "2026-08-25T10:30:00.000Z",
    "completedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "note": "Damaged in transit",
    "canBuild": false,
    "nextActions": [
      "plan"
    ],
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "inventoryLevelId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "componentKind": "variant",
        "componentId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "plannedQty": 10,
        "consumedQty": 10,
        "varianceQty": 10,
        "unit": "piece",
        "availableQty": 10,
        "shortageQty": 10
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such production order. |
| `422` | Not startable from its current status. |

---

### `POST /v1/admin/production/orders/:productionId/complete`

**Complete a production order**

| | |
|---|---|
| operationId | `adminCompleteProductionOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

ONE transaction: consume every component, create the finished stock, write both sides of the ledger. If any component is short the whole thing rolls back — a half-consumed run cannot be reconstructed, because nothing records which components were already taken.

Components are consumed in proportion to what was STARTED (`producedQty + scrappedQty`). Scrapped units burned their materials too; charging only for good output would understate cost and overstate stock.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `productionId` | `uuid` | **yes** | — | Production order id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `producedQty` | `integer` | no | ≥ 0, ≤ 1000000 | Good units that came out. Defaults to `plannedQty`. May be 0 for a batch that failed entirely. |
| `scrappedQty` | `integer` | no | default `0`, ≥ 0, ≤ 1000000 | Units started and unusable. Their components were still consumed, which is why this is recorded rather than folded into a smaller `producedQty`. |
| `batchNo` | `string` | no | max 80 | Set or correct the batch number at completion. |
| `note` | `string` | no | max 2000 | What happened on the floor. |
| `lines` | `object[]` | no | max 200 items | Actual consumption, per line. Anything not listed consumes its planned quantity. `plannedQty` is never overwritten — the difference between the two is the only honest signal for tuning `wastePct` later. |

Example request:

```json
{
  "producedQty": 10,
  "scrappedQty": 0,
  "batchNo": "B-2026-11",
  "note": "Damaged in transit",
  "lines": [
    {
      "inventoryLevelId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "consumedQty": 10
    }
  ]
}
```

**Response `200`** — The completed order with consumed quantities.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "productionNo": "PRD-2026-00001",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseName": "Mumbai — Andheri East",
    "outputKind": "variant",
    "outputId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "outputSku": "ACH-CAN-001",
    "outputName": "Brass Diya Set",
    "status": "draft",
    "plannedQty": 10,
    "producedQty": 38,
    "scrappedQty": 2,
    "batchNo": "B-2026-11",
    "lineCount": 3,
    "startedAt": "2026-08-25T10:30:00.000Z",
    "completedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "note": "Damaged in transit",
    "canBuild": false,
    "nextActions": [
      "plan"
    ],
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "componentKind": "variant",
        "componentId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "plannedQty": 10,
        "consumedQty": 10,
        "varianceQty": 10,
        "unit": "piece",
        "availableQty": 10,
        "shortageQty": 10
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such production order. |
| `422` | Not completable, output exceeds plan, or a component is short (`insufficient_stock`). |

---

### `POST /v1/admin/production/orders/:productionId/cancel`

**Cancel a production order**

| | |
|---|---|
| operationId | `adminCancelProductionOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Only before completion. Nothing to unwind — components are not consumed until the run completes, which is precisely why cancelling is safe up to that point and impossible after it.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `productionId` | `uuid` | **yes** | — | Production order id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `reason` | `string` | no | max 2000 | Why. Appended to the order’s note. |

Example request:

```json
{
  "reason": "Damaged in transit"
}
```

**Response `200`** — The cancelled order.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "productionNo": "PRD-2026-00001",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseName": "Mumbai — Andheri East",
    "outputKind": "variant",
    "outputId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "outputSku": "ACH-CAN-001",
    "outputName": "Brass Diya Set",
    "status": "draft",
    "plannedQty": 10,
    "producedQty": 38,
    "scrappedQty": 2,
    "batchNo": "B-2026-11",
    "lineCount": 3,
    "startedAt": "2026-08-25T10:30:00.000Z",
    "completedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "note": "Damaged in transit",
    "canBuild": false,
    "nextActions": [
      "plan"
    ],
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "componentKind": "variant",
        "componentId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "plannedQty": 10,
        "consumedQty": 10,
        "varianceQty": 10,
        "unit": "piece",
        "availableQty": 10,
        "shortageQty": 10
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such production order. |
| `422` | Already completed or already cancelled. |

---
