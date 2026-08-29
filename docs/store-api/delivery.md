# Delivery

1 endpoint — 0 require a signed-in customer, 1 public.

> Read `README.md` first — it carries the cart-token rule, the auth flow, the response envelope and the error shape that every endpoint here assumes.

## Endpoints

- [`GET /v1/serviceability`](#get-v1-serviceability) — Check delivery serviceability for a PIN code

---

### `GET /v1/serviceability`

**Check delivery serviceability for a PIN code**

| | |
|---|---|
| operationId | `checkServiceability` |
| Auth | Public — no token needed |

Real coverage, not an optimistic guess: an unknown PIN code and a suspended one both return `serviceable: false`. `sameDayEligible` additionally requires the zone’s cutoff not to have passed in Asia/Kolkata. `codEligible` requires both the zone and the PIN code to allow cash on delivery.

**Query parameters**

| Field | Type | Required | Rules | Notes |
|---|---|---|---|---|
| `pincode` | `string` | **yes** | — | Destination Indian PIN code, e.g. `400053`. |

**Response `200`** — The serviceability answer. Always 200, including for unserviceable PIN codes.

```json
{
  "type": "success",
  "result": {
    "pincode": "DIWALI20",
    "serviceable": false,
    "city": "Mumbai",
    "stateCode": "DIWALI20",
    "zoneName": "Brass Diya Set",
    "tier": "metro",
    "standardTatDays": 30,
    "estimatedDeliveryDate": "string",
    "sameDayEligible": false,
    "sameDayCutoff": "string",
    "midnightEligible": false,
    "codEligible": false
  }
}
```

---
