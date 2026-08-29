# Admin stock counts

7 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/stock-counts`](#get-v1-admin-stock-counts) — List stock counts
- [`POST /v1/admin/stock-counts`](#post-v1-admin-stock-counts) — Raise a stock count
- [`GET /v1/admin/stock-counts/:countId`](#get-v1-admin-stock-counts-countid) — Get one stock count
- [`POST /v1/admin/stock-counts/:countId/start`](#post-v1-admin-stock-counts-countid-start) — Start counting — freezes the system quantities
- [`POST /v1/admin/stock-counts/:countId/items`](#post-v1-admin-stock-counts-countid-items) — Record counted quantities
- [`POST /v1/admin/stock-counts/:countId/complete`](#post-v1-admin-stock-counts-countid-complete) — Finish counting
- [`POST /v1/admin/stock-counts/:countId/approve`](#post-v1-admin-stock-counts-countid-approve) — Approve the count and post the variance

---

### `GET /v1/admin/stock-counts`

**List stock counts**

| | |
|---|---|
| operationId | `adminListStockCounts` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

Count sheets, newest first. `?status=` takes a comma-separated list; an unrecognised value is a 400 rather than a silently empty page.

Each row carries the full roll-up — `itemsInScope`, `itemsCounted`, `itemsUncounted`, `itemsWithVariance`, `netVarianceQty` and `absVarianceQty` — computed over the WHOLE sheet, not over the page. `netVarianceQty` and `absVarianceQty` are both reported on purpose: a shelf where five units were put in the wrong bin nets to zero and is not a clean count, so a single "variance" figure would be the misleading one.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | max 120 | `-createdAt` (default), `countNo`, `status`, `scheduledFor`, `completedAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `warehouseId` | `uuid` | no | — | Only counts for this warehouse. |
| `locationId` | `uuid` | no | — | Only counts scoped to this location. Whole-warehouse counts have no location and are excluded. |
| `status` | `string` | no | max 120 | Comma-separated. One or more of: draft, in_progress, completed, approved, cancelled. An unrecognised value is a 400 rather than a silently empty page. |
| `kind` | `"full" \| "cycle" \| "spot"` | no | — | `full` (everything), `cycle` (a rolling slice), or `spot`. |
| `scheduledFrom` | `string` | no | — | `YYYY-MM-DD`. Earliest `scheduledFor`, inclusive. |
| `scheduledTo` | `string` | no | — | `YYYY-MM-DD`. Latest `scheduledFor`, inclusive. |

Example: `/v1/admin/stock-counts?page=…&perPage=…`

**Response `200`** — A page of count sheets.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "countNo": "PRD-2026-00001",
      "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "warehouseCode": "DIWALI20",
      "locationId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "locationPath": "A/R3/S2",
      "kind": "full",
      "status": "draft",
      "scheduledFor": "2026-08-25T10:30:00.000Z",
      "startedAt": "2026-08-25T10:30:00.000Z",
      "completedAt": "2026-08-25T10:30:00.000Z",
      "approvedAt": "2026-08-25T10:30:00.000Z",
      "createdBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "countedBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "approvedBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "note": "Damaged in transit",
      "totals": {
        "itemsInScope": 1,
        "itemsCounted": 3,
        "itemsUncounted": 3,
        "itemsWithVariance": 1,
        "netVarianceQty": 10,
        "absVarianceQty": 10
      },
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
| `400` | An unrecognised status, kind, or an unparseable date bound. |

---

### `POST /v1/admin/stock-counts`

**Raise a stock count**

| | |
|---|---|
| operationId | `adminCreateStockCount` |
| Auth | Bearer staff token |
| Permission | `inventory:create` |

Creates a `draft` sheet and nothing else. **No quantities are frozen here** — that is `POST /start`, because a sheet frozen at creation would already be stale by the time somebody walks the aisle.

