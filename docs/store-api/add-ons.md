# Add-ons

2 endpoints — 0 require a signed-in customer, 2 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/add-ons`](#get-v1-add-ons) — List add-ons
- [`GET /v1/personalisation-templates`](#get-v1-personalisation-templates) — List personalisation templates

---

### `GET /v1/add-ons`

**List add-ons**

| | |
|---|---|
| operationId | `listAddOns` |
| Auth | Public — no token needed |

Gift wrap, cards, engraving and the rest. Pass `product` to get exactly what that product offers with its per-product price override already applied; omit it for the global catalogue. `pricePaise` is always the price to charge — never re-derive it. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `kind` | `"packaging" \| "message" \| "fresh" \| "bakery" \| "digital" \| "engraving" \| "other"` | no | — | Restrict to one add-on kind. |
| `product` | `string` | no | — | Product handle. Returns exactly the add-ons that product offers, with any per-product price override already applied. Omit for the global catalogue of active add-ons. |

**Response `200`** — A page of add-ons.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "code": "DIWALI20",
      "name": "Brass Diya Set",
      "kind": "packaging",
      "pricePaise": 149900,
      "requiresInput": false,
      "inputCharLimit": 1,
      "leadTimeHours": 1
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
| `404` | `product` was supplied and no published product has that handle. |

---

### `GET /v1/personalisation-templates`

**List personalisation templates**

| | |
|---|---|
| operationId | `listPersonalisationTemplates` |
| Auth | Public — no token needed |

Engraving, embroidery, print, digital and laser methods with their turnaround, character cap and proof policy. `charLimit` is enforced server-side at cart and order time — the HTML `maxlength` is not the rule. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `method` | `"engraving" \| "embroidery" \| "print" \| "digital" \| "laser"` | no | — | Restrict to one production method. |
| `product` | `string` | no | — | Product handle. Returns only the templates pinned to that product. |

**Response `200`** — A page of templates.

```json
{
  "type": "success",
  "result": [
    {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "name": "Brass Diya Set",
      "method": "engraving",
      "turnaroundHours": 1,
      "charLimit": 1,
      "allowsImage": false,
      "proofRequired": false,
      "surchargePaise": 149900
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
| `404` | `product` was supplied and no published product has that handle. |

---
