# Prompt — Implement Achichiz admin authentication

**Paste this whole file into Lovable.** It is a build spec for the admin console's
sign-in, session and permission layer. Everything here was read out of the running
API, not inferred.

Build **only** what is described. Do not invent endpoints, do not add a "remember me"
that skips 2FA, do not store tokens anywhere this file does not say to.

- **Base URL:** `https://api.achichiz.com` · local `http://localhost:4000`
- **Interactive spec:** `/docs/admin`

---

## 0. The two rules that break every first attempt

### There is no `data` key. Anywhere.

Every response — success **and** error — has exactly two top-level keys:

```jsonc
{ "type": "success", "result": { … } }                          // single
{ "type": "success", "result": [ … ], "meta": { … } }           // list — meta is a SIBLING
{ "type": "error",   "result": { title, status, code, detail, instance, requestId } }
```

`json.data` is `undefined` on every call in this API. Unwrap **`json.result`**.

### `err.code` at the top level is always the string `"error"`

The real code is **`err.result.code`**. Everything about a failure — `code`,
`detail`, `requestId`, and the `errors[]` field list — lives one level down inside
`result`. Content type is `application/json`, not `application/problem+json`.

---

## 1. The HTTP layer — build this first

```ts
const BASE = 'https://api.achichiz.com';

let accessToken: string | null = null;   // MEMORY ONLY. Never localStorage.
let refreshing: Promise<void> | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly errors?: { path: string; code: string; message: string }[],
  ) { super(message); }
}

async function refresh(): Promise<void> {
  // ONE in-flight refresh, ever. Concurrent 401s queue behind it.
  refreshing ??= fetch(`${BASE}/v1/admin/auth/refresh`, {
    method: 'POST',
    credentials: 'include',              // the httpOnly ach_art cookie IS the credential
  })
    .then(async (r) => {
      if (!r.ok) { accessToken = null; throw new Error('session_expired'); }
      accessToken = (await r.json()).result.accessToken;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; idempotencyKey?: string; retry?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, idempotencyKey, retry = true } = opts;

  const res = await fetch(`${BASE}${path}`, {
    method,
    // Only /v1/admin/auth/* actually needs the cookie (it is Path-scoped), but
    // sending it everywhere is harmless and keeps this function simple.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401 && retry && accessToken !== null) {
    await refresh();                     // once. Never in a loop — see §5.
    return api<T>(path, { ...opts, retry: false });
  }

  if (res.status === 204) return undefined as T;

  const json = await res.json();         // { type, result }
  const p = json.result ?? {};

  if (!res.ok) {
    throw new ApiError(
      p.detail ?? 'Request failed',
      res.status,
      p.code ?? 'unknown',               // NOT json.code — that is always "error"
      p.requestId,
      p.errors,                          // field list is `errors`, NOT `issues`
    );
  }

  return json.result as T;               // unwrap once, here, and nowhere else
}
```

**Rate limiting.** Login is capped at **10 attempts per 15 minutes per IP**. A `429`
carries `retry-after` in seconds and a `ratelimit` header. Show the wait — do not
retry automatically, and do not let a form resubmit on Enter fire repeats.

---

## 2. Sign-in has THREE outcomes, not two

`POST /v1/admin/auth/login` **always returns `200`.** A correct password does not
necessarily produce a session.

```jsonc
// request
{ "email": "user@achichiz.in", "password": "…", "deviceLabel": "Chrome · Windows" }

// response — always 200
{
  "type": "success",
  "result": {
    "status": "authenticated" | "mfa_required" | "enrolment_required",
    "challengeToken": "eyJ…",     // present for the two non-authenticated statuses
    "tokens": null                 // populated ONLY when status === "authenticated"
  }
}
```

| `result.status` | Meaning | Route to |
|---|---|---|
| `authenticated` | Read-only role, or 2FA already satisfied. `result.tokens` is populated. | Dashboard |
| `mfa_required` | Authenticator enrolled. Needs a code. | `/two-factor` — **verify** mode |
| `enrolment_required` | Role can change data and has no second factor. **No session issued.** | `/two-factor` — **enrolment** mode |