Omit `locationId` to count the whole warehouse. Set it to scope the count to one zone, rack, shelf or bin; the scope includes DESCENDANTS, so counting a zone counts every bin under it. The location must belong to the named warehouse — the mismatch is a 422 rather than an empty sheet that would later report a flawless count over zero items.

`countNo` (`CNT-2026-00001`) comes from `document_number_series` under a row lock, never from the application.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `warehouseId` | `uuid` | **yes** | — | The warehouse being counted. Stock is per warehouse; there is no global count. |
| `locationId` | `uuid` | no | — | Narrow the count to one zone/rack/shelf/bin. Null or omitted counts the WHOLE warehouse. The scope includes descendants: counting a zone counts every bin under it. |
| `kind` | `"full" \| "cycle" \| "spot"` | no | default `"cycle"` | `full` is a wall-to-wall stocktake, `cycle` is the rolling slice most warehouses run weekly, `spot` is one operator checking a handful of bins. The kind does not change the arithmetic — it is how the count is reported on afterwards. |
| `scheduledFor` | `string` | no | — | `YYYY-MM-DD`. When the counting is meant to happen. Advisory; nothing enforces it. |
| `note` | `string` | no | max 2000 | Why this count was raised. |

Example request:

```json
{
  "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
  "locationId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
  "kind": "cycle",
  "scheduledFor": "2026-08-25T10:30:00.000Z",
  "note": "Damaged in transit"
}
```

**Response `201`** — The draft count sheet.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "countNo": "PRD-2026-00001",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseCode": "DIWALI20",
    "locationId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "locationPath": "A/R3/S2",
    "kind": "full",
    "status": "draft",
    "scheduledFor": "2026-08-25T10:30:00.000Z",
    "startedAt": "2026-08-25T10:30:00.000Z",
    "completedAt": "2026-08-25T10:30:00.000Z",
    "approvedAt": "2026-08-25T10:30:00.000Z",
    "createdBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "countedBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "approvedBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "note": "Damaged in transit",
    "totals": {
      "itemsInScope": 1,
      "itemsCounted": 3,
      "itemsUncounted": 3,
      "itemsWithVariance": 1,
      "netVarianceQty": 10,
      "absVarianceQty": 10
    },
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such warehouse, or no such location. |
| `422` | `location_warehouse_mismatch`. |

---

### `GET /v1/admin/stock-counts/:countId`

**Get one stock count**

| | |
|---|---|
| operationId | `adminGetStockCount` |
| Auth | Bearer staff token |
| Permission | `inventory:view` |

The sheet, its roll-up, one page of lines, and what may legally happen to it next — `transitions` is rendered from the state machine itself, so a UI that hides buttons from it can never offer an action the server will refuse.

Lines page separately from the collection (`?itemPage`, `?itemPerPage`, max 200) because a full-warehouse count has thousands of them. `?onlyVariances=true` is the approver’s work queue; `?uncountedOnly=true` is the counter’s. The header totals always cover the whole sheet regardless of which page of lines you asked for.

`varianceQty` on a line is `countedQty − systemQty`, or **null when nobody has counted it yet**. That is deliberately not the raw generated column, which reads `COALESCE(counted,0) − system` and would render an uncounted line as a full write-off.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `countId` | `uuid` | **yes** | — | Stock count id. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `itemPage` | `integer` | no | default `1`, > 0 | 1-indexed page of count lines. |
| `itemPerPage` | `integer` | no | default `50`, > 0, ≤ 200 | Count lines per page. Maximum 200. The header totals always cover the WHOLE count, not the page. |
| `onlyVariances` | `"true" \| "false"` | no | default `"false"` | `true` returns only counted lines whose variance is non-zero — the work queue for an approver. |
| `uncountedOnly` | `"true" \| "false"` | no | default `"false"` | `true` returns only lines nobody has counted yet — the work queue for a counter. |

