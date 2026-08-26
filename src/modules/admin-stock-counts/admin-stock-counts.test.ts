import { describe, expect, it } from 'vitest';
import {
  COUNT_ACTIONS,
  COUNT_TRANSITIONS,
  assertCountAcceptsItems,
  assertCountAction,
  assertVarianceApplies,
  countBalanceAfter,
  countEdgesFrom,
  countTotals,
  isCountOpen,
  postableVariances,
  varianceOf,
  type CountAction,
  type CountLine,
} from './admin-stock-counts.state.js';
import { STOCK_COUNT_STATUSES, type StockCountStatus } from '../../db/schema/index.js';

/**
 * Stock-count state and variance arithmetic — pure, so tested exhaustively.
 *
 * The subtle piece is the difference between "counted zero" and "not counted".
 * `stock_count_items.variance_qty` is a GENERATED column computing
 * `COALESCE(counted_qty, 0) - system_qty`, which for an UNCOUNTED row evaluates
 * to `-system_qty` — a full write-off of a shelf nobody walked. `varianceOf`
 * returns null there instead, and every caller has to deal with it. If that ever
 * stops being true, the first symptom is an approved count that zeroes out an
 * aisle the counter ran out of time for.
 */

const LEVEL = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: '33333333-3333-4333-8333-333333333333',
} as const;

const line = (inventoryLevelId: string, systemQty: number, countedQty: number | null): CountLine => ({
  inventoryLevelId,
  systemQty,
  countedQty,
});

const asAction = (s: string): CountAction => s as CountAction;

/* =========================================================== state machine */

describe('stock-count state machine', () => {
  it('covers exactly the statuses the database CHECK allows', () => {
    expect(Object.keys(COUNT_TRANSITIONS).sort()).toEqual([...STOCK_COUNT_STATUSES].sort());
  });

  it('never targets a status outside that vocabulary', () => {
    for (const edges of Object.values(COUNT_TRANSITIONS)) {
      for (const e of edges) expect(STOCK_COUNT_STATUSES).toContain(e.to);
    }
  });

  it('walks draft -> in_progress -> completed -> approved', () => {
    expect(assertCountAction('draft', 'start').to).toBe('in_progress');
    expect(assertCountAction('in_progress', 'complete').to).toBe('completed');
    expect(assertCountAction('completed', 'approve').to).toBe('approved');
  });

  it('marks approve as the ONLY stock-moving edge', () => {
    // Counting is not adjusting. Nothing reaches the ledger until an approver
    // has seen the variance — which is the entire point of the four states.
    const moving: string[] = [];
    for (const [from, edges] of Object.entries(COUNT_TRANSITIONS)) {
      for (const e of edges) if (e.movesStock) moving.push(`${from}:${e.action}`);
    }
    expect(moving).toEqual(['completed:approve']);
  });

  it('refuses to approve a sheet still being filled in, and says what to do', () => {
    expect(() => assertCountAction('in_progress', 'approve')).toThrowError(/still being counted/i);
  });

  it('refuses to approve twice — the variance is already in the ledger', () => {
    expect(() => assertCountAction('approved', 'approve')).toThrowError(/already been approved/i);
  });

  it('treats approved and cancelled as terminal', () => {
    for (const terminal of ['approved', 'cancelled'] as StockCountStatus[]) {
      expect(countEdgesFrom(terminal)).toHaveLength(0);
    }
  });

  it('rejects every transition not in the table — exhaustive sweep', () => {
    const legal = new Set<string>();
    for (const [from, edges] of Object.entries(COUNT_TRANSITIONS)) {
      for (const e of edges) legal.add(`${from}:${e.action}`);
    }
    for (const from of STOCK_COUNT_STATUSES) {
      for (const action of COUNT_ACTIONS) {
        if (legal.has(`${from}:${action}`)) continue;
        expect(() => assertCountAction(from, asAction(action))).toThrow();
      }
    }
  });
});

