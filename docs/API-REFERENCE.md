# Achichiz API Reference

> **Generated** from `openapi/openapi.storefront.json` and `openapi/openapi.admin.json`.
> Regenerate with `npm run openapi:generate && npm run docs:generate` — do not hand-edit.

## Conventions

**Envelope.** A single resource returns `{ "data": { … } }`. A collection returns
`{ "data": [ … ], "meta": { "page", "perPage", "total", "totalPages" } }`. Deletes return `204`
with no body. The tables below describe the **inner `data` payload**, not the wrapper.

**Money is always an integer number of paise.** `"totalPaise": 149900` means ₹1,499.00. There are
no float rupee values anywhere in this API. Percentages are integer basis points (250 = 2.5%).

**Errors** follow RFC 9457 with `Content-Type: application/problem+json`:

```json
{
  "type": "https://api.achichiz.com/errors/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "code": "validation_failed",
  "detail": "1 field is invalid.",
  "instance": "/v1/products",
  "requestId": "01KZGXZP18APANE6GJGZZXB00Y",
  "errors": [{ "path": "perPage", "code": "too_big", "message": "Too big: expected number to be <=100" }]
}
```

Switch on `code` — it is stable. `title` is human-facing and may be reworded.

**Pagination.** List endpoints accept `page` (1-indexed) and `perPage` (**max 100**), plus
`sort` (field name, `-` prefix for descending; validated against a per-resource allowlist) and
`q` for free-text search.

**Auth.** Two schemes, different secrets and different `aud` claims:

| Scheme | Audience | Obtained from | Lifetime |
|---|---|---|---|
| `bearerAuth` | customer | `POST /v1/auth/login` or `/v1/auth/otp/verify` | 15 min, refresh via httpOnly `ach_rt` cookie |
| `adminBearerAuth` | staff | `POST /v1/admin/auth/2fa/verify` | 10 min |

A customer token is rejected on every `/v1/admin` route. Admin routes additionally require a
`module:action` permission resolved from the staff member's role.

**Common error codes.** `401` unauthenticated · `403` forbidden (valid token, wrong role) ·
`404` not_found · `409` conflict / already_exists · `422` validation_failed or unprocessable ·
`429` rate_limited · `500` internal_error.



---

# Storefront surface

**70 operations** · Swagger UI at `/docs/storefront`

| Group | Operations |
|---|---|
| Account | 5 |
| Add-ons | 2 |
| Addresses | 6 |
| Auth | 10 |
| CMS | 2 |
| Cart | 8 |
| Checkout | 2 |
| Collections | 3 |
| Delivery | 1 |
| Designers | 2 |
| FAQ | 1 |
| Hamper builder | 2 |
| Journal | 2 |
| Leads | 3 |
| Navigation | 1 |
| Orders | 4 |
| Pages | 3 |
| Payments | 2 |
| Products | 3 |
| SEO | 1 |
| Search | 3 |
| System | 2 |
| Testimonials | 1 |
| Webhooks | 1 |


## Account

#### `GET /v1/account/profile`

> Get my profile

The full account record, including the two fields the storefront currently keeps in `localStorage` and therefore loses on a device change: `birthday` and the marketing toggle. `hasPassword` is false on an OTP-created account — use it to decide whether to offer “set a password” rather than “change password”.

| | |
|---|---|
| operationId | `getMyProfile` |
| Auth | `bearerAuth` (customer) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The signed-in customer’s profile. |
| `401` | Missing, expired or revoked access token. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `PATCH /v1/account/profile`

> Update my profile

A true PATCH — only the fields present are touched, and `{}` is a valid no-op. `birthday` and `gender` accept `null` to clear them; `email` and `mobile` do not, because the `customer_needs_a_handle` constraint requires at least one of the two and clearing the last one would surface as a database error rather than a field message.

**Changing `email` clears `emailVerified`; changing `mobile` clears `mobileVerified`.** Otherwise the profile form would be a way to mint a verified address you do not control. Re-verify a new mobile with `POST /v1/auth/otp/request`.

Toggling `marketingOptIn` in either direction writes a timestamped, sourced record to the append-only consent log. An address or number already in use on another account returns 409.

| | |
|---|---|
| operationId | `updateMyProfile` |
| Auth | `bearerAuth` (customer) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `fullName` | string | no | Display name, as it should appear on a parcel. <br><sub>minLen 2, maxLen 120</sub> |
| `email` | string | no | New email address. Changing it clears `emailVerified` — the new address has not been proven. An address already in use returns 409. <br><sub>maxLen 255, email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |
| `mobile` | string | no | New ten-digit mobile. Changing it clears `mobileVerified`; verify the new number with an OTP. A number already in use returns 409. <br><sub>pattern `^[6-9][0-9]{9}$`</sub> |
| `birthday` | string \| null | no | `YYYY-MM-DD`, or null to clear. Drives birthday gifting reminders. |
| `gender` | `female` \| `male` \| `other` \| `undisclosed` \| null | no | Or null to clear. |
| `marketingOptIn` | boolean | no | Turn marketing email/SMS on or off. Both directions are recorded in the append-only consent log with a timestamp and a source — the boolean alone cannot evidence consent. |
| `whatsappOptIn` | boolean | no | Turn WhatsApp messaging on or off. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated profile. |
| `401` | Missing, malformed or expired token. |
| `409` | That email address or mobile number belongs to another account. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/account/wishlist`

> List my wishlist

Newest first, wrapped as `{ data, meta }`. Price, image and stock are read live on every request, so a saved product shows its current price rather than the one it had when it was hearted.

A product that has since been unpublished or deleted still appears, with `available: false`. Dropping it silently would give the customer a shorter list with no explanation; this way the UI can say “no longer available” and offer to remove it.

| | |
|---|---|
| operationId | `listMyWishlist` |
| Auth | `bearerAuth` (customer) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of wishlist items. |
| `401` | Missing, expired or revoked access token. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/account/wishlist`

> Save a product to my wishlist

Keyed by product id, not handle — a handle can be edited in the admin, and the storefront’s handle-keyed `localStorage` wishlist silently loses its entry when that happens.

Idempotent: saving something already saved returns 201 with the same item rather than 409, because a heart icon tapped twice is not an error. An unpublished or unknown product is 404.

| | |
|---|---|
| operationId | `addWishlistItem` |
| Auth | `bearerAuth` (customer) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `productId` | string | **yes** | The product to save. Must exist and be published. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `201` | Saved. |
| `401` | Missing, malformed or expired token. |
| `404` | No such published product. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `DELETE /v1/account/wishlist/{productId}`

> Remove a product from my wishlist

Removing something that was not saved returns 404 rather than a silent 204 — the storefront’s heart is optimistic, and a 404 is how it learns its local state has drifted and should re-fetch.

| | |
|---|---|
| operationId | `removeWishlistItem` |
| Auth | `bearerAuth` (customer) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `productId` | string | **yes** | `products.id` as returned by `GET /v1/account/wishlist`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Removed. |
| `401` | Missing, malformed or expired token. |
| `404` | That product is not on your wishlist. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---


## Add-ons

#### `GET /v1/add-ons`

> List add-ons

Gift wrap, cards, engraving and the rest. Pass `product` to get exactly what that product offers with its per-product price override already applied; omit it for the global catalogue. `pricePaise` is always the price to charge — never re-derive it. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listAddOns` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `kind` | `packaging` \| `message` \| `fresh` \| `bakery` \| `digital` \| `engraving` \| `other` | no | Restrict to one add-on kind. |
| `product` | string | no | Product handle. Returns exactly the add-ons that product offers, with any per-product price override already applied. Omit for the global catalogue of active add-ons. <br><sub>pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of add-ons. |
| `404` | `product` was supplied and no published product has that handle. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/personalisation-templates`

> List personalisation templates

Engraving, embroidery, print, digital and laser methods with their turnaround, character cap and proof policy. `charLimit` is enforced server-side at cart and order time — the HTML `maxlength` is not the rule. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listPersonalisationTemplates` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `method` | `engraving` \| `embroidery` \| `print` \| `digital` \| `laser` | no | Restrict to one production method. |
| `product` | string | no | Product handle. Returns only the templates pinned to that product. <br><sub>pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of templates. |
| `404` | `product` was supplied and no published product has that handle. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---


## Addresses

#### `GET /v1/account/addresses`

> List my addresses

Default first, then oldest first. Not paginated — an address book is a handful of rows, and the checkout screen needs all of them at once to render its picker.

| | |
|---|---|
| operationId | `listMyAddresses` |
| Auth | `bearerAuth` (customer) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Every saved address. |
| `401` | Missing, expired or revoked access token. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/account/addresses`

> Add an address

**The first address you save becomes the default automatically**, whether or not `isDefault` was sent — a customer with addresses but no default is a checkout with nothing pre-selected. The storefront does this in the browser today, which means any address created by another path (checkout’s `saveToAddressBook`, an admin, an import) silently misses it.

Passing `isDefault: true` stands the previous default down in the same transaction, in that order — the uniqueness index is partial and cannot be deferred, so the other order is a constraint violation even though the end state would be legal.

`stateCode` is a foreign key to `gst_states`, not free text: it decides the place of supply and therefore whether the order is taxed IGST or CGST+SGST. An unknown code is rejected.

| | |
|---|---|
| operationId | `createMyAddress` |
| Auth | `bearerAuth` (customer) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | string | no | Address-book label, e.g. `Home`, `Office`, `Parents`. Free text — the list groups by it. <br><sub>minLen 1, maxLen 40, default `"Home"`</sub> |
| `contactName` | string | **yes** | Who receives the parcel at this address. <br><sub>minLen 2, maxLen 120</sub> |
| `mobile` | string | **yes** | Ten-digit number the courier calls on delivery. Not necessarily the account holder’s. <br><sub>pattern `^[6-9][0-9]{9}$`</sub> |
| `line1` | string | **yes** | House/flat, building, street. <br><sub>minLen 3, maxLen 200</sub> |
| `line2` | string | no | Second address line, if needed. <br><sub>maxLen 200</sub> |
| `area` | string | no | Locality or area. <br><sub>maxLen 120</sub> |
| `city` | string | **yes** | City. <br><sub>minLen 2, maxLen 80</sub> |
| `stateCode` | string | **yes** | Two-digit GST state code — a foreign key to `gst_states`, not free text. It sets the place of supply, and therefore whether the order is taxed IGST or CGST+SGST. <br><sub>pattern `^[0-3][0-9]$`</sub> |
| `pincode` | string | **yes** | Six-digit PIN code. Drives serviceability, same-day eligibility and COD eligibility. <br><sub>pattern `^[1-9][0-9]{5}$`</sub> |
| `countryCode` | string | no | ISO-3166-1 alpha-2. Only `IN` is serviceable today, whatever the marketing copy says. <br><sub>minLen 2, maxLen 2, default `"IN"`</sub> |
| `isDefault` | boolean | no | Make this the default address. The first address you save becomes the default automatically whether or not you ask for it — a customer with addresses but no default is a checkout with nothing pre-selected. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The saved address. |
| `401` | Missing, malformed or expired token. |
| `409` | An unknown `stateCode` — there is no such GST state. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `DELETE /v1/account/addresses/{addressId}`

> Delete an address

Soft delete — `addresses` is Tier 2, and orders reference the address snapshot they were placed against, so the row survives even though it disappears from the book.

Deleting the default is allowed: `trg_ensure_default_address` promotes the oldest surviving address in the same statement, so the customer is never left with addresses and no default.

| | |
|---|---|
| operationId | `deleteMyAddress` |
| Auth | `bearerAuth` (customer) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `addressId` | string | **yes** | `addresses.id` as returned by `GET /v1/account/addresses`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Deleted. |
| `401` | Missing, malformed or expired token. |
| `404` | No such address, or it belongs to someone else. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/account/addresses/{addressId}`

> Get one of my addresses

An id that is not yours returns 404, not 403 — confirming an id exists is itself a leak.

| | |
|---|---|
| operationId | `getMyAddress` |
| Auth | `bearerAuth` (customer) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `addressId` | string | **yes** | `addresses.id` as returned by `GET /v1/account/addresses`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The address. |
| `401` | Missing, malformed or expired token. |
| `404` | No such address, or it belongs to someone else. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `PATCH /v1/account/addresses/{addressId}`

> Update an address

A true PATCH — only the fields present are changed, and `{}` is a valid no-op.

`isDefault: true` promotes this address and stands the incumbent down atomically. `isDefault: false` **on the address that is currently the default is refused** (422 `default_address_required`): while any address exists one of them is the default, so clearing the flag would just cause some other address to be promoted arbitrarily. Use `POST /v1/account/addresses/{addressId}/default` on the address you actually want instead.

| | |
|---|---|
| operationId | `updateMyAddress` |
| Auth | `bearerAuth` (customer) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `addressId` | string | **yes** | `addresses.id` as returned by `GET /v1/account/addresses`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | string | no | Address-book label, e.g. `Home`, `Office`, `Parents`. Free text — the list groups by it. <br><sub>minLen 1, maxLen 40</sub> |
| `contactName` | string | no | Who receives the parcel at this address. <br><sub>minLen 2, maxLen 120</sub> |
| `mobile` | string | no | Ten-digit number the courier calls on delivery. Not necessarily the account holder’s. <br><sub>pattern `^[6-9][0-9]{9}$`</sub> |
| `line1` | string | no | House/flat, building, street. <br><sub>minLen 3, maxLen 200</sub> |
| `line2` | string | no | Second address line, if needed. <br><sub>maxLen 200</sub> |
| `area` | string | no | Locality or area. <br><sub>maxLen 120</sub> |
| `city` | string | no | City. <br><sub>minLen 2, maxLen 80</sub> |
| `stateCode` | string | no | Two-digit GST state code — a foreign key to `gst_states`, not free text. It sets the place of supply, and therefore whether the order is taxed IGST or CGST+SGST. <br><sub>pattern `^[0-3][0-9]$`</sub> |
| `pincode` | string | no | Six-digit PIN code. Drives serviceability, same-day eligibility and COD eligibility. <br><sub>pattern `^[1-9][0-9]{5}$`</sub> |
| `countryCode` | string | no | ISO-3166-1 alpha-2. Only `IN` is serviceable today, whatever the marketing copy says. <br><sub>minLen 2, maxLen 2</sub> |
| `isDefault` | boolean | no | Make this the default address. The first address you save becomes the default automatically whether or not you ask for it — a customer with addresses but no default is a checkout with nothing pre-selected. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated address. |
| `401` | Missing, malformed or expired token. |
| `404` | No such address, or it belongs to someone else. |
| `422` | Tried to clear the default flag without nominating a replacement. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/account/addresses/{addressId}/default`

> Make an address the default

Two statements in one transaction, in the only order the partial unique index permits: stand the incumbent down, then promote this one.

Returns the **whole list**, not just the address that changed. Two rows move — one gains the flag, one loses it — and a client that re-renders from a single-object response would show two ticks until its next refetch.

| | |
|---|---|
| operationId | `setDefaultAddress` |
| Auth | `bearerAuth` (customer) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `addressId` | string | **yes** | `addresses.id` as returned by `GET /v1/account/addresses`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The full address list, with exactly one default. |
| `401` | Missing, malformed or expired token. |
| `404` | No such address, or it belongs to someone else. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---


## Auth

#### `POST /v1/auth/forgot-password`

> Request a password-reset email

Always returns `{ "status": "sent" }`, for a known address and an unknown one alike. Anything else turns this endpoint into a free customer-list validator. 

When the address does have an account, a single-use token valid for 30 minutes is emailed. Only an argon2id hash of it is stored, so a database dump yields no usable reset links. Rate-limited to 10 attempts per 15 minutes per IP. Failure responses are deliberately identical whether or not an account exists.

| | |
|---|---|
| operationId | `requestPasswordReset` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | **yes** | Email address. Stored CITEXT, so lookups and uniqueness are case-insensitive. <br><sub>maxLen 255, email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `202` | An email has been sent, if that address has an account. |
| `422` | Validation failed. |
| `429` | Too many requests from this IP. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/auth/login`

> Sign in with email and password

The secondary login path — mobile + OTP is primary for Indian D2C, and this exists for corporate buyers and for accounts migrated from Supabase Auth. Those migrated accounts keep their original bcrypt password: it is verified as bcrypt and transparently re-hashed to argon2id on this login, so **no migrated customer is ever forced to reset**. Any failure — unknown address, wrong password, OTP-only account, blocked account — returns the same 401 with the same message, and costs the same amount of time. On success a rotating opaque refresh token is set as the httpOnly `ach_rt` cookie (`Path=/v1/auth`). Send credentialed requests (`fetch(..., { credentials: "include" })`) so it travels. It is never present in the response body. Rate-limited to 10 attempts per 15 minutes per IP. Failure responses are deliberately identical whether or not an account exists.

| | |
|---|---|
| operationId | `login` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | **yes** | Email address. Stored CITEXT, so lookups and uniqueness are case-insensitive. <br><sub>maxLen 255, email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |
| `password` | string | **yes** | The plaintext password. Never logged — see `config/logger.ts` redaction. <br><sub>minLen 1, maxLen 256</sub> |
| `cartToken` | string | no | The guest cart handle to fold into the account on success. May also be sent as the `X-Cart-Token` header, which wins when both are present. Merge failures never fail the login. <br><sub>minLen 8, maxLen 255</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Signed in. |
| `401` | Those credentials are not valid. The body never says which part was wrong. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/auth/logout`

> Sign out of this device

Revokes the session behind the `ach_rt` cookie and clears it. The outstanding access token is denylisted, so it stops working immediately rather than at its next expiry. Idempotent and always 204 — a missing or unknown cookie is not an error, and reporting one would tell a caller whether the token it holds is real.

| | |
|---|---|
| operationId | `logout` |
| Auth | public |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Signed out. |
| `429` | Too many requests. |
| `500` | Unexpected server error. |

---

#### `POST /v1/auth/logout-all`

> Sign out of every device

Revokes every live session for the customer identified by the `ach_rt` cookie, denylists all of their access tokens, and clears this device’s cookie. Use it from the “sign out everywhere” control, and after any credential scare. Authenticated by the refresh cookie rather than a Bearer token, because the access token has usually expired by the time somebody reaches for this.

| | |
|---|---|
| operationId | `logoutEverywhere` |
| Auth | public |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Every session revoked. |
| `429` | Too many requests. |
| `500` | Unexpected server error. |

---

#### `GET /v1/auth/me`

> Who am I

The signed-in customer, resolved from the access token. Replaces the storefront’s `supabase.auth.getSession()` polling with a single authoritative read. 

The one endpoint in this module that requires a Bearer token — it has no other way to answer. A 401 here means "refresh, then retry", not "show the login page".

| | |
|---|---|
| operationId | `getCurrentCustomer` |
| Auth | `bearerAuth` (customer) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The signed-in customer. |
| `401` | Missing, expired or revoked access token. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/auth/otp/request`

> Send a login OTP to a mobile number

The primary login path. A six-digit code, valid for five minutes, argon2id-hashed at rest, five verification attempts, three sends per hour per number on top of the IP rate limit. 

The response is `{ "status": "sent" }` **always** — for a number with an account, a number without one, and a number that has hit its send throttle. There is no signup step: verifying a code on an unknown number creates the account. 

Delivery goes through MSG91, which requires a TRAI DLT-registered template; until that paperwork clears the dev sender logs the code instead of sending it.

| | |
|---|---|
| operationId | `requestLoginOtp` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `mobile` | string | **yes** | Ten-digit Indian mobile number without the country code, e.g. `9820012345`. <br><sub>pattern `^[6-9][0-9]{9}$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `202` | A code has been sent, if that number was eligible for one. |
| `422` | Validation failed. |
| `429` | Too many OTP requests from this IP. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/auth/otp/verify`

> Verify a login OTP and sign in

Verifies the newest unconsumed code for that number. A correct code signs the customer in, marks the mobile verified, and — when the number has no account yet — creates one on the spot with `fullName` if supplied. The code is single-use: it is consumed before the session is issued. 

Wrong codes increment an attempt counter and burn the challenge after five. Expired, exhausted and simply-wrong all return 422 `otp_invalid` so the response cannot be used to probe which. On success a rotating opaque refresh token is set as the httpOnly `ach_rt` cookie (`Path=/v1/auth`). Send credentialed requests (`fetch(..., { credentials: "include" })`) so it travels. It is never present in the response body.

| | |
|---|---|
| operationId | `verifyLoginOtp` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `mobile` | string | **yes** | Ten-digit Indian mobile number without the country code, e.g. `9820012345`. <br><sub>pattern `^[6-9][0-9]{9}$`</sub> |
| `code` | string | **yes** | The six-digit code from the SMS. Five wrong attempts burn the challenge. <br><sub>pattern `^[0-9]{6}$`</sub> |
| `fullName` | string | no | Only used when this mobile has no account yet — a verified OTP creates one. <br><sub>minLen 2, maxLen 120</sub> |
| `cartToken` | string | no | The guest cart handle to fold into the account on success. May also be sent as the `X-Cart-Token` header, which wins when both are present. Merge failures never fail the login. <br><sub>minLen 8, maxLen 255</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Signed in. |
| `422` | The code is wrong, expired, or its attempts are exhausted. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/auth/refresh`

> Exchange the refresh cookie for a new access token

Reads the `ach_rt` cookie, issues a new access token, and **rotates the refresh token** — the old one stops working the instant this returns. There is no request body; the token is not accepted anywhere a script could have put it.

**Reuse detection.** Presenting a refresh token that has already been exchanged means two parties hold that session, so the entire session family is revoked immediately — in the database and on the Redis access-token denylist — a security event is logged, and the customer must sign in again. A client that retries a refresh whose response it lost will trip this; that is the accepted cost of rotation being worth anything at all.

