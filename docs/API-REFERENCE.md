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
| `id` | string | **yes** | `customers.id`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `fullName` | string \| null | **yes** | Display name, or null if never supplied. |
| `email` | string \| null | **yes** | Email address, or null on a mobile-only (OTP) account. |
| `mobile` | string \| null | **yes** | Ten-digit Indian mobile, or null on an email-only account. |
| `birthday` | string \| null | **yes** | `YYYY-MM-DD`, or null. Stored as a DATE — no timezone, because a birthday does not have one. |
| `gender` | `female` \| `male` \| `other` \| `undisclosed` \| null | **yes** | Self-declared, and optional. `undisclosed` is a valid answer. |
| `emailVerified` | boolean | **yes** | True once the address has been proven. |
| `mobileVerified` | boolean | **yes** | True once an OTP for the number has been verified. |
| `marketingOptIn` | boolean | **yes** | Marketing consent. Toggling it on writes a timestamped consent record. |
| `whatsappOptIn` | boolean | **yes** | WhatsApp consent. Separate from email/SMS because the channel is separate. |
| `hasPassword` | boolean | **yes** | False on an OTP-only account — offer “set a password” when false. |
| `acceptsCod` | boolean | **yes** | Whether cash-on-delivery is offered to this customer. Set by ops, read-only here. |
| `createdAt` | string | **yes** | ISO-8601 timestamp of account creation. |

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
| `id` | string | **yes** | `customers.id`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `fullName` | string \| null | **yes** | Display name, or null if never supplied. |
| `email` | string \| null | **yes** | Email address, or null on a mobile-only (OTP) account. |
| `mobile` | string \| null | **yes** | Ten-digit Indian mobile, or null on an email-only account. |
| `birthday` | string \| null | **yes** | `YYYY-MM-DD`, or null. Stored as a DATE — no timezone, because a birthday does not have one. |
| `gender` | `female` \| `male` \| `other` \| `undisclosed` \| null | **yes** | Self-declared, and optional. `undisclosed` is a valid answer. |
| `emailVerified` | boolean | **yes** | True once the address has been proven. |
| `mobileVerified` | boolean | **yes** | True once an OTP for the number has been verified. |
| `marketingOptIn` | boolean | **yes** | Marketing consent. Toggling it on writes a timestamped consent record. |
| `whatsappOptIn` | boolean | **yes** | WhatsApp consent. Separate from email/SMS because the channel is separate. |
| `hasPassword` | boolean | **yes** | False on an OTP-only account — offer “set a password” when false. |
| `acceptsCod` | boolean | **yes** | Whether cash-on-delivery is offered to this customer. Set by ops, read-only here. |
| `createdAt` | string | **yes** | ISO-8601 timestamp of account creation. |

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
| `productId` | string | **yes** | `products.id`. The wishlist is keyed by id, not by handle — a handle can be edited. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `handle` | string | **yes** | Current URL slug, for linking to the PDP. |
| `title` | string | **yes** | Product title. |
| `imageUrl` | string \| null | **yes** | Primary image URL, or null. |
| `fromPricePaise` | integer \| null | **yes** | Cheapest live variant price, GST-inclusive, in integer paise. Null when nothing is purchasable. |
| `inStock` | boolean | **yes** | True when at least one variant has stock available right now. |
| `available` | boolean | **yes** | False once the product is unpublished or deleted. The row is kept rather than silently dropped, so the customer sees “no longer available” instead of a shorter list they cannot explain. |
| `addedAt` | string | **yes** | ISO-8601 timestamp of when it was saved. |

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
| `id` | string | **yes** | Address id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `label` | string | **yes** | Address-book label. |
| `contactName` | string | **yes** | Who receives the parcel. |
| `mobile` | string | **yes** | Delivery contact number. |
| `line1` | string | **yes** | House/flat, building, street. |
| `line2` | string \| null | **yes** | Second address line, or null. |
| `area` | string \| null | **yes** | Locality, or null. |
| `city` | string | **yes** | City. |
| `stateCode` | string | **yes** | Two-digit GST state code. |
| `pincode` | string | **yes** | Six-digit PIN code. |
| `countryCode` | string | **yes** | ISO-3166-1 alpha-2 country code. |
| `isDefault` | boolean | **yes** | Exactly one address per customer has this set — enforced by a partial unique index, not by hope. |
| `createdAt` | string | **yes** | ISO-8601 timestamp. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp. |

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
| `id` | string | **yes** | Address id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `label` | string | **yes** | Address-book label. |
| `contactName` | string | **yes** | Who receives the parcel. |
| `mobile` | string | **yes** | Delivery contact number. |
| `line1` | string | **yes** | House/flat, building, street. |
| `line2` | string \| null | **yes** | Second address line, or null. |
| `area` | string \| null | **yes** | Locality, or null. |
| `city` | string | **yes** | City. |
| `stateCode` | string | **yes** | Two-digit GST state code. |
| `pincode` | string | **yes** | Six-digit PIN code. |
| `countryCode` | string | **yes** | ISO-3166-1 alpha-2 country code. |
| `isDefault` | boolean | **yes** | Exactly one address per customer has this set — enforced by a partial unique index, not by hope. |
| `createdAt` | string | **yes** | ISO-8601 timestamp. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp. |

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
| `id` | string | **yes** | Address id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `label` | string | **yes** | Address-book label. |
| `contactName` | string | **yes** | Who receives the parcel. |
| `mobile` | string | **yes** | Delivery contact number. |
| `line1` | string | **yes** | House/flat, building, street. |
| `line2` | string \| null | **yes** | Second address line, or null. |
| `area` | string \| null | **yes** | Locality, or null. |
| `city` | string | **yes** | City. |
| `stateCode` | string | **yes** | Two-digit GST state code. |
| `pincode` | string | **yes** | Six-digit PIN code. |
| `countryCode` | string | **yes** | ISO-3166-1 alpha-2 country code. |
| `isDefault` | boolean | **yes** | Exactly one address per customer has this set — enforced by a partial unique index, not by hope. |
| `createdAt` | string | **yes** | ISO-8601 timestamp. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp. |

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
| `status` | `"sent"` | **yes** | Always `sent`, whether or not an account exists for the address or number supplied. This endpoint is deliberately not an account-existence oracle. |

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
| `accessToken` | string | **yes** | HS256 JWT, audience `customer`. Send it as `Authorization: Bearer <token>`. **Keep it in memory only** — never `localStorage`, which is XSS-lootable. |
| `tokenType` | `"Bearer"` | **yes** | Always `Bearer`. |
| `expiresIn` | integer | **yes** | Seconds until `accessToken` expires. Refresh before it does via `POST /v1/auth/refresh`. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `customer` | object | **yes** | The signed-in customer. |

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
| `id` | string | **yes** | `customers.id`. This is the subject of every customer access token. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `fullName` | string \| null | **yes** | Display name, or null if never supplied. |
| `email` | string \| null | **yes** | Email address, or null on a mobile-only (OTP) account. |
| `mobile` | string \| null | **yes** | Ten-digit mobile, or null on an email-only account. |
| `emailVerified` | boolean | **yes** | True once the address has been proven — today, by completing a password reset. |
| `mobileVerified` | boolean | **yes** | True once an OTP for this number has been verified. |
| `marketingOptIn` | boolean | **yes** | Marketing consent. False unless explicitly granted. |
| `whatsappOptIn` | boolean | **yes** | WhatsApp messaging consent. False unless explicitly granted. |
| `hasPassword` | boolean | **yes** | False on an OTP-only account — the storefront should offer “set a password”. |
| `createdAt` | string | **yes** | ISO-8601 timestamp of account creation. |

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
| `status` | `"sent"` | **yes** | Always `sent`, whether or not an account exists for the address or number supplied. This endpoint is deliberately not an account-existence oracle. |

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
| `accessToken` | string | **yes** | HS256 JWT, audience `customer`. Send it as `Authorization: Bearer <token>`. **Keep it in memory only** — never `localStorage`, which is XSS-lootable. |
| `tokenType` | `"Bearer"` | **yes** | Always `Bearer`. |
| `expiresIn` | integer | **yes** | Seconds until `accessToken` expires. Refresh before it does via `POST /v1/auth/refresh`. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `customer` | object | **yes** | The signed-in customer. |

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
| `accessToken` | string | **yes** | HS256 JWT, audience `customer`. Send it as `Authorization: Bearer <token>`. **Keep it in memory only** — never `localStorage`, which is XSS-lootable. |
| `tokenType` | `"Bearer"` | **yes** | Always `Bearer`. |
| `expiresIn` | integer | **yes** | Seconds until `accessToken` expires. Refresh before it does via `POST /v1/auth/refresh`. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `customer` | object | **yes** | The signed-in customer. |

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
| `status` | `"ok"` | **yes** | The operation completed. |

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
| `accessToken` | string | **yes** | HS256 JWT, audience `customer`. Send it as `Authorization: Bearer <token>`. **Keep it in memory only** — never `localStorage`, which is XSS-lootable. |
| `tokenType` | `"Bearer"` | **yes** | Always `Bearer`. |
| `expiresIn` | integer | **yes** | Seconds until `accessToken` expires. Refresh before it does via `POST /v1/auth/refresh`. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `customer` | object | **yes** | The signed-in customer. |

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
| `id` | string \| null | **yes** | Cart id, or null when no cart exists yet. |
| `token` | string \| null | **yes** | Opaque cart handle. Store it and send it back as `X-Cart-Token`. Null when no cart exists yet. |
| `stage` | `cart` \| `address` \| `payment` \| `converted` | **yes** | How far through checkout this cart got. Drives abandonment recovery. |
| `couponCode` | string \| null | **yes** | Applied coupon code, or null. |
| `lines` | array<object> | **yes** | Lines in add order. |
| `totals` | object | **yes** | Server-computed money. Standard delivery, prepaid, before an address is known. |
| `itemCount` | integer | **yes** | Total units, not the number of lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `hasUnavailableLines` | boolean | **yes** | True when any line exceeds available stock. Checkout will reject. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp of the last change. |

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
| `id` | string \| null | **yes** | Cart id, or null when no cart exists yet. |
| `token` | string \| null | **yes** | Opaque cart handle. Store it and send it back as `X-Cart-Token`. Null when no cart exists yet. |
| `stage` | `cart` \| `address` \| `payment` \| `converted` | **yes** | How far through checkout this cart got. Drives abandonment recovery. |
| `couponCode` | string \| null | **yes** | Applied coupon code, or null. |
| `lines` | array<object> | **yes** | Lines in add order. |
| `totals` | object | **yes** | Server-computed money. Standard delivery, prepaid, before an address is known. |
| `itemCount` | integer | **yes** | Total units, not the number of lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `hasUnavailableLines` | boolean | **yes** | True when any line exceeds available stock. Checkout will reject. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp of the last change. |

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
| `id` | string \| null | **yes** | Cart id, or null when no cart exists yet. |
| `token` | string \| null | **yes** | Opaque cart handle. Store it and send it back as `X-Cart-Token`. Null when no cart exists yet. |
| `stage` | `cart` \| `address` \| `payment` \| `converted` | **yes** | How far through checkout this cart got. Drives abandonment recovery. |
| `couponCode` | string \| null | **yes** | Applied coupon code, or null. |
| `lines` | array<object> | **yes** | Lines in add order. |
| `totals` | object | **yes** | Server-computed money. Standard delivery, prepaid, before an address is known. |
| `itemCount` | integer | **yes** | Total units, not the number of lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `hasUnavailableLines` | boolean | **yes** | True when any line exceeds available stock. Checkout will reject. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp of the last change. |

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
| `id` | string \| null | **yes** | Cart id, or null when no cart exists yet. |
| `token` | string \| null | **yes** | Opaque cart handle. Store it and send it back as `X-Cart-Token`. Null when no cart exists yet. |
| `stage` | `cart` \| `address` \| `payment` \| `converted` | **yes** | How far through checkout this cart got. Drives abandonment recovery. |
| `couponCode` | string \| null | **yes** | Applied coupon code, or null. |
| `lines` | array<object> | **yes** | Lines in add order. |
| `totals` | object | **yes** | Server-computed money. Standard delivery, prepaid, before an address is known. |
| `itemCount` | integer | **yes** | Total units, not the number of lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `hasUnavailableLines` | boolean | **yes** | True when any line exceeds available stock. Checkout will reject. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp of the last change. |

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
| `id` | string \| null | **yes** | Cart id, or null when no cart exists yet. |
| `token` | string \| null | **yes** | Opaque cart handle. Store it and send it back as `X-Cart-Token`. Null when no cart exists yet. |
| `stage` | `cart` \| `address` \| `payment` \| `converted` | **yes** | How far through checkout this cart got. Drives abandonment recovery. |
| `couponCode` | string \| null | **yes** | Applied coupon code, or null. |
| `lines` | array<object> | **yes** | Lines in add order. |
| `totals` | object | **yes** | Server-computed money. Standard delivery, prepaid, before an address is known. |
| `itemCount` | integer | **yes** | Total units, not the number of lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `hasUnavailableLines` | boolean | **yes** | True when any line exceeds available stock. Checkout will reject. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp of the last change. |

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
| `id` | string \| null | **yes** | Cart id, or null when no cart exists yet. |
| `token` | string \| null | **yes** | Opaque cart handle. Store it and send it back as `X-Cart-Token`. Null when no cart exists yet. |
| `stage` | `cart` \| `address` \| `payment` \| `converted` | **yes** | How far through checkout this cart got. Drives abandonment recovery. |
| `couponCode` | string \| null | **yes** | Applied coupon code, or null. |
| `lines` | array<object> | **yes** | Lines in add order. |
| `totals` | object | **yes** | Server-computed money. Standard delivery, prepaid, before an address is known. |
| `itemCount` | integer | **yes** | Total units, not the number of lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `hasUnavailableLines` | boolean | **yes** | True when any line exceeds available stock. Checkout will reject. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp of the last change. |

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
| `id` | string \| null | **yes** | Cart id, or null when no cart exists yet. |
| `token` | string \| null | **yes** | Opaque cart handle. Store it and send it back as `X-Cart-Token`. Null when no cart exists yet. |
| `stage` | `cart` \| `address` \| `payment` \| `converted` | **yes** | How far through checkout this cart got. Drives abandonment recovery. |
| `couponCode` | string \| null | **yes** | Applied coupon code, or null. |
| `lines` | array<object> | **yes** | Lines in add order. |
| `totals` | object | **yes** | Server-computed money. Standard delivery, prepaid, before an address is known. |
| `itemCount` | integer | **yes** | Total units, not the number of lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `hasUnavailableLines` | boolean | **yes** | True when any line exceeds available stock. Checkout will reject. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp of the last change. |

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
| `id` | string \| null | **yes** | Cart id, or null when no cart exists yet. |
| `token` | string \| null | **yes** | Opaque cart handle. Store it and send it back as `X-Cart-Token`. Null when no cart exists yet. |
| `stage` | `cart` \| `address` \| `payment` \| `converted` | **yes** | How far through checkout this cart got. Drives abandonment recovery. |
| `couponCode` | string \| null | **yes** | Applied coupon code, or null. |
| `lines` | array<object> | **yes** | Lines in add order. |
| `totals` | object | **yes** | Server-computed money. Standard delivery, prepaid, before an address is known. |
| `itemCount` | integer | **yes** | Total units, not the number of lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `hasUnavailableLines` | boolean | **yes** | True when any line exceeds available stock. Checkout will reject. |
| `updatedAt` | string | **yes** | ISO-8601 timestamp of the last change. |

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
| `cartId` | string | **yes** | The cart that was priced. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `currency` | string | **yes** | ISO-4217 currency code. Always `INR` today. |
| `totals` | object | **yes** | The authoritative money. Recomputed from catalogue state on every call. |
| `serviceable` | boolean | **yes** | False when the destination PIN code is unknown or suspended. |
| `codEligible` | boolean | **yes** | True when both the zone and the PIN code allow cash on delivery. |
| `paymentMethodAllowed` | boolean | **yes** | False when the requested `paymentMethod` cannot be used — today that means COD on an ineligible PIN. |
| `estimatedDeliveryDate` | string \| null | **yes** | `YYYY-MM-DD` promise for the chosen delivery type. |
| `deliveryOptions` | array<object> | **yes** | Every delivery type with its live availability and surcharge. |
| `placeOfSupplyStateCode` | string | **yes** | Two-digit GST state code that will be frozen onto the order. |
| `warnings` | array<string> | **yes** | Non-fatal changes since the cart was last read — a price moved, a coupon stopped applying, a line was clamped to available stock. Show these before taking payment. |

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
| `orderId` | string | **yes** | Order id. Use it for `GET /v1/account/orders/{orderId}`. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `orderNo` | string | **yes** | Human-facing number, e.g. `ACH100042`. Issued by the document-number series. |
| `status` | string | **yes** | `pending_payment` for prepaid, `confirmed` for COD. |
| `paymentStatus` | string | **yes** | `pending` for prepaid, `cod_due` for cash on delivery. |
| `totalPaise` | integer | **yes** | Amount payable in integer paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `currency` | string | **yes** | ISO-4217 currency code. |
| `placedAt` | string | **yes** | ISO-8601 timestamp the order was placed. |
| `totals` | object | **yes** | The frozen breakdown, exactly as written to `orders` and `order_lines`. |
| `payment` | object \| null | **yes** | Razorpay session for a prepaid order. Null for COD, and null if the gateway was unreachable — in that case the order exists in `pending_payment` and the client should call `POST /v1/payments/razorpay/order` to obtain a session. |

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
| `collection` | object | **yes** | The collection itself. |
| `availableTypes` | array<object> | **yes** | Category facets present in this collection, with counts. Computed server-side. |
| `priceBounds` | object | **yes** | Price slider bounds for this collection. |
| `seo` | object \| null | **yes** | SEO overrides for this listing page. |

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
| `pincode` | string | **yes** | The PIN code that was checked, echoed back. |
| `serviceable` | boolean | **yes** | False for both unknown PIN codes and known-but-suspended ones. |
| `city` | string \| null | **yes** | City the PIN code resolves to. |
| `stateCode` | string \| null | **yes** | Two-digit GST state code, e.g. `27` for Maharashtra. |
| `zoneName` | string \| null | **yes** | Delivery zone name, e.g. `Mumbai Metro`. |
| `tier` | `metro` \| `tier_1` \| `tier_2` \| `tier_3` \| `remote` \| `international` \| null | **yes** | Zone tier. Drives the shipping slab. |
| `standardTatDays` | integer \| null | **yes** | Standard turnaround in working days for this zone. |
| `estimatedDeliveryDate` | string \| null | **yes** | `YYYY-MM-DD` promise date for a standard order placed now, in Asia/Kolkata. |
| `sameDayEligible` | boolean | **yes** | True only when the zone supports same-day AND the cutoff has not passed in Asia/Kolkata. |
| `sameDayCutoff` | string \| null | **yes** | Local cutoff time `HH:MM:SS` for same-day dispatch. |
| `midnightEligible` | boolean | **yes** | True when the zone runs midnight deliveries. |
| `codEligible` | boolean | **yes** | Cash on delivery allowed — zone policy AND PIN-code policy must both allow it. |

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
| `id` | string | **yes** | Designer id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `handle` | string | **yes** | URL slug. |
| `name` | string | **yes** | Display name. |
| `kind` | `designer` \| `brand` \| `celebrity` \| `artisan_cluster` | **yes** | What sort of maker this is. |
| `bio` | string \| null | **yes** | Long-form biography. |
| `logo` | object \| null | **yes** | Logo asset, or null. |
| `productCount` | integer | **yes** | Live, active products attributed to this designer. <br><sub>min -9007199254740991, max 9007199254740991</sub> |

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
| `id` | string | **yes** | Builder template id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `handle` | string | **yes** | Builder template handle, e.g. `build-your-own-hamper`. |
| `name` | string | **yes** | Template name. |
| `basePricePaise` | integer | **yes** | Price floor before any option is chosen, integer paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `maxWeightGrams` | integer \| null | **yes** | Hard weight ceiling for the assembled hamper. |
| `steps` | array<object> | **yes** | The wizard, in order. Per-step min/max are the real constraints. |

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
| `id` | string | **yes** | Post id. Prefer `slug` for URLs. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `slug` | string | **yes** | URL slug. Routes `/journal/:slug`. |
| `title` | string | **yes** | Headline. |
| `excerpt` | string \| null | **yes** | Standfirst shown on the index card. |
| `category` | string \| null | **yes** | Editorial category, e.g. `Gifting guides`. |
| `authorName` | string \| null | **yes** | Byline — the staff author’s name, or the guest author name when there is no staff row. |
| `heroImage` | object \| null | **yes** | Lead image, or null. |
| `readMinutes` | integer \| null | **yes** | Estimated reading time in minutes. |
| `viewCount` | integer | **yes** | Lifetime view count. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `publishedAt` | string \| null | **yes** | ISO-8601 publish timestamp. |
| `body` | array<object> | **yes** | Ordered rich-text blocks, rendered in sequence. Each block is an object with a `type` discriminator and type-specific fields; unknown types must be skipped, not thrown on. |
| `relatedSlugs` | array<string> | **yes** | Slugs of the newest other posts in the same category — the "keep reading" rail. |
| `seo` | object \| null | **yes** | SEO overrides for this post, or null to fall back to defaults. |

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
| `status` | `"received"` | **yes** | The enquiry is persisted. It is no longer only a toast. |
| `reference` | string | **yes** | Human-quotable lead number, e.g. `LD-00042`. Give it to the customer; support can search on it. |

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
| `status` | `"received"` | **yes** | The enquiry is persisted. It is no longer only a toast. |
| `reference` | string | **yes** | Human-quotable lead number, e.g. `LD-00042`. Give it to the customer; support can search on it. |

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
| `status` | `"subscribed"` | **yes** | Always `subscribed`, including for an address that was already on the list. Re-subscribing is idempotent and is not an error. |

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
| `id` | string | **yes** | Menu id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `key` | string | **yes** | Menu key, e.g. `header`. |
| `name` | string | **yes** | Human name for the menu. |
| `items` | array<object> | **yes** | Every visible item, FLAT and depth-ordered (parents before their children, siblings in `position` order). Build the tree from `parentId` — a self-referencing response type is not expressible in a generated client, and megamenu depth is not fixed. |

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
| `id` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `orderNo` | string | **yes** | Human-facing number, e.g. `ACH100042`. |
| `status` | `pending_payment` \| `paid` \| `confirmed` \| `in_production` \| `personalisation_pending` \| `quality_check` \| `packed` \| `ready_to_ship` \| `shipped` \| `out_for_delivery` \| `delivered` \| `failed_delivery` \| `rto` \| `cancelled` \| `refund_initiated` \| `refunded` | **yes** | Operational status, driven by real fulfilment and gateway events — never by elapsed time. Sixteen values; `trackingStage` projects them onto the five the customer UI shows. |
| `paymentStatus` | string | **yes** | Independent of `status`: `pending`, `paid`, `failed`, `partially_refunded`, `refunded`, `cod_due`. |
| `trackingStage` | `placed` \| `packed` \| `shipped` \| `out_for_delivery` \| `delivered` \| null | **yes** | The five-stage projection for the UI. Null when the order left the happy path. |
| `placedAt` | string | **yes** | ISO-8601 timestamp the order was placed. |
| `itemCount` | integer | **yes** | Total units across all lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `totalPaise` | integer | **yes** | Amount charged, in integer paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `currency` | string | **yes** | ISO-4217 currency code. |
| `deliveryType` | string | **yes** | `standard`, `scheduled`, `same_day`, `midnight` or `international`. |
| `requestedDeliveryDate` | string \| null | **yes** | `YYYY-MM-DD` requested date, or null. |
| `canCancel` | boolean | **yes** | True while the order is still cancellable by you. The API re-checks it. |
| `thumbnailUrl` | string \| null | **yes** | First line’s image, for the order list. |
| `buyerName` | string | **yes** | Buyer name, frozen at order time. |
| `buyerEmail` | string \| null | **yes** | Buyer email, frozen at order time. |
| `buyerMobile` | string \| null | **yes** | Buyer mobile, frozen at order time. |
| `recipientName` | string \| null | **yes** | Gift recipient, or null. |
| `recipientMobile` | string \| null | **yes** | Recipient mobile, or null. |
| `giftMessage` | string \| null | **yes** | Gift card message, or null. |
| `isAnonymousGift` | boolean | **yes** | True when the recipient is not told who sent it. |
| `shippingAddress` | object | **yes** | The address snapshot. An order is a legal record and its address never mutates. |
| `deliverySlot` | string \| null | **yes** | Requested slot, or null. |
| `couponCode` | string \| null | **yes** | Coupon applied at order time, or null. |
| `subtotalPaise` | integer | **yes** | Σ of line gross values, in paise. Already net of the coupon. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `couponDiscountPaise` | integer | **yes** | Coupon value in paise. Informational — do not subtract again. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `shippingPaise` | integer | **yes** | Shipping charged, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `codFeePaise` | integer | **yes** | COD handling fee, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `taxablePaise` | integer | **yes** | Order taxable value, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `cgstPaise` | integer | **yes** | CGST, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `sgstPaise` | integer | **yes** | SGST, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `igstPaise` | integer | **yes** | IGST, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `cessPaise` | integer | **yes** | Cess, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `roundOffPaise` | integer | **yes** | Invoice rounding, in paise. Bounded ±50. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `amountPaidPaise` | integer | **yes** | Captured so far, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `amountRefundedPaise` | integer | **yes** | Refunded so far, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `isInterstate` | boolean | **yes** | True when the supply was interstate, which makes the tax IGST. |
| `cancelReason` | string \| null | **yes** | Why it was cancelled, or null. |
| `cancelledAt` | string \| null | **yes** | ISO-8601 cancellation timestamp, or null. |
| `lines` | array<object> | **yes** | Order lines in display order. |
| `timeline` | array<object> | **yes** | Append-only event log, oldest first. |

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
| `id` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `orderNo` | string | **yes** | Human-facing number, e.g. `ACH100042`. |
| `status` | `pending_payment` \| `paid` \| `confirmed` \| `in_production` \| `personalisation_pending` \| `quality_check` \| `packed` \| `ready_to_ship` \| `shipped` \| `out_for_delivery` \| `delivered` \| `failed_delivery` \| `rto` \| `cancelled` \| `refund_initiated` \| `refunded` | **yes** | Operational status, driven by real fulfilment and gateway events — never by elapsed time. Sixteen values; `trackingStage` projects them onto the five the customer UI shows. |
| `paymentStatus` | string | **yes** | Independent of `status`: `pending`, `paid`, `failed`, `partially_refunded`, `refunded`, `cod_due`. |
| `trackingStage` | `placed` \| `packed` \| `shipped` \| `out_for_delivery` \| `delivered` \| null | **yes** | The five-stage projection for the UI. Null when the order left the happy path. |
| `placedAt` | string | **yes** | ISO-8601 timestamp the order was placed. |
| `itemCount` | integer | **yes** | Total units across all lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `totalPaise` | integer | **yes** | Amount charged, in integer paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `currency` | string | **yes** | ISO-4217 currency code. |
| `deliveryType` | string | **yes** | `standard`, `scheduled`, `same_day`, `midnight` or `international`. |
| `requestedDeliveryDate` | string \| null | **yes** | `YYYY-MM-DD` requested date, or null. |
| `canCancel` | boolean | **yes** | True while the order is still cancellable by you. The API re-checks it. |
| `thumbnailUrl` | string \| null | **yes** | First line’s image, for the order list. |
| `buyerName` | string | **yes** | Buyer name, frozen at order time. |
| `buyerEmail` | string \| null | **yes** | Buyer email, frozen at order time. |
| `buyerMobile` | string \| null | **yes** | Buyer mobile, frozen at order time. |
| `recipientName` | string \| null | **yes** | Gift recipient, or null. |
| `recipientMobile` | string \| null | **yes** | Recipient mobile, or null. |
| `giftMessage` | string \| null | **yes** | Gift card message, or null. |
| `isAnonymousGift` | boolean | **yes** | True when the recipient is not told who sent it. |
| `shippingAddress` | object | **yes** | The address snapshot. An order is a legal record and its address never mutates. |
| `deliverySlot` | string \| null | **yes** | Requested slot, or null. |
| `couponCode` | string \| null | **yes** | Coupon applied at order time, or null. |
| `subtotalPaise` | integer | **yes** | Σ of line gross values, in paise. Already net of the coupon. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `couponDiscountPaise` | integer | **yes** | Coupon value in paise. Informational — do not subtract again. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `shippingPaise` | integer | **yes** | Shipping charged, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `codFeePaise` | integer | **yes** | COD handling fee, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `taxablePaise` | integer | **yes** | Order taxable value, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `cgstPaise` | integer | **yes** | CGST, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `sgstPaise` | integer | **yes** | SGST, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `igstPaise` | integer | **yes** | IGST, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `cessPaise` | integer | **yes** | Cess, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `roundOffPaise` | integer | **yes** | Invoice rounding, in paise. Bounded ±50. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `amountPaidPaise` | integer | **yes** | Captured so far, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `amountRefundedPaise` | integer | **yes** | Refunded so far, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `isInterstate` | boolean | **yes** | True when the supply was interstate, which makes the tax IGST. |
| `cancelReason` | string \| null | **yes** | Why it was cancelled, or null. |
| `cancelledAt` | string \| null | **yes** | ISO-8601 cancellation timestamp, or null. |
| `lines` | array<object> | **yes** | Order lines in display order. |
| `timeline` | array<object> | **yes** | Append-only event log, oldest first. |

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
| `orderNo` | string | **yes** | The order number, echoed back. |
| `status` | `pending_payment` \| `paid` \| `confirmed` \| `in_production` \| `personalisation_pending` \| `quality_check` \| `packed` \| `ready_to_ship` \| `shipped` \| `out_for_delivery` \| `delivered` \| `failed_delivery` \| `rto` \| `cancelled` \| `refund_initiated` \| `refunded` | **yes** | Operational status, driven by real fulfilment and gateway events — never by elapsed time. Sixteen values; `trackingStage` projects them onto the five the customer UI shows. |
| `currentStage` | `placed` \| `packed` \| `shipped` \| `out_for_delivery` \| `delivered` \| null | **yes** | The stage the parcel is at now. Null when the order was cancelled, refunded or returned. |
| `statusNote` | string \| null | **yes** | Set when the order left the happy path — failed delivery, RTO, cancelled, refunded. |
| `stages` | array<object> | **yes** | The five stages in order, each with a real timestamp or null. Nothing is inferred from a clock. |
| `placedAt` | string | **yes** | ISO-8601 timestamp the order was placed. |
| `estimatedDeliveryDate` | string \| null | **yes** | `YYYY-MM-DD` requested/promised date, or null. |
| `deliveredAt` | string \| null | **yes** | ISO-8601 delivery timestamp, or null. |
| `itemCount` | integer | **yes** | Total units in the order. <br><sub>min -9007199254740991, max 9007199254740991</sub> |

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
| `id` | string | **yes** | Page id. Prefer `slug` for URLs. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `slug` | string | **yes** | URL slug. |
| `kind` | `occasion` \| `policy` \| `landing` \| `about` \| `static` | **yes** | Page discriminator. Occasion landing pages and policy pages are the same shape — `kind` is what tells them apart. |
| `title` | string | **yes** | Page title, used in navigation. |
| `heading` | string \| null | **yes** | Page H1 when it differs from the title. |
| `heroImage` | object \| null | **yes** | Hero image, or null. |
| `collectionHandle` | string \| null | **yes** | Collection this page fronts — set on `kind=occasion` pages, null otherwise. |
| `publishedAt` | string \| null | **yes** | ISO-8601 publish timestamp. |
| `body` | array<object> | **yes** | Ordered rich-text blocks, rendered in sequence. Each block is an object with a `type` discriminator and type-specific fields; unknown types must be skipped, not thrown on. |
| `seo` | object \| null | **yes** | SEO overrides for this page, or null to fall back to defaults. |

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
| `id` | string | **yes** | Page id. Prefer `slug` for URLs. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `slug` | string | **yes** | URL slug. |
| `kind` | `occasion` \| `policy` \| `landing` \| `about` \| `static` | **yes** | Page discriminator. Occasion landing pages and policy pages are the same shape — `kind` is what tells them apart. |
| `title` | string | **yes** | Page title, used in navigation. |
| `heading` | string \| null | **yes** | Page H1 when it differs from the title. |
| `heroImage` | object \| null | **yes** | Hero image, or null. |
| `collectionHandle` | string \| null | **yes** | Collection this page fronts — set on `kind=occasion` pages, null otherwise. |
| `publishedAt` | string \| null | **yes** | ISO-8601 publish timestamp. |
| `body` | array<object> | **yes** | Ordered rich-text blocks, rendered in sequence. Each block is an object with a `type` discriminator and type-specific fields; unknown types must be skipped, not thrown on. |
| `seo` | object \| null | **yes** | SEO overrides for this page, or null to fall back to defaults. |

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
| `gateway` | `"razorpay"` | **yes** | Gateway that owns this session. |
| `keyId` | string | **yes** | Razorpay public key id to hand to Checkout.js. Never the secret. |
| `razorpayOrderId` | string | **yes** | `order_XXXXXXXX` — created server-side. The client never creates one. |
| `amountPaise` | integer | **yes** | Amount to collect, in paise. Equals `order.totalPaise`. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `currency` | string | **yes** | ISO-4217 currency code. |

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
| `orderId` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `orderNo` | string | **yes** | Human-facing order number, e.g. `ACH100042`. |
| `status` | string | **yes** | Operational order status after the payment was applied. |
| `paymentStatus` | string | **yes** | `paid` once the captured amount covers the total; `pending` on a part payment. |
| `amountPaidPaise` | integer | **yes** | Total captured against this order so far, in integer paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `totalPaise` | integer | **yes** | Order total in integer paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `gatewayPaymentId` | string | **yes** | `pay_XXXXXXXX` — the capture this call applied. |

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
| `id` | string | **yes** | Product id. Stable; prefer `handle` for URLs. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `handle` | string | **yes** | URL slug, e.g. `bamboo-water-bottle`. Routes `/products/:handle`. |
| `sku` | string \| null | **yes** | SKU of the default variant. SKUs live on variants, not products. |
| `title` | string | **yes** | Product name. |
| `subtitle` | string \| null | **yes** | Short merchandising line under the title. |
| `kind` | `hamper` \| `single_gift` \| `personalised` \| `gourmet` \| `add_on` \| `builder` | **yes** | Fulfilment class — does it need assembly, personalisation, is it an add-on. |
| `designer` | object \| null | **yes** | Attributed designer/brand, or null. |
| `type` | string \| null | **yes** | Merchandising category handle (the collection of `kind=category` this product leads with), e.g. `drinkware`. This is the storefront `type` facet; it is NOT `kind`. |
| `typeLabel` | string \| null | **yes** | Human label for `type`, e.g. `Drinkware`. |
| `pricePaise` | integer | **yes** | Lowest active variant price, GST-inclusive, in integer paise. 149900 = ₹1,499.00. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `compareAtPaise` | integer \| null | **yes** | Struck-through was-price in integer paise, or null when not on offer. |
| `image` | object \| null | **yes** | Primary product image, or null when none is attached. |
| `collectionHandles` | array<string> | **yes** | Every live collection this product belongs to, any kind. |
| `occasionHandles` | array<string> | **yes** | Subset of `collectionHandles` of kind `occasion` or `festival`. |
| `recipientHandles` | array<string> | **yes** | Subset of `collectionHandles` of kind `recipient`. |
| `stock` | `in` \| `low` \| `out` | **yes** | Presentation of live availability, never stored: `out` when available quantity is 0, `low` when it is at or below the product low-stock threshold, otherwise `in`. |
| `stockQty` | integer | **yes** | Available units summed across warehouses (on-hand minus reserved). <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `sameDay` | boolean | **yes** | True when stock sits in at least one same-day-capable warehouse. Destination still decides — confirm with `GET /v1/serviceability`. |
| `bestSeller` | boolean | **yes** | Membership of the `best-sellers` collection, unless `badgeOverride` forces it either way. |
| `isNew` | boolean | **yes** | Published within the last 30 days, unless `badgeOverride` forces it either way. |
| `personalisable` | boolean | **yes** | Accepts engraving/printing. See `personalisationTemplates` on the detail. |
| `tags` | array<string> | **yes** | Free-form merchandising tags, e.g. `fragile`, `gift-ready`. |
| `ratingAvg` | number \| null | **yes** | Mean published review rating 1.0–5.0, or null when unreviewed. |
| `reviewCount` | integer | **yes** | Count of published reviews. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `publishedAt` | string \| null | **yes** | ISO-8601 publish timestamp. |
| `description` | string \| null | **yes** | Long-form description. Plain text. |
| `isPerishable` | boolean | **yes** | Perishable goods carry shorter delivery promises. |
| `isFragile` | boolean | **yes** | Drives packaging selection and courier choice. |
| `images` | array<object> | **yes** | Full gallery in display order. `image` is the first of these. |
| `contents` | array<string> | **yes** | The "what is inside" bullets, in order. |
| `variants` | array<object> | **yes** | Every active variant. Always at least one. |
| `addOns` | array<object> | **yes** | Add-ons offered on this product. Falls back to the global default set when none are pinned. |
| `personalisationTemplates` | array<object> | **yes** | Personalisation methods available. Empty when `personalisable` is false. |
| `relatedHandles` | array<string> | **yes** | Handles of products sharing the most collections with this one, best first. |
| `seo` | object \| null | **yes** | SEO overrides for this PDP, or null to fall back to defaults. |

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
| `metaTitle` | string \| null | **yes** | `<title>` override. Falls back to the resource title. |
| `metaDescription` | string \| null | **yes** | `<meta name="description">` content. |
| `canonicalUrl` | string \| null | **yes** | Canonical URL when this page duplicates another. |
| `focusKeyword` | string \| null | **yes** | Primary keyword the page targets. |
| `robotsIndex` | boolean | **yes** | False emits `noindex`. |
| `robotsFollow` | boolean | **yes** | False emits `nofollow`. |
| `ogImageUrl` | string \| null | **yes** | Open Graph image URL. |
| `structuredData` | object \| null | **yes** | JSON-LD document to embed verbatim, or null. |
| `entityType` | `product` \| `collection` \| `content_page` \| `blog_post` \| `route` | **yes** | What this record describes. |
| `entityId` | string \| null | **yes** | Target entity id, or null for a route record. |
| `routePath` | string \| null | **yes** | Target route, or null for an entity record. |

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
| `didYouMean` | string \| null | **yes** | The query rewritten against catalogue vocabulary, or null when nothing was corrected. Render it as "Did you mean X?" — never search it silently. |
| `unfilteredCount` | integer | **yes** | Matches for the query with every category and price filter dropped. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `types` | array<object> | **yes** | Categories that do contain matches for the query, busiest first. |
| `priceRanges` | array<object> | **yes** | Price windows that do contain matches, empty ones removed. |
| `fallback` | array<object> | **yes** | Popular gifts to show when the query matches nothing at all. |

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
| `status` | `"ok"` | **yes** |  |
| `version` | string | **yes** |  |
| `uptimeSeconds` | number | **yes** |  |

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
| `received` | `true` | **yes** | Always true. A 2xx is the only thing Razorpay reads. |
| `duplicate` | boolean | **yes** | True when this event id had already been processed, so the delivery changed nothing. |

