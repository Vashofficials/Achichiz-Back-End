import { describe, expect, it } from 'vitest';
import {
  aggregateDemand,
  allocateDemand,
  assertAllocationBalances,
  buildProcurementPlan,
  type SupplierTerms,
  type WarehousePosition,
} from './admin-bulk-orders.planning.js';

/**
 * Bulk-order planning — pure, so tested exhaustively without a database.
 *
 * The invariant these tests exist for is §88: the per-warehouse allocations must
 * sum to exactly the reserved total. A campaign whose allocations sum to 799
 * against a reservation of 800 has one recipient nobody will ever ship to, and
 * every individual number in that plan looks reasonable. Nothing downstream
 * catches it — which is why it is checked here, on the happy path as well as the
 * failing one.
 */

const VARIANT = {
  hamper: '11111111-1111-4111-8111-111111111111',
  candle: '22222222-2222-4222-8222-222222222222',
} as const;

const LEVEL = {
  mumbai: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  delhi: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  bangalore: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

const position = (
  inventoryLevelId: string,
  warehouseName: string,
  availableQty: number,
): WarehousePosition => ({
  inventoryLevelId,
  warehouseId: `wh-${warehouseName}`,
  warehouseName,
  availableQty,
});

/* ================================================================== demand */

describe('aggregateDemand', () => {
  it('collapses recipients wanting the same gift into one line', () => {
    // 800 recipients wanting the same hamper is one line of 800, not 800 lines.
    const recipients = Array.from({ length: 800 }, (_, i) => ({
      id: `r${i}`,
      variantId: VARIANT.hamper,
    }));
    const demand = aggregateDemand(recipients);
    expect(demand.lines).toHaveLength(1);
    expect(demand.lines[0]?.quantity).toBe(800);
    expect(demand.lines[0]?.recipientCount).toBe(800);
    expect(demand.totalUnits).toBe(800);
  });

  it('keeps distinct gifts as distinct lines', () => {
    const demand = aggregateDemand([
      { id: 'r1', variantId: VARIANT.hamper },
      { id: 'r2', variantId: VARIANT.candle },
      { id: 'r3', variantId: VARIANT.hamper },
    ]);
    expect(demand.lines).toHaveLength(2);
    expect(demand.totalUnits).toBe(3);
  });

  it('reports recipients with no gift instead of silently dropping them', () => {
    // A quiet total of 757 is the one that ships 43 empty boxes.
    const demand = aggregateDemand([
      { id: 'r1', variantId: VARIANT.hamper },
      { id: 'r2', variantId: null },
      { id: 'r3', variantId: null },
    ]);
    expect(demand.totalUnits).toBe(1);
    expect(demand.unassignedRecipientCount).toBe(2);
    expect(demand.unassignedRecipientIds).toEqual(['r2', 'r3']);
  });

  it('is deterministic — a plan that reorders its own lines is a plan nobody trusts', () => {
    const a = aggregateDemand([
      { id: 'r1', variantId: VARIANT.hamper },
      { id: 'r2', variantId: VARIANT.candle },
    ]);
    const b = aggregateDemand([
      { id: 'r2', variantId: VARIANT.candle },
      { id: 'r1', variantId: VARIANT.hamper },
    ]);
    expect(a.lines.map((l) => l.variantId)).toEqual(b.lines.map((l) => l.variantId));
  });

  it('honours an explicit per-recipient quantity', () => {
    const demand = aggregateDemand([{ id: 'r1', variantId: VARIANT.hamper, quantity: 12 }]);
    expect(demand.lines[0]?.quantity).toBe(12);
    expect(demand.lines[0]?.recipientCount).toBe(1);
  });

  it('is empty for an empty recipient list', () => {
    const demand = aggregateDemand([]);
    expect(demand.lines).toEqual([]);
    expect(demand.totalUnits).toBe(0);
  });
});

/* ============================================================== allocation */

describe('allocateDemand', () => {
  it('covers demand from a single warehouse when one is enough', () => {
    const result = allocateDemand(VARIANT.hamper, 100, [
      position(LEVEL.mumbai, 'Mumbai', 500),
      position(LEVEL.delhi, 'Delhi', 500),
    ]);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocatedQty).toBe(100);
    expect(result.shortageQty).toBe(0);
  });

  it('draws from the largest warehouse first, minimising the number of sites', () => {
    // Splitting 800 units across four sites when two would do doubles the
    // dispatch work for no gain.
    const result = allocateDemand(VARIANT.hamper, 700, [
      position(LEVEL.mumbai, 'Mumbai', 100),
      position(LEVEL.delhi, 'Delhi', 600),
      position(LEVEL.bangalore, 'Bangalore', 300),
    ]);
    expect(result.allocations).toHaveLength(2);
    const byLevel = new Map(result.allocations.map((a) => [a.inventoryLevelId, a.quantity]));
    expect(byLevel.get(LEVEL.delhi)).toBe(600);
    expect(byLevel.get(LEVEL.bangalore)).toBe(100);
    expect(byLevel.has(LEVEL.mumbai)).toBe(false);
  });

  it('returns allocations in ascending level id — the lock order', () => {
    const result = allocateDemand(VARIANT.hamper, 900, [
      position(LEVEL.bangalore, 'Bangalore', 300),
      position(LEVEL.mumbai, 'Mumbai', 400),
      position(LEVEL.delhi, 'Delhi', 500),
    ]);
    const ids = result.allocations.map((a) => a.inventoryLevelId);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('reports the shortfall rather than over-allocating', () => {
    const result = allocateDemand(VARIANT.hamper, 1_000, [
      position(LEVEL.mumbai, 'Mumbai', 300),
      position(LEVEL.delhi, 'Delhi', 200),
    ]);
    expect(result.allocatedQty).toBe(500);
    expect(result.shortageQty).toBe(500);
  });

  it('never takes more than a warehouse holds', () => {
    const result = allocateDemand(VARIANT.hamper, 1_000, [position(LEVEL.mumbai, 'Mumbai', 7)]);
    expect(result.allocations[0]?.quantity).toBe(7);
  });

  it('skips warehouses with nothing, rather than emitting a zero row', () => {
    const result = allocateDemand(VARIANT.hamper, 50, [
      position(LEVEL.mumbai, 'Mumbai', 0),
      position(LEVEL.delhi, 'Delhi', 100),
    ]);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations.every((a) => a.quantity > 0)).toBe(true);
  });

  it('allocates nothing when there is no stock anywhere', () => {
    const result = allocateDemand(VARIANT.hamper, 100, [position(LEVEL.mumbai, 'Mumbai', 0)]);
    expect(result.allocations).toEqual([]);
    expect(result.allocatedQty).toBe(0);
    expect(result.shortageQty).toBe(100);
  });

  it('allocates nothing when there are no warehouses at all', () => {
    const result = allocateDemand(VARIANT.hamper, 100, []);
    expect(result.shortageQty).toBe(100);
  });

  it('is deterministic when two warehouses hold the same quantity', () => {
    const positions = [position(LEVEL.delhi, 'Delhi', 100), position(LEVEL.mumbai, 'Mumbai', 100)];
    const a = allocateDemand(VARIANT.hamper, 100, positions);
    const b = allocateDemand(VARIANT.hamper, 100, [...positions].reverse());
    expect(a.allocations).toEqual(b.allocations);
  });
});

/* ============================================================ §88 balance */

describe('assertAllocationBalances — §88', () => {
  it('passes on a full allocation', () => {
    const result = allocateDemand(VARIANT.hamper, 800, [
      position(LEVEL.mumbai, 'Mumbai', 500),
      position(LEVEL.delhi, 'Delhi', 500),
    ]);
    expect(() => assertAllocationBalances(result)).not.toThrow();
    expect(result.allocations.reduce((s, a) => s + a.quantity, 0)).toBe(800);
  });

  it('passes on a partial allocation, where allocated + short = required', () => {
    const result = allocateDemand(VARIANT.hamper, 800, [position(LEVEL.mumbai, 'Mumbai', 500)]);
    expect(() => assertAllocationBalances(result)).not.toThrow();
    expect(result.allocatedQty + result.shortageQty).toBe(result.requiredQty);
  });

  it('passes when nothing is allocated at all', () => {
    expect(() => assertAllocationBalances(allocateDemand(VARIANT.hamper, 800, []))).not.toThrow();
  });

  it('catches rows that do not sum to the stated total — the 799-of-800 bug', () => {
    const broken = allocateDemand(VARIANT.hamper, 800, [position(LEVEL.mumbai, 'Mumbai', 800)]);
    broken.allocations[0]!.quantity = 799;
    expect(() => assertAllocationBalances(broken)).toThrowError(/does not balance/i);
  });

  it('catches over-allocation', () => {
    const broken = allocateDemand(VARIANT.hamper, 800, [position(LEVEL.mumbai, 'Mumbai', 800)]);
    broken.allocations[0]!.quantity = 900;
    broken.allocatedQty = 900;
    expect(() => assertAllocationBalances(broken)).toThrowError(/over-allocates/i);
  });

  it('catches units lost between allocated and short', () => {
    const broken = allocateDemand(VARIANT.hamper, 800, [position(LEVEL.mumbai, 'Mumbai', 500)]);
    broken.shortageQty = 0; // was 300
    expect(() => assertAllocationBalances(broken)).toThrowError(/loses units/i);
  });

  it('catches a zero-quantity row', () => {
    const broken = allocateDemand(VARIANT.hamper, 800, [position(LEVEL.mumbai, 'Mumbai', 800)]);
    broken.allocations.push({
      inventoryLevelId: LEVEL.delhi,
      warehouseId: 'wh-Delhi',
      warehouseName: 'Delhi',
      quantity: 0,
    });
    expect(() => assertAllocationBalances(broken)).toThrow();
  });

  it('holds across a sweep of demands and stock splits', () => {
    for (const required of [0, 1, 7, 99, 100, 101, 1_000]) {
      for (const stocks of [[0], [50], [50, 50], [33, 33, 34], [1, 1_000]]) {
        const positions = stocks.map((qty, i) =>
          position(`0000${i}`.slice(-5), `W${i}`, qty),
        );
        const result = allocateDemand(VARIANT.hamper, required, positions);
        expect(() => assertAllocationBalances(result)).not.toThrow();
        expect(result.allocatedQty + result.shortageQty).toBe(required);
      }
    }
  });
});

/* =========================================================== procurement */

describe('buildProcurementPlan', () => {
  const terms = (overrides: Partial<SupplierTerms> = {}): SupplierTerms => ({
    supplierId: 'sup-1',
    supplierName: 'Wax & Co',
    moq: 1,
    leadTimeDays: 10,
    unitCostPaise: 20_000,
    ...overrides,
  });

  it('rounds the order up to the supplier MOQ', () => {
    // A supplier who will not ship fewer than 50 makes an order for 12 into 50.
    const plan = buildProcurementPlan(
      [{ variantId: VARIANT.hamper, shortageQty: 12 }],
      new Map([[VARIANT.hamper, terms({ moq: 50 })]]),
    );
    expect(plan.lines[0]?.orderQty).toBe(50);
    expect(plan.lines[0]?.shortageQty).toBe(12);
  });

  it('leaves a shortfall that is already a multiple of the MOQ alone', () => {
    const plan = buildProcurementPlan(
      [{ variantId: VARIANT.hamper, shortageQty: 100 }],
      new Map([[VARIANT.hamper, terms({ moq: 50 })]]),
    );
    expect(plan.lines[0]?.orderQty).toBe(100);
  });

  it('drops lines with no shortfall', () => {
    const plan = buildProcurementPlan(
      [
        { variantId: VARIANT.hamper, shortageQty: 0 },
        { variantId: VARIANT.candle, shortageQty: 5 },
      ],
      new Map([[VARIANT.candle, terms()]]),
    );
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]?.variantId).toBe(VARIANT.candle);
  });

  it('costs the ORDER quantity, not the shortfall', () => {
    // Rounding up to the MOQ means paying for the MOQ.
    const plan = buildProcurementPlan(
      [{ variantId: VARIANT.hamper, shortageQty: 12 }],
      new Map([[VARIANT.hamper, terms({ moq: 50, unitCostPaise: 20_000 })]]),
    );
    expect(plan.lines[0]?.estimatedCostPaise).toBe(50 * 20_000);
  });

  it('returns a null total when ANY line lacks a cost', () => {
    // A total that silently omits the three most expensive items is worse than
    // no total at all.
    const plan = buildProcurementPlan(
      [
        { variantId: VARIANT.hamper, shortageQty: 5 },
        { variantId: VARIANT.candle, shortageQty: 5 },
      ],
      new Map([
        [VARIANT.hamper, terms()],
        [VARIANT.candle, terms({ unitCostPaise: null })],
      ]),
    );
    expect(plan.estimatedTotalPaise).toBeNull();
  });

  it('totals when every line has a cost', () => {
    const plan = buildProcurementPlan(
      [
        { variantId: VARIANT.hamper, shortageQty: 5 },
        { variantId: VARIANT.candle, shortageQty: 5 },
      ],
      new Map([
        [VARIANT.hamper, terms({ unitCostPaise: 1_000 })],
        [VARIANT.candle, terms({ unitCostPaise: 2_000 })],
      ]),
    );
    expect(plan.estimatedTotalPaise).toBe(5 * 1_000 + 5 * 2_000);
  });

  it('handles a variant nobody supplies', () => {
    const plan = buildProcurementPlan([{ variantId: VARIANT.hamper, shortageQty: 5 }], new Map());
    expect(plan.lines[0]?.supplierId).toBeNull();
    expect(plan.lines[0]?.orderQty).toBe(5); // MOQ defaults to 1
    expect(plan.estimatedTotalPaise).toBeNull();
  });

  it('counts back from the window to an order-by date', () => {
    const plan = buildProcurementPlan(
      [{ variantId: VARIANT.hamper, shortageQty: 5 }],
      new Map([[VARIANT.hamper, terms({ leadTimeDays: 10 })]]),
      { windowStartOn: '2026-11-01', today: new Date('2026-10-01T00:00:00.000Z') },
    );
    expect(plan.lines[0]?.orderByDate).toBe('2026-10-22');
    expect(plan.lines[0]?.meetsWindow).toBe(true);
  });

  it('says a line is late rather than softening it', () => {
    // Ordering today still misses the window. The decision this drives belongs
    // to a human and needs the real number.
    const plan = buildProcurementPlan(
      [{ variantId: VARIANT.hamper, shortageQty: 5 }],
      new Map([[VARIANT.hamper, terms({ leadTimeDays: 60 })]]),
      { windowStartOn: '2026-11-01', today: new Date('2026-10-01T00:00:00.000Z') },
    );
    expect(plan.lines[0]?.meetsWindow).toBe(false);
    expect(plan.lateLineCount).toBe(1);
  });

  it('treats an unknown lead time as unknown, not as zero days', () => {
    // Assuming zero would mark every unquoted item as comfortably on time.
    const plan = buildProcurementPlan(
      [{ variantId: VARIANT.hamper, shortageQty: 5 }],
      new Map([[VARIANT.hamper, terms({ leadTimeDays: null })]]),
      { windowStartOn: '2026-11-01', today: new Date('2026-10-01T00:00:00.000Z') },
    );
    expect(plan.lines[0]?.leadTimeDays).toBeNull();
    expect(plan.lines[0]?.orderByDate).toBeNull();
    expect(plan.longestLeadTimeDays).toBeNull();
  });

  it('has nothing to be late against without a window', () => {
    const plan = buildProcurementPlan(
      [{ variantId: VARIANT.hamper, shortageQty: 5 }],
      new Map([[VARIANT.hamper, terms({ leadTimeDays: 90 })]]),
      { windowStartOn: null },
    );
    expect(plan.lines[0]?.meetsWindow).toBe(true);
    expect(plan.lateLineCount).toBe(0);
  });

  it('reports the critical path across lines', () => {
    const plan = buildProcurementPlan(
      [
        { variantId: VARIANT.hamper, shortageQty: 5 },
        { variantId: VARIANT.candle, shortageQty: 5 },
      ],
      new Map([
        [VARIANT.hamper, terms({ leadTimeDays: 10 })],
        [VARIANT.candle, terms({ leadTimeDays: 45 })],
      ]),
    );
    expect(plan.longestLeadTimeDays).toBe(45);
  });

  it('is empty and costs nothing when there is no shortfall', () => {
    const plan = buildProcurementPlan([], new Map());
    expect(plan.lines).toEqual([]);
    expect(plan.totalOrderQty).toBe(0);
    expect(plan.estimatedTotalPaise).toBe(0);
  });
});
