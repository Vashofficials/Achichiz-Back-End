# Admin resources

1 endpoint. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/resources`](#get-v1-admin-resources) — The resource registry

---

### `GET /v1/admin/resources`

**The resource registry**

| | |
|---|---|
| operationId | `adminListResources` |
| Auth | Bearer staff token |
| Permission | `dashboard:view` |

Every generic resource this API serves, filtered to the ones your role can view. The console can build its nav from this instead of hardcoding 59 entries. Each carries its `basePath` (the five CRUD routes hang off it) and its `schemaPath` (the field spec that drives the forms).

**Response `200`** — Resources you can view.

```json
{
  "type": "success",
  "result": [
    {
      "slug": "brass-diya-set",
      "title": "Brass Diya Set",
      "group": "inventory",
      "module": "dashboard",
      "basePath": "string",
      "schemaPath": "string"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 25,
    "total": 1,
    "totalPages": 1
  }
}
```

---
