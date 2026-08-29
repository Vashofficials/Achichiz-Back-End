# Achichiz Storefront API — Implementation Guide

Everything a client needs to build the Achichiz storefront against this API.
**70 endpoints across 25 modules.**

These documents are generated from the server's own route registry, so every field
name, type, default and constraint is the one the server actually validates against.
Where a document and the running API disagree, the API is right — regenerate.

> **Using this as an AI prompt (Lovable, v0, Cursor):** give the model this README
> **plus the one module file** for the screen you are building. Do not paste all 25 —
> the README carries every convention the module files assume, and the module file
> carries the exact JSON.

---

## 1. Base URL

| Environment | URL |
|---|---|
| Production | `https://api.achichiz.com` |
| Local | `http://localhost:4000` |

Interactive spec at `/docs/storefront`. Paths are written Express-style with a
leading colon — `/v1/products/:handle` → `/v1/products/brass-diya-set`.

**Only 21 of the 70 endpoints require a signed-in customer.** Browsing, search, the
entire catalogue and — importantly — **the whole cart** are public. Endpoints needing
a token are marked 🔒 in each module file.

---

## 2. The cart is public. This is the most important thing on this page.

A cart exists **before an account does**. A shopper fills a basket and is only asked
to sign in at checkout. Ownership is proved by an **opaque cart token**, not a session.

```http
X-Cart-Token: ct_9f1c2a7e3b444d908a11
```

- The token comes back from the first `POST /v1/cart/lines`. **Persist it** —
  `localStorage` is correct here; it is not a credential to an account, it is a
  handle to an anonymous basket.
- Send it on **every** cart call. Without it the server sees a brand-new empty cart
  and the basket silently appears to reset.
- The header is preferred over the `cartToken` body/query field because it stays out
  of access logs and referrer headers. **The header wins when both are sent.**

### The merge, at sign-in

When a guest signs in, their basket must be folded into the account. Two ways, and
you only need one:

**Automatic** — pass `cartToken` in the body of `signup`, `login`, `verifyLoginOtp`
or `signInWithFirebase`. The merge happens inside the sign-in.

**Explicit** — `POST /v1/cart/merge` after the fact.

> A merge failure **never** fails the sign-in. If the guest cart held a discontinued
> variant the login still succeeds and the cart is simply not merged — so do not
> gate navigation on the merge result.

### Totals are always the server's

Every cart response recomputes totals from live variant and add-on prices. The
response never echoes a number the client sent, and there is no field through which a
client can propose a price. **Do not compute totals client-side** — render what comes
back. Shipping assumes standard delivery until an address reaches
`POST /v1/checkout/quote`.

---

## 3. Authentication

Three ways in. All three end with the same session.

### 3.1 Firebase phone OTP — the primary path

Firebase sends the SMS and verifies the code **in the browser**. The server never
sees the OTP.

```js
const confirmation = await signInWithPhoneNumber(auth, '+91' + mobile, recaptcha);
const credential   = await confirmation.confirm(code);
const idToken      = await credential.user.getIdToken();

await fetch('/v1/auth/firebase', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ idToken, cartToken }),
});
```

Send the **Firebase ID token**, never the six-digit code. The response tells you what
happened:

- `isNewAccount: true` → route to onboarding. It is the only reliable signal, because
  a phone sign-in has no separate signup step.
- `linkedExistingAccount: true` → an existing customer just used Firebase for the
  first time. Their orders and addresses are intact; nothing was migrated.

Firebase tokens are accepted at this one endpoint and **nowhere else**.

### 3.2 Email + password

`POST /v1/auth/signup` and `POST /v1/auth/login`. Every failure returns the same
`401` with the same message — the body never says whether the account exists or the
password was wrong. Do not try to distinguish them in the UI.

### 3.3 The session

```json
{ "accessToken": "eyJhbGciOi…", "tokenType": "Bearer", "expiresIn": 900, "customer": { … } }
```

```http
Authorization: Bearer <accessToken>
```

**Access token in memory only.** Never `localStorage` — a token JavaScript can read is
a token an XSS can steal. (The *cart* token is different: it guards an anonymous
basket, not an account.)

The **refresh token is never in the response body.** It is an httpOnly cookie
(`ach_rt`, `Path=/v1/auth`), so only the auth calls need credentials:

```js
fetch('/v1/auth/refresh', { method: 'POST', credentials: 'include' })
```

### 3.4 Refreshing — do not retry

`POST /v1/auth/refresh` takes **no body**. Call it on a timer just inside `expiresIn`,
and once on a `401`.

Refresh tokens **rotate**. Presenting one that was already spent means two parties
hold the session, so the server revokes the **entire family** immediately. A client
that retries a refresh whose response it lost will sign itself out.

- No retry wrapper on the refresh call.
- Concurrent `401`s must **queue behind one in-flight refresh**, not each fire their own.

---

## 4. Response envelope

Every success response is wrapped. There are no bare arrays.

```jsonc
{ "type": "success", "result": { … } }                              // single
{ "type": "success", "result": [ … ],
  "meta": { "page":1,"perPage":24,"total":137,"totalPages":6 } }    // list — meta is a SIBLING
```

The payload is under **`result`**, never `data`. `204` responses have no body.
Unwrap `.result` **once, centrally**, in your HTTP layer.

---

## 5. Errors

The **same two-key envelope** as success, with `type: "error"`. Content type is
`application/json` — despite the RFC 9457 *field names* inside `result`, this is not
`application/problem+json`.

```jsonc
{
  "type": "error",
  "result": {
    "title": "Unprocessable",
    "status": 422,
    "code": "insufficient_stock",          // ← stable. Branch on this.
    "detail": "Only 2 of Brass Diya Set are left.",   // ← prose, will be reworded
    "instance": "/v1/cart/lines",
    "requestId": "01M0WFES78H68XBHTVM09XZY8G"
  }
}
```

Everything is **one level down, inside `result`**. A client reading `err.code` at the
top level gets `"error"` for every failure, forever.

**Branch on `result.code`, never on `result.detail`.** Surface `result.requestId` in
any error toast — it is the only thing support can trace.

Validation failures carry a field list under **`errors`** (not `issues`), whose
`path` is dot-notated and indexes arrays, so it maps straight onto a form field:

```jsonc
{
  "type": "error",
  "result": {
    "code": "validation_failed",
    "detail": "2 fields are invalid.",
    "errors": [
      { "path": "lines.0.quantity", "code": "invalid_type", "message": "Expected number, received string" }
    ]
  }
}
```

| Status | Meaning | Client action |
|---|---|---|
| `401` | Missing/expired/revoked token. | Refresh once, then sign in. |
| `404` | No such record. | Empty state. |
| `409` | Already exists. | Show it; do not retry. |
| `422` | Well-formed, refused by a business rule. | **Show `detail` verbatim.** |
| `429` | Rate limited. | Back off; read the `RateLimit` header. |
| `502` | Gateway (Razorpay) unreachable. | **Safe to retry.** |

`422` is the interesting one — out of stock, coupon not applicable, order not
cancellable. `detail` is written to be read by the shopper.

---

## 6. Checkout and payment

The one flow worth getting exactly right.

```
POST /v1/checkout/quote      → price the cart for a destination + method
POST /v1/orders              → place the order (returns a payment session)
   ↳ Razorpay Checkout.js on the client
POST /v1/payments/razorpay/verify   → confirm the hand-back
```

### Placing the order

`POST /v1/orders` **already returns the payment session** for a prepaid order. You do
not normally need `POST /v1/payments/razorpay/order` at all.

That endpoint is the **retry path**, for exactly two cases:

1. `POST /v1/orders` came back with `payment: null` — the gateway was unreachable.
2. The customer abandoned Checkout and returned later to pay.

The amount is read from the order's own balance. **There is no field through which a
client can propose an amount.** An unconsumed session for the same amount is handed
back rather than a second one being created, so double-tapping "Pay now" is free.

Only `keyId` is returned. The key secret never leaves the server.

### Verifying

After Checkout.js hands back, `POST /v1/payments/razorpay/verify` with the
`razorpayOrderId`, `razorpayPaymentId` and `razorpaySignature`.

**Do not treat verify as the source of truth for fulfilment.** The Razorpay webhook
(`POST /v1/webhooks/razorpay`) is authoritative and idempotent; verify exists so the
customer sees a confirmed screen immediately. A customer who closes the tab before
verify still gets their order — the webhook lands regardless.

---