</details>

---


---

# Admin surface

**113 operations** · Swagger UI at `/docs/admin` (gated — requires a staff token with `settings:view`)

| Group | Operations |
|---|---|
| Admin auth | 13 |
| Admin catalogue | 28 |
| Admin content | 21 |
| Admin customers | 7 |
| Admin inventory | 14 |
| Admin orders | 10 |
| Admin promotions | 14 |
| Admin resources | 1 |
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
| `recoveryCodes` | array<string> | **yes** | Ten single-use codes. Shown ONCE — only sha256 digests are stored server-side. |
| `tokens` | object \| null | **yes** | A session, when enrolment completed a sign-in. |

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
| `recoveryCodes` | array<string> | **yes** | Ten single-use codes. Shown ONCE — only sha256 digests are stored server-side. |

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
| `secret` | string | **yes** | Base32 shared secret. Shown once, for manual entry. |
| `otpauthUri` | string | **yes** | `otpauth://totp/...` — render this as the QR code. |

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
| `status` | `authenticated` \| `mfa_required` \| `enrolment_required` | **yes** | `authenticated` → tokens are present. `mfa_required` → route to /two-factor. `enrolment_required` → the role can change data and has no second factor; route to /two-factor in enrolment mode. No session exists until 2FA is satisfied. |
| `challengeToken` | string \| null | **yes** | Five-minute token that identifies the half-finished sign-in. Null once authenticated. |
| `tokens` | object \| null | **yes** | Present only when `status` is `authenticated`. |

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
| `status` | `authenticated` \| `mfa_required` \| `enrolment_required` | **yes** | `authenticated` → tokens are present. `mfa_required` → route to /two-factor. `enrolment_required` → the role can change data and has no second factor; route to /two-factor in enrolment mode. No session exists until 2FA is satisfied. |
| `challengeToken` | string \| null | **yes** | Five-minute token that identifies the half-finished sign-in. Null once authenticated. |
| `tokens` | object \| null | **yes** | Present only when `status` is `authenticated`. |

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
| `ok` | `true` | **yes** | Always true. The response is deliberately uninformative. |

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
| `ok` | `true` | **yes** | Always true. The response is deliberately uninformative. |

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
| `accessToken` | string | **yes** | Bearer token for `Authorization`. Ten minutes — the console refreshes silently. |
| `expiresInSeconds` | integer | **yes** | Access-token lifetime in seconds. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `sessionId` | string | **yes** | The session this token belongs to. Revoking it kills the lineage. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |

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
| `expiresInSeconds` | integer | **yes** | How long the window lasts, in seconds. <br><sub>min -9007199254740991, max 9007199254740991</sub> |

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
| `id` | string | **yes** | Staff user id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `email` | string | **yes** | Work email. |
| `fullName` | string | **yes** | Display name. |
| `avatarInitials` | string \| null | **yes** | Generated in the database from the full name. |
| `role` | object | **yes** |  |
| `permissions` | array<string> | **yes** | `module:action` grants, e.g. `orders:refund`. The console mirrors these for optimistic UI only. |
| `modules` | array<`dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance`> | **yes** | Modules with at least one grant — drives which nav groups render. |
| `actions` | array<`view` \| `create` \| `edit` \| `delete` \| `export` \| `approve` \| `refund` \| `cancel` \| `manage-settings`> | **yes** | The nine action keys, for reference. |
| `warehouseIds` | array<string> | **yes** | Warehouse scope. An EMPTY array means every warehouse, matching the schema. |
| `mfaEnabled` | boolean | **yes** | True when an authenticator is enrolled. |
| `mfaRequired` | boolean | **yes** | True when this role is write-capable and therefore must carry 2FA. |
| `stepUpActive` | boolean | **yes** | True while a recent re-auth still satisfies refund step-up. |
| `sessionId` | string | **yes** | The current session id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `lastActiveAt` | string \| null | **yes** | ISO-8601 timestamp of the last authenticated request. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

