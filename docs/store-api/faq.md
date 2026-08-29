# FAQ

1 endpoint — 0 require a signed-in customer, 1 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/faqs`](#get-v1-faqs) — List FAQs

---

### `GET /v1/faqs`

**List FAQs**

| | |
|---|---|
| operationId | `listFaqs` |
| Auth | Public — no token needed |

Published question-and-answer pairs, grouped by category and ordered for the accordion. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `category` | `string` | no | max 80 | Restrict to one category. |

**Response `200`** — A page of FAQs.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "question": "string",
      "answer": "string",
      "category": "string",
      "position": 1,
      "helpfulCount": 3,
      "unhelpfulCount": 3
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
