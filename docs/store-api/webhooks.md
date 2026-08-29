# Webhooks

1 endpoint — 0 require a signed-in customer, 1 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`POST /v1/webhooks/razorpay`](#post-v1-webhooks-razorpay) — Razorpay payment webhook

---

### `POST /v1/webhooks/razorpay`

**Razorpay payment webhook**

| | |
|---|---|
| operationId | `razorpayWebhook` |
| Auth | Public — no token needed |

The authoritative source of payment state. Configure it in the Razorpay dashboard for `payment.captured`, `payment.failed`, `refund.processed` and `refund.failed`.

**Authentication is the `X-Razorpay-Signature` header**, an HMAC-SHA256 of the raw request body keyed with the webhook secret — a different secret from the API key secret. It is computed over the exact bytes received, never over re-serialised JSON, and compared in constant time. A signature that does not verify returns 400 and writes nothing at all, so an unauthenticated caller cannot even fill the event table.

**Replay-safe.** Every delivery is persisted by its `X-Razorpay-Event-Id` (falling back to a hash of the body) into `payment_events`, whose `(gateway, event_id)` uniqueness is the idempotency boundary — the INSERT is the claim. Five deliveries of the same event produce exactly one state change; the rest return `duplicate: true`. Underneath that, capture is keyed on the Razorpay payment id and refunds on the Razorpay refund id, so even a bypassed claim cannot double-credit an order.

A delivery whose processing throws is left unprocessed and answered with 5xx, so Razorpay’s retry does real work rather than being waved through as a duplicate. Unknown event types are acknowledged with 200 — a 4xx would make Razorpay retry something this API will never understand.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `event` | `string` | **yes** | min 3, max 120 | Event name, e.g. `payment.captured`, `payment.failed`, `refund.processed`. |
| `account_id` | `string` | no | — | Razorpay account the event belongs to. |
| `created_at` | `integer` | no | ≥ -9007199254740991 | Unix seconds at which Razorpay created the event. |
| `contains` | `string[]` | no | — | Which entities are present in `payload`. |
| `payload` | `object` | no | — | The entities this event carries. |

Example request:

```json
{
  "event": "string",
  "account_id": "string",
  "created_at": 1,
  "contains": [
    "string"
  ],
  "payload": {
    "payment": {
      "entity": {
        "id": "string",
        "amount": 1,
        "currency": "INR",
        "status": "active",
        "order_id": "string",
        "payment_id": "string",
        "method": "string",
        "error_code": "DIWALI20",
        "error_description": "string"
      }
    },
    "refund": {
      "entity": {
        "id": "string",
        "amount": 1,
        "currency": "INR",
        "status": "active",
        "order_id": "string",
        "payment_id": "string",
        "method": "string",
        "error_code": "DIWALI20",
        "error_description": "string"
      }
    },
    "order": {
      "entity": {
        "id": "string",
        "amount": 1,
        "currency": "INR",
        "status": "active",
        "order_id": "string",
        "payment_id": "string",
        "method": "string",
        "error_code": "DIWALI20",
        "error_description": "string"
      }
    }
  }
}
```

**Response `200`** — Received. `duplicate` is true when the event had already been processed.

```json
{
  "type": "success",
  "result": {
    "received": true,
    "duplicate": false
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | The signature header is missing or does not verify. |

---
