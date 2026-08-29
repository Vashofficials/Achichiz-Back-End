# Admin reports

10 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/reports/inventory-aging`](#get-v1-admin-reports-inventory-aging) — Inventory aging report
- [`GET /v1/admin/reports/dead-stock`](#get-v1-admin-reports-dead-stock) — Dead stock report
- [`GET /v1/admin/reports/inventory-valuation`](#get-v1-admin-reports-inventory-valuation) — Inventory valuation report
- [`GET /v1/admin/reports/stock-movements`](#get-v1-admin-reports-stock-movements) — Stock movements report
- [`GET /v1/admin/reports/product-performance`](#get-v1-admin-reports-product-performance) — Product performance report
- [`GET /v1/admin/reports/supplier-performance`](#get-v1-admin-reports-supplier-performance) — Supplier performance report
- [`GET /v1/admin/reports/inventory-health`](#get-v1-admin-reports-inventory-health) — Overall inventory health
- [`GET /v1/admin/reports/stock-velocity`](#get-v1-admin-reports-stock-velocity) — Stock velocity report
- [`GET /v1/admin/reports/purchase-forecast`](#get-v1-admin-reports-purchase-forecast) — Purchase forecast report
- [`GET /v1/admin/reports/:report/export`](#get-v1-admin-reports-report-export) — Export a report

---

### `GET /v1/admin/reports/inventory-aging`

**Inventory aging report**

| | |
|---|---|
| operationId | `adminReportInventoryAging` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Find stock sitting longer than threshold days.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `warehouseId` | `uuid` | no | — | — |
| `thresholdDays` | `integer` | no | default `90`, ≥ 1 | — |

Example: `/v1/admin/reports/inventory-aging?page=…&perPage=…`

**Response `200`** — A page of aging inventory.

```json
{
  "type": "success",
  "result": [
    {
      "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "hamperItemId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "packagingId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set",
      "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "onHandQty": 10,
      "ageDays": 30
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

### `GET /v1/admin/reports/dead-stock`

**Dead stock report**

| | |
|---|---|
| operationId | `adminReportDeadStock` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Items that have not moved recently.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `warehouseId` | `uuid` | no | — | — |
| `thresholdDays` | `integer` | no | default `90`, ≥ 1 | — |

Example: `/v1/admin/reports/dead-stock?page=…&perPage=…`

**Response `200`** — A page of dead stock.

```json
{
  "type": "success",
  "result": [
    {
      "variantId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "hamperItemId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "packagingId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set",
      "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "onHandQty": 10,
      "ageDays": 30
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

### `GET /v1/admin/reports/inventory-valuation`

**Inventory valuation report**

| | |
|---|---|
| operationId | `adminReportInventoryValuation` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Calculate total value of on-hand inventory.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `warehouseId` | `uuid` | no | — | — |

Example: `/v1/admin/reports/inventory-valuation?page=…&perPage=…`

**Response `200`** — A page of inventory values.

```json
{
  "type": "success",
  "result": [
    {
      "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "hamperItemId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "packagingId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set",
      "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "onHandQty": 10,
      "unitCostPaise": 149900,
      "totalValuePaise": 149900
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

### `GET /v1/admin/reports/stock-movements`

**Stock movements report**

| | |
|---|---|
| operationId | `adminReportStockMovements` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Aggregate stock movements over time.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `startDate` | `any` | no | — | — |
| `endDate` | `any` | no | — | — |
| `warehouseId` | `uuid` | no | — | — |

Example: `/v1/admin/reports/stock-movements?page=…&perPage=…`

**Response `200`** — A page of stock movement totals.

```json
{
  "type": "success",
  "result": [
    {
      "movementType": "string",
      "totalQuantity": 10,
      "eventCount": 3
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

### `GET /v1/admin/reports/product-performance`

**Product performance report**

| | |
|---|---|
| operationId | `adminReportProductPerformance` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Best selling products by volume and revenue.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `startDate` | `any` | no | — | — |
| `endDate` | `any` | no | — | — |

Example: `/v1/admin/reports/product-performance?page=…&perPage=…`

**Response `200`** — A page of product performance.

```json
{
  "type": "success",
  "result": [
    {
      "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set",
      "unitsSold": 1,
      "revenuePaise": 149900
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

### `GET /v1/admin/reports/supplier-performance`

**Supplier performance report**

| | |
|---|---|
| operationId | `adminReportSupplierPerformance` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Lead times, defect rates, PO fulfillment rates.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `startDate` | `any` | no | — | — |
| `endDate` | `any` | no | — | — |

Example: `/v1/admin/reports/supplier-performance?page=…&perPage=…`

**Response `200`** — A page of supplier performance.

```json
{
  "type": "success",
  "result": [
    {
      "supplierId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "code": "DIWALI20",
      "name": "Brass Diya Set",
      "totalOrders": 1,
      "avgLeadTimeDays": 30,
      "defectRateBp": 1000
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

### `GET /v1/admin/reports/inventory-health`

**Overall inventory health**

| | |
|---|---|
| operationId | `adminReportInventoryHealth` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Stock status percentages (out of stock, low stock, overstock).

**Response `200`** — Inventory health summary.

```json
{
  "type": "success",
  "result": {
    "totalSkus": 1,
    "outOfStockCount": 3,
    "lowStockCount": 3,
    "healthyStockCount": 3,
    "overstockCount": 3
  }
}
```

---

### `GET /v1/admin/reports/stock-velocity`

**Stock velocity report**

| | |
|---|---|
| operationId | `adminReportStockVelocity` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Sales per day / week over time.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `warehouseId` | `uuid` | no | — | — |
| `days` | `integer` | no | default `30`, ≥ 1, ≤ 365 | — |

Example: `/v1/admin/reports/stock-velocity?page=…&perPage=…`

**Response `200`** — A page of stock velocities.

```json
{
  "type": "success",
  "result": [
    {
      "variantId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "hamperItemId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "packagingId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set",
      "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "availableQty": 10,
      "unitsPerDay": 1
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

### `GET /v1/admin/reports/purchase-forecast`

**Purchase forecast report**

| | |
|---|---|
| operationId | `adminReportPurchaseForecast` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Forecasted run-out date and order quantities.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `warehouseId` | `uuid` | no | — | — |
| `days` | `integer` | no | default `30`, ≥ 1, ≤ 365 | — |

Example: `/v1/admin/reports/purchase-forecast?page=…&perPage=…`

**Response `200`** — A page of purchase forecasts.

```json
{
  "type": "success",
  "result": [
    {
      "variantId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "hamperItemId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "packagingId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "sku": "ACH-CAN-001",
      "name": "Brass Diya Set",
      "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "availableQty": 10,
      "unitsPerDay": 1,
      "runOutDays": 30,
      "suggestedOrderQty": 10
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

### `GET /v1/admin/reports/:report/export`

**Export a report**

| | |
|---|---|
| operationId | `adminExportReport` |
| Auth | Bearer staff token |
| Permission | `inventory:export` |

The same report as its JSON endpoint, unpaginated, as an RFC 4180 CSV attachment. Reads through the read-only pool, so a large export cannot contend with checkout writes.

Cells are quoted on comma, quote AND newline — an unquoted newline silently splits one record into two and shifts every row after it. Values that begin `=`, `+`, `-` or `@` are tab-prefixed: export rows carry supplier- and operator-supplied text, and a product title beginning `=HYPERLINK(...)` would otherwise execute when the file is opened in Excel.

`inventory-health` is not exportable — it returns one summary object, not rows.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `report` | `"inventory-aging" \| "dead-stock" \| "inventory-valuation" \| "stock-movements" \| "product-performance" \| "supplier-performance" \| "stock-velocity" \| "purchase-forecast"` | **yes** | — | Which report to export. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | no | — | Restrict to one warehouse, where the report supports it. |
| `startDate` | `any` | no | — | Range start, for the movement and performance reports. |
| `endDate` | `any` | no | — | Range end. |
| `thresholdDays` | `integer` | no | ≥ 1, ≤ 3650 | Aging/dead-stock threshold in days. |
| `days` | `integer` | no | ≥ 1, ≤ 365 | Look-back window for velocity and forecast. |

**Response `200`** — A CSV attachment.

```json
{
  "type": "success",
  "result": "string"
}
```

**Errors**

| Status | Meaning |
|---|---|
| `422` | Unknown report name. |

---
