# Admin transfers

7 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/transfers`](#get-v1-admin-transfers) — List stock transfers
- [`POST /v1/admin/transfers`](#post-v1-admin-transfers) — Raise a stock transfer
- [`GET /v1/admin/transfers/:transferId`](#get-v1-admin-transfers-transferid) — Get one stock transfer
- [`POST /v1/admin/transfers/:transferId/approve`](#post-v1-admin-transfers-transferid-approve) — Approve a stock transfer
- [`POST /v1/admin/transfers/:transferId/dispatch`](#post-v1-admin-transfers-transferid-dispatch) — Dispatch an approved transfer
- [`POST /v1/admin/transfers/:transferId/receive`](#post-v1-admin-transfers-transferid-receive) — Receive a transfer at the destination
- [`POST /v1/admin/transfers/:transferId/cancel`](#post-v1-admin-transfers-transferid-cancel) — Cancel a stock transfer

---

### `GET /v1/admin/transfers`

**List stock transfers**

| | |
|---|---|
| operationId | `adminListStockTransfers` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Filter by `status` (comma-separated), by either end (`warehouseId`) or one specific end (`fromWarehouseId` / `toWarehouseId`), and by ETA range. `?q=` matches the transfer number.

The five statuses are the database’s: `requested`, `approved`, `in_transit`, `received`, `cancelled`. The lifecycle people say out loud — draft → approved → dispatched → in transit → received → completed — maps onto them without inventing values: draft is `requested`, dispatched and in-transit are both `in_transit` (dispatch is the event that puts stock in transit), and received and completed are both `received`. Passing `draft` is a 400 that says so.

`inTransitQty` is non-zero only while `in_transit` — that is the quantity currently belonging to neither warehouse.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-createdAt` (default), `createdAt`, `transferNo`, `status`, `etaOn`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `status` | `string` | no | max 200 | One status or a comma-separated list. |
| `fromWarehouseId` | `uuid` | no | — | Source warehouse. |
| `toWarehouseId` | `uuid` | no | — | Destination warehouse. |
| `warehouseId` | `uuid` | no | — | Either end — source OR destination. |
| `etaFrom` | `string` | no | — | `YYYY-MM-DD`. Inclusive lower bound on ETA. |
| `etaTo` | `string` | no | — | `YYYY-MM-DD`. Inclusive upper bound on ETA. |

Example: `/v1/admin/transfers?page=…&perPage=…`

**Response `200`** — A page of transfers.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "transferNo": "PRD-2026-00001",
      "status": "requested",
      "fromWarehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "fromWarehouseName": "Mumbai — Andheri East",
      "toWarehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "toWarehouseName": "Mumbai — Andheri East",
      "lineCount": 3,
      "totalSentQty": 10,
      "totalReceivedQty": 10,
      "inTransitQty": 10,
      "etaOn": "2026-11-01",
      "dispatchedAt": "2026-08-25T10:30:00.000Z",
      "receivedAt": "2026-08-25T10:30:00.000Z",
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

### `POST /v1/admin/transfers`

**Raise a stock transfer**

| | |
|---|---|
| operationId | `adminCreateStockTransfer` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

Creates the transfer in `requested` with its lines. **No stock moves.** A transfer is a request until it is approved and dispatched; decrementing here would strand stock the moment somebody raised a transfer and forgot about it.

The number comes from the `stock_transfer` document series under a row lock — `TRF-2026-00061`, never `Math.random()`. Source and destination must differ, and every line names exactly one of `variantId` or `hamperItemId`, both of which the database CHECKs.

Availability is NOT checked here, deliberately: stock levels at approval time are what matter, and a check now would only produce a promise the dispatch cannot keep.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `fromWarehouseId` | `uuid` | **yes** | — | Source warehouse. Stock leaves here at dispatch. |
| `toWarehouseId` | `uuid` | **yes** | — | Destination warehouse. Must differ from the source. |
| `etaOn` | `string` | no | — | `YYYY-MM-DD` the goods are expected to land. Informational. |
| `lines` | `object[]` | **yes** | min 1 items, max 200 items | At least one line. A transfer of nothing is not a document. |

Example request:

```json
{
  "fromWarehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "toWarehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "etaOn": "2026-11-01",
  "lines": [
    {
      "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "hamperItemId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "quantity": 10
    }
  ]
}
```

