# Account

5 endpoints — 5 require a signed-in customer, 0 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/account/profile`](#get-v1-account-profile) 🔒 — Get my profile
- [`PATCH /v1/account/profile`](#patch-v1-account-profile) 🔒 — Update my profile
- [`GET /v1/account/wishlist`](#get-v1-account-wishlist) 🔒 — List my wishlist
- [`POST /v1/account/wishlist`](#post-v1-account-wishlist) 🔒 — Save a product to my wishlist
- [`DELETE /v1/account/wishlist/:productId`](#delete-v1-account-wishlist-productid) 🔒 — Remove a product from my wishlist

---

### `GET /v1/account/profile`

**Get my profile**

| | |
|---|---|
| operationId | `getMyProfile` |
| Auth | **Bearer customer token required** |

The full account record, including the two fields the storefront currently keeps in `localStorage` and therefore loses on a device change: `birthday` and the marketing toggle. `hasPassword` is false on an OTP-created account — use it to decide whether to offer “set a password” rather than “change password”.

**Response `200`** — The signed-in customer’s profile.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "fullName": "Brass Diya Set",
    "email": "priya@example.com",
    "mobile": "9820012345",
    "birthday": "string",
    "gender": "female",
    "emailVerified": false,
    "mobileVerified": false,
    "marketingOptIn": false,
    "whatsappOptIn": false,
    "hasPassword": false,
    "acceptsCod": false,
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | Missing, expired or revoked access token. |

---

### `PATCH /v1/account/profile`

**Update my profile**

| | |
|---|---|
| operationId | `updateMyProfile` |
| Auth | **Bearer customer token required** |

A true PATCH — only the fields present are touched, and `{}` is a valid no-op. `birthday` and `gender` accept `null` to clear them; `email` and `mobile` do not, because the `customer_needs_a_handle` constraint requires at least one of the two and clearing the last one would surface as a database error rather than a field message.

**Changing `email` clears `emailVerified`; changing `mobile` clears `mobileVerified`.** Otherwise the profile form would be a way to mint a verified address you do not control. Re-verify a new mobile with `POST /v1/auth/otp/request`.

Toggling `marketingOptIn` in either direction writes a timestamped, sourced record to the append-only consent log. An address or number already in use on another account returns 409.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `fullName` | `string` | no | min 2, max 120 | Display name, as it should appear on a parcel. |
| `email` | `email` | no | max 255 | New email address. Changing it clears `emailVerified` — the new address has not been proven. An address already in use returns 409. |
| `mobile` | `string` | no | — | New ten-digit mobile. Changing it clears `mobileVerified`; verify the new number with an OTP. A number already in use returns 409. |
| `birthday` | `string` | no | — | `YYYY-MM-DD`, or null to clear. Drives birthday gifting reminders. |
| `gender` | `"female" \| "male" \| "other" \| "undisclosed"` | no | — | Or null to clear. |
| `marketingOptIn` | `boolean` | no | — | Turn marketing email/SMS on or off. Both directions are recorded in the append-only consent log with a timestamp and a source — the boolean alone cannot evidence consent. |
| `whatsappOptIn` | `boolean` | no | — | Turn WhatsApp messaging on or off. |

Example request:

```json
{
  "fullName": "Brass Diya Set",
  "email": "priya@example.com",
  "mobile": "9820012345",
  "birthday": "string",
  "gender": "female",
  "marketingOptIn": false,
  "whatsappOptIn": false
}
```

**Response `200`** — The updated profile.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "fullName": "Brass Diya Set",
    "email": "priya@example.com",
    "mobile": "9820012345",
    "birthday": "string",
    "gender": "female",
    "emailVerified": false,
    "mobileVerified": false,
    "marketingOptIn": false,
    "whatsappOptIn": false,
    "hasPassword": false,
    "acceptsCod": false,
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `409` | That email address or mobile number belongs to another account. |

---

### `GET /v1/account/wishlist`

**List my wishlist**

| | |
|---|---|
| operationId | `listMyWishlist` |
| Auth | **Bearer customer token required** |

Newest first, wrapped as `{ data, meta }`. Price, image and stock are read live on every request, so a saved product shows its current price rather than the one it had when it was hearted.

A product that has since been unpublished or deleted still appears, with `available: false`. Dropping it silently would give the customer a shorter list with no explanation; this way the UI can say “no longer available” and offer to remove it.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |

**Response `200`** — A page of wishlist items.

```json
{
  "type": "success",
  "result": [
    {
      "productId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "handle": "brass-diya-set",
      "title": "Brass Diya Set",
      "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
      "fromPricePaise": 149900,
      "inStock": false,
      "available": false,
      "addedAt": "2026-08-25T10:30:00.000Z"
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

**Errors**

| Status | Meaning |
|---|---|
| `401` | Missing, expired or revoked access token. |

---

### `POST /v1/account/wishlist`

**Save a product to my wishlist**

| | |
|---|---|
| operationId | `addWishlistItem` |
| Auth | **Bearer customer token required** |

Keyed by product id, not handle — a handle can be edited in the admin, and the storefront’s handle-keyed `localStorage` wishlist silently loses its entry when that happens.

Idempotent: saving something already saved returns 201 with the same item rather than 409, because a heart icon tapped twice is not an error. An unpublished or unknown product is 404.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `productId` | `uuid` | **yes** | — | The product to save. Must exist and be published. |

Example request:

```json
{
  "productId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
}
```

**Response `201`** — Saved.

```json
{
  "type": "success",
  "result": {
    "productId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "handle": "brass-diya-set",
    "title": "Brass Diya Set",
    "imageUrl": "https://cdn.achichiz.in/media/diya.jpg",
    "fromPricePaise": 149900,
    "inStock": false,
    "available": false,
    "addedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such published product. |

---

### `DELETE /v1/account/wishlist/:productId`

**Remove a product from my wishlist**

| | |
|---|---|
| operationId | `removeWishlistItem` |
| Auth | **Bearer customer token required** |

Removing something that was not saved returns 404 rather than a silent 204 — the storefront’s heart is optimistic, and a 404 is how it learns its local state has drifted and should re-fetch.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `productId` | `uuid` | **yes** | — | `products.id` as returned by `GET /v1/account/wishlist`. |

**Request body** — none. Send `{}` or omit.

**Response `204`** — Removed.

**Errors**

| Status | Meaning |
|---|---|
| `404` | That product is not on your wishlist. |

---
