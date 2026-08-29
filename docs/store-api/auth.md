# Auth

9 endpoints — 1 require a signed-in customer, 8 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`POST /v1/auth/signup`](#post-v1-auth-signup) — Create a customer account
- [`POST /v1/auth/login`](#post-v1-auth-login) — Sign in with email and password
- [`POST /v1/auth/firebase`](#post-v1-auth-firebase) — Exchange a Firebase ID token for a session
- [`POST /v1/auth/refresh`](#post-v1-auth-refresh) — Exchange the refresh cookie for a new access token
- [`POST /v1/auth/logout`](#post-v1-auth-logout) — Sign out of this device
- [`POST /v1/auth/logout-all`](#post-v1-auth-logout-all) — Sign out of every device
- [`POST /v1/auth/forgot-password`](#post-v1-auth-forgot-password) — Request a password-reset email
- [`POST /v1/auth/reset-password`](#post-v1-auth-reset-password) — Complete a password reset
- [`GET /v1/auth/me`](#get-v1-auth-me) 🔒 — Who am I

---

### `POST /v1/auth/signup`

**Create a customer account**

| | |
|---|---|
| operationId | `signup` |
| Auth | Public — no token needed |

Creates the account, signs it in and folds any guest cart into it in one call. `marketingOptIn` defaults to **false** and is never inferred — a granted consent is recorded with its timestamp and source, which is what makes it defensible under the DPDP Act. An email or mobile already in use returns 409 rather than failing silently. On success a rotating opaque refresh token is set as the httpOnly `ach_rt` cookie (`Path=/v1/auth`). Send credentialed requests (`fetch(..., { credentials: "include" })`) so it travels. It is never present in the response body. Rate-limited to 10 attempts per 15 minutes per IP. Failure responses are deliberately identical whether or not an account exists.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `fullName` | `string` | **yes** | min 2, max 120 | The customer’s name, as they want it on a parcel. |
| `email` | `email` | **yes** | max 255 | Email address. Stored CITEXT, so lookups and uniqueness are case-insensitive. |
| `mobile` | `string` | no | — | Optional at signup; required before an order can be delivered. |
| `password` | `string` | **yes** | min 10, max 256 | Plaintext password, 10–256 characters. Hashed with argon2id (m=19456, t=2, p=1) at rest. |
| `marketingOptIn` | `boolean` | no | default `false` | Opt in to marketing email/SMS. Defaults to **false** — consent is never pre-ticked (DPDP). Granting it writes a timestamped consent record. |
| `cartToken` | `string` | no | min 8, max 255 | The guest cart handle to fold into the account on success. May also be sent as the `X-Cart-Token` header, which wins when both are present. Merge failures never fail the login. |

Example request:

```json
{
  "fullName": "Brass Diya Set",
  "email": "priya@example.com",
  "mobile": "9820012345",
  "password": "a-strong-passphrase",
  "marketingOptIn": false,
  "cartToken": "ct_9f1c2a7e3b444d908a11"
}
```

**Response `201`** — Account created and signed in.

```json
{
  "type": "success",
  "result": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "tokenType": "Bearer",
    "expiresIn": 1,
    "customer": {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "fullName": "Brass Diya Set",
      "email": "priya@example.com",
      "mobile": "9820012345",
      "emailVerified": false,
      "mobileVerified": false,
      "marketingOptIn": false,
      "whatsappOptIn": false,
      "hasPassword": false,
      "createdAt": "2026-08-25T10:30:00.000Z"
    }
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `409` | That email address or mobile number already has an account. |

---

### `POST /v1/auth/login`

**Sign in with email and password**

| | |
|---|---|
| operationId | `login` |
| Auth | Public — no token needed |

The secondary login path — mobile + OTP is primary for Indian D2C, and this exists for corporate buyers and for accounts migrated from Supabase Auth. Those migrated accounts keep their original bcrypt password: it is verified as bcrypt and transparently re-hashed to argon2id on this login, so **no migrated customer is ever forced to reset**. Any failure — unknown address, wrong password, OTP-only account, blocked account — returns the same 401 with the same message, and costs the same amount of time. On success a rotating opaque refresh token is set as the httpOnly `ach_rt` cookie (`Path=/v1/auth`). Send credentialed requests (`fetch(..., { credentials: "include" })`) so it travels. It is never present in the response body. Rate-limited to 10 attempts per 15 minutes per IP. Failure responses are deliberately identical whether or not an account exists.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `emailOrMobile` | `email` | **yes** | max 255 | Email address or mobile number. |
| `password` | `string` | **yes** | min 1, max 256 | The plaintext password. Never logged — see `config/logger.ts` redaction. |
| `cartToken` | `string` | no | min 8, max 255 | The guest cart handle to fold into the account on success. May also be sent as the `X-Cart-Token` header, which wins when both are present. Merge failures never fail the login. |

Example request:

```json
{
  "emailOrMobile": "priya@example.com",
  "password": "a-strong-passphrase",
  "cartToken": "ct_9f1c2a7e3b444d908a11"
}
```

**Response `200`** — Signed in.

```json
{
  "type": "success",
  "result": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "tokenType": "Bearer",
    "expiresIn": 1,
    "customer": {
      "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
      "fullName": "Brass Diya Set",
      "email": "priya@example.com",
      "mobile": "9820012345",
      "emailVerified": false,
      "mobileVerified": false,
      "marketingOptIn": false,
      "whatsappOptIn": false,
      "hasPassword": false,
      "createdAt": "2026-08-25T10:30:00.000Z"
    }
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | Those credentials are not valid. The body never says which part was wrong. |

---

### `POST /v1/auth/firebase`

**Exchange a Firebase ID token for a session**

| | |
|---|---|
| operationId | `signInWithFirebase` |
| Auth | Public — no token needed |

**The primary login path.** Firebase sends the SMS and verifies the six-digit code in the browser; this endpoint verifies the ID token that results and exchanges it for an Achichiz session.

The server never sees the OTP. Its expiry, attempt counter and rate limits are Google's, which is the reason for moving off MSG91 — the whole class of bugs around hashing and throttling our own codes goes with them.

**Client flow**

```js
const conf = await signInWithPhoneNumber(auth, "+91" + mobile, recaptcha);
const cred = await conf.confirm(code);
const idToken = await cred.user.getIdToken();
await fetch("/v1/auth/firebase", {
  method: "POST", credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ idToken }),
});
```

**How the account is resolved**, in order: a known `firebase_uid` signs in; otherwise a matching mobile links Firebase to that existing account; otherwise a matching **verified** email links; otherwise a new account is created. An **unverified** email never matches — Firebase will mint a token carrying a self-asserted address, and linking on one would let anyone who types a known email inherit that customer's orders and addresses. It falls through to creating a new account instead, because a duplicate is an annoyance and a takeover is not.

Every outcome — including refusals — is recorded in `customer_auth_events`.

The returned `accessToken` is what every other endpoint accepts. A Firebase token is accepted here and nowhere else. On success a rotating opaque refresh token is set as the httpOnly `ach_rt` cookie (`Path=/v1/auth`). Send credentialed requests (`fetch(..., { credentials: "include" })`) so it travels. It is never present in the response body.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `idToken` | `string` | **yes** | min 100, max 4096 | The Firebase ID token, from `await userCredential.user.getIdToken()` after `signInWithPhoneNumber(...).confirm(code)` completes on the client. This is NOT the six-digit SMS code and never should be — the code is verified by Firebase, in the browser, and the server never sees it. Sending the raw code here would mean re-implementing the verification we moved to Firebase to be rid of. Single use: exchange it once for an Achichiz session, then send the returned `accessToken` to every other endpoint. Firebase tokens are not accepted anywhere else in this API. |
| `cartToken` | `string` | no | min 8, max 255 | The guest cart handle to fold into the account on success. May also be sent as the `X-Cart-Token` header, which wins when both are present. Merge failures never fail the login. |

Example request:

```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6IjE2NzQ…",
  "cartToken": "ct_9f1c2a7e3b444d908a11"
}
```

**Response `200`** — Signed in.

```json
{
  "type": "success",
  "result": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "tokenType": "Bearer",
    "expiresIn": 1,
    "customer": {
      "id": "7a3f5c91-1e22-4bb8-8d44-9e0a1b2c3d4e",
      "fullName": "Brass Diya Set",
      "email": "priya@example.com",
      "mobile": "9820012345",
      "emailVerified": false,
      "mobileVerified": false,
      "marketingOptIn": false,
      "whatsappOptIn": false,
      "hasPassword": false,
      "createdAt": "2026-08-25T10:30:00.000Z"
    },
    "isNewAccount": false,
    "linkedExistingAccount": false
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | The Firebase token is expired, revoked or malformed — one message for all three, the detail is in the stable `code`. Also returned for a suspended account. |
| `422` | The token is valid but unusable: no phone or email (`firebase_no_identifier`), a non-Indian number (`firebase_unusable_phone`), or the number already belongs to a different sign-in (`firebase_uid_conflict`). |

---

### `POST /v1/auth/refresh`

**Exchange the refresh cookie for a new access token**

| | |
|---|---|
| operationId | `refreshSession` |
| Auth | Public — no token needed |

Reads the `ach_rt` cookie, issues a new access token, and **rotates the refresh token** — the old one stops working the instant this returns. There is no request body; the token is not accepted anywhere a script could have put it.

**Reuse detection.** Presenting a refresh token that has already been exchanged means two parties hold that session, so the entire session family is revoked immediately — in the database and on the Redis access-token denylist — a security event is logged, and the customer must sign in again. A client that retries a refresh whose response it lost will trip this; that is the accepted cost of rotation being worth anything at all.

Call it on a timer slightly inside `expiresIn`, and once on a 401.

**Request body** — none. Send `{}` or omit.

**Response `200`** — A new access token, and a rotated refresh cookie.

```json
{
  "type": "success",
  "result": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "tokenType": "Bearer",
    "expiresIn": 1,
    "customer": {
      "id": "9f1c2a7e-3b44-4d90-8a11-1c2d3e4f5a6b",
      "fullName": "Brass Diya Set",
      "email": "priya@example.com",
      "mobile": "9820012345",
      "emailVerified": false,
      "mobileVerified": false,
      "marketingOptIn": false,
      "whatsappOptIn": false,
      "hasPassword": false,
      "createdAt": "2026-08-25T10:30:00.000Z"
    }
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | No cookie, an expired session, or a token that had already been spent. |

---

### `POST /v1/auth/logout`

**Sign out of this device**

| | |
|---|---|
| operationId | `logout` |
| Auth | Public — no token needed |

Revokes the session behind the `ach_rt` cookie and clears it. The outstanding access token is denylisted, so it stops working immediately rather than at its next expiry. Idempotent and always 204 — a missing or unknown cookie is not an error, and reporting one would tell a caller whether the token it holds is real.

**Request body** — none. Send `{}` or omit.

**Response `204`** — Signed out.

**Errors**

| Status | Meaning |
|---|---|
| `429` | Too many requests. |

---

### `POST /v1/auth/logout-all`

**Sign out of every device**

| | |
|---|---|
| operationId | `logoutEverywhere` |
| Auth | Public — no token needed |

Revokes every live session for the customer identified by the `ach_rt` cookie, denylists all of their access tokens, and clears this device’s cookie. Use it from the “sign out everywhere” control, and after any credential scare. Authenticated by the refresh cookie rather than a Bearer token, because the access token has usually expired by the time somebody reaches for this.

**Request body** — none. Send `{}` or omit.

**Response `204`** — Every session revoked.

**Errors**

| Status | Meaning |
|---|---|
| `429` | Too many requests. |

---

### `POST /v1/auth/forgot-password`

**Request a password-reset email**

| | |
|---|---|
| operationId | `requestPasswordReset` |
| Auth | Public — no token needed |

Always returns `{ "status": "sent" }`, for a known address and an unknown one alike. Anything else turns this endpoint into a free customer-list validator. 

When the address does have an account, a single-use token valid for 30 minutes is emailed. Only an argon2id hash of it is stored, so a database dump yields no usable reset links. Rate-limited to 10 attempts per 15 minutes per IP. Failure responses are deliberately identical whether or not an account exists.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `email` | `email` | **yes** | max 255 | Email address. Stored CITEXT, so lookups and uniqueness are case-insensitive. |

Example request:

```json
{
  "email": "priya@example.com"
}
```

**Response `202`** — An email has been sent, if that address has an account.

```json
{
  "type": "success",
  "result": {
    "status": "sent"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `429` | Too many requests from this IP. |

---

### `POST /v1/auth/reset-password`

**Complete a password reset**

| | |
|---|---|
| operationId | `resetPassword` |
| Auth | Public — no token needed |

Consumes the emailed token and sets the new password (argon2id). The token carries its own challenge id, so no email address is re-submitted here. 

**Every session is revoked**, on every device. If the reset was prompted by a leak, leaving the attacker’s refresh token alive would make the reset decorative. The customer signs in again afterwards. Completing a reset also marks the email address verified — the loop proves the mailbox.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `token` | `string` | **yes** | min 20, max 400 | The single-use token from the reset email, in `<challengeId>.<secret>` form. The secret half is argon2id-hashed at rest, so a database dump does not yield a usable reset link. |
| `password` | `string` | **yes** | min 10, max 256 | Plaintext password, 10–256 characters. Hashed with argon2id (m=19456, t=2, p=1) at rest. |

Example request:

```json
{
  "token": "ct_9f1c2a7e3b444d908a11",
  "password": "a-strong-passphrase"
}
```

**Response `200`** — The password has been changed. Sign in again.

```json
{
  "type": "success",
  "result": {
    "status": "ok"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `422` | The token is unknown, already used, or expired. |

---

### `GET /v1/auth/me`

**Who am I**

| | |
|---|---|
| operationId | `getCurrentCustomer` |
| Auth | **Bearer customer token required** |

The signed-in customer, resolved from the access token. Replaces the storefront’s `supabase.auth.getSession()` polling with a single authoritative read. 

The one endpoint in this module that requires a Bearer token — it has no other way to answer. A 401 here means "refresh, then retry", not "show the login page".

**Response `200`** — The signed-in customer.

```json
{
  "type": "success",
  "result": {
    "id": "2e8b1d45-77aa-4c3e-9f01-5b6c7d8e9f10",
    "fullName": "Brass Diya Set",
    "email": "priya@example.com",
    "mobile": "9820012345",
    "emailVerified": false,
    "mobileVerified": false,
    "marketingOptIn": false,
    "whatsappOptIn": false,
    "hasPassword": false,
    "createdAt": "2026-08-25T10:30:00.000Z"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `401` | Missing, expired or revoked access token. |

---
