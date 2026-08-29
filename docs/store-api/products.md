# Products

3 endpoints — 0 require a signed-in customer, 3 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/products`](#get-v1-products) — List and filter products
- [`GET /v1/products/:handle`](#get-v1-products-handle) — Get a product by handle
- [`GET /v1/products/:handle/variants`](#get-v1-products-handle-variants) — List a product’s variants

---

### `GET /v1/products`

**List and filter products**

| | |
|---|---|
| operationId | `listProducts` |
| Auth | Public — no token needed |

The product grid behind `/collections/:handle` and every merchandising rail. `price`, `stock`, `sameDay`, `bestSeller` and `isNew` are derived at read time from variants, inventory and collection membership — none of them is a stored column. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

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

**Response `200`** — A page of products.

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

---

### `GET /v1/products/:handle`

**Get a product by handle**

| | |
|---|---|
| operationId | `getProductByHandle` |
| Auth | Public — no token needed |

Everything the PDP renders in one call: gallery, contents, variants with per-variant stock, add-ons (falling back to the global set when none are pinned), personalisation templates, related handles and SEO overrides.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | **yes** | min 2, max 120 | URL slug of the resource, e.g. `bamboo-water-bottle`. |

**Response `200`** — The product.

```json
{
  "type": "success",
  "result": {
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
    "publishedAt": "2026-08-25T10:30:00.000Z",
    "description": "Free-text description.",
    "isPerishable": false,
    "isFragile": false,
    "images": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string",
        "position": 1
      }
    ],
    "contents": [
      "string"
    ],
    "variants": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "sku": "ACH-CAN-001",
        "optionLabel": "Small",
        "optionValue": "string",
        "pricePaise": 149900,
        "compareAtPaise": 149900,
        "weightGrams": 1,
        "isDefault": false,
        "position": 1,
        "stock": "in",
        "stockQty": 2
      }
    ],
    "addOns": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "code": "DIWALI20",
        "name": "Brass Diya Set",
        "kind": "packaging",
        "pricePaise": 149900,
        "requiresInput": false,
        "inputCharLimit": 1,
        "leadTimeHours": 1
      }
    ],
    "personalisationTemplates": [
      {
        "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "name": "Brass Diya Set",
        "method": "engraving",
        "turnaroundHours": 1,
        "charLimit": 1,
        "allowsImage": false,
        "proofRequired": false,
        "surchargePaise": 149900
      }
    ],
    "relatedHandles": [
      "brass-diya-set"
    ],
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
| `404` | No published product has that handle. |

---

### `GET /v1/products/:handle/variants`

**List a product’s variants**

| | |
|---|---|
| operationId | `listProductVariants` |
| Auth | Public — no token needed |

The stock-bearing units. Cart lines reference a variant id, never a product id. Already included in `getProductByHandle` — use this when only availability changed.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | **yes** | min 2, max 120 | URL slug of the resource, e.g. `bamboo-water-bottle`. |

**Response `200`** — Active variants in display order.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "sku": "ACH-CAN-001",
      "optionLabel": "Small",
      "optionValue": "string",
      "pricePaise": 149900,
      "compareAtPaise": 149900,
      "weightGrams": 1,
      "isDefault": false,
      "position": 1,
      "stock": "in",
      "stockQty": 2
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
| `404` | No published product has that handle. |

---