**Response `200`** — The count, its lines and its legal next steps.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "countNo": "PRD-2026-00001",
    "warehouseId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "warehouseCode": "DIWALI20",
    "locationId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "locationPath": "A/R3/S2",
    "kind": "full",
    "status": "draft",
    "scheduledFor": "2026-08-25T10:30:00.000Z",
    "startedAt": "2026-08-25T10:30:00.000Z",
    "completedAt": "2026-08-25T10:30:00.000Z",
    "approvedAt": "2026-08-25T10:30:00.000Z",
    "createdBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "countedBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "approvedBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "note": "Damaged in transit",
    "totals": {
      "itemsInScope": 1,
      "itemsCounted": 3,
      "itemsUncounted": 3,
      "itemsWithVariance": 1,
      "netVarianceQty": 10,
      "absVarianceQty": 10
    },
    "createdAt": "2026-08-25T10:30:00.000Z",
    "items": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "itemKind": "variant",
        "itemId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "binLocation": "A/R3/S2",
        "locationPath": "A/R3/S2",
        "systemQty": 10,
        "countedQty": 10,
        "varianceQty": 10,
        "recountQty": 10,
        "reason": "Damaged in transit",
        "countedAt": "2026-08-25T10:30:00.000Z",
        "countedBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
      }
    ],
    "itemPage": 1,
    "itemPerPage": 25,
    "itemTotal": 1,
    "transitions": [
      {
        "to": "draft",
        "action": "start",
        "label": "In progress",
        "movesStock": false,
        "sideEffects": [
          "string"
        ]
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such stock count. |

---

### `POST /v1/admin/stock-counts/:countId/start`

**Start counting — freezes the system quantities**

| | |
|---|---|
| operationId | `adminStartStockCount` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

**This is the freeze.** Every inventory level in scope becomes a count line carrying the on-hand quantity as it is at this instant, written in ONE `INSERT … SELECT` so the whole sheet is a single consistent read rather than a walk that is already stale by row nine hundred.

That frozen `systemQty` is never re-read. If approval compared the count against live on-hand instead, every sale that happened while the counter walked the aisle would be silently absorbed and the variance would come out zero — a count that always agrees with itself finds nothing, which is exactly the failure a count exists to catch. Sales during the count remain their own `outbound` movements and the ledger stays additive.

Legal only from `draft`. An empty scope is `nothing_to_count` rather than a sheet that could be approved as a flawless count over zero items.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `countId` | `uuid` | **yes** | — | Stock count id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `countedBy` | `uuid` | no | — | Staff member doing the counting. Defaults to the caller. |

Example request:

```json
{
  "countedBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e"
}
```

**Response `200`** — The count, now `in_progress`, with `itemsInScope` frozen.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "countNo": "PRD-2026-00001",
    "warehouseId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "warehouseCode": "DIWALI20",
    "locationId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "locationPath": "A/R3/S2",
    "kind": "full",
    "status": "draft",
    "scheduledFor": "2026-08-25T10:30:00.000Z",
    "startedAt": "2026-08-25T10:30:00.000Z",
    "completedAt": "2026-08-25T10:30:00.000Z",
    "approvedAt": "2026-08-25T10:30:00.000Z",
    "createdBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "countedBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "approvedBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "note": "Damaged in transit",
    "totals": {
      "itemsInScope": 1,
      "itemsCounted": 3,
      "itemsUncounted": 3,
      "itemsWithVariance": 1,
      "netVarianceQty": 10,
      "absVarianceQty": 10
    },
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such stock count. |
| `422` | `illegal_count_transition`, `nothing_to_count`, or `count_location_missing`. |

---

### `POST /v1/admin/stock-counts/:countId/items`

**Record counted quantities**

| | |
|---|---|
| operationId | `adminSubmitStockCountItems` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Records what was physically counted. Call it as many times as the counting takes — a handheld submitting one bin at a time and a spreadsheet upload of five hundred lines use the same endpoint.

**Only while the count is `in_progress`.** A draft has no frozen `systemQty` to measure against, and a completed or approved sheet has numbers an approver has already reviewed; either is refused with the stable code `count_not_in_progress` and a message saying which it is.

**Every SKU must already be on the sheet.** Scope is the set of levels frozen at start, so a SKU that is stocked in the warehouse but sits outside the count’s location subtree is refused with `sku_not_in_count_scope` rather than quietly widened. The same SKU twice in one submission is `duplicate_count_item` — which of the two numbers is the count is not something insertion order should decide.

All-or-nothing: one bad line rejects the whole submission and writes nothing. `countedQty: 0` is a legitimate answer meaning the bin is empty, and is entirely different from leaving the line uncounted.

Nothing here moves stock.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `countId` | `uuid` | **yes** | — | Stock count id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `items` | `object[]` | **yes** | min 1 items, max 500 items | Up to 500 lines. All-or-nothing: one bad SKU rejects the whole submission and writes nothing. |

Example request:

```json
{
  "items": [
    {
      "sku": "ACH-CAN-001",
      "countedQty": 10,
      "recountQty": 10,
      "reason": "Damaged in transit"
    }
  ]
}
```

**Response `200`** — The lines as they now stand, plus the roll-up over the whole sheet.

```json
{
  "type": "success",
  "result": {
    "countId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "accepted": 1,
    "items": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "itemKind": "variant",
        "itemId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "sku": "ACH-CAN-001",
        "name": "Brass Diya Set",
        "binLocation": "A/R3/S2",
        "locationPath": "A/R3/S2",
        "systemQty": 10,
        "countedQty": 10,
        "varianceQty": 10,
        "recountQty": 10,
        "reason": "Damaged in transit",
        "countedAt": "2026-08-25T10:30:00.000Z",
        "countedBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
      }
    ],
    "totals": {
      "itemsInScope": 1,
      "itemsCounted": 3,
      "itemsUncounted": 3,
      "itemsWithVariance": 1,
      "netVarianceQty": 10,
      "absVarianceQty": 10
    }
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such stock count. |
| `422` | `count_not_in_progress`, `sku_not_in_count_scope`, or `duplicate_count_item`. |

---

### `POST /v1/admin/stock-counts/:countId/complete`

**Finish counting**

| | |
|---|---|
| operationId | `adminCompleteStockCount` |
| Auth | Bearer staff token |
| Permission | `inventory:edit` |

Marks the counting done and stamps `completedAt`. **No stock moves here** — completion is not approval, and separating them is what gives a second person something to review.

A sheet where nothing was counted is refused (`nothing_counted`): completing it would produce a document asserting that a warehouse was checked when no shelf was walked.

A sheet with SOME lines uncounted is refused unless `allowUncounted: true`. Uncounted lines are skipped at approval, never written off — but a signed-off count that silently omits them claims those SKUs were checked when they were not, so the partial count has to be deliberate.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `countId` | `uuid` | **yes** | — | Stock count id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `allowUncounted` | `boolean` | no | default `false` | Completing a sheet with lines nobody counted is refused unless this is `true`. It is an explicit acknowledgement, not a formality: an uncounted line is simply skipped at approval, so leaving one silently means that SKU was never checked despite appearing on a signed-off count. |
| `note` | `string` | no | max 2000 | Closing note from the counter. |

Example request:

```json
{
  "allowUncounted": false,
  "note": "Damaged in transit"
}
```

**Response `200`** — The count, now `completed`.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "countNo": "PRD-2026-00001",
    "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "warehouseCode": "DIWALI20",
    "locationId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "locationPath": "A/R3/S2",
    "kind": "full",
    "status": "draft",
    "scheduledFor": "2026-08-25T10:30:00.000Z",
    "startedAt": "2026-08-25T10:30:00.000Z",
    "completedAt": "2026-08-25T10:30:00.000Z",
    "approvedAt": "2026-08-25T10:30:00.000Z",
    "createdBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "countedBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "approvedBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "note": "Damaged in transit",
    "totals": {
      "itemsInScope": 1,
      "itemsCounted": 3,
      "itemsUncounted": 3,
      "itemsWithVariance": 1,
      "netVarianceQty": 10,
      "absVarianceQty": 10
    },
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such stock count. |
| `422` | `illegal_count_transition`, `nothing_counted`, or `uncounted_items`. |

---

### `POST /v1/admin/stock-counts/:countId/approve`

**Approve the count and post the variance**

| | |
|---|---|
| operationId | `adminApproveStockCount` |
| Auth | Bearer staff token |
| Permission | `inventory:approve` |

The only step that touches stock, gated on `inventory:approve` — walking a shelf and authorising a write-off are different jobs.

One transaction. The count row is locked, every varying level is locked in ascending `inventory_level_id` order (§62, so an approval and a checkout queue instead of deadlocking), and for each line an ADJUSTMENT of exactly `countedQty − systemQty` is posted as a `stock_count` movement referenced to `stock_count`/`countNo`, carrying the balance its own conditional UPDATE returned. If any line fails, none of it happened.

**It is an adjustment, never an assignment.** No statement anywhere sets `on_hand_qty = countedQty`; that would leave no ledger row and break the property that `SUM(quantity_delta)` reconstructs on-hand.

A line counted exactly right writes NO movement — a movement of nothing is not a movement — so `itemsAdjusted` is smaller than `itemsCounted` on a healthy count. Uncounted lines are skipped entirely and reported as `itemsSkippedUncounted`; they are never treated as a count of zero.

A shortfall that would drive stock below what is already RESERVED is refused with `insufficient_stock` and nothing is written. Those units are promised to open orders, and a count that "fixed" a number by breaking a delivery has not fixed anything. The message names the remedies: recount in case the stock is in another bin, release stale reservations, or let the order’s own outbound movement record the pick and recount after.

Requires an `Idempotency-Key`. A retry with the same key replays the stored response; a second genuine approval is refused with `count_already_approved`, because the ledger is append-only and posting the variance twice would double it.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `countId` | `uuid` | **yes** | — | Stock count id. |

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `note` | `string` | no | max 2000 | Approver’s note. Written onto every movement this posts. |

Example request:

```json
{
  "note": "Damaged in transit"
}
```

**Response `200`** — The approved count and one entry per movement posted.

```json
{
  "type": "success",
  "result": {
    "count": {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "countNo": "PRD-2026-00001",
      "warehouseId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "warehouseCode": "DIWALI20",
      "locationId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "locationPath": "A/R3/S2",
      "kind": "full",
      "status": "draft",
      "scheduledFor": "2026-08-25T10:30:00.000Z",
      "startedAt": "2026-08-25T10:30:00.000Z",
      "completedAt": "2026-08-25T10:30:00.000Z",
      "approvedAt": "2026-08-25T10:30:00.000Z",
      "createdBy": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "countedBy": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "approvedBy": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "note": "Damaged in transit",
      "totals": {
        "itemsInScope": 1,
        "itemsCounted": 3,
        "itemsUncounted": 3,
        "itemsWithVariance": 1,
        "netVarianceQty": 10,
        "absVarianceQty": 10
      },
      "createdAt": "2026-08-25T10:30:00.000Z"
    },
    "itemsAdjusted": 1,
    "itemsSkippedUncounted": 3,
    "netVarianceQty": 10,
    "absVarianceQty": 10,
    "movements": [
      {
        "movementId": "string",
        "inventoryLevelId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "systemQty": 10,
        "countedQty": 10,
        "varianceQty": 10,
        "onHandQtyBefore": 10,
        "onHandQty": 10,
        "reservedQty": 10,
        "availableQty": 10
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | Missing or malformed `Idempotency-Key`. |
| `404` | No such stock count. |
| `409` | That `Idempotency-Key` was used with a different body, or a first attempt is still in flight. |
| `422` | `count_not_completed`, `count_already_approved`, `illegal_count_transition`, or `insufficient_stock` — nothing was posted. |

---
