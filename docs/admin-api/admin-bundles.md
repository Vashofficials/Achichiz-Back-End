# Admin bundles

6 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/bundles`](#get-v1-admin-bundles) — List bundles
- [`POST /v1/admin/bundles`](#post-v1-admin-bundles) — Create a bundle
- [`GET /v1/admin/bundles/:bundleId/availability`](#get-v1-admin-bundles-bundleid-availability) — How many of this bundle can we ship?
- [`POST /v1/admin/bundles/:bundleId/archive`](#post-v1-admin-bundles-bundleid-archive) — Archive a bundle
- [`GET /v1/admin/bundles/:bundleId`](#get-v1-admin-bundles-bundleid) — Get one bundle
- [`PATCH /v1/admin/bundles/:bundleId`](#patch-v1-admin-bundles-bundleid) — Update a bundle

---

### `GET /v1/admin/bundles`

**List bundles**

| | |
|---|---|
| operationId | `adminListBundles` |
| Auth | Bearer staff token |
| Permission | `promotions:view` |

Every bundle with its contents summarised — `itemCount` distinct variants, `unitCount` units in the box — and the saving worked out.

`savingsPaise` is DERIVED on every read (`SUM(component price × quantity) − bundlePrice`) and is not a column. A component’s price changes without the bundle being touched, and a stored saving would then be advertising a discount that no longer exists. A negative saving is returned as-is: it means the box costs more than its parts, which is a pricing mistake worth seeing rather than clamping to zero.

`isLive` is not `status`. A bundle is sellable when it is `active` AND inside its `startsAt`/`endsAt` window; a window that has closed leaves the status untouched, so filtering on `status=active` alone returns bundles nobody can buy. `?live=true` applies the real test.

`?variantId=` returns every bundle containing that variant — the question to ask before discontinuing it.

There is no stock figure on this screen. Ask `/availability` per bundle.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `createdAt` (default, descending), `name`, `handle`, `bundlePricePaise`, `startsAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `status` | `string` | no | max 120 | One status or a comma-separated list: `active`, `draft`, `archived`. |
| `includeArchived` | `"true" \| "false"` | no | default `"false"` | Include soft-deleted bundles. Archived-by-status is a separate thing — use `status`. |
| `live` | `"true" \| "false"` | no | — | `true` returns only bundles sellable right now: status `active` AND inside the `startsAt`/`endsAt` window. A bundle whose window has closed is still `active` in the column — the schedule is what expires it, not the status. |
| `variantId` | `uuid` | no | — | Only bundles that contain this variant. The question to ask before discontinuing one. |

Example: `/v1/admin/bundles?page=…&perPage=…`

**Response `200`** — A page of bundles.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "handle": "brass-diya-set",
      "name": "Brass Diya Set",
      "bundlePricePaise": 149900,
      "componentTotalPaise": 149900,
      "savingsPaise": 149900,
      "savingsBp": 1000,
      "status": "active",
      "isLive": false,
      "itemCount": 3,
      "unitCount": 3,
      "startsAt": "2026-08-25T10:30:00.000Z",
      "endsAt": "2026-08-25T10:30:00.000Z",
      "archivedAt": "2026-08-25T10:30:00.000Z",
      "createdAt": "2026-08-25T10:30:00.000Z",
      "updatedAt": "2026-08-25T10:30:00.000Z"
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
| `400` | An unrecognised status value. |

---

### `POST /v1/admin/bundles`

**Create a bundle**

| | |
|---|---|
| operationId | `adminCreateBundle` |
| Auth | Bearer staff token |
| Permission | `promotions:create` |

The bundle and its contents in ONE transaction. A bundle with no items is refused by the schema rather than created empty: an empty bundle has no components to compute availability from, and the honest answer for it would be `fulfillableQty: 0` forever.

`items` is validated before anything is written. A duplicate variant collides with `PRIMARY KEY (bundle_id, variant_id)` and a discontinued variant would produce a bundle that can never ship; both come back as field-level issues instead of a constraint violation from three layers down.

**No stock row is created.** That is the point of the module — see §91 and `/availability`.

