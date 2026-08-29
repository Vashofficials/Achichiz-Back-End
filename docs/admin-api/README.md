# Achichiz Admin API — Implementation Guide

Everything a client needs to build the Achichiz admin console against this API.
**212 endpoints across 23 modules.**

These documents are generated from the server's own route registry, so every field
name, type, default and constraint below is the one the server actually validates
against. Where a document and the running API disagree, the API is right and the
document is stale — regenerate it.

> **Using this as an AI prompt (Lovable, v0, Cursor):** give the model this README
> **plus the one module file** you are building a screen for. Do not paste all 23 at
> once — the README carries every convention the module files assume, and the module
> file carries the exact JSON. Together they are enough to build a working screen.

---

## 1. Base URL

| Environment | URL |
|---|---|
| Production | `https://api.achichiz.com` |
| Local | `http://localhost:4000` |

Every path in these documents already includes the `/v1` prefix. Interactive
documentation lives at `/docs/admin`.

Paths are written Express-style with a leading colon — `/v1/admin/boms/:bomId`.
Substitute the value directly: `/v1/admin/boms/9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b`.

---

## 2. Authentication

Admin sign-in is **two-factor and mandatory**. A staff member who has never enrolled
an authenticator cannot obtain a token — there is no way to skip it, and a client
that does not implement the enrolment branch will lock out every new user.

### 2.1 The three outcomes of `POST /v1/admin/auth/login`

The response is always `200`. What differs is `result.status`:

```json
{
  "type": "success",
  "result": {
    "status": "authenticated | mfa_required | enrolment_required",
    "challengeToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "tokens": null
  }
}
```

| `status` | Meaning | What the client does next |
|---|---|---|
| `authenticated` | Tokens are in `result.tokens`. | Store the access token, go to the dashboard. |
| `mfa_required` | Enrolled already; needs a code. | Route to a code screen → `POST /v1/admin/auth/2fa/verify`. |
| `enrolment_required` | Never enrolled. | Route to a QR screen → `2fa/setup` then `2fa/enable`. |

`challengeToken` is short-lived (five minutes) and is **not** an access token. It is
only accepted by the three `2fa/*` endpoints.

### 2.2 First-time enrolment

```
POST /v1/admin/auth/login          → { status: "enrolment_required", challengeToken }
POST /v1/admin/auth/2fa/setup      { challengeToken }
                                   → { secret, otpauthUri }      ← render otpauthUri as a QR
POST /v1/admin/auth/2fa/enable     { challengeToken, code, deviceLabel? }
                                   → { recoveryCodes[], tokens }  ← 201
```

`secret` and `recoveryCodes` are shown **once**. The server stores only hashes, so a
client that does not display them at this moment has destroyed them. Force the user
to confirm they have saved the recovery codes before navigating away.

### 2.3 Returning sign-in

```
POST /v1/admin/auth/login          → { status: "mfa_required", challengeToken }
POST /v1/admin/auth/2fa/verify     { challengeToken, code }   ← 6-digit TOTP or a recovery code
                                   → { tokens }
```

