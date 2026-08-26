import { describe, expect, it } from 'vitest';
import {
  MAX_BOM_DEPTH,
  ceilTo,
  componentKey,
  directRequirements,
  explodeBom,
  parseComponentKey,
  roundRequirement,
  withWaste,
  type BomComponent,
  type BomGraph,
  type ComponentKey,
} from './admin-production.bom.js';
import {
  PRODUCTION_ACTIONS,
  PRODUCTION_TRANSITIONS,
  assertOutputWithinPlan,
  assertProductionAction,
  isProductionEditable,
  productionEdgesFrom,
  type ProductionAction,
} from './admin-production.state.js';
import { PRODUCTION_STATUSES, type ProductionStatus } from '../../db/schema/index.js';

/**
 * BOM explosion and the production state machine — both pure, so both are tested
 * exhaustively without a database.
 *
 * The explosion is where quiet wrongness lives. Every one of these cases is a way
 * the obvious implementation is wrong by a number nobody notices until a batch
 * comes up short: a diamond that overwrites instead of summing, waste applied
 * once instead of per level, a ceiling that chases IEEE 754 dust, a cycle that
 * hangs the request instead of failing it.
 */

const VARIANT = {
  hamper: '11111111-1111-4111-8111-111111111111',
  candle: '22222222-2222-4222-8222-222222222222',
  giftBox: '33333333-3333-4333-8333-333333333333',
} as const;

