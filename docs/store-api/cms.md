# CMS

2 endpoints — 0 require a signed-in customer, 2 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/cms/sections`](#get-v1-cms-sections) — List CMS sections with their items
- [`GET /v1/banners`](#get-v1-banners) — List live banners

---

### `GET /v1/cms/sections`

**List CMS sections with their items**

| | |
|---|---|
| operationId | `listCmsSections` |
| Auth | Public — no token needed |

The homepage and landing-page section slots, in page order, each with its visible tiles already attached. Pass `pageKey=home` for the homepage. Tiles pointing at an unpublished collection or product are dropped rather than rendered as dead links. Collections are wrapped as `{ data, meta }`; `meta` carries `page`, `perPage`, `total` and `totalPages`.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `pageKey` | `string` | no | max 60 | Page to fetch sections for. Defaults to every page; pass `home` for the homepage. |

**Response `200`** — A page of sections.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "key": "main-nav",
      "pageKey": "string",
      "title": "Brass Diya Set",
      "layout": "full_bleed",
      "position": 1,
      "settings": null,
      "items": [
        {
          "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
          "position": 1,
          "label": "Home",
          "sublabel": "string",
          "image": {
            "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
            "url": "https://cdn.achichiz.in/media/diya.jpg",
            "altText": "string"
          },
          "linkUrl": "https://cdn.achichiz.in/media/diya.jpg",
          "collectionHandle": "brass-diya-set",
          "productHandle": "brass-diya-set"
        }
      ]
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

### `GET /v1/banners`

**List live banners**

| | |
|---|---|
| operationId | `listBanners` |
| Auth | Public — no token needed |

Banners whose schedule window is open right now — the clock decides, not the status column, so a scheduled banner goes live without waiting for a job. Pass `device` to get creatives targeted at that device plus those targeted at all devices.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `page` | `integer` | no | default `1`, > 0 | 1-indexed page number. |
| `perPage` | `integer` | no | default `25`, > 0, ≤ 100 | Items per page. Maximum 100. |
| `sort` | `string` | no | — | Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`. |
| `q` | `string` | no | min 1, max 120 | Free-text search. |
| `placement` | `"homepage_hero" \| "category_top" \| "cart_strip" \| "pdp_ribbon" \| "announcement_bar"` | no | — | Restrict to one placement. |
| `device` | `"desktop" \| "mobile"` | no | — | Caller’s device. Returns banners targeted at it plus those targeted at `all`. |

**Response `200`** — A page of live banners.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "title": "Brass Diya Set",
      "subtitle": "Brass Diya Set",
      "placement": "homepage_hero",
      "device": "all",
      "image": {
        "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string"
      },
      "mobileImage": {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "altText": "string"
      },
      "linkUrl": "https://cdn.achichiz.in/media/diya.jpg",
      "collectionHandle": "brass-diya-set",
      "ctaLabel": "string",
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
