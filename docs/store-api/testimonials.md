# Testimonials

1 endpoint — 0 require a signed-in customer, 1 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/testimonials`](#get-v1-testimonials) — List testimonials

---

### `GET /v1/testimonials`

**List testimonials**

| | |
|---|---|
| operationId | `listTestimonials` |
| Auth | Public — no token needed |

Moderated marketing quotes. B2C quotes carry `authorCity`; B2B quotes carry `company` and `designation`. These are NOT product reviews — those live on the product. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `featured` | `"0" \| "1" \| "true" \| "false"` | no | — | `true` keeps only featured testimonials. |

**Response `200`** — A page of testimonials.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "authorName": "Brass Diya Set",
      "authorCity": "string",
      "company": "string",
      "designation": "string",
      "quote": "string",
      "rating": 1,
      "image": {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string"
      },
      "isFeatured": false,
      "position": 1
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
