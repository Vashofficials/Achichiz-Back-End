# Admin orders

10 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/orders`](#get-v1-admin-orders) — List orders
- [`GET /v1/admin/orders/transitions`](#get-v1-admin-orders-transitions) — The order state machine
- [`POST /v1/admin/orders/bulk`](#post-v1-admin-orders-bulk) — Bulk action on selected orders
- [`GET /v1/admin/orders/:orderId`](#get-v1-admin-orders-orderid) — Get one order
- [`PATCH /v1/admin/orders/:orderId/status`](#patch-v1-admin-orders-orderid-status) — Move an order to another status
- [`POST /v1/admin/orders/:orderId/cancel`](#post-v1-admin-orders-orderid-cancel) — Cancel an order
- [`POST /v1/admin/orders/:orderId/refund`](#post-v1-admin-orders-orderid-refund) — Refund an order
- [`POST /v1/admin/orders/:orderId/invoice`](#post-v1-admin-orders-orderid-invoice) — Issue the GST invoice for an order
- [`POST /v1/admin/orders/:orderId/courier`](#post-v1-admin-orders-orderid-courier) — Assign a courier to an order
- [`POST /v1/admin/orders/:orderId/notes`](#post-v1-admin-orders-orderid-notes) — Add an internal note

---

### `GET /v1/admin/orders`

**List orders**

| | |
|---|---|
| operationId | `adminListOrders` |
| Auth | Bearer staff token |
| Permission | `orders:view` |

The order desk. Six named filters (`status`, `paymentStatus`, `channel`, `deliveryType`, `priority`, `warehouseId`), two date ranges (`placedFrom`/`placedTo`, `deliveryFrom`/`deliveryTo`), a `tag` filter and a `corporateAccountId` filter. Each enum filter takes a comma-separated list; an unrecognised value is a 400 rather than a silently empty page, because a typo that returns nothing reads exactly like "there are no orders".

`?q=` searches order number, buyer name, buyer email, both mobile numbers, recipient name, destination PIN code and the AWB — the last through an EXISTS on `shipments`, so a multi-parcel order still returns one row.

The KPI block in `meta` is computed over the SAME filter set as the rows, not over the page. The console currently derives those numbers from whatever happens to be in memory, which makes "order value" mean "order value of these ten".

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-placedAt` (default), `placedAt`, `orderNo`, `totalPaise`, `status`, `priority`, `requestedDeliveryDate`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `status` | `string` | no | max 400 | One status or a comma-separated list: `?status=packed,ready_to_ship`. |
| `paymentStatus` | `string` | no | max 200 | One or a comma-separated list. |
| `channel` | `string` | no | max 200 | One or a comma-separated list. |
| `deliveryType` | `string` | no | max 200 | One or a comma-separated list. |
| `priority` | `string` | no | max 80 | `standard`, `high`, `vip`, or a list. |
| `warehouseId` | `uuid` | no | — | Fulfilment warehouse. |
| `corporateAccountId` | `uuid` | no | — | Restrict to one corporate account. |
| `placedFrom` | `string` | no | — | ISO date or timestamp. Inclusive lower bound on `placedAt`. |
| `placedTo` | `string` | no | — | ISO date or timestamp. Inclusive upper bound on `placedAt`. |
| `deliveryFrom` | `string` | no | — | `YYYY-MM-DD`. Lower bound on the requested delivery date. |
| `deliveryTo` | `string` | no | — | `YYYY-MM-DD`. Upper bound on the requested delivery date. |
| `tag` | `string` | no | max 40 | One order tag, e.g. `corporate`, `fragile`, `high-value`. |

Example: `/v1/admin/orders?page=…&perPage=…`

