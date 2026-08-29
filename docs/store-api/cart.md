# Cart

8 endpoints — 1 require a signed-in customer, 7 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/cart`](#get-v1-cart) — Get the current cart
- [`POST /v1/cart/lines`](#post-v1-cart-lines) — Add a line to the cart
- [`PATCH /v1/cart/lines/:lineId`](#patch-v1-cart-lines-lineid) — Change a cart line’s quantity or personalisation
- [`DELETE /v1/cart/lines/:lineId`](#delete-v1-cart-lines-lineid) — Remove a cart line
- [`DELETE /v1/cart`](#delete-v1-cart) — Empty the cart
- [`POST /v1/cart/coupon`](#post-v1-cart-coupon) — Apply a coupon to the cart
- [`DELETE /v1/cart/coupon`](#delete-v1-cart-coupon) — Remove the cart’s coupon
- [`POST /v1/cart/merge`](#post-v1-cart-merge) 🔒 — Attach a guest cart to the signed-in account

---

### `GET /v1/cart`

**Get the current cart**

| | |
|---|---|
| operationId | `getCart` |
| Auth | Public — no token needed |

The whole basket with server-computed totals. An unknown or missing token returns an empty cart rather than a 404, so a first-time visitor renders without special-casing. Totals are recomputed server-side on every call from live variant and add-on prices — the response never echoes a number the client sent. Shipping assumes standard delivery until an address is supplied at `POST /v1/checkout/quote`. A coupon that has expired, been exhausted or stopped qualifying is dropped here and reported in `totals.couponCode: null` — it is re-validated on every read, not only when it was applied. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `cartToken` | `string` | no | min 8, max 255 | Opaque cart handle. Prefer the `X-Cart-Token` header; this exists for GET/DELETE convenience. |

**Response `200`** — The cart. Empty when no cart exists yet.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "token": "ct_9f1c2a7e3b444d908a11",
    "stage": "cart",
    "couponCode": "DIWALI20",
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "lineKey": "variant:2e8b1d45|addon:card",
        "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "productId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "productHandle": "brass-diya-set",
        "title": "Brass Diya Set",
        "variantLabel": "Small",
        "sku": "ACH-CAN-001",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "quantity": 2,
        "unitPricePaise": 149900,
        "addOns": [
          {
            "addOnId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
            "code": "DIWALI20",
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "inputText": "string"
          }
        ],
        "addOnsPaise": 149900,
        "personalisation": {},
        "lineTotalPaise": 149900,
        "availableQty": 2,
        "inStock": false,
        "priceChanged": false
      }
    ],
    "totals": {
      "lines": [
        {
          "lineId": "string",
          "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
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
    "itemCount": 3,
    "hasUnavailableLines": false,
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

---

### `POST /v1/cart/lines`

**Add a line to the cart**

| | |
|---|---|
| operationId | `addCartLine` |
| Auth | Public — no token needed |

Adds a variant, its add-ons and its personalisation. Adding an identical configuration sums the quantities instead of creating a second line — “identical” means the same variant, the same add-ons with the same text, and the same personalisation. Quantity is checked against live available stock (on-hand minus reserved) and rejected with 422 `insufficient_stock` when it exceeds it; stock is NOT reserved here, only at order creation. Personalisation is capped server-side at 24 characters for a name, 180 for a message and 240 for a gift message. Omit `cartToken` on the very first add: the response `token` is the handle to keep. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `cartToken` | `string` | no | min 8, max 255 | Opaque cart handle. Omit on the first add — the response mints one and returns it as `token`. May also be sent as the `X-Cart-Token` request header. |
| `variantId` | `uuid` | **yes** | — | The variant to add. Cart lines reference a variant, never a product. |
| `quantity` | `integer` | no | default `1`, ≥ 1, ≤ 99 | Units to add. Adding to a line that already exists sums the quantities. |
| `addOns` | `object[]` | no | default `[]`, max 10 items | Chosen add-ons. A different add-on set makes a different cart line, not a merged one. |
| `personalisation` | `object` | no | — | Personalisation inputs keyed by field name, e.g. `{ "Name": "Aarav", "Message": "Happy Diwali" }`. Per-key character limits (Name 24, Message 180, Gift message 240) are enforced HERE, server-side — the PDP `maxlength` attribute is decoration. |
| `builderTemplateId` | `uuid` | no | — | Build-your-own-hamper template. NOT YET SUPPORTED — a builder line reserves its bill-of-materials components rather than a variant, and the pricing engine has no BOM path. Sending it returns 422 `builder_lines_unsupported` rather than silently dropping the hamper. |
| `builderConfig` | `any` | no | — | Chosen option ids for a built hamper. See `builderTemplateId`. |

Example request:

```json
{
  "cartToken": "ct_9f1c2a7e3b444d908a11",
  "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "quantity": 1,
  "addOns": [],
  "personalisation": {},
  "builderTemplateId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "builderConfig": null
}
```

**Response `200`** — The updated cart.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "token": "ct_9f1c2a7e3b444d908a11",
    "stage": "cart",
    "couponCode": "DIWALI20",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "lineKey": "variant:2e8b1d45|addon:card",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "productId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "productHandle": "brass-diya-set",
        "title": "Brass Diya Set",
        "variantLabel": "Small",
        "sku": "ACH-CAN-001",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "quantity": 2,
        "unitPricePaise": 149900,
        "addOns": [
          {
            "addOnId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
            "code": "DIWALI20",
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "inputText": "string"
          }
        ],
        "addOnsPaise": 149900,
        "personalisation": {},
        "lineTotalPaise": 149900,
        "availableQty": 2,
        "inStock": false,
        "priceChanged": false
      }
    ],
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
    "itemCount": 3,
    "hasUnavailableLines": false,
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such cart token, or no such purchasable variant. |
| `422` | Out of stock, personalisation too long, or a builder line was sent. |

---

### `PATCH /v1/cart/lines/:lineId`

**Change a cart line’s quantity or personalisation**

| | |
|---|---|
| operationId | `updateCartLine` |
| Auth | Public — no token needed |

`quantity: 0` removes the line, mirroring the storefront’s existing stepper behaviour. Any other quantity is an absolute value, not a delta, and is checked against live stock. Changing the personalisation rewrites the line’s dedupe key, so it will 422 if that would collide with another line already in the cart. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `lineId` | `uuid` | **yes** | — | `cart_lines.id` as returned by `GET /v1/cart`. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `cartToken` | `string` | no | min 8, max 255 | Opaque cart handle, or send `X-Cart-Token`. |
| `quantity` | `integer` | **yes** | ≥ 0, ≤ 99 | New absolute quantity. Zero removes the line, mirroring the storefront’s existing behaviour. |
| `personalisation` | `object` | no | — | Replaces the line’s personalisation when present. |

Example request:

```json
{
  "cartToken": "ct_9f1c2a7e3b444d908a11",
  "quantity": 2,
  "personalisation": {}
}
```

**Response `200`** — The updated cart.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "token": "ct_9f1c2a7e3b444d908a11",
    "stage": "cart",
    "couponCode": "DIWALI20",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "lineKey": "variant:2e8b1d45|addon:card",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "productId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "productHandle": "brass-diya-set",
        "title": "Brass Diya Set",
        "variantLabel": "Small",
        "sku": "ACH-CAN-001",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "quantity": 2,
        "unitPricePaise": 149900,
        "addOns": [
          {
            "addOnId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
            "code": "DIWALI20",
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "inputText": "string"
          }
        ],
        "addOnsPaise": 149900,
        "personalisation": {},
        "lineTotalPaise": 149900,
        "availableQty": 2,
        "inStock": false,
        "priceChanged": false
      }
    ],
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
    "itemCount": 3,
    "hasUnavailableLines": false,
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such cart or no such line in it. |
| `422` | Not enough stock, personalisation too long, or a duplicate line. |

---

### `DELETE /v1/cart/lines/:lineId`

**Remove a cart line**

| | |
|---|---|
| operationId | `removeCartLine` |
| Auth | Public — no token needed |

Deletes the line and its add-ons. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `lineId` | `uuid` | **yes** | — | `cart_lines.id` as returned by `GET /v1/cart`. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `cartToken` | `string` | no | min 8, max 255 | Opaque cart handle. Prefer the `X-Cart-Token` header; this exists for GET/DELETE convenience. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The updated cart.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "token": "ct_9f1c2a7e3b444d908a11",
    "stage": "cart",
    "couponCode": "DIWALI20",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "lineKey": "variant:2e8b1d45|addon:card",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "productId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "productHandle": "brass-diya-set",
        "title": "Brass Diya Set",
        "variantLabel": "Small",
        "sku": "ACH-CAN-001",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "quantity": 2,
        "unitPricePaise": 149900,
        "addOns": [
          {
            "addOnId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
            "code": "DIWALI20",
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "inputText": "string"
          }
        ],
        "addOnsPaise": 149900,
        "personalisation": {},
        "lineTotalPaise": 149900,
        "availableQty": 2,
        "inStock": false,
        "priceChanged": false
      }
    ],
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
    "itemCount": 3,
    "hasUnavailableLines": false,
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such cart or no such line in it. |

---

### `DELETE /v1/cart`

**Empty the cart**

| | |
|---|---|
| operationId | `clearCart` |
| Auth | Public — no token needed |

Removes every line and the coupon. The cart row and its token survive, so the same handle keeps working. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `cartToken` | `string` | no | min 8, max 255 | Opaque cart handle. Prefer the `X-Cart-Token` header; this exists for GET/DELETE convenience. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The now-empty cart.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "token": "ct_9f1c2a7e3b444d908a11",
    "stage": "cart",
    "couponCode": "DIWALI20",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "lineKey": "variant:2e8b1d45|addon:card",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "productId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "productHandle": "brass-diya-set",
        "title": "Brass Diya Set",
        "variantLabel": "Small",
        "sku": "ACH-CAN-001",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "quantity": 2,
        "unitPricePaise": 149900,
        "addOns": [
          {
            "addOnId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
            "code": "DIWALI20",
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "inputText": "string"
          }
        ],
        "addOnsPaise": 149900,
        "personalisation": {},
        "lineTotalPaise": 149900,
        "availableQty": 2,
        "inStock": false,
        "priceChanged": false
      }
    ],
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
    "itemCount": 3,
    "hasUnavailableLines": false,
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such cart token. |

---

### `POST /v1/cart/coupon`

**Apply a coupon to the cart**

| | |
|---|---|
| operationId | `applyCartCoupon` |
| Auth | Public — no token needed |

Validated against the live `coupons` table — status, start and end dates, global redemption cap, per-customer cap, minimum order value, and product/collection eligibility. Each failure returns a distinct stable `code` (`coupon_not_found`, `coupon_expired`, `coupon_exhausted`, `coupon_min_not_met`, `coupon_not_applicable`, `coupon_first_order_only`, …) so the frontend can explain itself rather than saying “invalid code”. Applying a coupon does not reserve a redemption; that is claimed atomically at order creation. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `cartToken` | `string` | no | min 8, max 255 | Opaque cart handle, or send `X-Cart-Token`. |
| `code` | `string` | **yes** | min 3, max 32 | Coupon code, case-insensitive. Validated against the live `coupons` table, never a hardcoded list. |

Example request:

```json
{
  "cartToken": "ct_9f1c2a7e3b444d908a11",
  "code": "DIWALI20"
}
```

**Response `200`** — The cart, repriced with the coupon.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "token": "ct_9f1c2a7e3b444d908a11",
    "stage": "cart",
    "couponCode": "DIWALI20",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "lineKey": "variant:2e8b1d45|addon:card",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "productId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "productHandle": "brass-diya-set",
        "title": "Brass Diya Set",
        "variantLabel": "Small",
        "sku": "ACH-CAN-001",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "quantity": 2,
        "unitPricePaise": 149900,
        "addOns": [
          {
            "addOnId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
            "code": "DIWALI20",
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "inputText": "string"
          }
        ],
        "addOnsPaise": 149900,
        "personalisation": {},
        "lineTotalPaise": 149900,
        "availableQty": 2,
        "inStock": false,
        "priceChanged": false
      }
    ],
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
    "itemCount": 3,
    "hasUnavailableLines": false,
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such cart token. |
| `422` | The coupon does not exist, is not live, or does not apply to this cart. |

---

### `DELETE /v1/cart/coupon`

**Remove the cart’s coupon**

| | |
|---|---|
| operationId | `removeCartCoupon` |
| Auth | Public — no token needed |

Clears the coupon and reprices. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `cartToken` | `string` | no | min 8, max 255 | Opaque cart handle. Prefer the `X-Cart-Token` header; this exists for GET/DELETE convenience. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The cart, repriced without the coupon.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "token": "ct_9f1c2a7e3b444d908a11",
    "stage": "cart",
    "couponCode": "DIWALI20",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "lineKey": "variant:2e8b1d45|addon:card",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "productId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "productHandle": "brass-diya-set",
        "title": "Brass Diya Set",
        "variantLabel": "Small",
        "sku": "ACH-CAN-001",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "quantity": 2,
        "unitPricePaise": 149900,
        "addOns": [
          {
            "addOnId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
            "code": "DIWALI20",
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "inputText": "string"
          }
        ],
        "addOnsPaise": 149900,
        "personalisation": {},
        "lineTotalPaise": 149900,
        "availableQty": 2,
        "inStock": false,
        "priceChanged": false
      }
    ],
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
    "itemCount": 3,
    "hasUnavailableLines": false,
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such cart token. |

---

### `POST /v1/cart/merge`

**Attach a guest cart to the signed-in account**

| | |
|---|---|
| operationId | `mergeCart` |
| Auth | **Bearer customer token required** |

Call this once immediately after login. With `cartToken`, the guest cart’s lines are folded into the account’s cart — identical configurations have their quantities summed, everything else is moved across — and the guest cart is discarded. Without `cartToken`, it simply returns (creating if needed) the account’s own cart, which is how a second device obtains a handle. No price is carried over: every line is re-priced from the catalogue, and the coupon is re-validated. **Use the `token` in the response from this point on** — the guest token is dead.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `cartToken` | `string` | no | min 8, max 255 | The guest cart to fold in. Omit to simply fetch (or create) the signed-in customer’s own cart — which is how a second device gets its cart handle. |

Example request:

```json
{
  "cartToken": "ct_9f1c2a7e3b444d908a11"
}
```

**Response `200`** — The account’s cart, after the merge.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "token": "ct_9f1c2a7e3b444d908a11",
    "stage": "cart",
    "couponCode": "DIWALI20",
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "lineKey": "variant:2e8b1d45|addon:card",
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "productId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "productHandle": "brass-diya-set",
        "title": "Brass Diya Set",
        "variantLabel": "Small",
        "sku": "ACH-CAN-001",
        "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
        "quantity": 2,
        "unitPricePaise": 149900,
        "addOns": [
          {
            "addOnId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
            "code": "DIWALI20",
            "name": "Brass Diya Set",
            "pricePaise": 149900,
            "inputText": "string"
          }
        ],
        "addOnsPaise": 149900,
        "personalisation": {},
        "lineTotalPaise": 149900,
        "availableQty": 2,
        "inStock": false,
        "priceChanged": false
      }
    ],
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
    "itemCount": 3,
    "hasUnavailableLines": false,
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | The supplied cart token belongs to a different account. |

---
