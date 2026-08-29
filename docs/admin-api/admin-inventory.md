# Admin inventory

32 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/suppliers`](#get-v1-admin-suppliers) — List suppliers
- [`GET /v1/admin/suppliers/schema`](#get-v1-admin-suppliers-schema) — Field spec for suppliers
- [`POST /v1/admin/suppliers/bulk`](#post-v1-admin-suppliers-bulk) — Bulk action on suppliers
- [`POST /v1/admin/suppliers`](#post-v1-admin-suppliers) — Create a supplier
- [`GET /v1/admin/suppliers/:id`](#get-v1-admin-suppliers-id) — Get one supplier
- [`PATCH /v1/admin/suppliers/:id`](#patch-v1-admin-suppliers-id) — Update a supplier
- [`DELETE /v1/admin/suppliers/:id`](#delete-v1-admin-suppliers-id) — Archive a supplier
- [`GET /v1/admin/warehouses`](#get-v1-admin-warehouses) — List warehouses
- [`GET /v1/admin/warehouses/schema`](#get-v1-admin-warehouses-schema) — Field spec for warehouses
- [`POST /v1/admin/warehouses/bulk`](#post-v1-admin-warehouses-bulk) — Bulk action on warehouses
- [`POST /v1/admin/warehouses`](#post-v1-admin-warehouses) — Create a warehouse
- [`GET /v1/admin/warehouses/:id`](#get-v1-admin-warehouses-id) — Get one warehouse
- [`PATCH /v1/admin/warehouses/:id`](#patch-v1-admin-warehouses-id) — Update a warehouse
- [`DELETE /v1/admin/warehouses/:id`](#delete-v1-admin-warehouses-id) — Archive a warehouse
- [`GET /v1/admin/inventory/dashboard`](#get-v1-admin-inventory-dashboard) — Inventory dashboard
- [`GET /v1/admin/inventory`](#get-v1-admin-inventory) — List stock levels
- [`GET /v1/admin/inventory/movements`](#get-v1-admin-inventory-movements) — The stock ledger
- [`GET /v1/admin/inventory/movements/:movementId`](#get-v1-admin-inventory-movements-movementid) — Get one ledger entry
- [`POST /v1/admin/inventory/adjustments`](#post-v1-admin-inventory-adjustments) — Adjust stock
- [`POST /v1/admin/inventory/bulk-adjust`](#post-v1-admin-inventory-bulk-adjust) — Adjust many SKUs at once
- [`GET /v1/admin/inventory/alerts/low-stock`](#get-v1-admin-inventory-alerts-low-stock) — Low-stock alerts
- [`GET /v1/admin/inventory/alerts/out-of-stock`](#get-v1-admin-inventory-alerts-out-of-stock) — Out-of-stock alerts
- [`GET /v1/admin/inventory/reorder`](#get-v1-admin-inventory-reorder) — What to buy
- [`POST /v1/admin/inventory/reorder/purchase-draft`](#post-v1-admin-inventory-reorder-purchase-draft) — Draft a purchase order from the reorder suggestions
- [`GET /v1/admin/inventory/reservations`](#get-v1-admin-inventory-reservations) — List stock holds
- [`POST /v1/admin/inventory/reservations`](#post-v1-admin-inventory-reservations) — Hold stock by hand
- [`POST /v1/admin/inventory/reservations/:id/release`](#post-v1-admin-inventory-reservations-id-release) — Release a stock hold
- [`GET /v1/admin/inventory/audit`](#get-v1-admin-inventory-audit) — Who changed stock, and what the numbers were
- [`GET /v1/admin/inventory/notifications`](#get-v1-admin-inventory-notifications) — Inventory notifications
- [`GET /v1/admin/inventory/export`](#get-v1-admin-inventory-export) — Export stock levels
- [`GET /v1/admin/inventory/:sku/availability`](#get-v1-admin-inventory-sku-availability) — Can we promise this?
- [`GET /v1/admin/inventory/:sku`](#get-v1-admin-inventory-sku) — Everything about one SKU

---

### `GET /v1/admin/suppliers`

**List suppliers**

| | |
|---|---|
| operationId | `adminListSuppliers` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Vendors. `outstandingPaise` is a ledger rollup and is not writable here.

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

Example: `/v1/admin/suppliers?page=…&perPage=…`

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

### `GET /v1/admin/suppliers/schema`

**Field spec for suppliers**

| | |
|---|---|
| operationId | `adminGetSupplierSchema` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

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

### `POST /v1/admin/suppliers/bulk`

**Bulk action on suppliers**

| | |
|---|---|
| operationId | `adminBulkSuppliers` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

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

### `POST /v1/admin/suppliers`

**Create a supplier**

| | |
|---|---|
| operationId | `adminCreateSupplier` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `code` | `string` | **yes** | max 32 | Code. |
| `name` | `string` | **yes** | max 200 | Supplier. |
| `contactName` | `string` | no | max 160 | Contact. |
| `email` | `string` | no | max 254 | Email. |
| `mobile` | `string` | no | max 20 | Mobile. |
| `line1` | `string` | no | max 300 | Address. |
| `city` | `string` | no | max 120 | City. |
| `stateCode` | `string` | no | max 2 | State code. Two-digit GST state code. |
| `pincode` | `string` | no | max 6 | PIN code. |
| `gstin` | `string` | no | max 15 | GSTIN. |
| `pan` | `string` | no | max 10 | PAN. |
| `category` | `string` | no | max 80 | Category. Gourmet, Packaging, Decor, Fragrance, Logistics. |
| `leadTimeDays` | `integer` | no | ≥ 0, ≤ 365 | Lead time. In days. |
| `paymentTerms` | `string` | no | max 80 | Payment terms. |
| `status` | `"active" \| "on_hold" \| "archived"` | **yes** | — | Status. |

Example request:

```json
{
  "code": "DIWALI20",
  "name": "Brass Diya Set",
  "contactName": "Brass Diya Set",
  "email": "ops@achichiz.in",
  "mobile": "9820012345",
  "line1": "12 Linking Road",
  "city": "Mumbai",
  "stateCode": "27",
  "pincode": "400050",
  "gstin": "27AAACA1234A1Z5",
  "pan": "string",
  "category": "string",
  "leadTimeDays": 30,
  "paymentTerms": "string",
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

### `GET /v1/admin/suppliers/:id`

**Get one supplier**

| | |
|---|---|
| operationId | `adminGetSupplier` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

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

### `PATCH /v1/admin/suppliers/:id`

**Update a supplier**

| | |
|---|---|
| operationId | `adminUpdateSupplier` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `code` | `string` | no | max 32 | Code. |
| `name` | `string` | no | max 200 | Supplier. |
| `contactName` | `string` | no | max 160 | Contact. |
| `email` | `string` | no | max 254 | Email. |
| `mobile` | `string` | no | max 20 | Mobile. |
| `line1` | `string` | no | max 300 | Address. |
| `city` | `string` | no | max 120 | City. |
| `stateCode` | `string` | no | max 2 | State code. Two-digit GST state code. |
| `pincode` | `string` | no | max 6 | PIN code. |
| `gstin` | `string` | no | max 15 | GSTIN. |
| `pan` | `string` | no | max 10 | PAN. |
| `category` | `string` | no | max 80 | Category. Gourmet, Packaging, Decor, Fragrance, Logistics. |
| `leadTimeDays` | `integer` | no | ≥ 0, ≤ 365 | Lead time. In days. |
| `paymentTerms` | `string` | no | max 80 | Payment terms. |
| `status` | `"active" \| "on_hold" \| "archived"` | no | — | Status. |

Example request:

```json
{
  "code": "DIWALI20",
  "name": "Brass Diya Set",
  "contactName": "Brass Diya Set",
  "email": "ops@achichiz.in",
  "mobile": "9820012345",
  "line1": "12 Linking Road",
  "city": "Mumbai",
  "stateCode": "27",
  "pincode": "400050",
  "gstin": "27AAACA1234A1Z5",
  "pan": "string",
  "category": "string",
  "leadTimeDays": 30,
  "paymentTerms": "string",
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

### `DELETE /v1/admin/suppliers/:id`

**Archive a supplier**

| | |
|---|---|
| operationId | `adminDeleteSupplier` |
| Auth | Bearer staff token |
| Permission | `inventory:delete` |

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `inventory:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

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

### `GET /v1/admin/warehouses`

**List warehouses**

| | |
|---|---|
| operationId | `adminListWarehouses` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Fulfilment locations. GST registration is state-wise, so each carries its own GSTIN. Filed under “Delivery & Fulfilment” in the nav but gated on `inventory`, matching the console.

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

Example: `/v1/admin/warehouses?page=…&perPage=…`

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

### `GET /v1/admin/warehouses/schema`

**Field spec for warehouses**

| | |
|---|---|
| operationId | `adminGetWarehouseSchema` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

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

### `POST /v1/admin/warehouses/bulk`

**Bulk action on warehouses**

| | |
|---|---|
| operationId | `adminBulkWarehouses` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

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

### `POST /v1/admin/warehouses`

**Create a warehouse**

| | |
|---|---|
| operationId | `adminCreateWarehouse` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

The body is generated from this resource’s `fields` spec, so required fields are required by name rather than by position, and the schema below is the real one — not `additionalProperties: true`.

Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to succeed without changing the price. Read-only fields are documented in `/schema` and rejected here. Database CHECK constraints still apply on top — an active product with no HSN code is refused by the database, because there is no invoice without one.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `code` | `string` | **yes** | max 32 | Code. `WH-MUM-AND`. |
| `name` | `string` | **yes** | max 200 | Warehouse. |
| `line1` | `string` | **yes** | max 300 | Address. |
| `city` | `string` | **yes** | max 120 | City. |
| `stateCode` | `string` | **yes** | max 2 | State code. Two-digit GST state code. Determines whether a supply is interstate. |
| `pincode` | `string` | **yes** | max 6 | PIN code. |
| `gstin` | `string` | no | max 15 | GSTIN. One per state of operation. |
| `managerId` | `uuid` | no | — | Manager. |
| `capacityUnits` | `integer` | no | ≥ 1, ≤ 10000000 | Capacity. |
| `supportsSameDay` | `any` | no | — | Same-day capable. |
| `isDefault` | `any` | no | — | Default warehouse. Exactly one live warehouse may be the default. |
| `status` | `"active" \| "maintenance" \| "closed"` | **yes** | — | Status. |

Example request:

```json
{
  "code": "DIWALI20",
  "name": "Brass Diya Set",
  "line1": "12 Linking Road",
  "city": "Mumbai",
  "stateCode": "27",
  "pincode": "400050",
  "gstin": "27AAACA1234A1Z5",
  "managerId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "capacityUnits": 1,
  "supportsSameDay": null,
  "isDefault": null,
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

### `GET /v1/admin/warehouses/:id`

**Get one warehouse**

| | |
|---|---|
| operationId | `adminGetWarehouse` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

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

### `PATCH /v1/admin/warehouses/:id`

**Update a warehouse**

| | |
|---|---|
| operationId | `adminUpdateWarehouse` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it rendered, so PUT would promise a full replacement the client has never had the data to make. Send at least one field. Unrecognised and read-only keys are rejected, not ignored.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Row id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `code` | `string` | no | max 32 | Code. `WH-MUM-AND`. |
| `name` | `string` | no | max 200 | Warehouse. |
| `line1` | `string` | no | max 300 | Address. |
| `city` | `string` | no | max 120 | City. |
| `stateCode` | `string` | no | max 2 | State code. Two-digit GST state code. Determines whether a supply is interstate. |
| `pincode` | `string` | no | max 6 | PIN code. |
| `gstin` | `string` | no | max 15 | GSTIN. One per state of operation. |
| `managerId` | `uuid` | no | — | Manager. |
| `capacityUnits` | `integer` | no | ≥ 1, ≤ 10000000 | Capacity. |
| `supportsSameDay` | `any` | no | — | Same-day capable. |
| `isDefault` | `any` | no | — | Default warehouse. Exactly one live warehouse may be the default. |
| `status` | `"active" \| "maintenance" \| "closed"` | no | — | Status. |

Example request:

```json
{
  "code": "DIWALI20",
  "name": "Brass Diya Set",
  "line1": "12 Linking Road",
  "city": "Mumbai",
  "stateCode": "27",
  "pincode": "400050",
  "gstin": "27AAACA1234A1Z5",
  "managerId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "capacityUnits": 1,
  "supportsSameDay": null,
  "isDefault": null,
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

### `DELETE /v1/admin/warehouses/:id`

**Archive a warehouse**

| | |
|---|---|
| operationId | `adminDeleteWarehouse` |
| Auth | Bearer staff token |
| Permission | `inventory:delete` |

Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit history pointing at it, survive.

Gated on `inventory:delete`, which is a much narrower grant than `edit` — across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and nobody else.

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

### `GET /v1/admin/inventory/dashboard`

**Inventory dashboard**

| | |
|---|---|
| operationId | `adminInventoryDashboard` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The header strip for the inventory console, computed in the database rather than by summing whatever page happens to be loaded — the console currently derives "stock value" from the twenty-five rows in memory, which makes it mean "stock value of these twenty-five".

`stockValuePaise` is on-hand at unit cost in integer paise. Items with no recorded cost contribute ZERO rather than an estimate: a valuation that quietly invents numbers is worse than one with a visible hole in it.

`lowStockCount` and `outOfStockCount` are counted against the GENERATED `available_qty` column, so they can never disagree with the list screens. `reorderCount` is different and larger in scope: it uses the inventory POSITION (`on hand − reserved + incoming`), because an item with a purchase order already in flight does not need a second one.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |

**Response `200`** — Network totals plus a per-warehouse breakdown.

```json
{
  "type": "success",
  "result": {
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "trackedItemCount": 3,
    "levelCount": 3,
    "totalOnHandQty": 10,
    "totalReservedQty": 10,
    "totalAvailableQty": 10,
    "totalIncomingQty": 10,
    "stockValuePaise": 149900,
    "outOfStockCount": 3,
    "lowStockCount": 3,
    "reorderCount": 3,
    "activeReservationCount": 3,
    "expiringReservationCount": 3,
    "movementsLast24h": 1,
    "movementsLast7d": 1,
    "openPurchaseOrderCount": 3,
    "openPurchaseOrderValuePaise": 149900,
    "warehouses": [
      {
        "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "warehouseCode": "DIWALI20",
        "warehouseName": "Mumbai — Andheri East",
        "levelCount": 3,
        "onHandQty": 10,
        "reservedQty": 10,
        "availableQty": 10,
        "stockValuePaise": 149900,
        "outOfStockCount": 3,
        "lowStockCount": 3
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | Unparseable filter. |

---

### `GET /v1/admin/inventory`

**List stock levels**

| | |
|---|---|
| operationId | `adminListInventory` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

One row per (item, warehouse) — stock is per stockable per warehouse and there is no global figure, which is the single largest difference from the three conflicting stock fields this replaces.

`inventory_levels` is polymorphic: a row is a finished `variant`, a loose `hamper_item`, or a `packaging` material. Filter with `?kind=`.

`availableQty` is a GENERATED column (`on_hand_qty - reserved_qty`), so it cannot drift from the two numbers beside it. `?state=` filters on it: `out` is nothing sellable, `low` is at or below the reorder point, `in` is above. `?belowReorderPoint=true` is deliberately NOT the same filter — it uses the inventory position including incoming stock, which is the buying question rather than the selling one.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `sku` (default), `-availableQty`, `availableQty`, `onHandQty`, `reservedQty`, `-lastMovementAt`, `warehouse`. |
| `q` | `string` | no | min 1, max 120 | Matches SKU or item name, case-insensitively. |
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `locationId` | `uuid` | no | — | Restrict to one bin/shelf/rack/zone (`warehouse_locations.id`). |
| `kind` | `"variant" \| "hamper_item" \| "packaging"` | no | — | `inventory_levels` is polymorphic — a row is a finished `variant`, a loose `hamper_item`, or a `packaging` material. |
| `state` | `"in" \| "low" \| "out"` | no | — | `out` = nothing sellable · `low` = at or below the reorder point · `in` = above it. |
| `belowReorderPoint` | `"0" \| "1" \| "true" \| "false"` | no | — | `true` returns only levels at or below their reorder point — the buying queue. |

Example: `/v1/admin/inventory?page=…&perPage=…`

**Response `200`** — A page of stock levels.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "item": {
        "kind": "variant",
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set"
      },
      "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "warehouseCode": "DIWALI20",
      "warehouseName": "Mumbai — Andheri East",
      "binLocation": "A/R3/S2",
      "locationId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "onHandQty": 10,
      "reservedQty": 10,
      "availableQty": 10,
      "incomingQty": 10,
      "reorderPoint": 1,
      "reorderQty": 10,
      "state": "in",
      "unitCostPaise": 149900,
      "stockValuePaise": 149900,
      "lastMovementAt": "2026-08-25T10:30:00.000Z"
    }
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
| `400` | An unrecognised filter value. |

---

### `GET /v1/admin/inventory/movements`

**The stock ledger**

| | |
|---|---|
| operationId | `adminListStockMovements` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Append-only. Every change to on-hand stock is exactly one row here, and nothing ever updates or deletes one — a correction is a NEW movement with the opposite sign (§10). That is what makes `balanceAfter` trustworthy: the running on-hand balance immediately after each movement, from which any historical position can be reconstructed without replaying the whole table.

Reservations do NOT appear here. A hold moves `reservedQty` and nothing physical has moved, so a ledger row for it would double-count against `balanceAfter` the moment the goods actually shipped.

`?movementType=` and `?referenceType=` take comma-separated lists; an unrecognised value is a 400 rather than a silently empty page. `?referenceId=` returns everything one document did — one order, one goods receipt, one transfer. Movement ids are BIGINT and travel as decimal STRINGS; a JSON number would lose precision past 2^53.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-occurredAt` (default), `occurredAt`, `quantityDelta`, `-id`. |
| `q` | `string` | no | min 1, max 120 | Matches SKU, item name or `referenceLabel`. |
| `sku` | `string` | no | max 64 | One SKU. The whole history for one item. |
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `movementType` | `string` | no | max 200 | One type or a comma-separated list: `?movementType=damage,loss`. An unknown value is a 400, not an empty page. |
| `referenceType` | `string` | no | max 200 | One type or a comma-separated list. |
| `referenceId` | `uuid` | no | — | Everything a single document did — one order, one GRN, one transfer. |
| `actorId` | `uuid` | no | — | Movements recorded by one staff member. |
| `from` | `string` | no | — | ISO date or timestamp. Inclusive lower bound on `occurredAt`. |
| `to` | `string` | no | — | ISO date or timestamp. Inclusive upper bound on `occurredAt`. |

Example: `/v1/admin/inventory/movements?page=…&perPage=…`

**Response `200`** — A page of ledger entries, newest first.

```json
{
  "type": "success",
  "result": [
    {
      "id": "string",
      "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "item": {
        "kind": "variant",
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set"
      },
      "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "warehouseCode": "DIWALI20",
      "movementType": "inbound",
      "quantityDelta": 10,
      "balanceAfter": 1,
      "referenceType": "purchase_order",
      "referenceId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "referenceLabel": "string",
      "note": "Damaged in transit",
      "actorId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "occurredAt": "2026-08-25T10:30:00.000Z"
    }
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
| `400` | An unrecognised movement type, reference type, or an unparseable date. |

---

### `GET /v1/admin/inventory/movements/:movementId`

**Get one ledger entry**

| | |
|---|---|
| operationId | `adminGetStockMovement` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The single movement, with the item, warehouse and document it belongs to resolved. There is no PATCH and no DELETE beside it, and there never will be — see the ledger note on the list endpoint.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `movementId` | `string` | **yes** | — | Movement id. `stock_movements.id` is a BIGINT identity, so it travels as a decimal string — a JSON number would silently lose precision past 2^53. |

**Response `200`** — The movement.

```json
{
  "type": "success",
  "result": {
    "id": "string",
    "inventoryLevelId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "item": {
      "kind": "variant",
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set"
    },
    "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "warehouseCode": "DIWALI20",
    "movementType": "inbound",
    "quantityDelta": 10,
    "balanceAfter": 1,
    "referenceType": "purchase_order",
    "referenceId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "referenceLabel": "string",
    "note": "Damaged in transit",
    "actorId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "occurredAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such movement. |

---

### `POST /v1/admin/inventory/adjustments`

**Adjust stock**

| | |
|---|---|
| operationId | `adminAdjustInventory` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

One transaction: lock the level, validate, update `inventory_levels`, append the movement with the balance the update actually returned, commit. There is no path where the level moves and the ledger does not.

A decrement that would take SELLABLE stock below zero is refused with the stable code `insufficient_stock` — note *sellable*, not on-hand: units already reserved for a paid order are physically present but spoken for, and letting an adjustment eat them turns someone else’s confirmed order into a stockout at picking time. The refusal is enforced by a conditional `UPDATE … WHERE on_hand − reserved + delta >= 0` whose affected-row count is checked, which is race-free at READ COMMITTED; the `inventory_no_oversell` CHECK behind it is a backstop, never flow control.

`movementType` is restricted to the seven types a human may post by hand. Transfer and production types are excluded because each is half of a pair that must move together, and `stock_count` is excluded because §40 says a count posts its variance only through approval.

To undo an adjustment, post the opposite one. The ledger is append-only and this endpoint will never edit a movement.

Requires an `Idempotency-Key`. A retry with the same key and body replays the stored response; the same key with a different body is a 409, because silently returning the first response would hide a client bug that is about to double-adjust something.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `sku` | `string` | **yes** | min 1, max 64 | The item to adjust. |
| `warehouseId` | `uuid` | **yes** | — | Which warehouse’s stock moved. Stock is per item × warehouse; there is no global figure to adjust. |
| `quantityDelta` | `integer` | **yes** | ≥ -9007199254740991 | Signed change. Positive adds, negative removes. Never zero — the ledger CHECK rejects a movement of nothing. |
| `movementType` | `"adjustment" \| "inbound" \| "outbound" \| "damage" \| "return_in" \| "loss" \| "found"` | no | default `"adjustment"` | Why the stock moved, in the ledger’s vocabulary. Transfer, production and stock-count types are not adjustable by hand — each writes two coordinated rows or requires an approval. |
| `reason` | `string` | **yes** | min 3, max 400 | Required. Goes on the movement as `note` and into the activity log. An adjustment with no stated reason is indistinguishable from an error. |
| `referenceType` | `"purchase_order" \| "goods_receipt" \| "order" \| "stock_transfer" \| "return" \| "adjustment" \| "import" \| "production_order" \| "stock_count" \| "purchase_return"` | no | — | The kind of document this adjustment answers to, if any. |
| `referenceId` | `uuid` | no | — | That document’s id. |
| `referenceLabel` | `string` | no | max 64 | Human-readable document number for the ledger screen — `PO-2026-02291`, `ACH104422`. |

Example request:

```json
{
  "sku": "ACH-CAN-001",
  "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "quantityDelta": 10,
  "movementType": "adjustment",
  "reason": "Damaged in transit",
  "referenceType": "purchase_order",
  "referenceId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "referenceLabel": "string"
}
```

**Response `200`** — The level after the change, and the movement it wrote.

```json
{
  "type": "success",
  "result": {
    "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "item": {
      "kind": "variant",
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set"
    },
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "movementId": "string",
    "movementType": "inbound",
    "quantityDelta": 10,
    "onHandQtyBefore": 10,
    "onHandQty": 10,
    "reservedQty": 10,
    "availableQty": 10,
    "balanceAfter": 1,
    "occurredAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | Missing or malformed `Idempotency-Key`. |
| `404` | No such SKU, or no such warehouse. |
| `409` | That `Idempotency-Key` was used with a different body, or a first attempt is still in flight. |
| `422` | `insufficient_stock`, or the item is not stocked at that warehouse (`no_inventory_level`). |

---

### `POST /v1/admin/inventory/bulk-adjust`

**Adjust many SKUs at once**

| | |
|---|---|
| operationId | `adminBulkAdjustInventory` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

All-or-nothing in ONE transaction — unlike the order desk’s bulk action, which reports per-order outcomes. Stock is different: a stocktake correction that half-applied leaves a warehouse in a state nobody chose and nobody can describe. Every line succeeds or nothing is written.

**Each SKU still gets its own movement row.** The batch is a unit of atomicity, not a unit of bookkeeping; one movement covering fifty SKUs would be unusable for reconciling any of them.

Levels are locked in a single statement in ascending `inventory_level_id` order, and the work is sorted the same way. Without that, batch A holding level 1 and wanting level 2 deadlocks against batch B holding 2 and wanting 1 — PostgreSQL would detect it and abort one, but a `deadlock_timeout` stall is not an acceptable way to find out (§62).

Every (`sku`, `warehouseId`) pair must be distinct. Two deltas against one level in one batch is ambiguous about which movement’s `balanceAfter` comes first, so it is refused rather than guessed at.

Validation is front-loaded: unknown SKUs and items not stocked at the named warehouse come back as field-level issues BEFORE any lock is taken.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `reason` | `string` | **yes** | min 3, max 400 | Applies to every line. A single stated reason is what makes a fifty-line correction reviewable later. |
| `movementType` | `"adjustment" \| "inbound" \| "outbound" \| "damage" \| "return_in" \| "loss" \| "found"` | no | default `"adjustment"` | Default type for lines that do not name their own. |
| `referenceType` | `"purchase_order" \| "goods_receipt" \| "order" \| "stock_transfer" \| "return" \| "adjustment" \| "import" \| "production_order" \| "stock_count" \| "purchase_return"` | no | — | Applies to every line. |
| `referenceId` | `uuid` | no | — | Applies to every line. |
| `referenceLabel` | `string` | no | max 64 | Applies to every line. |
| `adjustments` | `object[]` | **yes** | min 1 items, max 200 items | At most 200 lines. Every (`sku`, `warehouseId`) pair must be distinct — two deltas against one level in one batch is ambiguous, so it is refused rather than guessed at. |

Example request:

```json
{
  "reason": "Damaged in transit",
  "movementType": "adjustment",
  "referenceType": "purchase_order",
  "referenceId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "referenceLabel": "string",
  "adjustments": [
    {
      "sku": "ACH-CAN-001",
      "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "quantityDelta": 10,
      "movementType": "adjustment",
      "note": "Damaged in transit"
    }
  ]
}
```

**Response `200`** — One result per line, in the deterministic lock order.

```json
{
  "type": "success",
  "result": {
    "applied": 1,
    "totalQuantityDelta": 10,
    "results": [
      {
        "inventoryLevelId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "item": {
          "kind": "variant",
          "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
          "sku": "ACH-CAN-001",
          "name": "Brass Diya Set"
        },
        "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "movementId": "string",
        "movementType": "inbound",
        "quantityDelta": 10,
        "onHandQtyBefore": 10,
        "onHandQty": 10,
        "reservedQty": 10,
        "availableQty": 10,
        "balanceAfter": 1,
        "occurredAt": "2026-08-25T10:30:00.000Z"
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | Missing or malformed `Idempotency-Key`. |
| `404` | A warehouse in the batch does not exist. |
| `409` | That `Idempotency-Key` was used with a different body. |
| `422` | `unknown_sku`, `duplicate_target`, `no_inventory_level`, or `insufficient_stock` on any line — nothing was written. |

---

### `GET /v1/admin/inventory/alerts/low-stock`

**Low-stock alerts**

| | |
|---|---|
| operationId | `adminListLowStock` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Levels with sellable stock above zero but at or below their reorder point — the ones that will run out, ordered most urgent first. Backed by the partial index `idx_inventory_low`, so this stays cheap as the catalogue grows.

An item at zero is NOT here; it is already out, and mixing the two makes the list unusable as a work queue. See `/alerts/out-of-stock`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `availableQty` (default, most urgent first), `sku`, `-shortfallQty`. |
| `q` | `string` | no | min 1, max 120 | Matches SKU or item name. |
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `kind` | `"variant" \| "hamper_item" \| "packaging"` | no | — | Restrict to variants, hamper items or packaging. |

Example: `/v1/admin/inventory/alerts/low-stock?page=…&perPage=…`

**Response `200`** — A page of low-stock levels.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "item": {
        "kind": "variant",
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set"
      },
      "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "warehouseCode": "DIWALI20",
      "warehouseName": "Mumbai — Andheri East",
      "binLocation": "A/R3/S2",
      "locationId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "onHandQty": 10,
      "reservedQty": 10,
      "availableQty": 10,
      "incomingQty": 10,
      "reorderPoint": 1,
      "reorderQty": 10,
      "state": "in",
      "unitCostPaise": 149900,
      "stockValuePaise": 149900,
      "lastMovementAt": "2026-08-25T10:30:00.000Z"
    }
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
| `400` | An unrecognised filter value. |

---

### `GET /v1/admin/inventory/alerts/out-of-stock`

**Out-of-stock alerts**

| | |
|---|---|
| operationId | `adminListOutOfStock` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Levels with nothing sellable — `availableQty <= 0`. A row can appear here while `onHandQty` is positive: every unit is reserved. That is the honest reading, because those units are already promised and cannot be sold again.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `availableQty` (default, most urgent first), `sku`, `-shortfallQty`. |
| `q` | `string` | no | min 1, max 120 | Matches SKU or item name. |
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `kind` | `"variant" \| "hamper_item" \| "packaging"` | no | — | Restrict to variants, hamper items or packaging. |

Example: `/v1/admin/inventory/alerts/out-of-stock?page=…&perPage=…`

**Response `200`** — A page of out-of-stock levels.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "item": {
        "kind": "variant",
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set"
      },
      "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "warehouseCode": "DIWALI20",
      "warehouseName": "Mumbai — Andheri East",
      "binLocation": "A/R3/S2",
      "locationId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "onHandQty": 10,
      "reservedQty": 10,
      "availableQty": 10,
      "incomingQty": 10,
      "reorderPoint": 1,
      "reorderQty": 10,
      "state": "in",
      "unitCostPaise": 149900,
      "stockValuePaise": 149900,
      "lastMovementAt": "2026-08-25T10:30:00.000Z"
    }
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
| `400` | An unrecognised filter value. |

---

### `GET /v1/admin/inventory/reorder`

**What to buy**

| | |
|---|---|
| operationId | `adminListReorderSuggestions` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The buying queue. A level qualifies when its inventory POSITION — `on hand − reserved + incoming` — is at or below its reorder point. Incoming counts, otherwise every item with a purchase order already in flight is re-ordered, which is how a warehouse ends up with four months of ribbon. Reserved does not count as cover, because those units are leaving the building.

The formula lives in ONE documented function (`reorderSuggestion` in `admin-inventory.stock.ts`), shared with the purchase-draft endpoint, so the alert screen and the order that follows it can never disagree:

```
target    = reorderPoint + reorderQty
shortfall = max(0, target - position)
suggested = ceil(max(shortfall, 1) / moq) * moq
```

Suggestions are rounded UP to the supplier’s MOQ, never down — a purchase order the supplier will reject is not a saving. The supplier shown is the one flagged preferred (`supplier_products` has a partial unique index guaranteeing at most one per variant), falling back to the cheapest with `isPreferredSupplier: false` so the buyer can see the difference.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-shortfallQty` (default), `sku`, `leadTimeDays`. |
| `q` | `string` | no | min 1, max 120 | Matches SKU or item name. |
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `supplierId` | `uuid` | no | — | Only items whose preferred supplier is this one — one buyer’s worklist. |

Example: `/v1/admin/inventory/reorder?page=…&perPage=…`

**Response `200`** — A page of reorder suggestions, biggest shortfall first.

```json
{
  "type": "success",
  "result": [
    {
      "inventoryLevelId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "item": {
        "kind": "variant",
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set"
      },
      "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "warehouseCode": "DIWALI20",
      "onHandQty": 10,
      "reservedQty": 10,
      "availableQty": 10,
      "incomingQty": 10,
      "inventoryPosition": 1,
      "reorderPoint": 1,
      "reorderQty": 10,
      "targetLevel": 1,
      "shortfallQty": 10,
      "suggestedQty": 10,
      "moq": 1,
      "leadTimeDays": 30,
      "supplierId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "supplierName": "Kraft & Co Packaging",
      "supplierSku": "ACH-CAN-001",
      "isPreferredSupplier": false,
      "unitCostPaise": 149900,
      "estimatedCostPaise": 149900
    }
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
| `400` | An unrecognised filter value. |

---

### `POST /v1/admin/inventory/reorder/purchase-draft`

**Draft a purchase order from the reorder suggestions**

| | |
|---|---|
| operationId | `adminCreatePurchaseDraft` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

Creates ONE purchase order with status `draft` for one supplier and one warehouse. **It never sends anything to a supplier** — that is `POST /purchase-orders/:poId/send`, behind its own permission. A draft is a document a buyer reviews and edits.

With no `lines`, the draft is generated from the reorder engine: everything this supplier supplies that is at or below its reorder point in this warehouse, at the suggested quantity, optionally narrowed with `skus`. With `lines`, the buyer’s quantities are used instead — but still rounded UP to the supplier’s MOQ.

Nothing to order is a 422 (`nothing_to_order`), not an empty purchase order: an empty document in the PO list is a false signal that someone ordered something.

`taxPaise` is always 0 on a draft. GST is resolved when the goods are received and invoiced, and a guessed figure here would be a statutory number nobody computed. The number comes from `document_number_series` under a row lock; no active series for the year is a 422 rather than an improvised number that collides with the real series later.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `supplierId` | `uuid` | **yes** | — | Who to buy from. Required — a draft with no supplier has no cost, no MOQ and no lead time, which is most of what a purchase order is. |
| `warehouseId` | `uuid` | **yes** | — | Which warehouse the goods are being bought for. |
| `expectedOn` | `string` | no | — | `YYYY-MM-DD`. Defaults to today plus the supplier’s longest lead time across the drafted lines. |
| `notes` | `string` | no | max 2000 | Internal note on the draft. |
| `skus` | `string[]` | no | max 200 items | Restrict the generated draft to these SKUs. Omit to draft every item this supplier supplies that is at or below its reorder point in this warehouse. |
| `lines` | `object[]` | no | min 1 items, max 200 items | Explicit lines, overriding the reorder engine entirely. Quantities are still rounded UP to the supplier’s MOQ — a purchase order the supplier will reject is not a saving. |

Example request:

```json
{
  "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "expectedOn": "2026-11-01",
  "notes": "Damaged in transit",
  "skus": [
    "ACH-CAN-001"
  ],
  "lines": [
    {
      "sku": "ACH-CAN-001",
      "quantity": 10,
      "unitCostPaise": 149900
    }
  ]
}
```

**Response `201`** — The draft purchase order and its lines.

```json
{
  "type": "success",
  "result": {
    "purchaseOrderId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "poNo": "PRD-2026-00001",
    "status": "draft",
    "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "supplierName": "Kraft & Co Packaging",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "expectedOn": "2026-11-01",
    "subtotalPaise": 149900,
    "taxPaise": 149900,
    "totalPaise": 149900,
    "lines": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "description": "Free-text description.",
        "orderedQty": 10,
        "moq": 1,
        "unitCostPaise": 149900,
        "lineTotalPaise": 149900
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such supplier, or no such warehouse. |
| `422` | `nothing_to_order`, `unknown_sku`, `supplier_archived`, or `no_document_series`. |

---

### `GET /v1/admin/inventory/reservations`

**List stock holds**

| | |
|---|---|
| operationId | `adminListInventoryReservations` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Every hold against stock, whatever placed it: a `cart` (which expires), an `order` (which never does), a `quotation`, or a `manual_hold` placed here.

`?status=active` — the default — means unreleased AND unexpired, which is the set actually consuming `reservedQty` right now. `released` and `expired` are separate because they are different questions: one was let go deliberately, the other simply lapsed.

This is the screen to open when `onHandQty` is healthy and `availableQty` is not.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-createdAt` (default), `createdAt`, `expiresAt`, `quantity`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `sku` | `string` | no | max 64 | Holds against one SKU. |
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `reason` | `"cart" \| "order" \| "manual_hold" \| "quotation"` | no | — | `cart` (expires) · `order` (never expires) · `manual_hold` · `quotation`. |
| `status` | `"active" \| "released" \| "expired" \| "all"` | no | default `"active"` | `active` (default) is unreleased and unexpired — the holds that are actually consuming stock right now. |

Example: `/v1/admin/inventory/reservations?page=…&perPage=…`

**Response `200`** — A page of holds.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "item": {
        "kind": "variant",
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set"
      },
      "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "warehouseCode": "DIWALI20",
      "quantity": 10,
      "reason": "cart",
      "cartId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "orderId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "expiresAt": "2026-08-25T10:30:00.000Z",
      "releasedAt": "2026-08-25T10:30:00.000Z",
      "isActive": false,
      "createdAt": "2026-08-25T10:30:00.000Z"
    }
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
| `400` | An unrecognised filter value. |

---

### `POST /v1/admin/inventory/reservations`

**Hold stock by hand**

| | |
|---|---|
| operationId | `adminCreateInventoryReservation` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Puts units beyond the reach of the storefront — for a corporate quote being negotiated, a photoshoot, a replacement being held for a support case.

**A hold moves `reservedQty` and nothing else.** `onHandQty` is untouched, because the units have not moved, and NO `stock_movements` row is written: the ledger records physical movement, and a hold in it would double-count against `balanceAfter` the moment the goods actually shipped (§14). The effect is recorded in the activity log instead, where the before/after pair shows `onHandQty` unchanged.

The hold is refused with `insufficient_stock` when it will not fit in current sellable stock, using the same conditional-UPDATE guard as an adjustment.

The reason is always `manual_hold`. The `reservation_has_owner` CHECK requires a cart or an order for every other reason, and this endpoint has neither — cart and order holds are placed by checkout, inside the transaction that creates them.

Omit `expiresAt` for an open-ended hold. Note that the expiry sweeper only touches holds that carry one, so an open-ended hold stays until a person releases it — which is the point, and also the risk.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `sku` | `string` | **yes** | min 1, max 64 | The item to hold. |
| `warehouseId` | `uuid` | **yes** | — | Which warehouse the units are held in. |
| `quantity` | `integer` | **yes** | > 0, ≤ 1000000 | How many units to hold. Must fit inside current sellable stock. |
| `expiresAt` | `date-time` | no | — | When the hold lapses. Omit for an open-ended hold; the sweeper only releases holds that carry an expiry, so an open-ended one stays until someone releases it. |
| `note` | `string` | no | max 400 | Why this stock is being held. Recorded in the activity log. |

Example request:

```json
{
  "sku": "ACH-CAN-001",
  "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "quantity": 10,
  "expiresAt": "2026-08-25T10:30:00.000Z",
  "note": "Damaged in transit"
}
```

**Response `201`** — The hold.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "inventoryLevelId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "item": {
      "kind": "variant",
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set"
    },
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseCode": "DIWALI20",
    "quantity": 10,
    "reason": "cart",
    "cartId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "orderId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "expiresAt": "2026-08-25T10:30:00.000Z",
    "releasedAt": "2026-08-25T10:30:00.000Z",
    "isActive": false,
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | Missing or malformed `Idempotency-Key`. |
| `404` | No such SKU, or no such warehouse. |
| `409` | That `Idempotency-Key` was used with a different body. |
| `422` | `insufficient_stock`, `no_inventory_level`, or `expiry_in_past`. |

---

### `POST /v1/admin/inventory/reservations/:id/release`

**Release a stock hold**

| | |
|---|---|
| operationId | `adminReleaseInventoryReservation` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Stamps `releasedAt` and returns the units to sellable stock in one transaction, under the level’s row lock so the decrement cannot interleave with a checkout reserving the same level.

Releasing an already-released hold is a 422, not a silent success. Decrementing `reservedQty` twice for one hold is exactly how phantom inventory appears — stock the system believes is sellable and the shelf does not have.

Works on any hold, including one placed by a cart or an order. Releasing an order-backed hold does not cancel the order; if that is what you meant, cancel the order and let it release its own stock.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `id` | `uuid` | **yes** | — | Reservation id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `reason` | `string` | no | max 400 | Why the hold is being lifted. Recorded in the activity log. |

Example request:

```json
{
  "reason": "Damaged in transit"
}
```

**Response `200`** — The hold, after release.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "inventoryLevelId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "item": {
      "kind": "variant",
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set"
    },
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseCode": "DIWALI20",
    "quantity": 10,
    "reason": "cart",
    "cartId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "orderId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "expiresAt": "2026-08-25T10:30:00.000Z",
    "releasedAt": "2026-08-25T10:30:00.000Z",
    "isActive": false,
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such reservation. |
| `422` | `reservation_already_released`. |

---

### `GET /v1/admin/inventory/audit`

**Who changed stock, and what the numbers were**

| | |
|---|---|
| operationId | `adminListInventoryAudit` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The STATE-level trail from `activity_logs`, restricted to inventory entities. Each entry carries `beforeData` and `afterData` as queryable JSONB — the actual quantities — rather than a rendered string like "₹12,400 → ₹11,900" that cannot be diffed, queried or replayed.

This is complementary to the automatic request-level audit `defineRoute` applies to every non-GET admin route, not a duplicate of it. A request log records who called what from where; it cannot tell you what the number was. This one can, and cannot tell you the IP.

Distinct from `/movements` too: the ledger is the record of PHYSICAL movement and includes system movements with no human behind them. This is the record of human action, and includes reservations, which never touch the ledger.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-occurredAt` (default) or `occurredAt`. |
| `q` | `string` | no | min 1, max 120 | Matches the entity label or the action. |
| `action` | `string` | no | max 120 | e.g. `inventory.adjusted`, `inventory.reserved`, `inventory.released`. |
| `entityId` | `uuid` | no | — | Everything recorded against one inventory level. |
| `actorStaffId` | `uuid` | no | — | Everything one staff member did to stock. |
| `from` | `string` | no | — | ISO date or timestamp, inclusive. |
| `to` | `string` | no | — | ISO date or timestamp, inclusive. |

Example: `/v1/admin/inventory/audit?page=…&perPage=…`

**Response `200`** — A page of audit entries, newest first.

```json
{
  "type": "success",
  "result": [
    {
      "id": "string",
      "occurredAt": "2026-08-25T10:30:00.000Z",
      "action": "approve",
      "actorLabel": "string",
      "actorRole": "string",
      "actorStaffId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "entityType": "string",
      "entityId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "entityLabel": "string",
      "beforeData": null,
      "afterData": null,
      "changedFields": [
        "string"
      ],
      "requestId": "string"
    }
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
| `400` | An unparseable date bound. |

---

### `GET /v1/admin/inventory/notifications`

**Inventory notifications**

| | |
|---|---|
| operationId | `adminListInventoryNotifications` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The inventory slice of the staff notification feed — stockouts, low-stock warnings, expiring holds, overdue purchase orders.

Returns both notifications addressed to you personally and broadcasts (`staff_user_id IS NULL`). Filtering to "mine only" would hide every broadcast stockout alert, which is most of them.

Read-only here. Marking one read belongs to the notification module, which owns the whole feed.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-createdAt` (default) or `createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `unreadOnly` | `"0" \| "1" \| "true" \| "false"` | no | — | `true` returns only notifications with no `readAt`. |
| `priority` | `"high" \| "normal" \| "low"` | no | — | Restrict to one priority. |

Example: `/v1/admin/inventory/notifications?page=…&perPage=…`

**Response `200`** — A page of notifications, newest first.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "kind": "inventory",
      "priority": "high",
      "title": "Brass Diya Set",
      "body": "string",
      "linkUrl": "https://cdn.achichiz.in/media/diya.jpg",
      "entityType": "string",
      "entityId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "readAt": "2026-08-25T10:30:00.000Z",
      "createdAt": "2026-08-25T10:30:00.000Z"
    }
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
| `400` | An unrecognised filter value. |

---

### `GET /v1/admin/inventory/export`

**Export stock levels**

| | |
|---|---|
| operationId | `adminExportInventory` |
| Auth | Bearer staff token |
| Permission | `inventory:export` |

A flat file of the current position, for the spreadsheet the warehouse actually works from. `csv` by default, delivered as an attachment with CRLF line endings and every field quoted — an unquoted bin location containing a comma silently shifts every column after it, which is the classic way an export becomes wrong without looking wrong.

Money stays in integer paise, unconverted. A CSV that says `149900` is unambiguous; one that says `1499.00` has already made a rounding decision on the reader’s behalf.

Capped at 50,000 rows and gated on `inventory:export`, which is a separate grant from `inventory:view` — reading one screen and walking out with the whole stock position are different acts. The `export` rate limiter allows 20 per hour per user.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `format` | `"csv" \| "json"` | no | default `"csv"` | `csv` (default, a downloadable attachment) or `json`. |
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `kind` | `"variant" \| "hamper_item" \| "packaging"` | no | — | Restrict to variants, hamper items or packaging. |
| `state` | `"in" \| "low" \| "out"` | no | — | Export only `out`, `low` or `in` rows. |
| `limit` | `integer` | no | default `10000`, > 0, ≤ 50000 | Row cap. Maximum 50,000 — an unbounded export of a growing table is an outage waiting for a slow month. |

**Response `200`** — A CSV attachment, or the same rows as JSON when `?format=json`.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "item": {
        "kind": "variant",
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set"
      },
      "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "warehouseCode": "DIWALI20",
      "warehouseName": "Mumbai — Andheri East",
      "binLocation": "A/R3/S2",
      "locationId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "onHandQty": 10,
      "reservedQty": 10,
      "availableQty": 10,
      "incomingQty": 10,
      "reorderPoint": 1,
      "reorderQty": 10,
      "state": "in",
      "unitCostPaise": 149900,
      "stockValuePaise": 149900,
      "lastMovementAt": "2026-08-25T10:30:00.000Z"
    }
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
| `400` | An unrecognised filter value. |

---

### `GET /v1/admin/inventory/:sku/availability`

**Can we promise this?**

| | |
|---|---|
| operationId | `adminGetSkuAvailability` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The narrow question, answered per warehouse and across the network. Pass `?quantity=` to get a straight yes or no.

`canFulfil` is true when ONE warehouse can cover the quantity. `canFulfilAcrossWarehouses` is true when the network total covers it. They are reported separately and deliberately not conflated: the second needs a split shipment to be true, which is a fulfilment decision with a real cost attached, not an availability fact.

`state` is the `in`/`low`/`out` value the STOREFRONT should surface (§16). Never publish the raw number: it invites scraping the whole catalogue’s stock position, and it is wrong the instant someone else’s cart holds two of them.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `sku` | `string` | **yes** | min 1, max 64 | Stock-keeping unit. Resolved against `product_variants.sku` first, then `hamper_items.sku`, then `packaging_materials.sku`. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse. |
| `quantity` | `integer` | no | > 0, ≤ 1000000 | Ask a yes/no question: can this many units be promised right now? Sets `canFulfil` per warehouse and overall. |

**Response `200`** — Availability, per warehouse and in total.

```json
{
  "type": "success",
  "result": {
    "item": {
      "kind": "variant",
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set"
    },
    "totalOnHandQty": 10,
    "totalReservedQty": 10,
    "totalAvailableQty": 10,
    "totalIncomingQty": 10,
    "state": "in",
    "requestedQty": 10,
    "canFulfil": false,
    "canFulfilAcrossWarehouses": false,
    "warehouses": [
      {
        "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "warehouseCode": "DIWALI20",
        "warehouseName": "Mumbai — Andheri East",
        "onHandQty": 10,
        "reservedQty": 10,
        "availableQty": 10,
        "incomingQty": 10,
        "state": "in",
        "canFulfil": false
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No active item carries that SKU. |

---

### `GET /v1/admin/inventory/:sku`

**Everything about one SKU**

| | |
|---|---|
| operationId | `adminGetInventoryBySku` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The whole workspace in one call: the warehouse-by-warehouse breakdown, the last twenty ledger entries across every warehouse, every hold currently consuming stock, and the open purchase-order lines still owed.

The SKU is resolved against `product_variants.sku` first, then `hamper_items.sku`, then `packaging_materials.sku` — the three things this business stocks. Each has a partial unique index excluding soft-deleted rows, so a discontinued item never shadows a live one.

`incoming` lists only OPEN purchase-order lines (`draft`, `sent`, `partially_received`) with `outstandingQty` computed from absolute quantities, not the percentage the old console stored. A received or cancelled order is not incoming stock.

Declared last of the GET routes so that `/movements`, `/alerts/*`, `/reorder`, `/reservations`, `/audit`, `/notifications`, `/export` and `/dashboard` are matched as the literals they are.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `sku` | `string` | **yes** | min 1, max 64 | Stock-keeping unit. Resolved against `product_variants.sku` first, then `hamper_items.sku`, then `packaging_materials.sku`. |

**Response `200`** — The item, its levels, its recent history and what is inbound.

```json
{
  "type": "success",
  "result": {
    "item": {
      "kind": "variant",
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set"
    },
    "totalOnHandQty": 10,
    "totalReservedQty": 10,
    "totalAvailableQty": 10,
    "totalIncomingQty": 10,
    "totalStockValuePaise": 149900,
    "state": "in",
    "levels": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "item": {
          "kind": "variant",
          "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
          "sku": "ACH-CAN-001",
          "name": "Brass Diya Set"
        },
        "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "warehouseCode": "DIWALI20",
        "warehouseName": "Mumbai — Andheri East",
        "binLocation": "A/R3/S2",
        "locationId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "onHandQty": 10,
        "reservedQty": 10,
        "availableQty": 10,
        "incomingQty": 10,
        "reorderPoint": 1,
        "reorderQty": 10,
        "state": "in",
        "unitCostPaise": 149900,
        "stockValuePaise": 149900,
        "lastMovementAt": "2026-08-25T10:30:00.000Z"
      }
    ],
    "recentMovements": [
      {
        "id": "string",
        "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "item": {
          "kind": "variant",
          "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
          "sku": "ACH-CAN-001",
          "name": "Brass Diya Set"
        },
        "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "warehouseCode": "DIWALI20",
        "movementType": "inbound",
        "quantityDelta": 10,
        "balanceAfter": 1,
        "referenceType": "purchase_order",
        "referenceId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "referenceLabel": "string",
        "note": "Damaged in transit",
        "actorId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "occurredAt": "2026-08-25T10:30:00.000Z"
      }
    ],
    "reservations": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "item": {
          "kind": "variant",
          "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
          "sku": "ACH-CAN-001",
          "name": "Brass Diya Set"
        },
        "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "warehouseCode": "DIWALI20",
        "quantity": 10,
        "reason": "cart",
        "cartId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "orderId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "expiresAt": "2026-08-25T10:30:00.000Z",
        "releasedAt": "2026-08-25T10:30:00.000Z",
        "isActive": false,
        "createdAt": "2026-08-25T10:30:00.000Z"
      }
    ],
    "incoming": [
      {
        "purchaseOrderId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "poNo": "PRD-2026-00001",
        "supplierName": "Kraft & Co Packaging",
        "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "status": "active",
        "orderedQty": 10,
        "receivedQty": 10,
        "outstandingQty": 10,
        "expectedOn": "2026-11-01"
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No active item carries that SKU. |

---