**Response `201`** — The created transfer.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "transferNo": "PRD-2026-00001",
    "status": "requested",
    "fromWarehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "fromWarehouseName": "Mumbai — Andheri East",
    "toWarehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "toWarehouseName": "Mumbai — Andheri East",
    "lineCount": 3,
    "totalSentQty": 10,
    "totalReceivedQty": 10,
    "inTransitQty": 10,
    "etaOn": "2026-11-01",
    "dispatchedAt": "2026-08-25T10:30:00.000Z",
    "receivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "requestedBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "hamperItemId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "sentQty": 10,
        "receivedQty": 10,
        "shortQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "approve",
        "to": "requested",
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
| `404` | No such source or destination warehouse. |
| `422` | Same warehouse at both ends, or a line naming a stockable that does not exist. |

---

### `GET /v1/admin/transfers/:transferId`

**Get one stock transfer**

| | |
|---|---|
| operationId | `adminGetStockTransfer` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The document with its lines, both warehouse names, and `availableActions` — the legal edges from the current status with the side effects each carries. Render the buttons from that list and a disabled button and a 422 can never disagree.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `transferId` | `uuid` | **yes** | — | Stock transfer id. |

**Response `200`** — The transfer.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "transferNo": "PRD-2026-00001",
    "status": "requested",
    "fromWarehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "fromWarehouseName": "Mumbai — Andheri East",
    "toWarehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "toWarehouseName": "Mumbai — Andheri East",
    "lineCount": 3,
    "totalSentQty": 10,
    "totalReceivedQty": 10,
    "inTransitQty": 10,
    "etaOn": "2026-11-01",
    "dispatchedAt": "2026-08-25T10:30:00.000Z",
    "receivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "requestedBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "hamperItemId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "sentQty": 10,
        "receivedQty": 10,
        "shortQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "approve",
        "to": "requested",
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
| `404` | No such transfer. |

---

### `POST /v1/admin/transfers/:transferId/approve`

**Approve a stock transfer**

| | |
|---|---|
| operationId | `adminApproveStockTransfer` |
| Auth | Bearer staff token |
| Permission | `inventory:approve` |

`requested` → `approved`, gated on `inventory:approve` — which, across the eleven roles, a Warehouse Manager does not hold. Raising a transfer and authorising it are different jobs.

No stock moves. A transfer with no lines is refused here rather than at dispatch, because an approved empty document is a thing nobody can act on.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `transferId` | `uuid` | **yes** | — | Stock transfer id. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The approved transfer.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "transferNo": "PRD-2026-00001",
    "status": "requested",
    "fromWarehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "fromWarehouseName": "Mumbai — Andheri East",
    "toWarehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "toWarehouseName": "Mumbai — Andheri East",
    "lineCount": 3,
    "totalSentQty": 10,
    "totalReceivedQty": 10,
    "inTransitQty": 10,
    "etaOn": "2026-11-01",
    "dispatchedAt": "2026-08-25T10:30:00.000Z",
    "receivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "requestedBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "hamperItemId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "sentQty": 10,
        "receivedQty": 10,
        "shortQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "approve",
        "to": "requested",
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
| `404` | No such transfer. |
| `422` | Illegal transition (`illegal_transfer_transition`), or the transfer has no lines. |

---

### `POST /v1/admin/transfers/:transferId/dispatch`

**Dispatch an approved transfer**

| | |
|---|---|
| operationId | `adminDispatchStockTransfer` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

`approved` → `in_transit`, and the first of the two edges that touch stock. In ONE transaction, for every line: decrement on-hand at the source through a conditional `UPDATE … WHERE on_hand_qty - reserved_qty >= n`, write a `transfer_out` movement carrying the balance that update returned, and raise `incoming_qty` at the destination.

If any line is short the whole dispatch rolls back — no line half-ships. Reserved units belong to open carts and orders and are not available to transfer, so a warehouse with 10 on hand and 8 reserved can send 2. Short is 422 `insufficient_stock`, naming the SKU.

Source levels are locked in ascending id order, so two transfers sharing SKUs queue rather than deadlock.

From here until receipt the stock is in **neither** warehouse’s `availableQty`. That is not a gap in the accounting — it is where the goods actually are.

Requires an `Idempotency-Key`: a retried dispatch must not decrement twice.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `transferId` | `uuid` | **yes** | — | Stock transfer id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `note` | `string` | no | max 500 | Recorded on each `transfer_out` movement. |

Example request:

```json
{
  "note": "Damaged in transit"
}
```

