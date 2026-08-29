# Admin / Media

1 endpoint. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`POST /v1/admin/media/upload`](#post-v1-admin-media-upload) — Upload a media asset

---

### `POST /v1/admin/media/upload`

**Upload a media asset**

| | |
|---|---|
| operationId | `uploadMedia` |
| Auth | Bearer staff token |
| Permission | `dashboard:view` |

Uploads a file to S3 and creates a media asset record. The returned `id` can be used as an `imageRef` or `mediaId` in other Admin APIs.

**Request body** — none. Send `{}` or omit.

**Response `201`** — The uploaded media asset.

```json
{
  "type": "success",
  "result": {
    "data": {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
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