Call it on a timer slightly inside `expiresIn`, and once on a 401.

| | |
|---|---|
| operationId | `refreshSession` |
| Auth | public |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A new access token, and a rotated refresh cookie. |
| `401` | No cookie, an expired session, or a token that had already been spent. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/auth/reset-password`

> Complete a password reset

Consumes the emailed token and sets the new password (argon2id). The token carries its own challenge id, so no email address is re-submitted here. 

**Every session is revoked**, on every device. If the reset was prompted by a leak, leaving the attacker’s refresh token alive would make the reset decorative. The customer signs in again afterwards. Completing a reset also marks the email address verified — the loop proves the mailbox.

| | |
|---|---|
| operationId | `resetPassword` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `token` | string | **yes** | The single-use token from the reset email, in `<challengeId>.<secret>` form. The secret half is argon2id-hashed at rest, so a database dump does not yield a usable reset link. <br><sub>minLen 20, maxLen 400</sub> |
| `password` | string | **yes** | Plaintext password, 10–256 characters. Hashed with argon2id (m=19456, t=2, p=1) at rest. <br><sub>minLen 10, maxLen 256</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The password has been changed. Sign in again. |
| `422` | The token is unknown, already used, or expired. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/auth/signup`

> Create a customer account

Creates the account, signs it in and folds any guest cart into it in one call. `marketingOptIn` defaults to **false** and is never inferred — a granted consent is recorded with its timestamp and source, which is what makes it defensible under the DPDP Act. An email or mobile already in use returns 409 rather than failing silently. On success a rotating opaque refresh token is set as the httpOnly `ach_rt` cookie (`Path=/v1/auth`). Send credentialed requests (`fetch(..., { credentials: "include" })`) so it travels. It is never present in the response body. Rate-limited to 10 attempts per 15 minutes per IP. Failure responses are deliberately identical whether or not an account exists.

| | |
|---|---|
| operationId | `signup` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `fullName` | string | **yes** | The customer’s name, as they want it on a parcel. <br><sub>minLen 2, maxLen 120</sub> |
| `email` | string | **yes** | Email address. Stored CITEXT, so lookups and uniqueness are case-insensitive. <br><sub>maxLen 255, email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |
| `mobile` | string | no | Optional at signup; required before an order can be delivered. <br><sub>pattern `^[6-9][0-9]{9}$`</sub> |
| `password` | string | **yes** | Plaintext password, 10–256 characters. Hashed with argon2id (m=19456, t=2, p=1) at rest. <br><sub>minLen 10, maxLen 256</sub> |
| `marketingOptIn` | boolean | no | Opt in to marketing email/SMS. Defaults to **false** — consent is never pre-ticked (DPDP). Granting it writes a timestamped consent record. <br><sub>default `false`</sub> |
| `cartToken` | string | no | The guest cart handle to fold into the account on success. May also be sent as the `X-Cart-Token` header, which wins when both are present. Merge failures never fail the login. <br><sub>minLen 8, maxLen 255</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `201` | Account created and signed in. |
| `409` | That email address or mobile number already has an account. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## CMS

#### `GET /v1/banners`

> List live banners

Banners whose schedule window is open right now — the clock decides, not the status column, so a scheduled banner goes live without waiting for a job. Pass `device` to get creatives targeted at that device plus those targeted at all devices.

| | |
|---|---|
| operationId | `listBanners` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `placement` | `homepage_hero` \| `category_top` \| `cart_strip` \| `pdp_ribbon` \| `announcement_bar` | no | Restrict to one placement. |
| `device` | `desktop` \| `mobile` | no | Caller’s device. Returns banners targeted at it plus those targeted at `all`. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of live banners. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/cms/sections`

> List CMS sections with their items

The homepage and landing-page section slots, in page order, each with its visible tiles already attached. Pass `pageKey=home` for the homepage. Tiles pointing at an unpublished collection or product are dropped rather than rendered as dead links. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listCmsSections` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `pageKey` | string | no | Page to fetch sections for. Defaults to every page; pass `home` for the homepage. <br><sub>maxLen 60</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of sections. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---


## Cart

#### `DELETE /v1/cart`

> Empty the cart

Removes every line and the coupon. The cart row and its token survive, so the same handle keeps working. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

| | |
|---|---|
| operationId | `clearCart` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `cartToken` | string | no | Opaque cart handle. Prefer the `X-Cart-Token` header; this exists for GET/DELETE convenience. <br><sub>minLen 8, maxLen 255</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The now-empty cart. |
| `404` | No such cart token. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/cart`

> Get the current cart

The whole basket with server-computed totals. An unknown or missing token returns an empty cart rather than a 404, so a first-time visitor renders without special-casing. Totals are recomputed server-side on every call from live variant and add-on prices — the response never echoes a number the client sent. Shipping assumes standard delivery until an address is supplied at `POST /v1/checkout/quote`. A coupon that has expired, been exhausted or stopped qualifying is dropped here and reported in `totals.couponCode: null` — it is re-validated on every read, not only when it was applied. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

| | |
|---|---|
| operationId | `getCart` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `cartToken` | string | no | Opaque cart handle. Prefer the `X-Cart-Token` header; this exists for GET/DELETE convenience. <br><sub>minLen 8, maxLen 255</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The cart. Empty when no cart exists yet. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `DELETE /v1/cart/coupon`

> Remove the cart’s coupon

Clears the coupon and reprices. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

| | |
|---|---|
| operationId | `removeCartCoupon` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `cartToken` | string | no | Opaque cart handle. Prefer the `X-Cart-Token` header; this exists for GET/DELETE convenience. <br><sub>minLen 8, maxLen 255</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The cart, repriced without the coupon. |
| `404` | No such cart token. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/cart/coupon`

> Apply a coupon to the cart

Validated against the live `coupons` table — status, start and end dates, global redemption cap, per-customer cap, minimum order value, and product/collection eligibility. Each failure returns a distinct stable `code` (`coupon_not_found`, `coupon_expired`, `coupon_exhausted`, `coupon_min_not_met`, `coupon_not_applicable`, `coupon_first_order_only`, …) so the frontend can explain itself rather than saying “invalid code”. Applying a coupon does not reserve a redemption; that is claimed atomically at order creation. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

| | |
|---|---|
| operationId | `applyCartCoupon` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `cartToken` | string | no | Opaque cart handle, or send `X-Cart-Token`. <br><sub>minLen 8, maxLen 255</sub> |
| `code` | string | **yes** | Coupon code, case-insensitive. Validated against the live `coupons` table, never a hardcoded list. <br><sub>minLen 3, maxLen 32</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The cart, repriced with the coupon. |
| `404` | No such cart token. |
| `422` | The coupon does not exist, is not live, or does not apply to this cart. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/cart/lines`

> Add a line to the cart

Adds a variant, its add-ons and its personalisation. Adding an identical configuration sums the quantities instead of creating a second line — “identical” means the same variant, the same add-ons with the same text, and the same personalisation. Quantity is checked against live available stock (on-hand minus reserved) and rejected with 422 `insufficient_stock` when it exceeds it; stock is NOT reserved here, only at order creation. Personalisation is capped server-side at 24 characters for a name, 180 for a message and 240 for a gift message. Omit `cartToken` on the very first add: the response `token` is the handle to keep. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

| | |
|---|---|
| operationId | `addCartLine` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `cartToken` | string | no | Opaque cart handle. Omit on the first add — the response mints one and returns it as `token`. May also be sent as the `X-Cart-Token` request header. <br><sub>minLen 8, maxLen 255</sub> |
| `variantId` | string | **yes** | The variant to add. Cart lines reference a variant, never a product. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `quantity` | integer | no | Units to add. Adding to a line that already exists sums the quantities. <br><sub>min 1, max 99, default `1`</sub> |
| `addOns` | array<object> | no | Chosen add-ons. A different add-on set makes a different cart line, not a merged one. <br><sub>default `[]`</sub> |
| `personalisation` | object | no | Personalisation inputs keyed by field name, e.g. `{ "Name": "Aarav", "Message": "Happy Diwali" }`. Per-key character limits (Name 24, Message 180, Gift message 240) are enforced HERE, server-side — the PDP `maxlength` attribute is decoration. |
| `builderTemplateId` | string | no | Build-your-own-hamper template. NOT YET SUPPORTED — a builder line reserves its bill-of-materials components rather than a variant, and the pricing engine has no BOM path. Sending it returns 422 `builder_lines_unsupported` rather than silently dropping the hamper. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `builderConfig` | object | no | Chosen option ids for a built hamper. See `builderTemplateId`. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated cart. |
| `404` | No such cart token, or no such purchasable variant. |
| `422` | Out of stock, personalisation too long, or a builder line was sent. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `DELETE /v1/cart/lines/{lineId}`

> Remove a cart line

Deletes the line and its add-ons. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

| | |
|---|---|
| operationId | `removeCartLine` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `lineId` | string | **yes** | `cart_lines.id` as returned by `GET /v1/cart`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `cartToken` | string | no | Opaque cart handle. Prefer the `X-Cart-Token` header; this exists for GET/DELETE convenience. <br><sub>minLen 8, maxLen 255</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated cart. |
| `404` | No such cart or no such line in it. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `PATCH /v1/cart/lines/{lineId}`

> Change a cart line’s quantity or personalisation

`quantity: 0` removes the line, mirroring the storefront’s existing stepper behaviour. Any other quantity is an absolute value, not a delta, and is checked against live stock. Changing the personalisation rewrites the line’s dedupe key, so it will 422 if that would collide with another line already in the cart. Identify the cart with the `X-Cart-Token` header (preferred) or the `cartToken` field. The header wins if both are sent.

| | |
|---|---|
| operationId | `updateCartLine` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `lineId` | string | **yes** | `cart_lines.id` as returned by `GET /v1/cart`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `cartToken` | string | no | Opaque cart handle, or send `X-Cart-Token`. <br><sub>minLen 8, maxLen 255</sub> |
| `quantity` | integer | **yes** | New absolute quantity. Zero removes the line, mirroring the storefront’s existing behaviour. <br><sub>min 0, max 99</sub> |
| `personalisation` | object | no | Replaces the line’s personalisation when present. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated cart. |
| `404` | No such cart or no such line in it. |
| `422` | Not enough stock, personalisation too long, or a duplicate line. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/cart/merge`

> Attach a guest cart to the signed-in account

Call this once immediately after login. With `cartToken`, the guest cart’s lines are folded into the account’s cart — identical configurations have their quantities summed, everything else is moved across — and the guest cart is discarded. Without `cartToken`, it simply returns (creating if needed) the account’s own cart, which is how a second device obtains a handle. No price is carried over: every line is re-priced from the catalogue, and the coupon is re-validated. **Use the `token` in the response from this point on** — the guest token is dead.

| | |
|---|---|
| operationId | `mergeCart` |
| Auth | `bearerAuth` (customer) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `cartToken` | string | no | The guest cart to fold in. Omit to simply fetch (or create) the signed-in customer’s own cart — which is how a second device gets its cart handle. <br><sub>minLen 8, maxLen 255</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The account’s cart, after the merge. |
| `401` | Missing, malformed or expired token. |
| `404` | The supplied cart token belongs to a different account. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Checkout

#### `POST /v1/checkout/quote`

> Price a cart for a destination, delivery method and payment method

The review step, and the only honest source of a total. Every figure is recomputed here from `product_variants`, `add_ons`, `gst_rates`, `coupons` and `delivery_zones`. There is no request field through which a price, discount or total can be sent, and none would be read if there were. It also answers the three questions the storefront currently guesses: is the PIN code actually serviceable, is cash on delivery allowed there, and which delivery options are live right now (same-day depends on the zone AND on the cutoff not having passed in Asia/Kolkata). Read `warnings` before showing a payment button — that is where a price change, a dropped coupon or a stock shortfall since the cart was last loaded appears. Quoting is free of side effects: no stock is held and no coupon redemption is claimed.

| | |
|---|---|
| operationId | `createCheckoutQuote` |
| Auth | `bearerAuth` (customer) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `cartToken` | string | no | Opaque cart handle. Omit to quote the signed-in customer’s own cart. <br><sub>minLen 8, maxLen 255</sub> |
| `addressId` | string | no | A saved address id. Supply this OR `address`, not both and not neither. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `address` | object | no | A one-off shipping address. |
| `deliveryType` | `standard` \| `scheduled` \| `same_day` \| `midnight` \| `international` | no | Delivery method. Drives the surcharge (`standard` free, `scheduled` ₹249, `same_day`/`midnight` ₹499) and the courier SLA. Server-side constants — the client cannot set a shipping amount. <br><sub>default `"standard"`</sub> |
| `paymentMethod` | `upi` \| `credit_card` \| `debit_card` \| `net_banking` \| `wallet` \| `cod` | no | How the order will be paid. `cod` requires a COD-eligible PIN code; everything else is prepaid. <br><sub>default `"upi"`</sub> |
| `couponCode` | string | no | Coupon to apply for this quote. Omit to use whatever is already on the cart; send an empty string to quote without any coupon. <br><sub>maxLen 32</sub> |
| `requestedDeliveryDate` | string | no | `YYYY-MM-DD` requested delivery date. Must not be in the past in Asia/Kolkata. <br><sub>date, pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\`</sub> |
| `deliverySlot` | string | no | Requested slot, e.g. `09:00 - 12:00`. <br><sub>maxLen 60</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The priced quote. |
| `401` | Missing, malformed or expired token. |
| `404` | No such cart, or the address does not belong to the caller. |
| `422` | The cart is empty, or the coupon/address is invalid. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/orders`

> Place the order

Converts the cart into an order in one transaction. Every figure is recomputed here from `product_variants`, `add_ons`, `gst_rates`, `coupons` and `delivery_zones`. There is no request field through which a price, discount or total can be sent, and none would be read if there were. 

What happens, in order: the cart is re-priced; the coupon redemption is claimed with a conditional UPDATE that cannot over-redeem; stock is reserved with `UPDATE … WHERE on_hand − reserved >= qty` after locking every affected row in id order (so concurrent checkouts cannot deadlock and cannot oversell); the order number is drawn from the `document_number_series` counter; the header and lines are written; and the commit re-proves the totals against the lines through the deferred `check_order_totals()` trigger. Anything that fails rolls all of it back — including the coupon count and the stock hold.

**An `Idempotency-Key` header is required.** Retrying with the same key and the same body replays the stored response instead of creating a second order; the same key with a different body is a 409. Use a UUID and keep it for the whole retry sequence.

Prepaid orders come back `pending_payment` with a Razorpay session in `payment`; the order is confirmed by the webhook, never by the browser. COD orders come back `confirmed` / `cod_due` provided the PIN code allows it.

| | |
|---|---|
| operationId | `createOrder` |
| Auth | `bearerAuth` (customer) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `cartToken` | string | no | Opaque cart handle. Omit to quote the signed-in customer’s own cart. <br><sub>minLen 8, maxLen 255</sub> |
| `addressId` | string | no | A saved address id. Supply this OR `address`, not both and not neither. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `address` | object | no | A one-off shipping address. |
| `deliveryType` | `standard` \| `scheduled` \| `same_day` \| `midnight` \| `international` | no | Delivery method. Drives the surcharge (`standard` free, `scheduled` ₹249, `same_day`/`midnight` ₹499) and the courier SLA. Server-side constants — the client cannot set a shipping amount. <br><sub>default `"standard"`</sub> |
| `paymentMethod` | `upi` \| `credit_card` \| `debit_card` \| `net_banking` \| `wallet` \| `cod` | no | How the order will be paid. `cod` requires a COD-eligible PIN code; everything else is prepaid. <br><sub>default `"upi"`</sub> |
| `couponCode` | string | no | Coupon to apply for this quote. Omit to use whatever is already on the cart; send an empty string to quote without any coupon. <br><sub>maxLen 32</sub> |
| `requestedDeliveryDate` | string | no | `YYYY-MM-DD` requested delivery date. Must not be in the past in Asia/Kolkata. <br><sub>date, pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\`</sub> |
| `deliverySlot` | string | no | Requested slot, e.g. `09:00 - 12:00`. <br><sub>maxLen 60</sub> |
| `recipientName` | string | no | Gift recipient, when it is not the buyer. Frozen onto the order. <br><sub>maxLen 120</sub> |
| `recipientMobile` | string | no | Recipient’s mobile, for the delivery call. <br><sub>pattern `^[6-9][0-9]{9}$`</sub> |
| `isGift` | boolean | no | Marks the parcel as a gift — no price slip in the box. <br><sub>default `false`</sub> |
| `isAnonymousGift` | boolean | no | Hide the buyer’s identity from the recipient. <br><sub>default `false`</sub> |
| `giftMessage` | string | no | Gift card message. Hard-capped at 240 characters server-side; the HTML maxlength is not the rule. <br><sub>maxLen 240</sub> |
| `buyerName` | string | no | Buyer name. Defaults to the account name, then to the shipping contact name. <br><sub>minLen 2, maxLen 120</sub> |
| `buyerEmail` | string | no | Where the confirmation and invoice go. <br><sub>email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |
| `buyerMobile` | string | no | Buyer’s mobile. Defaults to the account mobile. <br><sub>pattern `^[6-9][0-9]{9}$`</sub> |
| `billGstin` | string | no | Buyer GSTIN for an input-tax-credit invoice. Validated by a DB domain, so it must be well-formed. <br><sub>minLen 15, maxLen 15</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The order, and a payment session when prepaid. |
| `400` | The `Idempotency-Key` header is missing or malformed. |
| `401` | Missing, malformed or expired token. |
| `404` | No such cart, or the address does not belong to the caller. |
| `409` | That `Idempotency-Key` is in flight, or was used with a different body. |
| `422` | Empty cart, an item went out of stock, the coupon stopped applying, the PIN code is unserviceable, or COD is not allowed there. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Collections

#### `GET /v1/collections`

> List collections

One table serves all six taxonomy kinds (category, recipient, occasion, festival, designer, edit) — filter with `kind`. `productCount` counts live products only. Scheduled collections appear once their window opens. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listCollections` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `kind` | `category` \| `recipient` \| `occasion` \| `festival` \| `designer` \| `edit` | no | Restrict to one taxonomy kind. |
| `parent` | string | no | Restrict to direct children of this collection handle. <br><sub>pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |
| `featured` | `0` \| `1` \| `true` \| `false` | no | `true` keeps only featured collections. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of collections. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/collections/{handle}`

> Get a collection with its facets

The collection plus the two things the listing page cannot compute for itself: the category facets actually present in it (with counts) and the real price-slider bounds. Fetch the products themselves from `listCollectionProducts`.

| | |
|---|---|
| operationId | `getCollectionByHandle` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | **yes** | URL slug of the resource, e.g. `bamboo-water-bottle`. <br><sub>minLen 2, maxLen 120, pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The collection, its facets and price bounds. |
| `404` | No live collection has that handle. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/collections/{handle}/products`

> List products in a collection

Identical filtering and sorting to `listProducts`, scoped to one collection. The path segment wins: a `collection` query parameter cannot widen the result set. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listCollectionProducts` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | **yes** | URL slug of the resource, e.g. `bamboo-water-bottle`. <br><sub>minLen 2, maxLen 120, pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `collection` | string | no | Restrict to a collection handle, any kind. e.g. `festivals-diwali`. <br><sub>pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |
| `type` | string \| array<string> | no | Category handle(s) to include. Repeat the parameter for several, e.g. `type=drinkware&type=candles`. |
| `designer` | string | no | Restrict to one designer handle. <br><sub>pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |
| `minPricePaise` | integer | no | Inclusive lower price bound, integer paise. <br><sub>min 0, max 9007199254740991</sub> |
| `maxPricePaise` | integer | no | Inclusive upper price bound, integer paise. <br><sub>min 0, max 9007199254740991</sub> |
| `inStock` | `0` \| `1` \| `true` \| `false` | no | `true` hides products whose `stock` is `out`. |
| `sameDay` | `0` \| `1` \| `true` \| `false` | no | `true` keeps only products with same-day-capable stock. |
| `personalisable` | `0` \| `1` \| `true` \| `false` | no | `true` keeps only personalisable products. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of products in the collection. |
| `404` | No live collection has that handle. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---


## Delivery

#### `GET /v1/serviceability`

> Check delivery serviceability for a PIN code

Real coverage, not an optimistic guess: an unknown PIN code and a suspended one both return `serviceable: false`. `sameDayEligible` additionally requires the zone’s cutoff not to have passed in Asia/Kolkata. `codEligible` requires both the zone and the PIN code to allow cash on delivery.

| | |
|---|---|
| operationId | `checkServiceability` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `pincode` | string | **yes** | Destination Indian PIN code, e.g. `400053`. <br><sub>pattern `^[1-9][0-9]{5}$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The serviceability answer. Always 200, including for unserviceable PIN codes. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Designers

#### `GET /v1/designers`

> List designers and brands

Makers attributed on the PDP: designers, brands, celebrities and artisan clusters. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listDesigners` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `kind` | `designer` \| `brand` \| `celebrity` \| `artisan_cluster` | no | Restrict to one maker kind. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of designers. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/designers/{handle}`

> Get a designer by handle

Backs the designer landing page. Fetch their products with `listProducts?designer=…`.

| | |
|---|---|
| operationId | `getDesignerByHandle` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | **yes** | URL slug of the resource, e.g. `bamboo-water-bottle`. <br><sub>minLen 2, maxLen 120, pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The designer. |
| `404` | No active designer has that handle. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## FAQ

#### `GET /v1/faqs`

> List FAQs