Handles are partial-unique among non-archived bundles, so archiving one frees its slug for a replacement. A clash with a live bundle is a 409.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | **yes** | min 2, max 80 | URL slug. Partial-unique among non-deleted bundles. |
| `name` | `string` | **yes** | min 2, max 160 | Display name. |
| `bundlePricePaise` | `integer` | **yes** | ≥ 0 | Integer paise. What the customer pays for the whole box. 149900 = ₹1,499.00. |
| `status` | `"active" \| "draft" \| "archived"` | no | default `"draft"` | `draft` until someone means it. Only `active` bundles are sellable. |
| `startsAt` | `date-time` | no | — | ISO timestamp. Null means live as soon as it is active. |
| `endsAt` | `date-time` | no | — | ISO timestamp. Null means it never expires on its own. |
| `items` | `object[]` | **yes** | min 1 items, max 50 items | At least one. A bundle with no items has no components to compute availability from and would report itself unfulfillable forever. |

Example request:

```json
{
  "handle": "brass-diya-set",
  "name": "Brass Diya Set",
  "bundlePricePaise": 149900,
  "status": "draft",
  "startsAt": "2026-08-25T10:30:00.000Z",
  "endsAt": "2026-08-25T10:30:00.000Z",
  "items": [
    {
      "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "quantity": 1,
      "position": 0
    }
  ]
}
```

