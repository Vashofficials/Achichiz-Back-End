# Prompt — Audit this app's Achichiz Admin API integration

**Paste this whole file into Lovable (or Cursor / v0 / Claude Code) with the admin app open.**

You are auditing an existing admin console against the Achichiz Admin API contract.
**Do not build features. Do not refactor. Do not "improve" anything.** Read the code,
decide whether each check below holds, and produce the report in §4.

Every check is derived from how this specific API actually behaves. They are the
things that break silently — the app compiles, screens render, and the bug surfaces
as wrong money, a locked-out user, or double-consumed stock.

- **Base URL:** `https://api.achichiz.com` (local: `http://localhost:4000`)
- **Interactive spec:** `/docs/admin`
- **212 admin endpoints across 23 modules**

---

## 1. How to audit

1. Find the app's HTTP layer — the fetch/axios wrapper, the generated client, or the
   hooks that call the API. Start there; most checks live in one or two files.
2. For each check: locate the code, decide **PASS / FAIL / NOT FOUND**, and record
   `file:line` as evidence.
3. **Never mark PASS without having read the code that makes it true.** "It probably
   handles that" is a FAIL. If the feature does not exist in the app at all, say
   NOT FOUND rather than PASS.
4. Do not fix anything until the report is delivered and the user asks.

---

## 2. Blocking checks

A FAIL here means the app is broken in production, not merely untidy.

### A1 — The payload is unwrapped from `result`, exactly once

**Every** response — success and error alike — has exactly two top-level keys:
`type` and `result`. There are no bare arrays, and there is **no `data` key
anywhere in this API.**

```jsonc
{ "type": "success", "result": { … } }                          // single
{ "type": "success", "result": [ … ],
  "meta": { "page":1,"perPage":25,"total":137,"totalPages":6 } } // list — meta is a SIBLING of result
```

**Check:** the HTTP layer returns `json.result`, centrally. An app written against
`json.data` gets `undefined` on every single call.
**Symptom if wrong:** everything is `undefined`; lists render empty or throw
`.map is not a function`.

### A2 — Errors read `result.code`, never the top level

Errors use the **same envelope**, with `type: "error"`. The content type is
`application/json`, **not** `application/problem+json`, despite the RFC 9457 field
names inside `result`.

```jsonc
{
  "type": "error",
  "result": {
    "title": "Unprocessable",
    "status": 422,
    "code": "insufficient_stock",   // ← stable. Branch on this.
    "detail": "Not enough ACH-CAN-001 — 105 needed, 40 sellable.",  // ← prose. Will be reworded.
    "instance": "/v1/admin/production/orders/9f1c…/complete",
    "requestId": "01M0WFES78H68XBHTVM09XZY8G"
  }
}
```

**The trap:** `err.code` at the top level is the literal string `"error"` for every
failure in the API. The real code is `err.result.code`.

**Check:** the app reads `json.result.code`, does not string-match on `detail` or
`title`, and surfaces `result.requestId` in the error UI — it is the only thing
support can trace.

### A3 — Validation errors read `result.errors` (not `issues`)

```jsonc
{
  "type": "error",
  "result": {
    "code": "validation_failed",
    "detail": "2 fields are invalid.",
    "errors": [
      { "path": "shippingAddress.pincode", "code": "invalid_string", "message": "Pincode must be 6 digits" }
    ]
  }
}
```

The field list is **`errors`**. `path` is dot-notated and indexes arrays
(`lines.0.quantity`), so it maps directly onto a form field.

**Check:** validation messages attach to the specific input, not a single banner.

### A4 — Login handles all THREE outcomes

`POST /v1/admin/auth/login` always returns `200`. What differs is `result.status`:

| `status` | Next step |
|---|---|
| `authenticated` | Tokens are in `result.tokens`. Proceed. |
| `mfa_required` | Code screen → `POST /v1/admin/auth/2fa/verify` |
| `enrolment_required` | QR screen → `2fa/setup` → `2fa/enable` |

**Check:** all three branches exist. **An app missing `enrolment_required` locks out
every new staff member permanently** — 2FA cannot be skipped, and there is no other
route to a token.

### A5 — The TOTP secret and recovery codes are displayed on first render

`2fa/setup` returns `secret` + `otpauthUri`. `2fa/enable` returns `recoveryCodes[]`.
The server stores only hashes; **these values are never retrievable again.**

**Check:** `otpauthUri` is rendered as a QR, `secret` shown for manual entry, and the
ten `recoveryCodes` are displayed with an explicit "I have saved these" confirmation
before navigation is allowed. Storing them in app state and navigating away destroys
them.

### A6 — Refresh is never retried

`POST /v1/admin/auth/refresh` takes **no body** — the httpOnly cookie is the credential.
Refresh tokens **rotate**: the old one dies the instant the new one is issued.
Presenting an already-spent token means two parties hold one session, so the server
revokes the **entire session family**.

**Check:** no retry loop, no exponential backoff, no React-Query `retry` on the
refresh call. A failed refresh must mean "sign in again". Also confirm concurrent
401s do not each fire their own refresh — they must queue behind one in-flight call.

### A7 — Money is integer paise everywhere

`149900` is ₹1,499.00. There are no floats in this API.

