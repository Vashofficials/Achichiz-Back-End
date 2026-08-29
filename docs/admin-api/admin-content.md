# Admin content

21 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/banners`](#get-v1-admin-banners) — List banners
- [`GET /v1/admin/banners/schema`](#get-v1-admin-banners-schema) — Field spec for banners
- [`POST /v1/admin/banners/bulk`](#post-v1-admin-banners-bulk) — Bulk action on banners
- [`POST /v1/admin/banners`](#post-v1-admin-banners) — Create a banner
- [`GET /v1/admin/banners/:id`](#get-v1-admin-banners-id) — Get one banner
- [`PATCH /v1/admin/banners/:id`](#patch-v1-admin-banners-id) — Update a banner
- [`DELETE /v1/admin/banners/:id`](#delete-v1-admin-banners-id) — Archive a banner
- [`GET /v1/admin/faqs`](#get-v1-admin-faqs) — List faqs
- [`GET /v1/admin/faqs/schema`](#get-v1-admin-faqs-schema) — Field spec for faqs
- [`POST /v1/admin/faqs/bulk`](#post-v1-admin-faqs-bulk) — Bulk action on faqs
- [`POST /v1/admin/faqs`](#post-v1-admin-faqs) — Create a faq
- [`GET /v1/admin/faqs/:id`](#get-v1-admin-faqs-id) — Get one faq
- [`PATCH /v1/admin/faqs/:id`](#patch-v1-admin-faqs-id) — Update a faq
- [`DELETE /v1/admin/faqs/:id`](#delete-v1-admin-faqs-id) — Archive a faq
- [`GET /v1/admin/testimonials`](#get-v1-admin-testimonials) — List testimonials
- [`GET /v1/admin/testimonials/schema`](#get-v1-admin-testimonials-schema) — Field spec for testimonials
- [`POST /v1/admin/testimonials/bulk`](#post-v1-admin-testimonials-bulk) — Bulk action on testimonials
- [`POST /v1/admin/testimonials`](#post-v1-admin-testimonials) — Create a testimonial
- [`GET /v1/admin/testimonials/:id`](#get-v1-admin-testimonials-id) — Get one testimonial
- [`PATCH /v1/admin/testimonials/:id`](#patch-v1-admin-testimonials-id) — Update a testimonial
- [`DELETE /v1/admin/testimonials/:id`](#delete-v1-admin-testimonials-id) — Archive a testimonial

---

### `GET /v1/admin/banners`

**List banners**

| | |
|---|---|
| operationId | `adminListBanners` |
| Auth | Bearer staff token |
| Permission | `content:view` |

Storefront banners. Clicks and CTR are analytics and live in `banner_stats_daily`.

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

Example: `/v1/admin/banners?page=…&perPage=…`

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

### `GET /v1/admin/banners/schema`

**Field spec for banners**

| | |
|---|---|
| operationId | `adminGetBannerSchema` |
| Auth | Bearer staff token |
| Permission | `content:view` |

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

### `POST /v1/admin/banners/bulk`

**Bulk action on banners**

| | |
|---|---|
| operationId | `adminBulkBanners` |
| Auth | Bearer staff token |
| Permission | `content:edit` |

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

### `POST /v1/admin/banners`

**Create a banner**

| | |
|---|---|
| operationId | `adminCreateBanner` |
| Auth | Bearer staff token |
| Permission | `content:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `title` | `string` | **yes** | max 200 | Title. |
| `subtitle` | `string` | no | max 300 | Subtitle. |
| `placement` | `"homepage_hero" \| "category_top" \| "cart_strip" \| "pdp_ribbon" \| "announcement_bar"` | **yes** | — | Placement. |
| `device` | `"all" \| "desktop" \| "mobile"` | no | — | Device. |
| `mediaId` | `uuid` | no | — | Image. |
| `mobileMediaId` | `uuid` | no | — | Mobile image. |
| `linkUrl` | `string` | no | max 500 | Link URL. |
| `collectionId` | `uuid` | no | — | Links to collection. |
| `ctaLabel` | `string` | no | max 60 | CTA label. |
| `position` | `integer` | no | ≥ 0, ≤ 1000 | Position. |
| `startsAt` | `string` | no | — | Starts. |
| `endsAt` | `string` | no | — | Ends. |
| `status` | `"live" \| "scheduled" \| "expired" \| "draft"` | **yes** | — | Status. |

Example request:

