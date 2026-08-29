# Admin purchasing

7 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/purchasing/purchase-orders`](#get-v1-admin-purchasing-purchase-orders) — List purchase orders
- [`POST /v1/admin/purchasing/purchase-orders`](#post-v1-admin-purchasing-purchase-orders) — Raise a purchase order
- [`GET /v1/admin/purchasing/purchase-orders/:poId`](#get-v1-admin-purchasing-purchase-orders-poid) — Get one purchase order
- [`PATCH /v1/admin/purchasing/purchase-orders/:poId`](#patch-v1-admin-purchasing-purchase-orders-poid) — Edit a draft purchase order
- [`POST /v1/admin/purchasing/purchase-orders/:poId/approve`](#post-v1-admin-purchasing-purchase-orders-poid-approve) — Approve a purchase order
- [`POST /v1/admin/purchasing/purchase-orders/:poId/send`](#post-v1-admin-purchasing-purchase-orders-poid-send) — Mark a purchase order sent to the supplier
- [`POST /v1/admin/purchasing/purchase-orders/:poId/cancel`](#post-v1-admin-purchasing-purchase-orders-poid-cancel) — Cancel a purchase order

---

### `GET /v1/admin/purchasing/purchase-orders`

**List purchase orders**

| | |
|---|---|
| operationId | `adminListPurchaseOrders` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Filter by stored `status` (comma-separated), supplier, receiving warehouse and expected-date range. `?q=` matches the PO number.

Every row carries **both** `status` and `lifecycle`. `status` is one of the five values the database allows; `lifecycle` is what it means, derived from `status` plus `sentAt`. The one that matters: `status: "sent"` with `sentAt: null` is `lifecycle: "approved"` — approved, but not yet in front of the supplier, and the state in which `incomingQty` has deliberately not been raised. Filter on `sent` and read `lifecycle` to tell the two apart.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-createdAt` (default), `createdAt`, `poNo`, `status`, `expectedOn`, `totalPaise`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `status` | `string` | no | max 200 | One stored status or a comma-separated list. |
| `supplierId` | `uuid` | no | — | Restrict to one supplier. |
| `warehouseId` | `uuid` | no | — | Restrict to one receiving warehouse. |
| `expectedFrom` | `string` | no | — | `YYYY-MM-DD`. Inclusive lower bound on `expectedOn`. |
| `expectedTo` | `string` | no | — | `YYYY-MM-DD`. Inclusive upper bound on `expectedOn`. |

Example: `/v1/admin/purchasing/purchase-orders?page=…&perPage=…`

**Response `200`** — A page of purchase orders.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "poNo": "PRD-2026-00001",
      "status": "draft",
      "lifecycle": "draft",
      "supplierId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "supplierName": "Kraft & Co Packaging",
      "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "warehouseName": "Mumbai — Andheri East",
      "currency": "INR",
      "subtotalPaise": 149900,
      "taxPaise": 149900,
      "totalPaise": 149900,
      "lineCount": 3,
      "orderedQty": 10,
      "receivedQty": 10,
      "expectedOn": "2026-11-01",
      "sentAt": "2026-08-25T10:30:00.000Z",
      "closedAt": "2026-08-25T10:30:00.000Z",
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

### `POST /v1/admin/purchasing/purchase-orders`

**Raise a purchase order**