const ITEM = {
  wax: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  wick: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ribbon: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

const v = (id: string): ComponentKey => componentKey('variant', id);
const h = (id: string): ComponentKey => componentKey('hamper_item', id);

const line = (
  key: ComponentKey,
  quantity: number,
  wastePct = 0,
  unit: BomComponent['unit'] = 'piece',
): BomComponent => ({ key, quantity, wastePct, unit });

const graphOf = (entries: [ComponentKey, BomComponent[]][]): BomGraph => new Map(entries);

/* ============================================================== arithmetic */

describe('withWaste — the uplift formula, not the yield formula', () => {
  it('adds the waste percentage to the input', () => {
    expect(withWaste(100, 5)).toBeCloseTo(105, 10);
  });

  it('is NOT quantity / (1 - pct/100)', () => {
    // The yield reading of the same number gives 105.263…. Picking it would
    // silently change every purchase quantity in the system, so it is pinned.
    expect(withWaste(100, 5)).not.toBeCloseTo(100 / 0.95, 3);
  });

  it('is the identity at zero waste', () => {
    expect(withWaste(42, 0)).toBe(42);
  });
});

describe('ceilTo — rounds up without chasing float dust', () => {
  it('does not demand a milligram that does not exist', () => {
    // 100 × 1.05 is 105.00000000000001 in IEEE 754. A naive ceil at three
    // decimals turns that into 105.001 on every line, forever.
    expect(ceilTo(100 * 1.05, 3)).toBe(105);
  });

  it('still rounds a real fraction up', () => {
    expect(ceilTo(104.7001, 3)).toBe(104.701);
    expect(ceilTo(2.0001, 3)).toBe(2.001);
  });

  it('rounds to whole units at zero decimals', () => {
    expect(ceilTo(2.1, 0)).toBe(3);
    expect(ceilTo(2, 0)).toBe(2);
  });
});

describe('roundRequirement — pieces are whole, measures are not', () => {
  it('rounds a piece up to a whole unit, because on_hand_qty is an INTEGER', () => {
    expect(roundRequirement(2.1, 'piece')).toBe(3);
    expect(roundRequirement(2.0, 'piece')).toBe(2);
  });

  it('keeps three decimals for continuous units', () => {
    expect(roundRequirement(105.2504, 'gram')).toBe(105.251);
    expect(roundRequirement(1.5, 'litre')).toBe(1.5);
  });

  it('never rounds DOWN — a shortage of the size nobody notices', () => {
    for (const raw of [0.0001, 1.4999, 99.9999]) {
      expect(roundRequirement(raw, 'gram')).toBeGreaterThanOrEqual(raw);
      expect(roundRequirement(raw, 'piece')).toBeGreaterThanOrEqual(raw);
    }
  });
});

describe('component keys', () => {
  it('round-trips', () => {
    expect(parseComponentKey(v(VARIANT.candle))).toEqual({ kind: 'variant', id: VARIANT.candle });
    expect(parseComponentKey(h(ITEM.wax))).toEqual({ kind: 'hamper_item', id: ITEM.wax });
  });

  it('keeps the two id spaces apart when they collide', () => {
    // The same uuid can legitimately be a variant and a hamper item. A bare id
    // as the accumulator key would add their quantities together.
    expect(v(VARIANT.candle)).not.toBe(h(VARIANT.candle));
  });
});

/* =============================================================== explosion */

describe('explodeBom — flat', () => {
  const graph = graphOf([[v(VARIANT.candle), [line(h(ITEM.wax), 100, 0, 'gram'), line(h(ITEM.wick), 1)]]]);

  it('multiplies by the build quantity', () => {
    const result = explodeBom(v(VARIANT.candle), 10, graph);
    const wax = result.leaves.find((l) => l.key === h(ITEM.wax));
    expect(wax?.requiredQty).toBe(1000);
  });

  it('reports raw materials as leaves and nothing as a sub-assembly', () => {
    const result = explodeBom(v(VARIANT.candle), 1, graph);
    expect(result.leaves).toHaveLength(2);
    expect(result.subAssemblies).toHaveLength(0);
  });

  it('returns nothing for a root that makes nothing', () => {
    const result = explodeBom(v(VARIANT.hamper), 5, graph);
    expect(result.leaves).toHaveLength(0);
    expect(result.nodeCount).toBe(0);
  });
});

describe('explodeBom — waste compounds per level', () => {
  // A hamper needs 1 candle at 5% waste; a candle needs 100 g of wax at 5%.
  const graph = graphOf([
    [v(VARIANT.hamper), [line(v(VARIANT.candle), 1, 5)]],
    [v(VARIANT.candle), [line(h(ITEM.wax), 100, 5, 'gram')]],
  ]);

  it('asks for 110.25 g, not 105 g', () => {
    // 5% of the wax is lost making the candle AND 5% of the candles are lost
    // making the hamper. Applying waste once at the end gives 105 — a 5%
    // shortfall on every batch.
    const result = explodeBom(v(VARIANT.hamper), 1, graph);
    const wax = result.leaves.find((l) => l.key === h(ITEM.wax));
    expect(wax?.rawQty).toBeCloseTo(110.25, 6);
    expect(wax?.requiredQty).toBe(110.25);
  });

  it('records the candle as a sub-assembly, not a pick line', () => {
    const result = explodeBom(v(VARIANT.hamper), 1, graph);
    expect(result.leaves.map((l) => l.key)).toEqual([h(ITEM.wax)]);
    expect(result.subAssemblies.map((l) => l.key)).toEqual([v(VARIANT.candle)]);
  });

  it('reports the depth it reached', () => {
    expect(explodeBom(v(VARIANT.hamper), 1, graph).maxDepth).toBe(2);
  });
});

describe('explodeBom — a diamond SUMS', () => {
  //        hamper
  //        /     \
  //     candle   gift box
  //        \     /
  //         ribbon      ← reached by two paths
  const graph = graphOf([
    [v(VARIANT.hamper), [line(v(VARIANT.candle), 1), line(v(VARIANT.giftBox), 1)]],
    [v(VARIANT.candle), [line(h(ITEM.ribbon), 2)]],
    [v(VARIANT.giftBox), [line(h(ITEM.ribbon), 3)]],
  ]);

  it('adds both paths instead of keeping the last one', () => {
    // A global `visited` set — the obvious way to stop a cycle — would skip the
    // second visit and under-order the ribbon.
    const result = explodeBom(v(VARIANT.hamper), 1, graph);
    const ribbon = result.leaves.find((l) => l.key === h(ITEM.ribbon));
    expect(ribbon?.requiredQty).toBe(5);
  });

  it('names both routes, so the number is explicable', () => {
    const result = explodeBom(v(VARIANT.hamper), 1, graph);
    const ribbon = result.leaves.find((l) => l.key === h(ITEM.ribbon));
    expect(ribbon?.paths).toHaveLength(2);
  });

  it('rounds ONCE after summing, not per path', () => {
    // Two paths of 0.4 pieces each. Rounded per path that is 1 + 1 = 2; rounded
    // once after summing it is ceil(0.8) = 1.
    const fractional = graphOf([
      [v(VARIANT.hamper), [line(v(VARIANT.candle), 1), line(v(VARIANT.giftBox), 1)]],
      [v(VARIANT.candle), [line(h(ITEM.ribbon), 0.4)]],
      [v(VARIANT.giftBox), [line(h(ITEM.ribbon), 0.4)]],
    ]);
    const ribbon = explodeBom(v(VARIANT.hamper), 1, fractional).leaves.find(
      (l) => l.key === h(ITEM.ribbon),
    );
    expect(ribbon?.requiredQty).toBe(1);
  });
});

describe('explodeBom — termination', () => {
  it('refuses a two-hop cycle rather than recursing forever', () => {
    // The database CHECK blocks only the DIRECT case. Nothing in it can see this.
    const cyclic = graphOf([
      [v(VARIANT.hamper), [line(v(VARIANT.candle), 1)]],
      [v(VARIANT.candle), [line(v(VARIANT.hamper), 1)]],
    ]);
    expect(() => explodeBom(v(VARIANT.hamper), 1, cyclic)).toThrowError(/contains itself/i);
  });

  it('names the actual loop in the error', () => {
    const cyclic = graphOf([
      [v(VARIANT.hamper), [line(v(VARIANT.candle), 1)]],
      [v(VARIANT.candle), [line(v(VARIANT.hamper), 1)]],
    ]);
    expect(() => explodeBom(v(VARIANT.hamper), 1, cyclic)).toThrowError(
      new RegExp(`${VARIANT.hamper}.*${VARIANT.candle}.*${VARIANT.hamper}`, 's'),
    );
  });

  it('stops on depth even if the cycle check were wrong', () => {
    // A legal, acyclic, absurdly deep chain: each level is a distinct key.
    const chain: [ComponentKey, BomComponent[]][] = [];
    for (let i = 0; i < MAX_BOM_DEPTH + 2; i += 1) {
      chain.push([v(`0000${i}`.slice(-5)), [line(v(`0000${i + 1}`.slice(-5)), 1)]]);
    }
    expect(() => explodeBom(v('00000'), 1, graphOf(chain))).toThrowError(/levels deep/i);
  });

  it('refuses to add two requirements measured in different units', () => {
    const conflicting = graphOf([
      [v(VARIANT.hamper), [line(v(VARIANT.candle), 1), line(v(VARIANT.giftBox), 1)]],
      [v(VARIANT.candle), [line(h(ITEM.wax), 1, 0, 'gram')]],
      [v(VARIANT.giftBox), [line(h(ITEM.wax), 1, 0, 'kg')]],
    ]);
    expect(() => explodeBom(v(VARIANT.hamper), 1, conflicting)).toThrowError(/unit/i);
  });
});

describe('directRequirements — one level, no recursion', () => {
  const graph = graphOf([
    [v(VARIANT.hamper), [line(v(VARIANT.candle), 2, 5)]],
    [v(VARIANT.candle), [line(h(ITEM.wax), 100, 0, 'gram')]],
  ]);

  it('stops at the immediate components', () => {
    const lines = directRequirements(v(VARIANT.hamper), 1, graph);
    expect(lines.map((l) => l.key)).toEqual([v(VARIANT.candle)]);
  });

  it('still applies waste — it just has nothing to compound into', () => {
    const lines = directRequirements(v(VARIANT.hamper), 10, graph);
    expect(lines[0]?.requiredQty).toBe(21); // 2 × 1.05 × 10 = 21
  });

  it('merges two lines naming the same component', () => {
    const duplicated = graphOf([
      [v(VARIANT.hamper), [line(h(ITEM.ribbon), 1), line(h(ITEM.ribbon), 2)]],
    ]);
    const lines = directRequirements(v(VARIANT.hamper), 1, duplicated);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.requiredQty).toBe(3);
  });

  it('returns nothing for a root with no recipe', () => {
    expect(directRequirements(v(ITEM.wax), 1, graph)).toEqual([]);
  });
});

