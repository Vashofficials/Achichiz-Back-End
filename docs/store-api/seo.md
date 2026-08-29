# SEO

1 endpoint — 0 require a signed-in customer, 1 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/seo`](#get-v1-seo) — Get the SEO record for an entity or a route

---

### `GET /v1/seo`

**Get the SEO record for an entity or a route**

| | |
|---|---|
| operationId | `getSeoEntry` |
| Auth | Public — no token needed |

Meta tags, canonical URL, robots directives and JSON-LD. Look up either an entity (`entityType` + `entityId`) or a bare route (`routePath`, e.g. `/`) — exactly one of the two. Product, collection, page and post detail responses already embed their own SEO block; this endpoint exists for routes that have no entity behind them.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `entityType` | `"product" \| "collection" \| "content_page" \| "blog_post"` | no | — | Entity kind. Requires `entityId`. Omit both to look up a route instead. |
| `entityId` | `uuid` | no | — | Entity id. Requires `entityType`. |
| `routePath` | `string` | no | max 200 | Route to look up instead of an entity, e.g. `/` or `/corporate-gifting`. |

**Response `200`** — The SEO record.

```json
{
  "type": "success",
  "result": {
    "metaTitle": "Brass Diya Set",
    "metaDescription": "string",
    "canonicalUrl": "https://cdn.achichiz.in/media/diya.jpg",
    "focusKeyword": "string",
    "robotsIndex": false,
    "robotsFollow": false,
    "ogImageUrl": "https://cdn.achichiz.in/media/diya.jpg",
    "structuredData": null,
    "entityType": "product",
    "entityId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "routePath": "string"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | Nothing has been authored for that entity or route. |

---
