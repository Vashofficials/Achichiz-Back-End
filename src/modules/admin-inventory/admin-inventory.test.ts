import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, UnprocessableError } from '../../lib/errors.js';

/**
 * Pure tests only — no Postgres, no Redis.
 *
 * What is worth testing here is the set of rules that decide whether a warehouse
 * can oversell, whether the ledger's running balance is right, and whether a
 * retried POST adjusts stock twice. Those are the four ways this module can be
 * wrong in a way that costs money, and every one of them is provable without a
 * database.
 *
 * The concurrency MECHANISM — the conditional `UPDATE ... WHERE
 * on_hand - reserved + delta >= 0` and its affected-row check — is a property of
 * PostgreSQL under READ COMMITTED and cannot be demonstrated with a mock; a mock
 * of a query builder tests the mock. What is asserted here is everything that
 * decides what that statement is asked to do.
 */

/* -------------------------------------------------------------- redis mock */

const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    cache: {
      get: (key: string): Promise<string | null> => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string, _ex?: string, _ttl?: number, mode?: string): Promise<string | null> => {
        if (mode === 'NX' && store.has(key)) return Promise.resolve(null);
        store.set(key, value);
        return Promise.resolve('OK');
      },
      del: (key: string): Promise<number> => Promise.resolve(store.delete(key) ? 1 : 0),
    },
  };
});

vi.mock('../../config/redis.js', () => ({ cache: redis.cache }));

const { idempotency } = await import('../../middleware/idempotency.js');

const {
  applyReservation,
  assertReservable,
  assertSufficientStock,
  availableOf,
  balanceAfter,
  reorderSuggestion,
  roundUpToMoq,
  stockState,
} = await import('./admin-inventory.stock.js');

const { buildInventoryWhere, purchaseOrderScopeKey, toCsv } = await import('./admin-inventory.service.js');

const {
  adjustmentBody,
  bulkAdjustBody,
  inventoryListQuery,
  movementIdParam,
  purchaseDraftBody,
  reservationBody,
  ADJUSTMENT_MOVEMENT_TYPES,
  MOVEMENT_TYPES,
} = await import('./admin-inventory.schemas.js');

/* ------------------------------------------------------ the oversell guard */

describe('the oversell guard — the definition of done', () => {
  it('refuses a decrement that would take SELLABLE stock below zero', () => {
    // 10 on the shelf, 8 already promised. Only 2 are actually free.
    const level = { onHandQty: 10, reservedQty: 8 };
    expect(availableOf(level)).toBe(2);

    expect(() => assertSufficientStock(level, -3, 'SKU-1 at WH-MUM')).toThrow(UnprocessableError);
    expect(() => assertSufficientStock(level, -3, 'SKU-1 at WH-MUM')).toThrow(/insufficient|not a quantity/i);
  });

  it('throws with the STABLE code `insufficient_stock`, which frontends switch on', () => {
    let thrown: unknown;
    try {
      assertSufficientStock({ onHandQty: 1, reservedQty: 1 }, -1, 'SKU-1');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnprocessableError);
    expect((thrown as UnprocessableError).code).toBe('insufficient_stock');
    expect((thrown as UnprocessableError).status).toBe(422);
  });

  it('guards SELLABLE stock, not on-hand — reserved units are present but spoken for', () => {
    // Removing 5 from 10 on-hand looks fine if you only look at on-hand. It is
    // not: 8 of those 10 belong to somebody's paid order.
    const level = { onHandQty: 10, reservedQty: 8 };
    expect(() => assertSufficientStock(level, -5, 'SKU-1')).toThrow(UnprocessableError);
    // With nothing reserved, the same removal is fine.
    expect(() => assertSufficientStock({ onHandQty: 10, reservedQty: 0 }, -5, 'SKU-1')).not.toThrow();
  });

  it('allows a decrement that lands exactly on zero sellable', () => {
    expect(() => assertSufficientStock({ onHandQty: 10, reservedQty: 8 }, -2, 'SKU-1')).not.toThrow();
  });

  it('never blocks an increment, whatever the reservations look like', () => {
    expect(() => assertSufficientStock({ onHandQty: 0, reservedQty: 0 }, +500, 'SKU-1')).not.toThrow();
    expect(() => assertSufficientStock({ onHandQty: 3, reservedQty: 3 }, +1, 'SKU-1')).not.toThrow();
  });

  it('names the real numbers in the message, so the operator can act on it', () => {
    try {
      assertSufficientStock({ onHandQty: 10, reservedQty: 8 }, -3, 'CORK-A5 at WH-MUM-AND');
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('CORK-A5 at WH-MUM-AND');
      expect(message).toContain('10 on hand');
      expect(message).toContain('8 reserved');
    }
  });
});