**Response `200`** — A page of orders. `meta` carries pagination plus the KPI block.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "orderNo": "PRD-2026-00001",
      "status": "pending_payment",
      "paymentStatus": "pending",
      "fulfilmentStatus": "pending",
      "channel": "website",
      "priority": "standard",
      "deliveryType": "standard",
      "buyerName": "Brass Diya Set",
      "buyerMobile": "9820012345",
      "recipientName": "Brass Diya Set",
      "shipCity": "string",
      "shipPincode": "DIWALI20",
      "totalPaise": 149900,
      "amountPaidPaise": 149900,
      "amountRefundedPaise": 149900,
      "itemCount": 3,
      "lineCount": 3,
      "awb": "BD123456789IN",
      "courierName": "Brass Diya Set",
      "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "corporateAccountId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "tags": [
        "string"
      ],
      "placedAt": "2026-08-25T10:30:00.000Z",
      "requestedDeliveryDate": "2026-11-01",
      "deliverySlot": "string"
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
| `400` | An unrecognised filter value or an unparseable date. |

---

### `GET /v1/admin/orders/transitions`

**The order state machine**

| | |
|---|---|
| operationId | `adminGetOrderTransitionMap` |
| Auth | Bearer staff token |
| Permission | `orders:view` |

The whole transition table: every status, its legal next states, the RBAC action each edge requires, and the side effects it triggers. Edges marked `systemOnly` are facts reported by a courier scan or a payment-gateway webhook — `delivered`, `out_for_delivery`, `refunded` — and no staff member may set them by hand, because forging one puts the ledger out of step with reality.

Fetch this once and render the "Advance status" menu from it instead of hardcoding sixteen statuses in the console.

**Response `200`** — status → legal edges.

```json
{
  "type": "success",
  "result": {}
}
```

---

### `POST /v1/admin/orders/bulk`

**Bulk action on selected orders**

| | |
|---|---|
| operationId | `adminBulkOrderAction` |
| Auth | Bearer staff token |
| Permission | `orders:edit` |

Five actions. `mark_packed` and `mark_ready_to_ship` are ordinary transitions and each order is checked against the state machine individually. `generate_invoices` issues one GST invoice per order from its frozen tax columns and is idempotent — an order that already has an issued invoice is reported as succeeded, not duplicated. `assign_courier` needs `courierId` and creates or updates the open shipment. `cancel` needs `reason` and additionally requires `orders:cancel`, which this route’s own `orders:edit` gate does not imply.

Results are per order, not all-or-nothing: fifty orders selected on a busy desk will include a few that moved since the page rendered, and failing the batch for those helps nobody. They come back in `failed` with a stable code. Orders are processed sequentially because each takes row locks on the order and its inventory reservations; firing fifty in parallel turns a queue into a deadlock.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `action` | `"mark_packed" \| "mark_ready_to_ship" \| "generate_invoices" \| "assign_courier" \| "cancel"` | **yes** | — | `mark_packed` and `mark_ready_to_ship` are state transitions and obey the machine per order. `generate_invoices` issues a GST invoice from the frozen tax columns, once per order. `assign_courier` needs `courierId`. `cancel` needs `reason` and requires `orders:cancel`. |
| `orderIds` | `uuid[]` | **yes** | min 1 items, max 100 items | Order ids. At most 100 per call. |
| `courierId` | `uuid` | no | — | Required for `assign_courier`. |
| `reason` | `string` | no | min 3, max 400 | Required for `cancel`. |

Example request:

```json
{
  "action": "mark_packed",
  "orderIds": [
    "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
  ],
  "courierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "reason": "Damaged in transit"
}
```

**Response `200`** — Per-order outcomes.

