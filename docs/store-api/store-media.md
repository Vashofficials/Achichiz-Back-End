# Store / Media

1 endpoint — 1 require a signed-in customer, 0 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`POST /v1/store/media/upload`](#post-v1-store-media-upload) 🔒 — Upload a media asset

---

### `POST /v1/store/media/upload`

**Upload a media asset**

| | |
|---|---|
| operationId | `uploadCustomerMedia` |
| Auth | **Bearer customer token required** |

Uploads a file to S3 and creates a media asset record. The returned `id` can be used in storefront APIs (like reviews or custom orders).

**Request body** — none. Send `{}` or omit.

**Response `201`** — The uploaded media asset.

```json
{
  "type": "success",
  "result": {
    "data": {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "url": "https://cdn.achichiz.in/media/diya.jpg",
      "cdnUrl": "https://cdn.achichiz.in/media/diya.jpg",
      "filename": "Brass Diya Set",
      "mimeType": "string",
      "kind": "image",
      "bytes": 1,
      "widthPx": 1,
      "heightPx": 1,
      "createdAt": "2026-08-25T10:30:00.000Z"
    }
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `400` | No file provided or file too large. |

---
