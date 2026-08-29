# Admin catalogue

28 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/products`](#get-v1-admin-products) — List products
- [`GET /v1/admin/products/schema`](#get-v1-admin-products-schema) — Field spec for products
- [`POST /v1/admin/products/bulk`](#post-v1-admin-products-bulk) — Bulk action on products
- [`POST /v1/admin/products`](#post-v1-admin-products) — Create a product
- [`GET /v1/admin/products/:id`](#get-v1-admin-products-id) — Get one product
- [`PATCH /v1/admin/products/:id`](#patch-v1-admin-products-id) — Update a product
- [`DELETE /v1/admin/products/:id`](#delete-v1-admin-products-id) — Archive a product
- [`GET /v1/admin/product-variants`](#get-v1-admin-product-variants) — List product variants
- [`GET /v1/admin/product-variants/schema`](#get-v1-admin-product-variants-schema) — Field spec for product variants
- [`POST /v1/admin/product-variants/bulk`](#post-v1-admin-product-variants-bulk) — Bulk action on product variants
- [`POST /v1/admin/product-variants`](#post-v1-admin-product-variants) — Create a productvariant
- [`GET /v1/admin/product-variants/:id`](#get-v1-admin-product-variants-id) — Get one productvariant
- [`PATCH /v1/admin/product-variants/:id`](#patch-v1-admin-product-variants-id) — Update a productvariant
- [`DELETE /v1/admin/product-variants/:id`](#delete-v1-admin-product-variants-id) — Archive a productvariant
- [`GET /v1/admin/collections`](#get-v1-admin-collections) — List collections
- [`GET /v1/admin/collections/schema`](#get-v1-admin-collections-schema) — Field spec for collections
- [`POST /v1/admin/collections/bulk`](#post-v1-admin-collections-bulk) — Bulk action on collections
- [`POST /v1/admin/collections`](#post-v1-admin-collections) — Create a collection
- [`GET /v1/admin/collections/:id`](#get-v1-admin-collections-id) — Get one collection
- [`PATCH /v1/admin/collections/:id`](#patch-v1-admin-collections-id) — Update a collection
- [`DELETE /v1/admin/collections/:id`](#delete-v1-admin-collections-id) — Archive a collection
- [`GET /v1/admin/designers`](#get-v1-admin-designers) — List brands & designers
- [`GET /v1/admin/designers/schema`](#get-v1-admin-designers-schema) — Field spec for brands & designers
- [`POST /v1/admin/designers/bulk`](#post-v1-admin-designers-bulk) — Bulk action on brands & designers
- [`POST /v1/admin/designers`](#post-v1-admin-designers) — Create a designer
- [`GET /v1/admin/designers/:id`](#get-v1-admin-designers-id) — Get one designer
- [`PATCH /v1/admin/designers/:id`](#patch-v1-admin-designers-id) — Update a designer
- [`DELETE /v1/admin/designers/:id`](#delete-v1-admin-designers-id) — Archive a designer

---

### `GET /v1/admin/products`

**List products**

| | |
|---|---|
| operationId | `adminListProducts` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

The sellable catalogue. `kind` is a fulfilment class, not the storefront category.

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

Example: `/v1/admin/products?page=…&perPage=…`

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

### `GET /v1/admin/products/schema`

**Field spec for products**

| | |
|---|---|
| operationId | `adminGetProductSchema` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

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

### `POST /v1/admin/products/bulk`

**Bulk action on products**

| | |
|---|---|
| operationId | `adminBulkProducts` |
| Auth | Bearer staff token |
| Permission | `catalogue:edit` |

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
    "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e"
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
      "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
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

### `POST /v1/admin/products`

**Create a product**

| | |
|---|---|
| operationId | `adminCreateProduct` |
| Auth | Bearer staff token |
| Permission | `catalogue:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | **yes** | max 120 | Handle. URL slug. Lower case, hyphenated. Unique among live products. |
| `title` | `string` | **yes** | max 200 | Title. |
| `subtitle` | `string` | no | max 200 | Subtitle. |
| `description` | `string` | no | max 20000 | Description. |
| `kind` | `"hamper" \| "single_gift" \| "personalised" \| "gourmet" \| "add_on" \| "builder"` | **yes** | — | Fulfilment kind. |
| `designerId` | `uuid` | no | — | Brand / designer. |
| `primaryCollectionId` | `uuid` | no | — | Primary collection. Breadcrumb only — the real taxonomy is the product↔collection join. |
| `hsnCode` | `string` | no | max 8 | HSN code. Required before the product can go active — there is no invoice without one. |
| `isPersonalisable` | `any` | no | — | Personalisable. |
| `isPerishable` | `any` | no | — | Perishable. |
| `isFragile` | `any` | no | — | Fragile. |
| `requiresShipping` | `any` | no | — | Requires shipping. |
| `lowStockThreshold` | `integer` | no | ≥ 0, ≤ 100000 | Low-stock threshold. |
| `badgeOverride` | `"best_seller" \| "new" \| "limited" \| "none"` | no | — | Badge override. |
| `tags` | `string[]` | no | max 50 items | Tags. |
| `status` | `"active" \| "draft" \| "archived"` | **yes** | — | Status. |
| `publishedAt` | `string` | no | — | Published at. Must be set before status can be `active`. |

