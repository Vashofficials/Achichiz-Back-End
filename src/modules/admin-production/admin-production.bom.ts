/**
 * BOM explosion — pure arithmetic, no database, no HTTP.
 *
 * A bill of materials is a TREE, not a list. A hamper contains a candle; the
 * candle is itself made of wax and a wick. Answering "what do I have to take off
 * the shelf to build 40 of these" means walking that tree to the things nobody
 * manufactures — the raw materials — and summing what arrives there.
 *
 * Four properties this file is responsible for, each of which is a way the
 * naive version is wrong:
 *
 * ## 1. Recursion terminates, always
 *
 * A BOM that contains itself — directly (`A` needs `A`) or transitively
 * (`A` needs `B`, `B` needs `A`) — recurses forever. The database blocks only
 * the direct case (`CHECK bom_no_self_reference`); nothing in it can see a
 * two-hop cycle, and nothing will until somebody's console hangs.
 *
 * So the walk carries the CURRENT PATH and refuses to re-enter a node already on
 * it, with the stable code `bom_cycle_detected` and the actual cycle in the
 * message. `MAX_BOM_DEPTH` is a second, independent guard: if the cycle check
 * were ever wrong, depth still stops it. A visit budget is the third, for the
 * shape that is finite but absurd.
 *
 * The path is a STACK, not a global visited set. That distinction is the whole
 * of property 2.
 *
 * ## 2. A diamond SUMS, it does not overwrite
 *
 * ```
 *        hamper
 *        /     \
 *     candle   gift box
 *        \     /
 *         ribbon        ← reached by two paths
 * ```
 *
 * Ribbon is needed by both branches and the answer is the SUM. A global
 * `visited` set — the obvious way to stop a cycle — would skip the second visit
 * and under-order the ribbon by half. A per-path stack lets a node be reached
 * any number of times through different routes while still refusing to reach it
 * through ITSELF.
 *
 * ## 3. Waste compounds, per level
 *
 * ```
 *   effectiveQty = quantity × (1 + wastePct / 100)
 * ```
 *
 * 100 g of wax at 5% waste is 105 g. Applied ONCE at the end, a candle at 5%
 * made of wax at 5% would ask for 105 g; applied per level, as it physically
 * happens, it asks for 110.25 g — you lose 5% of the wax making the candle and
 * 5% of the candles making the hamper. The multiplier is therefore carried DOWN
 * the recursion rather than reapplied at the bottom, and the arithmetic lives in
 * exactly one function (`withWaste`) so the two callers cannot disagree.
 *
 * ## 4. Rounding happens once, at the leaf, UPWARD
 *
 * Intermediate quantities stay exact. Only the final per-material total is
 * rounded, and always up: you cannot buy 104.7 g of wax and expect the batch to
 * come out. Rounding down would produce a shortage of exactly the size nobody
 * notices until the last unit fails.
 *
 * `piece` rounds up to a WHOLE unit — 2.1 bottles means you need 3 — because
 * `inventory_levels.on_hand_qty` is an INTEGER and half a bottle is not a thing
 * the ledger can express. Continuous units round up to three decimals, which is
 * the precision `production_order_lines.planned_qty NUMERIC(12,3)` actually holds.
 */

import { UnprocessableError } from '../../lib/errors.js';
import type { Uom } from '../../db/schema/index.js';

/** Second guard behind the cycle check. Ten levels is far deeper than any real gift hamper. */
export const MAX_BOM_DEPTH = 10;

/** Third guard: finite but absurd. A legitimate BOM does not visit five thousand nodes. */
export const MAX_BOM_NODES = 5_000;

export type ComponentKind = 'variant' | 'hamper_item';

/**
 * `variant:<uuid>` / `hamper_item:<uuid>`.
 *
 * The graph is polymorphic — a component is a manufacturable variant or a loose
 * hamper item — and a bare uuid would let the two id spaces collide in the
 * accumulator. Prefixing makes the key total.
 */
export type ComponentKey = `${ComponentKind}:${string}`;

export const componentKey = (kind: ComponentKind, id: string): ComponentKey => `${kind}:${id}`;

export function parseComponentKey(key: ComponentKey): { kind: ComponentKind; id: string } {
  const index = key.indexOf(':');
  return {
    kind: key.slice(0, index) as ComponentKind,
    id: key.slice(index + 1),
  };
}

/** One BOM line, normalised: what goes into ONE unit of its parent. */
export type BomComponent = {
  key: ComponentKey;
  /** Per ONE unit of the parent output. `product_bom_lines.quantity`, always > 0. */
  quantity: number;
  /** `product_bom_lines.waste_pct`. 0 ≤ pct < 100, enforced by a CHECK. */
  wastePct: number;
  unit: Uom;
};

/** Output key → what it is made of. A key absent from the map is a raw material. */
export type BomGraph = ReadonlyMap<ComponentKey, readonly BomComponent[]>;

