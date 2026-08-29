# System

2 endpoints — 0 require a signed-in customer, 2 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /healthz`](#get-healthz) — Liveness probe
- [`GET /readyz`](#get-readyz) — Readiness probe

---

### `GET /healthz`

**Liveness probe**

| | |
|---|---|
| operationId | `getLiveness` |
| Auth | Public — no token needed |

Returns 200 whenever the process is running. Deliberately does NOT touch the database — a liveness probe that fails on a DB blip gets your healthy container killed during an outage.

**Response `200`** — The process is alive.

```json
{
  "type": "success",
  "result": {
    "status": "ok",
    "version": "string",
    "uptimeSeconds": 1
  }
}
```

---

### `GET /readyz`

**Readiness probe**

| | |
|---|---|
| operationId | `getReadiness` |
| Auth | Public — no token needed |

Checks Postgres and Redis. Returns 503 when a dependency is down so the load balancer stops sending traffic without the container being restarted.

**Response `200`** — All dependencies reachable.

**Errors**

| Status | Meaning |
|---|---|
| `503` | At least one dependency is unreachable. |

---
