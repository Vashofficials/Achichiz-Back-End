# Journal

2 endpoints — 0 require a signed-in customer, 2 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/blog/posts`](#get-v1-blog-posts) — List journal posts
- [`GET /v1/blog/posts/:slug`](#get-v1-blog-posts-slug) — Get a journal post by slug

---

### `GET /v1/blog/posts`

**List journal posts**

| | |
|---|---|
| operationId | `listBlogPosts` |
| Auth | Public — no token needed |

Published posts, newest first. Scheduled posts stay hidden until their publish time passes. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `category` | `string` | no | max 80 | Restrict to one editorial category. |

**Response `200`** — A page of journal posts.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "slug": "brass-diya-set",
      "title": "Brass Diya Set",
      "excerpt": "string",
      "category": "string",
      "authorName": "Brass Diya Set",
      "heroImage": {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string"
      },
      "readMinutes": 1,
      "viewCount": 3,
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

### `GET /v1/blog/posts/:slug`

**Get a journal post by slug**

| | |
|---|---|
| operationId | `getBlogPostBySlug` |
| Auth | Public — no token needed |

The post with its ordered body blocks, the "keep reading" slugs and any SEO overrides. Unknown block types must be skipped by the renderer, never thrown on.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `slug` | `string` | **yes** | min 2, max 160 | URL slug of the resource, e.g. `shipping` or `gifting-for-diwali`. |

**Response `200`** — The post.

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "slug": "brass-diya-set",
    "title": "Brass Diya Set",
    "excerpt": "string",
    "category": "string",
    "authorName": "Brass Diya Set",
    "heroImage": {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "url": "https://cdn.achichiz.in/media/diya.jpg",
      "altText": "string"
    },
    "readMinutes": 1,
    "viewCount": 3,
    "publishedAt": "2026-08-25T10:30:00.000Z",
    "body": [
      null
    ],
    "relatedSlugs": [
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
| `404` | No published post has that slug. |

---
