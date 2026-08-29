# Admin suppliers

3 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/suppliers/:supplierId/products`](#get-v1-admin-suppliers-supplierid-products) — List what a supplier sells us
- [`POST /v1/admin/suppliers/:supplierId/products`](#post-v1-admin-suppliers-supplierid-products) — Add an item to a supplier’s catalogue
- [`PATCH /v1/admin/suppliers/:supplierId/products/:supplierProductId`](#patch-v1-admin-suppliers-supplierid-products-supplierproductid) — Update a supplier catalogue entry

---

### `GET /v1/admin/suppliers/:supplierId/products`

**List what a supplier sells us**

| | |
|---|---|
| operationId | `adminListSupplierProducts` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The join that makes reordering possible: the supplier’s own SKU, what they charge, their minimum order quantity and their lead time, per stockable.

A catalogue entry targets exactly one of a product variant, a loose hamper item or a packaging material — the same polymorphism `inventory_levels` uses. `?q=` matches our SKU, the title and the supplier’s own code. Archived entries are excluded unless `includeArchived=true`.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `supplierId` | `uuid` | **yes** | — | Supplier id. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `sku` (default), `unitCostPaise`, `leadTimeDays`, `moq`, `createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `preferredOnly` | `"true" \| "false"` | no | — | `true` returns only the entries marked preferred for their target. |
| `includeArchived` | `"true" \| "false"` | no | default `"false"` | Include soft-deleted entries. |

Example: `/v1/admin/suppliers/:supplierId/products?page=…&perPage=…`

**Response `200`** — A page of catalogue entries.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "targetKind": "variant",
      "targetId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "sku": "ACH-CAN-001",
      "title": "Brass Diya Set",
      "supplierSku": "ACH-CAN-001",
      "unitCostPaise": 149900,
      "currency": "INR",
      "moq": 1,
      "leadTimeDays": 30,
      "isPreferred": false,
      "lastPurchaseAt": "2026-08-25T10:30:00.000Z",
      "lastPurchaseCostPaise": 149900,
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
| `404` | No such supplier. |

---

### `POST /v1/admin/suppliers/:supplierId/products`

**Add an item to a supplier’s catalogue**

| | |
|---|---|
| operationId | `adminCreateSupplierProduct` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

Exactly one of `variantId`, `hamperItemId` or `packagingId`, which the database CHECKs. A second live entry for the same supplier and the same item is 422 `supplier_product_exists` — the reorder engine would have no way to choose between two prices for one thing.

`isPreferred` is capped at ONE per variant by a partial unique index. Setting it here demotes whoever held it, in the same transaction and BEFORE the insert: a partial unique index cannot be deferred, so doing it the other way round collides with a row that is about to change.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `supplierId` | `uuid` | **yes** | — | Supplier id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `variantId` | `uuid` | no | — | Product variant this supplier sells. Exactly one target. |
| `hamperItemId` | `uuid` | no | — | Loose hamper item this supplier sells. Exactly one target. |
| `packagingId` | `uuid` | no | — | Packaging material this supplier sells. Exactly one target. |
| `supplierSku` | `string` | no | max 80 | What the SUPPLIER calls it. This is what goes on the PO they receive. |
| `unitCostPaise` | `integer` | no | default `0`, ≥ 0 | Integer paise. What they charge per unit, excluding GST. |
| `moq` | `integer` | no | default `1`, ≥ 1, ≤ 1000000 | Minimum order quantity. The reorder engine rounds suggestions up to this. |
| `leadTimeDays` | `integer` | no | default `0`, ≥ 0, ≤ 3650 | Days from order to delivery. Feeds reorder point = daily consumption × lead time + safety. |
| `isPreferred` | `boolean` | no | default `false` | At most ONE preferred supplier per variant, enforced by a partial unique index. Setting this clears the flag on whoever held it, in the same transaction. |

Example request:

```json
{
  "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "hamperItemId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
  "packagingId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "supplierSku": "ACH-CAN-001",
  "unitCostPaise": 0,
  "moq": 1,
  "leadTimeDays": 0,
  "isPreferred": false
}
```

**Response `201`** — The created catalogue entry.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "targetKind": "variant",
    "targetId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "sku": "ACH-CAN-001",
    "title": "Brass Diya Set",
    "supplierSku": "ACH-CAN-001",
    "unitCostPaise": 149900,
    "currency": "INR",
    "moq": 1,
    "leadTimeDays": 30,
    "isPreferred": false,
    "lastPurchaseAt": "2026-08-25T10:30:00.000Z",
    "lastPurchaseCostPaise": 149900,
    "archivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such supplier. |
| `422` | A duplicate entry, or a target that does not exist. |

---

### `PATCH /v1/admin/suppliers/:supplierId/products/:supplierProductId`

**Update a supplier catalogue entry**

| | |
|---|---|
| operationId | `adminUpdateSupplierProduct` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Cost, MOQ, lead time, the supplier’s SKU, and the preferred flag. Promoting one entry demotes the incumbent for that variant.

The TARGET is immutable — changing which item an entry prices is not an edit, it is a different entry, and silently repointing it would rewrite the price history of both.

`archived: true` soft-deletes and clears the preferred flag, freeing the slot in the unique index for a replacement supplier. `archived: false` restores it.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `supplierId` | `uuid` | **yes** | — | Supplier id. The catalogue entry must belong to it. |
| `supplierProductId` | `uuid` | **yes** | — | Supplier catalogue entry id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `supplierSku` | `string` | no | max 80 | Supplier’s own SKU, or null to clear. |
| `unitCostPaise` | `integer` | no | ≥ 0 | Integer paise. New unit cost. |
| `moq` | `integer` | no | ≥ 1, ≤ 1000000 | Minimum order quantity. |
| `leadTimeDays` | `integer` | no | ≥ 0, ≤ 3650 | Lead time in days. |
| `isPreferred` | `boolean` | no | — | Promote or demote. Promotion demotes the incumbent. |
| `archived` | `boolean` | no | — | True soft-deletes the entry, freeing its slot in the unique index. False restores it. |

Example request:

```json
{
  "supplierSku": "ACH-CAN-001",
  "unitCostPaise": 149900,
  "moq": 1,
  "leadTimeDays": 30,
  "isPreferred": false,
  "archived": false
}
```

**Response `200`** — The updated entry.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "supplierId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "targetKind": "variant",
    "targetId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "sku": "ACH-CAN-001",
    "title": "Brass Diya Set",
    "supplierSku": "ACH-CAN-001",
    "unitCostPaise": 149900,
    "currency": "INR",
    "moq": 1,
    "leadTimeDays": 30,
    "isPreferred": false,
    "lastPurchaseAt": "2026-08-25T10:30:00.000Z",
    "lastPurchaseCostPaise": 149900,
    "archivedAt": "2026-08-25T10:30:00.000Z",
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such entry for this supplier. |
| `422` | Restoring it would collide with a live entry for the same item. |

---