Published question-and-answer pairs, grouped by category and ordered for the accordion. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listFaqs` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `category` | string | no | Restrict to one category. <br><sub>maxLen 80</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of FAQs. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---


## Hamper builder

#### `GET /v1/hamper-builder/templates`

> List build-your-own-hamper templates

Live builder templates. Fetch one by handle for the wizard itself. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listHamperBuilderTemplates` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of builder templates. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/hamper-builder/templates/{handle}`

> Get a hamper builder template with its steps and options

The whole wizard in one call. Per-step `minChoices`/`maxChoices` are the real constraints and are re-enforced when the hamper is added to a cart. An option is `stock: "out"` when it is switched off or its component has no available units — that is computed live, never hardcoded.

| | |
|---|---|
| operationId | `getHamperBuilderTemplate` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | **yes** | URL slug of the resource, e.g. `bamboo-water-bottle`. <br><sub>minLen 2, maxLen 120, pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The template, its steps and their options. |
| `404` | No live builder template has that handle. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Journal

#### `GET /v1/blog/posts`

> List journal posts

Published posts, newest first. Scheduled posts stay hidden until their publish time passes. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listBlogPosts` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `category` | string | no | Restrict to one editorial category. <br><sub>maxLen 80</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of journal posts. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/blog/posts/{slug}`

> Get a journal post by slug

The post with its ordered body blocks, the "keep reading" slugs and any SEO overrides. Unknown block types must be skipped by the renderer, never thrown on.

| | |
|---|---|
| operationId | `getBlogPostBySlug` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `slug` | string | **yes** | URL slug of the resource, e.g. `shipping` or `gifting-for-diwali`. <br><sub>minLen 2, maxLen 160, pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The post. |
| `404` | No published post has that slug. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Leads

#### `POST /v1/leads/contact`

> Submit a contact enquiry

Persists the enquiry as a lead, emails the team, and acknowledges the customer. Replaces `contact.tsx`, which today calls `preventDefault()`, shows a success toast and throws the message away. 

The response carries a `reference` (`LD-00042`) issued from the row-locked document series — show it in the confirmation, because support can search on it. A phone number that is not an Indian ten-digit mobile is stored on the lead as free text rather than rejected; losing a genuine enquiry over a landline would be the wrong trade. Rate-limited to 10 submissions per hour per IP. There is no captcha in front of this yet — if volume becomes a problem, that is the next control, not a tighter limiter.

| | |
|---|---|
| operationId | `submitContactEnquiry` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | **yes** | Who is writing in. <br><sub>minLen 2, maxLen 120</sub> |
| `email` | string | **yes** | Where the reply goes. The only field the reply strictly needs. <br><sub>maxLen 255, email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |
| `phone` | string | no | Optional call-back number. <br><sub>minLen 6, maxLen 20, pattern `^[0-9+\-\s()]+$`</sub> |
| `message` | string | **yes** | The enquiry itself. Stored verbatim on the lead as its brief. <br><sub>minLen 10, maxLen 4000</sub> |
| `company` | string | no | Optional. Supplied, the enquiry is filed against the company; otherwise against the person. <br><sub>maxLen 160</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The enquiry is saved. |
| `422` | Validation failed. |
| `429` | Too many submissions from this IP. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/leads/corporate-gifting`

> Submit a corporate gifting brief

The B2B pipeline’s front door, and the highest-value form on the site. Persists to the same lead board the sales team works from, tagged `website_corporate_form`. 

The **25-unit minimum is enforced server-side**. The storefront expresses it as `min={25}` on an `<input>`, which any direct API call ignores; a brief for three mugs entering the corporate pipeline wastes a salesperson’s afternoon. Rate-limited to 10 submissions per hour per IP. There is no captcha in front of this yet — if volume becomes a problem, that is the next control, not a tighter limiter.

| | |
|---|---|
| operationId | `submitCorporateGiftingBrief` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | **yes** | The buyer’s name. <br><sub>minLen 2, maxLen 120</sub> |
| `company` | string | **yes** | Company the gifting programme is for. <br><sub>minLen 2, maxLen 160</sub> |
| `workEmail` | string | **yes** | Work email address. Proposals and quotations go here. <br><sub>maxLen 255, email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |
| `quantity` | integer | **yes** | Units needed. The 25-unit minimum is enforced **here**, server-side — the storefront’s `min={25}` is an HTML attribute and a direct API call ignores it. <br><sub>min 25, max 1000000</sub> |
| `brief` | string | **yes** | Free-text brief: occasion, budget, branding, timelines. <br><sub>minLen 10, maxLen 4000</sub> |
| `mobile` | string | no | Optional direct line. Corporate leads convert far faster on a call than on email. <br><sub>pattern `^[6-9][0-9]{9}$`</sub> |
| `occasion` | string | no | Diwali, onboarding kits, client appreciation, … <br><sub>maxLen 120</sub> |
| `employeeCount` | integer | no | Headcount, when known. Drives programme sizing. <br><sub>max 10000000</sub> |
| `city` | string | no | Delivery city, when known. <br><sub>maxLen 80</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The brief is saved. |
| `422` | Below the 25-unit minimum, or a field failed validation. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/newsletter/subscribe`

> Subscribe to the newsletter

Adds the address to the marketing list and records the consent with a timestamp, a source and an IP — a boolean column alone cannot answer "prove when they opted in", which is the question the DPDP Act actually asks. 

Idempotent and deliberately uninformative: the same `{ "status": "subscribed" }` comes back for a new address, for a customer who had opted out, and for one already on the list. A footer form that said "you already have an account" would be an account-existence oracle on every page. 

The subscriber list and the account list are the same rows, so the footer form and the profile toggle cannot disagree. Double opt-in is not implemented — it is an open business question.

| | |
|---|---|
| operationId | `subscribeToNewsletter` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | **yes** | The address to subscribe. Case-insensitive — stored CITEXT. <br><sub>maxLen 255, email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |
| `source` | `footer` \| `profile` \| `checkout` \| `popup` | no | Which control the customer used. Recorded with the consent, because consent needs provenance. <br><sub>default `"footer"`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Subscribed (or already subscribed). |
| `422` | Validation failed. |
| `429` | Too many submissions from this IP. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Navigation

#### `GET /v1/menus/{key}`

> Get a navigation menu

A named menu (`header`, `footer`, `mobile`) with every visible item as a FLAT, depth-ordered array. Build the tree from `parentId`: megamenu depth is not fixed and a self-referencing response type is not expressible in a generated client. A hidden parent hides its whole branch, and items pointing at a dead collection are omitted.

| | |
|---|---|
| operationId | `getMenuByKey` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `key` | string | **yes** | Menu key. The three that exist today are `header`, `footer` and `mobile`. <br><sub>minLen 2, maxLen 60, pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The menu and its items. |
| `404` | No menu has that key. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Orders

#### `GET /v1/account/orders`

> List my orders

Newest first. `status` is the real sixteen-value operational status driven by fulfilment and gateway events; `trackingStage` is the five-stage projection the UI renders. `canCancel` tells you whether to show the cancel button — the API re-checks it under a row lock anyway. Wrapped as `{ data, meta }` with `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listMyOrders` |
| Auth | `bearerAuth` (customer) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `status` | `pending_payment` \| `paid` \| `confirmed` \| `in_production` \| `personalisation_pending` \| `quality_check` \| `packed` \| `ready_to_ship` \| `shipped` \| `out_for_delivery` \| `delivered` \| `failed_delivery` \| `rto` \| `cancelled` \| `refund_initiated` \| `refunded` | no | Filter to a single operational status. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of orders. |
| `401` | Missing, malformed or expired token. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/account/orders/{orderId}`

> Get one of my orders

Everything the order page renders: the frozen address and buyer snapshots, the per-line GST breakdown, add-ons, personalisation instructions, and the append-only timeline. An order id that is not yours returns 404, not 403 — confirming that an order exists is itself a leak.

| | |
|---|---|
| operationId | `getMyOrder` |
| Auth | `bearerAuth` (customer) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | **yes** | Order id from `GET /v1/account/orders`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The order. |
| `401` | Missing, malformed or expired token. |
| `404` | No such order, or it belongs to someone else. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/account/orders/{orderId}/cancel`

> Cancel one of my orders

The only state transition a customer owns, and only from a pre-shipped state (`pending_payment`, `paid`, `confirmed`, `in_production`, `personalisation_pending`, `quality_check`, `packed`, `ready_to_ship`). Anything later returns 422 `order_not_cancellable` with the reason — once a courier has it, cancelling is a return, not an update.

In one transaction it releases the stock reservation, returns the coupon redemption to the pool, stamps the cancellation and appends a timeline event. An order that was actually paid moves to `refund_initiated`, not `cancelled`, and a gateway refund is started afterwards — only the gateway’s confirmation moves it to `refunded`, because telling someone their money is back before it is would be a lie.

| | |
|---|---|
| operationId | `cancelMyOrder` |
| Auth | `bearerAuth` (customer) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | **yes** | Order id from `GET /v1/account/orders`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | no | Why you are cancelling. Stored on the order and shown to ops. <br><sub>maxLen 400</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The cancelled order. |
| `401` | Missing, malformed or expired token. |
| `404` | No such order, or it belongs to someone else. |
| `422` | The order has moved past the point where a customer may cancel it. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/orders/track`

> Track an order without signing in

Backs the public tracking page. Requires the order number AND a matching mobile number — either the buyer’s or the recipient’s, because the person chasing a gift is often the recipient. Order numbers are sequential and therefore guessable, so the mobile number is the actual secret; a wrong number and a non-existent order return the same 404.

Each stage carries the timestamp of the event that actually happened, or null. Nothing here is derived from elapsed time, and no address, email, name or price is returned.

| | |
|---|---|
| operationId | `trackOrder` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `orderNo` | string | **yes** | The order number from the confirmation email. <br><sub>pattern `^ACH[0-9]{6,}$`</sub> |
| `mobile` | string | **yes** | The buyer’s or recipient’s mobile number. Both must match — the number is the shared secret. <br><sub>pattern `^[6-9][0-9]{9}$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The tracking view. |
| `404` | No order matches that number and mobile number. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Pages

#### `GET /v1/pages`

> List content pages

Occasion landing pages, policy pages, about and static pages — one table, discriminated by `kind`. Filter with `kind=policy` for the footer’s legal links. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listContentPages` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `kind` | `occasion` \| `policy` \| `landing` \| `about` \| `static` | no | Restrict to one page kind. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of content pages. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/pages/{slug}`

> Get a content page by slug

Any published page, whatever its kind. For an occasion page, `collectionHandle` names the collection whose products belong on it — fetch them with `listCollectionProducts`.

| | |
|---|---|
| operationId | `getContentPageBySlug` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `slug` | string | **yes** | URL slug of the resource, e.g. `shipping` or `gifting-for-diwali`. <br><sub>minLen 2, maxLen 160, pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The page. |
| `404` | No published page has that slug. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/policies/{slug}`

> Get a policy page by slug

The published, linkable policy URLs: `shipping`, `returns`, `privacy`, `terms`, `cookies`. Identical shape to `getContentPageBySlug` but restricted to `kind=policy`, so an occasion page can never be served from a `/policies/…` URL.

| | |
|---|---|
| operationId | `getPolicyBySlug` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `slug` | string | **yes** | URL slug of the resource, e.g. `shipping` or `gifting-for-diwali`. <br><sub>minLen 2, maxLen 160, pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The policy page. |
| `404` | No published policy page has that slug. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Payments

#### `POST /v1/payments/razorpay/order`

> Create (or reuse) a Razorpay order for an existing order

`POST /v1/orders` already returns a session for a prepaid order, so this is the retry path — use it when that response came back with `payment: null` (the gateway was unreachable at the time), or when the customer abandoned Checkout and came back to pay later.

The amount is the order’s outstanding balance read from `orders.total_paise`; there is no field through which a client can propose one. An unconsumed session for the same amount is returned again rather than a second one being created, so double-tapping “Pay now” is free. Only `keyId` is returned — the key secret never leaves the server.

| | |
|---|---|
| operationId | `createRazorpayOrder` |
| Auth | `bearerAuth` (customer) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `orderId` | string | **yes** | The order to collect payment for. Must belong to the caller. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The payment session to hand to Checkout.js. |
| `401` | Missing, malformed or expired token. |
| `404` | No such order, or it belongs to someone else. |
| `422` | The order is already paid, or has been cancelled or refunded. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |
| `502` | Razorpay could not be reached. Safe to retry. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/payments/razorpay/verify`

> Verify the Razorpay checkout hand-back

Call this from the Checkout.js success handler with the three identifiers it gives you. The signature — `HMAC-SHA256(razorpay_order_id|razorpay_payment_id)` keyed with the API secret — is verified in constant time, and the Razorpay order is confirmed to belong to this order.

**A valid signature is not proof of payment.** It proves the identifiers are genuine, nothing more; a signed but merely *authorised* payment has taken no money. So the payment is refetched from Razorpay and only a `captured` status is applied. If the webhook already applied it, this returns the same state without double-crediting the order.

A failure here does not mean the payment failed — the webhook remains the source of truth and will confirm the order regardless of whether the browser ever came back.

| | |
|---|---|
| operationId | `verifyRazorpayPayment` |
| Auth | `bearerAuth` (customer) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `orderId` | string | **yes** | The order the payment belongs to. Must belong to the caller. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `razorpayOrderId` | string | **yes** | `razorpay_order_id` from the Checkout success handler. <br><sub>minLen 4, maxLen 64</sub> |
| `razorpayPaymentId` | string | **yes** | `razorpay_payment_id` from the Checkout success handler. <br><sub>minLen 4, maxLen 64</sub> |
| `razorpaySignature` | string | **yes** | HMAC-SHA256 of `razorpay_order_id\|razorpay_payment_id` keyed with the API secret, hex-encoded. Verified in constant time. <br><sub>minLen 64, maxLen 64</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The order’s payment state after applying the capture. |
| `401` | Missing, malformed or expired token. |
| `404` | No such order, or it belongs to someone else. |
| `422` | The signature did not verify (`signature_invalid`), the Razorpay order belongs to a different order (`payment_order_mismatch`), or the payment is not captured yet (`payment_not_captured`). |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |
| `502` | Razorpay could not be reached to confirm the payment. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Products

#### `GET /v1/products`

> List and filter products

The product grid behind `/collections/:handle` and every merchandising rail. `price`, `stock`, `sameDay`, `bestSeller` and `isNew` are derived at read time from variants, inventory and collection membership — none of them is a stored column. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listProducts` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `collection` | string | no | Restrict to a collection handle, any kind. e.g. `festivals-diwali`. <br><sub>pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |
| `type` | string \| array<string> | no | Category handle(s) to include. Repeat the parameter for several, e.g. `type=drinkware&type=candles`. |
| `designer` | string | no | Restrict to one designer handle. <br><sub>pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |
| `minPricePaise` | integer | no | Inclusive lower price bound, integer paise. <br><sub>min 0, max 9007199254740991</sub> |
| `maxPricePaise` | integer | no | Inclusive upper price bound, integer paise. <br><sub>min 0, max 9007199254740991</sub> |
| `inStock` | `0` \| `1` \| `true` \| `false` | no | `true` hides products whose `stock` is `out`. |
| `sameDay` | `0` \| `1` \| `true` \| `false` | no | `true` keeps only products with same-day-capable stock. |
| `personalisable` | `0` \| `1` \| `true` \| `false` | no | `true` keeps only personalisable products. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of products. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/products/{handle}`

> Get a product by handle

Everything the PDP renders in one call: gallery, contents, variants with per-variant stock, add-ons (falling back to the global set when none are pinned), personalisation templates, related handles and SEO overrides.

| | |
|---|---|
| operationId | `getProductByHandle` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | **yes** | URL slug of the resource, e.g. `bamboo-water-bottle`. <br><sub>minLen 2, maxLen 120, pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The product. |
| `404` | No published product has that handle. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/products/{handle}/variants`

> List a product’s variants

The stock-bearing units. Cart lines reference a variant id, never a product id. Already included in `getProductByHandle` — use this when only availability changed.

| | |
|---|---|
| operationId | `listProductVariants` |
| Auth | public |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `handle` | string | **yes** | URL slug of the resource, e.g. `bamboo-water-bottle`. <br><sub>minLen 2, maxLen 120, pattern `^[a-z0-9]+(-[a-z0-9]+)*$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Active variants in display order. |
| `404` | No published product has that handle. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---


## SEO

#### `GET /v1/seo`

> Get the SEO record for an entity or a route

Meta tags, canonical URL, robots directives and JSON-LD. Look up either an entity (`entityType` + `entityId`) or a bare route (`routePath`, e.g. `/`) — exactly one of the two. Product, collection, page and post detail responses already embed their own SEO block; this endpoint exists for routes that have no entity behind them.

| | |
|---|---|
| operationId | `getSeoEntry` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `entityType` | `product` \| `collection` \| `content_page` \| `blog_post` | no | Entity kind. Requires `entityId`. Omit both to look up a route instead. |
| `entityId` | string | no | Entity id. Requires `entityType`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `routePath` | string | no | Route to look up instead of an entity, e.g. `/` or `/corporate-gifting`. <br><sub>maxLen 200</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The SEO record. |
| `404` | Nothing has been authored for that entity or route. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Search

#### `GET /v1/search`

> Search products

Full-text search with typo tolerance. Results are the same `productSummary` shape `listProducts` returns, so a result card and a grid card are one component. Ranking weights title matches over body matches and gives best sellers a small nudge. When `meta.total` is 0, call `getSearchSuggestions` for the recovery screen. Never cached — availability in results is as live as the PDP.

| | |
|---|---|
| operationId | `searchProducts` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | `relevance` \| `price` \| `-price` \| `publishedAt` \| `-publishedAt` | no | Ordering. `relevance` (the default) is always best-first. Prefix with `-` for descending, e.g. `-price` for dearest first. |
| `q` | string | **yes** | The shopper’s raw query. Typos are tolerated; punctuation is ignored. <br><sub>minLen 1, maxLen 120</sub> |
| `type` | string \| array<string> | no | Category handle(s) to restrict to. Repeat the parameter or comma-separate, e.g. `type=drinkware,candles`. |
| `minPricePaise` | integer | no | Inclusive lower price bound, integer paise. <br><sub>min 0, max 9007199254740991</sub> |
| `maxPricePaise` | integer | no | Inclusive upper price bound, integer paise. <br><sub>min 0, max 9007199254740991</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of matching products, wrapped as `{ data, meta }`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/search/suggest`

> Autocomplete products for the header search

Fast prefix-biased lookup for the search-as-you-type dropdown. Title-prefix hits come first, then fuzzy matches, then popularity. Send at least two characters; shorter queries tokenise to nothing and return an empty page.

| | |
|---|---|
| operationId | `suggestProducts` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Autocomplete rows to return. Maximum 20, default 6. <br><sub>max 20, default `6`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | **yes** | The shopper’s raw query. Typos are tolerated; punctuation is ignored. <br><sub>minLen 1, maxLen 120</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Up to `perPage` autocomplete matches, wrapped as `{ data, meta }`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/search/suggestions`

> Recovery hints for a search that returned nothing

Everything the no-results screen needs, in one call: a "did you mean" rewrite, the number of matches once every filter is dropped, and the categories and price windows that do hold matches. `fallback` is populated only when the query matches nothing at all — that is the "here are some popular gifts instead" case.

| | |
|---|---|
| operationId | `getSearchSuggestions` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `q` | string | **yes** | The shopper’s raw query. Typos are tolerated; punctuation is ignored. <br><sub>minLen 1, maxLen 120</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Suggestions for relaxing or correcting the query. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## System

#### `GET /healthz`

> Liveness probe

Returns 200 whenever the process is running. Deliberately does NOT touch the database — a liveness probe that fails on a DB blip gets your healthy container killed during an outage.

| | |
|---|---|
| operationId | `getLiveness` |
| Auth | public |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The process is alive. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /readyz`

> Readiness probe

Checks Postgres and Redis. Returns 503 when a dependency is down so the load balancer stops sending traffic without the container being restarted.

| | |
|---|---|
| operationId | `getReadiness` |
| Auth | public |

**Responses**

| Status | Meaning |
|---|---|
| `200` | All dependencies reachable. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |
| `503` | At least one dependency is unreachable. |

---


## Testimonials

#### `GET /v1/testimonials`

> List testimonials

Moderated marketing quotes. B2C quotes carry `authorCity`; B2B quotes carry `company` and `designation`. These are NOT product reviews — those live on the product. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

| | |
|---|---|
| operationId | `listTestimonials` |
| Auth | public |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. <br><sub>pattern `^-?[a-zA-Z][a-zA-Z0-9_]*$`</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `featured` | `0` \| `1` \| `true` \| `false` | no | `true` keeps only featured testimonials. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of testimonials. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---


## Webhooks

#### `POST /v1/webhooks/razorpay`

> Razorpay payment webhook

The authoritative source of payment state. Configure it in the Razorpay dashboard for `payment.captured`, `payment.failed`, `refund.processed` and `refund.failed`.

**Authentication is the `X-Razorpay-Signature` header**, an HMAC-SHA256 of the raw request body keyed with the webhook secret — a different secret from the API key secret. It is computed over the exact bytes received, never over re-serialised JSON, and compared in constant time. A signature that does not verify returns 400 and writes nothing at all, so an unauthenticated caller cannot even fill the event table.

**Replay-safe.** Every delivery is persisted by its `X-Razorpay-Event-Id` (falling back to a hash of the body) into `payment_events`, whose `(gateway, event_id)` uniqueness is the idempotency boundary — the INSERT is the claim. Five deliveries of the same event produce exactly one state change; the rest return `duplicate: true`. Underneath that, capture is keyed on the Razorpay payment id and refunds on the Razorpay refund id, so even a bypassed claim cannot double-credit an order.

