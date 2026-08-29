# Pages

3 endpoints — 0 require a signed-in customer, 3 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/pages`](#get-v1-pages) — List content pages
- [`GET /v1/pages/:slug`](#get-v1-pages-slug) — Get a content page by slug
- [`GET /v1/policies/:slug`](#get-v1-policies-slug) — Get a policy page by slug

---

### `GET /v1/pages`

**List content pages**

| | |
|---|---|
| operationId | `listContentPages` |
| Auth | Public — no token needed |

Occasion landing pages, policy pages, about and static pages — one table, discriminated by `kind`. Filter with `kind=policy` for the footer’s legal links. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `kind` | `"occasion" \| "policy" \| "landing" \| "about" \| "static"` | no | — | Restrict to one page kind. |

**Response `200`** — A page of content pages.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "slug": "brass-diya-set",
      "kind": "occasion",
      "title": "Brass Diya Set",
      "heading": "string",
      "heroImage": {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string"
      },
      "collectionHandle": "brass-diya-set",
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

### `GET /v1/pages/:slug`

**Get a content page by slug**

| | |
|---|---|
| operationId | `getContentPageBySlug` |
| Auth | Public — no token needed |

Any published page, whatever its kind. For an occasion page, `collectionHandle` names the collection whose products belong on it — fetch them with `listCollectionProducts`.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `slug` | `string` | **yes** | min 2, max 160 | URL slug of the resource, e.g. `shipping` or `gifting-for-diwali`. |

**Response `200`** — The page.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "slug": "brass-diya-set",
    "kind": "occasion",
    "title": "Brass Diya Set",
    "heading": "string",
    "heroImage": {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "url": "https://cdn.achichiz.in/media/diya.jpg",
      "altText": "string"
    },
    "collectionHandle": "brass-diya-set",
    "publishedAt": "2026-08-25T10:30:00.000Z",
    "body": [
      null
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
| `404` | No published page has that slug. |

---

### `GET /v1/policies/:slug`

**Get a policy page by slug**

| | |
|---|---|
| operationId | `getPolicyBySlug` |
| Auth | Public — no token needed |

The published, linkable policy URLs: `shipping`, `returns`, `privacy`, `terms`, `cookies`. Identical shape to `getContentPageBySlug` but restricted to `kind=policy`, so an occasion page can never be served from a `/policies/…` URL.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `slug` | `string` | **yes** | min 2, max 160 | URL slug of the resource, e.g. `shipping` or `gifting-for-diwali`. |

**Response `200`** — The policy page.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "slug": "brass-diya-set",
    "kind": "occasion",
    "title": "Brass Diya Set",
    "heading": "string",
    "heroImage": {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "url": "https://cdn.achichiz.in/media/diya.jpg",
      "altText": "string"
    },
    "collectionHandle": "brass-diya-set",
    "publishedAt": "2026-08-25T10:30:00.000Z",
    "body": [
      null
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
| `404` | No published policy page has that slug. |

---