```json
{
  "type": "success",
  "result": {
    "action": "approve",
    "requested": 1,
    "succeeded": [
      "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e"
    ],
    "failed": [
      {
        "orderId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "code": "DIWALI20",
        "message": "Damaged in transit"
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | `courierId` or `reason` missing for an action that needs it. |
| `403` | The action needs an RBAC action your role does not hold — `cancel` needs `orders:cancel`. |

---

### `GET /v1/admin/orders/:orderId`

**Get one order**

| | |
|---|---|
| operationId | `adminGetOrder` |
| Auth | Bearer staff token |
| Permission | `orders:view` |

The whole workspace in one call: the frozen buyer, recipient, address, billing and tax snapshots; every money column in integer paise including `refundablePaise` (captured minus already refunded, which is the cap on a refund); the lines with their add-ons, personalisation and per-line GST split; the append-only timeline; every payment attempt, not only the successful one; the refund ledger; shipments; and issued invoices.

`availableTransitions` lists every legal edge from the current status, each flagged `allowed` against YOUR grants — so the console can render the menu without a second copy of the state machine, and a disabled button and a 403 can never disagree.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | Order id. |

**Response `200`** — The order.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "orderNo": "PRD-2026-00001",
    "status": "pending_payment",
    "paymentStatus": "pending",
    "fulfilmentStatus": "pending",
    "channel": "website",
    "priority": "standard",
    "deliveryType": "standard",
    "buyerName": "Brass Diya Set",
    "buyerMobile": "9820012345",
    "recipientName": "Brass Diya Set",
    "shipCity": "string",
    "shipPincode": "DIWALI20",
    "totalPaise": 149900,
    "amountPaidPaise": 149900,
    "amountRefundedPaise": 149900,
    "itemCount": 3,
    "lineCount": 3,
    "awb": "BD123456789IN",
    "courierName": "Brass Diya Set",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "corporateAccountId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "tags": [
      "string"
    ],
    "placedAt": "2026-08-25T10:30:00.000Z",
    "requestedDeliveryDate": "2026-11-01",
    "deliverySlot": "string",
    "currency": "INR",
    "buyerEmail": "ops@achichiz.in",
    "recipientMobile": "9820012345",
    "isAnonymousGift": false,
    "giftMessage": "Damaged in transit",
    "shippingAddress": {
      "line1": "12 Linking Road",
      "line2": "Bandra West",
      "area": "Bandra",
      "city": "Mumbai",
      "stateCode": "27",
      "pincode": "400050",
      "countryCode": "DIWALI20"
    },
    "billing": {
      "sameAsShipping": false,
      "name": "Brass Diya Set",
      "line1": "12 Linking Road",
      "city": "Mumbai",
      "stateCode": "27",
      "pincode": "400050",
      "gstin": "27AAACA1234A1Z5"
    },
    "tax": {
      "placeOfSupplyStateCode": "DIWALI20",
      "supplierGstin": "string",
      "isInterstate": false,
      "isExport": false
    },
    "money": {
      "subtotalPaise": 149900,
      "couponDiscountPaise": 149900,
      "autoDiscountPaise": 149900,
      "loyaltyDiscountPaise": 149900,
      "shippingPaise": 149900,
      "codFeePaise": 149900,
      "taxablePaise": 149900,
      "cgstPaise": 149900,
      "sgstPaise": 149900,
      "igstPaise": 149900,
      "cessPaise": 149900,
      "roundOffPaise": 149900,
      "totalPaise": 149900,
      "refundablePaise": 149900
    },
    "couponCode": "DIWALI20",
    "internalNotes": "Damaged in transit",
    "cancelReason": "Damaged in transit",
    "cancelledAt": "2026-08-25T10:30:00.000Z",
    "confirmedAt": "2026-08-25T10:30:00.000Z",
    "shippedAt": "2026-08-25T10:30:00.000Z",
    "deliveredAt": "2026-08-25T10:30:00.000Z",
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "variantLabel": "string",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "hsnCode": "DIWALI20",
        "quantity": 10,
        "fulfilledQty": 10,
        "returnedQty": 10,
        "unitPricePaise": 149900,
        "lineDiscountPaise": 149900,
        "allocatedOrderDiscountPaise": 149900,
        "grossPaise": 149900,
        "gstRateBp": 1000,
        "taxablePaise": 149900,
        "cgstPaise": 149900,
        "sgstPaise": 149900,
        "igstPaise": 149900,
        "cessPaise": 149900,
        "fulfilmentStatus": "pending",
        "addOns": [
          {
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "quantity": 10,
            "inputText": "string"
          }
        ],
        "personalisation": "string"
      }
    ],
    "timeline": [
      {
        "occurredAt": "2026-08-25T10:30:00.000Z",
        "eventType": "string",
        "label": "In progress",
        "note": "Damaged in transit",
        "actorKind": "string",
        "actorStaffId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "actorLabel": "string",
        "metadata": null
      }
    ],
    "payments": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "gateway": "string",
        "method": "string",
        "status": "active",
        "amountPaise": 149900,
        "gatewayPaymentId": "string",
        "capturedAt": "2026-08-25T10:30:00.000Z",
        "failureReason": "Damaged in transit"
      }
    ],
    "refunds": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "refundNo": "PRD-2026-00001",
        "amountPaise": 149900,
        "mode": "string",
        "status": "active",
        "reason": "Damaged in transit",
        "createdAt": "2026-08-25T10:30:00.000Z"
      }
    ],
    "shipments": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "shipmentNo": "PRD-2026-00001",
        "courierName": "Brass Diya Set",
        "awb": "BD123456789IN",
        "status": "active",
        "attempts": 1,
        "etaOn": "2026-11-01",
        "dispatchedAt": "2026-08-25T10:30:00.000Z",
        "deliveredAt": "2026-08-25T10:30:00.000Z"
      }
    ],
    "invoices": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "invoiceNo": "PRD-2026-00001",
        "totalPaise": 149900,
        "issuedAt": "2026-08-25T10:30:00.000Z",
        "status": "active"
      }
    ],
    "availableTransitions": [
      {
        "to": "pending_payment",
        "label": "In progress",
        "action": "approve",
        "allowed": false,
        "systemOnly": false,
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
| `404` | No such order. |

---

### `PATCH /v1/admin/orders/:orderId/status`

**Move an order to another status**

| | |
|---|---|
| operationId | `adminUpdateOrderStatus` |
| Auth | Bearer staff token |
| Permission | `orders:edit` |

Validated against the state machine under a row lock — the status read a moment ago may have moved beneath a courier webhook while the operator was looking at the screen.

An edge that does not exist is 422 `illegal_transition` and lists the legal ones; that check runs BEFORE the permission check, so a Super Admin gets the same answer and nobody goes hunting for a missing grant that was never the problem. An edge a courier or the gateway owns is 422 `system_driven_transition`. An edge you lack the grant for is 403.

Two targets are redirected rather than handled here, because both have side effects that a status write alone would silently skip: `cancelled` runs the full cancellation (stock released, coupon redemption returned to the pool, refund started), and `refund_initiated` needs an amount, so it returns 422 pointing at the refund endpoint.

Moving to `shipped` creates or reuses the open shipment; pass `courierId` and `awb` to lock them in.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | Order id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `status` | `"pending_payment" \| "paid" \| "confirmed" \| "in_production" \| "personalisation_pending" \| "quality_check" \| "packed" \| "ready_to_ship" \| "shipped" \| "out_for_delivery" \| "delivered" \| "failed_delivery" \| "rto" \| "cancelled" \| "refund_initiated" \| "refunded"` | **yes** | — | The status to move to. Must be a legal edge from the current one. |
| `note` | `string` | no | max 500 | Free text appended to the timeline entry. Visible to staff, not to the customer. |
| `courierId` | `uuid` | no | — | Required when moving to `shipped` if no shipment has a courier yet — the AWB is locked at that point. |
| `awb` | `string` | no | max 64 | Air waybill, when moving to `shipped`. |

Example request:

```json
{
  "status": "pending_payment",
  "note": "Damaged in transit",
  "courierId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "awb": "BD123456789IN"
}
```

**Response `200`** — The order, after the move.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "orderNo": "PRD-2026-00001",
    "status": "pending_payment",
    "paymentStatus": "pending",
    "fulfilmentStatus": "pending",
    "channel": "website",
    "priority": "standard",
    "deliveryType": "standard",
    "buyerName": "Brass Diya Set",
    "buyerMobile": "9820012345",
    "recipientName": "Brass Diya Set",
    "shipCity": "string",
    "shipPincode": "DIWALI20",
    "totalPaise": 149900,
    "amountPaidPaise": 149900,
    "amountRefundedPaise": 149900,
    "itemCount": 3,
    "lineCount": 3,
    "awb": "BD123456789IN",
    "courierName": "Brass Diya Set",
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "corporateAccountId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "tags": [
      "string"
    ],
    "placedAt": "2026-08-25T10:30:00.000Z",
    "requestedDeliveryDate": "2026-11-01",
    "deliverySlot": "string",
    "currency": "INR",
    "buyerEmail": "ops@achichiz.in",
    "recipientMobile": "9820012345",
    "isAnonymousGift": false,
    "giftMessage": "Damaged in transit",
    "shippingAddress": {
      "line1": "12 Linking Road",
      "line2": "Bandra West",
      "area": "Bandra",
      "city": "Mumbai",
      "stateCode": "27",
      "pincode": "400050",
      "countryCode": "DIWALI20"
    },
    "billing": {
      "sameAsShipping": false,
      "name": "Brass Diya Set",
      "line1": "12 Linking Road",
      "city": "Mumbai",
      "stateCode": "27",
      "pincode": "400050",
      "gstin": "27AAACA1234A1Z5"
    },
    "tax": {
      "placeOfSupplyStateCode": "DIWALI20",
      "supplierGstin": "string",
      "isInterstate": false,
      "isExport": false
    },
    "money": {
      "subtotalPaise": 149900,
      "couponDiscountPaise": 149900,
      "autoDiscountPaise": 149900,
      "loyaltyDiscountPaise": 149900,
      "shippingPaise": 149900,
      "codFeePaise": 149900,
      "taxablePaise": 149900,
      "cgstPaise": 149900,
      "sgstPaise": 149900,
      "igstPaise": 149900,
      "cessPaise": 149900,
      "roundOffPaise": 149900,
      "totalPaise": 149900,
      "refundablePaise": 149900
    },
    "couponCode": "DIWALI20",
    "internalNotes": "Damaged in transit",
    "cancelReason": "Damaged in transit",
    "cancelledAt": "2026-08-25T10:30:00.000Z",
    "confirmedAt": "2026-08-25T10:30:00.000Z",
    "shippedAt": "2026-08-25T10:30:00.000Z",
    "deliveredAt": "2026-08-25T10:30:00.000Z",
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "variantLabel": "string",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "hsnCode": "DIWALI20",
        "quantity": 10,
        "fulfilledQty": 10,
        "returnedQty": 10,
        "unitPricePaise": 149900,
        "lineDiscountPaise": 149900,
        "allocatedOrderDiscountPaise": 149900,
        "grossPaise": 149900,
        "gstRateBp": 1000,
        "taxablePaise": 149900,
        "cgstPaise": 149900,
        "sgstPaise": 149900,
        "igstPaise": 149900,
        "cessPaise": 149900,
        "fulfilmentStatus": "pending",
        "addOns": [
          {
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "quantity": 10,
            "inputText": "string"
          }
        ],
        "personalisation": "string"
      }
    ],
    "timeline": [
      {
        "occurredAt": "2026-08-25T10:30:00.000Z",
        "eventType": "string",
        "label": "In progress",
        "note": "Damaged in transit",
        "actorKind": "string",
        "actorStaffId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "actorLabel": "string",
        "metadata": null
      }
    ],
    "payments": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "gateway": "string",
        "method": "string",
        "status": "active",
        "amountPaise": 149900,
        "gatewayPaymentId": "string",
        "capturedAt": "2026-08-25T10:30:00.000Z",
        "failureReason": "Damaged in transit"
      }
    ],
    "refunds": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "refundNo": "PRD-2026-00001",
        "amountPaise": 149900,
        "mode": "string",
        "status": "active",
        "reason": "Damaged in transit",
        "createdAt": "2026-08-25T10:30:00.000Z"
      }
    ],
    "shipments": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "shipmentNo": "PRD-2026-00001",
        "courierName": "Brass Diya Set",
        "awb": "BD123456789IN",
        "status": "active",
        "attempts": 1,
        "etaOn": "2026-11-01",
        "dispatchedAt": "2026-08-25T10:30:00.000Z",
        "deliveredAt": "2026-08-25T10:30:00.000Z"
      }
    ],
    "invoices": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "invoiceNo": "PRD-2026-00001",
        "totalPaise": 149900,
        "issuedAt": "2026-08-25T10:30:00.000Z",
        "status": "active"
      }
    ],
    "availableTransitions": [
      {
        "to": "pending_payment",
        "label": "In progress",
        "action": "approve",
        "allowed": false,
        "systemOnly": false,
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
| `403` | Your role lacks the action this edge requires. |
| `404` | No such order. |
| `422` | Illegal transition, a system-owned edge, or no warehouse to ship from. |

---

### `POST /v1/admin/orders/:orderId/cancel`

**Cancel an order**

| | |
|---|---|
| operationId | `adminCancelOrder` |
| Auth | Bearer staff token |
| Permission | `orders:cancel` |

Cancellation is not a status write. In one transaction it releases the stock reservation, returns the coupon redemption to the pool, stamps the reason and appends a timeline event.

An order that was actually paid becomes `refund_initiated`, **not** `cancelled` — only the gateway’s confirmation moves it to `refunded`, because telling someone their money is back before it is would be a lie. The gateway call happens after the commit, so a Razorpay outage cannot take the cancellation down with it; a failed refund is logged for Finance to retry. Send `refund: false` to leave the money for Finance to settle by hand.

Only pre-shipment orders qualify. Once a courier has the parcel, cancelling is a return-to-origin — an operations decision with a cost — so use the `rto` transition or raise a return.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | Order id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `reason` | `string` | **yes** | min 3, max 400 | Why. Required — the database refuses a cancellation with no reason, and ops needs it. |
| `refund` | `boolean` | no | default `true` | Start a gateway refund when money was actually captured. Setting false leaves the order in `refund_initiated` for Finance to settle by hand. |

Example request:

```json
{
  "reason": "Damaged in transit",
  "refund": true
}
```

**Response `200`** — The cancelled order.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "orderNo": "PRD-2026-00001",
    "status": "pending_payment",
    "paymentStatus": "pending",
    "fulfilmentStatus": "pending",
    "channel": "website",
    "priority": "standard",
    "deliveryType": "standard",
    "buyerName": "Brass Diya Set",
    "buyerMobile": "9820012345",
    "recipientName": "Brass Diya Set",
    "shipCity": "string",
    "shipPincode": "DIWALI20",
    "totalPaise": 149900,
    "amountPaidPaise": 149900,
    "amountRefundedPaise": 149900,
    "itemCount": 3,
    "lineCount": 3,
    "awb": "BD123456789IN",
    "courierName": "Brass Diya Set",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "corporateAccountId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "tags": [
      "string"
    ],
    "placedAt": "2026-08-25T10:30:00.000Z",
    "requestedDeliveryDate": "2026-11-01",
    "deliverySlot": "string",
    "currency": "INR",
    "buyerEmail": "ops@achichiz.in",
    "recipientMobile": "9820012345",
    "isAnonymousGift": false,
    "giftMessage": "Damaged in transit",
    "shippingAddress": {
      "line1": "12 Linking Road",
      "line2": "Bandra West",
      "area": "Bandra",
      "city": "Mumbai",
      "stateCode": "27",
      "pincode": "400050",
      "countryCode": "DIWALI20"
    },
    "billing": {
      "sameAsShipping": false,
      "name": "Brass Diya Set",
      "line1": "12 Linking Road",
      "city": "Mumbai",
      "stateCode": "27",
      "pincode": "400050",
      "gstin": "27AAACA1234A1Z5"
    },
    "tax": {
      "placeOfSupplyStateCode": "DIWALI20",
      "supplierGstin": "string",
      "isInterstate": false,
      "isExport": false
    },
    "money": {
      "subtotalPaise": 149900,
      "couponDiscountPaise": 149900,
      "autoDiscountPaise": 149900,
      "loyaltyDiscountPaise": 149900,
      "shippingPaise": 149900,
      "codFeePaise": 149900,
      "taxablePaise": 149900,
      "cgstPaise": 149900,
      "sgstPaise": 149900,
      "igstPaise": 149900,
      "cessPaise": 149900,
      "roundOffPaise": 149900,
      "totalPaise": 149900,
      "refundablePaise": 149900
    },
    "couponCode": "DIWALI20",
    "internalNotes": "Damaged in transit",
    "cancelReason": "Damaged in transit",
    "cancelledAt": "2026-08-25T10:30:00.000Z",
    "confirmedAt": "2026-08-25T10:30:00.000Z",
    "shippedAt": "2026-08-25T10:30:00.000Z",
    "deliveredAt": "2026-08-25T10:30:00.000Z",
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "variantLabel": "string",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "hsnCode": "DIWALI20",
        "quantity": 10,
        "fulfilledQty": 10,
        "returnedQty": 10,
        "unitPricePaise": 149900,
        "lineDiscountPaise": 149900,
        "allocatedOrderDiscountPaise": 149900,
        "grossPaise": 149900,
        "gstRateBp": 1000,
        "taxablePaise": 149900,
        "cgstPaise": 149900,
        "sgstPaise": 149900,
        "igstPaise": 149900,
        "cessPaise": 149900,
        "fulfilmentStatus": "pending",
        "addOns": [
          {
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "quantity": 10,
            "inputText": "string"
          }
        ],
        "personalisation": "string"
      }
    ],
    "timeline": [
      {
        "occurredAt": "2026-08-25T10:30:00.000Z",
        "eventType": "string",
        "label": "In progress",
        "note": "Damaged in transit",
        "actorKind": "string",
        "actorStaffId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "actorLabel": "string",
        "metadata": null
      }
    ],
    "payments": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "gateway": "string",
        "method": "string",
        "status": "active",
        "amountPaise": 149900,
        "gatewayPaymentId": "string",
        "capturedAt": "2026-08-25T10:30:00.000Z",
        "failureReason": "Damaged in transit"
      }
    ],
    "refunds": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "refundNo": "PRD-2026-00001",
        "amountPaise": 149900,
        "mode": "string",
        "status": "active",
        "reason": "Damaged in transit",
        "createdAt": "2026-08-25T10:30:00.000Z"
      }
    ],
    "shipments": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "shipmentNo": "PRD-2026-00001",
        "courierName": "Brass Diya Set",
        "awb": "BD123456789IN",
        "status": "active",
        "attempts": 1,
        "etaOn": "2026-11-01",
        "dispatchedAt": "2026-08-25T10:30:00.000Z",
        "deliveredAt": "2026-08-25T10:30:00.000Z"
      }
    ],
    "invoices": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "invoiceNo": "PRD-2026-00001",
        "totalPaise": 149900,
        "issuedAt": "2026-08-25T10:30:00.000Z",
        "status": "active"
      }
    ],
    "availableTransitions": [
      {
        "to": "pending_payment",
        "label": "In progress",
        "action": "approve",
        "allowed": false,
        "systemOnly": false,
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
| `403` | Your role cannot cancel orders. |
| `404` | No such order. |
| `422` | The order has moved past the point where it can be cancelled. |

---

### `POST /v1/admin/orders/:orderId/refund`

**Refund an order**

| | |
|---|---|
| operationId | `adminRefundOrder` |
| Auth | Bearer staff token |
| Permission | `orders:refund` |

Gated on `orders:refund`, which across the eleven roles only **Finance Manager** and **Super Admin** hold. Every other role — including Operations Manager and Order Manager, who can cancel — gets a 403 here. The console hides the button for them; that is a convenience, and this is the control.

Also requires a recent re-authentication: call `POST /v1/admin/auth/step-up` first, which opens a five-minute window on the current session. Ten minutes of access-token life is a long time for an unattended laptop and a refund is irreversible.

The work is delegated to the payments service, which caps the amount at captured-minus-refunded, writes and commits the refund row **before** calling the gateway (so a refund Razorpay accepted but whose response was lost is still on the books), and honours `Idempotency-Key` for a replayed request. Only a gateway webhook moves the refund to `completed` and the order to `refunded`.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | Order id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `amountPaise` | `integer` | **yes** | > 0 | How much to refund, in integer paise. Cannot exceed captured minus already refunded. |
| `reason` | `string` | **yes** | min 3, max 400 | Recorded on the refund row and the timeline. |

Example request:

```json
{
  "amountPaise": 149900,
  "reason": "Damaged in transit"
}
```

**Response `200`** — The refund, as the gateway accepted it.

```json
{
  "type": "success",
  "result": {
    "refundId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "refundNo": "PRD-2026-00001",
    "status": "active",
    "gatewayRefundId": "string",
    "amountPaise": 149900
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `403` | Your role cannot refund orders, or there is no recent step-up. |
| `404` | No such order. |
| `422` | The amount exceeds what is still refundable. |

---

### `POST /v1/admin/orders/:orderId/invoice`

**Issue the GST invoice for an order**

| | |
|---|---|
| operationId | `adminGenerateOrderInvoice` |
| Auth | Bearer staff token |
| Permission | `orders:edit` |

Amounts are copied from the order’s FROZEN tax columns, never recomputed — the rates were resolved when the order was placed and the catalogue has moved on since. The total is built as `taxable + cgst + sgst + igst + cess + roundOff` rather than copied from the order header, which also carries shipping and COD fees.

The number comes from `document_number_series` under a row lock, because a gap in a statutory series is a compliance problem. If no active series exists for the current financial year this returns 422 rather than improvising one. Every line needs an HSN code — GSTR-1 requires an HSN-wise summary.

Idempotent: an order that already has an issued invoice returns that invoice with `alreadyIssued: true`.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | Order id. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The invoice.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "invoiceNo": "PRD-2026-00001",
    "alreadyIssued": false
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such order. |
| `422` | Not invoiceable yet, no numbering series, an unknown supplier state, or a line with no HSN. |

---

### `POST /v1/admin/orders/:orderId/courier`

**Assign a courier to an order**

| | |
|---|---|
| operationId | `adminAssignOrderCourier` |
| Auth | Bearer staff token |
| Permission | `delivery:edit` |

Attaches the courier to the order’s open (`label_created`) shipment, creating one from the fulfilment warehouse — or the default warehouse — if none exists yet. A COD order carries its outstanding balance onto the shipment as `codAmountPaise`. Reuses the open shipment rather than creating a second row, so packing and dispatch do not produce two parcels for one box.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | Order id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `courierId` | `uuid` | **yes** | — | Courier partner id. |

Example request:

```json
{
  "courierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
}
```

**Response `200`** — The shipment the courier was attached to.

```json
{
  "type": "success",
  "result": {
    "shipmentId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "shipmentNo": "PRD-2026-00001"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such order, or no such courier. |
| `422` | No fulfilment warehouse and no default warehouse configured. |

---

### `POST /v1/admin/orders/:orderId/notes`

**Add an internal note**

| | |
|---|---|
| operationId | `adminAddOrderNote` |
| Auth | Bearer staff token |
| Permission | `orders:edit` |

Appends to `orders.internal_notes` AND writes a timeline event. The column is the convenience view; the timeline is the record that cannot be edited. Never shown to the customer.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | Order id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `note` | `string` | **yes** | min 1, max 2000 | Internal note. Appended to the timeline, never shown to the customer. |

Example request:

```json
{
  "note": "Damaged in transit"
}
```

**Response `200`** — The note, as stored.

```json
{
  "type": "success",
  "result": {
    "note": "Damaged in transit"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such order. |

---
