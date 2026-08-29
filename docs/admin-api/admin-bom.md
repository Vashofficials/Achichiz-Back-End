# Admin BOM

6 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/boms`](#get-v1-admin-boms) — List bills of materials
- [`POST /v1/admin/boms`](#post-v1-admin-boms) — Create a bill of materials
- [`GET /v1/admin/boms/:bomId/explosion`](#get-v1-admin-boms-bomid-explosion) — Explode a BOM to its requirements
- [`GET /v1/admin/boms/:bomId`](#get-v1-admin-boms-bomid) — Get a bill of materials
- [`PATCH /v1/admin/boms/:bomId`](#patch-v1-admin-boms-bomid) — Update a bill of materials
- [`POST /v1/admin/boms/:bomId/archive`](#post-v1-admin-boms-bomid-archive) — Remove a bill of materials

---

### `GET /v1/admin/boms`

**List bills of materials**

| | |
|---|---|
| operationId | `adminListBoms` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

One row per output that has a recipe. Filter by `componentVariantId` to answer the question worth asking before discontinuing anything: what do we make out of this?

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `sku` (default), `lineCount`, `version`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `outputVariantId` | `uuid` | no | — | Restrict to one output. |
| `componentVariantId` | `uuid` | no | — | Every BOM that consumes this variant. The question to ask before discontinuing it. |
| `hamperItemId` | `uuid` | no | — | Every BOM that consumes this hamper item. |
| `hasWaste` | `"true" \| "false"` | no | — | `true` returns only BOMs with at least one line carrying a non-zero `wastePct`. |

Example: `/v1/admin/boms?page=…&perPage=…`

**Response `200`** — A page of BOMs.

```json
{
  "type": "success",
  "result": [
    {
      "bomId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "outputVariantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "outputSku": "ACH-CAN-001",
      "outputName": "Brass Diya Set",
      "version": 1,
      "lineCount": 3,
      "hasWaste": false,
      "hasSubAssemblies": false
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

---

### `POST /v1/admin/boms`

**Create a bill of materials**

| | |
|---|---|
| operationId | `adminCreateBom` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

One BOM per output — a second create is a 409, because silently replacing a recipe would discard one that production orders may already have been costed against. A component that is the output itself is rejected: it would explode forever.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `outputVariantId` | `uuid` | **yes** | — | The variant this BOM builds. One BOM per output — a second create is a 409. |
| `version` | `integer` | no | default `1`, ≥ 1, ≤ 100000 | `CHECK (version >= 1)`. Stamped on every line so a recipe change is visible in history. |
| `lines` | `object[]` | **yes** | min 1 items, max 200 items | At least one component. A BOM with no lines describes nothing. |

Example request:

```json
{
  "outputVariantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "version": 1,
  "lines": [
    {
      "componentVariantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "hamperItemId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "quantity": 10,
      "wastePct": 0,
      "unit": "piece",
      "isSubstitutable": false
    }
  ]
}
```

**Response `201`** — The BOM as stored.

```json
{
  "type": "success",
  "result": {
    "bomId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "outputVariantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "outputSku": "ACH-CAN-001",
    "outputName": "Brass Diya Set",
    "version": 1,
    "lineCount": 3,
    "hasWaste": false,
    "hasSubAssemblies": false,
    "lines": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "componentKind": "variant",
        "componentId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "quantity": 10,
        "wastePct": 1,
        "effectiveQty": 10,
        "unit": "piece",
        "isSubstitutable": false,
        "version": 1,
        "hasOwnBom": false
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | Output variant not found. |
| `409` | That output already has a BOM. |
| `422` | A component does not exist, or the BOM references itself. |

---

### `GET /v1/admin/boms/:bomId/explosion`

**Explode a BOM to its requirements**

| | |
|---|---|
| operationId | `adminExplodeBom` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Recurses to raw materials, compounding waste at every level, and SUMS a component reached by more than one path. `mode=direct` returns only the immediate components instead.

Pass `warehouseId` to decorate each line with on-hand and shortage — this is the "can we build this?" question. A cyclic BOM is a 422 rather than a hung request.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bomId` | `uuid` | **yes** | — | The OUTPUT variant id. `product_bom_lines` has no header table — a BOM *is* its output, so the output variant identifies it. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `quantity` | `integer` | no | default `1`, > 0, ≤ 1000000 | Units of the output to build. Multiplies every requirement below it. |
| `mode` | `"full" \| "direct"` | no | default `"full"` | `full` recurses to raw materials, compounding waste at each level. `direct` returns only the immediate components — what a run consumes when the sub-assemblies are things the warehouse already stocks rather than things it makes in the same batch. |
| `warehouseId` | `uuid` | no | — | Resolve each requirement against this warehouse’s stock, adding `available` and `shortage`. |

**Response `200`** — Requirements, and shortages when a warehouse was named.

```json
{
  "type": "success",
  "result": {
    "bomId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "outputSku": "ACH-CAN-001",
    "quantity": 10,
    "mode": "full",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "maxDepth": 1,
    "nodeCount": 3,
    "canBuild": false,
    "leaves": [
      {
        "componentKind": "variant",
        "componentId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "unit": "piece",
        "rawQty": 10,
        "requiredQty": 10,
        "depth": 1,
        "paths": [
          "/v1/admin/products"
        ],
        "availableQty": 10,
        "shortageQty": 10
      }
    ],
    "subAssemblies": [
      {
        "componentKind": "variant",
        "componentId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "unit": "piece",
        "rawQty": 10,
        "requiredQty": 10,
        "depth": 1,
        "paths": [
          "/v1/admin/products"
        ],
        "availableQty": 10,
        "shortageQty": 10
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No variant or no BOM for it. |
| `422` | The BOM contains a cycle, or is too deep or too large to explode. |

---

### `GET /v1/admin/boms/:bomId`

**Get a bill of materials**

| | |
|---|---|
| operationId | `adminGetBom` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The recipe for one output variant, with every component line and the current version.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bomId` | `uuid` | **yes** | — | The OUTPUT variant id. `product_bom_lines` has no header table — a BOM *is* its output, so the output variant identifies it. |

**Response `200`** — The BOM.

```json
{
  "type": "success",
  "result": {
    "bomId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "outputVariantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "outputSku": "ACH-CAN-001",
    "outputName": "Brass Diya Set",
    "version": 1,
    "lineCount": 3,
    "hasWaste": false,
    "hasSubAssemblies": false,
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "componentKind": "variant",
        "componentId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "quantity": 10,
        "wastePct": 1,
        "effectiveQty": 10,
        "unit": "piece",
        "isSubstitutable": false,
        "version": 1,
        "hasOwnBom": false
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No variant or no BOM for it. |

---

### `PATCH /v1/admin/boms/:bomId`

**Update a bill of materials**

| | |
|---|---|
| operationId | `adminUpdateBom` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Supplying `lines` REPLACES the recipe wholesale and bumps the version — half the old recipe merged with half the new one is a recipe nobody wrote. Supplying only `version` restamps without changing components.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bomId` | `uuid` | **yes** | — | The OUTPUT variant id. `product_bom_lines` has no header table — a BOM *is* its output, so the output variant identifies it. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `version` | `integer` | no | ≥ 1, ≤ 100000 | Bump when the recipe genuinely changes. |
| `lines` | `object[]` | no | min 1 items, max 200 items | REPLACES every line of this BOM in one transaction. Omit to change only `version`. Existing production orders are unaffected — their `production_order_lines` are a snapshot taken when the order was created, which is what makes planned-vs-consumed comparable across a recipe change. |

Example request:

```json
{
  "version": 1,
  "lines": [
    {
      "componentVariantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "hamperItemId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "quantity": 10,
      "wastePct": 0,
      "unit": "piece",
      "isSubstitutable": false
    }
  ]
}
```

**Response `200`** — The BOM after the change.

```json
{
  "type": "success",
  "result": {
    "bomId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "outputVariantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "outputSku": "ACH-CAN-001",
    "outputName": "Brass Diya Set",
    "version": 1,
    "lineCount": 3,
    "hasWaste": false,
    "hasSubAssemblies": false,
    "lines": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "componentKind": "variant",
        "componentId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "quantity": 10,
        "wastePct": 1,
        "effectiveQty": 10,
        "unit": "piece",
        "isSubstitutable": false,
        "version": 1,
        "hasOwnBom": false
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No variant or no BOM for it. |
| `422` | A component does not exist, or the BOM references itself. |

---

### `POST /v1/admin/boms/:bomId/archive`

**Remove a bill of materials**

| | |
|---|---|
| operationId | `adminArchiveBom` |
| Auth | Bearer staff token |
| Permission | `inventory:delete` |

Refused while any production order against this output is still open — those orders were planned against this recipe, and completing them afterwards would consume components nobody can trace.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `bomId` | `uuid` | **yes** | — | The OUTPUT variant id. `product_bom_lines` has no header table — a BOM *is* its output, so the output variant identifies it. |

**Request body** — none. Send `{}` or omit.

**Response `200`** — What was removed.

```json
{
  "type": "success",
  "result": {
    "bomId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "removedLineCount": 3
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No variant or no BOM for it. |
| `409` | Open production orders still reference this recipe. |

---