/* --------------------------------------------- adjustment maths / balance */

describe('adjustment maths and balanceAfter', () => {
  it('is the ON-HAND balance after the movement, never the available one', () => {
    // Reservations do not appear in the ledger at all. Subtracting them would
    // make consecutive rows disagree by however many holds happened to exist.
    expect(balanceAfter({ onHandQty: 40, reservedQty: 12 }, +10)).toBe(50);
    expect(balanceAfter({ onHandQty: 40, reservedQty: 12 }, -10)).toBe(30);
  });

  it('reconstructs the running balance across a sequence of movements', () => {
    const deltas = [+100, -20, -5, +50, -25];
    let position = { onHandQty: 0, reservedQty: 7 };
    const balances = deltas.map((delta) => {
      const next = balanceAfter(position, delta);
      position = { onHandQty: next, reservedQty: position.reservedQty };
      return next;
    });

    expect(balances).toEqual([100, 80, 75, 125, 100]);
    // The invariant the nightly reconciliation job asserts.
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(position.onHandQty);
    // Reservations rode along untouched the whole way.
    expect(position.reservedQty).toBe(7);
  });

  it('a correction is a reversing movement, and the balance returns to where it was', () => {
    const before = { onHandQty: 60, reservedQty: 0 };
    const afterMistake = balanceAfter(before, -15);
    const afterCorrection = balanceAfter({ onHandQty: afterMistake, reservedQty: 0 }, +15);

    expect(afterMistake).toBe(45);
    expect(afterCorrection).toBe(before.onHandQty);
  });

  it('agrees with `availableOf` on what is left sellable', () => {
    const before = { onHandQty: 30, reservedQty: 10 };
    const after = { onHandQty: balanceAfter(before, -5), reservedQty: before.reservedQty };
    expect(after.onHandQty).toBe(25);
    expect(availableOf(after)).toBe(15);
  });
});

/* ---------------------------------------------------------------- reserve */

describe('a reservation moves reservedQty and NOTHING else', () => {
  it('leaves onHandQty untouched — the units have not moved, they are spoken for', () => {
    const before = { onHandQty: 25, reservedQty: 4 };
    const after = applyReservation(before, 6);

    expect(after.onHandQty).toBe(before.onHandQty);
    expect(after.reservedQty).toBe(10);
    expect(availableOf(after)).toBe(15);
  });

  it('a hold followed by its release returns the position exactly, with no drift', () => {
    const start = { onHandQty: 25, reservedQty: 4 };
    const held = applyReservation(start, 6);
    const released = applyReservation(held, -6);

    expect(released).toEqual(start);
  });

  it('refuses a hold larger than sellable stock, with the same stable code', () => {
    let thrown: unknown;
    try {
      assertReservable({ onHandQty: 10, reservedQty: 8 }, 3, 'SKU-1 at WH-MUM');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnprocessableError);
    expect((thrown as UnprocessableError).code).toBe('insufficient_stock');
  });

  it('allows a hold that exactly consumes the remaining sellable stock', () => {
    expect(() => assertReservable({ onHandQty: 10, reservedQty: 8 }, 2, 'SKU-1')).not.toThrow();
  });

  it('never lets reserved exceed on-hand, which is what the DB backstop also asserts', () => {
    const level = { onHandQty: 10, reservedQty: 0 };
    expect(() => assertReservable(level, 10, 'SKU-1')).not.toThrow();
    expect(() => assertReservable(level, 11, 'SKU-1')).toThrow(UnprocessableError);
    expect(applyReservation(level, 10).reservedQty).toBeLessThanOrEqual(level.onHandQty);
  });
});