| | |
|---|---|
| operationId | `adminCreatePurchaseOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

Creates the PO in `draft` with its lines. Nothing is ordered and nothing is expected until it has been approved AND sent.

Every total is recomputed server-side: `lineTotalPaise` is `orderedQty × unitCostPaise` excluding GST, `taxPaise` applies each line’s own basis-point rate to its own subtotal (so a PO mixing 5% and 18% items does not have to pick one), and `totalPaise` is their sum. All integer paise. A client-supplied total is not accepted, let alone trusted.

The number comes from the `purchase_order` document series under a row lock — `PO-2026-02291`.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `supplierId` | `uuid` | **yes** | — | Who we are buying from. |
| `warehouseId` | `uuid` | **yes** | — | Where the goods will be received. The GRN must name the same warehouse. |
| `expectedOn` | `string` | no | — | `YYYY-MM-DD`. When the goods are expected. |
| `notes` | `string` | no | max 2000 | Internal notes. Not sent to the supplier by this API. |
| `lines` | `object[]` | **yes** | min 1 items, max 500 items | At least one line. A PO for nothing is not a document. |

Example request:

```json
{
  "supplierId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "expectedOn": "2026-11-01",
  "notes": "Damaged in transit",
  "lines": [
    {
      "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "hamperItemId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "packagingId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "description": "Free-text description.",
      "orderedQty": 10,
      "unitCostPaise": 149900,
      "gstRateBp": 0
    }
  ]
}
```

**Response `201`** — The created purchase order.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "poNo": "PRD-2026-00001",
    "status": "draft",
    "lifecycle": "draft",
    "supplierId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "warehouseName": "Mumbai — Andheri East",
    "currency": "INR",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lineCount": 3,
    "orderedQty": 10,
    "receivedQty": 10,
    "expectedOn": "2026-11-01",
    "sentAt": "2026-08-25T10:30:00.000Z",
    "closedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "notes": "Damaged in transit",
    "createdBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "targetKind": "variant",
        "targetId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "description": "Free-text description.",
        "orderedQty": 10,
        "receivedQty": 10,
        "outstandingQty": 10,
        "unitCostPaise": 149900,
        "gstRateBp": 1000,
        "lineTotalPaise": 149900
      }
    ],
    "receipts": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "grnNo": "PRD-2026-00001",
        "receivedOn": "2026-11-01",
        "qcStatus": "passed",
        "acceptedQty": 10,
        "rejectedQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "edit",
        "to": "draft",
        "label": "In progress",
        "documentDriven": false,
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
| `422` | A line naming a stockable that does not exist. |

---

### `GET /v1/admin/purchasing/purchase-orders/:poId`

**Get one purchase order**

| | |
|---|---|
| operationId | `adminGetPurchaseOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The document with its lines, every goods receipt posted against it, and `availableActions`.

Per line, `outstandingQty` is `orderedQty - receivedQty`, and `receivedQty` counts **accepted** units only. Rejected goods appear on the receipts, never here — they are going back to the supplier, so the PO is still owed that stock.

Edges marked `documentDriven` (`partially_received`, `received`) have no endpoint: a PO reaches them because a GRN was posted, not because someone clicked. Render them disabled.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `poId` | `uuid` | **yes** | — | Purchase order id. |

**Response `200`** — The purchase order.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "poNo": "PRD-2026-00001",
    "status": "draft",
    "lifecycle": "draft",
    "supplierId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "warehouseName": "Mumbai — Andheri East",
    "currency": "INR",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lineCount": 3,
    "orderedQty": 10,
    "receivedQty": 10,
    "expectedOn": "2026-11-01",
    "sentAt": "2026-08-25T10:30:00.000Z",
    "closedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "notes": "Damaged in transit",
    "createdBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "targetKind": "variant",
        "targetId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "description": "Free-text description.",
        "orderedQty": 10,
        "receivedQty": 10,
        "outstandingQty": 10,
        "unitCostPaise": 149900,
        "gstRateBp": 1000,
        "lineTotalPaise": 149900
      }
    ],
    "receipts": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "grnNo": "PRD-2026-00001",
        "receivedOn": "2026-11-01",
        "qcStatus": "passed",
        "acceptedQty": 10,
        "rejectedQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "edit",
        "to": "draft",
        "label": "In progress",
        "documentDriven": false,
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
| `404` | No such purchase order. |

---

### `PATCH /v1/admin/purchasing/purchase-orders/:poId`

**Edit a draft purchase order**