A delivery whose processing throws is left unprocessed and answered with 5xx, so Razorpay’s retry does real work rather than being waved through as a duplicate. Unknown event types are acknowledged with 200 — a 4xx would make Razorpay retry something this API will never understand.

| | |
|---|---|
| operationId | `razorpayWebhook` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `event` | string | **yes** | Event name, e.g. `payment.captured`, `payment.failed`, `refund.processed`. <br><sub>minLen 3, maxLen 120</sub> |
| `account_id` | string | no | Razorpay account the event belongs to. |
| `created_at` | integer | no | Unix seconds at which Razorpay created the event. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `contains` | array<string> | no | Which entities are present in `payload`. |
| `payload` | object | no | The entities this event carries. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Received. `duplicate` is true when the event had already been processed. |
| `400` | The signature header is missing or does not verify. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


---

# Admin surface

**162 operations** · Swagger UI at `/docs/admin` (gated — requires a staff token with `settings:view`)

| Group | Operations |
|---|---|
| Admin auth | 13 |
| Admin catalogue | 28 |
| Admin content | 21 |
| Admin customers | 7 |
| Admin goods receipts | 3 |
| Admin inventory | 32 |
| Admin orders | 10 |
| Admin promotions | 14 |
| Admin purchase returns | 5 |
| Admin purchasing | 7 |
| Admin resources | 1 |
| Admin suppliers | 3 |
| Admin transfers | 7 |
| Admin warehousing | 6 |
| RBAC | 5 |


## Admin auth

#### `POST /v1/admin/auth/2fa/enable`

> Finish authenticator enrolment and sign in

Verifies a code against the pending secret, flips `mfaEnabled`, issues ten single-use recovery codes and completes the sign-in in one call. **The recovery codes are returned exactly once** — only their sha256 digests are stored, so there is no endpoint that can show them again.

| | |
|---|---|
| operationId | `adminEnableTwoFactor` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `challengeToken` | string | **yes** | The enrolment `challengeToken` from login. Required — enrolment is part of signing in. <br><sub>minLen 10</sub> |
| `code` | string | **yes** | A code from the app, proving the secret was stored correctly. <br><sub>pattern `^[0-9]{6}$`</sub> |
| `deviceLabel` | string | no | Human label for this device. <br><sub>maxLen 80</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `201` | Enrolled and signed in. Store the recovery codes now. |
| `401` | The challenge token or the code is not valid. |
| `422` | No pending secret — call `/2fa/setup` first. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/auth/2fa/recovery-codes`

> Reissue the ten recovery codes

Discards every unused code and returns ten new ones, shown once. Requires a live step-up (`POST /v1/admin/auth/step-up`) — without that, anyone who found an open console could mint themselves a permanent second-factor bypass.

| | |
|---|---|
| operationId | `adminRegenerateRecoveryCodes` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `201` | Ten new codes. Store them now. |
| `401` | Missing, malformed or expired token. |
| `403` | No recent step-up. |
| `422` | This account has no authenticator enrolled. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/auth/2fa/setup`

> Begin authenticator enrolment

Returns a fresh base32 secret and its `otpauth://` URI for the QR code. The secret is stored against the account immediately but `mfaEnabled` stays false, so a half-finished enrolment cannot be used to sign in — only `POST /2fa/enable`, which requires a code generated from this secret, completes it. Calling this again replaces the pending secret.

| | |
|---|---|
| operationId | `adminStartTwoFactorSetup` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `challengeToken` | string | **yes** | The enrolment `challengeToken` from login. <br><sub>minLen 10</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The secret and QR payload. Shown once. |
| `401` | The challenge token is missing, expired or malformed. |
| `422` | This account already has an authenticator. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/auth/2fa/verify`

> Complete sign-in with the second factor

Backs `/two-factor`. Send exactly one of `code` (six digits from the app) or `recoveryCode` (single-use; the digest is deleted whether or not anything later fails). A wrong value counts towards the same five-attempt lockout as a wrong password.

`trustDevice` is accepted so the console’s checkbox has somewhere to go, but it does not mint a 2FA bypass cookie — skipping the second factor for thirty days on a device is precisely the exposure the second factor exists to remove.

| | |
|---|---|
| operationId | `adminVerifyTwoFactor` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `challengeToken` | string | **yes** | The `challengeToken` returned by `POST /v1/admin/auth/login`. Valid for five minutes. <br><sub>minLen 10</sub> |
| `code` | string | no | The six-digit code from the authenticator app. <br><sub>pattern `^[0-9]{6}$`</sub> |
| `recoveryCode` | string | no | A one-time recovery code, if the authenticator is unavailable. Consumed on use. <br><sub>minLen 6, maxLen 24</sub> |
| `trustDevice` | boolean | no | Accepted for the console’s “trust this device” checkbox. It currently only lengthens the device label — no 2FA bypass cookie is minted, because a bypass is exactly the thing the second factor exists to prevent. <br><sub>default `false`</sub> |
| `deviceLabel` | string | no | Human label for this device. <br><sub>maxLen 80</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Signed in. |
| `401` | The challenge token, code or recovery code is not valid. |
| `422` | This account has no authenticator — enrol instead. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/auth/login`

> Sign in to the admin console

Backs `/login`. A correct password does NOT necessarily produce a session — read `status`:

- `authenticated` — a read-only role, or 2FA already satisfied. `tokens` is populated and the refresh cookie is set.
- `mfa_required` — an authenticator is enrolled. Route to `/two-factor` and post the `challengeToken` with the six-digit code.
- `enrolment_required` — **the role can change data and has no second factor.** No session is issued at all. Route to `/two-factor` in enrolment mode: `POST /2fa/setup` for the QR, then `POST /2fa/enable`.

An unknown email, a wrong password and an account with no password set are one identical 401 that costs the same wall-clock time, because response latency is otherwise an account-enumeration oracle. Five failures lock the account for fifteen minutes.

| | |
|---|---|
| operationId | `adminLogin` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | **yes** | Work email. Matching is case-insensitive — the column is CITEXT. <br><sub>maxLen 254, email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |
| `password` | string | **yes** | The account password. Never logged, never audited. <br><sub>minLen 1, maxLen 200</sub> |
| `deviceLabel` | string | no | Human label for this device, e.g. `MacBook Pro · Chrome`. Shown on the sessions screen. <br><sub>maxLen 80</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Signed in, or told which second-factor step comes next. |
| `401` | Bad credentials, or the account is temporarily locked. |
| `403` | The credentials were right but the account is suspended or still invited. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/auth/logout`

> Sign out of this session

Revokes the session row, adds it to the Redis denylist so the outstanding access token stops working immediately rather than at expiry, clears any step-up window and clears the cookie. Deliberately 204 whether or not a session was found — sign-out must never fail.

| | |
|---|---|
| operationId | `adminLogout` |
| Auth | public |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Signed out. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `POST /v1/admin/auth/password/forgot`

> Request a password-reset token

Always 200 with the same body, whether or not the address belongs to an account — otherwise this endpoint is a staff-directory oracle. The token is 256 random bits, valid for thirty minutes, single-use, and only its argon2id hash is stored (in `otp_challenges`, reusing that table’s expiry and attempt semantics rather than inventing new ones).

| | |
|---|---|
| operationId | `adminForgotPassword` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | **yes** | Work email. Matching is case-insensitive — the column is CITEXT. <br><sub>maxLen 254, email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Accepted. Says nothing about whether the account exists. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/auth/password/reset`

> Set a new password with a reset token

Backs `/reset-password`, which today does not read a token from the URL at all — it must, and this endpoint requires it alongside the email. On success the token is consumed, an `invited` account becomes `active`, the lockout counter is cleared, and **every other session is revoked**: a reset is what you do when you think someone else has your credentials.

| | |
|---|---|
| operationId | `adminResetPassword` |
| Auth | public |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | **yes** | Work email. Matching is case-insensitive — the column is CITEXT. <br><sub>maxLen 254, email, pattern `^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A`</sub> |
| `token` | string | **yes** | The single-use token from the reset email. Only its argon2id hash is stored. <br><sub>minLen 20, maxLen 200</sub> |
| `newPassword` | string | **yes** | At least 12 characters with upper case, lower case and a digit. <br><sub>minLen 12, maxLen 200</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The password was changed. Sign in again. |
| `422` | The token is unknown, expired, already used or tried too many times. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/auth/refresh`

> Exchange the refresh cookie for a new access token

Reads the httpOnly `ach_art` cookie — nothing in the body. Rotates the stored hash, so the presented token is dead the moment this returns, and re-reads the role’s grants from `role_permissions`, which is what makes a revoked permission take effect within one ten-minute access-token lifetime instead of at the next sign-in. A token that matches no live row is a flat 401; the console should route to `/session-expired`.

| | |
|---|---|
| operationId | `adminRefreshSession` |
| Auth | public |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A new access token, and a rotated refresh cookie. |
| `401` | No cookie, or it is expired, revoked or unknown. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/auth/step-up`

> Re-enter your password to unlock money movement

Opens a five-minute window on the CURRENT session. `POST /v1/admin/orders/{orderId}/refund` requires it: ten minutes of access-token life is a long time for an unattended laptop and a refund is irreversible. The window lives in Redis, not in a token claim, so signing out or revoking the session ends it instantly. `GET /v1/admin/me` reports `stepUpActive`.

| | |
|---|---|
| operationId | `adminStepUpReauth` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `password` | string | **yes** | The current account password, re-entered. <br><sub>minLen 1, maxLen 200</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Step-up granted. |
| `401` | The password was wrong. This counts towards the lockout. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/me`

> The signed-in staff member

Everything the console shell needs on boot: identity, role, the flat `module:action` grant list, the modules to render in the nav, warehouse scope (an EMPTY array means every warehouse), whether 2FA is enrolled and whether this role is required to have it. The grant list is for optimistic UI only — the server re-checks every call, so hiding a button is a convenience, not a control.

| | |
|---|---|
| operationId | `getAdminMe` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The current staff member. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `dashboard:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/sessions`

> My active sessions

Backs the sessions table on `/profile`. Only your own sessions — signing another staff member out is a `settings` action, not self-service.

| | |
|---|---|
| operationId | `listMyStaffSessions` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Live sessions, most recently used first. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `dashboard:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `DELETE /v1/admin/sessions/{sessionId}`

> Revoke one of my sessions

Revokes the row and denylists the session id, so the access token issued from it stops working on the next request rather than at expiry. A session id belonging to someone else returns 404, not 403 — confirming it exists is itself a leak.

| | |
|---|---|
| operationId | `revokeMyStaffSession` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `sessionId` | string | **yes** | Session id from `GET /v1/admin/sessions`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Revoked. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `dashboard:view`. |
| `404` | No such session, or it is not yours. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---


## Admin catalogue

#### `GET /v1/admin/collections`

> List collections

One taxonomy table for categories, occasions, festivals, recipients, designer pages and edits.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListCollections` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/collections`

> Create a collection

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateCollection` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `handle` | string | **yes** | Handle. Public route key. Unique among live collections. <br><sub>maxLen 120</sub> |
| `kind` | `category` \| `recipient` \| `occasion` \| `festival` \| `designer` \| `edit` | **yes** | Kind. |
| `title` | string | **yes** | Nav title. <br><sub>maxLen 160</sub> |
| `heading` | string \| null | no |  |
| `subtext` | string \| null | no |  |
| `seoDescription` | string \| null | no |  |
| `parentId` | string \| null | no |  |
| `designerId` | string \| null | no |  |
| `curator` | string \| null | no |  |
| `sortOrder` | integer \| null | no |  |
| `isFeatured` | boolean \| null | no |  |
| `status` | `live` \| `scheduled` \| `draft` \| `archived` | **yes** | Status. |
| `startsOn` | string \| null | no |  |
| `endsOn` | string \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/collections/{id}`

> Archive a collection

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `catalogue:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteCollection` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/collections/{id}`

> Get one collection

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetCollection` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/collections/{id}`

> Update a collection

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateCollection` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `handle` | string \| null | no |  |
| `kind` | `category` \| `recipient` \| `occasion` \| `festival` \| `designer` \| `edit` \| null | no |  |
| `title` | string \| null | no |  |
| `heading` | string \| null | no |  |
| `subtext` | string \| null | no |  |
| `seoDescription` | string \| null | no |  |
| `parentId` | string \| null | no |  |
| `designerId` | string \| null | no |  |
| `curator` | string \| null | no |  |
| `sortOrder` | integer \| null | no |  |
| `isFeatured` | boolean \| null | no |  |
| `status` | `live` \| `scheduled` \| `draft` \| `archived` \| null | no |  |
| `startsOn` | string \| null | no |  |
| `endsOn` | string \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/collections/bulk`

> Bulk action on collections

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkCollections` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/collections/schema`

> Field spec for collections

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetCollectionSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/designers`

> List brands & designers

Partners. Commission is stored in basis points, not whole percent.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListDesigners` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/designers`

> Create a designer

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateDesigner` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `handle` | string | **yes** | Handle. <br><sub>maxLen 120</sub> |
| `name` | string | **yes** | Partner. <br><sub>maxLen 160</sub> |
| `kind` | `designer` \| `brand` \| `celebrity` \| `artisan_cluster` | **yes** | Type. |
| `bio` | string \| null | no |  |
| `commissionBp` | integer \| null | no |  |
| `contactEmail` | string \| null | no |  |
| `contactPhone` | string \| null | no |  |
| `status` | `active` \| `paused` \| `archived` | **yes** | Status. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/designers/{id}`

> Archive a designer

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `catalogue:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteDesigner` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/designers/{id}`

> Get one designer

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetDesigner` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/designers/{id}`

> Update a designer

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateDesigner` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `handle` | string \| null | no |  |
| `name` | string \| null | no |  |
| `kind` | `designer` \| `brand` \| `celebrity` \| `artisan_cluster` \| null | no |  |
| `bio` | string \| null | no |  |
| `commissionBp` | integer \| null | no |  |
| `contactEmail` | string \| null | no |  |
| `contactPhone` | string \| null | no |  |
| `status` | `active` \| `paused` \| `archived` \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/designers/bulk`

> Bulk action on brands & designers

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkDesigners` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/designers/schema`

> Field spec for brands & designers

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetDesignerSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/product-variants`

> List product variants

SKU-level rows. Prices are GST-INCLUSIVE integer paise.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListProductVariants` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/product-variants`

> Create a productvariant

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateProductVariant` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `productId` | string | **yes** | Product. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `sku` | string | **yes** | SKU. <br><sub>maxLen 64</sub> |
| `optionLabel` | string | **yes** | Option label. `Signature`, `Rose`, `A5`. <br><sub>maxLen 80</sub> |
| `optionValue` | string | **yes** | Option value. Slug form. Unique per product. <br><sub>maxLen 80</sub> |
| `pricePaise` | integer | **yes** | Price. GST-inclusive. Integer paise — 149900 is ₹1,499.00. <br><sub>min 0, max 9007199254740991</sub> |
| `compareAtPaise` | integer \| null | no |  |
| `costPaise` | integer \| null | no |  |
| `weightGrams` | integer \| null | no |  |
| `lengthMm` | integer \| null | no |  |
| `widthMm` | integer \| null | no |  |
| `heightMm` | integer \| null | no |  |
| `barcode` | string \| null | no |  |
| `isDefault` | boolean \| null | no |  |
| `position` | integer \| null | no |  |
| `status` | `active` \| `inactive` | **yes** | Status. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/product-variants/{id}`

> Archive a productvariant

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `catalogue:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteProductVariant` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/product-variants/{id}`

> Get one productvariant

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetProductVariant` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/product-variants/{id}`

> Update a productvariant

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateProductVariant` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `productId` | string \| null | no |  |
| `sku` | string \| null | no |  |
| `optionLabel` | string \| null | no |  |
| `optionValue` | string \| null | no |  |
| `pricePaise` | integer \| null | no |  |
| `compareAtPaise` | integer \| null | no |  |
| `costPaise` | integer \| null | no |  |
| `weightGrams` | integer \| null | no |  |
| `lengthMm` | integer \| null | no |  |
| `widthMm` | integer \| null | no |  |
| `heightMm` | integer \| null | no |  |
| `barcode` | string \| null | no |  |
| `isDefault` | boolean \| null | no |  |
| `position` | integer \| null | no |  |
| `status` | `active` \| `inactive` \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/product-variants/bulk`

> Bulk action on product variants

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkProductVariants` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/product-variants/schema`

> Field spec for product variants

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetProductVariantSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/products`

> List products

The sellable catalogue. `kind` is a fulfilment class, not the storefront category.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListProducts` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/products`

> Create a product

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateProduct` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `handle` | string | **yes** | Handle. URL slug. Lower case, hyphenated. Unique among live products. <br><sub>maxLen 120</sub> |
| `title` | string | **yes** | Title. <br><sub>maxLen 200</sub> |
| `subtitle` | string \| null | no |  |
| `description` | string \| null | no |  |
| `kind` | `hamper` \| `single_gift` \| `personalised` \| `gourmet` \| `add_on` \| `builder` | **yes** | Fulfilment kind. |
| `designerId` | string \| null | no |  |
| `primaryCollectionId` | string \| null | no |  |
| `hsnCode` | string \| null | no |  |
| `isPersonalisable` | boolean \| null | no |  |
| `isPerishable` | boolean \| null | no |  |
| `isFragile` | boolean \| null | no |  |
| `requiresShipping` | boolean \| null | no |  |
| `lowStockThreshold` | integer \| null | no |  |
| `badgeOverride` | `best_seller` \| `new` \| `limited` \| `none` \| null | no |  |
| `tags` | array<string> \| null | no |  |
| `status` | `active` \| `draft` \| `archived` | **yes** | Status. |
| `publishedAt` | string \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/products/{id}`

> Archive a product

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `catalogue:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteProduct` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/products/{id}`

> Get one product

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetProduct` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/products/{id}`

> Update a product

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateProduct` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `handle` | string \| null | no |  |
| `title` | string \| null | no |  |
| `subtitle` | string \| null | no |  |
| `description` | string \| null | no |  |
| `kind` | `hamper` \| `single_gift` \| `personalised` \| `gourmet` \| `add_on` \| `builder` \| null | no |  |
| `designerId` | string \| null | no |  |
| `primaryCollectionId` | string \| null | no |  |
| `hsnCode` | string \| null | no |  |
| `isPersonalisable` | boolean \| null | no |  |
| `isPerishable` | boolean \| null | no |  |
| `isFragile` | boolean \| null | no |  |
| `requiresShipping` | boolean \| null | no |  |
| `lowStockThreshold` | integer \| null | no |  |
| `badgeOverride` | `best_seller` \| `new` \| `limited` \| `none` \| null | no |  |
| `tags` | array<string> \| null | no |  |
| `status` | `active` \| `draft` \| `archived` \| null | no |  |
| `publishedAt` | string \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/products/bulk`

> Bulk action on products

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkProducts` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/products/schema`

> Field spec for products

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetProductSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `catalogue:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin content

#### `GET /v1/admin/banners`

> List banners

Storefront banners. Clicks and CTR are analytics and live in `banner_stats_daily`.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListBanners` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/banners`

> Create a banner

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateBanner` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | **yes** | Title. <br><sub>maxLen 200</sub> |
| `subtitle` | string \| null | no |  |
| `placement` | `homepage_hero` \| `category_top` \| `cart_strip` \| `pdp_ribbon` \| `announcement_bar` | **yes** | Placement. |
| `device` | `all` \| `desktop` \| `mobile` \| null | no |  |
| `mediaId` | string \| null | no |  |
| `mobileMediaId` | string \| null | no |  |
| `linkUrl` | string \| null | no |  |
| `collectionId` | string \| null | no |  |
| `ctaLabel` | string \| null | no |  |
| `position` | integer \| null | no |  |
| `startsAt` | string \| null | no |  |
| `endsAt` | string \| null | no |  |
| `status` | `live` \| `scheduled` \| `expired` \| `draft` | **yes** | Status. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/banners/{id}`

> Archive a banner

Archive: `status` becomes `expired`. This table has no `deleted_at` because other rows keep foreign keys to it.

Gated on `content:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteBanner` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/banners/{id}`

> Get one banner

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetBanner` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/banners/{id}`

> Update a banner

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateBanner` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string \| null | no |  |
| `subtitle` | string \| null | no |  |
| `placement` | `homepage_hero` \| `category_top` \| `cart_strip` \| `pdp_ribbon` \| `announcement_bar` \| null | no |  |
| `device` | `all` \| `desktop` \| `mobile` \| null | no |  |
| `mediaId` | string \| null | no |  |
| `mobileMediaId` | string \| null | no |  |
| `linkUrl` | string \| null | no |  |
| `collectionId` | string \| null | no |  |
| `ctaLabel` | string \| null | no |  |
| `position` | integer \| null | no |  |
| `startsAt` | string \| null | no |  |
| `endsAt` | string \| null | no |  |
| `status` | `live` \| `scheduled` \| `expired` \| `draft` \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/banners/bulk`

> Bulk action on banners

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkBanners` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/banners/schema`

> Field spec for banners

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetBannerSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/faqs`

> List faqs

`answer` is NOT NULL — the console mock had no answer field at all.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListFaqs` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/faqs`

> Create a faq

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateFaq` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `question` | string | **yes** | Question. <br><sub>maxLen 400</sub> |
| `answer` | string | **yes** | Answer. <br><sub>maxLen 20000</sub> |
| `category` | string \| null | no |  |
| `position` | integer \| null | no |  |
| `status` | `published` \| `draft` | **yes** | Status. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/faqs/{id}`