/* ------------------------------------------------------------ stock state */

describe('stock state', () => {
  it('is out at or below zero sellable, whatever on-hand says', () => {
    expect(stockState({ onHandQty: 0, reservedQty: 0 }, 5)).toBe('out');
    // Everything on the shelf is already promised.
    expect(stockState({ onHandQty: 12, reservedQty: 12 }, 5)).toBe('out');
  });

  it('is low at or below the reorder point, and in above it', () => {
    expect(stockState({ onHandQty: 5, reservedQty: 0 }, 5)).toBe('low');
    expect(stockState({ onHandQty: 6, reservedQty: 0 }, 5)).toBe('in');
  });

  it('treats a zero reorder point as "anything above zero is in stock"', () => {
    expect(stockState({ onHandQty: 1, reservedQty: 0 }, 0)).toBe('in');
  });
});

/* ------------------------------------------------------ reorder + the MOQ */

describe('reorder suggestion', () => {
  it('rounds UP to the MOQ — a purchase order the supplier rejects is not a saving', () => {
    // Shortfall of 12 against a supplier who will not ship fewer than 50.
    const suggestion = reorderSuggestion({
      onHandQty: 8,
      reservedQty: 0,
      incomingQty: 0,
      reorderPoint: 10,
      reorderQty: 10,
      moq: 50,
    });

    expect(suggestion.shortfallQty).toBe(12);
    expect(suggestion.suggestedQty).toBe(50);
    expect(suggestion.suggestedQty).toBeGreaterThanOrEqual(suggestion.shortfallQty);
  });

  it('rounds up to the NEXT whole multiple, not merely to one MOQ', () => {
    const suggestion = reorderSuggestion({
      onHandQty: 0,
      reservedQty: 0,
      incomingQty: 0,
      reorderPoint: 100,
      reorderQty: 20,
      moq: 50,
    });
    // Shortfall 120 → 3 × 50 = 150, not 50 and not 100.
    expect(suggestion.shortfallQty).toBe(120);
    expect(suggestion.suggestedQty).toBe(150);
  });

  it('leaves a shortfall that is already a multiple of the MOQ alone', () => {
    const suggestion = reorderSuggestion({
      onHandQty: 0,
      reservedQty: 0,
      incomingQty: 0,
      reorderPoint: 50,
      reorderQty: 50,
      moq: 25,
    });
    expect(suggestion.shortfallQty).toBe(100);
    expect(suggestion.suggestedQty).toBe(100);
  });

  it('never suggests less than one MOQ when it triggers at all', () => {
    // Position sits exactly on the reorder point with a target that matches it:
    // shortfall is zero, but the buyer still has to act.
    const suggestion = reorderSuggestion({
      onHandQty: 10,
      reservedQty: 0,
      incomingQty: 0,
      reorderPoint: 10,
      reorderQty: 0,
      moq: 40,
    });
    expect(suggestion.shouldReorder).toBe(true);
    expect(suggestion.shortfallQty).toBe(0);
    expect(suggestion.suggestedQty).toBe(40);
  });

  it('counts INCOMING stock, so an item already on order is not ordered twice', () => {
    const withoutIncoming = reorderSuggestion({
      onHandQty: 5,
      reservedQty: 0,
      incomingQty: 0,
      reorderPoint: 20,
      reorderQty: 30,
      moq: 1,
    });
    const withIncoming = reorderSuggestion({
      onHandQty: 5,
      reservedQty: 0,
      incomingQty: 100,
      reorderPoint: 20,
      reorderQty: 30,
      moq: 1,
    });

    expect(withoutIncoming.shouldReorder).toBe(true);
    expect(withIncoming.shouldReorder).toBe(false);
    expect(withIncoming.suggestedQty).toBe(0);
  });

  it('does NOT count reserved stock as cover — those units are leaving the building', () => {
    const suggestion = reorderSuggestion({
      onHandQty: 40,
      reservedQty: 35,
      incomingQty: 0,
      reorderPoint: 20,
      reorderQty: 30,
      moq: 1,
    });
    expect(suggestion.inventoryPosition).toBe(5);
    expect(suggestion.shouldReorder).toBe(true);
    expect(suggestion.suggestedQty).toBe(45);
  });

  it('suggests nothing while the position is above the reorder point', () => {
    const suggestion = reorderSuggestion({
      onHandQty: 500,
      reservedQty: 0,
      incomingQty: 0,
      reorderPoint: 20,
      reorderQty: 30,
      moq: 10,
    });
    expect(suggestion.shouldReorder).toBe(false);
    expect(suggestion.suggestedQty).toBe(0);
  });

  it('treats a missing or nonsensical MOQ as 1 rather than dividing by zero', () => {
    const suggestion = reorderSuggestion({
      onHandQty: 0,
      reservedQty: 0,
      incomingQty: 0,
      reorderPoint: 10,
      reorderQty: 5,
      moq: 0,
    });
    expect(Number.isFinite(suggestion.suggestedQty)).toBe(true);
    expect(suggestion.suggestedQty).toBe(15);
  });

  it('rounds an operator-supplied quantity up to the MOQ too', () => {
    expect(roundUpToMoq(1, 50)).toBe(50);
    expect(roundUpToMoq(50, 50)).toBe(50);
    expect(roundUpToMoq(51, 50)).toBe(100);
    expect(roundUpToMoq(7, 1)).toBe(7);
  });
});