| | |
|---|---|
| operationId | `adminUpdatePurchaseOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Draft only. Once a PO is approved the lines are the agreement, and once it is sent the supplier has a copy — editing either would leave two different documents with one number. Anything else is 422 `illegal_po_transition`.

Supplying `lines` REPLACES all of them and recomputes every total. Replacement rather than a partial patch because a line carries `receivedQty`, and a patch that reordered or dropped lines would have to invent an answer for what happens to it. In draft it is always zero, so replacement is safe.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `poId` | `uuid` | **yes** | — | Purchase order id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `expectedOn` | `string` | no | — | `YYYY-MM-DD`. When the goods are expected, or null to clear. |
| `notes` | `string` | no | max 2000 | Internal notes, or null to clear. |
| `lines` | `object[]` | no | min 1 items, max 500 items | Replaces ALL lines when given. Totals are recomputed. Draft only. |

Example request:

```json
{
  "expectedOn": "2026-11-01",
  "notes": "Damaged in transit",
  "lines": [
    {
      "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "hamperItemId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "packagingId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "description": "Free-text description.",
      "orderedQty": 10,
      "unitCostPaise": 149900,
      "gstRateBp": 0
    }
  ]
}
```

**Response `200`** — The updated purchase order.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "poNo": "PRD-2026-00001",
    "status": "draft",
    "lifecycle": "draft",
    "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseName": "Mumbai — Andheri East",
    "currency": "INR",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lineCount": 3,
    "orderedQty": 10,
    "receivedQty": 10,
    "expectedOn": "2026-11-01",
    "sentAt": "2026-08-25T10:30:00.000Z",
    "closedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "notes": "Damaged in transit",
    "createdBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "targetKind": "variant",
        "targetId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "description": "Free-text description.",
        "orderedQty": 10,
        "receivedQty": 10,
        "outstandingQty": 10,
        "unitCostPaise": 149900,
        "gstRateBp": 1000,
        "lineTotalPaise": 149900
      }
    ],
    "receipts": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "grnNo": "PRD-2026-00001",
        "receivedOn": "2026-11-01",
        "qcStatus": "passed",
        "acceptedQty": 10,
        "rejectedQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "edit",
        "to": "draft",
        "label": "In progress",
        "documentDriven": false,
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
| `404` | No such purchase order. |
| `422` | Not a draft, or a line naming a stockable that does not exist. |

---

### `POST /v1/admin/purchasing/purchase-orders/:poId/approve`

**Approve a purchase order**

| | |
|---|---|
| operationId | `adminApprovePurchaseOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:approve` |

Gated on `inventory:approve`, which a Warehouse Manager does not hold — raising a PO and committing the company’s money to it are different jobs.

**Stored as `status: "sent"` with `sentAt` still null**, which reads back as `lifecycle: "approved"`. The `purchase_orders` CHECK allows exactly five statuses and there is no `approved` among them; writing one would fail against the live database rather than model anything. The two columns together carry the distinction the CHECK cannot.

`incomingQty` is deliberately NOT raised here. An approved PO nobody has posted to the supplier is not stock on its way, and counting it would make the reorder engine skip a SKU that was never actually ordered.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `poId` | `uuid` | **yes** | — | Purchase order id. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The approved purchase order.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "poNo": "PRD-2026-00001",
    "status": "draft",
    "lifecycle": "draft",
    "supplierId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "warehouseName": "Mumbai — Andheri East",
    "currency": "INR",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lineCount": 3,
    "orderedQty": 10,
    "receivedQty": 10,
    "expectedOn": "2026-11-01",
    "sentAt": "2026-08-25T10:30:00.000Z",
    "closedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "notes": "Damaged in transit",
    "createdBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "targetKind": "variant",
        "targetId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "description": "Free-text description.",
        "orderedQty": 10,
        "receivedQty": 10,
        "outstandingQty": 10,
        "unitCostPaise": 149900,
        "gstRateBp": 1000,
        "lineTotalPaise": 149900
      }
    ],
    "receipts": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "grnNo": "PRD-2026-00001",
        "receivedOn": "2026-11-01",
        "qcStatus": "passed",
        "acceptedQty": 10,
        "rejectedQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "edit",
        "to": "draft",
        "label": "In progress",
        "documentDriven": false,
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
| `404` | No such purchase order. |
| `422` | Illegal transition, or the PO has no lines. |

---

### `POST /v1/admin/purchasing/purchase-orders/:poId/send`

**Mark a purchase order sent to the supplier**

| | |
|---|---|
| operationId | `adminSendPurchaseOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Legal only from `lifecycle: "approved"`. Sending an unapproved draft is 422 `po_not_approved`.