```json
{
  "title": "Brass Diya Set",
  "subtitle": "Brass Diya Set",
  "placement": "homepage_hero",
  "device": "all",
  "mediaId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "mobileMediaId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "linkUrl": "https://cdn.achichiz.in/media/diya.jpg",
  "collectionId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "ctaLabel": "string",
  "position": 1,
  "startsAt": "2026-08-25T10:30:00.000Z",
  "endsAt": "2026-08-25T10:30:00.000Z",
  "status": "live"
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

### `GET /v1/admin/banners/:id`

**Get one banner**

| | |
|---|---|
| operationId | `adminGetBanner` |
| Auth | Bearer staff token |
| Permission | `content:view` |

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

### `PATCH /v1/admin/banners/:id`

**Update a banner**

| | |
|---|---|
| operationId | `adminUpdateBanner` |
| Auth | Bearer staff token |
| Permission | `content:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `title` | `string` | no | max 200 | Title. |
| `subtitle` | `string` | no | max 300 | Subtitle. |
| `placement` | `"homepage_hero" \| "category_top" \| "cart_strip" \| "pdp_ribbon" \| "announcement_bar"` | no | — | Placement. |
| `device` | `"all" \| "desktop" \| "mobile"` | no | — | Device. |
| `mediaId` | `uuid` | no | — | Image. |
| `mobileMediaId` | `uuid` | no | — | Mobile image. |
| `linkUrl` | `string` | no | max 500 | Link URL. |
| `collectionId` | `uuid` | no | — | Links to collection. |
| `ctaLabel` | `string` | no | max 60 | CTA label. |
| `position` | `integer` | no | ≥ 0, ≤ 1000 | Position. |
| `startsAt` | `string` | no | — | Starts. |
| `endsAt` | `string` | no | — | Ends. |
| `status` | `"live" \| "scheduled" \| "expired" \| "draft"` | no | — | Status. |

Example request:

```json
{
  "title": "Brass Diya Set",
  "subtitle": "Brass Diya Set",
  "placement": "homepage_hero",
  "device": "all",
  "mediaId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "mobileMediaId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "linkUrl": "https://cdn.achichiz.in/media/diya.jpg",
  "collectionId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "ctaLabel": "string",
  "position": 1,
  "startsAt": "2026-08-25T10:30:00.000Z",
  "endsAt": "2026-08-25T10:30:00.000Z",
  "status": "live"
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

### `DELETE /v1/admin/banners/:id`

**Archive a banner**

| | |
|---|---|
| operationId | `adminDeleteBanner` |
| Auth | Bearer staff token |
| Permission | `content:delete` |

Archive: `status` becomes `expired`. This table has no `deleted_at` because other rows keep foreign keys to it.

Gated on `content:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

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

### `GET /v1/admin/faqs`

**List faqs**

| | |
|---|---|
| operationId | `adminListFaqs` |
| Auth | Bearer staff token |
| Permission | `content:view` |

`answer` is NOT NULL — the console mock had no answer field at all.

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

Example: `/v1/admin/faqs?page=…&perPage=…`

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

### `GET /v1/admin/faqs/schema`

**Field spec for faqs**

| | |
|---|---|
| operationId | `adminGetFaqSchema` |
| Auth | Bearer staff token |
| Permission | `content:view` |

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

### `POST /v1/admin/faqs/bulk`

**Bulk action on faqs**

| | |
|---|---|
| operationId | `adminBulkFaqs` |
| Auth | Bearer staff token |
| Permission | `content:edit` |

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

### `POST /v1/admin/faqs`

**Create a faq**