describe('when a sheet accepts counted quantities', () => {
  it('accepts them only while in progress', () => {
    expect(isCountOpen('in_progress')).toBe(true);
    for (const s of ['draft', 'completed', 'approved', 'cancelled'] as StockCountStatus[]) {
      expect(isCountOpen(s)).toBe(false);
    }
  });

  it('does not throw for an open sheet', () => {
    expect(() => assertCountAcceptsItems('in_progress')).not.toThrow();
  });

  it('tells a draft to start first, because start is what freezes systemQty', () => {
    // A counted quantity with nothing to compare it against is not a count.
    expect(() => assertCountAcceptsItems('draft')).toThrowError(/start it first/i);
  });

  it('refuses edits after completion and after approval, with different remedies', () => {
    expect(() => assertCountAcceptsItems('completed')).toThrowError(/complete/i);
    expect(() => assertCountAcceptsItems('approved')).toThrowError(/approved/i);
    expect(() => assertCountAcceptsItems('cancelled')).toThrow();
  });
});

/* ================================================================ variance */

describe('varianceOf — counted zero is not uncounted', () => {
  it('is counted minus system', () => {
    expect(varianceOf(line(LEVEL.a, 100, 95))).toBe(-5);
    expect(varianceOf(line(LEVEL.a, 100, 105))).toBe(5);
    expect(varianceOf(line(LEVEL.a, 100, 100))).toBe(0);
  });

  it('is null for a row nobody has counted', () => {
    expect(varianceOf(line(LEVEL.a, 100, null))).toBeNull();
  });

  it('is NOT the generated column, which would write off the whole level', () => {
    // The DB column computes COALESCE(counted, 0) - system = -100 here. Treating
    // that as a variance would zero out a shelf the counter never reached.
    const uncounted = line(LEVEL.a, 100, null);
    expect(varianceOf(uncounted)).not.toBe(-100);
    expect(varianceOf(uncounted)).toBeNull();
  });

  it('distinguishes a genuine zero count from an uncounted row', () => {
    // An empty shelf IS a finding: -100. Nobody having looked is not.
    expect(varianceOf(line(LEVEL.a, 100, 0))).toBe(-100);
    expect(varianceOf(line(LEVEL.a, 100, null))).toBeNull();
  });
});

describe('postableVariances', () => {
  it('skips uncounted rows entirely', () => {
    const result = postableVariances([line(LEVEL.a, 100, null), line(LEVEL.b, 50, 45)]);
    expect(result.map((r) => r.inventoryLevelId)).toEqual([LEVEL.b]);
  });

  it('skips rows counted exactly right — a movement of nothing is not a movement', () => {
    const result = postableVariances([line(LEVEL.a, 100, 100), line(LEVEL.b, 50, 45)]);
    expect(result).toHaveLength(1);
  });

  it('returns rows in ascending inventoryLevelId — the deadlock protocol', () => {
    // The same ascending-id lock ordering the bulk adjustment and checkout use.
    // Two of them contending for the same levels must queue, not deadlock.
    const result = postableVariances([
      line(LEVEL.c, 10, 5),
      line(LEVEL.a, 10, 5),
      line(LEVEL.b, 10, 5),
    ]);
    expect(result.map((r) => r.inventoryLevelId)).toEqual([LEVEL.a, LEVEL.b, LEVEL.c]);
  });

  it('carries the variance alongside each line', () => {
    const result = postableVariances([line(LEVEL.a, 100, 93)]);
    expect(result[0]?.varianceQty).toBe(-7);
  });

  it('is empty when nothing was counted', () => {
    expect(postableVariances([line(LEVEL.a, 10, null), line(LEVEL.b, 20, null)])).toEqual([]);
  });
});