/* =========================================================== state machine */

describe('production state machine', () => {
  it('covers exactly the statuses the database CHECK allows', () => {
    expect(Object.keys(PRODUCTION_TRANSITIONS).sort()).toEqual([...PRODUCTION_STATUSES].sort());
  });

  it('never targets a status outside that vocabulary', () => {
    for (const edges of Object.values(PRODUCTION_TRANSITIONS)) {
      for (const e of edges) expect(PRODUCTION_STATUSES).toContain(e.to);
    }
  });

  it('walks draft → planned → in_progress → completed', () => {
    expect(assertProductionAction('draft', 'plan').to).toBe('planned');
    expect(assertProductionAction('planned', 'start').to).toBe('in_progress');
    expect(assertProductionAction('in_progress', 'complete').to).toBe('completed');
  });

  it('marks complete as the ONLY stock-moving edge', () => {
    // Everything about cancellation depends on this: nothing has moved before
    // completion, which is why cancelling needs no compensating movement.
    const moving: string[] = [];
    for (const [from, edges] of Object.entries(PRODUCTION_TRANSITIONS)) {
      for (const e of edges) if (e.movesStock) moving.push(`${from}:${e.action}`);
    }
    expect(moving).toEqual(['in_progress:complete']);
  });

  it('allows cancel from every non-terminal status', () => {
    for (const from of ['draft', 'planned', 'in_progress'] as ProductionStatus[]) {
      expect(assertProductionAction(from, 'cancel').to).toBe('cancelled');
    }
  });

  it('refuses to complete a run nobody started, and says how to start it', () => {
    expect(() => assertProductionAction('planned', 'complete')).toThrowError(/not been started/i);
    expect(() => assertProductionAction('draft', 'complete')).toThrowError(/not been started/i);
  });

  it('refuses to restart a completed run — it would consume the components twice', () => {
    expect(() => assertProductionAction('completed', 'start')).toThrowError(/already completed/i);
  });

  it('treats completed and cancelled as terminal', () => {
    for (const terminal of ['completed', 'cancelled'] as ProductionStatus[]) {
      expect(productionEdgesFrom(terminal)).toHaveLength(0);
    }
  });

  it('rejects every transition not in the table — exhaustive sweep', () => {
    const legal = new Set<string>();
    for (const [from, edges] of Object.entries(PRODUCTION_TRANSITIONS)) {
      for (const e of edges) legal.add(`${from}:${e.action}`);
    }
    for (const from of PRODUCTION_STATUSES) {
      for (const action of PRODUCTION_ACTIONS as readonly ProductionAction[]) {
        if (legal.has(`${from}:${action}`)) continue;
        expect(() => assertProductionAction(from, action)).toThrow();
      }
    }
  });

  it('allows edits only before anything is committed to the floor', () => {
    expect(isProductionEditable('draft')).toBe(true);
    expect(isProductionEditable('planned')).toBe(true);
    for (const s of ['in_progress', 'completed', 'cancelled'] as ProductionStatus[]) {
      expect(isProductionEditable(s)).toBe(false);
    }
  });
});

