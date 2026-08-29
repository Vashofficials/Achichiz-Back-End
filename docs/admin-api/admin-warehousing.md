# Admin warehousing

6 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/warehouses/:warehouseId/locations`](#get-v1-admin-warehouses-warehouseid-locations) — List bin locations in a warehouse
- [`POST /v1/admin/warehouses/:warehouseId/locations`](#post-v1-admin-warehouses-warehouseid-locations) — Create a bin location
- [`GET /v1/admin/warehouses/:warehouseId/locations/:locationId`](#get-v1-admin-warehouses-warehouseid-locations-locationid) — Get one bin location
- [`PATCH /v1/admin/warehouses/:warehouseId/locations/:locationId`](#patch-v1-admin-warehouses-warehouseid-locations-locationid) — Rename or move a bin location
- [`POST /v1/admin/warehouses/:warehouseId/locations/:locationId/archive`](#post-v1-admin-warehouses-warehouseid-locations-locationid-archive) — Archive a bin location
- [`GET /v1/admin/warehouses/:warehouseId/inventory`](#get-v1-admin-warehouses-warehouseid-inventory) — Stock held in one warehouse

---

### `GET /v1/admin/warehouses/:warehouseId/locations`

**List bin locations in a warehouse**

| | |
|---|---|
| operationId | `adminListWarehouseLocations` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The zone → rack → shelf → bin tree, flattened and sorted by `path` so the default ordering is also the tree order. Filter by `kind`, by `parentId` for one level of children, or by `pickable` to get only the locations a pick list may route to.

`?q=` matches path, code and name. Archived locations are excluded unless `includeArchived=true` — they are soft-deleted (§96) because the movement ledger still names them.

`depth` and `childCount` come back on every row so the console can render the tree without a second call per node.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | **yes** | — | Warehouse id. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `path` (default), `code`, `kind`, `sortOrder`, `createdAt`. Prefix `-` for descending. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `kind` | `"zone" \| "rack" \| "shelf" \| "bin"` | no | — | Restrict to one level of the hierarchy. |
| `parentId` | `uuid` | no | — | Direct children of this location only. |
| `pickable` | `"true" \| "false"` | no | — | `true` for pickable locations only — the ones a pick list may route to. |
| `includeArchived` | `"true" \| "false"` | no | default `"false"` | Include soft-deleted locations. Off by default. |

Example: `/v1/admin/warehouses/:warehouseId/locations?page=…&perPage=…`

**Response `200`** — A page of locations.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "parentId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "kind": "zone",
      "code": "DIWALI20",
      "name": "Brass Diya Set",
      "path": "/v1/admin/products",
      "depth": 1,
      "isPickable": false,
      "sortOrder": 1,
      "childCount": 3,
      "stockedLevelCount": 3,
      "archivedAt": "2026-08-25T10:30:00.000Z",
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
| `404` | No such warehouse. |

---

### `POST /v1/admin/warehouses/:warehouseId/locations`

**Create a bin location**

| | |
|---|---|
| operationId | `adminCreateWarehouseLocation` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

`path` is **not** accepted in the body. The service builds it from the parent chain — `A` + `R3` + `S2` + `B7` becomes `A/R3/S2/B7` — because a client-settable materialised path is a denormalisation that has stopped being derived from anything, and the first wrong value sends a picker to the wrong aisle.

A child must sit strictly deeper than its parent. It may skip levels — a zone straight to a bin is a legitimate small studio — but a shelf inside a bin is 422 `invalid_location_depth`. A parent in another warehouse is 422; paths are unique per warehouse, so that would quietly start a second tree.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | **yes** | — | Warehouse id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `parentId` | `uuid` | no | — | Parent location, or null/omitted for a top-level one. Must be in the same warehouse. |
| `kind` | `"zone" \| "rack" \| "shelf" \| "bin"` | **yes** | — | `zone` → `rack` → `shelf` → `bin`. A child may skip levels but never sit at or above its parent. |
| `code` | `string` | **yes** | — | Segment code, unique within its parent — `B7`. Becomes the last segment of `path`. |
| `name` | `string` | no | max 120 | Human label, e.g. `Fragile goods, upper shelf`. |
| `isPickable` | `boolean` | no | default `true` | False for staging, quarantine or overflow areas a pick list must not route to. |
| `sortOrder` | `integer` | no | default `0`, ≥ 0, ≤ 100000 | Display order among siblings. |

Example request:

```json
{
  "parentId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "kind": "zone",
  "code": "DIWALI20",
  "name": "Brass Diya Set",
  "isPickable": true,
  "sortOrder": 0
}
```

**Response `201`** — The created location.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "parentId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "kind": "zone",
    "code": "DIWALI20",
    "name": "Brass Diya Set",
    "path": "/v1/admin/products",
    "depth": 1,
    "isPickable": false,
    "sortOrder": 1,
    "childCount": 3,
    "stockedLevelCount": 3,
    "archivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such warehouse, or no such parent location. |
| `422` | Duplicate path, illegal depth, an archived parent, or a parent in another warehouse. |

---

### `GET /v1/admin/warehouses/:warehouseId/locations/:locationId`

**Get one bin location**

| | |
|---|---|
| operationId | `adminGetWarehouseLocation` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Includes `childCount` and `stockedLevelCount` — the two numbers that decide whether it can be archived, so the console can disable the button rather than discover the 422.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | **yes** | — | Warehouse id. The location must belong to it. |
| `locationId` | `uuid` | **yes** | — | Location id. |

**Response `200`** — The location.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "parentId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "kind": "zone",
    "code": "DIWALI20",
    "name": "Brass Diya Set",
    "path": "/v1/admin/products",
    "depth": 1,
    "isPickable": false,
    "sortOrder": 1,
    "childCount": 3,
    "stockedLevelCount": 3,
    "archivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such location in this warehouse. |

---

### `PATCH /v1/admin/warehouses/:warehouseId/locations/:locationId`

**Rename or move a bin location**

| | |
|---|---|
| operationId | `adminUpdateWarehouseLocation` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Changing `parentId` or `code` rewrites `path` for this location **and every descendant** in the same transaction. A grandchild left holding the old prefix would be a bin that exists in the database and nowhere in the warehouse.

A `parentId` that sits inside this location’s own subtree is 422 `location_cycle`. The database CHECK only catches the trivial self-parent case; a three-node ring is caught here, before a recursive walk has anything to fail to terminate on.

`kind` is deliberately not editable — turning a rack into a bin while it still has shelves under it is not a rename, it is a restructure, and re-parenting the subtree is the honest way to say so.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | **yes** | — | Warehouse id. The location must belong to it. |
| `locationId` | `uuid` | **yes** | — | Location id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `parentId` | `uuid` | no | — | Move the location under a different parent, or null to make it top-level. The whole subtree’s `path` is rewritten in the same transaction. A parent that is a descendant is rejected. |
| `code` | `string` | no | — | Rename the segment. Rewrites `path` for this location and every descendant. |
| `name` | `string` | no | max 120 | Human label, or null to clear. |
| `isPickable` | `boolean` | no | — | Whether pick lists may route here. |
| `sortOrder` | `integer` | no | ≥ 0, ≤ 100000 | Display order among siblings. |

Example request:

```json
{
  "parentId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "code": "DIWALI20",
  "name": "Brass Diya Set",
  "isPickable": false,
  "sortOrder": 1
}
```

**Response `200`** — The updated location.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "parentId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "kind": "zone",
    "code": "DIWALI20",
    "name": "Brass Diya Set",
    "path": "/v1/admin/products",
    "depth": 1,
    "isPickable": false,
    "sortOrder": 1,
    "childCount": 3,
    "stockedLevelCount": 3,
    "archivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such location, or no such new parent. |
| `422` | A cycle, a duplicate path, an illegal depth, or the location is archived. |

---

### `POST /v1/admin/warehouses/:warehouseId/locations/:locationId/archive`

**Archive a bin location**

| | |
|---|---|
| operationId | `adminArchiveWarehouseLocation` |
| Auth | Bearer staff token |
| Permission | `inventory:delete` |

Soft delete (§96) — the movement ledger still names this location, so the row stays and the partial unique index frees the path for reuse.

Refused while it has live children (they would point at a dead parent) or while inventory levels are still stored there (they would claim a bin that no longer exists). Move the stock first. Archiving an already-archived location is a no-op rather than an error, so a double-click is not a failure.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | **yes** | — | Warehouse id. The location must belong to it. |
| `locationId` | `uuid` | **yes** | — | Location id. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — The archived location, with `archivedAt` set.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "parentId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "kind": "zone",
    "code": "DIWALI20",
    "name": "Brass Diya Set",
    "path": "/v1/admin/products",
    "depth": 1,
    "isPickable": false,
    "sortOrder": 1,
    "childCount": 3,
    "stockedLevelCount": 3,
    "archivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such location in this warehouse. |
| `422` | It still has live children or stock stored in it. |

---

### `GET /v1/admin/warehouses/:warehouseId/inventory`

**Stock held in one warehouse**

| | |
|---|---|
| operationId | `adminListWarehouseInventory` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Every `inventory_levels` row for this warehouse, across all three stockable kinds — variants, loose hamper items and packaging materials — with the SKU and title resolved for each.

`availableQty` is a GENERATED column (`on_hand - reserved`), so it cannot drift from the two numbers it is derived from. `incomingQty` is what is expected to arrive here: sent purchase orders plus transfers dispatched to this warehouse. Stock currently in transit appears in `incomingQty` at the destination and in neither warehouse’s `availableQty`, which is correct — it is on a lorry.

`?lowStock=true` returns only levels at or below their reorder point. `?locationId=` narrows to one bin. `inventoryLevelId` is the id transfer and purchase-return lines lock on.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | **yes** | — | Warehouse id. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `sku` (default), `onHandQty`, `availableQty`, `reservedQty`, `incomingQty`, `lastMovementAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `locationId` | `uuid` | no | — | Only levels stored at this bin location. |
| `lowStock` | `"true" \| "false"` | no | — | `true` returns only levels where available ≤ reorder point. |

Example: `/v1/admin/warehouses/:warehouseId/inventory?page=…&perPage=…`

**Response `200`** — A page of inventory levels.

```json
{
  "type": "success",
  "result": [
    {
      "inventoryLevelId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "stockableKind": "variant",
      "stockableId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "sku": "ACH-CAN-001",
      "title": "Brass Diya Set",
      "onHandQty": 10,
      "reservedQty": 10,
      "availableQty": 10,
      "incomingQty": 10,
      "reorderPoint": 1,
      "reorderQty": 10,
      "locationId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "locationPath": "A/R3/S2",
      "binLocation": "A/R3/S2",
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
| `404` | No such warehouse. |

---
