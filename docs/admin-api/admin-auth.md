# Admin auth

13 endpoints. Every request needs `Authorization: Bearer <staffAccessToken>`.

> Read `README.md` first — it carries the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`POST /v1/admin/auth/login`](#post-v1-admin-auth-login) — Sign in to the admin console
- [`POST /v1/admin/auth/2fa/setup`](#post-v1-admin-auth-2fa-setup) — Begin authenticator enrolment
- [`POST /v1/admin/auth/2fa/enable`](#post-v1-admin-auth-2fa-enable) — Finish authenticator enrolment and sign in
- [`POST /v1/admin/auth/2fa/verify`](#post-v1-admin-auth-2fa-verify) — Complete sign-in with the second factor
- [`POST /v1/admin/auth/refresh`](#post-v1-admin-auth-refresh) — Exchange the refresh cookie for a new access token
- [`POST /v1/admin/auth/logout`](#post-v1-admin-auth-logout) — Sign out of this session
- [`POST /v1/admin/auth/password/forgot`](#post-v1-admin-auth-password-forgot) — Request a password-reset token
- [`POST /v1/admin/auth/password/reset`](#post-v1-admin-auth-password-reset) — Set a new password with a reset token
- [`POST /v1/admin/auth/step-up`](#post-v1-admin-auth-step-up) — Re-enter your password to unlock money movement
- [`POST /v1/admin/auth/2fa/recovery-codes`](#post-v1-admin-auth-2fa-recovery-codes) — Reissue the ten recovery codes
- [`GET /v1/admin/me`](#get-v1-admin-me) — The signed-in staff member
- [`GET /v1/admin/sessions`](#get-v1-admin-sessions) — My active sessions
- [`DELETE /v1/admin/sessions/:sessionId`](#delete-v1-admin-sessions-sessionid) — Revoke one of my sessions

---

### `POST /v1/admin/auth/login`

**Sign in to the admin console**

| | |
|---|---|
| operationId | `adminLogin` |
| Auth | public |
| Permission | — (any signed-in staff) |

Backs `/login`. A correct password does NOT necessarily produce a session — read `status`:

- `authenticated` — a read-only role, or 2FA already satisfied. `tokens` is populated and the refresh cookie is set.
- `mfa_required` — an authenticator is enrolled. Route to `/two-factor` and post the `challengeToken` with the six-digit code.
- `enrolment_required` — **the role can change data and has no second factor.** No session is issued at all. Route to `/two-factor` in enrolment mode: `POST /2fa/setup` for the QR, then `POST /2fa/enable`.

An unknown email, a wrong password and an account with no password set are one identical 401 that costs the same wall-clock time, because response latency is otherwise an account-enumeration oracle. Five failures lock the account for fifteen minutes.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `email` | `email` | **yes** | max 254 | Work email. Matching is case-insensitive — the column is CITEXT. |
| `password` | `string` | **yes** | min 1, max 200 | The account password. Never logged, never audited. |
| `deviceLabel` | `string` | no | max 80 | Human label for this device, e.g. `MacBook Pro · Chrome`. Shown on the sessions screen. |

Example request:

```json
{
  "email": "ops@achichiz.in",
  "password": "a-strong-passphrase",
  "deviceLabel": "string"
}
```

**Response `200`** — Signed in, or told which second-factor step comes next.

```json
{
  "type": "success",
  "result": {
    "status": "authenticated",
    "challengeToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
      "expiresInSeconds": 1,
      "sessionId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
    }
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | Bad credentials, or the account is temporarily locked. |
| `403` | The credentials were right but the account is suspended or still invited. |

---

### `POST /v1/admin/auth/2fa/setup`

**Begin authenticator enrolment**

| | |
|---|---|
| operationId | `adminStartTwoFactorSetup` |
| Auth | public |
| Permission | — (any signed-in staff) |

Returns a fresh base32 secret and its `otpauth://` URI for the QR code. The secret is stored against the account immediately but `mfaEnabled` stays false, so a half-finished enrolment cannot be used to sign in — only `POST /2fa/enable`, which requires a code generated from this secret, completes it. Calling this again replaces the pending secret.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `challengeToken` | `string` | **yes** | min 10 | The enrolment `challengeToken` from login. |

Example request:

```json
{
  "challengeToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
}
```

**Response `200`** — The secret and QR payload. Shown once.

```json
{
  "type": "success",
  "result": {
    "secret": "string",
    "otpauthUri": "string"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | The challenge token is missing, expired or malformed. |
| `422` | This account already has an authenticator. |

---

### `POST /v1/admin/auth/2fa/enable`

**Finish authenticator enrolment and sign in**

| | |
|---|---|
| operationId | `adminEnableTwoFactor` |
| Auth | public |
| Permission | — (any signed-in staff) |

Verifies a code against the pending secret, flips `mfaEnabled`, issues ten single-use recovery codes and completes the sign-in in one call. **The recovery codes are returned exactly once** — only their sha256 digests are stored, so there is no endpoint that can show them again.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `challengeToken` | `string` | **yes** | min 10 | The enrolment `challengeToken` from login. Required — enrolment is part of signing in. |
| `code` | `string` | **yes** | — | A code from the app, proving the secret was stored correctly. |
| `deviceLabel` | `string` | no | max 80 | Human label for this device. |

Example request:

```json
{
  "challengeToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "code": "DIWALI20",
  "deviceLabel": "string"
}
```

**Response `201`** — Enrolled and signed in. Store the recovery codes now.

```json
{
  "type": "success",
  "result": {
    "recoveryCodes": [
      "DIWALI20"
    ],
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
      "expiresInSeconds": 1,
      "sessionId": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e"
    }
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | The challenge token or the code is not valid. |
| `422` | No pending secret — call `/2fa/setup` first. |

---

### `POST /v1/admin/auth/2fa/verify`

**Complete sign-in with the second factor**

| | |
|---|---|
| operationId | `adminVerifyTwoFactor` |
| Auth | public |
| Permission | — (any signed-in staff) |

Backs `/two-factor`. Send exactly one of `code` (six digits from the app) or `recoveryCode` (single-use; the digest is deleted whether or not anything later fails). A wrong value counts towards the same five-attempt lockout as a wrong password.

`trustDevice` is accepted so the console’s checkbox has somewhere to go, but it does not mint a 2FA bypass cookie — skipping the second factor for thirty days on a device is precisely the exposure the second factor exists to remove.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `challengeToken` | `string` | **yes** | min 10 | The `challengeToken` returned by `POST /v1/admin/auth/login`. Valid for five minutes. |
| `code` | `string` | no | — | The six-digit code from the authenticator app. |
| `recoveryCode` | `string` | no | min 6, max 24 | A one-time recovery code, if the authenticator is unavailable. Consumed on use. |
| `trustDevice` | `boolean` | no | default `false` | Accepted for the console’s “trust this device” checkbox. It currently only lengthens the device label — no 2FA bypass cookie is minted, because a bypass is exactly the thing the second factor exists to prevent. |
| `deviceLabel` | `string` | no | max 80 | Human label for this device. |

Example request:

```json
{
  "challengeToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "code": "DIWALI20",
  "recoveryCode": "DIWALI20",
  "trustDevice": false,
  "deviceLabel": "string"
}
```

**Response `200`** — Signed in.

```json
{
  "type": "success",
  "result": {
    "status": "authenticated",
    "challengeToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
      "expiresInSeconds": 1,
      "sessionId": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
    }
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | The challenge token, code or recovery code is not valid. |
| `422` | This account has no authenticator — enrol instead. |

---

### `POST /v1/admin/auth/refresh`

**Exchange the refresh cookie for a new access token**

| | |
|---|---|
| operationId | `adminRefreshSession` |
| Auth | public |
| Permission | — (any signed-in staff) |

Reads the httpOnly `ach_art` cookie — nothing in the body. Rotates the stored hash, so the presented token is dead the moment this returns, and re-reads the role’s grants from `role_permissions`, which is what makes a revoked permission take effect within one ten-minute access-token lifetime instead of at the next sign-in. A token that matches no live row is a flat 401; the console should route to `/session-expired`.

**Request body** — none. Send `{}` or omit.

**Response `200`** — A new access token, and a rotated refresh cookie.

```json
{
  "type": "success",
  "result": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "expiresInSeconds": 1,
    "sessionId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | No cookie, or it is expired, revoked or unknown. |

---

### `POST /v1/admin/auth/logout`

**Sign out of this session**

| | |
|---|---|
| operationId | `adminLogout` |
| Auth | public |
| Permission | — (any signed-in staff) |

Revokes the session row, adds it to the Redis denylist so the outstanding access token stops working immediately rather than at expiry, clears any step-up window and clears the cookie. Deliberately 204 whether or not a session was found — sign-out must never fail.

**Request body** — none. Send `{}` or omit.

**Response `204`** — Signed out.

---

### `POST /v1/admin/auth/password/forgot`

**Request a password-reset token**

| | |
|---|---|
| operationId | `adminForgotPassword` |
| Auth | public |
| Permission | — (any signed-in staff) |

Always 200 with the same body, whether or not the address belongs to an account — otherwise this endpoint is a staff-directory oracle. The token is 256 random bits, valid for thirty minutes, single-use, and only its argon2id hash is stored (in `otp_challenges`, reusing that table’s expiry and attempt semantics rather than inventing new ones).

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `email` | `email` | **yes** | max 254 | Work email. Matching is case-insensitive — the column is CITEXT. |

Example request:

```json
{
  "email": "ops@achichiz.in"
}
```

**Response `200`** — Accepted. Says nothing about whether the account exists.

```json
{
  "type": "success",
  "result": {
    "ok": true
  }
}
```

---

### `POST /v1/admin/auth/password/reset`

**Set a new password with a reset token**

| | |
|---|---|
| operationId | `adminResetPassword` |
| Auth | public |
| Permission | — (any signed-in staff) |

Backs `/reset-password`, which today does not read a token from the URL at all — it must, and this endpoint requires it alongside the email. On success the token is consumed, an `invited` account becomes `active`, the lockout counter is cleared, and **every other session is revoked**: a reset is what you do when you think someone else has your credentials.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `email` | `email` | **yes** | max 254 | Work email. Matching is case-insensitive — the column is CITEXT. |
| `token` | `string` | **yes** | min 20, max 200 | The single-use token from the reset email. Only its argon2id hash is stored. |
| `newPassword` | `string` | **yes** | min 12, max 200 | At least 12 characters with upper case, lower case and a digit. |

Example request:

```json
{
  "email": "ops@achichiz.in",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "newPassword": "a-strong-passphrase"
}
```

**Response `200`** — The password was changed. Sign in again.

```json
{
  "type": "success",
  "result": {
    "ok": true
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `422` | The token is unknown, expired, already used or tried too many times. |

---

### `POST /v1/admin/auth/step-up`

**Re-enter your password to unlock money movement**

| | |
|---|---|
| operationId | `adminStepUpReauth` |
| Auth | Bearer staff token |
| Permission | — (any signed-in staff) |

Opens a five-minute window on the CURRENT session. `POST /v1/admin/orders/{orderId}/refund` requires it: ten minutes of access-token life is a long time for an unattended laptop and a refund is irreversible. The window lives in Redis, not in a token claim, so signing out or revoking the session ends it instantly. `GET /v1/admin/me` reports `stepUpActive`.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `password` | `string` | **yes** | min 1, max 200 | The current account password, re-entered. |

Example request:

```json
{
  "password": "a-strong-passphrase"
}
```

**Response `200`** — Step-up granted.

```json
{
  "type": "success",
  "result": {
    "expiresInSeconds": 1
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | The password was wrong. This counts towards the lockout. |

---

### `POST /v1/admin/auth/2fa/recovery-codes`

**Reissue the ten recovery codes**

| | |
|---|---|
| operationId | `adminRegenerateRecoveryCodes` |
| Auth | Bearer staff token |
| Permission | — (any signed-in staff) |

Discards every unused code and returns ten new ones, shown once. Requires a live step-up (`POST /v1/admin/auth/step-up`) — without that, anyone who found an open console could mint themselves a permanent second-factor bypass.

**Request body** — none. Send `{}` or omit.

**Response `201`** — Ten new codes. Store them now.

```json
{
  "type": "success",
  "result": {
    "recoveryCodes": [
      "DIWALI20"
    ]
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `403` | No recent step-up. |
| `422` | This account has no authenticator enrolled. |

---

### `GET /v1/admin/me`

**The signed-in staff member**

| | |
|---|---|
| operationId | `getAdminMe` |
| Auth | Bearer staff token |
| Permission | `dashboard:view` |

Everything the console shell needs on boot: identity, role, the flat `module:action` grant list, the modules to render in the nav, warehouse scope (an EMPTY array means every warehouse), whether 2FA is enrolled and whether this role is required to have it. The grant list is for optimistic UI only — the server re-checks every call, so hiding a button is a convenience, not a control.

**Response `200`** — The current staff member.

```json
{
  "type": "success",
  "result": {
    "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
    "email": "ops@achichiz.in",
    "fullName": "Brass Diya Set",
    "avatarInitials": "string",
    "role": {
      "key": "inventory",
      "name": "Brass Diya Set"
    },
    "permissions": [
      "string"
    ],
    "modules": [
      "dashboard"
    ],
    "actions": [
      "view"
    ],
    "warehouseIds": [
      "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b"
    ],
    "mfaEnabled": false,
    "mfaRequired": false,
    "stepUpActive": false,
    "sessionId": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "lastActiveAt": "2026-08-25T10:30:00.000Z"
  }
}
```

---

### `GET /v1/admin/sessions`

**My active sessions**

| | |
|---|---|
| operationId | `listMyStaffSessions` |
| Auth | Bearer staff token |
| Permission | `dashboard:view` |

Backs the sessions table on `/profile`. Only your own sessions — signing another staff member out is a `settings` action, not self-service.

**Response `200`** — Live sessions, most recently used first.

```json
{
  "type": "success",
  "result": [
    {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "deviceLabel": "string",
      "userAgent": "string",
      "ip": "string",
      "locationLabel": "string",
      "issuedAt": "2026-08-25T10:30:00.000Z",
      "lastActiveAt": "2026-08-25T10:30:00.000Z",
      "expiresAt": "2026-08-25T10:30:00.000Z",
      "isCurrent": false
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

### `DELETE /v1/admin/sessions/:sessionId`

**Revoke one of my sessions**

| | |
|---|---|
| operationId | `revokeMyStaffSession` |
| Auth | Bearer staff token |
| Permission | `dashboard:view` |

Revokes the row and denylists the session id, so the access token issued from it stops working on the next request rather than at expiry. A session id belonging to someone else returns 404, not 403 — confirming it exists is itself a leak.

**Path parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `sessionId` | `uuid` | **yes** | — | Session id from `GET /v1/admin/sessions`. |

**Request body** — none. Send `{}` or omit.

**Response `204`** — Revoked.

**Errors**

| Status | Meaning |
|---|---|
| `404` | No such session, or it is not yours. |

---
