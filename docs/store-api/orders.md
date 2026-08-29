# Orders

4 endpoints — 3 require a signed-in customer, 1 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/account/orders`](#get-v1-account-orders) 🔒 — List my orders
- [`GET /v1/account/orders/:orderId`](#get-v1-account-orders-orderid) 🔒 — Get one of my orders
- [`POST /v1/account/orders/:orderId/cancel`](#post-v1-account-orders-orderid-cancel) 🔒 — Cancel one of my orders
- [`GET /v1/orders/track`](#get-v1-orders-track) — Track an order without signing in

---

### `GET /v1/account/orders`

**List my orders**

| | |
|---|---|
| operationId | `listMyOrders` |
| Auth | **Bearer customer token required** |

Newest first. `status` is the real sixteen-value operational status driven by fulfilment and gateway events; `trackingStage` is the five-stage projection the UI renders. `canCancel` tells you whether to show the cancel button — the API re-checks it under a row lock anyway. Wrapped as `{ data, meta }` with `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `status` | `"pending_payment" \| "paid" \| "confirmed" \| "in_production" \| "personalisation_pending" \| "quality_check" \| "packed" \| "ready_to_ship" \| "shipped" \| "out_for_delivery" \| "delivered" \| "failed_delivery" \| "rto" \| "cancelled" \| "refund_initiated" \| "refunded"` | no | — | Filter to a single operational status. |

