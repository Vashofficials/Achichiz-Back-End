# Leads

3 endpoints — 0 require a signed-in customer, 3 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`POST /v1/leads/contact`](#post-v1-leads-contact) — Submit a contact enquiry
- [`POST /v1/leads/corporate-gifting`](#post-v1-leads-corporate-gifting) — Submit a corporate gifting brief
- [`POST /v1/newsletter/subscribe`](#post-v1-newsletter-subscribe) — Subscribe to the newsletter

---

### `POST /v1/leads/contact`

**Submit a contact enquiry**

| | |
|---|---|
| operationId | `submitContactEnquiry` |
| Auth | Public — no token needed |

Persists the enquiry as a lead, emails the team, and acknowledges the customer. Replaces `contact.tsx`, which today calls `preventDefault()`, shows a success toast and throws the message away. 

The response carries a `reference` (`LD-00042`) issued from the row-locked document series — show it in the confirmation, because support can search on it. A phone number that is not an Indian ten-digit mobile is stored on the lead as free text rather than rejected; losing a genuine enquiry over a landline would be the wrong trade. Rate-limited to 10 submissions per hour per IP. There is no captcha in front of this yet — if volume becomes a problem, that is the next control, not a tighter limiter.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `name` | `string` | **yes** | min 2, max 120 | Who is writing in. |
| `email` | `email` | **yes** | max 255 | Where the reply goes. The only field the reply strictly needs. |
| `phone` | `string` | no | min 6, max 20 | Optional call-back number. |
| `message` | `string` | **yes** | min 10, max 4000 | The enquiry itself. Stored verbatim on the lead as its brief. |
| `company` | `string` | no | max 160 | Optional. Supplied, the enquiry is filed against the company; otherwise against the person. |

Example request:

```json
{
  "name": "Brass Diya Set",
  "email": "priya@example.com",
  "phone": "9820012345",
  "message": "Please leave with the concierge.",
  "company": "string"
}
```

**Response `201`** — The enquiry is saved.

```json
{
  "type": "success",
  "result": {
    "status": "received",
    "reference": "string"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `429` | Too many submissions from this IP. |

---

### `POST /v1/leads/corporate-gifting`

**Submit a corporate gifting brief**

| | |
|---|---|
| operationId | `submitCorporateGiftingBrief` |
| Auth | Public — no token needed |

The B2B pipeline’s front door, and the highest-value form on the site. Persists to the same lead board the sales team works from, tagged `website_corporate_form`. 

The **25-unit minimum is enforced server-side**. The storefront expresses it as `min={25}` on an `<input>`, which any direct API call ignores; a brief for three mugs entering the corporate pipeline wastes a salesperson’s afternoon. Rate-limited to 10 submissions per hour per IP. There is no captcha in front of this yet — if volume becomes a problem, that is the next control, not a tighter limiter.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `name` | `string` | **yes** | min 2, max 120 | The buyer’s name. |
| `company` | `string` | **yes** | min 2, max 160 | Company the gifting programme is for. |
| `workEmail` | `email` | **yes** | max 255 | Work email address. Proposals and quotations go here. |
| `quantity` | `integer` | **yes** | ≥ 25, ≤ 1000000 | Units needed. The 25-unit minimum is enforced **here**, server-side — the storefront’s `min={25}` is an HTML attribute and a direct API call ignores it. |
| `brief` | `string` | **yes** | min 10, max 4000 | Free-text brief: occasion, budget, branding, timelines. |
| `mobile` | `string` | no | — | Optional direct line. Corporate leads convert far faster on a call than on email. |
| `occasion` | `string` | no | max 120 | Diwali, onboarding kits, client appreciation, … |
| `employeeCount` | `integer` | no | > 0, ≤ 10000000 | Headcount, when known. Drives programme sizing. |
| `city` | `string` | no | max 80 | Delivery city, when known. |

Example request:

```json
{
  "name": "Brass Diya Set",
  "company": "string",
  "workEmail": "priya@example.com",
  "quantity": 2,
  "brief": "string",
  "mobile": "9820012345",
  "occasion": "string",
  "employeeCount": 3,
  "city": "Mumbai"
}
```

**Response `201`** — The brief is saved.

```json
{
  "type": "success",
  "result": {
    "status": "received",
    "reference": "string"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `422` | Below the 25-unit minimum, or a field failed validation. |

---

### `POST /v1/newsletter/subscribe`

**Subscribe to the newsletter**

| | |
|---|---|
| operationId | `subscribeToNewsletter` |
| Auth | Public — no token needed |

Adds the address to the marketing list and records the consent with a timestamp, a source and an IP — a boolean column alone cannot answer "prove when they opted in", which is the question the DPDP Act actually asks. 

Idempotent and deliberately uninformative: the same `{ "status": "subscribed" }` comes back for a new address, for a customer who had opted out, and for one already on the list. A footer form that said "you already have an account" would be an account-existence oracle on every page. 

The subscriber list and the account list are the same rows, so the footer form and the profile toggle cannot disagree. Double opt-in is not implemented — it is an open business question.

**Request body**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `email` | `email` | **yes** | max 255 | The address to subscribe. Case-insensitive — stored CITEXT. |
| `source` | `"footer" \| "profile" \| "checkout" \| "popup"` | no | default `"footer"` | Which control the customer used. Recorded with the consent, because consent needs provenance. |

Example request:

```json
{
  "email": "priya@example.com",
  "source": "footer"
}
```

**Response `200`** — Subscribed (or already subscribed).

```json
{
  "type": "success",
  "result": {
    "status": "subscribed"
  }
}
```

**Errors**

| Status | Meaning |
|---|---|
| `429` | Too many submissions from this IP. |

---
