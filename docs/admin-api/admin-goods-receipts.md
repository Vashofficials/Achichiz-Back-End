# Admin goods receipts

3 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/purchasing/goods-receipts`](#get-v1-admin-purchasing-goods-receipts) — List goods receipts
- [`POST /v1/admin/purchasing/goods-receipts`](#post-v1-admin-purchasing-goods-receipts) — Receive goods against a purchase order
- [`GET /v1/admin/purchasing/goods-receipts/:grnId`](#get-v1-admin-purchasing-goods-receipts-grnid) — Get one goods receipt

---

### `GET /v1/admin/purchasing/goods-receipts`

**List goods receipts**

| | |
|---|---|
| operationId | `adminListGoodsReceipts` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Filter by purchase order, warehouse, QC status and received-date range. `?q=` matches the GRN number and the supplier’s invoice number.

`acceptedQty` is what entered stock; `rejectedQty` is what did not. The two are always reported separately and never summed into a single "received" figure.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-receivedOn` (default), `receivedOn`, `grnNo`, `createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `purchaseOrderId` | `uuid` | no | — | Restrict to one purchase order. |
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `qcStatus` | `"passed" \| "partial" \| "failed"` | no | — | `passed`, `partial` or `failed`. |
| `receivedFrom` | `string` | no | — | `YYYY-MM-DD`. Inclusive lower bound on `receivedOn`. |
| `receivedTo` | `string` | no | — | `YYYY-MM-DD`. Inclusive upper bound on `receivedOn`. |

Example: `/v1/admin/purchasing/goods-receipts?page=…&perPage=…`

**Response `200`** — A page of goods receipts.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "grnNo": "PRD-2026-00001",
      "purchaseOrderId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "poNo": "PRD-2026-00001",
      "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "warehouseName": "Mumbai — Andheri East",
      "supplierId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "supplierName": "Kraft & Co Packaging",
      "receivedOn": "2026-11-01",
      "qcStatus": "passed",
      "supplierInvoiceNo": "PRD-2026-00001",
      "acceptedQty": 10,
      "rejectedQty": 10,
      "lineCount": 3,
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

### `POST /v1/admin/purchasing/goods-receipts`

**Receive goods against a purchase order**

| | |
|---|---|
| operationId | `adminCreateGoodsReceipt` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

The stock-in step, and ONE transaction end to end. Per line: increment on-hand by `acceptedQty`, write an `inbound` movement carrying the balance that increment returned, add to the PO line’s `receivedQty`, and lower `incomingQty` by everything that turned up. If any line fails, none of it happened.

**Rejected units never enter stock.** They are recorded on the receipt line with a reason and go no further — damaged goods inside `on_hand_qty` are sellable goods, and no downstream report undoes that. They also do not count towards `receivedQty`, so a PO with rejections stays open for what it is still owed. Send them back with a purchase return.

**Partial receipts are normal.** The PO becomes `partially_received` and stays there until ordered equals accepted across ALL lines, at which point it becomes `received` and `closedAt` is stamped. Accepting more than a line still has outstanding is 422 `over_receipt`.

The warehouse is taken from the PO, not from the request: receiving into a different warehouse than the one that ordered would leave `incomingQty` raised forever at the warehouse still waiting.

Requires an `Idempotency-Key`: a retried receipt must not add the stock twice.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `purchaseOrderId` | `uuid` | **yes** | — | The PO being received against. Must be sent or partially received. |
| `receivedOn` | `string` | no | — | `YYYY-MM-DD`. When the goods physically arrived. Defaults to today. |
| `qcStatus` | `"passed" \| "partial" \| "failed"` | no | default `"passed"` | Inspection outcome for the receipt as a whole. Per-line rejections are on the lines. |
| `inspectorId` | `uuid` | no | — | Staff member who inspected the goods. |
| `supplierInvoiceNo` | `string` | no | max 60 | The supplier’s invoice number, for reconciliation. |
| `notes` | `string` | no | max 2000 | Free text. |
| `lines` | `object[]` | **yes** | min 1 items, max 500 items | At least one line. Partial receipts are normal — the PO stays `partially_received`. |

Example request:

```json
{
  "purchaseOrderId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "receivedOn": "2026-11-01",
  "qcStatus": "passed",
  "inspectorId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "supplierInvoiceNo": "PRD-2026-00001",
  "notes": "Damaged in transit",
  "lines": [
    {
      "poLineId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "acceptedQty": 10,
      "rejectedQty": 0,
      "rejectionReason": "Damaged in transit",
      "batchNo": "B-2026-11",
      "expiryOn": "2026-11-01"
    }
  ]
}
```

**Response `201`** — The posted receipt, with the PO’s resulting status.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "grnNo": "PRD-2026-00001",
    "purchaseOrderId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "poNo": "PRD-2026-00001",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseName": "Mumbai — Andheri East",
    "supplierId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "supplierName": "Kraft & Co Packaging",
    "receivedOn": "2026-11-01",
    "qcStatus": "passed",
    "supplierInvoiceNo": "PRD-2026-00001",
    "acceptedQty": 10,
    "rejectedQty": 10,
    "lineCount": 3,
    "createdAt": "2026-08-25T10:30:00.000Z",
    "inspectorId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "notes": "Damaged in transit",
    "poStatusAfter": "draft",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "poLineId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "description": "Free-text description.",
        "acceptedQty": 10,
        "rejectedQty": 10,
        "rejectionReason": "Damaged in transit",
        "batchNo": "B-2026-11",
        "expiryOn": "2026-11-01"
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such purchase order. |
| `422` | The PO has not been sent (`po_not_receivable`), an unknown line, or `over_receipt`. |

---

### `GET /v1/admin/purchasing/goods-receipts/:grnId`

**Get one goods receipt**

| | |
|---|---|
| operationId | `adminGetGoodsReceipt` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The receipt with its lines, including per-line rejections with their reasons, batch numbers and expiry dates. `poStatusAfter` is what the purchase order’s stored status became once this receipt was posted.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `grnId` | `uuid` | **yes** | — | Goods receipt id. |

**Response `200`** — The goods receipt.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "grnNo": "PRD-2026-00001",
    "purchaseOrderId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "poNo": "PRD-2026-00001",
    "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "warehouseName": "Mumbai — Andheri East",
    "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "supplierName": "Kraft & Co Packaging",
    "receivedOn": "2026-11-01",
    "qcStatus": "passed",
    "supplierInvoiceNo": "PRD-2026-00001",
    "acceptedQty": 10,
    "rejectedQty": 10,
    "lineCount": 3,
    "createdAt": "2026-08-25T10:30:00.000Z",
    "inspectorId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "notes": "Damaged in transit",
    "poStatusAfter": "draft",
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "poLineId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "description": "Free-text description.",
        "acceptedQty": 10,
        "rejectedQty": 10,
        "rejectionReason": "Damaged in transit",
        "batchNo": "B-2026-11",
        "expiryOn": "2026-11-01"
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such goods receipt. |

---
