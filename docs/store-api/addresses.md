# Addresses

6 endpoints — 6 require a signed-in customer, 0 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/account/addresses`](#get-v1-account-addresses) 🔒 — List my addresses
- [`GET /v1/account/addresses/:addressId`](#get-v1-account-addresses-addressid) 🔒 — Get one of my addresses
- [`POST /v1/account/addresses`](#post-v1-account-addresses) 🔒 — Add an address
- [`PATCH /v1/account/addresses/:addressId`](#patch-v1-account-addresses-addressid) 🔒 — Update an address
- [`POST /v1/account/addresses/:addressId/default`](#post-v1-account-addresses-addressid-default) 🔒 — Make an address the default
- [`DELETE /v1/account/addresses/:addressId`](#delete-v1-account-addresses-addressid) 🔒 — Delete an address

---

### `GET /v1/account/addresses`

**List my addresses**

| | |
|---|---|
| operationId | `listMyAddresses` |
| Auth | **Bearer customer token required** |

Default first, then oldest first. Not paginated — an address book is a handful of rows, and the checkout screen needs all of them at once to render its picker.

**Response `200`** — Every saved address.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "label": "Home",
      "contactName": "Brass Diya Set",
      "mobile": "9820012345",
      "line1": "12 Linking Road",
      "line2": "Bandra West",
      "area": "Bandra",
      "city": "Mumbai",
      "stateCode": "DIWALI20",
      "pincode": "DIWALI20",
      "countryCode": "DIWALI20",
      "isDefault": false,
      "createdAt": "2026-08-25T10:30:00.000Z",
      "updatedAt": "2026-08-25T10:30:00.000Z"
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

### `GET /v1/account/addresses/:addressId`

**Get one of my addresses**

| | |
|---|---|
| operationId | `getMyAddress` |
| Auth | **Bearer customer token required** |

An id that is not yours returns 404, not 403 — confirming an id exists is itself a leak.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `addressId` | `uuid` | **yes** | — | `addresses.id` as returned by `GET /v1/account/addresses`. |

**Response `200`** — The address.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "label": "Home",
    "contactName": "Brass Diya Set",
    "mobile": "9820012345",
    "line1": "12 Linking Road",
    "line2": "Bandra West",
    "area": "Bandra",
    "city": "Mumbai",
    "stateCode": "DIWALI20",
    "pincode": "DIWALI20",
    "countryCode": "DIWALI20",
    "isDefault": false,
    "createdAt": "2026-08-25T10:30:00.000Z",
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such address, or it belongs to someone else. |

---

### `POST /v1/account/addresses`

**Add an address**

| | |
|---|---|
| operationId | `createMyAddress` |
| Auth | **Bearer customer token required** |

**The first address you save becomes the default automatically**, whether or not `isDefault` was sent — a customer with addresses but no default is a checkout with nothing pre-selected. The storefront does this in the browser today, which means any address created by another path (checkout’s `saveToAddressBook`, an admin, an import) silently misses it.

Passing `isDefault: true` stands the previous default down in the same transaction, in that order — the uniqueness index is partial and cannot be deferred, so the other order is a constraint violation even though the end state would be legal.

`stateCode` is a foreign key to `gst_states`, not free text: it decides the place of supply and therefore whether the order is taxed IGST or CGST+SGST. An unknown code is rejected.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `label` | `string` | no | default `"Home"`, min 1, max 40 | Address-book label, e.g. `Home`, `Office`, `Parents`. Free text — the list groups by it. |
| `contactName` | `string` | **yes** | min 2, max 120 | Who receives the parcel at this address. |
| `mobile` | `string` | **yes** | — | Ten-digit number the courier calls on delivery. Not necessarily the account holder’s. |
| `line1` | `string` | **yes** | min 3, max 200 | House/flat, building, street. |
| `line2` | `string` | no | max 200 | Second address line, if needed. |
| `area` | `string` | no | max 120 | Locality or area. |
| `city` | `string` | **yes** | min 2, max 80 | City. |
| `stateCode` | `string` | **yes** | — | Two-digit GST state code — a foreign key to `gst_states`, not free text. It sets the place of supply, and therefore whether the order is taxed IGST or CGST+SGST. |
| `pincode` | `string` | **yes** | — | Six-digit PIN code. Drives serviceability, same-day eligibility and COD eligibility. |
| `countryCode` | `string` | no | default `"IN"`, min 2, max 2 | ISO-3166-1 alpha-2. Only `IN` is serviceable today, whatever the marketing copy says. |
| `isDefault` | `boolean` | no | — | Make this the default address. The first address you save becomes the default automatically whether or not you ask for it — a customer with addresses but no default is a checkout with nothing pre-selected. |

Example request:

```json
{
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
  "isDefault": false
}
```

**Response `201`** — The saved address.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "label": "Home",
    "contactName": "Brass Diya Set",
    "mobile": "9820012345",
    "line1": "12 Linking Road",
    "line2": "Bandra West",
    "area": "Bandra",
    "city": "Mumbai",
    "stateCode": "DIWALI20",
    "pincode": "DIWALI20",
    "countryCode": "DIWALI20",
    "isDefault": false,
    "createdAt": "2026-08-25T10:30:00.000Z",
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `409` | An unknown `stateCode` — there is no such GST state. |

---

### `PATCH /v1/account/addresses/:addressId`

**Update an address**

| | |
|---|---|
| operationId | `updateMyAddress` |
| Auth | **Bearer customer token required** |

A true PATCH — only the fields present are changed, and `{}` is a valid no-op.

`isDefault: true` promotes this address and stands the incumbent down atomically. `isDefault: false` **on the address that is currently the default is refused** (422 `default_address_required`): while any address exists one of them is the default, so clearing the flag would just cause some other address to be promoted arbitrarily. Use `POST /v1/account/addresses/{addressId}/default` on the address you actually want instead.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `addressId` | `uuid` | **yes** | — | `addresses.id` as returned by `GET /v1/account/addresses`. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `label` | `string` | no | min 1, max 40 | Address-book label, e.g. `Home`, `Office`, `Parents`. Free text — the list groups by it. |
| `contactName` | `string` | no | min 2, max 120 | Who receives the parcel at this address. |
| `mobile` | `string` | no | — | Ten-digit number the courier calls on delivery. Not necessarily the account holder’s. |
| `line1` | `string` | no | min 3, max 200 | House/flat, building, street. |
| `line2` | `string` | no | max 200 | Second address line, if needed. |
| `area` | `string` | no | max 120 | Locality or area. |
| `city` | `string` | no | min 2, max 80 | City. |
| `stateCode` | `string` | no | — | Two-digit GST state code — a foreign key to `gst_states`, not free text. It sets the place of supply, and therefore whether the order is taxed IGST or CGST+SGST. |
| `pincode` | `string` | no | — | Six-digit PIN code. Drives serviceability, same-day eligibility and COD eligibility. |
| `countryCode` | `string` | no | min 2, max 2 | ISO-3166-1 alpha-2. Only `IN` is serviceable today, whatever the marketing copy says. |
| `isDefault` | `boolean` | no | — | Make this the default address. The first address you save becomes the default automatically whether or not you ask for it — a customer with addresses but no default is a checkout with nothing pre-selected. |

Example request:

```json
{
  "label": "Home",
  "contactName": "Brass Diya Set",
  "mobile": "9820012345",
  "line1": "12 Linking Road",
  "line2": "Bandra West",
  "area": "Bandra",
  "city": "Mumbai",
  "stateCode": "DIWALI20",
  "pincode": "DIWALI20",
  "countryCode": "DIWALI20",
  "isDefault": false
}
```

**Response `200`** — The updated address.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "label": "Home",
    "contactName": "Brass Diya Set",
    "mobile": "9820012345",
    "line1": "12 Linking Road",
    "line2": "Bandra West",
    "area": "Bandra",
    "city": "Mumbai",
    "stateCode": "DIWALI20",
    "pincode": "DIWALI20",
    "countryCode": "DIWALI20",
    "isDefault": false,
    "createdAt": "2026-08-25T10:30:00.000Z",
    "updatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such address, or it belongs to someone else. |
| `422` | Tried to clear the default flag without nominating a replacement. |

---

### `POST /v1/account/addresses/:addressId/default`

**Make an address the default**

| | |
|---|---|
| operationId | `setDefaultAddress` |
| Auth | **Bearer customer token required** |

Two statements in one transaction, in the only order the partial unique index permits: stand the incumbent down, then promote this one.

Returns the **whole list**, not just the address that changed. Two rows move — one gains the flag, one loses it — and a client that re-renders from a single-object response would show two ticks until its next refetch.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `addressId` | `uuid` | **yes** | — | `addresses.id` as returned by `GET /v1/account/addresses`. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The full address list, with exactly one default.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "label": "Home",
      "contactName": "Brass Diya Set",
      "mobile": "9820012345",
      "line1": "12 Linking Road",
      "line2": "Bandra West",
      "area": "Bandra",
      "city": "Mumbai",
      "stateCode": "DIWALI20",
      "pincode": "DIWALI20",
      "countryCode": "DIWALI20",
      "isDefault": false,
      "createdAt": "2026-08-25T10:30:00.000Z",
      "updatedAt": "2026-08-25T10:30:00.000Z"
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
| `404` | No such address, or it belongs to someone else. |

---

### `DELETE /v1/account/addresses/:addressId`

**Delete an address**

| | |
|---|---|
| operationId | `deleteMyAddress` |
| Auth | **Bearer customer token required** |

Soft delete — `addresses` is Tier 2, and orders reference the address snapshot they were placed against, so the row survives even though it disappears from the book.

Deleting the default is allowed: `trg_ensure_default_address` promotes the oldest surviving address in the same statement, so the customer is never left with addresses and no default.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `addressId` | `uuid` | **yes** | — | `addresses.id` as returned by `GET /v1/account/addresses`. |

**Request body** — none. Send `{}` or omit.

**Response `204`** — Deleted.

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such address, or it belongs to someone else. |

---
