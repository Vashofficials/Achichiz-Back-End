# Designers

2 endpoints — 0 require a signed-in customer, 2 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/designers`](#get-v1-designers) — List designers and brands
- [`GET /v1/designers/:handle`](#get-v1-designers-handle) — Get a designer by handle

---

### `GET /v1/designers`

**List designers and brands**

| | |
|---|---|
| operationId | `listDesigners` |
| Auth | Public — no token needed |

Makers attributed on the PDP: designers, brands, celebrities and artisan clusters. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `kind` | `"designer" \| "brand" \| "celebrity" \| "artisan_cluster"` | no | — | Restrict to one maker kind. |

**Response `200`** — A page of designers.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "handle": "brass-diya-set",
      "name": "Brass Diya Set",
      "kind": "designer",
      "bio": "string",
      "logo": {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string",
        "position": 1
      },
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

### `GET /v1/designers/:handle`

**Get a designer by handle**

| | |
|---|---|
| operationId | `getDesignerByHandle` |
| Auth | Public — no token needed |

Backs the designer landing page. Fetch their products with `listProducts?designer=…`.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | **yes** | min 2, max 120 | URL slug of the resource, e.g. `bamboo-water-bottle`. |

**Response `200`** — The designer.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "handle": "brass-diya-set",
    "name": "Brass Diya Set",
    "kind": "designer",
    "bio": "string",
    "logo": {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "url": "https://cdn.achichiz.in/media/diya.jpg",
      "altText": "string",
      "position": 1
    },
    "productCount": 3
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No active designer has that handle. |

---