### 2.4 The token pair

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "expiresInSeconds": 600,
  "sessionId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
}
```

Send it on every request:

```http
Authorization: Bearer <accessToken>
```

**Keep the access token in memory only.** Never `localStorage` — a token JavaScript
can read is a token an XSS can steal.

The **refresh token is never in the response body.** It is set as an httpOnly cookie
(`ach_art`, `Path=/v1/admin/auth` — deliberately distinct from the storefront's
`ach_rt`), which is the whole point: JavaScript cannot read it. The path scope means
the cookie is *not* attached to the other ~200 admin requests, so only the auth
endpoints need `credentials: 'include'`:

```js
fetch(url, { credentials: 'include' })
```

### 2.5 Refreshing

The access token lasts ten minutes. Call `POST /v1/admin/auth/refresh` on a timer
slightly inside that, and once on any `401`. It takes **no request body** — the
cookie is the credential.

**Refresh tokens rotate.** The old one stops working the instant the new one is
issued. If a token that was already spent is presented, the server treats it as two
parties holding one session and revokes the **entire session family** immediately.
A client that retries a refresh whose response it lost will trigger this and be
signed out. Do not retry refresh — treat a failed refresh as "sign in again".

### 2.6 Step-up for money movement

Refunds and other money-moving operations require a recent password re-entry via
`POST /v1/admin/auth/step-up`.

The refusal is a `403` whose `result.code` is `forbidden`. The specific reason is
carried in the server's error context, so the reliable signal for a client is the
**`403` on a refund endpoint**, plus `stepUpActive: false` from `GET /v1/admin/me`:

```json
{
  "type": "error",
  "result": {
    "title": "Forbidden",
    "status": 403,
    "code": "forbidden",
    "detail": "Re-enter your password before doing this. POST /v1/admin/auth/step-up, then retry.",
    "instance": "/v1/admin/orders/9f1c…/refund",
    "requestId": "01JK8QP2XM9TZ4W7B3C5D6E7F8"
  }
}
```

On seeing it: prompt for the password, `POST /v1/admin/auth/step-up`, then **retry
the original request**. The window is five minutes and lives in Redis, not in a token
claim — so signing out ends it instantly. `GET /v1/admin/me` reports `stepUpActive`,
which lets a refund button show its lock state before the click.

---

## 3. Response envelope

**Every successful response is wrapped.** There are no bare arrays or bare objects.

Single resource:

```json
{
  "type": "success",
  "result": {
    "id": "…",
    "title": "…"
  }
}
```

Collection — always carries `meta`:

```json
{
  "type": "success",
  "result": [
    {
      "id": "…"
    },
    {
      "id": "…"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 25,
    "total": 137,
    "totalPages": 6
  }
}
```

`204 No Content` responses have no body at all.

The payload is under **`result`**, never `data`. Unwrap once, centrally, in your API
layer — `return json.result`. For a list, `meta` is a **sibling of `result`**, not
nested inside it.

---

## 4. Errors

Errors use the **same two-key envelope** as success, with `type: "error"`. The
content type is `application/json` — despite the RFC 9457 *field names* inside
`result`, this is not `application/problem+json`.

```json
{
  "type": "error",
  "result": {
    "title": "Unprocessable",
    "status": 422,
    "code": "insufficient_stock",
    "detail": "Not enough ACH-CAN-001 to complete this run — 105 needed, 40 sellable.",
    "instance": "/v1/admin/production/orders/9f1c…/complete",
    "requestId": "01M0WFES78H68XBHTVM09XZY8G"
  }
}
```

Everything you need is **one level down, inside `result`** — `result.code`,
`result.detail`, `result.requestId`. A client reading `err.code` at the top level
gets `"error"` every time, for every failure.

**Branch on `result.code`, not on `result.detail`.** `code` is a stable identifier;
`detail` is human prose that will be reworded. Surface `requestId` in any error
toast — it is the only thing support can trace.

Validation failures add a field list under **`errors`** (not `issues`):

```json
{
  "type": "error",
  "result": {
    "title": "Validation failed",
    "status": 422,
    "code": "validation_failed",
    "detail": "2 fields are invalid.",
    "instance": "/v1/admin/production/orders",
    "requestId": "01JK8QP2XM9TZ4W7B3C5D6E7F8",
    "errors": [
      { "path": "lines.0.quantity", "code": "invalid_type", "message": "Expected number, received string" },
      { "path": "warehouseId", "code": "invalid_string", "message": "Invalid uuid" }
    ]
  }
}
```

`path` is dot-notated and indexes arrays, so it maps directly onto a form field.

### Status codes you will actually see

| Status | Meaning | Client action |
|---|---|---|
| `400` | Malformed request. | Bug — fix the call. |
| `401` | Missing, expired or revoked token. | Refresh once, then sign in. |
| `403` | Authenticated but not permitted, **or** step-up needed. | Check `code`. |
| `404` | No such record. | Show an empty state. |
| `409` | Conflict — the thing already exists. | Show the conflict; do not retry. |
| `422` | Valid shape, refused by a business rule. | Show `detail` against the form. |
| `429` | Rate limited. | Back off; read the `RateLimit` header. |
| `500` | Server fault. | Show `requestId`; do not retry automatically. |

**`422` is the interesting one.** It means the request was well-formed and the server
refused on a rule — insufficient stock, an illegal state transition, a window that
closed. The `detail` is written to be shown to the operator verbatim.

---

## 5. Pagination, sorting, search

Every list endpoint accepts the same three:

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `page` | integer | `1` | 1-indexed. |
| `perPage` | integer | `25` | **Maximum 100.** Larger values are rejected, not clamped. |
| `sort` | string | per endpoint | Field name; prefix `-` for descending, e.g. `-createdAt`. |
| `q` | string | — | Free-text search where the endpoint supports it. |

Sort fields are allow-listed per endpoint — an unknown field falls back to the
default rather than erroring. Each module document lists the accepted fields.

---

## 6. Idempotency

Endpoints marked **Idempotency** in their table require a header:

```http
Idempotency-Key: <any unique string, e.g. a uuid v4>
```

These are the operations that move stock or money. Replaying the same key returns
the **stored original response** with an `Idempotent-Replay: true` header rather than
performing the action twice.

Generate the key **once, when the user clicks** — not per attempt. Regenerating it on
retry defeats the entire mechanism and will double-consume inventory.

---

## 7. Permissions

Every endpoint declares a permission as `module:action`. The signed-in user's grants
come back from `GET /v1/admin/me`:

```json
{
  "type": "success",
  "result": {
    "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
    "email": "ops@achichiz.in",
    "fullName": "Priya Nair",
    "avatarInitials": "PN",
    "role": {
      "key": "operations_manager",
      "name": "Operations Manager"
    },
    "permissions": [
      "inventory:view",
      "inventory:edit",
      "orders:view"
    ],
    "modules": [
      "inventory",
      "orders"
    ],
    "actions": [
      "view",
      "create",
      "edit",
      "delete",
      "export",
      "approve",
      "refund",
      "cancel",
      "manage-settings"
    ],
    "warehouseIds": [
      "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
    ],
    "mfaEnabled": true,
    "mfaRequired": true,
    "stepUpActive": false,
    "sessionId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "lastActiveAt": "2026-08-25T10:30:00.000Z"
  }
}
```

Three fields do real work in a console:

- **`modules`** — the distinct modules the user has *any* grant in. Build the sidebar
  from this rather than deriving it from `permissions` yourself.
- **`warehouseIds`** — a warehouse scope. When non-empty, this user only sees stock
  at those sites; default warehouse pickers to them.
- **`stepUpActive`** — whether the password re-entry window is currently open, so a
  refund button can show its lock state before the user clicks it.

**Modules:** `dashboard`, `orders`, `catalogue`, `inventory`, `customers`,
`corporate`, `delivery`, `promotions`, `content`, `reports`, `settings`, `finance`

**Actions:** `view`, `create`, `edit`, `delete`, `export`, `approve`, `refund`,
`cancel`, `manage-settings`

Use `permissions` to hide controls the user cannot use — but the server enforces it
regardless, so a hidden button is a courtesy, not a security boundary. A missing
grant is a `403`.

---

## 8. Money and quantities

- **All money is an integer in paise.** `149900` is ₹1,499.00. There are no floats
  anywhere in this API. Divide by 100 only at the moment of display.
- **Percentages are basis points.** `1000` is 10%. `bp` in a field name means this.
- **Quantities are whole units** for stock (`on_hand_qty` is an INTEGER), and
  `NUMERIC(12,3)` for BOM measures where grams and millilitres matter.

Field names ending `Paise` and `Bp` are the reliable signal.

---

## 9. Module index

| Module | Endpoints | Methods |
|---|---|---|
| [Admin / Media](./admin-media.md) | 1 | POST |
| [Admin auth](./admin-auth.md) | 13 | DELETE, GET, POST |
| [Admin barcodes](./admin-barcodes.md) | 5 | GET, POST |
| [Admin BOM](./admin-bom.md) | 6 | GET, PATCH, POST |
| [Admin bulk orders](./admin-bulk-orders.md) | 9 | GET, PATCH, POST |
| [Admin bundles](./admin-bundles.md) | 6 | GET, PATCH, POST |
| [Admin catalogue](./admin-catalogue.md) | 28 | DELETE, GET, PATCH, POST |
| [Admin content](./admin-content.md) | 21 | DELETE, GET, PATCH, POST |
| [Admin customers](./admin-customers.md) | 7 | DELETE, GET, PATCH, POST |
| [Admin goods receipts](./admin-goods-receipts.md) | 3 | GET, POST |
| [Admin inventory](./admin-inventory.md) | 32 | DELETE, GET, PATCH, POST |
| [Admin orders](./admin-orders.md) | 10 | GET, PATCH, POST |
| [Admin production](./admin-production.md) | 6 | GET, POST |
| [Admin promotions](./admin-promotions.md) | 14 | DELETE, GET, PATCH, POST |
| [Admin purchase returns](./admin-purchase-returns.md) | 5 | GET, POST |
| [Admin purchasing](./admin-purchasing.md) | 7 | GET, PATCH, POST |
| [Admin reports](./admin-reports.md) | 10 | GET |
| [Admin resources](./admin-resources.md) | 1 | GET |
| [Admin stock counts](./admin-stock-counts.md) | 7 | GET, POST |
| [Admin suppliers](./admin-suppliers.md) | 3 | GET, PATCH, POST |
| [Admin transfers](./admin-transfers.md) | 7 | GET, POST |
| [Admin warehousing](./admin-warehousing.md) | 6 | GET, PATCH, POST |
| [RBAC](./rbac.md) | 5 | GET, POST |

---

## 10. The generic resource pattern

Fifteen of these modules are CRUD over a registry, and they all expose the same six
routes. Learn them once:

```
GET    /v1/admin/{resource}              list, paginated
POST   /v1/admin/{resource}              create
GET    /v1/admin/{resource}/schema       field spec — see below
POST   /v1/admin/{resource}/bulk         act on many ids at once
GET    /v1/admin/{resource}/{id}         read one
PATCH  /v1/admin/{resource}/{id}         partial update
DELETE /v1/admin/{resource}/{id}         ARCHIVE, not a hard delete
```

Two things worth knowing:

**`DELETE` archives.** It sets `deleted_at`; the row stays and stops appearing in
lists. Nothing in this API hard-deletes a business record.

**`/schema` is machine-readable and worth using.** It returns the field list with
types, labels, validation and which columns belong on the list view — enough to
render a form and a table generically instead of hand-writing fifteen near-identical
screens.

Resources following this pattern: `products`, `product-variants`, `collections`,
`designers`, `banners`, `faqs`, `testimonials`, `customers`, `suppliers`,
`warehouses`, `coupons`, `gift-cards`.

---

## 11. A worked example

Raising a production order and completing it — the shape most of this API follows.

```js
const api = async (path, { method = 'GET', body, idempotencyKey } = {}) => {
  const res = await fetch(`https://api.achichiz.com${path}`, {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const json = await res.json();          // { type, result }  — always these two keys

  if (!res.ok) {
    const p = json.result ?? {};          // EVERYTHING is one level down
    throw Object.assign(new Error(p.detail ?? 'Request failed'), {
      code: p.code,                       // branch on this, not on p.detail
      errors: p.errors,                   // field list — `errors`, NOT `issues`
      requestId: p.requestId,             // show in the toast
      status: res.status,
    });
  }
  return json.result;                     // unwrap the envelope once, here
};

// 1. Can we build it? Reads only — reserves nothing.
const explosion = await api(
  `/v1/admin/boms/${variantId}/explosion?quantity=40&warehouseId=${warehouseId}`,
);
if (!explosion.canBuild) {
  // explosion.leaves[].shortageQty tells you exactly what is short
}

// 2. Raise the order. Components are sized from the BOM now and frozen.
const order = await api('/v1/admin/production/orders', {
  method: 'POST',
  body: { warehouseId, outputVariantId: variantId, plannedQty: 40, batchNo: 'B-2026-11' },
});

// 3. Start it. Consumes nothing yet.
await api(`/v1/admin/production/orders/${order.id}/start`, { method: 'POST', body: {} });

// 4. Complete it. ONE transaction — all components consumed and finished stock
//    created together, or nothing at all. The key is generated once, on click.
const key = crypto.randomUUID();
await api(`/v1/admin/production/orders/${order.id}/complete`, {
  method: 'POST',
  idempotencyKey: key,
  body: { producedQty: 38, scrappedQty: 2 },
});
```

If step 4 fails with `422 insufficient_stock`, **nothing was consumed** — the whole
transaction rolled back. Show `detail`, let the operator fix the stock, and retry
with the *same* idempotency key.

---

*Generated from the route registry. Regenerate after any route change so these
documents cannot drift from the running API.*