| | |
|---|---|
| operationId | `adminCreateFaq` |
| Auth | Bearer staff token |
| Permission | `content:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `question` | `string` | **yes** | max 400 | Question. |
| `answer` | `string` | **yes** | max 20000 | Answer. |
| `category` | `string` | no | max 80 | Category. |
| `position` | `integer` | no | ≥ 0, ≤ 1000 | Position. |
| `status` | `"published" \| "draft"` | **yes** | — | Status. |

Example request:

```json
{
  "question": "string",
  "answer": "string",
  "category": "string",
  "position": 1,
  "status": "published"
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

### `GET /v1/admin/faqs/:id`

**Get one faq**

| | |
|---|---|
| operationId | `adminGetFaq` |
| Auth | Bearer staff token |
| Permission | `content:view` |

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

### `PATCH /v1/admin/faqs/:id`

**Update a faq**

| | |
|---|---|
| operationId | `adminUpdateFaq` |
| Auth | Bearer staff token |
| Permission | `content:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `question` | `string` | no | max 400 | Question. |
| `answer` | `string` | no | max 20000 | Answer. |
| `category` | `string` | no | max 80 | Category. |
| `position` | `integer` | no | ≥ 0, ≤ 1000 | Position. |
| `status` | `"published" \| "draft"` | no | — | Status. |

Example request:

```json
{
  "question": "string",
  "answer": "string",
  "category": "string",
  "position": 1,
  "status": "published"
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

### `DELETE /v1/admin/faqs/:id`

**Archive a faq**

| | |
|---|---|
| operationId | `adminDeleteFaq` |
| Auth | Bearer staff token |
| Permission | `content:delete` |

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `content:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

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

### `GET /v1/admin/testimonials`

**List testimonials**

| | |
|---|---|
| operationId | `adminListTestimonials` |
| Auth | Bearer staff token |
| Permission | `content:view` |

Marketing quotes, not linked to a product. Product reviews are a separate resource.

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

Example: `/v1/admin/testimonials?page=…&perPage=…`

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

### `GET /v1/admin/testimonials/schema`

**Field spec for testimonials**

| | |
|---|---|
| operationId | `adminGetTestimonialSchema` |
| Auth | Bearer staff token |
| Permission | `content:view` |

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

### `POST /v1/admin/testimonials/bulk`

**Bulk action on testimonials**

| | |
|---|---|
| operationId | `adminBulkTestimonials` |
| Auth | Bearer staff token |
| Permission | `content:edit` |

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

### `POST /v1/admin/testimonials`

**Create a testimonial**

| | |
|---|---|
| operationId | `adminCreateTestimonial` |
| Auth | Bearer staff token |
| Permission | `content:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `authorName` | `string` | **yes** | max 160 | Author. |
| `authorCity` | `string` | no | max 80 | City. |
| `company` | `string` | no | max 160 | Company. |
| `designation` | `string` | no | max 120 | Designation. |
| `quote` | `string` | **yes** | max 2000 | Quote. |
| `rating` | `integer` | no | ≥ 1, ≤ 5 | Rating. |
| `mediaId` | `uuid` | no | — | Photo. |
| `isFeatured` | `any` | no | — | Featured. |
| `position` | `integer` | no | ≥ 0, ≤ 1000 | Position. |
| `status` | `"published" \| "pending" \| "rejected"` | **yes** | — | Status. |

Example request:

```json
{
  "authorName": "Brass Diya Set",
  "authorCity": "string",
  "company": "string",
  "designation": "string",
  "quote": "string",
  "rating": 1,
  "mediaId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "isFeatured": null,
  "position": 1,
  "status": "published"
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

### `GET /v1/admin/testimonials/:id`

**Get one testimonial**

| | |
|---|---|
| operationId | `adminGetTestimonial` |
| Auth | Bearer staff token |
| Permission | `content:view` |

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

### `PATCH /v1/admin/testimonials/:id`

**Update a testimonial**

| | |
|---|---|
| operationId | `adminUpdateTestimonial` |
| Auth | Bearer staff token |
| Permission | `content:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `authorName` | `string` | no | max 160 | Author. |
| `authorCity` | `string` | no | max 80 | City. |
| `company` | `string` | no | max 160 | Company. |
| `designation` | `string` | no | max 120 | Designation. |
| `quote` | `string` | no | max 2000 | Quote. |
| `rating` | `integer` | no | ≥ 1, ≤ 5 | Rating. |
| `mediaId` | `uuid` | no | — | Photo. |
| `isFeatured` | `any` | no | — | Featured. |
| `position` | `integer` | no | ≥ 0, ≤ 1000 | Position. |
| `status` | `"published" \| "pending" \| "rejected"` | no | — | Status. |

Example request:

```json
{
  "authorName": "Brass Diya Set",
  "authorCity": "string",
  "company": "string",
  "designation": "string",
  "quote": "string",
  "rating": 1,
  "mediaId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "isFeatured": null,
  "position": 1,
  "status": "published"
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

### `DELETE /v1/admin/testimonials/:id`

**Archive a testimonial**

| | |
|---|---|
| operationId | `adminDeleteTestimonial` |
| Auth | Bearer staff token |
| Permission | `content:delete` |

Archive: `status` becomes `rejected`. This table has no `deleted_at` because other rows keep foreign keys to it.

Gated on `content:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

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