**Check:** no `parseFloat` on a `*Paise` field, no `* 100` / `/ 100` outside the
display formatter, and form inputs submit integers. `*Bp` fields are basis points —
`1000` is 10%.
**Symptom if wrong:** every price wrong by 100×.

### A8 — `Idempotency-Key` is generated once per user action

Stock- and money-moving POSTs require the header. Replaying a key returns the stored
original response with `Idempotent-Replay: true`.

**Check:** the key is created when the user clicks and **reused across retries**.
Generating a fresh key inside a retry wrapper or an interceptor defeats the whole
mechanism and will double-consume inventory.

---

## 3. Correctness checks

FAIL here means wrong behaviour in specific cases, not total breakage.

### B1 — `DELETE` is presented as *archive*

`DELETE /v1/admin/{resource}/{id}` sets `deleted_at`. Nothing hard-deletes.
**Check:** UI says "Archive", not "Delete permanently".

### B2 — `perPage` never exceeds 100
Values above 100 are **rejected**, not clamped. Check page-size selectors and any
"export all" that fetches with a large `perPage`.

### B3 — Sorting uses the `-` prefix and allow-listed fields
`?sort=-createdAt` is descending. Unknown fields silently fall back to the default —
so a wrong field name looks like "sorting is broken" with no error.

### B4 — `credentials: 'include'` is set where the cookie is needed
The refresh cookie is `ach_art`, scoped to `Path=/v1/admin/auth`. Only the auth calls
need credentials; it is not sent on the other ~200 endpoints. Both mistakes count:
missing it on auth calls, or setting it globally when the API's CORS is credentialed.

### B5 — The access token is in memory only
**Check:** the access token is NOT in `localStorage` or `sessionStorage`. A token
JavaScript can read is a token an XSS can steal. The refresh token is httpOnly and
must never be read by JS at all.

### B6 — `GET /v1/admin/me` drives the shell
It returns more than permissions:

- `modules[]` — the distinct modules with any grant. **Build the sidebar from this**,
  not by parsing `permissions` strings.
- `warehouseIds[]` — a per-user warehouse scope. When non-empty, default and
  constrain every warehouse picker to it.
- `stepUpActive` — whether the password window is already open, so a refund button
  can show its lock state before the click.

**Check:** all three are used, not just `permissions`.

### B7 — `422` messages are shown verbatim
`422` means the request was well-formed and a **business rule** refused it —
insufficient stock, an illegal state transition, a closed window. `detail` is written
to be read by the operator. Do not replace it with "Something went wrong".

### B8 — Step-up on refunds prompts, then **retries**
`POST /v1/admin/orders/{orderId}/refund` needs a password re-entry inside the last
five minutes. Without it the call is a `403` whose `result.detail` says so.

**Check:** on that `403` the app prompts for the password, calls
`POST /v1/admin/auth/step-up`, then **re-issues the original refund request** —
rather than showing "forbidden" and stopping. The window lives in Redis, not a token
claim, so signing out ends it instantly; `GET /v1/admin/me` reports `stepUpActive`
for the button's lock state.

### B9 — State machines come from the API, not hardcoded
Endpoints return the legal next steps (`nextActions`, `transitions`, and
`GET /v1/admin/orders/transitions`). **Check:** buttons are enabled from those rather
than from a client-side copy of the state machine that will drift.

### B10 — Generic CRUD uses `/schema`
Twelve resources share the same six routes plus `GET /v1/admin/{resource}/schema`,
which returns field types, labels and validation. **Check:** whether twelve
near-identical screens were hand-written when one generic renderer would do. Report
it; do not rewrite it.

---

## 4. Required output

Produce exactly this, and nothing else:

```markdown
# Achichiz Admin API — Integration Audit

**Verdict:** SHIP / FIX FIRST / NOT INTEGRATED
**Blocking failures:** N of 8   ·   **Correctness failures:** N of 10

## Blocking

| # | Check | Result | Evidence | Notes |
|---|---|---|---|---|
| A1 | Payload unwrapped from `result` | FAIL | `src/lib/api.ts:34` | Returns `json.data` — always undefined. |
| A2 | Errors read `result.code` | FAIL | `src/lib/api.ts:61` | Reads `json.code`; always the string "error". |
| … | | | | |

## Correctness

| # | Check | Result | Evidence | Notes |
|---|---|---|---|---|
| B1 | DELETE shown as archive | … | … | … |

## Endpoint coverage

| Module | Endpoints | Called by app | Missing |
|---|---|---|---|
| Admin inventory | 32 | 11 | … |

## Top 5 fixes, in order

1. **[A1] Nothing is ever unwrapped** — `src/lib/api.ts:34`. Change `json.data` to
   `json.result`. Every screen currently receives `undefined`.
2. …
```

**Rules for the report**

- One row per check. No check omitted — use NOT FOUND if the feature is absent.
- Evidence is `file:line`. A row with no evidence is a FAIL.
- Verdict is **FIX FIRST** if any blocking check fails, **NOT INTEGRATED** if the app
  has no HTTP layer calling this API at all.
- Order the top-5 by damage done, not by how easy they are to fix.
- State what you could not verify and why. Do not guess to fill the table.