**A console that only handles `authenticated` will appear completely broken for every
new staff member** — they get a 200, no tokens, and nothing happens.

`challengeToken` is valid ~5 minutes and is **not** an access token. Only the three
`2fa/*` endpoints accept it. Hold it in component state, never persist it.

### Failures

`401` for an unknown email, a wrong password, and an account with no password —
one identical response, deliberately taking the same wall-clock time, because
latency is otherwise an account-enumeration oracle. **Never** show "no such user".

**Five failures lock the account for 15 minutes**, separately from the IP rate limit.

`403` means the credentials were right but the account is suspended or still invited.

---

## 3. Enrolment — `/two-factor` in enrolment mode

```
POST /v1/admin/auth/2fa/setup     { challengeToken }
  → { secret, otpauthUri }

POST /v1/admin/auth/2fa/enable    { challengeToken, code, deviceLabel? }
  → 201 { recoveryCodes: string[], tokens: { accessToken, expiresInSeconds, sessionId } }
```

**Screen requirements:**

1. Render `otpauthUri` as a QR code. Show `secret` as selectable text for manual entry.
2. Six-digit input → `2fa/enable`.
3. On `201`, display the **ten recovery codes** with a copy/download control and an
   explicit "I have saved these" checkbox that gates the Continue button.

`secret` and `recoveryCodes` are returned **exactly once** — the server stores only
digests, and there is no endpoint that can show them again. A screen that stashes
them in state and navigates away has destroyed them, and the account's only route
back in is a database statement.

Calling `2fa/setup` again replaces the pending secret. A half-finished enrolment
cannot sign in: `mfaEnabled` stays false until `2fa/enable` succeeds.

`422` from `2fa/setup` means an authenticator already exists — send the user to
verify mode instead.

---

## 4. Verify — `/two-factor` in verify mode

```
POST /v1/admin/auth/2fa/verify
{ "challengeToken": "eyJ…", "code": "511061", "deviceLabel": "Chrome · Windows" }
```

Send **exactly one** of `code` (six digits) or `recoveryCode`. Offer "Use a recovery
code instead" as a secondary action.

A recovery code is **single-use and its digest is deleted whether or not anything
later fails** — so never send one speculatively or as part of a retry.

A wrong value counts toward the **same five-attempt lockout** as a wrong password.

`trustDevice` is accepted by the schema so the checkbox has somewhere to go, but it
**does not** mint a bypass cookie. Skipping the second factor for 30 days is exactly
the exposure the second factor exists to remove. Do not build UI implying otherwise.

---

## 5. Session lifetime

The access token lasts **10 minutes** (`expiresInSeconds`, currently 600).

`POST /v1/admin/auth/refresh` — **no request body**. Reads the httpOnly `ach_art`
cookie (`Path=/v1/admin/auth`). Returns a new access token and rotates the cookie.

> Refresh also **re-reads the role's grants**, which is what makes a revoked
> permission take effect within one token lifetime instead of at next sign-in. So
> refresh the *permission set* too, not just the token.

**Rotation means the presented token is dead the moment refresh returns.**

- **No retry on refresh.** No backoff, no React-Query `retry`. A failed refresh means
  route to `/session-expired`.
- **One in-flight refresh.** Concurrent 401s must queue behind a single call —
  see the `refreshing ??=` pattern in §1. Firing several is what triggers the
  revoke-the-family path and signs the user out.

`POST /v1/admin/auth/logout` is **always `204`**, found or not. Sign-out must never
fail. It denylists the session so the outstanding access token stops working
immediately rather than at expiry. Clear `accessToken` locally regardless of response.

---

## 6. Boot the shell from `GET /v1/admin/me`

Call it once after any successful sign-in and after every refresh.

```jsonc
{
  "type": "success",
  "result": {
    "id": "…", "email": "…", "fullName": "…", "avatarInitials": "PN",
    "role": { "key": "operations_manager", "name": "Operations Manager" },
    "permissions": ["inventory:view", "inventory:edit"],
    "modules": ["inventory", "orders"],
    "actions": ["view", "create", "…"],
    "warehouseIds": [],
    "mfaEnabled": true,
    "mfaRequired": true,
    "stepUpActive": false,
    "sessionId": "…",
    "lastActiveAt": "2026-08-25T10:30:00.000Z"
  }
}
```