**Response `200`** — A page of orders.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "orderNo": "ACH-2026-00042",
      "status": "pending_payment",
      "paymentStatus": "string",
      "trackingStage": "placed",
      "placedAt": "2026-08-25T10:30:00.000Z",
      "itemCount": 3,
      "totalPaise": 149900,
      "currency": "INR",
      "deliveryType": "string",
      "requestedDeliveryDate": "string",
      "canCancel": false,
      "thumbnailUrl": "https://cdn.achichiz.in/media/diya.jpg"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 24,
    "total": 1,
    "totalPages": 1
  }
}
```

---

### `GET /v1/account/orders/:orderId`

**Get one of my orders**

| | |
|---|---|
| operationId | `getMyOrder` |
| Auth | **Bearer customer token required** |

Everything the order page renders: the frozen address and buyer snapshots, the per-line GST breakdown, add-ons, personalisation instructions, and the append-only timeline. An order id that is not yours returns 404, not 403 — confirming that an order exists is itself a leak.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | Order id from `GET /v1/account/orders`. |

**Response `200`** — The order.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "orderNo": "ACH-2026-00042",
    "status": "pending_payment",
    "paymentStatus": "string",
    "trackingStage": "placed",
    "placedAt": "2026-08-25T10:30:00.000Z",
    "itemCount": 3,
    "totalPaise": 149900,
    "currency": "INR",
    "deliveryType": "string",
    "requestedDeliveryDate": "string",
    "canCancel": false,
    "thumbnailUrl": "https://cdn.achichiz.in/media/diya.jpg",
    "buyerName": "Brass Diya Set",
    "buyerEmail": "priya@example.com",
    "buyerMobile": "9820012345",
    "recipientName": "Brass Diya Set",
    "recipientMobile": "9820012345",
    "giftMessage": "Happy Diwali, with love from the team.",
    "isAnonymousGift": false,
    "shippingAddress": {
      "line1": "12 Linking Road",
      "line2": "Bandra West",
      "area": "Bandra",
      "city": "Mumbai",
      "stateCode": "DIWALI20",
      "pincode": "DIWALI20",
      "countryCode": "DIWALI20"
    },
    "deliverySlot": "string",
    "couponCode": "DIWALI20",
    "subtotalPaise": 149900,
    "couponDiscountPaise": 149900,
    "shippingPaise": 149900,
    "codFeePaise": 149900,
    "taxablePaise": 149900,
    "cgstPaise": 149900,
    "sgstPaise": 149900,
    "igstPaise": 149900,
    "cessPaise": 149900,
    "roundOffPaise": 149900,
    "amountPaidPaise": 149900,
    "amountRefundedPaise": 149900,
    "isInterstate": false,
    "cancelReason": "Please leave with the concierge.",
    "cancelledAt": "2026-08-25T10:30:00.000Z",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "variantLabel": "Small",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "quantity": 2,
        "unitPricePaise": 149900,
        "allocatedOrderDiscountPaise": 149900,
        "grossPaise": 149900,
        "gstRateBp": 1000,
        "taxablePaise": 149900,
        "cgstPaise": 149900,
        "sgstPaise": 149900,
        "igstPaise": 149900,
        "cessPaise": 149900,
        "fulfilmentStatus": "string",
        "addOns": [
          {
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "quantity": 2,
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
        "label": "Home",
        "note": "Please leave with the concierge.",
        "actorKind": "customer",
        "actorLabel": "string"
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such order, or it belongs to someone else. |

---

### `POST /v1/account/orders/:orderId/cancel`

**Cancel one of my orders**

| | |
|---|---|
| operationId | `cancelMyOrder` |
| Auth | **Bearer customer token required** |

The only state transition a customer owns, and only from a pre-shipped state (`pending_payment`, `paid`, `confirmed`, `in_production`, `personalisation_pending`, `quality_check`, `packed`, `ready_to_ship`). Anything later returns 422 `order_not_cancellable` with the reason — once a courier has it, cancelling is a return, not an update.

In one transaction it releases the stock reservation, returns the coupon redemption to the pool, stamps the cancellation and appends a timeline event. An order that was actually paid moves to `refund_initiated`, not `cancelled`, and a gateway refund is started afterwards — only the gateway’s confirmation moves it to `refunded`, because telling someone their money is back before it is would be a lie.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | Order id from `GET /v1/account/orders`. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `reason` | `string` | no | max 400 | Why you are cancelling. Stored on the order and shown to ops. |

Example request:

```json
{
  "reason": "Please leave with the concierge."
}
```

**Response `200`** — The cancelled order.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "orderNo": "ACH-2026-00042",
    "status": "pending_payment",
    "paymentStatus": "string",
    "trackingStage": "placed",
    "placedAt": "2026-08-25T10:30:00.000Z",
    "itemCount": 3,
    "totalPaise": 149900,
    "currency": "INR",
    "deliveryType": "string",
    "requestedDeliveryDate": "string",
    "canCancel": false,
    "thumbnailUrl": "https://cdn.achichiz.in/media/diya.jpg",
    "buyerName": "Brass Diya Set",
    "buyerEmail": "priya@example.com",
    "buyerMobile": "9820012345",
    "recipientName": "Brass Diya Set",
    "recipientMobile": "9820012345",
    "giftMessage": "Happy Diwali, with love from the team.",
    "isAnonymousGift": false,
    "shippingAddress": {
      "line1": "12 Linking Road",
      "line2": "Bandra West",
      "area": "Bandra",
      "city": "Mumbai",
      "stateCode": "DIWALI20",
      "pincode": "DIWALI20",
      "countryCode": "DIWALI20"
    },
    "deliverySlot": "string",
    "couponCode": "DIWALI20",
    "subtotalPaise": 149900,
    "couponDiscountPaise": 149900,
    "shippingPaise": 149900,
    "codFeePaise": 149900,
    "taxablePaise": 149900,
    "cgstPaise": 149900,
    "sgstPaise": 149900,
    "igstPaise": 149900,
    "cessPaise": 149900,
    "roundOffPaise": 149900,
    "amountPaidPaise": 149900,
    "amountRefundedPaise": 149900,
    "isInterstate": false,
    "cancelReason": "Please leave with the concierge.",
    "cancelledAt": "2026-08-25T10:30:00.000Z",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "variantLabel": "Small",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "quantity": 2,
        "unitPricePaise": 149900,
        "allocatedOrderDiscountPaise": 149900,
        "grossPaise": 149900,
        "gstRateBp": 1000,
        "taxablePaise": 149900,
        "cgstPaise": 149900,
        "sgstPaise": 149900,
        "igstPaise": 149900,
        "cessPaise": 149900,
        "fulfilmentStatus": "string",
        "addOns": [
          {
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "quantity": 2,
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
        "label": "Home",
        "note": "Please leave with the concierge.",
        "actorKind": "customer",
        "actorLabel": "string"
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such order, or it belongs to someone else. |
| `422` | The order has moved past the point where a customer may cancel it. |

---

### `GET /v1/orders/track`

**Track an order without signing in**

| | |
|---|---|
| operationId | `trackOrder` |
| Auth | Public — no token needed |

Backs the public tracking page. Requires the order number AND a matching mobile number — either the buyer’s or the recipient’s, because the person chasing a gift is often the recipient. Order numbers are sequential and therefore guessable, so the mobile number is the actual secret; a wrong number and a non-existent order return the same 404.

Each stage carries the timestamp of the event that actually happened, or null. Nothing here is derived from elapsed time, and no address, email, name or price is returned.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderNo` | `string` | **yes** | — | The order number from the confirmation email. |
| `mobile` | `string` | **yes** | — | The buyer’s or recipient’s mobile number. Both must match — the number is the shared secret. |

**Response `200`** — The tracking view.

```json
{
  "type": "success",
  "result": {
    "orderNo": "ACH-2026-00042",
    "status": "pending_payment",
    "currentStage": "placed",
    "statusNote": "Please leave with the concierge.",
    "stages": [
      {
        "id": "placed",
        "label": "Home",
        "completedAt": "2026-08-25T10:30:00.000Z",
        "note": "Please leave with the concierge."
      }
    ],
    "placedAt": "2026-08-25T10:30:00.000Z",
    "estimatedDeliveryDate": "string",
    "deliveredAt": "2026-08-25T10:30:00.000Z",
    "itemCount": 3
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No order matches that number and mobile number. |

---