## 7. Pagination, sorting, search

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `page` | integer | `1` | 1-indexed. |
| `perPage` | integer | `24` | **Maximum 100** — rejected, not clamped. |
| `sort` | string | per endpoint | `-createdAt` for descending. |
| `q` | string | — | Free-text search. |

Sort fields are allow-listed per endpoint; an unknown field falls back to the default
rather than erroring, so a typo looks like "sorting is broken" with no error.

**Three search endpoints, three jobs:**

- `GET /v1/search` — the results page.
- `GET /v1/search/suggest` — header autocomplete, as-you-type.
- `GET /v1/search/suggestions` — recovery hints **after** a search returned nothing.

---

## 8. Money

**All money is an integer in paise.** `149900` is ₹1,499.00. There are no floats in
this API — divide by 100 only in the display formatter. Percentages are basis points
(`1000` = 10%). Field names ending `Paise` and `Bp` are the signal.

---

## 9. Stock is a state, not a number

Product responses carry `stock` as `in` / `low` / `out`. Render that.

`stockQty` is also present, but it is a snapshot that is wrong the moment another
shopper's cart holds two of them. **Never render a raw count as "only N left"** — the
authoritative check happens when the line is added to the cart, and again at checkout.

---

## 10. Module index

| Module | Endpoints | Need sign-in |
|---|---|---|
| [Account](./account.md) | 5 | 5 |
| [Add-ons](./add-ons.md) | 2 | 0 |
| [Addresses](./addresses.md) | 6 | 6 |
| [Auth](./auth.md) | 9 | 1 |
| [Cart](./cart.md) | 8 | 1 |
| [Checkout](./checkout.md) | 2 | 2 |
| [CMS](./cms.md) | 2 | 0 |
| [Collections](./collections.md) | 3 | 0 |
| [Delivery](./delivery.md) | 1 | 0 |
| [Designers](./designers.md) | 2 | 0 |
| [FAQ](./faq.md) | 1 | 0 |
| [Hamper builder](./hamper-builder.md) | 2 | 0 |
| [Journal](./journal.md) | 2 | 0 |
| [Leads](./leads.md) | 3 | 0 |
| [Navigation](./navigation.md) | 1 | 0 |
| [Orders](./orders.md) | 4 | 3 |
| [Pages](./pages.md) | 3 | 0 |
| [Payments](./payments.md) | 2 | 2 |
| [Products](./products.md) | 3 | 0 |
| [Search](./search.md) | 3 | 0 |
| [SEO](./seo.md) | 1 | 0 |
| [Store / Media](./store-media.md) | 1 | 1 |
| [System](./system.md) | 2 | 0 |
| [Testimonials](./testimonials.md) | 1 | 0 |
| [Webhooks](./webhooks.md) | 1 | 0 |

---

## 11. A working HTTP layer

```js
const BASE = 'https://api.achichiz.com';

let accessToken = null;                        // memory only — never localStorage
const cartToken = () => localStorage.getItem('ach_cart');   // fine: anonymous basket

let refreshing = null;                         // one in-flight refresh, ever

async function refresh() {
  refreshing ??= fetch(`${BASE}/v1/auth/refresh`, {
    method: 'POST',
    credentials: 'include',                    // the ach_rt cookie is the credential
  })
    .then(async (r) => {
      if (!r.ok) throw new Error('session expired');   // do NOT retry — rotation
      accessToken = (await r.json()).result.accessToken;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(cartToken() ? { 'X-Cart-Token': cartToken() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401 && retry) {
    await refresh();                           // once, never in a loop
    return api(path, { method, body, retry: false });
  }

  if (res.status === 204) return null;

  const json = await res.json();               // { type, result } — always these two keys

  if (!res.ok) {
    const p = json.result ?? {};               // EVERYTHING is one level down
    throw Object.assign(new Error(p.detail ?? 'Request failed'), {
      code: p.code,                            // branch on this
      errors: p.errors,                        // field list — `errors`, NOT `issues`
      requestId: p.requestId,                  // show in the toast
      status: res.status,
    });
  }
  return json.result;                          // unwrap the envelope once, here
}
```

Add-to-cart, with the token captured on first use:

```js
const cart = await api('/v1/cart/lines', {
  method: 'POST',
  body: { variantId, quantity: 2 },
});
if (cart.token) localStorage.setItem('ach_cart', cart.token);
```

---

*Generated from the route registry. Regenerate after any route change so these
documents cannot drift from the running API.*