Stamps `sentAt` and raises `incomingQty` at the receiving warehouse by each line’s outstanding quantity. This is the moment the order becomes real to the outside world, so it is the moment the warehouse starts expecting stock. `incomingQty` never touches `availableQty`, which is GENERATED from `on_hand - reserved` — ordered stock is expected, not sellable.

Also stamps `lastPurchaseAt` and `lastPurchaseCostPaise` on the matching supplier-catalogue entries, so the next reorder suggestion prices from what we actually paid.

Requires an `Idempotency-Key`: a retried send must not raise `incomingQty` twice.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `poId` | `uuid` | **yes** | — | Purchase order id. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The sent purchase order.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "poNo": "PRD-2026-00001",
    "status": "draft",
    "lifecycle": "draft",
    "supplierId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "warehouseName": "Mumbai — Andheri East",
    "currency": "INR",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lineCount": 3,
    "orderedQty": 10,
    "receivedQty": 10,
    "expectedOn": "2026-11-01",
    "sentAt": "2026-08-25T10:30:00.000Z",
    "closedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "notes": "Damaged in transit",
    "createdBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "targetKind": "variant",
        "targetId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "description": "Free-text description.",
        "orderedQty": 10,
        "receivedQty": 10,
        "outstandingQty": 10,
        "unitCostPaise": 149900,
        "gstRateBp": 1000,
        "lineTotalPaise": 149900
      }
    ],
    "receipts": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "grnNo": "PRD-2026-00001",
        "receivedOn": "2026-11-01",
        "qcStatus": "passed",
        "acceptedQty": 10,
        "rejectedQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "edit",
        "to": "draft",
        "label": "In progress",
        "documentDriven": false,
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
| `404` | No such purchase order. |
| `422` | Not approved yet, or already sent. |

---

### `POST /v1/admin/purchasing/purchase-orders/:poId/cancel`

**Cancel a purchase order**

| | |
|---|---|
| operationId | `adminCancelPurchaseOrder` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Legal from draft, approved, sent and partially received. A `received` PO is terminal — goods that arrived cannot be un-received by a status flip; raise a purchase return instead.

Whatever has NOT been received stops being `incomingQty`, because it is no longer coming. Already received stock stays exactly where it is: it is in the warehouse.

The reason is stamped into the PO notes and captured by the automatic audit log.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `poId` | `uuid` | **yes** | — | Purchase order id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `reason` | `string` | **yes** | min 3, max 400 | Why. Appended to the PO notes and the audit log. |

Example request:

```json
{
  "reason": "Damaged in transit"
}
```

**Response `200`** — The cancelled purchase order.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "poNo": "PRD-2026-00001",
    "status": "draft",
    "lifecycle": "draft",
    "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseName": "Mumbai — Andheri East",
    "currency": "INR",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lineCount": 3,
    "orderedQty": 10,
    "receivedQty": 10,
    "expectedOn": "2026-11-01",
    "sentAt": "2026-08-25T10:30:00.000Z",
    "closedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "notes": "Damaged in transit",
    "createdBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "targetKind": "variant",
        "targetId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "description": "Free-text description.",
        "orderedQty": 10,
        "receivedQty": 10,
        "outstandingQty": 10,
        "unitCostPaise": 149900,
        "gstRateBp": 1000,
        "lineTotalPaise": 149900
      }
    ],
    "receipts": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "grnNo": "PRD-2026-00001",
        "receivedOn": "2026-11-01",
        "qcStatus": "passed",
        "acceptedQty": 10,
        "rejectedQty": 10
      }
    ],
    "availableActions": [
      {
        "action": "edit",
        "to": "draft",
        "label": "In progress",
        "documentDriven": false,
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
| `404` | No such purchase order. |
| `422` | Already received or already cancelled. |

---
