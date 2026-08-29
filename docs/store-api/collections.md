# Collections

3 endpoints — 0 require a signed-in customer, 3 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/collections`](#get-v1-collections) — List collections
- [`GET /v1/collections/:handle`](#get-v1-collections-handle) — Get a collection with its facets
- [`GET /v1/collections/:handle/products`](#get-v1-collections-handle-products) — List products in a collection

---

### `GET /v1/collections`

**List collections**

| | |
|---|---|
| operationId | `listCollections` |
| Auth | Public — no token needed |

One table serves all six taxonomy kinds (category, recipient, occasion, festival, designer, edit) — filter with `kind`. `productCount` counts live products only. Scheduled collections appear once their window opens. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `kind` | `"category" \| "recipient" \| "occasion" \| "festival" \| "designer" \| "edit"` | no | — | Restrict to one taxonomy kind. |
| `parent` | `string` | no | — | Restrict to direct children of this collection handle. |
| `featured` | `"0" \| "1" \| "true" \| "false"` | no | — | `true` keeps only featured collections. |

**Response `200`** — A page of collections.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "handle": "brass-diya-set",
      "kind": "category",
      "parentHandle": "brass-diya-set",
      "title": "Brass Diya Set",
      "heading": "string",
      "subtext": "string",
      "seoDescription": "string",
      "image": {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string",
        "position": 1
      },
      "curator": "string",
      "designer": {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "handle": "brass-diya-set",
        "name": "Brass Diya Set"
      },
      "isFeatured": false,
      "sortOrder": 1,
      "productCount": 3
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

### `GET /v1/collections/:handle`

**Get a collection with its facets**

| | |
|---|---|
| operationId | `getCollectionByHandle` |
| Auth | Public — no token needed |

The collection plus the two things the listing page cannot compute for itself: the category facets actually present in it (with counts) and the real price-slider bounds. Fetch the products themselves from `listCollectionProducts`.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | **yes** | min 2, max 120 | URL slug of the resource, e.g. `bamboo-water-bottle`. |

**Response `200`** — The collection, its facets and price bounds.

```json
{
  "type": "success",
  "result": {
    "collection": {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "handle": "brass-diya-set",
      "kind": "category",
      "parentHandle": "brass-diya-set",
      "title": "Brass Diya Set",
      "heading": "string",
      "subtext": "string",
      "seoDescription": "string",
      "image": {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string",
        "position": 1
      },
      "curator": "string",
      "designer": {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "handle": "brass-diya-set",
        "name": "Brass Diya Set"
      },
      "isFeatured": false,
      "sortOrder": 1,
      "productCount": 3
    },
    "availableTypes": [
      {
        "handle": "brass-diya-set",
        "title": "Brass Diya Set",
        "count": 3
      }
    ],
    "priceBounds": {
      "minPaise": 149900,
      "maxPaise": 149900
    },
    "seo": {
      "metaTitle": "Brass Diya Set",
      "metaDescription": "string",
      "canonicalUrl": "https://cdn.achichiz.in/media/diya.jpg",
      "focusKeyword": "string",
      "robotsIndex": false,
      "robotsFollow": false,
      "ogImageUrl": "https://cdn.achichiz.in/media/diya.jpg",
      "structuredData": null
    }
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No live collection has that handle. |

---

### `GET /v1/collections/:handle/products`

**List products in a collection**

| | |
|---|---|
| operationId | `listCollectionProducts` |
| Auth | Public — no token needed |

Identical filtering and sorting to `listProducts`, scoped to one collection. The path segment wins: a `collection` query parameter cannot widen the result set. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | **yes** | min 2, max 120 | URL slug of the resource, e.g. `bamboo-water-bottle`. |

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `collection` | `string` | no | — | Restrict to a collection handle, any kind. e.g. `festivals-diwali`. |
| `type` | `string` | no | — | Category handle(s) to include. Repeat the parameter for several, e.g. `type=drinkware&type=candles`. |
| `designer` | `string` | no | — | Restrict to one designer handle. |
| `minPricePaise` | `integer` | no | ≥ 0 | Inclusive lower price bound, integer paise. |
| `maxPricePaise` | `integer` | no | ≥ 0 | Inclusive upper price bound, integer paise. |
| `inStock` | `"0" \| "1" \| "true" \| "false"` | no | — | `true` hides products whose `stock` is `out`. |
| `sameDay` | `"0" \| "1" \| "true" \| "false"` | no | — | `true` keeps only products with same-day-capable stock. |
| `personalisable` | `"0" \| "1" \| "true" \| "false"` | no | — | `true` keeps only personalisable products. |

**Response `200`** — A page of products in the collection.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "handle": "brass-diya-set",
      "sku": "ACH-CAN-001",
      "title": "Brass Diya Set",
      "subtitle": "Brass Diya Set",
      "kind": "hamper",
      "designer": {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "handle": "brass-diya-set",
        "name": "Brass Diya Set"
      },
      "type": "string",
      "typeLabel": "string",
      "pricePaise": 149900,
      "compareAtPaise": 149900,
      "image": {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
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

**Errors**

| Status | Meaning |
|---|---|
| `404` | No live collection has that handle. |

---
