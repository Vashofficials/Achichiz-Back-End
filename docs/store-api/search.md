# Search

3 endpoints — 0 require a signed-in customer, 3 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/search`](#get-v1-search) — Search products
- [`GET /v1/search/suggest`](#get-v1-search-suggest) — Autocomplete products for the header search
- [`GET /v1/search/suggestions`](#get-v1-search-suggestions) — Recovery hints for a search that returned nothing

---

### `GET /v1/search`

**Search products**

| | |
|---|---|
| operationId | `searchProducts` |
| Auth | Public — no token needed |

Full-text search with typo tolerance. Results are the same `productSummary` shape `listProducts` returns, so a result card and a grid card are one component. Ranking weights title matches over body matches and gives best sellers a small nudge. When `meta.total` is 0, call `getSearchSuggestions` for the recovery screen. Never cached — availability in results is as live as the PDP.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `"relevance" \| "price" \| "-price" \| "publishedAt" \| "-publishedAt"` | no | — | Ordering. `relevance` (the default) is always best-first. Prefix with `-` for descending, e.g. `-price` for dearest first. |
| `q` | `string` | **yes** | min 1, max 120 | The shopper’s raw query. Typos are tolerated; punctuation is ignored. |
| `type` | `string` | no | — | Category handle(s) to restrict to. Repeat the parameter or comma-separate, e.g. `type=drinkware,candles`. |
| `minPricePaise` | `integer` | no | ≥ 0 | Inclusive lower price bound, integer paise. |
| `maxPricePaise` | `integer` | no | ≥ 0 | Inclusive upper price bound, integer paise. |

**Response `200`** — A page of matching products, wrapped as `{ data, meta }`.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "handle": "brass-diya-set",
      "sku": "ACH-CAN-001",
      "title": "Brass Diya Set",
      "subtitle": "Brass Diya Set",
      "kind": "hamper",
      "designer": {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "handle": "brass-diya-set",
        "name": "Brass Diya Set"
      },
      "type": "string",
      "typeLabel": "string",
      "pricePaise": 149900,
      "compareAtPaise": 149900,
      "image": {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string",
        "position": 1
      },
      "collectionHandles": [
        "brass-diya-set"
      ],
      "occasionHandles": [
        "brass-diya-set"
      ],
      "recipientHandles": [
        "brass-diya-set"
      ],
      "stock": "in",
      "stockQty": 2,
      "sameDay": false,
      "bestSeller": false,
      "isNew": false,
      "personalisable": false,
      "tags": [
        "string"
      ],
      "ratingAvg": 1,
      "reviewCount": 3,
      "publishedAt": "2026-08-25T10:30:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 24,
    "total": 1,
    "totalPages": 1
  }
}
```

---

### `GET /v1/search/suggest`

**Autocomplete products for the header search**

| | |
|---|---|
| operationId | `suggestProducts` |
| Auth | Public — no token needed |

Fast prefix-biased lookup for the search-as-you-type dropdown. Title-prefix hits come first, then fuzzy matches, then popularity. Send at least two characters; shorter queries tokenise to nothing and return an empty page.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `6`, > 0, ≤ 20 | Autocomplete rows to return. Maximum 20, default 6. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | **yes** | min 1, max 120 | The shopper’s raw query. Typos are tolerated; punctuation is ignored. |

**Response `200`** — Up to `perPage` autocomplete matches, wrapped as `{ data, meta }`.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "handle": "brass-diya-set",
      "sku": "ACH-CAN-001",
      "title": "Brass Diya Set",
      "subtitle": "Brass Diya Set",
      "kind": "hamper",
      "designer": {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "handle": "brass-diya-set",
        "name": "Brass Diya Set"
      },
      "type": "string",
      "typeLabel": "string",
      "pricePaise": 149900,
      "compareAtPaise": 149900,
      "image": {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string",
        "position": 1
      },
      "collectionHandles": [
        "brass-diya-set"
      ],
      "occasionHandles": [
        "brass-diya-set"
      ],
      "recipientHandles": [
        "brass-diya-set"
      ],
      "stock": "in",
      "stockQty": 2,
      "sameDay": false,
      "bestSeller": false,
      "isNew": false,
      "personalisable": false,
      "tags": [
        "string"
      ],
      "ratingAvg": 1,
      "reviewCount": 3,
      "publishedAt": "2026-08-25T10:30:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 24,
    "total": 1,
    "totalPages": 1
  }
}
```

---

### `GET /v1/search/suggestions`

**Recovery hints for a search that returned nothing**

| | |
|---|---|
| operationId | `getSearchSuggestions` |
| Auth | Public — no token needed |

Everything the no-results screen needs, in one call: a "did you mean" rewrite, the number of matches once every filter is dropped, and the categories and price windows that do hold matches. `fallback` is populated only when the query matches nothing at all — that is the "here are some popular gifts instead" case.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `q` | `string` | **yes** | min 1, max 120 | The shopper’s raw query. Typos are tolerated; punctuation is ignored. |

**Response `200`** — Suggestions for relaxing or correcting the query.

```json
{
  "type": "success",
  "result": {
    "didYouMean": "string",
    "unfilteredCount": 3,
    "types": [
      {
        "handle": "brass-diya-set",
        "title": "Brass Diya Set",
        "count": 3
      }
    ],
    "priceRanges": [
      {
        "minPaise": 149900,
        "maxPaise": 149900,
        "count": 3
      }
    ],
    "fallback": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "handle": "brass-diya-set",
        "sku": "ACH-CAN-001",
        "title": "Brass Diya Set",
        "subtitle": "Brass Diya Set",
        "kind": "hamper",
        "designer": {
          "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
          "handle": "brass-diya-set",
          "name": "Brass Diya Set"
        },
        "type": "string",
        "typeLabel": "string",
        "pricePaise": 149900,
        "compareAtPaise": 149900,
        "image": {
          "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
          "url": "https://cdn.achichiz.in/media/diya.jpg",
          "altText": "string",
          "position": 1
        },
        "collectionHandles": [
          "brass-diya-set"
        ],
        "occasionHandles": [
          "brass-diya-set"
        ],
        "recipientHandles": [
          "brass-diya-set"
        ],
        "stock": "in",
        "stockQty": 2,
        "sameDay": false,
        "bestSeller": false,
        "isNew": false,
        "personalisable": false,
        "tags": [
          "string"
        ],
        "ratingAvg": 1,
        "reviewCount": 3,
        "publishedAt": "2026-08-25T10:30:00.000Z"
      }
    ]
  }
}
```

---