**Response `200`** — The dispatched transfer.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "transferNo": "PRD-2026-00001",
    "status": "requested",
    "fromWarehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "fromWarehouseName": "Mumbai — Andheri East",
    "toWarehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "toWarehouseName": "Mumbai — Andheri East",
    "lineCount": 3,
    "totalSentQty": 10,
    "totalReceivedQty": 10,
    "inTransitQty": 10,
    "etaOn": "2026-11-01",
    "dispatchedAt": "2026-08-25T10:30:00.000Z",
    "receivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "requestedBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "hamperItemId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "sentQty": 10,
        "receivedQty": 10,
        "shortQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "approve",
        "to": "requested",
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
| `404` | No such transfer. |
| `422` | Illegal transition, no lines, or `insufficient_stock` at the source. |

---

### `POST /v1/admin/transfers/:transferId/receive`

**Receive a transfer at the destination**

| | |
|---|---|
| operationId | `adminReceiveStockTransfer` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

`in_transit` → `received`, the second stock-moving edge. In ONE transaction, for every line: increment on-hand at the destination, write a `transfer_in` movement with the resulting balance, and clear the `incoming_qty` this transfer raised.

Omit `lines` to receive everything in full, which is the common case. A line may arrive SHORT — the difference is goods lost in transit: they already left the source ledger and are simply never credited to the destination, so both warehouses stay reconciled and the loss is visible as `shortQty`. A line cannot arrive OVER; that is 422 `over_receipt`, which the `transfer_line_no_over_receipt` CHECK would otherwise raise as a constraint error.

Requires an `Idempotency-Key`: a retried receipt must not credit the destination twice.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `transferId` | `uuid` | **yes** | — | Stock transfer id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `lines` | `object[]` | no | max 200 items | Per-line arrivals. Omit entirely to receive every line in full, which is the common case. Any shortfall is goods lost in transit: they already left the source ledger and are simply never credited to the destination. |
| `note` | `string` | no | max 500 | Recorded on each `transfer_in` movement. |

Example request:

```json
{
  "lines": [
    {
      "lineId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "receivedQty": 10
    }
  ],
  "note": "Damaged in transit"
}
```

**Response `200`** — The received transfer, with per-line `receivedQty` and `shortQty`.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "transferNo": "PRD-2026-00001",
    "status": "requested",
    "fromWarehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "fromWarehouseName": "Mumbai — Andheri East",
    "toWarehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "toWarehouseName": "Mumbai — Andheri East",
    "lineCount": 3,
    "totalSentQty": 10,
    "totalReceivedQty": 10,
    "inTransitQty": 10,
    "etaOn": "2026-11-01",
    "dispatchedAt": "2026-08-25T10:30:00.000Z",
    "receivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "requestedBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "hamperItemId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "sentQty": 10,
        "receivedQty": 10,
        "shortQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "approve",
        "to": "requested",
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
| `404` | No such transfer. |
| `422` | Illegal transition, an unknown line id, or `over_receipt`. |

---

### `POST /v1/admin/transfers/:transferId/cancel`

**Cancel a stock transfer**

| | |
|---|---|
| operationId | `adminCancelStockTransfer` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Legal from `requested` and `approved` only — nothing has moved yet, so there is nothing to unwind.

A transfer that is already `in_transit` is refused with 422 `transfer_in_transit_not_cancellable`. The stock has left the source warehouse; "cancelling" it would leave those units on no document and in no warehouse, which is precisely the invisible inventory the movement ledger exists to prevent. Receive it at the destination and raise a transfer back.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `transferId` | `uuid` | **yes** | — | Stock transfer id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `reason` | `string` | **yes** | min 3, max 400 | Why. Recorded for the audit trail. |

Example request:

```json
{
  "reason": "Damaged in transit"
}
```

**Response `200`** — The cancelled transfer.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "transferNo": "PRD-2026-00001",
    "status": "requested",
    "fromWarehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "fromWarehouseName": "Mumbai — Andheri East",
    "toWarehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "toWarehouseName": "Mumbai — Andheri East",
    "lineCount": 3,
    "totalSentQty": 10,
    "totalReceivedQty": 10,
    "inTransitQty": 10,
    "etaOn": "2026-11-01",
    "dispatchedAt": "2026-08-25T10:30:00.000Z",
    "receivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "requestedBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "hamperItemId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "sentQty": 10,
        "receivedQty": 10,
        "shortQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "approve",
        "to": "requested",
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
| `404` | No such transfer. |
| `422` | Already in transit, already received, or already cancelled. |

---