> Archive a faq

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `content:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteFaq` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/faqs/{id}`

> Get one faq

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetFaq` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/faqs/{id}`

> Update a faq

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateFaq` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `question` | string \| null | no |  |
| `answer` | string \| null | no |  |
| `category` | string \| null | no |  |
| `position` | integer \| null | no |  |
| `status` | `published` \| `draft` \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/faqs/bulk`

> Bulk action on faqs

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkFaqs` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/faqs/schema`

> Field spec for faqs

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetFaqSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/testimonials`

> List testimonials

Marketing quotes, not linked to a product. Product reviews are a separate resource.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListTestimonials` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/testimonials`

> Create a testimonial

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateTestimonial` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `authorName` | string | **yes** | Author. <br><sub>maxLen 160</sub> |
| `authorCity` | string \| null | no |  |
| `company` | string \| null | no |  |
| `designation` | string \| null | no |  |
| `quote` | string | **yes** | Quote. <br><sub>maxLen 2000</sub> |
| `rating` | integer \| null | no |  |
| `mediaId` | string \| null | no |  |
| `isFeatured` | boolean \| null | no |  |
| `position` | integer \| null | no |  |
| `status` | `published` \| `pending` \| `rejected` | **yes** | Status. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/testimonials/{id}`

> Archive a testimonial

Archive: `status` becomes `rejected`. This table has no `deleted_at` because other rows keep foreign keys to it.

Gated on `content:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteTestimonial` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/testimonials/{id}`

> Get one testimonial

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetTestimonial` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/testimonials/{id}`

> Update a testimonial

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateTestimonial` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `authorName` | string \| null | no |  |
| `authorCity` | string \| null | no |  |
| `company` | string \| null | no |  |
| `designation` | string \| null | no |  |
| `quote` | string \| null | no |  |
| `rating` | integer \| null | no |  |
| `mediaId` | string \| null | no |  |
| `isFeatured` | boolean \| null | no |  |
| `position` | integer \| null | no |  |
| `status` | `published` \| `pending` \| `rejected` \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/testimonials/bulk`

> Bulk action on testimonials

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkTestimonials` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/testimonials/schema`

> Field spec for testimonials

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetTestimonialSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `content:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin customers

#### `GET /v1/admin/customers`

> List customers

Shoppers. Lifetime spend and order counts live in the `customer_stats` satellite, refreshed by a job, so they are not writable here.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListCustomers` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `customers:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/customers`

> Create a customer

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateCustomer` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `fullName` | string \| null | no |  |
| `email` | string \| null | no |  |
| `mobile` | string \| null | no |  |
| `birthday` | string \| null | no |  |
| `gender` | `female` \| `male` \| `other` \| `undisclosed` \| null | no |  |
| `segment` | `vip` \| `loyal` \| `new` \| `at_risk` \| `corporate_buyer` \| null | no |  |
| `corporateAccountId` | string \| null | no |  |
| `defaultBillingGstin` | string \| null | no |  |
| `tags` | array<string> \| null | no |  |
| `marketingOptIn` | boolean \| null | no |  |
| `whatsappOptIn` | boolean \| null | no |  |
| `acceptsCod` | boolean \| null | no |  |
| `blockedReason` | string \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `customers:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/customers/{id}`

> Archive a customer

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `customers:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteCustomer` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `customers:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/customers/{id}`

> Get one customer

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetCustomer` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `customers:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/customers/{id}`

> Update a customer

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateCustomer` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `fullName` | string \| null | no |  |
| `email` | string \| null | no |  |
| `mobile` | string \| null | no |  |
| `birthday` | string \| null | no |  |
| `gender` | `female` \| `male` \| `other` \| `undisclosed` \| null | no |  |
| `segment` | `vip` \| `loyal` \| `new` \| `at_risk` \| `corporate_buyer` \| null | no |  |
| `corporateAccountId` | string \| null | no |  |
| `defaultBillingGstin` | string \| null | no |  |
| `tags` | array<string> \| null | no |  |
| `marketingOptIn` | boolean \| null | no |  |
| `whatsappOptIn` | boolean \| null | no |  |
| `acceptsCod` | boolean \| null | no |  |
| `blockedReason` | string \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `customers:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/customers/bulk`

> Bulk action on customers

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkCustomers` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/customers/schema`

> Field spec for customers

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetCustomerSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `customers:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin goods receipts

#### `GET /v1/admin/purchasing/goods-receipts`

> List goods receipts

Filter by purchase order, warehouse, QC status and received-date range. `?q=` matches the GRN number and the supplier’s invoice number.

`acceptedQty` is what entered stock; `rejectedQty` is what did not. The two are always reported separately and never summed into a single "received" figure.

| | |
|---|---|
| operationId | `adminListGoodsReceipts` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `-receivedOn` (default), `receivedOn`, `grnNo`, `createdAt`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `purchaseOrderId` | string | no | Restrict to one purchase order. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `qcStatus` | `passed` \| `partial` \| `failed` | no | `passed`, `partial` or `failed`. |
| `receivedFrom` | string | no | `YYYY-MM-DD`. Inclusive lower bound on `receivedOn`. <br><sub>pattern `^\d{4}-\d{2}-\d{2}$`</sub> |
| `receivedTo` | string | no | `YYYY-MM-DD`. Inclusive upper bound on `receivedOn`. <br><sub>pattern `^\d{4}-\d{2}-\d{2}$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of goods receipts. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/purchasing/goods-receipts`

> Receive goods against a purchase order

The stock-in step, and ONE transaction end to end. Per line: increment on-hand by `acceptedQty`, write an `inbound` movement carrying the balance that increment returned, add to the PO line’s `receivedQty`, and lower `incomingQty` by everything that turned up. If any line fails, none of it happened.

**Rejected units never enter stock.** They are recorded on the receipt line with a reason and go no further — damaged goods inside `on_hand_qty` are sellable goods, and no downstream report undoes that. They also do not count towards `receivedQty`, so a PO with rejections stays open for what it is still owed. Send them back with a purchase return.

**Partial receipts are normal.** The PO becomes `partially_received` and stays there until ordered equals accepted across ALL lines, at which point it becomes `received` and `closedAt` is stamped. Accepting more than a line still has outstanding is 422 `over_receipt`.

The warehouse is taken from the PO, not from the request: receiving into a different warehouse than the one that ordered would leave `incomingQty` raised forever at the warehouse still waiting.

Requires an `Idempotency-Key`: a retried receipt must not add the stock twice.

| | |
|---|---|
| operationId | `adminCreateGoodsReceipt` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `purchaseOrderId` | string | **yes** | The PO being received against. Must be sent or partially received. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `receivedOn` | string | no | `YYYY-MM-DD`. When the goods physically arrived. Defaults to today. <br><sub>pattern `^\d{4}-\d{2}-\d{2}$`</sub> |
| `qcStatus` | `passed` \| `partial` \| `failed` | no | Inspection outcome for the receipt as a whole. Per-line rejections are on the lines. <br><sub>default `"passed"`</sub> |
| `inspectorId` | string \| null | no | Staff member who inspected the goods. |
| `supplierInvoiceNo` | string \| null | no | The supplier’s invoice number, for reconciliation. |
| `notes` | string \| null | no | Free text. |
| `lines` | array<object> | **yes** | At least one line. Partial receipts are normal — the PO stays `partially_received`. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The posted receipt, with the PO’s resulting status. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:create`. |
| `404` | No such purchase order. |
| `422` | The PO has not been sent (`po_not_receivable`), an unknown line, or `over_receipt`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/purchasing/goods-receipts/{grnId}`

> Get one goods receipt

The receipt with its lines, including per-line rejections with their reasons, batch numbers and expiry dates. `poStatusAfter` is what the purchase order’s stored status became once this receipt was posted.

| | |
|---|---|
| operationId | `adminGetGoodsReceipt` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `grnId` | string | **yes** | Goods receipt id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The goods receipt. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such goods receipt. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin inventory

#### `GET /v1/admin/inventory`

> List stock levels

One row per (item, warehouse) — stock is per stockable per warehouse and there is no global figure, which is the single largest difference from the three conflicting stock fields this replaces.

`inventory_levels` is polymorphic: a row is a finished `variant`, a loose `hamper_item`, or a `packaging` material. Filter with `?kind=`.

`availableQty` is a GENERATED column (`on_hand_qty - reserved_qty`), so it cannot drift from the two numbers beside it. `?state=` filters on it: `out` is nothing sellable, `low` is at or below the reorder point, `in` is above. `?belowReorderPoint=true` is deliberately NOT the same filter — it uses the inventory position including incoming stock, which is the buying question rather than the selling one.

| | |
|---|---|
| operationId | `adminListInventory` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `sku` (default), `-availableQty`, `availableQty`, `onHandQty`, `reservedQty`, `-lastMovementAt`, `warehouse`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Matches SKU or item name, case-insensitively. <br><sub>minLen 1, maxLen 120</sub> |
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `locationId` | string | no | Restrict to one bin/shelf/rack/zone (`warehouse_locations.id`). <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `kind` | `variant` \| `hamper_item` \| `packaging` | no | `inventory_levels` is polymorphic — a row is a finished `variant`, a loose `hamper_item`, or a `packaging` material. |
| `state` | `in` \| `low` \| `out` | no | `out` = nothing sellable · `low` = at or below the reorder point · `in` = above it. |
| `belowReorderPoint` | `0` \| `1` \| `true` \| `false` | no | `true` returns only levels at or below their reorder point — the buying queue. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of stock levels. |
| `400` | An unrecognised filter value. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/{sku}`

> Everything about one SKU

The whole workspace in one call: the warehouse-by-warehouse breakdown, the last twenty ledger entries across every warehouse, every hold currently consuming stock, and the open purchase-order lines still owed.

The SKU is resolved against `product_variants.sku` first, then `hamper_items.sku`, then `packaging_materials.sku` — the three things this business stocks. Each has a partial unique index excluding soft-deleted rows, so a discontinued item never shadows a live one.

`incoming` lists only OPEN purchase-order lines (`draft`, `sent`, `partially_received`) with `outstandingQty` computed from absolute quantities, not the percentage the old console stored. A received or cancelled order is not incoming stock.

Declared last of the GET routes so that `/movements`, `/alerts/*`, `/reorder`, `/reservations`, `/audit`, `/notifications`, `/export` and `/dashboard` are matched as the literals they are.

| | |
|---|---|
| operationId | `adminGetInventoryBySku` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `sku` | string | **yes** | Stock-keeping unit. Resolved against `product_variants.sku` first, then `hamper_items.sku`, then `packaging_materials.sku`. <br><sub>minLen 1, maxLen 64</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The item, its levels, its recent history and what is inbound. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No active item carries that SKU. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/{sku}/availability`

> Can we promise this?

The narrow question, answered per warehouse and across the network. Pass `?quantity=` to get a straight yes or no.

`canFulfil` is true when ONE warehouse can cover the quantity. `canFulfilAcrossWarehouses` is true when the network total covers it. They are reported separately and deliberately not conflated: the second needs a split shipment to be true, which is a fulfilment decision with a real cost attached, not an availability fact.

`state` is the `in`/`low`/`out` value the STOREFRONT should surface (§16). Never publish the raw number: it invites scraping the whole catalogue’s stock position, and it is wrong the instant someone else’s cart holds two of them.

| | |
|---|---|
| operationId | `adminGetSkuAvailability` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `sku` | string | **yes** | Stock-keeping unit. Resolved against `product_variants.sku` first, then `hamper_items.sku`, then `packaging_materials.sku`. <br><sub>minLen 1, maxLen 64</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `quantity` | integer | no | Ask a yes/no question: can this many units be promised right now? Sets `canFulfil` per warehouse and overall. <br><sub>max 1000000</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Availability, per warehouse and in total. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No active item carries that SKU. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/inventory/adjustments`

> Adjust stock

One transaction: lock the level, validate, update `inventory_levels`, append the movement with the balance the update actually returned, commit. There is no path where the level moves and the ledger does not.

A decrement that would take SELLABLE stock below zero is refused with the stable code `insufficient_stock` — note *sellable*, not on-hand: units already reserved for a paid order are physically present but spoken for, and letting an adjustment eat them turns someone else’s confirmed order into a stockout at picking time. The refusal is enforced by a conditional `UPDATE … WHERE on_hand − reserved + delta >= 0` whose affected-row count is checked, which is race-free at READ COMMITTED; the `inventory_no_oversell` CHECK behind it is a backstop, never flow control.

`movementType` is restricted to the seven types a human may post by hand. Transfer and production types are excluded because each is half of a pair that must move together, and `stock_count` is excluded because §40 says a count posts its variance only through approval.

To undo an adjustment, post the opposite one. The ledger is append-only and this endpoint will never edit a movement.

Requires an `Idempotency-Key`. A retry with the same key and body replays the stored response; the same key with a different body is a 409, because silently returning the first response would hide a client bug that is about to double-adjust something.

| | |
|---|---|
| operationId | `adminAdjustInventory` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `sku` | string | **yes** | The item to adjust. <br><sub>minLen 1, maxLen 64</sub> |
| `warehouseId` | string | **yes** | Which warehouse’s stock moved. Stock is per item × warehouse; there is no global figure to adjust. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `quantityDelta` | integer | **yes** | Signed change. Positive adds, negative removes. Never zero — the ledger CHECK rejects a movement of nothing. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `movementType` | `adjustment` \| `inbound` \| `outbound` \| `damage` \| `return_in` \| `loss` \| `found` | no | Why the stock moved, in the ledger’s vocabulary. Transfer, production and stock-count types are not adjustable by hand — each writes two coordinated rows or requires an approval. <br><sub>default `"adjustment"`</sub> |
| `reason` | string | **yes** | Required. Goes on the movement as `note` and into the activity log. An adjustment with no stated reason is indistinguishable from an error. <br><sub>minLen 3, maxLen 400</sub> |
| `referenceType` | `purchase_order` \| `goods_receipt` \| `order` \| `stock_transfer` \| `return` \| `adjustment` \| `import` \| `production_order` \| `stock_count` \| `purchase_return` | no | The kind of document this adjustment answers to, if any. |
| `referenceId` | string | no | That document’s id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `referenceLabel` | string | no | Human-readable document number for the ledger screen — `PO-2026-02291`, `ACH104422`. <br><sub>maxLen 64</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The level after the change, and the movement it wrote. |
| `400` | Missing or malformed `Idempotency-Key`. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such SKU, or no such warehouse. |
| `409` | That `Idempotency-Key` was used with a different body, or a first attempt is still in flight. |
| `422` | `insufficient_stock`, or the item is not stocked at that warehouse (`no_inventory_level`). |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/alerts/low-stock`

> Low-stock alerts

Levels with sellable stock above zero but at or below their reorder point — the ones that will run out, ordered most urgent first. Backed by the partial index `idx_inventory_low`, so this stays cheap as the catalogue grows.

An item at zero is NOT here; it is already out, and mixing the two makes the list unusable as a work queue. See `/alerts/out-of-stock`.

| | |
|---|---|
| operationId | `adminListLowStock` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `availableQty` (default, most urgent first), `sku`, `-shortfallQty`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Matches SKU or item name. <br><sub>minLen 1, maxLen 120</sub> |
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `kind` | `variant` \| `hamper_item` \| `packaging` | no | Restrict to variants, hamper items or packaging. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of low-stock levels. |
| `400` | An unrecognised filter value. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/alerts/out-of-stock`

> Out-of-stock alerts

Levels with nothing sellable — `availableQty <= 0`. A row can appear here while `onHandQty` is positive: every unit is reserved. That is the honest reading, because those units are already promised and cannot be sold again.

| | |
|---|---|
| operationId | `adminListOutOfStock` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `availableQty` (default, most urgent first), `sku`, `-shortfallQty`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Matches SKU or item name. <br><sub>minLen 1, maxLen 120</sub> |
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `kind` | `variant` \| `hamper_item` \| `packaging` | no | Restrict to variants, hamper items or packaging. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of out-of-stock levels. |
| `400` | An unrecognised filter value. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/audit`

> Who changed stock, and what the numbers were

The STATE-level trail from `activity_logs`, restricted to inventory entities. Each entry carries `beforeData` and `afterData` as queryable JSONB — the actual quantities — rather than a rendered string like "₹12,400 → ₹11,900" that cannot be diffed, queried or replayed.

This is complementary to the automatic request-level audit `defineRoute` applies to every non-GET admin route, not a duplicate of it. A request log records who called what from where; it cannot tell you what the number was. This one can, and cannot tell you the IP.

Distinct from `/movements` too: the ledger is the record of PHYSICAL movement and includes system movements with no human behind them. This is the record of human action, and includes reservations, which never touch the ledger.

| | |
|---|---|
| operationId | `adminListInventoryAudit` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `-occurredAt` (default) or `occurredAt`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Matches the entity label or the action. <br><sub>minLen 1, maxLen 120</sub> |
| `action` | string | no | e.g. `inventory.adjusted`, `inventory.reserved`, `inventory.released`. <br><sub>maxLen 120</sub> |
| `entityId` | string | no | Everything recorded against one inventory level. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `actorStaffId` | string | no | Everything one staff member did to stock. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `from` | string | no | ISO date or timestamp, inclusive. |
| `to` | string | no | ISO date or timestamp, inclusive. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of audit entries, newest first. |
| `400` | An unparseable date bound. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/inventory/bulk-adjust`

> Adjust many SKUs at once

All-or-nothing in ONE transaction — unlike the order desk’s bulk action, which reports per-order outcomes. Stock is different: a stocktake correction that half-applied leaves a warehouse in a state nobody chose and nobody can describe. Every line succeeds or nothing is written.

**Each SKU still gets its own movement row.** The batch is a unit of atomicity, not a unit of bookkeeping; one movement covering fifty SKUs would be unusable for reconciling any of them.

Levels are locked in a single statement in ascending `inventory_level_id` order, and the work is sorted the same way. Without that, batch A holding level 1 and wanting level 2 deadlocks against batch B holding 2 and wanting 1 — PostgreSQL would detect it and abort one, but a `deadlock_timeout` stall is not an acceptable way to find out (§62).

Every (`sku`, `warehouseId`) pair must be distinct. Two deltas against one level in one batch is ambiguous about which movement’s `balanceAfter` comes first, so it is refused rather than guessed at.

Validation is front-loaded: unknown SKUs and items not stocked at the named warehouse come back as field-level issues BEFORE any lock is taken.

| | |
|---|---|
| operationId | `adminBulkAdjustInventory` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | **yes** | Applies to every line. A single stated reason is what makes a fifty-line correction reviewable later. <br><sub>minLen 3, maxLen 400</sub> |
| `movementType` | `adjustment` \| `inbound` \| `outbound` \| `damage` \| `return_in` \| `loss` \| `found` | no | Default type for lines that do not name their own. <br><sub>default `"adjustment"`</sub> |
| `referenceType` | `purchase_order` \| `goods_receipt` \| `order` \| `stock_transfer` \| `return` \| `adjustment` \| `import` \| `production_order` \| `stock_count` \| `purchase_return` | no | Applies to every line. |
| `referenceId` | string | no | Applies to every line. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `referenceLabel` | string | no | Applies to every line. <br><sub>maxLen 64</sub> |
| `adjustments` | array<object> | **yes** | At most 200 lines. Every (`sku`, `warehouseId`) pair must be distinct — two deltas against one level in one batch is ambiguous, so it is refused rather than guessed at. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | One result per line, in the deterministic lock order. |
| `400` | Missing or malformed `Idempotency-Key`. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | A warehouse in the batch does not exist. |
| `409` | That `Idempotency-Key` was used with a different body. |
| `422` | `unknown_sku`, `duplicate_target`, `no_inventory_level`, or `insufficient_stock` on any line — nothing was written. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/dashboard`

> Inventory dashboard

The header strip for the inventory console, computed in the database rather than by summing whatever page happens to be loaded — the console currently derives "stock value" from the twenty-five rows in memory, which makes it mean "stock value of these twenty-five".

`stockValuePaise` is on-hand at unit cost in integer paise. Items with no recorded cost contribute ZERO rather than an estimate: a valuation that quietly invents numbers is worse than one with a visible hole in it.

`lowStockCount` and `outOfStockCount` are counted against the GENERATED `available_qty` column, so they can never disagree with the list screens. `reorderCount` is different and larger in scope: it uses the inventory POSITION (`on hand − reserved + incoming`), because an item with a purchase order already in flight does not need a second one.

| | |
|---|---|
| operationId | `adminInventoryDashboard` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Network totals plus a per-warehouse breakdown. |
| `400` | Unparseable filter. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/export`

> Export stock levels

A flat file of the current position, for the spreadsheet the warehouse actually works from. `csv` by default, delivered as an attachment with CRLF line endings and every field quoted — an unquoted bin location containing a comma silently shifts every column after it, which is the classic way an export becomes wrong without looking wrong.

Money stays in integer paise, unconverted. A CSV that says `149900` is unambiguous; one that says `1499.00` has already made a rounding decision on the reader’s behalf.

Capped at 50,000 rows and gated on `inventory:export`, which is a separate grant from `inventory:view` — reading one screen and walking out with the whole stock position are different acts. The `export` rate limiter allows 20 per hour per user.