Example request:

```json
{
  "handle": "brass-diya-set",
  "title": "Brass Diya Set",
  "subtitle": "Brass Diya Set",
  "description": "Free-text description.",
  "kind": "hamper",
  "designerId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "primaryCollectionId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "hsnCode": "DIWALI20",
  "isPersonalisable": null,
  "isPerishable": null,
  "isFragile": null,
  "requiresShipping": null,
  "lowStockThreshold": 1,
  "badgeOverride": "best_seller",
  "tags": [
    "string"
  ],
  "status": "active",
  "publishedAt": "2026-08-25T10:30:00.000Z"
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

### `GET /v1/admin/products/:id`

**Get one product**

| | |
|---|---|
| operationId | `adminGetProduct` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

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

### `PATCH /v1/admin/products/:id`

**Update a product**

| | |
|---|---|
| operationId | `adminUpdateProduct` |
| Auth | Bearer staff token |
| Permission | `catalogue:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | no | max 120 | Handle. URL slug. Lower case, hyphenated. Unique among live products. |
| `title` | `string` | no | max 200 | Title. |
| `subtitle` | `string` | no | max 200 | Subtitle. |
| `description` | `string` | no | max 20000 | Description. |
| `kind` | `"hamper" \| "single_gift" \| "personalised" \| "gourmet" \| "add_on" \| "builder"` | no | — | Fulfilment kind. |
| `designerId` | `uuid` | no | — | Brand / designer. |
| `primaryCollectionId` | `uuid` | no | — | Primary collection. Breadcrumb only — the real taxonomy is the product↔collection join. |
| `hsnCode` | `string` | no | max 8 | HSN code. Required before the product can go active — there is no invoice without one. |
| `isPersonalisable` | `any` | no | — | Personalisable. |
| `isPerishable` | `any` | no | — | Perishable. |
| `isFragile` | `any` | no | — | Fragile. |
| `requiresShipping` | `any` | no | — | Requires shipping. |
| `lowStockThreshold` | `integer` | no | ≥ 0, ≤ 100000 | Low-stock threshold. |
| `badgeOverride` | `"best_seller" \| "new" \| "limited" \| "none"` | no | — | Badge override. |
| `tags` | `string[]` | no | max 50 items | Tags. |
| `status` | `"active" \| "draft" \| "archived"` | no | — | Status. |
| `publishedAt` | `string` | no | — | Published at. Must be set before status can be `active`. |

Example request:

```json
{
  "handle": "brass-diya-set",
  "title": "Brass Diya Set",
  "subtitle": "Brass Diya Set",
  "description": "Free-text description.",
  "kind": "hamper",
  "designerId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "primaryCollectionId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "hsnCode": "DIWALI20",
  "isPersonalisable": null,
  "isPerishable": null,
  "isFragile": null,
  "requiresShipping": null,
  "lowStockThreshold": 1,
  "badgeOverride": "best_seller",
  "tags": [
    "string"
  ],
  "status": "active",
  "publishedAt": "2026-08-25T10:30:00.000Z"
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

### `DELETE /v1/admin/products/:id`

**Archive a product**

| | |
|---|---|
| operationId | `adminDeleteProduct` |
| Auth | Bearer staff token |
| Permission | `catalogue:delete` |

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `catalogue:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

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

### `GET /v1/admin/product-variants`

**List product variants**

| | |
|---|---|
| operationId | `adminListProductVariants` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

SKU-level rows. Prices are GST-INCLUSIVE integer paise.

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