export type ExplodedLine = {
  key: ComponentKey;
  kind: ComponentKind;
  id: string;
  unit: Uom;
  /** Exact, waste-compounded, summed over every path. Not rounded. */
  rawQty: number;
  /** `rawQty` rounded UP — whole units for `piece`, three decimals otherwise. */
  requiredQty: number;
  /** The deepest level at which this component was reached. */
  depth: number;
  /** How it was reached. More than one entry is a diamond, and the quantities were summed. */
  paths: string[];
};

export type BomExplosion = {
  root: ComponentKey;
  /** Units of the root being built. */
  quantity: number;
  /** Raw materials — nothing in the graph makes these. This is the pick list. */
  leaves: ExplodedLine[];
  /** Components that are themselves manufactured. Informational: they were exploded, not picked. */
  subAssemblies: ExplodedLine[];
  maxDepth: number;
  /** Nodes visited. Compare against `MAX_BOM_NODES` when a BOM feels slow. */
  nodeCount: number;
};

/* ---------------------------------------------------------------- arithmetic */

/**
 * THE waste formula. One function, one place, called once per level.
 *
 * `effectiveQty = quantity × (1 + wastePct / 100)`
 *
 * 100 g at 5% is 105 g. It is deliberately NOT `quantity / (1 - pct/100)` (the
 * yield formula, 105.26 g) — `waste_pct` is defined by the migration as an
 * uplift on the input, and picking the other reading silently changes every
 * purchase quantity in the system.
 */
export function withWaste(quantity: number, wastePct: number): number {
  return quantity * (1 + wastePct / 100);
}

/**
 * Ceiling at a fixed number of decimals, with the binary-float dust removed first.
 *
 * `100 × 1.05` is `105.00000000000001` in IEEE 754. A naive `Math.ceil(x * 1000)`
 * turns that into 105.001 g — demanding a milligram of wax that does not exist,
 * on every line, forever. The value is snapped to microscopic precision before
 * the ceiling so that only a REAL fraction rounds up.
 */
export function ceilTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const dedusted = Math.round(scaled * 1e6) / 1e6;
  return Math.ceil(dedusted) / factor;
}

/**
 * Round a finished requirement UP.
 *
 * `piece` goes to a whole unit: `inventory_levels.on_hand_qty` is INTEGER, and
 * 2.1 bottles is 3 bottles at the shelf. Everything else goes to three decimals,
 * the precision `production_order_lines.planned_qty NUMERIC(12,3)` holds.
 */
export function roundRequirement(quantity: number, unit: Uom): number {
  return ceilTo(quantity, unit === 'piece' ? 0 : 3);
}

/* ----------------------------------------------------------------- failures */

function cycleError(path: readonly ComponentKey[], repeated: ComponentKey): never {
  const start = path.indexOf(repeated);
  const loop = [...path.slice(start === -1 ? 0 : start), repeated].join(' → ');
  throw new UnprocessableError(
    `This bill of materials contains itself: ${loop}. Exploding it would never terminate, so nothing ` +
      'was computed. Break the loop by removing one of those component lines — a component cannot be ' +
      'made of something that is made of it.',
    'bom_cycle_detected',
    { context: { cycle: loop, path: [...path], repeated } },
  );
}

function depthError(path: readonly ComponentKey[], maxDepth: number): never {
  throw new UnprocessableError(
    `This bill of materials nests more than ${maxDepth} levels deep (${path.join(' → ')}). That is far ` +
      'past anything this catalogue builds, so the walk stopped rather than kept going. If it is ' +
      'genuinely that deep, flatten the intermediate assemblies.',
    'bom_depth_exceeded',
    { context: { maxDepth, path: [...path] } },
  );
}

function sizeError(nodeCount: number): never {
  throw new UnprocessableError(
    `This bill of materials expands to more than ${nodeCount} component visits. It is finite but not ` +
      'something anyone assembles; the explosion was abandoned rather than left to run.',
    'bom_too_large',
    { context: { limit: MAX_BOM_NODES } },
  );
}

function unitConflictError(key: ComponentKey, first: Uom, second: Uom): never {
  throw new UnprocessableError(
    `Component ${key} is required in \`${first}\` on one path and \`${second}\` on another. Unit ` +
      'conversion is deliberately not modelled — a BOM line and the stock it draws from must already ' +
      'agree — so these two requirements cannot be added together. Fix the units on the BOM lines.',
    'bom_unit_conflict',
    { context: { key, units: [first, second] } },
  );
}

/* ---------------------------------------------------------------- explosion */

type Accumulator = {
  key: ComponentKey;
  unit: Uom;
  rawQty: number;
  depth: number;
  paths: string[];
};