| | |
|---|---|
| operationId | `adminExportInventory` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `format` | `csv` \| `json` | no | `csv` (default, a downloadable attachment) or `json`. <br><sub>default `"csv"`</sub> |
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `kind` | `variant` \| `hamper_item` \| `packaging` | no | Restrict to variants, hamper items or packaging. |
| `state` | `in` \| `low` \| `out` | no | Export only `out`, `low` or `in` rows. |
| `limit` | integer | no | Row cap. Maximum 50,000 — an unbounded export of a growing table is an outage waiting for a slow month. <br><sub>max 50000, default `10000`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A CSV attachment, or the same rows as JSON when `?format=json`. |
| `400` | An unrecognised filter value. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:export`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/inventory/movements`

> The stock ledger

Append-only. Every change to on-hand stock is exactly one row here, and nothing ever updates or deletes one — a correction is a NEW movement with the opposite sign (§10). That is what makes `balanceAfter` trustworthy: the running on-hand balance immediately after each movement, from which any historical position can be reconstructed without replaying the whole table.

Reservations do NOT appear here. A hold moves `reservedQty` and nothing physical has moved, so a ledger row for it would double-count against `balanceAfter` the moment the goods actually shipped.

`?movementType=` and `?referenceType=` take comma-separated lists; an unrecognised value is a 400 rather than a silently empty page. `?referenceId=` returns everything one document did — one order, one goods receipt, one transfer. Movement ids are BIGINT and travel as decimal STRINGS; a JSON number would lose precision past 2^53.

| | |
|---|---|
| operationId | `adminListStockMovements` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `-occurredAt` (default), `occurredAt`, `quantityDelta`, `-id`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Matches SKU, item name or `referenceLabel`. <br><sub>minLen 1, maxLen 120</sub> |
| `sku` | string | no | One SKU. The whole history for one item. <br><sub>maxLen 64</sub> |
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `movementType` | string | no | One type or a comma-separated list: `?movementType=damage,loss`. An unknown value is a 400, not an empty page. <br><sub>maxLen 200</sub> |
| `referenceType` | string | no | One type or a comma-separated list. <br><sub>maxLen 200</sub> |
| `referenceId` | string | no | Everything a single document did — one order, one GRN, one transfer. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `actorId` | string | no | Movements recorded by one staff member. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `from` | string | no | ISO date or timestamp. Inclusive lower bound on `occurredAt`. |
| `to` | string | no | ISO date or timestamp. Inclusive upper bound on `occurredAt`. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of ledger entries, newest first. |
| `400` | An unrecognised movement type, reference type, or an unparseable date. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/movements/{movementId}`

> Get one ledger entry

The single movement, with the item, warehouse and document it belongs to resolved. There is no PATCH and no DELETE beside it, and there never will be — see the ledger note on the list endpoint.

| | |
|---|---|
| operationId | `adminGetStockMovement` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `movementId` | string | **yes** | Movement id. `stock_movements.id` is a BIGINT identity, so it travels as a decimal string — a JSON number would silently lose precision past 2^53. <br><sub>pattern `^\d{1,19}$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The movement. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such movement. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/notifications`

> Inventory notifications

The inventory slice of the staff notification feed — stockouts, low-stock warnings, expiring holds, overdue purchase orders.

Returns both notifications addressed to you personally and broadcasts (`staff_user_id IS NULL`). Filtering to "mine only" would hide every broadcast stockout alert, which is most of them.

Read-only here. Marking one read belongs to the notification module, which owns the whole feed.

| | |
|---|---|
| operationId | `adminListInventoryNotifications` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `-createdAt` (default) or `createdAt`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `unreadOnly` | `0` \| `1` \| `true` \| `false` | no | `true` returns only notifications with no `readAt`. |
| `priority` | `high` \| `normal` \| `low` | no | Restrict to one priority. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of notifications, newest first. |
| `400` | An unrecognised filter value. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/reorder`

> What to buy

The buying queue. A level qualifies when its inventory POSITION — `on hand − reserved + incoming` — is at or below its reorder point. Incoming counts, otherwise every item with a purchase order already in flight is re-ordered, which is how a warehouse ends up with four months of ribbon. Reserved does not count as cover, because those units are leaving the building.

The formula lives in ONE documented function (`reorderSuggestion` in `admin-inventory.stock.ts`), shared with the purchase-draft endpoint, so the alert screen and the order that follows it can never disagree:

```
target    = reorderPoint + reorderQty
shortfall = max(0, target - position)
suggested = ceil(max(shortfall, 1) / moq) * moq
```

Suggestions are rounded UP to the supplier’s MOQ, never down — a purchase order the supplier will reject is not a saving. The supplier shown is the one flagged preferred (`supplier_products` has a partial unique index guaranteeing at most one per variant), falling back to the cheapest with `isPreferredSupplier: false` so the buyer can see the difference.

| | |
|---|---|
| operationId | `adminListReorderSuggestions` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `-shortfallQty` (default), `sku`, `leadTimeDays`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Matches SKU or item name. <br><sub>minLen 1, maxLen 120</sub> |
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `supplierId` | string | no | Only items whose preferred supplier is this one — one buyer’s worklist. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of reorder suggestions, biggest shortfall first. |
| `400` | An unrecognised filter value. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/inventory/reorder/purchase-draft`

> Draft a purchase order from the reorder suggestions

Creates ONE purchase order with status `draft` for one supplier and one warehouse. **It never sends anything to a supplier** — that is `POST /purchase-orders/:poId/send`, behind its own permission. A draft is a document a buyer reviews and edits.

With no `lines`, the draft is generated from the reorder engine: everything this supplier supplies that is at or below its reorder point in this warehouse, at the suggested quantity, optionally narrowed with `skus`. With `lines`, the buyer’s quantities are used instead — but still rounded UP to the supplier’s MOQ.

Nothing to order is a 422 (`nothing_to_order`), not an empty purchase order: an empty document in the PO list is a false signal that someone ordered something.

`taxPaise` is always 0 on a draft. GST is resolved when the goods are received and invoiced, and a guessed figure here would be a statutory number nobody computed. The number comes from `document_number_series` under a row lock; no active series for the year is a 422 rather than an improvised number that collides with the real series later.

| | |
|---|---|
| operationId | `adminCreatePurchaseDraft` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `supplierId` | string | **yes** | Who to buy from. Required — a draft with no supplier has no cost, no MOQ and no lead time, which is most of what a purchase order is. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `warehouseId` | string | **yes** | Which warehouse the goods are being bought for. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `expectedOn` | string | no | `YYYY-MM-DD`. Defaults to today plus the supplier’s longest lead time across the drafted lines. <br><sub>date, pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\`</sub> |
| `notes` | string | no | Internal note on the draft. <br><sub>maxLen 2000</sub> |
| `skus` | array<string> | no | Restrict the generated draft to these SKUs. Omit to draft every item this supplier supplies that is at or below its reorder point in this warehouse. |
| `lines` | array<object> | no | Explicit lines, overriding the reorder engine entirely. Quantities are still rounded UP to the supplier’s MOQ — a purchase order the supplier will reject is not a saving. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The draft purchase order and its lines. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:create`. |
| `404` | No such supplier, or no such warehouse. |
| `422` | `nothing_to_order`, `unknown_sku`, `supplier_archived`, or `no_document_series`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/inventory/reservations`

> List stock holds

Every hold against stock, whatever placed it: a `cart` (which expires), an `order` (which never does), a `quotation`, or a `manual_hold` placed here.

`?status=active` — the default — means unreleased AND unexpired, which is the set actually consuming `reservedQty` right now. `released` and `expired` are separate because they are different questions: one was let go deliberately, the other simply lapsed.

This is the screen to open when `onHandQty` is healthy and `availableQty` is not.

| | |
|---|---|
| operationId | `adminListInventoryReservations` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `-createdAt` (default), `createdAt`, `expiresAt`, `quantity`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `sku` | string | no | Holds against one SKU. <br><sub>maxLen 64</sub> |
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `reason` | `cart` \| `order` \| `manual_hold` \| `quotation` | no | `cart` (expires) · `order` (never expires) · `manual_hold` · `quotation`. |
| `status` | `active` \| `released` \| `expired` \| `all` | no | `active` (default) is unreleased and unexpired — the holds that are actually consuming stock right now. <br><sub>default `"active"`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of holds. |
| `400` | An unrecognised filter value. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/inventory/reservations`

> Hold stock by hand

Puts units beyond the reach of the storefront — for a corporate quote being negotiated, a photoshoot, a replacement being held for a support case.

**A hold moves `reservedQty` and nothing else.** `onHandQty` is untouched, because the units have not moved, and NO `stock_movements` row is written: the ledger records physical movement, and a hold in it would double-count against `balanceAfter` the moment the goods actually shipped (§14). The effect is recorded in the activity log instead, where the before/after pair shows `onHandQty` unchanged.

The hold is refused with `insufficient_stock` when it will not fit in current sellable stock, using the same conditional-UPDATE guard as an adjustment.

The reason is always `manual_hold`. The `reservation_has_owner` CHECK requires a cart or an order for every other reason, and this endpoint has neither — cart and order holds are placed by checkout, inside the transaction that creates them.

Omit `expiresAt` for an open-ended hold. Note that the expiry sweeper only touches holds that carry one, so an open-ended hold stays until a person releases it — which is the point, and also the risk.

| | |
|---|---|
| operationId | `adminCreateInventoryReservation` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `sku` | string | **yes** | The item to hold. <br><sub>minLen 1, maxLen 64</sub> |
| `warehouseId` | string | **yes** | Which warehouse the units are held in. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `quantity` | integer | **yes** | How many units to hold. Must fit inside current sellable stock. <br><sub>max 1000000</sub> |
| `expiresAt` | string | no | When the hold lapses. Omit for an open-ended hold; the sweeper only releases holds that carry an expiry, so an open-ended one stays until someone releases it. <br><sub>date-time, pattern `^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\`</sub> |
| `note` | string | no | Why this stock is being held. Recorded in the activity log. <br><sub>maxLen 400</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The hold. |
| `400` | Missing or malformed `Idempotency-Key`. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such SKU, or no such warehouse. |
| `409` | That `Idempotency-Key` was used with a different body. |
| `422` | `insufficient_stock`, `no_inventory_level`, or `expiry_in_past`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/inventory/reservations/{id}/release`

> Release a stock hold

Stamps `releasedAt` and returns the units to sellable stock in one transaction, under the level’s row lock so the decrement cannot interleave with a checkout reserving the same level.

Releasing an already-released hold is a 422, not a silent success. Decrementing `reservedQty` twice for one hold is exactly how phantom inventory appears — stock the system believes is sellable and the shelf does not have.

Works on any hold, including one placed by a cart or an order. Releasing an order-backed hold does not cancel the order; if that is what you meant, cancel the order and let it release its own stock.

| | |
|---|---|
| operationId | `adminReleaseInventoryReservation` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Reservation id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | no | Why the hold is being lifted. Recorded in the activity log. <br><sub>maxLen 400</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The hold, after release. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such reservation. |
| `422` | `reservation_already_released`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/suppliers`

> List suppliers

Vendors. `outstandingPaise` is a ledger rollup and is not writable here.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListSuppliers` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/suppliers`

> Create a supplier

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateSupplier` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | **yes** | Code. <br><sub>maxLen 32</sub> |
| `name` | string | **yes** | Supplier. <br><sub>maxLen 200</sub> |
| `contactName` | string \| null | no |  |
| `email` | string \| null | no |  |
| `mobile` | string \| null | no |  |
| `line1` | string \| null | no |  |
| `city` | string \| null | no |  |
| `stateCode` | string \| null | no |  |
| `pincode` | string \| null | no |  |
| `gstin` | string \| null | no |  |
| `pan` | string \| null | no |  |
| `category` | string \| null | no |  |
| `leadTimeDays` | integer \| null | no |  |
| `paymentTerms` | string \| null | no |  |
| `status` | `active` \| `on_hold` \| `archived` | **yes** | Status. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/suppliers/{id}`

> Archive a supplier

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `inventory:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteSupplier` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/suppliers/{id}`

> Get one supplier

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetSupplier` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/suppliers/{id}`

> Update a supplier

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateSupplier` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string \| null | no |  |
| `name` | string \| null | no |  |
| `contactName` | string \| null | no |  |
| `email` | string \| null | no |  |
| `mobile` | string \| null | no |  |
| `line1` | string \| null | no |  |
| `city` | string \| null | no |  |
| `stateCode` | string \| null | no |  |
| `pincode` | string \| null | no |  |
| `gstin` | string \| null | no |  |
| `pan` | string \| null | no |  |
| `category` | string \| null | no |  |
| `leadTimeDays` | integer \| null | no |  |
| `paymentTerms` | string \| null | no |  |
| `status` | `active` \| `on_hold` \| `archived` \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/suppliers/bulk`

> Bulk action on suppliers

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkSuppliers` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/suppliers/schema`

> Field spec for suppliers

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetSupplierSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/warehouses`

> List warehouses

Fulfilment locations. GST registration is state-wise, so each carries its own GSTIN. Filed under “Delivery & Fulfilment” in the nav but gated on `inventory`, matching the console.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListWarehouses` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/warehouses`

> Create a warehouse

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateWarehouse` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | **yes** | Code. `WH-MUM-AND`. <br><sub>maxLen 32</sub> |
| `name` | string | **yes** | Warehouse. <br><sub>maxLen 200</sub> |
| `line1` | string | **yes** | Address. <br><sub>maxLen 300</sub> |
| `city` | string | **yes** | City. <br><sub>maxLen 120</sub> |
| `stateCode` | string | **yes** | State code. Two-digit GST state code. Determines whether a supply is interstate. <br><sub>maxLen 2</sub> |
| `pincode` | string | **yes** | PIN code. <br><sub>maxLen 6</sub> |
| `gstin` | string \| null | no |  |
| `managerId` | string \| null | no |  |
| `capacityUnits` | integer \| null | no |  |
| `supportsSameDay` | boolean \| null | no |  |
| `isDefault` | boolean \| null | no |  |
| `status` | `active` \| `maintenance` \| `closed` | **yes** | Status. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/warehouses/{id}`

> Archive a warehouse

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `inventory:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteWarehouse` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/warehouses/{id}`

> Get one warehouse

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetWarehouse` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/warehouses/{id}`

> Update a warehouse

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateWarehouse` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string \| null | no |  |
| `name` | string \| null | no |  |
| `line1` | string \| null | no |  |
| `city` | string \| null | no |  |
| `stateCode` | string \| null | no |  |
| `pincode` | string \| null | no |  |
| `gstin` | string \| null | no |  |
| `managerId` | string \| null | no |  |
| `capacityUnits` | integer \| null | no |  |
| `supportsSameDay` | boolean \| null | no |  |
| `isDefault` | boolean \| null | no |  |
| `status` | `active` \| `maintenance` \| `closed` \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/warehouses/bulk`

> Bulk action on warehouses

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkWarehouses` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/warehouses/schema`

> Field spec for warehouses

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetWarehouseSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin orders

#### `GET /v1/admin/orders`

> List orders

The order desk. Six named filters (`status`, `paymentStatus`, `channel`, `deliveryType`, `priority`, `warehouseId`), two date ranges (`placedFrom`/`placedTo`, `deliveryFrom`/`deliveryTo`), a `tag` filter and a `corporateAccountId` filter. Each enum filter takes a comma-separated list; an unrecognised value is a 400 rather than a silently empty page, because a typo that returns nothing reads exactly like "there are no orders".

`?q=` searches order number, buyer name, buyer email, both mobile numbers, recipient name, destination PIN code and the AWB — the last through an EXISTS on `shipments`, so a multi-parcel order still returns one row.

The KPI block in `meta` is computed over the SAME filter set as the rows, not over the page. The console currently derives those numbers from whatever happens to be in memory, which makes "order value" mean "order value of these ten".

| | |
|---|---|
| operationId | `adminListOrders` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `-placedAt` (default), `placedAt`, `orderNo`, `totalPaise`, `status`, `priority`, `requestedDeliveryDate`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `status` | string | no | One status or a comma-separated list: `?status=packed,ready_to_ship`. <br><sub>maxLen 400</sub> |
| `paymentStatus` | string | no | One or a comma-separated list. <br><sub>maxLen 200</sub> |
| `channel` | string | no | One or a comma-separated list. <br><sub>maxLen 200</sub> |
| `deliveryType` | string | no | One or a comma-separated list. <br><sub>maxLen 200</sub> |
| `priority` | string | no | `standard`, `high`, `vip`, or a list. <br><sub>maxLen 80</sub> |
| `warehouseId` | string | no | Fulfilment warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `corporateAccountId` | string | no | Restrict to one corporate account. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `placedFrom` | string | no | ISO date or timestamp. Inclusive lower bound on `placedAt`. |
| `placedTo` | string | no | ISO date or timestamp. Inclusive upper bound on `placedAt`. |
| `deliveryFrom` | string | no | `YYYY-MM-DD`. Lower bound on the requested delivery date. |
| `deliveryTo` | string | no | `YYYY-MM-DD`. Upper bound on the requested delivery date. |
| `tag` | string | no | One order tag, e.g. `corporate`, `fragile`, `high-value`. <br><sub>maxLen 40</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of orders. `meta` carries pagination plus the KPI block. |
| `400` | An unrecognised filter value or an unparseable date. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `orders:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/orders/{orderId}`

> Get one order

The whole workspace in one call: the frozen buyer, recipient, address, billing and tax snapshots; every money column in integer paise including `refundablePaise` (captured minus already refunded, which is the cap on a refund); the lines with their add-ons, personalisation and per-line GST split; the append-only timeline; every payment attempt, not only the successful one; the refund ledger; shipments; and issued invoices.

`availableTransitions` lists every legal edge from the current status, each flagged `allowed` against YOUR grants — so the console can render the menu without a second copy of the state machine, and a disabled button and a 403 can never disagree.

| | |
|---|---|
| operationId | `adminGetOrder` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The order. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `orders:view`. |
| `404` | No such order. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/orders/{orderId}/cancel`

> Cancel an order

Cancellation is not a status write. In one transaction it releases the stock reservation, returns the coupon redemption to the pool, stamps the reason and appends a timeline event.

An order that was actually paid becomes `refund_initiated`, **not** `cancelled` — only the gateway’s confirmation moves it to `refunded`, because telling someone their money is back before it is would be a lie. The gateway call happens after the commit, so a Razorpay outage cannot take the cancellation down with it; a failed refund is logged for Finance to retry. Send `refund: false` to leave the money for Finance to settle by hand.

Only pre-shipment orders qualify. Once a courier has the parcel, cancelling is a return-to-origin — an operations decision with a cost — so use the `rto` transition or raise a return.

| | |
|---|---|
| operationId | `adminCancelOrder` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | **yes** | Why. Required — the database refuses a cancellation with no reason, and ops needs it. <br><sub>minLen 3, maxLen 400</sub> |
| `refund` | boolean | no | Start a gateway refund when money was actually captured. Setting false leaves the order in `refund_initiated` for Finance to settle by hand. <br><sub>default `true`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The cancelled order. |
| `401` | Missing, malformed or expired token. |
| `403` | Your role cannot cancel orders. |
| `404` | No such order. |
| `422` | The order has moved past the point where it can be cancelled. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/orders/{orderId}/courier`

> Assign a courier to an order

Attaches the courier to the order’s open (`label_created`) shipment, creating one from the fulfilment warehouse — or the default warehouse — if none exists yet. A COD order carries its outstanding balance onto the shipment as `codAmountPaise`. Reuses the open shipment rather than creating a second row, so packing and dispatch do not produce two parcels for one box.

| | |
|---|---|
| operationId | `adminAssignOrderCourier` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `courierId` | string | **yes** | Courier partner id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The shipment the courier was attached to. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `delivery:edit`. |
| `404` | No such order, or no such courier. |
| `422` | No fulfilment warehouse and no default warehouse configured. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/orders/{orderId}/invoice`

> Issue the GST invoice for an order

Amounts are copied from the order’s FROZEN tax columns, never recomputed — the rates were resolved when the order was placed and the catalogue has moved on since. The total is built as `taxable + cgst + sgst + igst + cess + roundOff` rather than copied from the order header, which also carries shipping and COD fees.

The number comes from `document_number_series` under a row lock, because a gap in a statutory series is a compliance problem. If no active series exists for the current financial year this returns 422 rather than improvising one. Every line needs an HSN code — GSTR-1 requires an HSN-wise summary.

Idempotent: an order that already has an issued invoice returns that invoice with `alreadyIssued: true`.

| | |
|---|---|
| operationId | `adminGenerateOrderInvoice` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The invoice. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `orders:edit`. |
| `404` | No such order. |
| `422` | Not invoiceable yet, no numbering series, an unknown supplier state, or a line with no HSN. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/orders/{orderId}/notes`

> Add an internal note

Appends to `orders.internal_notes` AND writes a timeline event. The column is the convenience view; the timeline is the record that cannot be edited. Never shown to the customer.

