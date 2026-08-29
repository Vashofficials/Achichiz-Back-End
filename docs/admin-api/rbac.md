# RBAC

5 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/admin/roles`](#get-v1-admin-roles) — List roles
- [`GET /v1/admin/roles/:roleId`](#get-v1-admin-roles-roleid) — Get one role
- [`GET /v1/admin/permissions`](#get-v1-admin-permissions) — The permission vocabulary
- [`GET /v1/admin/permissions/matrix`](#get-v1-admin-permissions-matrix) — The whole grant matrix, and its drift
- [`POST /v1/admin/roles/sync`](#post-v1-admin-roles-sync) — Re-seed roles and grants from the source matrix

---

### `GET /v1/admin/roles`

**List roles**

| | |
|---|---|
| operationId | `adminListRoles` |
| Auth | Bearer staff token |
| Permission | `settings:view` |

The eleven system roles with live staff counts and grant counts. Backs the role picker on `/settings/team` and the role column on the team list.

**Response `200`** — Roles, alphabetical.

```json
{
  "type": "success",
  "result": [
    {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "key": "inventory",
      "name": "Brass Diya Set",
      "description": "Free-text description.",
      "isSystem": false,
      "staffCount": 3,
      "grantCount": 3
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

### `GET /v1/admin/roles/:roleId`

**Get one role**

| | |
|---|---|
| operationId | `adminGetRole` |
| Auth | Bearer staff token |
| Permission | `settings:view` |

The role, its grants in both shapes (a flat `module:action` list and the module-pivoted map the matrix screen renders), and the staff members holding it.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `roleId` | `uuid` | **yes** | — | Role id from `GET /v1/admin/roles`. |

**Response `200`** — The role.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "key": "inventory",
    "name": "Brass Diya Set",
    "description": "Free-text description.",
    "isSystem": false,
    "staffCount": 3,
    "grantCount": 3,
    "permissions": [
      "string"
    ],
    "grants": {},
    "members": [
      {
        "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
        "fullName": "Brass Diya Set",
        "email": "ops@achichiz.in",
        "status": "active"
      }
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such role. |

---

### `GET /v1/admin/permissions`

**The permission vocabulary**

| | |
|---|---|
| operationId | `adminListPermissionCatalogue` |
| Auth | Bearer staff token |
| Permission | `settings:view` |

The twelve modules and nine actions, with labels. `mutating: false` marks `view` and `export` — a role holding nothing but those cannot change anything, which is exactly the test that decides whether two-factor authentication is mandatory for it.

**Response `200`** — Modules and actions.

```json
{
  "type": "success",
  "result": {
    "modules": [
      {
        "key": "dashboard",
        "label": "In progress"
      }
    ],
    "actions": [
      {
        "key": "view",
        "label": "In progress",
        "mutating": false
      }
    ]
  }
}
```

---

### `GET /v1/admin/permissions/matrix`

**The whole grant matrix, and its drift**

| | |
|---|---|
| operationId | `adminGetPermissionMatrix` |
| Auth | Bearer staff token |
| Permission | `settings:view` |

roleKey → module → actions, read from `role_permissions` — the copy that is actually enforced, not the compiled-in matrix. `drift` lists every grant the two disagree on, in both directions. An empty `drift` array is the healthy state; anything in it is either a deliberate emergency revocation or a seed that has not been run.

**Response `200`** — The stored matrix and its drift from source.

```json
{
  "type": "success",
  "result": {
    "roles": [
      "string"
    ],
    "matrix": {},
    "drift": [
      {
        "roleKey": "string",
        "missing": [
          "string"
        ],
        "extra": [
          "string"
        ]
      }
    ]
  }
}
```

---

### `POST /v1/admin/roles/sync`

**Re-seed roles and grants from the source matrix**

| | |
|---|---|
| operationId | `adminSyncRolesFromMatrix` |
| Auth | Bearer staff token |
| Permission | `settings:manage-settings` |

Projects `lib/rbac-matrix.ts` onto `roles` and `role_permissions`. Idempotent, and it REVOKES grants the matrix no longer contains — without that step, narrowing a role in code would be a no-op in the database, which is the one kind of seed bug that fails open.

It therefore also **undoes any manual revocation**. Check `GET /v1/admin/permissions/matrix` first. Gated on `settings:manage-settings`, which only Super Admin and Finance Manager hold.

**Request body** — none. Send `{}` or omit.

**Response `200`** — What changed.

```json
{
  "type": "success",
  "result": {
    "rolesUpserted": 1,
    "permissionsGranted": 1,
    "permissionsRevoked": 1
  }
}
```

---