/**
 * Explode a BOM depth-first to its raw materials.
 *
 * Depth-first rather than breadth-first because the guard that matters is the
 * PATH, and a depth-first walk has the path in hand at every step.
 *
 * @param root     What is being built.
 * @param quantity How many units of it. Multiplies everything below.
 * @param graph    Output key → its component lines. A key not present is a leaf.
 */
export function explodeBom(
  root: ComponentKey,
  quantity: number,
  graph: BomGraph,
  options?: { maxDepth?: number },
): BomExplosion {
  const maxDepth = options?.maxDepth ?? MAX_BOM_DEPTH;

  const leaves = new Map<ComponentKey, Accumulator>();
  const subAssemblies = new Map<ComponentKey, Accumulator>();
  let nodeCount = 0;
  let maxSeenDepth = 0;

  const accumulate = (
    into: Map<ComponentKey, Accumulator>,
    line: BomComponent,
    qty: number,
    depth: number,
    path: string,
  ): void => {
    const existing = into.get(line.key);
    if (!existing) {
      into.set(line.key, { key: line.key, unit: line.unit, rawQty: qty, depth, paths: [path] });
      return;
    }
    // The diamond case. SUM — see property 2 in the header.
    if (existing.unit !== line.unit) unitConflictError(line.key, existing.unit, line.unit);
    existing.rawQty += qty;
    existing.depth = Math.max(existing.depth, depth);
    if (!existing.paths.includes(path)) existing.paths.push(path);
  };

  const walk = (key: ComponentKey, multiplier: number, depth: number, path: ComponentKey[]): void => {
    if (depth >= maxDepth) depthError([...path], maxDepth);

    const lines = graph.get(key);
    if (!lines || lines.length === 0) return;

    for (const line of lines) {
      nodeCount += 1;
      if (nodeCount > MAX_BOM_NODES) sizeError(MAX_BOM_NODES);

      // The cycle guard. Checked against the CURRENT PATH, so a diamond is
      // allowed through and only a genuine loop is refused.
      if (path.includes(line.key)) cycleError(path, line.key);

      // Waste is applied HERE, at this level, and the result becomes the
      // multiplier for everything beneath it. That is what makes it compound.
      const effective = withWaste(line.quantity, line.wastePct) * multiplier;
      const childDepth = depth + 1;
      maxSeenDepth = Math.max(maxSeenDepth, childDepth);

      const childLines = graph.get(line.key);
      const isManufactured = childLines !== undefined && childLines.length > 0;
      const pathLabel = [...path, line.key].join(' → ');

      if (isManufactured) {
        accumulate(subAssemblies, line, effective, childDepth, pathLabel);
        walk(line.key, effective, childDepth, [...path, line.key]);
      } else {
        accumulate(leaves, line, effective, childDepth, pathLabel);
      }
    }
  };

  walk(root, quantity, 0, [root]);

  const finish = (accumulators: Iterable<Accumulator>): ExplodedLine[] =>
    [...accumulators]
      .map((a) => {
        const { kind, id } = parseComponentKey(a.key);
        return {
          key: a.key,
          kind,
          id,
          unit: a.unit,
          rawQty: a.rawQty,
          // Rounded ONCE, here, after every path has been summed into `rawQty`.
          // Rounding per path would round the same material up several times.
          requiredQty: roundRequirement(a.rawQty, a.unit),
          depth: a.depth,
          paths: a.paths,
        };
      })
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    root,
    quantity,
    leaves: finish(leaves.values()),
    subAssemblies: finish(subAssemblies.values()),
    maxDepth: maxSeenDepth,
    nodeCount,
  };
}

/**
 * The direct components of one output — one level, no recursion.
 *
 * What a production run consumes when the sub-assemblies are things the
 * warehouse actually stocks, rather than things it makes in the same batch.
 * Waste still applies; it simply does not compound, because there is nothing
 * below to compound into.
 */
export function directRequirements(
  root: ComponentKey,
  quantity: number,
  graph: BomGraph,
): ExplodedLine[] {
  const lines = graph.get(root) ?? [];
  const merged = new Map<ComponentKey, Accumulator>();

  for (const line of lines) {
    const qty = withWaste(line.quantity, line.wastePct) * quantity;
    const existing = merged.get(line.key);
    if (!existing) {
      merged.set(line.key, { key: line.key, unit: line.unit, rawQty: qty, depth: 1, paths: [line.key] });
      continue;
    }
    if (existing.unit !== line.unit) unitConflictError(line.key, existing.unit, line.unit);
    existing.rawQty += qty;
  }

  return [...merged.values()]
    .map((a) => {
      const { kind, id } = parseComponentKey(a.key);
      return {
        key: a.key,
        kind,
        id,
        unit: a.unit,
        rawQty: a.rawQty,
        requiredQty: roundRequirement(a.rawQty, a.unit),
        depth: 1,
        paths: a.paths,
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