| | |
|---|---|
| operationId | `adminAddOrderNote` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `note` | string | **yes** | Internal note. Appended to the timeline, never shown to the customer. <br><sub>minLen 1, maxLen 2000</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The note, as stored. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `orders:edit`. |
| `404` | No such order. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/orders/{orderId}/refund`

> Refund an order

Gated on `orders:refund`, which across the eleven roles only **Finance Manager** and **Super Admin** hold. Every other role — including Operations Manager and Order Manager, who can cancel — gets a 403 here. The console hides the button for them; that is a convenience, and this is the control.

Also requires a recent re-authentication: call `POST /v1/admin/auth/step-up` first, which opens a five-minute window on the current session. Ten minutes of access-token life is a long time for an unattended laptop and a refund is irreversible.

The work is delegated to the payments service, which caps the amount at captured-minus-refunded, writes and commits the refund row **before** calling the gateway (so a refund Razorpay accepted but whose response was lost is still on the books), and honours `Idempotency-Key` for a replayed request. Only a gateway webhook moves the refund to `completed` and the order to `refunded`.

| | |
|---|---|
| operationId | `adminRefundOrder` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `amountPaise` | integer | **yes** | How much to refund, in integer paise. Cannot exceed captured minus already refunded. <br><sub>max 9007199254740991</sub> |
| `reason` | string | **yes** | Recorded on the refund row and the timeline. <br><sub>minLen 3, maxLen 400</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The refund, as the gateway accepted it. |
| `401` | Missing, malformed or expired token. |
| `403` | Your role cannot refund orders, or there is no recent step-up. |
| `404` | No such order. |
| `422` | The amount exceeds what is still refundable. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `PATCH /v1/admin/orders/{orderId}/status`

> Move an order to another status

Validated against the state machine under a row lock — the status read a moment ago may have moved beneath a courier webhook while the operator was looking at the screen.

An edge that does not exist is 422 `illegal_transition` and lists the legal ones; that check runs BEFORE the permission check, so a Super Admin gets the same answer and nobody goes hunting for a missing grant that was never the problem. An edge a courier or the gateway owns is 422 `system_driven_transition`. An edge you lack the grant for is 403.

Two targets are redirected rather than handled here, because both have side effects that a status write alone would silently skip: `cancelled` runs the full cancellation (stock released, coupon redemption returned to the pool, refund started), and `refund_initiated` needs an amount, so it returns 422 pointing at the refund endpoint.

Moving to `shipped` creates or reuses the open shipment; pass `courierId` and `awb` to lock them in.

| | |
|---|---|
| operationId | `adminUpdateOrderStatus` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | `pending_payment` \| `paid` \| `confirmed` \| `in_production` \| `personalisation_pending` \| `quality_check` \| `packed` \| `ready_to_ship` \| `shipped` \| `out_for_delivery` \| `delivered` \| `failed_delivery` \| `rto` \| `cancelled` \| `refund_initiated` \| `refunded` | **yes** | The status to move to. Must be a legal edge from the current one. |
| `note` | string | no | Free text appended to the timeline entry. Visible to staff, not to the customer. <br><sub>maxLen 500</sub> |
| `courierId` | string | no | Required when moving to `shipped` if no shipment has a courier yet — the AWB is locked at that point. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `awb` | string | no | Air waybill, when moving to `shipped`. <br><sub>maxLen 64</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The order, after the move. |
| `401` | Missing, malformed or expired token. |
| `403` | Your role lacks the action this edge requires. |
| `404` | No such order. |
| `422` | Illegal transition, a system-owned edge, or no warehouse to ship from. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/orders/bulk`

> Bulk action on selected orders

Five actions. `mark_packed` and `mark_ready_to_ship` are ordinary transitions and each order is checked against the state machine individually. `generate_invoices` issues one GST invoice per order from its frozen tax columns and is idempotent — an order that already has an issued invoice is reported as succeeded, not duplicated. `assign_courier` needs `courierId` and creates or updates the open shipment. `cancel` needs `reason` and additionally requires `orders:cancel`, which this route’s own `orders:edit` gate does not imply.

Results are per order, not all-or-nothing: fifty orders selected on a busy desk will include a few that moved since the page rendered, and failing the batch for those helps nobody. They come back in `failed` with a stable code. Orders are processed sequentially because each takes row locks on the order and its inventory reservations; firing fifty in parallel turns a queue into a deadlock.

| | |
|---|---|
| operationId | `adminBulkOrderAction` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | `mark_packed` \| `mark_ready_to_ship` \| `generate_invoices` \| `assign_courier` \| `cancel` | **yes** | `mark_packed` and `mark_ready_to_ship` are state transitions and obey the machine per order. `generate_invoices` issues a GST invoice from the frozen tax columns, once per order. `assign_courier` needs `courierId`. `cancel` needs `reason` and requires `orders:cancel`. |
| `orderIds` | array<string> | **yes** | Order ids. At most 100 per call. |
| `courierId` | string | no | Required for `assign_courier`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `reason` | string | no | Required for `cancel`. <br><sub>minLen 3, maxLen 400</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Per-order outcomes. |
| `400` | `courierId` or `reason` missing for an action that needs it. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not hold — `cancel` needs `orders:cancel`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/orders/transitions`

> The order state machine

The whole transition table: every status, its legal next states, the RBAC action each edge requires, and the side effects it triggers. Edges marked `systemOnly` are facts reported by a courier scan or a payment-gateway webhook — `delivered`, `out_for_delivery`, `refunded` — and no staff member may set them by hand, because forging one puts the ledger out of step with reality.

Fetch this once and render the "Advance status" menu from it instead of hardcoding sixteen statuses in the console.

| | |
|---|---|
| operationId | `adminGetOrderTransitionMap` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | status → legal edges. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `orders:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin promotions

#### `GET /v1/admin/coupons`

> List coupons

Discount codes. `discountType` decides which value column is required — the database refuses a percent coupon with no basis points, which the console mock could represent and did.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListCoupons` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/coupons`

> Create a coupon

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateCoupon` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | **yes** | Code. Upper case, 3-32 characters, `A-Z 0-9 _ -` only. <br><sub>maxLen 32</sub> |
| `description` | string \| null | no |  |
| `discountType` | `percent` \| `flat` \| `free_shipping` \| `bogo` \| `free_gift` | **yes** | Type. |
| `discountBp` | integer \| null | no |  |
| `discountPaise` | integer \| null | no |  |
| `maxDiscountPaise` | integer \| null | no |  |
| `minOrderPaise` | integer \| null | no |  |
| `appliesTo` | `all` \| `collections` \| `products` \| `first_order` \| null | no |  |
| `channels` | array<string> \| null | no |  |
| `maxRedemptions` | integer \| null | no |  |
| `maxRedemptionsPerCustomer` | integer \| null | no |  |
| `stackable` | boolean \| null | no |  |
| `startsAt` | string \| null | no |  |
| `endsAt` | string \| null | no |  |
| `status` | `active` \| `scheduled` \| `expired` \| `paused` \| `draft` | **yes** | Status. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/coupons/{id}`

> Archive a coupon

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `promotions:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteCoupon` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/coupons/{id}`

> Get one coupon

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetCoupon` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/coupons/{id}`

> Update a coupon

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateCoupon` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string \| null | no |  |
| `description` | string \| null | no |  |
| `discountType` | `percent` \| `flat` \| `free_shipping` \| `bogo` \| `free_gift` \| null | no |  |
| `discountBp` | integer \| null | no |  |
| `discountPaise` | integer \| null | no |  |
| `maxDiscountPaise` | integer \| null | no |  |
| `minOrderPaise` | integer \| null | no |  |
| `appliesTo` | `all` \| `collections` \| `products` \| `first_order` \| null | no |  |
| `channels` | array<string> \| null | no |  |
| `maxRedemptions` | integer \| null | no |  |
| `maxRedemptionsPerCustomer` | integer \| null | no |  |
| `stackable` | boolean \| null | no |  |
| `startsAt` | string \| null | no |  |
| `endsAt` | string \| null | no |  |
| `status` | `active` \| `scheduled` \| `expired` \| `paused` \| `draft` \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/coupons/bulk`

> Bulk action on coupons

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkCoupons` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/coupons/schema`

> Field spec for coupons

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetCouponSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/gift-cards`

> List gift cards

Issued cards. The code itself is never stored — only its hash and the last four characters — so there is no endpoint, here or anywhere, that can show a customer their code again.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

| | |
|---|---|
| operationId | `adminListGiftCards` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `dir` | `asc` \| `desc` | no | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | string | no | Comma-separated projection, validated against the resource’s column allowlist. <br><sub>maxLen 600</sub> |
| `withFilterOptions` | `true` \| `false` | no | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of rows, with `meta` and the filter option lists. |
| `400` | An unknown filter key, operator, sort field or projection field. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/gift-cards`

> Create a giftcard

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

| | |
|---|---|
| operationId | `adminCreateGiftCard` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `initialValuePaise` | integer | **yes** | Face value. Integer paise — 149900 is ₹1,499.00. <br><sub>min 1, max 9007199254740991</sub> |
| `issuedToName` | string \| null | no |  |
| `issuedToEmail` | string \| null | no |  |
| `issuedToCustomerId` | string \| null | no |  |
| `expiresOn` | string \| null | no |  |
| `status` | `active` \| `redeemed` \| `expired` \| `void` | **yes** | Status. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:create`. |
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `DELETE /v1/admin/gift-cards/{id}`

> Archive a giftcard

Archive: `status` becomes `void`. This table has no `deleted_at` because other rows keep foreign keys to it.

Gated on `promotions:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

| | |
|---|---|
| operationId | `adminDeleteGiftCard` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `204` | Archived. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:delete`. |
| `404` | No such row, or it is already archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

---

#### `GET /v1/admin/gift-cards/{id}`

> Get one giftcard

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

| | |
|---|---|
| operationId | `adminGetGiftCard` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `fields` | string | no | Comma-separated projection, from the column allowlist. <br><sub>maxLen 600</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:view`. |
| `404` | No such row, or it is archived. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `PATCH /v1/admin/gift-cards/{id}`

> Update a giftcard

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

| | |
|---|---|
| operationId | `adminUpdateGiftCard` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `initialValuePaise` | integer \| null | no |  |
| `issuedToName` | string \| null | no |  |
| `issuedToEmail` | string \| null | no |  |
| `issuedToCustomerId` | string \| null | no |  |
| `expiresOn` | string \| null | no |  |
| `status` | `active` \| `redeemed` \| `expired` \| `void` \| null | no |  |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated row. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:edit`. |
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** | One row, projected to the requested `fields`. The primary key is always present. |

</details>

---

#### `POST /v1/admin/gift-cards/bulk`

> Bulk action on gift cards

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

| | |
|---|---|
| operationId | `adminBulkGiftCards` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | string | **yes** | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. <br><sub>minLen 1, maxLen 64</sub> |
| `ids` | array<string> | **yes** | Row ids. At most 100 — the same ceiling as a page. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What was matched and changed. |
| `400` | No such bulk action on this resource. |
| `401` | Missing, malformed or expired token. |
| `403` | The action needs an RBAC action your role does not have. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/gift-cards/schema`

> Field spec for gift cards

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

| | |
|---|---|
| operationId | `adminGetGiftCardSchema` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The descriptor. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `promotions:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin purchase returns

#### `GET /v1/admin/purchasing/purchase-returns`

> List purchase returns

Stock going back to a supplier. Filter by status (comma-separated), supplier, warehouse and reason. `?q=` matches the return number.

Unlike purchase orders, all six lifecycle statuses exist in the database for returns — `draft`, `pending_approval`, `approved`, `dispatched`, `completed`, `cancelled` — so no derivation is needed and `status` means exactly what it says.

| | |
|---|---|
| operationId | `adminListPurchaseReturns` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `-createdAt` (default), `createdAt`, `returnNo`, `status`, `totalPaise`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `status` | string | no | One status or a comma-separated list. <br><sub>maxLen 200</sub> |
| `supplierId` | string | no | Restrict to one supplier. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `warehouseId` | string | no | Restrict to one warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `reason` | `damaged` \| `wrong_item` \| `quality` \| `excess` \| `expired` \| `other` | no | Restrict to one reason. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of purchase returns. |
| `400` | An unrecognised status value. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/purchasing/purchase-returns`

> Raise a purchase return

Creates the return in `draft`. **No stock moves** — a return is a request until it is approved and dispatched.

Lines name an `inventoryLevelId`, not a SKU. That is what `purchase_return_lines` stores and it is the right shape: a return takes stock out of one specific warehouse, and naming a SKU would leave the question of which one open. Get the ids from `GET /v1/admin/warehouses/{warehouseId}/inventory`. Every line’s level must be in this return’s warehouse — anything else is 422 `level_warehouse_mismatch`.

Totals are computed from the lines: `subtotalPaise` is the sum of `quantity × unitCostPaise`, and `totalPaise` adds the `taxPaise` you are reversing. Integer paise.

The number comes from the `purchase_return` series added by migration 0003 — `PRET-2026-00001`.

| | |
|---|---|
| operationId | `adminCreatePurchaseReturn` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `supplierId` | string | **yes** | Who the goods are going back to. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `warehouseId` | string | **yes** | Where they are leaving from. Every line’s level must be in this warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `goodsReceiptId` | string \| null | no | The receipt being returned against, when it is known. |
| `reason` | `damaged` \| `wrong_item` \| `quality` \| `excess` \| `expired` \| `other` | **yes** | Why the goods are going back. Fixed vocabulary, enforced by a CHECK. |
| `note` | string \| null | no | Free text. |
| `taxPaise` | integer | no | Integer paise. GST to reverse, if any. Zero when the goods were never taxed to us. <br><sub>min 0, max 9007199254740991, default `0`</sub> |
| `lines` | array<object> | **yes** | At least one line. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created return. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:create`. |
| `404` | No such supplier or warehouse. |
| `422` | A line naming a level that is not in this warehouse. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/purchasing/purchase-returns/{returnId}`

> Get one purchase return

The return with its lines and `availableActions`. `totalPaise` is the credit expected from the supplier once they receive the goods.

| | |
|---|---|
| operationId | `adminGetPurchaseReturn` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `returnId` | string | **yes** | Purchase return id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The purchase return. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such purchase return. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/purchasing/purchase-returns/{returnId}/approve`

> Approve a purchase return

Gated on `inventory:approve`. Legal from `draft` and `pending_approval`; stamps `approvedBy` and `approvedAt`. No stock moves — approval authorises the dispatch, it does not perform it.

A return with no lines is refused here rather than at dispatch, because an approved empty document authorises sending nothing back.

| | |
|---|---|
| operationId | `adminApprovePurchaseReturn` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `returnId` | string | **yes** | Purchase return id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The approved return. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:approve`. |
| `404` | No such purchase return. |
| `422` | Illegal transition, or the return has no lines. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/purchasing/purchase-returns/{returnId}/dispatch`

> Dispatch an approved return to the supplier

`approved` → `dispatched`, and the only edge on a return that touches stock. In ONE transaction, for every line: decrement on-hand through the conditional `UPDATE … WHERE on_hand_qty - reserved_qty >= n`, and write an `outbound` movement with `referenceType: "purchase_return"` carrying the balance that update returned.

Reserved units belong to open carts and orders and cannot be sent back to a supplier, so a level with 10 on hand and 8 reserved can return 2. Short is 422 `insufficient_stock`, naming the SKU, and the whole dispatch rolls back — a return that shipped three of its four lines is a parcel the supplier will dispute and a ledger nobody can reconcile.

Levels are locked in ascending id order, so concurrent returns and transfers queue rather than deadlock.

A dispatched return cannot be cancelled: the stock has left. Requires an `Idempotency-Key`.

| | |
|---|---|
| operationId | `adminDispatchPurchaseReturn` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `returnId` | string | **yes** | Purchase return id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The dispatched return. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such purchase return. |
| `422` | Not approved, already dispatched, or `insufficient_stock`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin purchasing

#### `GET /v1/admin/purchasing/purchase-orders`

> List purchase orders

Filter by stored `status` (comma-separated), supplier, receiving warehouse and expected-date range. `?q=` matches the PO number.

Every row carries **both** `status` and `lifecycle`. `status` is one of the five values the database allows; `lifecycle` is what it means, derived from `status` plus `sentAt`. The one that matters: `status: "sent"` with `sentAt: null` is `lifecycle: "approved"` — approved, but not yet in front of the supplier, and the state in which `incomingQty` has deliberately not been raised. Filter on `sent` and read `lifecycle` to tell the two apart.

| | |
|---|---|
| operationId | `adminListPurchaseOrders` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `-createdAt` (default), `createdAt`, `poNo`, `status`, `expectedOn`, `totalPaise`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `status` | string | no | One stored status or a comma-separated list. <br><sub>maxLen 200</sub> |
| `supplierId` | string | no | Restrict to one supplier. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `warehouseId` | string | no | Restrict to one receiving warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `expectedFrom` | string | no | `YYYY-MM-DD`. Inclusive lower bound on `expectedOn`. <br><sub>pattern `^\d{4}-\d{2}-\d{2}$`</sub> |
| `expectedTo` | string | no | `YYYY-MM-DD`. Inclusive upper bound on `expectedOn`. <br><sub>pattern `^\d{4}-\d{2}-\d{2}$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of purchase orders. |
| `400` | An unrecognised status value. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/purchasing/purchase-orders`

> Raise a purchase order

Creates the PO in `draft` with its lines. Nothing is ordered and nothing is expected until it has been approved AND sent.

Every total is recomputed server-side: `lineTotalPaise` is `orderedQty × unitCostPaise` excluding GST, `taxPaise` applies each line’s own basis-point rate to its own subtotal (so a PO mixing 5% and 18% items does not have to pick one), and `totalPaise` is their sum. All integer paise. A client-supplied total is not accepted, let alone trusted.

The number comes from the `purchase_order` document series under a row lock — `PO-2026-02291`.

| | |
|---|---|
| operationId | `adminCreatePurchaseOrder` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `supplierId` | string | **yes** | Who we are buying from. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `warehouseId` | string | **yes** | Where the goods will be received. The GRN must name the same warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `expectedOn` | string \| null | no |  |
| `notes` | string \| null | no | Internal notes. Not sent to the supplier by this API. |
| `lines` | array<object> | **yes** | At least one line. A PO for nothing is not a document. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created purchase order. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:create`. |
| `404` | No such supplier or warehouse. |
| `422` | A line naming a stockable that does not exist. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/purchasing/purchase-orders/{poId}`

> Get one purchase order

The document with its lines, every goods receipt posted against it, and `availableActions`.

Per line, `outstandingQty` is `orderedQty - receivedQty`, and `receivedQty` counts **accepted** units only. Rejected goods appear on the receipts, never here — they are going back to the supplier, so the PO is still owed that stock.

Edges marked `documentDriven` (`partially_received`, `received`) have no endpoint: a PO reaches them because a GRN was posted, not because someone clicked. Render them disabled.

| | |
|---|---|
| operationId | `adminGetPurchaseOrder` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `poId` | string | **yes** | Purchase order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The purchase order. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such purchase order. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `PATCH /v1/admin/purchasing/purchase-orders/{poId}`

> Edit a draft purchase order

Draft only. Once a PO is approved the lines are the agreement, and once it is sent the supplier has a copy — editing either would leave two different documents with one number. Anything else is 422 `illegal_po_transition`.

Supplying `lines` REPLACES all of them and recomputes every total. Replacement rather than a partial patch because a line carries `receivedQty`, and a patch that reordered or dropped lines would have to invent an answer for what happens to it. In draft it is always zero, so replacement is safe.

| | |
|---|---|
| operationId | `adminUpdatePurchaseOrder` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `poId` | string | **yes** | Purchase order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `expectedOn` | string \| null | no |  |
| `notes` | string \| null | no | Internal notes, or null to clear. |
| `lines` | array<object> | no | Replaces ALL lines when given. Totals are recomputed. Draft only. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated purchase order. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such purchase order. |
| `422` | Not a draft, or a line naming a stockable that does not exist. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/purchasing/purchase-orders/{poId}/approve`

> Approve a purchase order

Gated on `inventory:approve`, which a Warehouse Manager does not hold — raising a PO and committing the company’s money to it are different jobs.

**Stored as `status: "sent"` with `sentAt` still null**, which reads back as `lifecycle: "approved"`. The `purchase_orders` CHECK allows exactly five statuses and there is no `approved` among them; writing one would fail against the live database rather than model anything. The two columns together carry the distinction the CHECK cannot.

`incomingQty` is deliberately NOT raised here. An approved PO nobody has posted to the supplier is not stock on its way, and counting it would make the reorder engine skip a SKU that was never actually ordered.

| | |
|---|---|
| operationId | `adminApprovePurchaseOrder` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `poId` | string | **yes** | Purchase order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The approved purchase order. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:approve`. |
| `404` | No such purchase order. |
| `422` | Illegal transition, or the PO has no lines. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/purchasing/purchase-orders/{poId}/cancel`

> Cancel a purchase order

Legal from draft, approved, sent and partially received. A `received` PO is terminal — goods that arrived cannot be un-received by a status flip; raise a purchase return instead.

Whatever has NOT been received stops being `incomingQty`, because it is no longer coming. Already received stock stays exactly where it is: it is in the warehouse.

The reason is stamped into the PO notes and captured by the automatic audit log.

| | |
|---|---|
| operationId | `adminCancelPurchaseOrder` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `poId` | string | **yes** | Purchase order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | **yes** | Why. Appended to the PO notes and the audit log. <br><sub>minLen 3, maxLen 400</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The cancelled purchase order. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such purchase order. |
| `422` | Already received or already cancelled. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/purchasing/purchase-orders/{poId}/send`

> Mark a purchase order sent to the supplier

Legal only from `lifecycle: "approved"`. Sending an unapproved draft is 422 `po_not_approved`.

Stamps `sentAt` and raises `incomingQty` at the receiving warehouse by each line’s outstanding quantity. This is the moment the order becomes real to the outside world, so it is the moment the warehouse starts expecting stock. `incomingQty` never touches `availableQty`, which is GENERATED from `on_hand - reserved` — ordered stock is expected, not sellable.

Also stamps `lastPurchaseAt` and `lastPurchaseCostPaise` on the matching supplier-catalogue entries, so the next reorder suggestion prices from what we actually paid.

Requires an `Idempotency-Key`: a retried send must not raise `incomingQty` twice.

| | |
|---|---|
| operationId | `adminSendPurchaseOrder` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `poId` | string | **yes** | Purchase order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The sent purchase order. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such purchase order. |
| `422` | Not approved yet, or already sent. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin resources

