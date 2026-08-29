# Admin barcodes

5 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/barcodes/:sku`](#get-v1-admin-barcodes-sku) — Get the barcode for a SKU
- [`POST /v1/admin/barcodes/generate`](#post-v1-admin-barcodes-generate) — Generate a barcode for one SKU
- [`POST /v1/admin/barcodes/bulk-generate`](#post-v1-admin-barcodes-bulk-generate) — Generate barcodes for many SKUs
- [`POST /v1/admin/barcodes/scan`](#post-v1-admin-barcodes-scan) — Resolve a scanned barcode
- [`GET /v1/admin/qr/:sku`](#get-v1-admin-qr-sku) — Get the QR payload for a SKU

---

### `GET /v1/admin/barcodes/:sku`

**Get the barcode for a SKU**

| | |
|---|---|
| operationId | `adminGetBarcode` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Returns the stored EAN-13 for a variant, with a validity check on the check digit. A SKU with no barcode yet is a 200 with `barcode: null`, not a 404 — the variant exists, it simply has not been labelled.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `sku` | `string` | **yes** | min 1, max 64 | SKU of a product variant. |

**Response `200`** — Barcode state for the SKU.

```json
{
  "type": "success",
  "result": {
    "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "sku": "ACH-CAN-001",
    "name": "Brass Diya Set",
    "barcode": "2900000000008",
    "symbology": "EAN13",
    "isValid": false,
    "checkDigit": 1
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No variant with that SKU. |

---

### `POST /v1/admin/barcodes/generate`

**Generate a barcode for one SKU**

| | |
|---|---|
| operationId | `adminGenerateBarcode` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Mints an EAN-13 in an internal (restricted-circulation) prefix range and stores it on the variant. Refuses to overwrite an existing barcode unless `force` is set: a relabelled SKU orphans every carton already printed with the old code.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `sku` | `string` | **yes** | min 1, max 64 | SKU of the variant to assign a barcode to. |
| `prefix` | `"20" \| "21" \| "22" \| "23" \| "24" \| "25" \| "26" \| "27" \| "28" \| "29"` | no | default `"29"` | GS1 restricted-circulation prefix (`20`–`29`). These are reserved for codes meaningful inside one company and can never collide with a manufacturer’s registered GS1 prefix. Goods sold through retail need a real GS1 company prefix, which is bought rather than generated — this endpoint cannot mint one and the default makes that obvious. |
| `force` | `boolean` | no | default `false` | Overwrite an existing barcode. Refused without it: every label already printed for that SKU becomes wrong the moment the column changes, and a scan of an old label then resolves to nothing. |

Example request:

```json
{
  "sku": "ACH-CAN-001",
  "prefix": "29",
  "force": false
}
```

**Response `200`** — The barcode assigned.

```json
{
  "type": "success",
  "result": {
    "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "sku": "ACH-CAN-001",
    "barcode": "2900000000008",
    "previousBarcode": "2900000000008",
    "generated": false
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No variant with that SKU. |
| `422` | The SKU already has a barcode and `force` was not set. |

---

### `POST /v1/admin/barcodes/bulk-generate`

**Generate barcodes for many SKUs**

| | |
|---|---|
| operationId | `adminBulkGenerateBarcodes` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

All-or-nothing in one transaction. Codes are minted distinct from each other AND from every barcode already stored — a duplicate EAN-13 across two SKUs makes the scanner ambiguous, which is worse than having no barcode at all.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `skus` | `string[]` | **yes** | min 1 items, max 500 items | Up to 500 SKUs. All-or-nothing — one unknown SKU writes nothing. |
| `prefix` | `"20" \| "21" \| "22" \| "23" \| "24" \| "25" \| "26" \| "27" \| "28" \| "29"` | no | default `"29"` | As on the single-SKU endpoint. |
| `force` | `boolean` | no | default `false` | Overwrite variants that already have a barcode. Without it they are skipped and reported as such. |

Example request:

```json
{
  "skus": [
    "ACH-CAN-001"
  ],
  "prefix": "29",
  "force": false
}
```

**Response `200`** — What was assigned and what was skipped.

```json
{
  "type": "success",
  "result": {
    "assigned": 1,
    "skipped": 1,
    "results": [
      {
        "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "barcode": "2900000000008",
        "previousBarcode": "2900000000008",
        "generated": false
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `422` | A SKU is unknown, or already had a barcode and `force` was not set. |

---

### `POST /v1/admin/barcodes/scan`

**Resolve a scanned barcode**

| | |
|---|---|
| operationId | `adminScanBarcode` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Resolves a barcode to its variant and returns the context the named operation needs — stock levels per warehouse, and the active stock count when the operation is `stock_count`.

**This endpoint does not move stock.** It answers "what am I holding, and what can I do with it here"; the actual movement goes through the endpoint that names it (adjustment, receipt, transfer, count item). A scanner that silently decremented would be an unauditable side door into the ledger.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `barcode` | `string` | **yes** | min 1, max 64 | What the scanner read. Matched against `product_variants.barcode` first, then against `sku` — labels printed from `GET /v1/admin/qr/:sku` carry the SKU, and a handheld should not care which kind of label it is pointed at. The response says which matched. |
| `operation` | `"stock_count" \| "receive" \| "transfer" \| "pick" \| "pack" \| "dispatch" \| "return"` | **yes** | — | What the operator is about to do. It selects the context returned; it does not perform anything. |
| `warehouseId` | `uuid` | no | — | Narrow the returned levels to one warehouse — the one the handheld is standing in. |

Example request:

```json
{
  "barcode": "2900000000008",
  "operation": "stock_count",
  "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
}
```

**Response `200`** — The resolved variant and its operation context.

```json
{
  "type": "success",
  "result": {
    "matchedOn": "barcode",
    "operation": "stock_count",
    "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "sku": "ACH-CAN-001",
    "name": "Brass Diya Set",
    "barcode": "2900000000008",
    "status": "active",
    "levels": [
      {
        "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "warehouseCode": "DIWALI20",
        "onHandQty": 10,
        "reservedQty": 10,
        "availableQty": 10,
        "incomingQty": 10,
        "binLocation": "A/R3/S2",
        "locationPath": "A/R3/S2"
      }
    ],
    "activeCount": {
      "countId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "countNo": "PRD-2026-00001",
      "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "countItemId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "systemQty": 10,
      "countedQty": 10,
      "submitTo": "string"
    },
    "movesStock": false
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No variant carries that barcode. |

---

### `GET /v1/admin/qr/:sku`

**Get the QR payload for a SKU**

| | |
|---|---|
| operationId | `adminGetSkuQr` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Returns a payload safe to print on a label: SKU, title, barcode and a version marker. It deliberately carries **no cost, no supplier and no warehouse quantities** — a QR on a carton is readable by anyone in the supply chain, including people who should not learn your margins.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `sku` | `string` | **yes** | min 1, max 64 | SKU of a product variant. |

**Response `200`** — Label-safe QR payload.

```json
{
  "type": "success",
  "result": {
    "sku": "ACH-CAN-001",
    "barcode": "2900000000008",
    "name": "Brass Diya Set",
    "optionLabel": "string",
    "payload": "string",
    "version": "ACH1",
    "symbology": "QR",
    "generatedAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No variant with that SKU. |

---