/* --------------------------------------------------- idempotency-key fingerprint */

type FakeReq = {
  headers: Record<string, string | string[] | undefined>;
  path: string;
  body: unknown;
  auth?: { kind: 'customer'; customerId: string } | { kind: 'staff'; staffId: string };
};

function fakeRes(): {
  statusCode: number;
  headers: Record<string, string>;
  payload: unknown;
  status: (code: number) => unknown;
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => void;
} {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  return res;
}

const KEY = 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff';

/** Run the middleware and report what it did. */
async function runIdempotency(req: FakeReq): Promise<{ err: unknown; res: ReturnType<typeof fakeRes>; passed: boolean }> {
  const middleware = idempotency();
  const res = fakeRes();
  let err: unknown;
  let passed = false;

  await middleware(
    req as never,
    res as never,
    ((e?: unknown) => {
      if (e) err = e;
      else passed = true;
    }) as never,
  );

  return { err, res, passed };
}

describe('Idempotency-Key fingerprinting', () => {
  beforeEach(() => {
    redis.store.clear();
  });

  it('requires the header on an endpoint that declares itself idempotent', async () => {
    const { err, passed } = await runIdempotency({ headers: {}, path: '/v1/admin/inventory/adjustments', body: {} });
    expect(passed).toBe(false);
    expect((err as Error).message).toMatch(/Idempotency-Key header is required/i);
  });

  it('rejects a key too short to be a UUID', async () => {
    const { err } = await runIdempotency({
      headers: { 'idempotency-key': 'abc' },
      path: '/v1/admin/inventory/adjustments',
      body: {},
    });
    expect((err as Error).message).toMatch(/between 8 and 255/i);
  });

  it('lets the first request through and reserves the key', async () => {
    const { passed, err } = await runIdempotency({
      headers: { 'idempotency-key': KEY },
      path: '/v1/admin/inventory/adjustments',
      body: { sku: 'CORK-A5', warehouseId: 'wh-1', quantityDelta: -5 },
    });

    expect(err).toBeUndefined();
    expect(passed).toBe(true);
    expect(redis.store.size).toBe(1);
  });

  it('REPLAYS the stored response for the same key AND the same body', async () => {
    const body = { sku: 'CORK-A5', warehouseId: 'wh-1', quantityDelta: -5 };
    const path = '/v1/admin/inventory/adjustments';

    // First attempt: run the handler and let it write its response.
    const first = await runIdempotency({ headers: { 'idempotency-key': KEY }, path, body });
    expect(first.passed).toBe(true);
    first.res.statusCode = 200;
    first.res.json({ data: { movementId: '4711', onHandQty: 5 } });

    // The retry after a stalled network. Stock must NOT move a second time.
    const replay = await runIdempotency({ headers: { 'idempotency-key': KEY }, path, body });
    expect(replay.passed).toBe(false);
    expect(replay.err).toBeUndefined();
    expect(replay.res.headers['Idempotent-Replay']).toBe('true');
    expect(replay.res.payload).toEqual({ data: { movementId: '4711', onHandQty: 5 } });
  });

  it('409s when the SAME key arrives with a DIFFERENT body', async () => {
    const path = '/v1/admin/inventory/adjustments';

    const first = await runIdempotency({
      headers: { 'idempotency-key': KEY },
      path,
      body: { sku: 'CORK-A5', quantityDelta: -5 },
    });
    first.res.json({ data: { ok: true } });

    // Same key, different delta. Returning the first response would hide a client
    // bug that is about to lose an adjustment.
    const conflicting = await runIdempotency({
      headers: { 'idempotency-key': KEY },
      path,
      body: { sku: 'CORK-A5', quantityDelta: -50 },
    });

    expect(conflicting.err).toBeInstanceOf(ConflictError);
    expect((conflicting.err as ConflictError).status).toBe(409);
    expect((conflicting.err as Error).message).toMatch(/different request body/i);
  });

  it('fingerprints the PATH as well as the body, so one key cannot serve two endpoints', async () => {
    const body = { sku: 'CORK-A5', quantityDelta: -5 };

    const first = await runIdempotency({ headers: { 'idempotency-key': KEY }, path: '/v1/admin/inventory/adjustments', body });
    first.res.json({ data: { ok: true } });

    const elsewhere = await runIdempotency({
      headers: { 'idempotency-key': KEY },
      path: '/v1/admin/inventory/reservations',
      body,
    });

    expect(elsewhere.err).toBeInstanceOf(ConflictError);
  });

  it('409s while a first attempt with that key is still in flight', async () => {
    const path = '/v1/admin/inventory/adjustments';
    const body = { sku: 'CORK-A5', quantityDelta: -5 };

    const inFlight = await runIdempotency({ headers: { 'idempotency-key': KEY }, path, body });
    expect(inFlight.passed).toBe(true); // reserved, handler still running

    const second = await runIdempotency({ headers: { 'idempotency-key': KEY }, path, body });
    expect(second.err).toBeInstanceOf(ConflictError);
    expect((second.err as Error).message).toMatch(/still being processed/i);
  });

  it('releases the key when the handler failed, so a corrected retry is allowed', async () => {
    const path = '/v1/admin/inventory/adjustments';
    const body = { sku: 'CORK-A5', quantityDelta: -500 };

    const first = await runIdempotency({ headers: { 'idempotency-key': KEY }, path, body });
    first.res.statusCode = 422; // insufficient_stock
    first.res.json({ code: 'insufficient_stock' });

    // The key must be gone, not holding a 422 forever.
    expect(redis.store.size).toBe(0);
  });
});