#### `GET /v1/admin/resources`

> The resource registry

Every generic resource this API serves, filtered to the ones your role can view. The console can build its nav from this instead of hardcoding 59 entries. Each carries its `basePath` (the five CRUD routes hang off it) and its `schemaPath` (the field spec that drives the forms).

| | |
|---|---|
| operationId | `adminListResources` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Resources you can view. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `dashboard:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---


## Admin suppliers

#### `GET /v1/admin/suppliers/{supplierId}/products`

> List what a supplier sells us

The join that makes reordering possible: the supplier’s own SKU, what they charge, their minimum order quantity and their lead time, per stockable.

A catalogue entry targets exactly one of a product variant, a loose hamper item or a packaging material — the same polymorphism `inventory_levels` uses. `?q=` matches our SKU, the title and the supplier’s own code. Archived entries are excluded unless `includeArchived=true`.

| | |
|---|---|
| operationId | `adminListSupplierProducts` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `supplierId` | string | **yes** | Supplier id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `sku` (default), `unitCostPaise`, `leadTimeDays`, `moq`, `createdAt`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `preferredOnly` | `true` \| `false` | no | `true` returns only the entries marked preferred for their target. |
| `includeArchived` | `true` \| `false` | no | Include soft-deleted entries. <br><sub>default `"false"`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of catalogue entries. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such supplier. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/suppliers/{supplierId}/products`

> Add an item to a supplier’s catalogue

Exactly one of `variantId`, `hamperItemId` or `packagingId`, which the database CHECKs. A second live entry for the same supplier and the same item is 422 `supplier_product_exists` — the reorder engine would have no way to choose between two prices for one thing.

`isPreferred` is capped at ONE per variant by a partial unique index. Setting it here demotes whoever held it, in the same transaction and BEFORE the insert: a partial unique index cannot be deferred, so doing it the other way round collides with a row that is about to change.

| | |
|---|---|
| operationId | `adminCreateSupplierProduct` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `supplierId` | string | **yes** | Supplier id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `variantId` | string | no | Product variant this supplier sells. Exactly one target. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `hamperItemId` | string | no | Loose hamper item this supplier sells. Exactly one target. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `packagingId` | string | no | Packaging material this supplier sells. Exactly one target. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `supplierSku` | string \| null | no | What the SUPPLIER calls it. This is what goes on the PO they receive. |
| `unitCostPaise` | integer | no | Integer paise. What they charge per unit, excluding GST. <br><sub>min 0, max 9007199254740991, default `0`</sub> |
| `moq` | integer | no | Minimum order quantity. The reorder engine rounds suggestions up to this. <br><sub>min 1, max 1000000, default `1`</sub> |
| `leadTimeDays` | integer | no | Days from order to delivery. Feeds reorder point = daily consumption × lead time + safety. <br><sub>min 0, max 3650, default `0`</sub> |
| `isPreferred` | boolean | no | At most ONE preferred supplier per variant, enforced by a partial unique index. Setting this clears the flag on whoever held it, in the same transaction. <br><sub>default `false`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created catalogue entry. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:create`. |
| `404` | No such supplier. |
| `422` | A duplicate entry, or a target that does not exist. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `PATCH /v1/admin/suppliers/{supplierId}/products/{supplierProductId}`

> Update a supplier catalogue entry

Cost, MOQ, lead time, the supplier’s SKU, and the preferred flag. Promoting one entry demotes the incumbent for that variant.

The TARGET is immutable — changing which item an entry prices is not an edit, it is a different entry, and silently repointing it would rewrite the price history of both.

`archived: true` soft-deletes and clears the preferred flag, freeing the slot in the unique index for a replacement supplier. `archived: false` restores it.

| | |
|---|---|
| operationId | `adminUpdateSupplierProduct` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `supplierId` | string | **yes** | Supplier id. The catalogue entry must belong to it. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `supplierProductId` | string | **yes** | Supplier catalogue entry id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `supplierSku` | string \| null | no | Supplier’s own SKU, or null to clear. |
| `unitCostPaise` | integer | no | Integer paise. New unit cost. <br><sub>min 0, max 9007199254740991</sub> |
| `moq` | integer | no | Minimum order quantity. <br><sub>min 1, max 1000000</sub> |
| `leadTimeDays` | integer | no | Lead time in days. <br><sub>min 0, max 3650</sub> |
| `isPreferred` | boolean | no | Promote or demote. Promotion demotes the incumbent. |
| `archived` | boolean | no | True soft-deletes the entry, freeing its slot in the unique index. False restores it. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated entry. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such entry for this supplier. |
| `422` | Restoring it would collide with a live entry for the same item. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin transfers

#### `GET /v1/admin/transfers`

> List stock transfers

Filter by `status` (comma-separated), by either end (`warehouseId`) or one specific end (`fromWarehouseId` / `toWarehouseId`), and by ETA range. `?q=` matches the transfer number.

The five statuses are the database’s: `requested`, `approved`, `in_transit`, `received`, `cancelled`. The lifecycle people say out loud — draft → approved → dispatched → in transit → received → completed — maps onto them without inventing values: draft is `requested`, dispatched and in-transit are both `in_transit` (dispatch is the event that puts stock in transit), and received and completed are both `received`. Passing `draft` is a 400 that says so.

`inTransitQty` is non-zero only while `in_transit` — that is the quantity currently belonging to neither warehouse.

| | |
|---|---|
| operationId | `adminListStockTransfers` |
| Auth | `adminBearerAuth` (staff) |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `-createdAt` (default), `createdAt`, `transferNo`, `status`, `etaOn`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `status` | string | no | One status or a comma-separated list. <br><sub>maxLen 200</sub> |
| `fromWarehouseId` | string | no | Source warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `toWarehouseId` | string | no | Destination warehouse. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `warehouseId` | string | no | Either end — source OR destination. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `etaFrom` | string | no | `YYYY-MM-DD`. Inclusive lower bound on ETA. <br><sub>pattern `^\d{4}-\d{2}-\d{2}$`</sub> |
| `etaTo` | string | no | `YYYY-MM-DD`. Inclusive upper bound on ETA. <br><sub>pattern `^\d{4}-\d{2}-\d{2}$`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of transfers. |
| `400` | An unrecognised status value. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/transfers`

> Raise a stock transfer

Creates the transfer in `requested` with its lines. **No stock moves.** A transfer is a request until it is approved and dispatched; decrementing here would strand stock the moment somebody raised a transfer and forgot about it.

The number comes from the `stock_transfer` document series under a row lock — `TRF-2026-00061`, never `Math.random()`. Source and destination must differ, and every line names exactly one of `variantId` or `hamperItemId`, both of which the database CHECKs.

Availability is NOT checked here, deliberately: stock levels at approval time are what matter, and a check now would only produce a promise the dispatch cannot keep.

| | |
|---|---|
| operationId | `adminCreateStockTransfer` |
| Auth | `adminBearerAuth` (staff) |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `fromWarehouseId` | string | **yes** | Source warehouse. Stock leaves here at dispatch. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `toWarehouseId` | string | **yes** | Destination warehouse. Must differ from the source. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `etaOn` | string \| null | no | `YYYY-MM-DD` the goods are expected to land. Informational. |
| `lines` | array<object> | **yes** | At least one line. A transfer of nothing is not a document. |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created transfer. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:create`. |
| `404` | No such source or destination warehouse. |
| `422` | Same warehouse at both ends, or a line naming a stockable that does not exist. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/transfers/{transferId}`

> Get one stock transfer

The document with its lines, both warehouse names, and `availableActions` — the legal edges from the current status with the side effects each carries. Render the buttons from that list and a disabled button and a 422 can never disagree.

| | |
|---|---|
| operationId | `adminGetStockTransfer` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `transferId` | string | **yes** | Stock transfer id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The transfer. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such transfer. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/transfers/{transferId}/approve`

> Approve a stock transfer

`requested` → `approved`, gated on `inventory:approve` — which, across the eleven roles, a Warehouse Manager does not hold. Raising a transfer and authorising it are different jobs.

No stock moves. A transfer with no lines is refused here rather than at dispatch, because an approved empty document is a thing nobody can act on.

| | |
|---|---|
| operationId | `adminApproveStockTransfer` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `transferId` | string | **yes** | Stock transfer id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The approved transfer. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:approve`. |
| `404` | No such transfer. |
| `422` | Illegal transition (`illegal_transfer_transition`), or the transfer has no lines. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/transfers/{transferId}/cancel`

> Cancel a stock transfer

Legal from `requested` and `approved` only — nothing has moved yet, so there is nothing to unwind.

A transfer that is already `in_transit` is refused with 422 `transfer_in_transit_not_cancellable`. The stock has left the source warehouse; "cancelling" it would leave those units on no document and in no warehouse, which is precisely the invisible inventory the movement ledger exists to prevent. Receive it at the destination and raise a transfer back.

| | |
|---|---|
| operationId | `adminCancelStockTransfer` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `transferId` | string | **yes** | Stock transfer id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | **yes** | Why. Recorded for the audit trail. <br><sub>minLen 3, maxLen 400</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The cancelled transfer. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such transfer. |
| `422` | Already in transit, already received, or already cancelled. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/transfers/{transferId}/dispatch`

> Dispatch an approved transfer

`approved` → `in_transit`, and the first of the two edges that touch stock. In ONE transaction, for every line: decrement on-hand at the source through a conditional `UPDATE … WHERE on_hand_qty - reserved_qty >= n`, write a `transfer_out` movement carrying the balance that update returned, and raise `incoming_qty` at the destination.

If any line is short the whole dispatch rolls back — no line half-ships. Reserved units belong to open carts and orders and are not available to transfer, so a warehouse with 10 on hand and 8 reserved can send 2. Short is 422 `insufficient_stock`, naming the SKU.

Source levels are locked in ascending id order, so two transfers sharing SKUs queue rather than deadlock.

From here until receipt the stock is in **neither** warehouse’s `availableQty`. That is not a gap in the accounting — it is where the goods actually are.

Requires an `Idempotency-Key`: a retried dispatch must not decrement twice.

| | |
|---|---|
| operationId | `adminDispatchStockTransfer` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `transferId` | string | **yes** | Stock transfer id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `note` | string | no | Recorded on each `transfer_out` movement. <br><sub>maxLen 500</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The dispatched transfer. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such transfer. |
| `422` | Illegal transition, no lines, or `insufficient_stock` at the source. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/transfers/{transferId}/receive`

> Receive a transfer at the destination

`in_transit` → `received`, the second stock-moving edge. In ONE transaction, for every line: increment on-hand at the destination, write a `transfer_in` movement with the resulting balance, and clear the `incoming_qty` this transfer raised.

Omit `lines` to receive everything in full, which is the common case. A line may arrive SHORT — the difference is goods lost in transit: they already left the source ledger and are simply never credited to the destination, so both warehouses stay reconciled and the loss is visible as `shortQty`. A line cannot arrive OVER; that is 422 `over_receipt`, which the `transfer_line_no_over_receipt` CHECK would otherwise raise as a constraint error.

Requires an `Idempotency-Key`: a retried receipt must not credit the destination twice.

| | |
|---|---|
| operationId | `adminReceiveStockTransfer` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `transferId` | string | **yes** | Stock transfer id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | array<object> | no | Per-line arrivals. Omit entirely to receive every line in full, which is the common case. Any shortfall is goods lost in transit: they already left the source ledger and are simply never credited to the destination. |
| `note` | string | no | Recorded on each `transfer_in` movement. <br><sub>maxLen 500</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The received transfer, with per-line `receivedQty` and `shortQty`. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such transfer. |
| `422` | Illegal transition, an unknown line id, or `over_receipt`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## Admin warehousing

#### `GET /v1/admin/warehouses/{warehouseId}/inventory`

> Stock held in one warehouse

Every `inventory_levels` row for this warehouse, across all three stockable kinds — variants, loose hamper items and packaging materials — with the SKU and title resolved for each.

`availableQty` is a GENERATED column (`on_hand - reserved`), so it cannot drift from the two numbers it is derived from. `incomingQty` is what is expected to arrive here: sent purchase orders plus transfers dispatched to this warehouse. Stock currently in transit appears in `incomingQty` at the destination and in neither warehouse’s `availableQty`, which is correct — it is on a lorry.

`?lowStock=true` returns only levels at or below their reorder point. `?locationId=` narrows to one bin. `inventoryLevelId` is the id transfer and purchase-return lines lock on.

| | |
|---|---|
| operationId | `adminListWarehouseInventory` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `warehouseId` | string | **yes** | Warehouse id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `sku` (default), `onHandQty`, `availableQty`, `reservedQty`, `incomingQty`, `lastMovementAt`. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `locationId` | string | no | Only levels stored at this bin location. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `lowStock` | `true` \| `false` | no | `true` returns only levels where available ≤ reorder point. |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of inventory levels. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such warehouse. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/warehouses/{warehouseId}/locations`

> List bin locations in a warehouse

The zone → rack → shelf → bin tree, flattened and sorted by `path` so the default ordering is also the tree order. Filter by `kind`, by `parentId` for one level of children, or by `pickable` to get only the locations a pick list may route to.

`?q=` matches path, code and name. Archived locations are excluded unless `includeArchived=true` — they are soft-deleted (§96) because the movement ledger still names them.

`depth` and `childCount` come back on every row so the console can render the tree without a second call per node.

| | |
|---|---|
| operationId | `adminListWarehouseLocations` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `warehouseId` | string | **yes** | Warehouse id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Query parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-indexed page number. <br><sub>max 9007199254740991, default `1`</sub> |
| `perPage` | integer | no | Items per page. Maximum 100. <br><sub>max 100, default `25`</sub> |
| `sort` | string | no | `path` (default), `code`, `kind`, `sortOrder`, `createdAt`. Prefix `-` for descending. <br><sub>maxLen 120</sub> |
| `q` | string | no | Free-text search. <br><sub>minLen 1, maxLen 120</sub> |
| `kind` | `zone` \| `rack` \| `shelf` \| `bin` | no | Restrict to one level of the hierarchy. |
| `parentId` | string | no | Direct children of this location only. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `pickable` | `true` \| `false` | no | `true` for pickable locations only — the ones a pick list may route to. |
| `includeArchived` | `true` \| `false` | no | Include soft-deleted locations. Off by default. <br><sub>default `"false"`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | A page of locations. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such warehouse. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/warehouses/{warehouseId}/locations`

> Create a bin location

`path` is **not** accepted in the body. The service builds it from the parent chain — `A` + `R3` + `S2` + `B7` becomes `A/R3/S2/B7` — because a client-settable materialised path is a denormalisation that has stopped being derived from anything, and the first wrong value sends a picker to the wrong aisle.

A child must sit strictly deeper than its parent. It may skip levels — a zone straight to a bin is a legitimate small studio — but a shelf inside a bin is 422 `invalid_location_depth`. A parent in another warehouse is 422; paths are unique per warehouse, so that would quietly start a second tree.

| | |
|---|---|
| operationId | `adminCreateWarehouseLocation` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `warehouseId` | string | **yes** | Warehouse id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string \| null | no | Parent location, or null/omitted for a top-level one. Must be in the same warehouse. |
| `kind` | `zone` \| `rack` \| `shelf` \| `bin` | **yes** | `zone` → `rack` → `shelf` → `bin`. A child may skip levels but never sit at or above its parent. |
| `code` | string | **yes** | Segment code, unique within its parent — `B7`. Becomes the last segment of `path`. <br><sub>pattern `^[A-Z0-9][A-Z0-9._-]{0,23}$`</sub> |
| `name` | string \| null | no | Human label, e.g. `Fragile goods, upper shelf`. |
| `isPickable` | boolean | no | False for staging, quarantine or overflow areas a pick list must not route to. <br><sub>default `true`</sub> |
| `sortOrder` | integer | no | Display order among siblings. <br><sub>min 0, max 100000, default `0`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `201` | The created location. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:create`. |
| `404` | No such warehouse, or no such parent location. |
| `422` | Duplicate path, illegal depth, an archived parent, or a parent in another warehouse. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/warehouses/{warehouseId}/locations/{locationId}`

> Get one bin location

Includes `childCount` and `stockedLevelCount` — the two numbers that decide whether it can be archived, so the console can disable the button rather than discover the 422.

| | |
|---|---|
| operationId | `adminGetWarehouseLocation` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `warehouseId` | string | **yes** | Warehouse id. The location must belong to it. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `locationId` | string | **yes** | Location id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The location. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:view`. |
| `404` | No such location in this warehouse. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `PATCH /v1/admin/warehouses/{warehouseId}/locations/{locationId}`

> Rename or move a bin location

Changing `parentId` or `code` rewrites `path` for this location **and every descendant** in the same transaction. A grandchild left holding the old prefix would be a bin that exists in the database and nowhere in the warehouse.

A `parentId` that sits inside this location’s own subtree is 422 `location_cycle`. The database CHECK only catches the trivial self-parent case; a three-node ring is caught here, before a recursive walk has anything to fail to terminate on.

`kind` is deliberately not editable — turning a rack into a bin while it still has shelves under it is not a rename, it is a restructure, and re-parenting the subtree is the honest way to say so.

| | |
|---|---|
| operationId | `adminUpdateWarehouseLocation` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `warehouseId` | string | **yes** | Warehouse id. The location must belong to it. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `locationId` | string | **yes** | Location id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Request body** — `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | string \| null | no | Move the location under a different parent, or null to make it top-level. The whole subtree’s `path` is rewritten in the same transaction. A parent that is a descendant is rejected. |
| `code` | string | no | Rename the segment. Rewrites `path` for this location and every descendant. <br><sub>pattern `^[A-Z0-9][A-Z0-9._-]{0,23}$`</sub> |
| `name` | string \| null | no | Human label, or null to clear. |
| `isPickable` | boolean | no | Whether pick lists may route here. |
| `sortOrder` | integer | no | Display order among siblings. <br><sub>min 0, max 100000</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The updated location. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:edit`. |
| `404` | No such location, or no such new parent. |
| `422` | A cycle, a duplicate path, an illegal depth, or the location is archived. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/warehouses/{warehouseId}/locations/{locationId}/archive`

> Archive a bin location

Soft delete (§96) — the movement ledger still names this location, so the row stays and the partial unique index frees the path for reuse.

Refused while it has live children (they would point at a dead parent) or while inventory levels are still stored there (they would claim a bin that no longer exists). Move the stock first. Archiving an already-archived location is a no-op rather than an error, so a double-click is not a failure.

| | |
|---|---|
| operationId | `adminArchiveWarehouseLocation` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `warehouseId` | string | **yes** | Warehouse id. The location must belong to it. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `locationId` | string | **yes** | Location id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The archived location, with `archivedAt` set. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `inventory:delete`. |
| `404` | No such location in this warehouse. |
| `422` | It still has live children or stock stored in it. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---


## RBAC

#### `GET /v1/admin/permissions`

> The permission vocabulary

The twelve modules and nine actions, with labels. `mutating: false` marks `view` and `export` — a role holding nothing but those cannot change anything, which is exactly the test that decides whether two-factor authentication is mandatory for it.

| | |
|---|---|
| operationId | `adminListPermissionCatalogue` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Modules and actions. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `settings:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/permissions/matrix`

> The whole grant matrix, and its drift

roleKey → module → actions, read from `role_permissions` — the copy that is actually enforced, not the compiled-in matrix. `drift` lists every grant the two disagree on, in both directions. An empty `drift` array is the healthy state; anything in it is either a deliberate emergency revocation or a seed that has not been run.

| | |
|---|---|
| operationId | `adminGetPermissionMatrix` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The stored matrix and its drift from source. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `settings:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/roles`

> List roles

The eleven system roles with live staff counts and grant counts. Backs the role picker on `/settings/team` and the role column on the team list.

| | |
|---|---|
| operationId | `adminListRoles` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | Roles, alphabetical. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `settings:view`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | array<object> | **yes** |  |
| `meta` | object | **yes** |  |

</details>

---

#### `GET /v1/admin/roles/{roleId}`

> Get one role

The role, its grants in both shapes (a flat `module:action` list and the module-pivoted map the matrix screen renders), and the staff members holding it.

| | |
|---|---|
| operationId | `adminGetRole` |
| Auth | `adminBearerAuth` (staff) |

**Path parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `roleId` | string | **yes** | Role id from `GET /v1/admin/roles`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

**Responses**

| Status | Meaning |
|---|---|
| `200` | The role. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `settings:view`. |
| `404` | No such role. |
| `422` | Validation failed. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---

#### `POST /v1/admin/roles/sync`

> Re-seed roles and grants from the source matrix

Projects `lib/rbac-matrix.ts` onto `roles` and `role_permissions`. Idempotent, and it REVOKES grants the matrix no longer contains — without that step, narrowing a role in code would be a no-op in the database, which is the one kind of seed bug that fails open.

It therefore also **undoes any manual revocation**. Check `GET /v1/admin/permissions/matrix` first. Gated on `settings:manage-settings`, which only Super Admin and Finance Manager hold.

| | |
|---|---|
| operationId | `adminSyncRolesFromMatrix` |
| Auth | `adminBearerAuth` (staff) |

**Responses**

| Status | Meaning |
|---|---|
| `200` | What changed. |
| `401` | Missing, malformed or expired token. |
| `403` | Authenticated, but the staff role lacks `settings:manage-settings`. |
| `429` | Rate limit exceeded. |
| `500` | Unexpected server error. |

<details><summary>Success payload — the <code>data</code> field of the envelope</summary>

| Field | Type | Always present | Description |
|---|---|---|---|
| `data` | object | **yes** |  |

</details>

---