- **`modules`** → build the sidebar from this. Do not parse `permissions` strings.
- **`permissions`** → `module:action` grants, for hiding controls. **Optimistic UI
  only** — the server re-checks every call, so a hidden button is a courtesy, not a
  control. Never rely on it for security.
- **`warehouseIds`** → an **EMPTY array means every warehouse.** A non-empty array
  scopes this user; default and constrain warehouse pickers to it. Getting this
  backwards shows one user nothing and another everything.
- **`mfaRequired`** → true when the role can change data. Surface a nag if
  `mfaEnabled` is false.
- **`stepUpActive`** → see §7.

---

## 7. Step-up before money movement

`POST /v1/admin/orders/{orderId}/refund` requires a password re-entry within the last
**five minutes**. Without it the refund returns `403`.

```
POST /v1/admin/auth/step-up   { password }
  → { expiresInSeconds }
```

**Flow:** refund → `403` → modal asking for the password → `step-up` → **re-issue the
original refund request**. Do not show "forbidden" and stop.

The window lives in Redis on the current session, not in a token claim — signing out
or revoking the session ends it instantly. Use `stepUpActive` from `/me` to show a
lock icon on the refund button before the click.

`POST /v1/admin/auth/2fa/recovery-codes` (reissue ten codes) **also** requires a live
step-up — otherwise anyone at an unattended console could mint themselves a permanent
second-factor bypass.

---

## 8. Sessions screen (`/profile`)

```
GET    /v1/admin/sessions              → list, most recently used first
DELETE /v1/admin/sessions/{sessionId}  → 204
```

Only your own sessions; signing another staff member out is a settings action, not
self-service. Mark the row with `isCurrent: true` and warn before revoking it.

A session id belonging to someone else returns **`404`, not `403`** — confirming it
exists would itself be a leak. Do not write UI that distinguishes them.

---

## 9. Password reset

```
POST /v1/admin/auth/password/forgot   { email }              → always 200 { ok: true }
POST /v1/admin/auth/password/reset    { email, token, newPassword }
```

`forgot` returns the same body whether or not the address exists — it is otherwise a
staff-directory oracle. The success screen must say "if that address has an account,
we've sent a link", never "check your inbox".

The reset link carries a **token in the URL**; the reset form must read it and submit
it alongside the email. A reset page that does not read the token cannot work.

**`newPassword` policy: at least 12 characters, with upper case, lower case and a
digit.** Validate client-side to match, or the server's `422` is the first the user
hears of it. On success every other session is revoked — a reset is what you do when
you think someone else has your credentials — so route to sign-in, not to the
dashboard.

---

## 10. Routes to build

| Route | Purpose |
|---|---|
| `/login` | Email + password. Branches on `result.status`. |
| `/two-factor` | Both modes — enrolment (QR + recovery codes) and verify (code / recovery code). |
| `/forgot-password` | Email only. Neutral confirmation. |
| `/reset-password` | Reads `token` from the URL. Enforces the 12-char policy. |
| `/session-expired` | Where a failed refresh lands. |
| `/profile` | Sessions table with revoke. |

---

## 11. Definition of done

- [ ] `json.result` is unwrapped in exactly one place; `json.data` appears nowhere.
- [ ] Errors read `result.code`; nothing string-matches `detail`.
- [ ] All three login statuses are handled and routed.
- [ ] Enrolment shows the QR, the secret, and gates Continue on saving recovery codes.
- [ ] Verify accepts a recovery code as an alternative to a TOTP code.
- [ ] Access token is in memory only — grep the build output for `localStorage` and
      confirm no token is written to it.
- [ ] Exactly one in-flight refresh; no retry on refresh failure.
- [ ] `429` shows the `retry-after` wait instead of retrying.
- [ ] Sidebar built from `modules`; empty `warehouseIds` treated as "all".
- [ ] Refund `403` prompts for step-up and **retries** the original request.
- [ ] Logout clears local state even if the request fails.

Report which boxes you could not tick and why.
