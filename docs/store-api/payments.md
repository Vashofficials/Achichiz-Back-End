# Payments

2 endpoints — 2 require a signed-in customer, 0 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`POST /v1/payments/razorpay/order`](#post-v1-payments-razorpay-order) 🔒 — Create (or reuse) a Razorpay order for an existing order
- [`POST /v1/payments/razorpay/verify`](#post-v1-payments-razorpay-verify) 🔒 — Verify the Razorpay checkout hand-back

---

### `POST /v1/payments/razorpay/order`

**Create (or reuse) a Razorpay order for an existing order**

| | |
|---|---|
| operationId | `createRazorpayOrder` |
| Auth | **Bearer customer token required** |

`POST /v1/orders` already returns a session for a prepaid order, so this is the retry path — use it when that response came back with `payment: null` (the gateway was unreachable at the time), or when the customer abandoned Checkout and came back to pay later.

The amount is the order’s outstanding balance read from `orders.total_paise`; there is no field through which a client can propose one. An unconsumed session for the same amount is returned again rather than a second one being created, so double-tapping “Pay now” is free. Only `keyId` is returned — the key secret never leaves the server.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | The order to collect payment for. Must belong to the caller. |

Example request:

```json
{
  "orderId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
}
```

**Response `201`** — The payment session to hand to Checkout.js.

```json
{
  "type": "success",
  "result": {
    "gateway": "razorpay",
    "keyId": "string",
    "razorpayOrderId": "order_Pq1XyZaBcDeFgH",
    "amountPaise": 149900,
    "currency": "INR"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such order, or it belongs to someone else. |
| `422` | The order is already paid, or has been cancelled or refunded. |
| `502` | Razorpay could not be reached. Safe to retry. |

---

### `POST /v1/payments/razorpay/verify`

**Verify the Razorpay checkout hand-back**

| | |
|---|---|
| operationId | `verifyRazorpayPayment` |
| Auth | **Bearer customer token required** |

Call this from the Checkout.js success handler with the three identifiers it gives you. The signature — `HMAC-SHA256(razorpay_order_id|razorpay_payment_id)` keyed with the API secret — is verified in constant time, and the Razorpay order is confirmed to belong to this order.

**A valid signature is not proof of payment.** It proves the identifiers are genuine, nothing more; a signed but merely *authorised* payment has taken no money. So the payment is refetched from Razorpay and only a `captured` status is applied. If the webhook already applied it, this returns the same state without double-crediting the order.

A failure here does not mean the payment failed — the webhook remains the source of truth and will confirm the order regardless of whether the browser ever came back.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `orderId` | `uuid` | **yes** | — | The order the payment belongs to. Must belong to the caller. |
| `razorpayOrderId` | `string` | **yes** | min 4, max 64 | `razorpay_order_id` from the Checkout success handler. |
| `razorpayPaymentId` | `string` | **yes** | min 4, max 64 | `razorpay_payment_id` from the Checkout success handler. |
| `razorpaySignature` | `string` | **yes** | min 64, max 64 | HMAC-SHA256 of `razorpay_order_id\|razorpay_payment_id` keyed with the API secret, hex-encoded. Verified in constant time. |

Example request:

```json
{
  "orderId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "razorpayOrderId": "order_Pq1XyZaBcDeFgH",
  "razorpayPaymentId": "pay_Pq1XyZaBcDeFgH",
  "razorpaySignature": "9ef4dffbfd84f1318f6739a3ce19f9d85851857ae648f114332d8401e0949a3d"
}
```

**Response `200`** — The order’s payment state after applying the capture.

```json
{
  "type": "success",
  "result": {
    "orderId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "orderNo": "ACH-2026-00042",
    "status": "active",
    "paymentStatus": "string",
    "amountPaidPaise": 149900,
    "totalPaise": 149900,
    "gatewayPaymentId": "string"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such order, or it belongs to someone else. |
| `422` | The signature did not verify (`signature_invalid`), the Razorpay order belongs to a different order (`payment_order_mismatch`), or the payment is not captured yet (`payment_not_captured`). |
| `502` | Razorpay could not be reached to confirm the payment. |

---