**Response `201`** — The bundle and its contents.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "handle": "brass-diya-set",
    "name": "Brass Diya Set",
    "bundlePricePaise": 149900,
    "componentTotalPaise": 149900,
    "savingsPaise": 149900,
    "savingsBp": 1000,
    "status": "active",
    "isLive": false,
    "itemCount": 3,
    "unitCount": 3,
    "startsAt": "2026-08-25T10:30:00.000Z",
    "endsAt": "2026-08-25T10:30:00.000Z",
    "archivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "updatedAt": "2026-08-25T10:30:00.000Z",
    "items": [
      {
        "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "quantity": 10,
        "position": 1,
        "unitPricePaise": 149900,
        "archived": false
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `409` | That handle already belongs to a live bundle. |
| `422` | `invalid_bundle_items` (duplicate or discontinued variant) or `invalid_schedule_window`. |

---

### `GET /v1/admin/bundles/:bundleId/availability`

**How many of this bundle can we ship?**

| | |
|---|---|
| operationId | `adminGetBundleAvailability` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Computed, never stored (§91).

```
fulfillable(component) = floor(component.available / component.required)
fulfillable(bundle)    = MIN over components
```

A gift set of 1 bottle + 1 pen + 1 diary against 100 / 75 / 100 available is **75** bundles — not 275, and not 100. The scarcest component is the answer, so `limitingVariantIds` names the ones setting the MIN rather than leaving the caller to re-derive them.

`available` is sellable stock (`on_hand − reserved`, the GENERATED column), never on-hand alone: units already promised to a paid order are physically present but spoken for, and counting them here is precisely how a bundle oversells. A component with **zero** available makes the whole bundle unfulfillable however healthy the rest are, and a component with no stock row at all is read as zero rather than skipped.

`?quantity=` drives `shortage` and `canFulfil`; `fulfillableQty` is the unconditional answer either way. `?warehouseId=` narrows to one warehouse — omitting it sums the network, which silently assumes a split shipment is acceptable, and that is a fulfilment decision with a cost attached rather than an availability fact.

Gated on `inventory:view`, not `promotions:view`: this reads the warehouse.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bundleId` | `uuid` | **yes** | — | Bundle id. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `quantity` | `integer` | no | default `1`, > 0, ≤ 1000000 | How many bundles to ask about. Drives `shortage` and `canFulfil`, not `fulfillableQty`. |
| `warehouseId` | `uuid` | no | — | Compute against ONE warehouse. Omit for the network total — which assumes a split shipment is acceptable, and that is a fulfilment decision with a cost attached, not an availability fact. |

**Response `200`** — The MIN, and the per-component working behind it.

```json
{
  "type": "success",
  "result": {
    "bundleId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "handle": "brass-diya-set",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "requestedQty": 10,
    "fulfillableQty": 10,
    "canFulfil": false,
    "limitingVariantIds": [
      "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
    ],
    "components": [
      {
        "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "required": 1,
        "available": 1,
        "onHand": 1,
        "reserved": 1,
        "shortage": 1,
        "fulfillableQty": 10,
        "isLimiting": false
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bundle, or no such warehouse. |

---

### `POST /v1/admin/bundles/:bundleId/archive`

**Archive a bundle**

| | |
|---|---|
| operationId | `adminArchiveBundle` |
| Auth | Bearer staff token |
| Permission | `promotions:delete` |

Soft delete (§96): `status` becomes `archived` and `deletedAt` is stamped. The row stays, because orders that already contain the bundle still name it, and the partial unique index frees the handle for a replacement.

Archiving an already-archived bundle is a no-op that returns the original `archivedAt`, not a 422. A double-click is not a mistake here — unlike releasing a stock hold twice, there is no second effect to guard against.

Nothing is deleted from `bundle_items`: the contents are what made the historical price mean something.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bundleId` | `uuid` | **yes** | — | Bundle id. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The archived bundle.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "handle": "brass-diya-set",
    "status": "active",
    "archivedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bundle. |

---

### `GET /v1/admin/bundles/:bundleId`

**Get one bundle**

| | |
|---|---|
| operationId | `adminGetBundle` |
| Auth | Bearer staff token |
| Permission | `promotions:view` |

The bundle with its contents resolved — SKU, title and the variant’s own list price per line, which is what `savingsPaise` is computed from.

`archived: true` on a line means the VARIANT has been discontinued while still sitting in the box. That bundle can never ship, and it is surfaced here rather than discovered at checkout.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bundleId` | `uuid` | **yes** | — | Bundle id. |

**Response `200`** — The bundle and its contents.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "handle": "brass-diya-set",
    "name": "Brass Diya Set",
    "bundlePricePaise": 149900,
    "componentTotalPaise": 149900,
    "savingsPaise": 149900,
    "savingsBp": 1000,
    "status": "active",
    "isLive": false,
    "itemCount": 3,
    "unitCount": 3,
    "startsAt": "2026-08-25T10:30:00.000Z",
    "endsAt": "2026-08-25T10:30:00.000Z",
    "archivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "updatedAt": "2026-08-25T10:30:00.000Z",
    "items": [
      {
        "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "quantity": 10,
        "position": 1,
        "unitPricePaise": 149900,
        "archived": false
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bundle. |

---

### `PATCH /v1/admin/bundles/:bundleId`

**Update a bundle**

| | |
|---|---|
| operationId | `adminUpdateBundle` |
| Auth | Bearer staff token |
| Permission | `promotions:edit` |

Every field optional. `items`, when present, **replaces** the contents wholesale inside the same transaction — `bundle_items` is keyed by `(bundleId, variantId)` with no surrogate id, so there is nothing stable to patch a single line by. Omit `items` to leave the box alone.

Editing an archived bundle is a 422. Archiving freed its handle, so an edit could resurrect a row that now collides with a live bundle.

`endsAt` must be after `startsAt`. A window that is never open is refused rather than stored as a bundle that silently never sells.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bundleId` | `uuid` | **yes** | — | Bundle id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | no | min 2, max 80 | — |
| `name` | `string` | no | min 2, max 160 | Display name. |
| `bundlePricePaise` | `integer` | no | ≥ 0 | Integer paise. New bundle price. |
| `status` | `"active" \| "draft" \| "archived"` | no | — | `active`, `draft` or `archived`. |
| `startsAt` | `date-time` | no | — | ISO timestamp, or null to clear. |
| `endsAt` | `date-time` | no | — | ISO timestamp, or null to clear. |
| `items` | `object[]` | no | min 1 items, max 50 items | REPLACES the item list wholesale when present. Omit it to leave the contents alone. `bundle_items` is keyed by (bundleId, variantId) with no surrogate id, so there is nothing stable to patch a single row by. |

Example request:

```json
{
  "handle": "brass-diya-set",
  "name": "Brass Diya Set",
  "bundlePricePaise": 149900,
  "status": "active",
  "startsAt": "2026-08-25T10:30:00.000Z",
  "endsAt": "2026-08-25T10:30:00.000Z",
  "items": [
    {
      "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "quantity": 1,
      "position": 0
    }
  ]
}
```

**Response `200`** — The updated bundle.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "handle": "brass-diya-set",
    "name": "Brass Diya Set",
    "bundlePricePaise": 149900,
    "componentTotalPaise": 149900,
    "savingsPaise": 149900,
    "savingsBp": 1000,
    "status": "active",
    "isLive": false,
    "itemCount": 3,
    "unitCount": 3,
    "startsAt": "2026-08-25T10:30:00.000Z",
    "endsAt": "2026-08-25T10:30:00.000Z",
    "archivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z",
    "updatedAt": "2026-08-25T10:30:00.000Z",
    "items": [
      {
        "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "quantity": 10,
        "position": 1,
        "unitPricePaise": 149900,
        "archived": false
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such bundle. |
| `409` | That handle already belongs to another live bundle. |
| `422` | `bundle_archived`, `invalid_bundle_items`, or `invalid_schedule_window`. |

---