Example: `/v1/admin/product-variants?page=…&perPage=…`

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

### `GET /v1/admin/product-variants/schema`

**Field spec for product variants**

| | |
|---|---|
| operationId | `adminGetProductVariantSchema` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

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

### `POST /v1/admin/product-variants/bulk`

**Bulk action on product variants**

| | |
|---|---|
| operationId | `adminBulkProductVariants` |
| Auth | Bearer staff token |
| Permission | `catalogue:edit` |

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
    "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e"
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
      "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
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

### `POST /v1/admin/product-variants`

**Create a productvariant**

| | |
|---|---|
| operationId | `adminCreateProductVariant` |
| Auth | Bearer staff token |
| Permission | `catalogue:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `productId` | `uuid` | **yes** | — | Product. |
| `sku` | `string` | **yes** | max 64 | SKU. |
| `optionLabel` | `string` | **yes** | max 80 | Option label. `Signature`, `Rose`, `A5`. |
| `optionValue` | `string` | **yes** | max 80 | Option value. Slug form. Unique per product. |
| `pricePaise` | `integer` | **yes** | ≥ 0 | Price. GST-inclusive. Integer paise — 149900 is ₹1,499.00. |
| `compareAtPaise` | `integer` | no | ≥ 0 | Compare-at price. Must be ≥ price. The struck-through number. Integer paise — 149900 is ₹1,499.00. |
| `costPaise` | `integer` | no | ≥ 0 | Cost. Never exposed on the storefront API. Integer paise — 149900 is ₹1,499.00. |
| `weightGrams` | `integer` | no | ≥ 1, ≤ 1000000 | Weight. In grams. |
| `lengthMm` | `integer` | no | ≥ 0, ≤ 100000 | Length. In millimetres. |
| `widthMm` | `integer` | no | ≥ 0, ≤ 100000 | Width. In millimetres. |
| `heightMm` | `integer` | no | ≥ 0, ≤ 100000 | Height. In millimetres. |
| `barcode` | `string` | no | max 64 | Barcode. |
| `isDefault` | `any` | no | — | Default variant. At most one per product. |
| `position` | `integer` | no | ≥ 0, ≤ 10000 | Position. |
| `status` | `"active" \| "inactive"` | **yes** | — | Status. |

Example request:

```json
{
  "productId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "sku": "ACH-CAN-001",
  "optionLabel": "string",
  "optionValue": "string",
  "pricePaise": 149900,
  "compareAtPaise": 149900,
  "costPaise": 149900,
  "weightGrams": 1,
  "lengthMm": 1,
  "widthMm": 1,
  "heightMm": 1,
  "barcode": "2900000000008",
  "isDefault": null,
  "position": 1,
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

### `GET /v1/admin/product-variants/:id`

**Get one productvariant**

| | |
|---|---|
| operationId | `adminGetProductVariant` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

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

### `PATCH /v1/admin/product-variants/:id`

**Update a productvariant**

| | |
|---|---|
| operationId | `adminUpdateProductVariant` |
| Auth | Bearer staff token |
| Permission | `catalogue:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `productId` | `uuid` | no | — | Product. |
| `sku` | `string` | no | max 64 | SKU. |
| `optionLabel` | `string` | no | max 80 | Option label. `Signature`, `Rose`, `A5`. |
| `optionValue` | `string` | no | max 80 | Option value. Slug form. Unique per product. |
| `pricePaise` | `integer` | no | ≥ 0 | Price. GST-inclusive. Integer paise — 149900 is ₹1,499.00. |
| `compareAtPaise` | `integer` | no | ≥ 0 | Compare-at price. Must be ≥ price. The struck-through number. Integer paise — 149900 is ₹1,499.00. |
| `costPaise` | `integer` | no | ≥ 0 | Cost. Never exposed on the storefront API. Integer paise — 149900 is ₹1,499.00. |
| `weightGrams` | `integer` | no | ≥ 1, ≤ 1000000 | Weight. In grams. |
| `lengthMm` | `integer` | no | ≥ 0, ≤ 100000 | Length. In millimetres. |
| `widthMm` | `integer` | no | ≥ 0, ≤ 100000 | Width. In millimetres. |
| `heightMm` | `integer` | no | ≥ 0, ≤ 100000 | Height. In millimetres. |
| `barcode` | `string` | no | max 64 | Barcode. |
| `isDefault` | `any` | no | — | Default variant. At most one per product. |
| `position` | `integer` | no | ≥ 0, ≤ 10000 | Position. |
| `status` | `"active" \| "inactive"` | no | — | Status. |

Example request:

```json
{
  "productId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "sku": "ACH-CAN-001",
  "optionLabel": "string",
  "optionValue": "string",
  "pricePaise": 149900,
  "compareAtPaise": 149900,
  "costPaise": 149900,
  "weightGrams": 1,
  "lengthMm": 1,
  "widthMm": 1,
  "heightMm": 1,
  "barcode": "2900000000008",
  "isDefault": null,
  "position": 1,
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

### `DELETE /v1/admin/product-variants/:id`

**Archive a productvariant**

| | |
|---|---|
| operationId | `adminDeleteProductVariant` |
| Auth | Bearer staff token |
| Permission | `catalogue:delete` |

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `catalogue:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

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

### `GET /v1/admin/collections`

**List collections**

| | |
|---|---|
| operationId | `adminListCollections` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

One taxonomy table for categories, occasions, festivals, recipients, designer pages and edits.

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

Example: `/v1/admin/collections?page=…&perPage=…`

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

### `GET /v1/admin/collections/schema`

**Field spec for collections**

| | |
|---|---|
| operationId | `adminGetCollectionSchema` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

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

### `POST /v1/admin/collections/bulk`

**Bulk action on collections**

| | |
|---|---|
| operationId | `adminBulkCollections` |
| Auth | Bearer staff token |
| Permission | `catalogue:edit` |

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

### `POST /v1/admin/collections`

**Create a collection**

| | |
|---|---|
| operationId | `adminCreateCollection` |
| Auth | Bearer staff token |
| Permission | `catalogue:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | **yes** | max 120 | Handle. Public route key. Unique among live collections. |
| `kind` | `"category" \| "recipient" \| "occasion" \| "festival" \| "designer" \| "edit"` | **yes** | — | Kind. |
| `title` | `string` | **yes** | max 160 | Nav title. |
| `heading` | `string` | no | max 200 | Page heading. |
| `subtext` | `string` | no | max 20000 | Subtext. |
| `seoDescription` | `string` | no | max 500 | SEO description. |
| `parentId` | `uuid` | no | — | Parent collection. |
| `designerId` | `uuid` | no | — | Designer. Only for `kind: designer`. |
| `curator` | `string` | no | max 120 | Curator. Only for `kind: edit`. |
| `sortOrder` | `integer` | no | ≥ 0, ≤ 10000 | Sort order. |
| `isFeatured` | `any` | no | — | Featured. |
| `status` | `"live" \| "scheduled" \| "draft" \| "archived"` | **yes** | — | Status. |
| `startsOn` | `string` | no | — | Starts. Required when status is `scheduled`. |
| `endsOn` | `string` | no | — | Ends. |

Example request:

```json
{
  "handle": "brass-diya-set",
  "kind": "category",
  "title": "Brass Diya Set",
  "heading": "string",
  "subtext": "string",
  "seoDescription": "string",
  "parentId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "designerId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "curator": "string",
  "sortOrder": 1,
  "isFeatured": null,
  "status": "live",
  "startsOn": "2026-11-01",
  "endsOn": "2026-11-01"
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

### `GET /v1/admin/collections/:id`

**Get one collection**

| | |
|---|---|
| operationId | `adminGetCollection` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

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

### `PATCH /v1/admin/collections/:id`

**Update a collection**

| | |
|---|---|
| operationId | `adminUpdateCollection` |
| Auth | Bearer staff token |
| Permission | `catalogue:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | no | max 120 | Handle. Public route key. Unique among live collections. |
| `kind` | `"category" \| "recipient" \| "occasion" \| "festival" \| "designer" \| "edit"` | no | — | Kind. |
| `title` | `string` | no | max 160 | Nav title. |
| `heading` | `string` | no | max 200 | Page heading. |
| `subtext` | `string` | no | max 20000 | Subtext. |
| `seoDescription` | `string` | no | max 500 | SEO description. |
| `parentId` | `uuid` | no | — | Parent collection. |
| `designerId` | `uuid` | no | — | Designer. Only for `kind: designer`. |
| `curator` | `string` | no | max 120 | Curator. Only for `kind: edit`. |
| `sortOrder` | `integer` | no | ≥ 0, ≤ 10000 | Sort order. |
| `isFeatured` | `any` | no | — | Featured. |
| `status` | `"live" \| "scheduled" \| "draft" \| "archived"` | no | — | Status. |
| `startsOn` | `string` | no | — | Starts. Required when status is `scheduled`. |
| `endsOn` | `string` | no | — | Ends. |

Example request:

```json
{
  "handle": "brass-diya-set",
  "kind": "category",
  "title": "Brass Diya Set",
  "heading": "string",
  "subtext": "string",
  "seoDescription": "string",
  "parentId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "designerId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "curator": "string",
  "sortOrder": 1,
  "isFeatured": null,
  "status": "live",
  "startsOn": "2026-11-01",
  "endsOn": "2026-11-01"
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

### `DELETE /v1/admin/collections/:id`

**Archive a collection**

| | |
|---|---|
| operationId | `adminDeleteCollection` |
| Auth | Bearer staff token |
| Permission | `catalogue:delete` |

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `catalogue:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

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

### `GET /v1/admin/designers`

**List brands & designers**

| | |
|---|---|
| operationId | `adminListDesigners` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

Partners. Commission is stored in basis points, not whole percent.

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

Example: `/v1/admin/designers?page=…&perPage=…`

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

### `GET /v1/admin/designers/schema`

**Field spec for brands & designers**

| | |
|---|---|
| operationId | `adminGetDesignerSchema` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

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

### `POST /v1/admin/designers/bulk`

**Bulk action on brands & designers**

| | |
|---|---|
| operationId | `adminBulkDesigners` |
| Auth | Bearer staff token |
| Permission | `catalogue:edit` |

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

### `POST /v1/admin/designers`

**Create a designer**

| | |
|---|---|
| operationId | `adminCreateDesigner` |
| Auth | Bearer staff token |
| Permission | `catalogue:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | **yes** | max 120 | Handle. |
| `name` | `string` | **yes** | max 160 | Partner. |
| `kind` | `"designer" \| "brand" \| "celebrity" \| "artisan_cluster"` | **yes** | — | Type. |
| `bio` | `string` | no | max 20000 | Bio. |
| `commissionBp` | `integer` | no | ≥ 0, ≤ 10000 | Commission. The console shows whole percent; the column is basis points. 800 = 8%. Basis points — 250 is 2.5%. |
| `contactEmail` | `string` | no | max 254 | Contact email. |
| `contactPhone` | `string` | no | max 20 | Contact phone. |
| `status` | `"active" \| "paused" \| "archived"` | **yes** | — | Status. |

Example request:

```json
{
  "handle": "brass-diya-set",
  "name": "Brass Diya Set",
  "kind": "designer",
  "bio": "string",
  "commissionBp": 1000,
  "contactEmail": "ops@achichiz.in",
  "contactPhone": "9820012345",
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

### `GET /v1/admin/designers/:id`

**Get one designer**

| | |
|---|---|
| operationId | `adminGetDesigner` |
| Auth | Bearer staff token |
| Permission | `catalogue:view` |

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

### `PATCH /v1/admin/designers/:id`

**Update a designer**

| | |
|---|---|
| operationId | `adminUpdateDesigner` |
| Auth | Bearer staff token |
| Permission | `catalogue:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | no | max 120 | Handle. |
| `name` | `string` | no | max 160 | Partner. |
| `kind` | `"designer" \| "brand" \| "celebrity" \| "artisan_cluster"` | no | — | Type. |
| `bio` | `string` | no | max 20000 | Bio. |
| `commissionBp` | `integer` | no | ≥ 0, ≤ 10000 | Commission. The console shows whole percent; the column is basis points. 800 = 8%. Basis points — 250 is 2.5%. |
| `contactEmail` | `string` | no | max 254 | Contact email. |
| `contactPhone` | `string` | no | max 20 | Contact phone. |
| `status` | `"active" \| "paused" \| "archived"` | no | — | Status. |

Example request:

```json
{
  "handle": "brass-diya-set",
  "name": "Brass Diya Set",
  "kind": "designer",
  "bio": "string",
  "commissionBp": 1000,
  "contactEmail": "ops@achichiz.in",
  "contactPhone": "9820012345",
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

### `DELETE /v1/admin/designers/:id`

**Archive a designer**

| | |
|---|---|
| operationId | `adminDeleteDesigner` |
| Auth | Bearer staff token |
| Permission | `catalogue:delete` |

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `catalogue:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

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