/* ------------------------------------------------------- request contracts */

describe('request bodies', () => {
  it('refuses a zero adjustment — the ledger CHECK rejects a movement of nothing', () => {
    const base = { sku: 'CORK-A5', warehouseId: '9f8b2c1a-7d3e-4f5a-9b6c-2e1d4a7f8c30', reason: 'stocktake' };
    expect(adjustmentBody.safeParse({ ...base, quantityDelta: 5 }).success).toBe(true);
    expect(adjustmentBody.safeParse({ ...base, quantityDelta: -5 }).success).toBe(true);
    expect(adjustmentBody.safeParse({ ...base, quantityDelta: 0 }).success).toBe(false);
    // Quantities are whole units. Half a diary is not a stock level.
    expect(adjustmentBody.safeParse({ ...base, quantityDelta: 2.5 }).success).toBe(false);
  });

  it('requires a stated reason — an adjustment with none is indistinguishable from an error', () => {
    const base = { sku: 'CORK-A5', warehouseId: '9f8b2c1a-7d3e-4f5a-9b6c-2e1d4a7f8c30', quantityDelta: -1 };
    expect(adjustmentBody.safeParse(base).success).toBe(false);
    expect(adjustmentBody.safeParse({ ...base, reason: 'ok' }).success).toBe(false);
    expect(adjustmentBody.safeParse({ ...base, reason: 'damaged in transit' }).success).toBe(true);
  });

  it('defaults the movement type to `adjustment`', () => {
    const parsed = adjustmentBody.parse({
      sku: 'CORK-A5',
      warehouseId: '9f8b2c1a-7d3e-4f5a-9b6c-2e1d4a7f8c30',
      quantityDelta: -1,
      reason: 'damaged in transit',
    });
    expect(parsed.movementType).toBe('adjustment');
  });

  it('keeps paired movement types off the manual adjustment endpoint', () => {
    // Each of these writes two coordinated rows, or needs an approval. Half a
    // transfer invents or destroys stock.
    for (const forbidden of ['transfer_in', 'transfer_out', 'production', 'raw_material_consumption', 'stock_count']) {
      expect(ADJUSTMENT_MOVEMENT_TYPES).not.toContain(forbidden);
      expect(MOVEMENT_TYPES).toContain(forbidden);
    }
    for (const allowed of ADJUSTMENT_MOVEMENT_TYPES) {
      expect(MOVEMENT_TYPES).toContain(allowed);
    }
  });

  it('carries the five movement types migration 0003 added', () => {
    for (const added of ['production', 'raw_material_consumption', 'stock_count', 'loss', 'found']) {
      expect(MOVEMENT_TYPES).toContain(added);
    }
  });

  it('caps a bulk batch and requires at least one line', () => {
    const line = { sku: 'CORK-A5', warehouseId: '9f8b2c1a-7d3e-4f5a-9b6c-2e1d4a7f8c30', quantityDelta: 1 };
    expect(bulkAdjustBody.safeParse({ reason: 'stocktake', adjustments: [line] }).success).toBe(true);
    expect(bulkAdjustBody.safeParse({ reason: 'stocktake', adjustments: [] }).success).toBe(false);
    expect(
      bulkAdjustBody.safeParse({ reason: 'stocktake', adjustments: Array.from({ length: 201 }, () => line) }).success,
    ).toBe(false);
  });

  it('requires a positive whole quantity on a hold', () => {
    const base = { sku: 'CORK-A5', warehouseId: '9f8b2c1a-7d3e-4f5a-9b6c-2e1d4a7f8c30' };
    expect(reservationBody.safeParse({ ...base, quantity: 3 }).success).toBe(true);
    expect(reservationBody.safeParse({ ...base, quantity: 0 }).success).toBe(false);
    expect(reservationBody.safeParse({ ...base, quantity: -3 }).success).toBe(false);
    expect(reservationBody.safeParse({ ...base, quantity: 1.5 }).success).toBe(false);
  });

  it('requires a supplier on a purchase draft — cost, MOQ and lead time all come from them', () => {
    const warehouseId = '9f8b2c1a-7d3e-4f5a-9b6c-2e1d4a7f8c30';
    expect(purchaseDraftBody.safeParse({ warehouseId }).success).toBe(false);
    expect(purchaseDraftBody.safeParse({ warehouseId, supplierId: warehouseId }).success).toBe(true);
  });

  it('takes a movement id as a decimal STRING, because BIGINT does not fit a JSON number', () => {
    expect(movementIdParam.safeParse({ movementId: '4711' }).success).toBe(true);
    expect(movementIdParam.safeParse({ movementId: '9007199254740993' }).success).toBe(true);
    expect(movementIdParam.safeParse({ movementId: 'movements' }).success).toBe(false);
    expect(movementIdParam.safeParse({ movementId: '-1' }).success).toBe(false);
  });
});