describe('countTotals — two figures, because one would mislead', () => {
  const lines = [
    line(LEVEL.a, 100, 105), // +5
    line(LEVEL.b, 100, 95), // -5
    line(LEVEL.c, 100, null), // uncounted
  ];

  it('counts only the rows somebody actually counted', () => {
    const totals = countTotals(lines);
    expect(totals.itemsInScope).toBe(3);
    expect(totals.itemsCounted).toBe(2);
    expect(totals.itemsUncounted).toBe(1);
  });

  it('nets +5 and -5 to zero', () => {
    expect(countTotals(lines).netVarianceQty).toBe(0);
  });

  it('reports 10 units of absolute error at the same time', () => {
    // A shelf where five units went missing and five appeared elsewhere is not
    // an accurate warehouse. Net alone would call it perfect.
    expect(countTotals(lines).absVarianceQty).toBe(10);
  });

  it('counts a row counted exactly right as counted, but not as varying', () => {
    const totals = countTotals([line(LEVEL.a, 100, 100)]);
    expect(totals.itemsCounted).toBe(1);
    expect(totals.itemsWithVariance).toBe(0);
  });

  it('handles an empty sheet without dividing by anything', () => {
    expect(countTotals([])).toEqual({
      itemsInScope: 0,
      itemsCounted: 0,
      itemsUncounted: 0,
      itemsWithVariance: 0,
      netVarianceQty: 0,
      absVarianceQty: 0,
    });
  });

  it('agrees with postableVariances about how many rows will move', () => {
    expect(countTotals(lines).itemsWithVariance).toBe(postableVariances(lines).length);
  });
});

/* ==================================================== the negative-stock rule */

describe('assertVarianceApplies — a shortfall may not eat reserved units', () => {
  it('allows a positive variance regardless of reservations', () => {
    expect(() =>
      assertVarianceApplies({ onHandQty: 10, reservedQty: 10 }, 5, 'SKU-1'),
    ).not.toThrow();
  });

  it('allows a shortfall that fits inside the sellable balance', () => {
    // 100 on hand, 20 reserved, 80 sellable. A count of 30 short is fine.
    expect(() =>
      assertVarianceApplies({ onHandQty: 100, reservedQty: 20 }, -30, 'SKU-1'),
    ).not.toThrow();
  });

  it('allows a shortfall that lands exactly on the reserved floor', () => {
    expect(() =>
      assertVarianceApplies({ onHandQty: 100, reservedQty: 20 }, -80, 'SKU-1'),
    ).not.toThrow();
  });

  it('refuses one unit past that floor', () => {
    // Absorbing a reserved unit turns somebody's confirmed order into a stockout
    // at picking time, and the count would have "fixed" a number by breaking a
    // delivery.
    expect(() => assertVarianceApplies({ onHandQty: 100, reservedQty: 20 }, -81, 'SKU-1')).toThrow();
  });

  it('measures against sellable, not on-hand', () => {
    // On-hand alone would permit -100 here. It must not.
    expect(() => assertVarianceApplies({ onHandQty: 100, reservedQty: 20 }, -100, 'SKU-1')).toThrow();
  });

  it('names the SKU and the three numbers in the message', () => {
    expect(() => assertVarianceApplies({ onHandQty: 100, reservedQty: 20 }, -90, 'ACH-CAN-001'))
      .toThrowError(/ACH-CAN-001/);
    expect(() => assertVarianceApplies({ onHandQty: 100, reservedQty: 20 }, -90, 'ACH-CAN-001'))
      .toThrowError(/100 on hand/);
  });

  it('refuses everything when the whole balance is reserved', () => {
    expect(() => assertVarianceApplies({ onHandQty: 10, reservedQty: 10 }, -1, 'SKU-1')).toThrow();
  });
});

describe('countBalanceAfter', () => {
  it('is the on-hand balance the movement row must carry', () => {
    // Shared with the rest of the stock primitives rather than reimplemented:
    // `balance_after` has to mean the same thing on a count row as on every
    // other row, or a ledger replay stops reconciling.
    expect(countBalanceAfter({ onHandQty: 100, reservedQty: 20 }, -5)).toBe(95);
    expect(countBalanceAfter({ onHandQty: 100, reservedQty: 20 }, 5)).toBe(105);
  });

  it('is computed from the row as it was BEFORE the update', () => {
    expect(countBalanceAfter({ onHandQty: 100, reservedQty: 0 }, 0)).toBe(100);
  });
});
