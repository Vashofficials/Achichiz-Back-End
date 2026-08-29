# Navigation

1 endpoint — 0 require a signed-in customer, 1 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/menus/:key`](#get-v1-menus-key) — Get a navigation menu

---

### `GET /v1/menus/:key`

**Get a navigation menu**

| | |
|---|---|
| operationId | `getMenuByKey` |
| Auth | Public — no token needed |

A named menu (`header`, `footer`, `mobile`) with every visible item as a FLAT, depth-ordered array. Build the tree from `parentId`: megamenu depth is not fixed and a self-referencing response type is not expressible in a generated client. A hidden parent hides its whole branch, and items pointing at a dead collection are omitted.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `key` | `string` | **yes** | min 2, max 60 | Menu key. The three that exist today are `header`, `footer` and `mobile`. |

**Response `200`** — The menu and its items.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "key": "main-nav",
    "name": "Brass Diya Set",
    "items": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "parentId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
        "label": "Home",
        "url": "https://cdn.achichiz.in/media/diya.jpg",
        "collectionHandle": "brass-diya-set",
        "contentPageSlug": "brass-diya-set",
        "image": {
          "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
          "url": "https://cdn.achichiz.in/media/diya.jpg",
          "altText": "string"
        },
        "position": 1
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No menu has that key. |

---