describe('list query compilation', () => {
  it('applies the shared pagination defaults and cap', () => {
    const parsed = inventoryListQuery.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(25);
    expect(inventoryListQuery.safeParse({ perPage: 101 }).success).toBe(false);
    expect(inventoryListQuery.safeParse({ perPage: 100 }).success).toBe(true);
  });

  it('parses a boolean query param literally — `Boolean("false")` is true', () => {
    expect(inventoryListQuery.parse({ belowReorderPoint: 'false' }).belowReorderPoint).toBe(false);
    expect(inventoryListQuery.parse({ belowReorderPoint: 'true' }).belowReorderPoint).toBe(true);
    expect(inventoryListQuery.parse({ belowReorderPoint: '0' }).belowReorderPoint).toBe(false);
    expect(inventoryListQuery.safeParse({ belowReorderPoint: 'yes' }).success).toBe(false);
  });

  it('builds no WHERE at all for an unfiltered page', () => {
    expect(buildInventoryWhere(inventoryListQuery.parse({}))).toBeUndefined();
  });

  it('builds a WHERE for every filter it accepts', () => {
    const where = buildInventoryWhere(
      inventoryListQuery.parse({
        q: 'CORK',
        warehouseId: '9f8b2c1a-7d3e-4f5a-9b6c-2e1d4a7f8c30',
        locationId: '9f8b2c1a-7d3e-4f5a-9b6c-2e1d4a7f8c31',
        kind: 'variant',
        state: 'low',
        belowReorderPoint: 'true',
      }),
    );
    expect(where).toBeDefined();
  });

  it('rejects an unknown stockable kind rather than returning a silently empty page', () => {
    expect(inventoryListQuery.safeParse({ kind: 'hampers' }).success).toBe(false);
    expect(inventoryListQuery.safeParse({ state: 'nearly-out' }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ export */

describe('CSV export', () => {
  const row = {
    id: 'level-1',
    item: { kind: 'variant' as const, id: 'v1', sku: 'CORK-A5', name: 'Cork Diary, "Large"' },
    warehouseId: 'wh-1',
    warehouseCode: 'WH-MUM-AND',
    warehouseName: 'Mumbai Atelier',
    binLocation: 'A/R3, S2',
    locationId: null,
    onHandQty: 40,
    reservedQty: 12,
    availableQty: 28,
    incomingQty: 100,
    reorderPoint: 20,
    reorderQty: 50,
    state: 'in' as const,
    unitCostPaise: 149900,
    stockValuePaise: 5996000,
    lastMovementAt: null,
  };

  it('quotes a field containing a comma, so the columns do not shift', () => {
    const csv = toCsv([row]);
    expect(csv).toContain('"A/R3, S2"');
    expect(csv.split('\r\n')).toHaveLength(2);
  });

  it('doubles an embedded quote, per RFC 4180', () => {
    expect(toCsv([row])).toContain('"Cork Diary, ""Large"""');
  });

  it('keeps money in integer paise rather than making a rounding decision for the reader', () => {
    const csv = toCsv([row]);
    expect(csv).toContain('"149900"');
    expect(csv).not.toContain('1499.00');
  });

  it('writes an empty pair of quotes for a null, not the string "null"', () => {
    const csv = toCsv([{ ...row, binLocation: null, unitCostPaise: null }]);
    expect(csv).not.toContain('null');
  });

  it('emits a header even with no rows, so the file opens as a table', () => {
    expect(toCsv([])).toBe(
      'sku,name,kind,warehouseCode,warehouseName,binLocation,onHandQty,reservedQty,availableQty,incomingQty,' +
        'reorderPoint,reorderQty,state,unitCostPaise,stockValuePaise,lastMovementAt',
    );
  });
});

describe('purchase order numbering', () => {
  it('is scoped by CALENDAR year, unlike the invoice series which GST scopes by financial year', () => {
    expect(purchaseOrderScopeKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026');
    expect(purchaseOrderScopeKey(new Date('2026-04-01T00:00:00Z'))).toBe('2026');
    expect(purchaseOrderScopeKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026');
    expect(purchaseOrderScopeKey(new Date('2027-01-01T00:00:00Z'))).toBe('2027');
  });
});
