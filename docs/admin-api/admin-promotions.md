# Admin promotions

14 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/coupons`](#get-v1-admin-coupons) — List coupons
- [`GET /v1/admin/coupons/schema`](#get-v1-admin-coupons-schema) — Field spec for coupons
- [`POST /v1/admin/coupons/bulk`](#post-v1-admin-coupons-bulk) — Bulk action on coupons
- [`POST /v1/admin/coupons`](#post-v1-admin-coupons) — Create a coupon
- [`GET /v1/admin/coupons/:id`](#get-v1-admin-coupons-id) — Get one coupon
- [`PATCH /v1/admin/coupons/:id`](#patch-v1-admin-coupons-id) — Update a coupon
- [`DELETE /v1/admin/coupons/:id`](#delete-v1-admin-coupons-id) — Archive a coupon
- [`GET /v1/admin/gift-cards`](#get-v1-admin-gift-cards) — List gift cards
- [`GET /v1/admin/gift-cards/schema`](#get-v1-admin-gift-cards-schema) — Field spec for gift cards
- [`POST /v1/admin/gift-cards/bulk`](#post-v1-admin-gift-cards-bulk) — Bulk action on gift cards
- [`POST /v1/admin/gift-cards`](#post-v1-admin-gift-cards) — Create a giftcard
- [`GET /v1/admin/gift-cards/:id`](#get-v1-admin-gift-cards-id) — Get one giftcard
- [`PATCH /v1/admin/gift-cards/:id`](#patch-v1-admin-gift-cards-id) — Update a giftcard
- [`DELETE /v1/admin/gift-cards/:id`](#delete-v1-admin-gift-cards-id) — Archive a giftcard

---

### `GET /v1/admin/coupons`

**List coupons**

| | |
|---|---|
| operationId | `adminListCoupons` |
| Auth | Bearer staff token |
| Permission | `promotions:view` |

Discount codes. `discountType` decides which value column is required — the database refuses a percent coupon with no basis points, which the console mock could represent and did.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `dir` | `"asc" \| "desc"` | no | — | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | `string` | no | max 600 | Comma-separated projection, validated against the resource’s column allowlist. |
| `withFilterOptions` | `"true" \| "false"` | no | — | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

Example: `/v1/admin/coupons?page=…&perPage=…`

**Response `200`** — A page of rows, with `meta` and the filter option lists.

```json
{
  "type": "success",
  "result": [
    {}
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
| `400` | An unknown filter key, operator, sort field or projection field. |

---

### `GET /v1/admin/coupons/schema`

**Field spec for coupons**

| | |
|---|---|
| operationId | `adminGetCouponSchema` |
| Auth | Bearer staff token |
| Permission | `promotions:view` |

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

**Response `200`** — The descriptor.

```json
{
  "type": "success",
  "result": {
    "slug": "brass-diya-set",
    "title": "Brass Diya Set",
    "description": "Free-text description.",
    "group": "inventory",
    "module": "dashboard",
    "permissions": {},
    "columns": [
      "string"
    ],
    "listColumns": [
      "string"
    ],
    "fields": [
      {
        "key": "inventory",
        "label": "In progress",
        "kind": "text",
        "required": false,
        "readOnly": false,
        "options": [
          "string"
        ],
        "reference": {
          "resource": "products",
          "labelField": "sku"
        },
        "unit": "piece",
        "help": "Shown beneath the field in the console.",
        "of": null,
        "fields": [
          null
        ]
      }
    ],
    "searchable": [
      "string"
    ],
    "sortable": [
      "string"
    ],
    "defaultSort": {
      "field": "sku",
      "direction": "asc"
    },
    "defaultPerPage": 25,
    "filters": [
      {
        "key": "inventory",
        "label": "In progress",
        "valueKind": "string",
        "operators": [
          "eq"
        ],
        "options": [
          "string"
        ]
      }
    ],
    "bulkActions": [
      {
        "action": "approve",
        "label": "In progress",
        "requires": "view",
        "destructive": false,
        "description": "Free-text description."
      }
    ],
    "deleteBehaviour": "soft"
  }
}
```

---

### `POST /v1/admin/coupons/bulk`

**Bulk action on coupons**

| | |
|---|---|
| operationId | `adminBulkCoupons` |
| Auth | Bearer staff token |
| Permission | `promotions:edit` |

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `action` | `string` | **yes** | min 1, max 64 | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. |
| `ids` | `uuid[]` | **yes** | min 1 items, max 100 items | Row ids. At most 100 — the same ceiling as a page. |

Example request:

```json
{
  "action": "approve",
  "ids": [
    "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
  ]
}
```

**Response `200`** — What was matched and changed.

```json
{
  "type": "success",
  "result": {
    "action": "approve",
    "requested": 1,
    "matched": 1,
    "updated": 1,
    "skipped": [
      "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e"
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | No such bulk action on this resource. |
| `403` | The action needs an RBAC action your role does not have. |

---

### `POST /v1/admin/coupons`

**Create a coupon**

| | |
|---|---|
| operationId | `adminCreateCoupon` |
| Auth | Bearer staff token |
| Permission | `promotions:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `code` | `string` | **yes** | max 32 | Code. Upper case, 3-32 characters, `A-Z 0-9 _ -` only. |
| `description` | `string` | no | max 20000 | Description. |
| `discountType` | `"percent" \| "flat" \| "free_shipping" \| "bogo" \| "free_gift"` | **yes** | — | Type. |
| `discountBp` | `integer` | no | ≥ 0, ≤ 10000 | Percent off. Required for `percent`. Basis points — 250 is 2.5%. |
| `discountPaise` | `integer` | no | ≥ 0 | Flat discount. Required for `flat`. Integer paise — 149900 is ₹1,499.00. |
| `maxDiscountPaise` | `integer` | no | ≥ 0 | Cap. Caps a percent coupon. Integer paise — 149900 is ₹1,499.00. |
| `minOrderPaise` | `integer` | no | ≥ 0 | Minimum order. Integer paise — 149900 is ₹1,499.00. |
| `appliesTo` | `"all" \| "collections" \| "products" \| "first_order"` | no | — | Applies to. |
| `channels` | `string[]` | no | max 50 items | Channels. Empty means every channel. |
| `maxRedemptions` | `integer` | no | ≥ 1, ≤ 10000000 | Global limit. |
| `maxRedemptionsPerCustomer` | `integer` | no | ≥ 1, ≤ 1000 | Per-customer limit. |
| `stackable` | `any` | no | — | Stackable. |
| `startsAt` | `string` | no | — | Starts. |
| `endsAt` | `string` | no | — | Ends. |
| `status` | `"active" \| "scheduled" \| "expired" \| "paused" \| "draft"` | **yes** | — | Status. |

Example request:

```json
{
  "code": "DIWALI20",
  "description": "Free-text description.",
  "discountType": "percent",
  "discountBp": 1000,
  "discountPaise": 149900,
  "maxDiscountPaise": 149900,
  "minOrderPaise": 149900,
  "appliesTo": "all",
  "channels": [
    "string"
  ],
  "maxRedemptions": 1,
  "maxRedemptionsPerCustomer": 1,
  "stackable": null,
  "startsAt": "2026-08-25T10:30:00.000Z",
  "endsAt": "2026-08-25T10:30:00.000Z",
  "status": "active"
}
```

**Response `201`** — The created row.

```json
{
  "type": "success",
  "result": {}
}
```

**Errors**

| Status | Meaning |
|---|---|
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |

---

### `GET /v1/admin/coupons/:id`

**Get one coupon**

| | |
|---|---|
| operationId | `adminGetCoupon` |
| Auth | Bearer staff token |
| Permission | `promotions:view` |

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `fields` | `string` | no | max 600 | Comma-separated projection, from the column allowlist. |

**Response `200`** — The row.

```json
{
  "type": "success",
  "result": {}
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such row, or it is archived. |

---

### `PATCH /v1/admin/coupons/:id`

**Update a coupon**

| | |
|---|---|
| operationId | `adminUpdateCoupon` |
| Auth | Bearer staff token |
| Permission | `promotions:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `code` | `string` | no | max 32 | Code. Upper case, 3-32 characters, `A-Z 0-9 _ -` only. |
| `description` | `string` | no | max 20000 | Description. |
| `discountType` | `"percent" \| "flat" \| "free_shipping" \| "bogo" \| "free_gift"` | no | — | Type. |
| `discountBp` | `integer` | no | ≥ 0, ≤ 10000 | Percent off. Required for `percent`. Basis points — 250 is 2.5%. |
| `discountPaise` | `integer` | no | ≥ 0 | Flat discount. Required for `flat`. Integer paise — 149900 is ₹1,499.00. |
| `maxDiscountPaise` | `integer` | no | ≥ 0 | Cap. Caps a percent coupon. Integer paise — 149900 is ₹1,499.00. |
| `minOrderPaise` | `integer` | no | ≥ 0 | Minimum order. Integer paise — 149900 is ₹1,499.00. |
| `appliesTo` | `"all" \| "collections" \| "products" \| "first_order"` | no | — | Applies to. |
| `channels` | `string[]` | no | max 50 items | Channels. Empty means every channel. |
| `maxRedemptions` | `integer` | no | ≥ 1, ≤ 10000000 | Global limit. |
| `maxRedemptionsPerCustomer` | `integer` | no | ≥ 1, ≤ 1000 | Per-customer limit. |
| `stackable` | `any` | no | — | Stackable. |
| `startsAt` | `string` | no | — | Starts. |
| `endsAt` | `string` | no | — | Ends. |
| `status` | `"active" \| "scheduled" \| "expired" \| "paused" \| "draft"` | no | — | Status. |

Example request:

```json
{
  "code": "DIWALI20",
  "description": "Free-text description.",
  "discountType": "percent",
  "discountBp": 1000,
  "discountPaise": 149900,
  "maxDiscountPaise": 149900,
  "minOrderPaise": 149900,
  "appliesTo": "all",
  "channels": [
    "string"
  ],
  "maxRedemptions": 1,
  "maxRedemptionsPerCustomer": 1,
  "stackable": null,
  "startsAt": "2026-08-25T10:30:00.000Z",
  "endsAt": "2026-08-25T10:30:00.000Z",
  "status": "active"
}
```

**Response `200`** — The updated row.

```json
{
  "type": "success",
  "result": {}
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |

---

### `DELETE /v1/admin/coupons/:id`

**Archive a coupon**

| | |
|---|---|
| operationId | `adminDeleteCoupon` |
| Auth | Bearer staff token |
| Permission | `promotions:delete` |

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `promotions:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body** — none. Send `{}` or omit.

**Response `204`** — Archived.

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such row, or it is already archived. |

---

### `GET /v1/admin/gift-cards`

**List gift cards**

| | |
|---|---|
| operationId | `adminListGiftCards` |
| Auth | Bearer staff token |
| Permission | `promotions:view` |

Issued cards. The code itself is never stored — only its hash and the last four characters — so there is no endpoint, here or anywhere, that can show a customer their code again.

Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched against its `filterable` entries — key AND operator. An unknown key, operator, sort field or projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse than an error. `perPage` is capped at 100 in two places. Fetch the exact vocabulary from `/schema`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored what you asked for is a list you will misread. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `dir` | `"asc" \| "desc"` | no | — | Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins. |
| `fields` | `string` | no | max 600 | Comma-separated projection, validated against the resource’s column allowlist. |
| `withFilterOptions` | `"true" \| "false"` | no | — | Return distinct values for filters that have no static option list, so the console’s dropdowns do not have to compute them from an in-memory array. One extra query per such filter — ask for it on screen mount, not on every keystroke. |

Example: `/v1/admin/gift-cards?page=…&perPage=…`

**Response `200`** — A page of rows, with `meta` and the filter option lists.

```json
{
  "type": "success",
  "result": [
    {}
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
| `400` | An unknown filter key, operator, sort field or projection field. |

---

### `GET /v1/admin/gift-cards/schema`

**Field spec for gift cards**

| | |
|---|---|
| operationId | `adminGetGiftCardSchema` |
| Auth | Bearer staff token |
| Permission | `promotions:view` |

The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, every filter with its permitted operators, the bulk actions with the RBAC action each needs, and what DELETE actually does.

`fields` is deliberately NOT `columns`. The console currently derives its edit form from `Object.keys(rows[0])` and marks the first two fields required — so a null in the first row makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and references name the resource to fetch a picker from.

**Response `200`** — The descriptor.

```json
{
  "type": "success",
  "result": {
    "slug": "brass-diya-set",
    "title": "Brass Diya Set",
    "description": "Free-text description.",
    "group": "inventory",
    "module": "dashboard",
    "permissions": {},
    "columns": [
      "string"
    ],
    "listColumns": [
      "string"
    ],
    "fields": [
      {
        "key": "inventory",
        "label": "In progress",
        "kind": "text",
        "required": false,
        "readOnly": false,
        "options": [
          "string"
        ],
        "reference": {
          "resource": "products",
          "labelField": "sku"
        },
        "unit": "piece",
        "help": "Shown beneath the field in the console.",
        "of": null,
        "fields": [
          null
        ]
      }
    ],
    "searchable": [
      "string"
    ],
    "sortable": [
      "string"
    ],
    "defaultSort": {
      "field": "sku",
      "direction": "asc"
    },
    "defaultPerPage": 25,
    "filters": [
      {
        "key": "inventory",
        "label": "In progress",
        "valueKind": "string",
        "operators": [
          "eq"
        ],
        "options": [
          "string"
        ]
      }
    ],
    "bulkActions": [
      {
        "action": "approve",
        "label": "In progress",
        "requires": "view",
        "destructive": false,
        "description": "Free-text description."
      }
    ],
    "deleteBehaviour": "soft"
  }
}
```

---

### `POST /v1/admin/gift-cards/bulk`

**Bulk action on gift cards**

| | |
|---|---|
| operationId | `adminBulkGiftCards` |
| Auth | Bearer staff token |
| Permission | `promotions:edit` |

Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race anything else touching those rows.

The route declares `edit`, but each action ALSO declares its own `requires`, checked against your grants before anything is written: destructive actions ask for `delete`, which most roles do not hold on most modules. Ids that no longer exist come back in `skipped` rather than failing the batch — rows move while a table is on screen.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `action` | `string` | **yes** | min 1, max 64 | One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs. |
| `ids` | `uuid[]` | **yes** | min 1 items, max 100 items | Row ids. At most 100 — the same ceiling as a page. |

Example request:

```json
{
  "action": "approve",
  "ids": [
    "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
  ]
}
```

**Response `200`** — What was matched and changed.

```json
{
  "type": "success",
  "result": {
    "action": "approve",
    "requested": 1,
    "matched": 1,
    "updated": 1,
    "skipped": [
      "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | No such bulk action on this resource. |
| `403` | The action needs an RBAC action your role does not have. |

---

### `POST /v1/admin/gift-cards`

**Create a giftcard**

| | |
|---|---|
| operationId | `adminCreateGiftCard` |
| Auth | Bearer staff token |
| Permission | `promotions:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `initialValuePaise` | `integer` | **yes** | ≥ 1 | Face value. Integer paise — 149900 is ₹1,499.00. |
| `issuedToName` | `string` | no | max 160 | Issued to. |
| `issuedToEmail` | `string` | no | max 254 | Issued to (email). |
| `issuedToCustomerId` | `uuid` | no | — | Customer. |
| `expiresOn` | `string` | no | — | Expires. |
| `status` | `"active" \| "redeemed" \| "expired" \| "void"` | **yes** | — | Status. |

Example request:

```json
{
  "initialValuePaise": 149900,
  "issuedToName": "Brass Diya Set",
  "issuedToEmail": "ops@achichiz.in",
  "issuedToCustomerId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "expiresOn": "2026-11-01",
  "status": "active"
}
```

**Response `201`** — The created row.

```json
{
  "type": "success",
  "result": {}
}
```

**Errors**

| Status | Meaning |
|---|---|
| `409` | A unique constraint rejected it — a duplicate handle, SKU or code. |
| `422` | Validation failed, or a database constraint refused the row. |

---

### `GET /v1/admin/gift-cards/:id`

**Get one giftcard**

| | |
|---|---|
| operationId | `adminGetGiftCard` |
| Auth | Bearer staff token |
| Permission | `promotions:view` |

Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 here, the same as a row that never existed.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `fields` | `string` | no | max 600 | Comma-separated projection, from the column allowlist. |

**Response `200`** — The row.

```json
{
  "type": "success",
  "result": {}
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such row, or it is archived. |

---

### `PATCH /v1/admin/gift-cards/:id`

**Update a giftcard**

| | |
|---|---|
| operationId | `adminUpdateGiftCard` |
| Auth | Bearer staff token |
| Permission | `promotions:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `initialValuePaise` | `integer` | no | ≥ 1 | Face value. Integer paise — 149900 is ₹1,499.00. |
| `issuedToName` | `string` | no | max 160 | Issued to. |
| `issuedToEmail` | `string` | no | max 254 | Issued to (email). |
| `issuedToCustomerId` | `uuid` | no | — | Customer. |
| `expiresOn` | `string` | no | — | Expires. |
| `status` | `"active" \| "redeemed" \| "expired" \| "void"` | no | — | Status. |

Example request:

```json
{
  "initialValuePaise": 149900,
  "issuedToName": "Brass Diya Set",
  "issuedToEmail": "ops@achichiz.in",
  "issuedToCustomerId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "expiresOn": "2026-11-01",
  "status": "active"
}
```

**Response `200`** — The updated row.

```json
{
  "type": "success",
  "result": {}
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such row, or it is archived. |
| `409` | A unique constraint rejected it. |
| `422` | Validation failed, or a database constraint refused the change. |

---

### `DELETE /v1/admin/gift-cards/:id`

**Archive a giftcard**

| | |
|---|---|
| operationId | `adminDeleteGiftCard` |
| Auth | Bearer staff token |
| Permission | `promotions:delete` |

Archive: `status` becomes `void`. This table has no `deleted_at` because other rows keep foreign keys to it.

Gated on `promotions:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body** — none. Send `{}` or omit.

**Response `204`** — Archived.

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such row, or it is already archived. |

---