</details>

---


## Admin inventory

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `id` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `orderNo` | string | **yes** | `ACH100042`. |
| `status` | `pending_payment` \| `paid` \| `confirmed` \| `in_production` \| `personalisation_pending` \| `quality_check` \| `packed` \| `ready_to_ship` \| `shipped` \| `out_for_delivery` \| `delivered` \| `failed_delivery` \| `rto` \| `cancelled` \| `refund_initiated` \| `refunded` | **yes** | The sixteen-value operational status. Driven by real events, never by elapsed time. |
| `paymentStatus` | `pending` \| `paid` \| `failed` \| `partially_refunded` \| `refunded` \| `cod_due` | **yes** | Tracked independently of `status`. |
| `fulfilmentStatus` | string | **yes** | `unfulfilled`, `partially_fulfilled`, `fulfilled`, `returned`. |
| `channel` | `website` \| `mobile_app` \| `whatsapp` \| `corporate_portal` \| `phone` \| `admin` | **yes** | Where it came from. |
| `priority` | `standard` \| `high` \| `vip` | **yes** | `standard`, `high`, `vip`. |
| `deliveryType` | `standard` \| `scheduled` \| `same_day` \| `midnight` \| `international` | **yes** | A routing property, not a lifecycle stage. |
| `buyerName` | string | **yes** | Buyer, frozen at order time. |
| `buyerMobile` | string \| null | **yes** | Buyer mobile. |
| `recipientName` | string \| null | **yes** | Gift recipient, when different. |
| `shipCity` | string | **yes** | Destination city. |
| `shipPincode` | string | **yes** | Destination PIN code. |
| `totalPaise` | integer | **yes** | Order total in integer paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `amountPaidPaise` | integer | **yes** | Captured so far, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `amountRefundedPaise` | integer | **yes** | Refunded so far, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `itemCount` | integer | **yes** | Total units. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `lineCount` | integer | **yes** | Distinct lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `awb` | string \| null | **yes** | Most recent air waybill, or null. |
| `courierName` | string \| null | **yes** | Most recent courier, or null. |
| `warehouseId` | string \| null | **yes** | Fulfilment warehouse. |
| `corporateAccountId` | string \| null | **yes** | Corporate account, when this is a B2B order. |
| `tags` | array<string> | **yes** | `gift-message`, `personalised`, `fragile`, `high-value`, `corporate`. |
| `placedAt` | string | **yes** | ISO-8601. |
| `requestedDeliveryDate` | string \| null | **yes** | `YYYY-MM-DD`, or null. |
| `deliverySlot` | string \| null | **yes** | Requested slot, or null. |
| `currency` | string | **yes** | ISO-4217. |
| `buyerEmail` | string \| null | **yes** | Buyer email. |
| `recipientMobile` | string \| null | **yes** | Recipient mobile. |
| `isAnonymousGift` | boolean | **yes** | True when the recipient is not told who sent it. |
| `giftMessage` | string \| null | **yes** | Gift card message. |
| `shippingAddress` | object | **yes** | Frozen snapshot. An order is a legal record; its address does not mutate. |
| `billing` | object | **yes** | Billing snapshot. |
| `tax` | object | **yes** | Tax determination, frozen — the state codes are themselves snapshots. |
| `money` | object | **yes** | Every figure in integer paise. |
| `couponCode` | string \| null | **yes** | Coupon applied at order time. |
| `internalNotes` | string \| null | **yes** | Accumulated internal notes. Never shown to the customer. |
| `cancelReason` | string \| null | **yes** | Why it was cancelled. |
| `cancelledAt` | string \| null | **yes** | ISO-8601, or null. |
| `confirmedAt` | string \| null | **yes** | ISO-8601, or null. |
| `shippedAt` | string \| null | **yes** | ISO-8601, or null. |
| `deliveredAt` | string \| null | **yes** | ISO-8601, or null. |
| `lines` | array<object> | **yes** | Order lines in display order. |
| `timeline` | array<object> | **yes** | Append-only, server-generated, oldest first. |
| `payments` | array<object> | **yes** | Every attempt, not only the successful one. |
| `refunds` | array<object> | **yes** | Refund ledger for this order. |
| `shipments` | array<object> | **yes** | A multi-warehouse gift order legitimately has several. |
| `invoices` | array<object> | **yes** | At most one issued invoice per order. |
| `availableTransitions` | array<object> | **yes** | Every legal edge from the current status, each flagged with whether YOUR role may take it. |

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
| `id` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `orderNo` | string | **yes** | `ACH100042`. |
| `status` | `pending_payment` \| `paid` \| `confirmed` \| `in_production` \| `personalisation_pending` \| `quality_check` \| `packed` \| `ready_to_ship` \| `shipped` \| `out_for_delivery` \| `delivered` \| `failed_delivery` \| `rto` \| `cancelled` \| `refund_initiated` \| `refunded` | **yes** | The sixteen-value operational status. Driven by real events, never by elapsed time. |
| `paymentStatus` | `pending` \| `paid` \| `failed` \| `partially_refunded` \| `refunded` \| `cod_due` | **yes** | Tracked independently of `status`. |
| `fulfilmentStatus` | string | **yes** | `unfulfilled`, `partially_fulfilled`, `fulfilled`, `returned`. |
| `channel` | `website` \| `mobile_app` \| `whatsapp` \| `corporate_portal` \| `phone` \| `admin` | **yes** | Where it came from. |
| `priority` | `standard` \| `high` \| `vip` | **yes** | `standard`, `high`, `vip`. |
| `deliveryType` | `standard` \| `scheduled` \| `same_day` \| `midnight` \| `international` | **yes** | A routing property, not a lifecycle stage. |
| `buyerName` | string | **yes** | Buyer, frozen at order time. |
| `buyerMobile` | string \| null | **yes** | Buyer mobile. |
| `recipientName` | string \| null | **yes** | Gift recipient, when different. |
| `shipCity` | string | **yes** | Destination city. |
| `shipPincode` | string | **yes** | Destination PIN code. |
| `totalPaise` | integer | **yes** | Order total in integer paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `amountPaidPaise` | integer | **yes** | Captured so far, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `amountRefundedPaise` | integer | **yes** | Refunded so far, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `itemCount` | integer | **yes** | Total units. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `lineCount` | integer | **yes** | Distinct lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `awb` | string \| null | **yes** | Most recent air waybill, or null. |
| `courierName` | string \| null | **yes** | Most recent courier, or null. |
| `warehouseId` | string \| null | **yes** | Fulfilment warehouse. |
| `corporateAccountId` | string \| null | **yes** | Corporate account, when this is a B2B order. |
| `tags` | array<string> | **yes** | `gift-message`, `personalised`, `fragile`, `high-value`, `corporate`. |
| `placedAt` | string | **yes** | ISO-8601. |
| `requestedDeliveryDate` | string \| null | **yes** | `YYYY-MM-DD`, or null. |
| `deliverySlot` | string \| null | **yes** | Requested slot, or null. |
| `currency` | string | **yes** | ISO-4217. |
| `buyerEmail` | string \| null | **yes** | Buyer email. |
| `recipientMobile` | string \| null | **yes** | Recipient mobile. |
| `isAnonymousGift` | boolean | **yes** | True when the recipient is not told who sent it. |
| `giftMessage` | string \| null | **yes** | Gift card message. |
| `shippingAddress` | object | **yes** | Frozen snapshot. An order is a legal record; its address does not mutate. |
| `billing` | object | **yes** | Billing snapshot. |
| `tax` | object | **yes** | Tax determination, frozen — the state codes are themselves snapshots. |
| `money` | object | **yes** | Every figure in integer paise. |
| `couponCode` | string \| null | **yes** | Coupon applied at order time. |
| `internalNotes` | string \| null | **yes** | Accumulated internal notes. Never shown to the customer. |
| `cancelReason` | string \| null | **yes** | Why it was cancelled. |
| `cancelledAt` | string \| null | **yes** | ISO-8601, or null. |
| `confirmedAt` | string \| null | **yes** | ISO-8601, or null. |
| `shippedAt` | string \| null | **yes** | ISO-8601, or null. |
| `deliveredAt` | string \| null | **yes** | ISO-8601, or null. |
| `lines` | array<object> | **yes** | Order lines in display order. |
| `timeline` | array<object> | **yes** | Append-only, server-generated, oldest first. |
| `payments` | array<object> | **yes** | Every attempt, not only the successful one. |
| `refunds` | array<object> | **yes** | Refund ledger for this order. |
| `shipments` | array<object> | **yes** | A multi-warehouse gift order legitimately has several. |
| `invoices` | array<object> | **yes** | At most one issued invoice per order. |
| `availableTransitions` | array<object> | **yes** | Every legal edge from the current status, each flagged with whether YOUR role may take it. |

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
| `shipmentId` | string | **yes** | Shipment id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `shipmentNo` | string | **yes** | Internal shipment number. |

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
| `id` | string | **yes** | Invoice id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `invoiceNo` | string | **yes** | Statutory number, at most 16 characters (Rule 46(b)). |
| `alreadyIssued` | boolean | **yes** | True when this order already had an issued invoice. |

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
| `note` | string | **yes** | The note text. |

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
| `refundId` | string | **yes** | Refund row id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `refundNo` | string | **yes** | Human-facing refund number. |
| `status` | string | **yes** | `initiated`, `processing` or `failed`. Only a gateway webhook makes it `completed`. |
| `gatewayRefundId` | string \| null | **yes** | The gateway’s id, when it accepted the request. |
| `amountPaise` | integer | **yes** | Amount refunded, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |

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
| `id` | string | **yes** | Order id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `orderNo` | string | **yes** | `ACH100042`. |
| `status` | `pending_payment` \| `paid` \| `confirmed` \| `in_production` \| `personalisation_pending` \| `quality_check` \| `packed` \| `ready_to_ship` \| `shipped` \| `out_for_delivery` \| `delivered` \| `failed_delivery` \| `rto` \| `cancelled` \| `refund_initiated` \| `refunded` | **yes** | The sixteen-value operational status. Driven by real events, never by elapsed time. |
| `paymentStatus` | `pending` \| `paid` \| `failed` \| `partially_refunded` \| `refunded` \| `cod_due` | **yes** | Tracked independently of `status`. |
| `fulfilmentStatus` | string | **yes** | `unfulfilled`, `partially_fulfilled`, `fulfilled`, `returned`. |
| `channel` | `website` \| `mobile_app` \| `whatsapp` \| `corporate_portal` \| `phone` \| `admin` | **yes** | Where it came from. |
| `priority` | `standard` \| `high` \| `vip` | **yes** | `standard`, `high`, `vip`. |
| `deliveryType` | `standard` \| `scheduled` \| `same_day` \| `midnight` \| `international` | **yes** | A routing property, not a lifecycle stage. |
| `buyerName` | string | **yes** | Buyer, frozen at order time. |
| `buyerMobile` | string \| null | **yes** | Buyer mobile. |
| `recipientName` | string \| null | **yes** | Gift recipient, when different. |
| `shipCity` | string | **yes** | Destination city. |
| `shipPincode` | string | **yes** | Destination PIN code. |
| `totalPaise` | integer | **yes** | Order total in integer paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `amountPaidPaise` | integer | **yes** | Captured so far, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `amountRefundedPaise` | integer | **yes** | Refunded so far, in paise. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `itemCount` | integer | **yes** | Total units. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `lineCount` | integer | **yes** | Distinct lines. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `awb` | string \| null | **yes** | Most recent air waybill, or null. |
| `courierName` | string \| null | **yes** | Most recent courier, or null. |
| `warehouseId` | string \| null | **yes** | Fulfilment warehouse. |
| `corporateAccountId` | string \| null | **yes** | Corporate account, when this is a B2B order. |
| `tags` | array<string> | **yes** | `gift-message`, `personalised`, `fragile`, `high-value`, `corporate`. |
| `placedAt` | string | **yes** | ISO-8601. |
| `requestedDeliveryDate` | string \| null | **yes** | `YYYY-MM-DD`, or null. |
| `deliverySlot` | string \| null | **yes** | Requested slot, or null. |
| `currency` | string | **yes** | ISO-4217. |
| `buyerEmail` | string \| null | **yes** | Buyer email. |
| `recipientMobile` | string \| null | **yes** | Recipient mobile. |
| `isAnonymousGift` | boolean | **yes** | True when the recipient is not told who sent it. |
| `giftMessage` | string \| null | **yes** | Gift card message. |
| `shippingAddress` | object | **yes** | Frozen snapshot. An order is a legal record; its address does not mutate. |
| `billing` | object | **yes** | Billing snapshot. |
| `tax` | object | **yes** | Tax determination, frozen — the state codes are themselves snapshots. |
| `money` | object | **yes** | Every figure in integer paise. |
| `couponCode` | string \| null | **yes** | Coupon applied at order time. |
| `internalNotes` | string \| null | **yes** | Accumulated internal notes. Never shown to the customer. |
| `cancelReason` | string \| null | **yes** | Why it was cancelled. |
| `cancelledAt` | string \| null | **yes** | ISO-8601, or null. |
| `confirmedAt` | string \| null | **yes** | ISO-8601, or null. |
| `shippedAt` | string \| null | **yes** | ISO-8601, or null. |
| `deliveredAt` | string \| null | **yes** | ISO-8601, or null. |
| `lines` | array<object> | **yes** | Order lines in display order. |
| `timeline` | array<object> | **yes** | Append-only, server-generated, oldest first. |
| `payments` | array<object> | **yes** | Every attempt, not only the successful one. |
| `refunds` | array<object> | **yes** | Refund ledger for this order. |
| `shipments` | array<object> | **yes** | A multi-warehouse gift order legitimately has several. |
| `invoices` | array<object> | **yes** | At most one issued invoice per order. |
| `availableTransitions` | array<object> | **yes** | Every legal edge from the current status, each flagged with whether YOUR role may take it. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Order ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `succeeded` | array<string> | **yes** | Orders that changed. |
| `failed` | array<object> | **yes** | Per-order, not all-or-nothing. Fifty orders selected on a busy desk will include a few that moved since the page loaded, and failing the batch for those would be useless. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `action` | string | **yes** | The action that ran. |
| `requested` | integer | **yes** | Ids sent. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `matched` | integer | **yes** | Ids that exist and are not already archived. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `updated` | integer | **yes** | Rows actually changed, from the single UPDATE statement. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `skipped` | array<string> | **yes** | Ids that matched nothing. Not an error — rows move. |

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
| `slug` | string | **yes** | URL segment and registry key. |
| `title` | string | **yes** | Screen title. |
| `description` | string | **yes** | What the resource is. |
| `group` | string | **yes** | Nav group. |
| `module` | `dashboard` \| `orders` \| `catalogue` \| `inventory` \| `customers` \| `corporate` \| `delivery` \| `promotions` \| `content` \| `reports` \| `settings` \| `finance` | **yes** | The RBAC module gating every route for this resource. |
| `permissions` | object | **yes** | operation → the action required, e.g. `{ "delete": "delete" }`. |
| `columns` | array<string> | **yes** | Every selectable field. The `?fields=` allowlist. |
| `listColumns` | array<string> | **yes** | Default table projection. |
| `fields` | array<object> | **yes** | The editable spec. This is what the create/edit form renders. |
| `searchable` | array<string> | **yes** | Fields `?q=` ORs across. |
| `sortable` | array<string> | **yes** | Fields `?sort=` accepts. |
| `defaultSort` | object | **yes** | Applied when `sort` is absent. |
| `defaultPerPage` | integer | **yes** | Suggested page size. Hard-capped at 100. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `filters` | array<object> | **yes** | Every filterable key, with its permitted operators. |
| `bulkActions` | array<object> | **yes** | Declared bulk actions. The server re-checks `requires` — hiding the button is not the control. |
| `deleteBehaviour` | `soft` \| `archived` \| `hard` | **yes** | `soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row. |

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
| `modules` | array<object> | **yes** | The twelve modules, in matrix order. |
| `actions` | array<object> | **yes** | The nine actions, in matrix order. |

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
| `roles` | array<string> | **yes** | Role keys, in the order the matrix declares them. |
| `matrix` | object | **yes** | roleKey → module → actions, read from `role_permissions` — the DATABASE copy, not the compiled-in matrix. If an operator has revoked a grant by hand this shows the revoked state, which is the point of having the copy. |
| `drift` | array<object> | **yes** | Where the database and the source matrix disagree. Empty is the healthy state. |

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
| `id` | string | **yes** | Role id. <br><sub>uuid, pattern `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-`</sub> |
| `key` | string | **yes** | Stable machine key, e.g. `operations_manager`. Matches `^[a-z0-9_]+$`. |
| `name` | string | **yes** | Display name, e.g. `Operations Manager`. |
| `description` | string \| null | **yes** | What the role is for. |
| `isSystem` | boolean | **yes** | True for the eleven roles the matrix owns. They cannot be deleted. |
| `staffCount` | integer | **yes** | Live staff members holding this role. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `grantCount` | integer | **yes** | Number of `module:action` grants. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `permissions` | array<string> | **yes** | Flat `module:action` grants — the exact strings the staff JWT carries. |
| `grants` | object | **yes** | The same grants pivoted by module, which is the shape the matrix screen renders. |
| `members` | array<object> | **yes** | Staff members currently holding this role. |

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
| `rolesUpserted` | integer | **yes** | Roles inserted or refreshed. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `permissionsGranted` | integer | **yes** | Grants added. <br><sub>min -9007199254740991, max 9007199254740991</sub> |
| `permissionsRevoked` | integer | **yes** | Grants removed because the matrix no longer has them. <br><sub>min -9007199254740991, max 9007199254740991</sub> |

</details>

---
