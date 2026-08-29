# Checkout

2 endpoints — 2 require a signed-in customer, 0 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`POST /v1/checkout/quote`](#post-v1-checkout-quote) 🔒 — Price a cart for a destination, delivery method and payment method
- [`POST /v1/orders`](#post-v1-orders) 🔒 — Place the order

---

### `POST /v1/checkout/quote`

**Price a cart for a destination, delivery method and payment method**

| | |
|---|---|
| operationId | `createCheckoutQuote` |
| Auth | **Bearer customer token required** |

The review step, and the only honest source of a total. Every figure is recomputed here from `product_variants`, `add_ons`, `gst_rates`, `coupons` and `delivery_zones`. There is no request field through which a price, discount or total can be sent, and none would be read if there were. It also answers the three questions the storefront currently guesses: is the PIN code actually serviceable, is cash on delivery allowed there, and which delivery options are live right now (same-day depends on the zone AND on the cutoff not having passed in Asia/Kolkata). Read `warnings` before showing a payment button — that is where a price change, a dropped coupon or a stock shortfall since the cart was last loaded appears. Quoting is free of side effects: no stock is held and no coupon redemption is claimed.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `cartToken` | `string` | no | min 8, max 255 | Opaque cart handle. Omit to quote the signed-in customer’s own cart. |
| `addressId` | `uuid` | no | — | A saved address id. Supply this OR `address`, not both and not neither. |
| `address` | `object` | no | — | A one-off shipping address. |
| `deliveryType` | `"standard" \| "scheduled" \| "same_day" \| "midnight" \| "international"` | no | default `"standard"` | Delivery method. Drives the surcharge (`standard` free, `scheduled` ₹249, `same_day`/`midnight` ₹499) and the courier SLA. Server-side constants — the client cannot set a shipping amount. |
| `paymentMethod` | `"upi" \| "credit_card" \| "debit_card" \| "net_banking" \| "wallet" \| "cod"` | no | default `"upi"` | How the order will be paid. `cod` requires a COD-eligible PIN code; everything else is prepaid. |
| `couponCode` | `string` | no | max 32 | Coupon to apply for this quote. Omit to use whatever is already on the cart; send an empty string to quote without any coupon. |
| `requestedDeliveryDate` | `string` | no | — | `YYYY-MM-DD` requested delivery date. Must not be in the past in Asia/Kolkata. |
| `deliverySlot` | `string` | no | max 60 | Requested slot, e.g. `09:00 - 12:00`. |

Example request:

```json
{
  "cartToken": "ct_9f1c2a7e3b444d908a11",
  "addressId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "address": {
    "label": "Home",
    "contactName": "Brass Diya Set",
    "mobile": "9820012345",
    "line1": "12 Linking Road",
    "line2": "Bandra West",
    "area": "Bandra",
    "city": "Mumbai",
    "stateCode": "DIWALI20",
    "pincode": "DIWALI20",
    "countryCode": "IN",
    "saveToAddressBook": false
  },
  "deliveryType": "standard",
  "paymentMethod": "upi",
  "couponCode": "DIWALI20",
  "requestedDeliveryDate": "2026-11-01",
  "deliverySlot": "string"
}
```

**Response `200`** — The priced quote.

```json
{
  "type": "success",
  "result": {
    "cartId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "currency": "INR",
    "totals": {
      "lines": [
        {
          "lineId": "string",
          "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
          "quantity": 2,
          "unitPricePaise": 149900,
          "addOnsPaise": 149900,
          "lineTotalPaise": 149900,
          "allocatedOrderDiscountPaise": 149900,
          "grossPaise": 149900,
          "gstRateBp": 1000,
          "taxablePaise": 149900,
          "cgstPaise": 149900,
          "sgstPaise": 149900,
          "igstPaise": 149900,
          "cessPaise": 149900
        }
      ],
      "itemCount": 3,
      "merchandisePaise": 149900,
      "couponCode": "DIWALI20",
      "couponDiscountPaise": 149900,
      "subtotalPaise": 149900,
      "shippingPaise": 149900,
      "codFeePaise": 149900,
      "taxablePaise": 149900,
      "cgstPaise": 149900,
      "sgstPaise": 149900,
      "igstPaise": 149900,
      "cessPaise": 149900,
      "roundOffPaise": 149900,
      "totalPaise": 149900,
      "isInterstate": false
    },
    "serviceable": false,
    "codEligible": false,
    "paymentMethodAllowed": false,
    "estimatedDeliveryDate": "string",
    "deliveryOptions": [
      {
        "deliveryType": "standard",
        "available": false,
        "surchargePaise": 149900,
        "estimatedDeliveryDate": "string",
        "unavailableReason": "Please leave with the concierge."
      }
    ],
    "placeOfSupplyStateCode": "DIWALI20",
    "warnings": [
      "string"
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such cart, or the address does not belong to the caller. |
| `422` | The cart is empty, or the coupon/address is invalid. |

---

### `POST /v1/orders`

**Place the order**

| | |
|---|---|
| operationId | `createOrder` |
| Auth | **Bearer customer token required** |

Converts the cart into an order in one transaction. Every figure is recomputed here from `product_variants`, `add_ons`, `gst_rates`, `coupons` and `delivery_zones`. There is no request field through which a price, discount or total can be sent, and none would be read if there were. 

What happens, in order: the cart is re-priced; the coupon redemption is claimed with a conditional UPDATE that cannot over-redeem; stock is reserved with `UPDATE … WHERE on_hand − reserved >= qty` after locking every affected row in id order (so concurrent checkouts cannot deadlock and cannot oversell); the order number is drawn from the `document_number_series` counter; the header and lines are written; and the commit re-proves the totals against the lines through the deferred `check_order_totals()` trigger. Anything that fails rolls all of it back — including the coupon count and the stock hold.

**An `Idempotency-Key` header is required.** Retrying with the same key and the same body replays the stored response instead of creating a second order; the same key with a different body is a 409. Use a UUID and keep it for the whole retry sequence.

Prepaid orders come back `pending_payment` with a Razorpay session in `payment`; the order is confirmed by the webhook, never by the browser. COD orders come back `confirmed` / `cod_due` provided the PIN code allows it.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `cartToken` | `string` | no | min 8, max 255 | Opaque cart handle. Omit to quote the signed-in customer’s own cart. |
| `addressId` | `uuid` | no | — | A saved address id. Supply this OR `address`, not both and not neither. |
| `address` | `object` | no | — | A one-off shipping address. |
| `deliveryType` | `"standard" \| "scheduled" \| "same_day" \| "midnight" \| "international"` | no | default `"standard"` | Delivery method. Drives the surcharge (`standard` free, `scheduled` ₹249, `same_day`/`midnight` ₹499) and the courier SLA. Server-side constants — the client cannot set a shipping amount. |
| `paymentMethod` | `"upi" \| "credit_card" \| "debit_card" \| "net_banking" \| "wallet" \| "cod"` | no | default `"upi"` | How the order will be paid. `cod` requires a COD-eligible PIN code; everything else is prepaid. |
| `couponCode` | `string` | no | max 32 | Coupon to apply for this quote. Omit to use whatever is already on the cart; send an empty string to quote without any coupon. |
| `requestedDeliveryDate` | `string` | no | — | `YYYY-MM-DD` requested delivery date. Must not be in the past in Asia/Kolkata. |
| `deliverySlot` | `string` | no | max 60 | Requested slot, e.g. `09:00 - 12:00`. |
| `recipientName` | `string` | no | max 120 | Gift recipient, when it is not the buyer. Frozen onto the order. |
| `recipientMobile` | `string` | no | — | Recipient’s mobile, for the delivery call. |
| `isGift` | `boolean` | no | default `false` | Marks the parcel as a gift — no price slip in the box. |
| `isAnonymousGift` | `boolean` | no | default `false` | Hide the buyer’s identity from the recipient. |
| `giftMessage` | `string` | no | max 240 | Gift card message. Hard-capped at 240 characters server-side; the HTML maxlength is not the rule. |
| `buyerName` | `string` | no | min 2, max 120 | Buyer name. Defaults to the account name, then to the shipping contact name. |
| `buyerEmail` | `email` | no | — | Where the confirmation and invoice go. |
| `buyerMobile` | `string` | no | — | Buyer’s mobile. Defaults to the account mobile. |
| `billGstin` | `string` | no | min 15, max 15 | Buyer GSTIN for an input-tax-credit invoice. Validated by a DB domain, so it must be well-formed. |

Example request:

```json
{
  "cartToken": "ct_9f1c2a7e3b444d908a11",
  "addressId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "address": {
    "label": "Home",
    "contactName": "Brass Diya Set",
    "mobile": "9820012345",
    "line1": "12 Linking Road",
    "line2": "Bandra West",
    "area": "Bandra",
    "city": "Mumbai",
    "stateCode": "DIWALI20",
    "pincode": "DIWALI20",
    "countryCode": "IN",
    "saveToAddressBook": false
  },
  "deliveryType": "standard",
  "paymentMethod": "upi",
  "couponCode": "DIWALI20",
  "requestedDeliveryDate": "2026-11-01",
  "deliverySlot": "string",
  "recipientName": "Brass Diya Set",
  "recipientMobile": "9820012345",
  "isGift": false,
  "isAnonymousGift": false,
  "giftMessage": "Happy Diwali, with love from the team.",
  "buyerName": "Brass Diya Set",
  "buyerEmail": "priya@example.com",
  "buyerMobile": "9820012345",
  "billGstin": "string"
}
```

**Response `201`** — The order, and a payment session when prepaid.

```json
{
  "type": "success",
  "result": {
    "orderId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "orderNo": "ACH-2026-00042",
    "status": "active",
    "paymentStatus": "string",
    "totalPaise": 149900,
    "currency": "INR",
    "placedAt": "2026-08-25T10:30:00.000Z",
    "totals": {
      "lines": [
        {
          "lineId": "string",
          "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
          "quantity": 2,
          "unitPricePaise": 149900,
          "addOnsPaise": 149900,
          "lineTotalPaise": 149900,
          "allocatedOrderDiscountPaise": 149900,
          "grossPaise": 149900,
          "gstRateBp": 1000,
          "taxablePaise": 149900,
          "cgstPaise": 149900,
          "sgstPaise": 149900,
          "igstPaise": 149900,
          "cessPaise": 149900
        }
      ],
      "itemCount": 3,
      "merchandisePaise": 149900,
      "couponCode": "DIWALI20",
      "couponDiscountPaise": 149900,
      "subtotalPaise": 149900,
      "shippingPaise": 149900,
      "codFeePaise": 149900,
      "taxablePaise": 149900,
      "cgstPaise": 149900,
      "sgstPaise": 149900,
      "igstPaise": 149900,
      "cessPaise": 149900,
      "roundOffPaise": 149900,
      "totalPaise": 149900,
      "isInterstate": false
    },
    "payment": {
      "gateway": "razorpay",
      "keyId": "string",
      "razorpayOrderId": "order_Pq1XyZaBcDeFgH",
      "amountPaise": 149900,
      "currency": "INR"
    }
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | The `Idempotency-Key` header is missing or malformed. |
| `404` | No such cart, or the address does not belong to the caller. |
| `409` | That `Idempotency-Key` is in flight, or was used with a different body. |
| `422` | Empty cart, an item went out of stock, the coupon stopped applying, the PIN code is unserviceable, or COD is not allowed there. |

---
