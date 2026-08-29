# Hamper builder

2 endpoints — 0 require a signed-in customer, 2 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/hamper-builder/templates`](#get-v1-hamper-builder-templates) — List build-your-own-hamper templates
- [`GET /v1/hamper-builder/templates/:handle`](#get-v1-hamper-builder-templates-handle) — Get a hamper builder template with its steps and options

---

### `GET /v1/hamper-builder/templates`

**List build-your-own-hamper templates**

| | |
|---|---|
| operationId | `listHamperBuilderTemplates` |
| Auth | Public — no token needed |

Live builder templates. Fetch one by handle for the wizard itself. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |

**Response `200`** — A page of builder templates.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "handle": "brass-diya-set",
      "name": "Brass Diya Set",
      "basePricePaise": 149900,
      "maxWeightGrams": 1,
      "stepCount": 3
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

### `GET /v1/hamper-builder/templates/:handle`

**Get a hamper builder template with its steps and options**

| | |
|---|---|
| operationId | `getHamperBuilderTemplate` |
| Auth | Public — no token needed |

The whole wizard in one call. Per-step `minChoices`/`maxChoices` are the real constraints and are re-enforced when the hamper is added to a cart. An option is `stock: "out"` when it is switched off or its component has no available units — that is computed live, never hardcoded.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `handle` | `string` | **yes** | min 2, max 120 | URL slug of the resource, e.g. `bamboo-water-bottle`. |

**Response `200`** — The template, its steps and their options.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "handle": "brass-diya-set",
    "name": "Brass Diya Set",
    "basePricePaise": 149900,
    "maxWeightGrams": 1,
    "steps": [
      {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "position": 1,
        "title": "Brass Diya Set",
        "note": "Please leave with the concierge.",
        "stepKind": "packaging",
        "minChoices": 1,
        "maxChoices": 1,
        "options": [
          {
            "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
            "label": "Home",
            "pricePaise": 149900,
            "weightGrams": 1,
            "position": 1,
            "stock": "in"
          }
        ]
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No live builder template has that handle. |

---