describe('assertOutputWithinPlan', () => {
  it('accepts a run that came out exactly as planned', () => {
    expect(() => assertOutputWithinPlan(100, 100, 0)).not.toThrow();
  });

  it('accepts a short run — that is what scrap records', () => {
    expect(() => assertOutputWithinPlan(100, 90, 10)).not.toThrow();
    expect(() => assertOutputWithinPlan(100, 80, 5)).not.toThrow();
  });

  it('accepts a batch that failed entirely', () => {
    expect(() => assertOutputWithinPlan(100, 0, 100)).not.toThrow();
  });

  it('refuses more output than the plan sized components for', () => {
    expect(() => assertOutputWithinPlan(100, 101, 0)).toThrowError(/cannot yield more/i);
    expect(() => assertOutputWithinPlan(100, 100, 1)).toThrowError(/cannot yield more/i);
  });

  it('refuses negative quantities', () => {
    expect(() => assertOutputWithinPlan(100, -1, 0)).toThrow();
    expect(() => assertOutputWithinPlan(100, 10, -1)).toThrow();
  });
});

describe('component consumption is proportional to what was STARTED', () => {
  /**
   * The rule the completion transaction applies, restated here so a change to it
   * has to be deliberate: components are charged against produced + scrapped, not
   * produced alone. Scrapped units burned their materials too.
   */
  const consumed = (plannedQty: number, planned: number, produced: number, scrapped: number): number =>
    Math.ceil(planned * ((produced + scrapped) / plannedQty) * 1000) / 1000;

  it('charges the full plan when everything came out good', () => {
    expect(consumed(100, 500, 100, 0)).toBe(500);
  });

  it('charges for scrapped units as well as good ones', () => {
    // 90 good + 10 scrapped is 100 units started — the whole 500 g was used.
    expect(consumed(100, 500, 90, 10)).toBe(500);
  });

  it('charges nothing when nothing was started', () => {
    expect(consumed(100, 500, 0, 0)).toBe(0);
  });

  it('charges proportionally on a part-finished run', () => {
    expect(consumed(100, 500, 40, 10)).toBe(250);
  });

  it('does NOT undercharge by ignoring scrap', () => {
    // The bug this guards: charging produced-only would bill 450 g for a run
    // that consumed 500 g, overstating both stock and margin.
    expect(consumed(100, 500, 90, 10)).toBeGreaterThan(
      Math.ceil(500 * (90 / 100) * 1000) / 1000,
    );
  });
});
