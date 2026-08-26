import { db, type Tx } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import * as repo from './admin-production.repository.js';
import {
  componentKey,
  directRequirements,
  explodeBom,
  parseComponentKey,
  type BomGraph,
  type ComponentKey,
  type ExplodedLine,
} from './admin-production.bom.js';
import {
  assertOutputWithinPlan,
  assertProductionAction,
  isProductionEditable,
  productionEdgesFrom,
} from './admin-production.state.js';
import type { BomLineRow, StockableRef } from './admin-production.repository.js';
import type {
  BomArchiveResponse,
  BomDetail,
  BomExplosionQuery,
  BomExplosionResponse,
  BomListQuery,
  BomSummary,
  CancelProductionOrderBody,
  CompleteProductionOrderBody,
  CreateBomBody,
  CreateProductionOrderBody,
  ProductionDetail,
  ProductionListQuery,
  ProductionSummary,
  UpdateBomBody,
} from './admin-production.schemas.js';
import type { Uom } from '../../db/schema/index.js';

/**
 * BOM and production.
 *
 * Two responsibilities that share one idea: a finished good is not a number
 * somebody types, it is the sum of what went into it. The BOM says what that is;
 * production is the transaction that actually converts one into the other.
 *
 * The only genuinely dangerous operation here is `complete`. It consumes real
 * components and creates real finished stock, and a half-applied completion is
 * unrecoverable — you cannot tell afterwards which components were taken. So it
 * is one transaction, locked in a deterministic order, and it rolls back whole.
 *
 * Every exported function returns the shape declared in `.schemas.ts`, annotated
 * with the schema's inferred type. The response schema is documentation, not a
 * runtime filter — the compiler is what keeps the published contract honest.
 */

/* ------------------------------------------------------------ bom graph */

const keyOfBomLine = (line: BomLineRow): ComponentKey =>
  line.componentVariantId
    ? componentKey('variant', line.componentVariantId)
    : componentKey('hamper_item', line.hamperItemId ?? '');

type ComponentLabel = { sku: string | null; name: string | null };

/** The graph plus a key → sku/name index, because `explodeBom` deals only in keys. */
type LoadedBom = { graph: BomGraph; labels: ReadonlyMap<ComponentKey, ComponentLabel> };

/**
 * Load the BOM graph, following sub-assemblies breadth-first.
 *
 * The graph is loaded LEVEL BY LEVEL rather than per-node: a hamper with twelve
 * components that each have a BOM is one query per level, not twelve. `seen`
 * stops a cyclic graph from looping here as well — `explodeBom` detects the
 * cycle and reports it properly, but there is no reason to fetch forever first.
 */
async function loadBomGraph(rootVariantIds: readonly string[]): Promise<LoadedBom> {
  const graph = new Map<ComponentKey, BomComponentRow[]>();
  const labels = new Map<ComponentKey, ComponentLabel>();
  const seen = new Set<string>();
  let frontier = [...new Set(rootVariantIds)];

  for (let depth = 0; frontier.length > 0 && depth < 12; depth++) {
    const pending = frontier.filter((id) => !seen.has(id));
    pending.forEach((id) => seen.add(id));
    if (pending.length === 0) break;

    const lines = await repo.findBomLinesForOutputs(pending);
    const next = new Set<string>();

    for (const line of lines) {
      const outKey = componentKey('variant', line.outputVariantId);
      const key = keyOfBomLine(line);
      const bucket = graph.get(outKey) ?? [];
      bucket.push({
        key,
        quantity: line.quantity,
        wastePct: line.wastePct,
        unit: line.unit,
      });
      graph.set(outKey, bucket);
      labels.set(key, { sku: line.sku, name: line.name });
      // Only a variant can itself be manufactured; a hamper item is a leaf here.
      if (line.componentVariantId) next.add(line.componentVariantId);
    }

    frontier = [...next];
  }

  return { graph, labels };
}

type BomComponentRow = {
  key: ComponentKey;
  quantity: number;
  wastePct: number;
  unit: Uom;
};

/* ---------------------------------------------------------------- BOMs */

export async function listBoms(query: BomListQuery): Promise<{ rows: BomSummary[]; total: number }> {
  const { field, direction } = parseSort(query.sort, ['sku', 'lineCount', 'version'], {
    field: 'sku',
    direction: 'asc',
  });
  const where = repo.bomFilters(query);
  const [rows, total] = await Promise.all([
    repo.listBomOutputs(
      where,
      repo.bomOutputOrderBy(field, direction),
      query.perPage,
      offsetOf(query.page, query.perPage),
    ),
    repo.countBomOutputs(where),
  ]);

  return {
    rows: rows.map((r) => ({
      // `bomId` and `outputVariantId` are deliberately the same value: there is no
      // BOM header table, so a BOM *is* its output. Both names are published so
      // the console can address it either way without a lookup table.
      bomId: r.outputVariantId,
      outputVariantId: r.outputVariantId,
      outputSku: r.outputSku,
      outputName: r.outputName,
      version: r.version,
      lineCount: r.lineCount,
      hasWaste: r.hasWaste,
      hasSubAssemblies: r.hasSubAssemblies,
    })),
    total,
  };
}

export async function getBom(outputVariantId: string): Promise<BomDetail> {
  const variant = await repo.findVariant(outputVariantId);
  if (!variant) throw new NotFoundError('Product variant', outputVariantId);
  return buildBomDetail(outputVariantId, variant);
}

export async function createBom(input: CreateBomBody): Promise<BomDetail> {
  const variant = await repo.findVariant(input.outputVariantId);
  if (!variant) throw new NotFoundError('Product variant', input.outputVariantId);

  const existing = await repo.findBomLines(input.outputVariantId);
  if (existing.length > 0) {
    throw new ConflictError(
      `${variant.sku} already has a bill of materials. PATCH it instead — replacing it silently would ` +
        'discard a recipe that production orders may already have been costed against.',
    );
  }

  await assertComponentsExist(input.lines);
  assertNoSelfReference(input.outputVariantId, input.lines);

  await db.transaction(async (tx) => {
    await repo.insertBomLines(tx, input.outputVariantId, input.version, input.lines.map(toNewBomLine));
  });

  return buildBomDetail(input.outputVariantId, variant);
}

export async function updateBom(outputVariantId: string, input: UpdateBomBody): Promise<BomDetail> {
  const variant = await repo.findVariant(outputVariantId);
  if (!variant) throw new NotFoundError('Product variant', outputVariantId);

  const existing = await repo.findBomLines(outputVariantId);
  if (existing.length === 0) throw new NotFoundError('Bill of materials for variant', outputVariantId);

  if (input.lines) {
    await assertComponentsExist(input.lines);
    assertNoSelfReference(outputVariantId, input.lines);
  }

  await db.transaction(async (tx) => {
    await repo.lockBomLines(tx, outputVariantId);

    if (input.lines) {
      // Replace wholesale rather than diffing. A BOM is a recipe: half of the old
      // one merged with half of the new one is a recipe nobody wrote.
      const version = input.version ?? (existing[0]?.version ?? 1) + 1;
      await repo.deleteBomLines(tx, outputVariantId);
      await repo.insertBomLines(tx, outputVariantId, version, input.lines.map(toNewBomLine));
    } else if (input.version !== undefined) {
      await repo.setBomVersion(tx, outputVariantId, input.version);
    }
  });

  return buildBomDetail(outputVariantId, variant);
}

export async function archiveBom(outputVariantId: string): Promise<BomArchiveResponse> {
  const variant = await repo.findVariant(outputVariantId);
  if (!variant) throw new NotFoundError('Product variant', outputVariantId);

  const lines = await repo.findBomLines(outputVariantId);
  if (lines.length === 0) throw new NotFoundError('Bill of materials for variant', outputVariantId);

  const open = await repo.countOpenProductionForOutput(outputVariantId);
  if (open > 0) {
    throw new ConflictError(
      `${variant.sku} has ${open} production order(s) that are not finished. Complete or cancel them ` +
        'before removing the recipe they were planned against.',
    );
  }

  const removed = await db.transaction((tx) => repo.deleteBomLines(tx, outputVariantId));
  return { bomId: outputVariantId, removedLineCount: removed };
}

/* ----------------------------------------------------------- explosion */

export async function explodeBomForOutput(
  outputVariantId: string,
  opts: Pick<BomExplosionQuery, 'quantity' | 'mode'> & { warehouseId?: string | undefined },
): Promise<BomExplosionResponse> {
  const variant = await repo.findVariant(outputVariantId);
  if (!variant) throw new NotFoundError('Product variant', outputVariantId);

  const root = componentKey('variant', outputVariantId);
  const { graph, labels } = await loadBomGraph([outputVariantId]);
  if (!graph.has(root)) throw new NotFoundError('Bill of materials for variant', outputVariantId);

  const direct = opts.mode === 'direct';
  // explodeBom throws `bom_cycle_detected` / `bom_depth_exceeded` / `bom_too_large`.
  const explosion = direct ? undefined : explodeBom(root, opts.quantity, graph);
  const leaves = explosion ? explosion.leaves : directRequirements(root, opts.quantity, graph);
  const subAssemblies = explosion ? explosion.subAssemblies : [];

  // One availability lookup for both lists, so a sub-assembly that is also stocked
  // reports the same number in both places.
  const availability = await availabilityMap([...leaves, ...subAssemblies], opts.warehouseId);
  const decorate = (line: ExplodedLine) => toExplosionLine(line, labels, availability);
  const decoratedLeaves = leaves.map(decorate);

  return {
    bomId: outputVariantId,
    outputSku: variant.sku,
    quantity: opts.quantity,
    mode: direct ? 'direct' : 'full',
    warehouseId: opts.warehouseId ?? null,
    maxDepth: explosion ? explosion.maxDepth : leaves.length > 0 ? 1 : 0,
    nodeCount: explosion ? explosion.nodeCount : leaves.length,
    // Only the LEAVES decide buildability. A sub-assembly short at the shelf is
    // not a blocker — it is exploded into its own components, which is exactly
    // what the leaf list already accounts for.
    canBuild: availability ? decoratedLeaves.every((l) => (l.shortageQty ?? 0) === 0) : null,
    leaves: decoratedLeaves,
    subAssemblies: subAssemblies.map(decorate),
  };
}

/** `null` when no warehouse was named — the caller reads that as "not asked". */
async function availabilityMap(
  lines: readonly ExplodedLine[],
  warehouseId?: string,
): Promise<Map<ComponentKey, number> | null> {
  if (!warehouseId) return null;
  if (lines.length === 0) return new Map();

  const rows = await repo.availabilityFor(warehouseId, lines.map(refOf));
  const map = new Map<ComponentKey, number>();
  for (const row of rows) {
    const key = row.variantId
      ? componentKey('variant', row.variantId)
      : row.hamperItemId
        ? componentKey('hamper_item', row.hamperItemId)
        : undefined;
    if (key) map.set(key, row.availableQty);
  }
  return map;
}

function toExplosionLine(
  line: ExplodedLine,
  labels: ReadonlyMap<ComponentKey, ComponentLabel>,
  availability: Map<ComponentKey, number> | null,
) {
  const label = labels.get(line.key);
  // Absent from the map means no inventory level exists at that warehouse, which
  // is zero stock — not missing data. Reporting null would let a component nobody
  // has ever stocked pass a "can we build this" check.
  const available = availability ? (availability.get(line.key) ?? 0) : null;

  return {
    componentKind: line.kind,
    componentId: line.id,
    sku: label?.sku ?? null,
    name: label?.name ?? null,
    unit: line.unit,
    rawQty: line.rawQty,
    requiredQty: line.requiredQty,
    depth: line.depth,
    paths: line.paths,
    availableQty: available,
    shortageQty: available === null ? null : Math.max(0, line.requiredQty - available),
  };
}

const refOf = (line: { key: ComponentKey }): StockableRef => {
  const { kind, id } = parseComponentKey(line.key);
  return {
    variantId: kind === 'variant' ? id : null,
    hamperItemId: kind === 'hamper_item' ? id : null,
    packagingId: null,
  };
};

/* ------------------------------------------------------ production orders */

export async function listProductionOrders(
  query: ProductionListQuery,
): Promise<{ rows: ProductionSummary[]; total: number }> {
  const { field, direction } = parseSort(query.sort, ['createdAt', 'productionNo', 'plannedQty', 'status'], {
    field: 'createdAt',
    direction: 'desc',
  });
  const where = repo.productionFilters(query);
  const [rows, total] = await Promise.all([
    repo.listProductionOrders(
      where,
      repo.productionOrderBy(field, direction),
      query.perPage,
      offsetOf(query.page, query.perPage),
    ),
    repo.countProductionOrders(where),
  ]);

  return { rows: rows.map(toProductionSummary), total };
}

export async function getProductionOrder(productionId: string): Promise<ProductionDetail> {
  return buildProductionDetail(productionId);
}

/**
 * Create a production order and size its component lines from the BOM.
 *
 * Lines are materialised NOW rather than resolved at completion. A recipe that
 * changes between planning and completion must not silently change what a
 * half-built batch consumes — the order records the recipe it was planned against.
 */
export async function createProductionOrder(
  input: CreateProductionOrderBody,
  staffId: string,
): Promise<ProductionDetail> {
  if (!input.outputVariantId && !input.outputHamperItemId) {
    throw new UnprocessableError(
      'A production order needs exactly one output — either `outputVariantId` or `outputHamperItemId`.',
      'production_output_required',
    );
  }
  if (input.outputVariantId && input.outputHamperItemId) {
    throw new UnprocessableError(
      'A production order builds one thing. Pass `outputVariantId` or `outputHamperItemId`, not both.',
      'production_output_ambiguous',
    );
  }

  const warehouse = await repo.findWarehouse(input.warehouseId);
  if (!warehouse) throw new NotFoundError('Warehouse', input.warehouseId);

  // Explicit lines win over the BOM. That is the point of the field: a trial
  // batch or a substitution is a run whose recipe genuinely differs from the
  // standing one, and forcing it through the BOM would mean editing the BOM.
  const planned = input.lines
    ? input.lines.map((l) => ({
        ref: {
          variantId: l.componentVariantId ?? null,
          hamperItemId: l.hamperItemId ?? null,
          packagingId: l.packagingId ?? null,
        },
        plannedQty: l.plannedQty,
        unit: l.unit,
      }))
    : await plannedLinesFromBom(input);

  return db.transaction(async (tx) => {
    const productionNo = await repo.nextProductionNumber(tx, new Date().getUTCFullYear());

    const order = await repo.insertProductionOrder(tx, {
      productionNo,
      warehouseId: input.warehouseId,
      outputVariantId: input.outputVariantId ?? null,
      outputHamperItemId: input.outputHamperItemId ?? null,
      plannedQty: input.plannedQty,
      status: input.status,
      batchNo: input.batchNo ?? null,
      note: input.note ?? null,
      createdBy: staffId,
    });

    // ensureLevel creates the (item, warehouse) row if this component has never
    // been stocked here — otherwise planning a new recipe would 404 on a
    // component the warehouse is about to receive.
    const lineValues = [];
    for (const line of planned) {
      const level = await repo.ensureLevel(tx, input.warehouseId, line.ref);
      lineValues.push({
        productionOrderId: order.id,
        inventoryLevelId: level.id,
        plannedQty: line.plannedQty.toFixed(3),
        consumedQty: '0',
        unit: line.unit,
      });
    }
    await repo.insertProductionLines(tx, lineValues);

    logger.info({ productionId: order.id, productionNo, staffId }, 'production order created');
    return buildProductionDetail(order.id, tx);
  });
}

/** Size the component lines from the output's BOM. Only a variant can carry one. */
async function plannedLinesFromBom(input: CreateProductionOrderBody) {
  if (!input.outputVariantId) {
    // A hamper-item output has no BOM of its own — its recipe is expressed
    // against a variant. Refused rather than silently creating an order with no
    // component lines, which would complete by consuming nothing.
    throw new UnprocessableError(
      'A hamper-item output has no bill of materials of its own, so its components cannot be derived. ' +
        'Supply `lines` explicitly for this run.',
      'bom_not_found',
    );
  }

  const variant = await repo.findVariant(input.outputVariantId);
  if (!variant) throw new NotFoundError('Product variant', input.outputVariantId);

  const root = componentKey('variant', input.outputVariantId);
  const { graph } = await loadBomGraph([input.outputVariantId]);
  if (!graph.has(root)) {
    throw new UnprocessableError(
      `${variant.sku} has no bill of materials, so there is nothing to consume. Create the BOM first, ` +
        'or supply `lines` explicitly for a one-off run.',
      'bom_not_found',
    );
  }

  const lines =
    input.mode === 'direct'
      ? directRequirements(root, input.plannedQty, graph)
      : explodeBom(root, input.plannedQty, graph).leaves;

  return lines.map((l) => ({ ref: refOf(l), plannedQty: l.requiredQty, unit: l.unit }));
}

export async function transitionProductionOrder(
  productionId: string,
  action: 'start' | 'cancel',
  body: CancelProductionOrderBody,
  staffId: string,
): Promise<ProductionDetail> {
  return db.transaction(async (tx) => {
    const order = await repo.lockProductionOrder(tx, productionId);
    if (!order) throw new NotFoundError('Production order', productionId);

    // A draft that is being started takes both edges at once. Both are asserted,
    // so an order that may not be planned still cannot be started — see the note
    // on `plan` in the state file.
    const edges =
      action === 'start' && order.status === 'draft'
        ? [assertProductionAction('draft', 'plan'), assertProductionAction('planned', 'start')]
        : [assertProductionAction(order.status, action)];
    const edge = edges[edges.length - 1]!;

    await repo.updateProductionOrder(tx, productionId, {
      status: edge.to,
      ...(action === 'start' ? { startedAt: new Date() } : {}),
      ...(body.reason ? { note: [order.note, body.reason].filter(Boolean).join('\n') } : {}),
    });

    logger.info({ productionId, from: order.status, to: edge.to, staffId }, 'production order transitioned');
    return buildProductionDetail(productionId, tx);
  });
}

/**
 * Complete a production order — the one transaction that matters.
 *
 * Consume every component, create the finished stock, write both sides of the
 * ledger. All of it or none of it: a half-consumed order cannot be reconstructed
 * afterwards, because nothing records which components were already taken.
 */
export async function completeProductionOrder(
  productionId: string,
  body: CompleteProductionOrderBody,
  staffId: string,
): Promise<ProductionDetail> {
  return db.transaction(async (tx) => {
    const order = await repo.lockProductionOrder(tx, productionId);
    if (!order) throw new NotFoundError('Production order', productionId);

    assertProductionAction(order.status, 'complete');

    const producedQty = body.producedQty ?? order.plannedQty;
    assertOutputWithinPlan(order.plannedQty, producedQty, body.scrappedQty);

    const lines = await repo.findProductionLines(productionId, tx);
    const overrides = new Map((body.lines ?? []).map((l) => [l.inventoryLevelId, l.consumedQty]));
    assertOverridesMatchLines(overrides, lines);

    // Deterministic lock order. Two production orders sharing a component and
    // locking it in different orders is a textbook deadlock; sorting by id means
    // they always contend in the same sequence and one simply waits.
    const ordered = [...lines].sort((a, b) => a.inventoryLevelId.localeCompare(b.inventoryLevelId));
    await repo.lockLevels(tx, ordered.map((l) => l.inventoryLevelId));

    // Components are consumed in proportion to what was STARTED — produced plus
    // scrapped. Scrapped units burned their materials too; charging only for good
    // output would quietly understate cost and overstate stock.
    const startedQty = producedQty + body.scrappedQty;
    const ratio = order.plannedQty > 0 ? startedQty / order.plannedQty : 0;

    for (const line of ordered) {
      const override = overrides.get(line.inventoryLevelId);
      const consume = override ?? Math.ceil(line.plannedQty * ratio * 1000) / 1000;
      if (consume <= 0) continue;

      const balance = await repo.adjustOnHand(tx, line.inventoryLevelId, -consume);
      if (balance === null) {
        throw new UnprocessableError(
          `Not enough ${line.sku ?? 'component'} to complete this run — ${consume} needed, ` +
            `${line.availableQty} sellable. Nothing has been consumed; receive or transfer stock and retry.`,
          'insufficient_stock',
          {
            context: {
              inventoryLevelId: line.inventoryLevelId,
              required: consume,
              onHand: line.onHandQty,
              available: line.availableQty,
            },
          },
        );
      }

      await repo.insertMovement(tx, {
        inventoryLevelId: line.inventoryLevelId,
        movementType: 'raw_material_consumption',
        quantityDelta: -consume,
        balanceAfter: balance,
        referenceType: 'production_order',
        referenceId: productionId,
        referenceLabel: order.productionNo,
        note: `Consumed by ${order.productionNo}`,
        actorId: staffId,
      });

      await repo.setLineConsumed(tx, line.id, consume);
    }

    // Finished goods in. Scrapped units produced nothing, so only `producedQty`
    // lands — which is exactly why scrap is recorded separately.
    if (producedQty > 0) {
      const outLevel = await repo.ensureLevel(tx, order.warehouseId, {
        variantId: order.outputVariantId,
        hamperItemId: order.outputHamperItemId,
        packagingId: null,
      });
      const balance = await repo.adjustOnHand(tx, outLevel.id, producedQty);
      await repo.insertMovement(tx, {
        inventoryLevelId: outLevel.id,
        movementType: 'production',
        quantityDelta: producedQty,
        balanceAfter: balance ?? outLevel.onHandQty + producedQty,
        referenceType: 'production_order',
        referenceId: productionId,
        referenceLabel: order.productionNo,
        note: order.batchNo ? `Batch ${order.batchNo}` : null,
        actorId: staffId,
      });
    }

    await repo.updateProductionOrder(tx, productionId, {
      status: 'completed',
      producedQty,
      scrappedQty: body.scrappedQty,
      completedAt: new Date(),
      ...(body.batchNo !== undefined && body.batchNo !== null ? { batchNo: body.batchNo } : {}),
      ...(body.note ? { note: [order.note, body.note].filter(Boolean).join('\n') } : {}),
    });

    logger.info(
      { productionId, productionNo: order.productionNo, producedQty, scrappedQty: body.scrappedQty, staffId },
      'production order completed',
    );

    return buildProductionDetail(productionId, tx);
  });
}

/* ------------------------------------------------------------- helpers */

type BomInputLine = CreateBomBody['lines'][number];

/**
 * Zod's optional-with-default fields arrive typed as possibly-undefined; the
 * repository's insert wants them settled. One conversion, so the two cannot
 * disagree about what a missing `wastePct` means.
 */
const toNewBomLine = (line: BomInputLine): repo.NewBomLine => ({
  componentVariantId: line.componentVariantId ?? null,
  hamperItemId: line.hamperItemId ?? null,
  quantity: line.quantity,
  wastePct: line.wastePct,
  unit: line.unit,
  isSubstitutable: line.isSubstitutable,
});

/** A BOM whose output is one of its own components would explode forever. */
function assertNoSelfReference(outputVariantId: string, lines: readonly BomInputLine[]): void {
  if (lines.some((l) => l.componentVariantId === outputVariantId)) {
    throw new UnprocessableError(
      'A product cannot be a component of itself. Check the component list — this is usually the wrong ' +
        'variant id pasted twice.',
      'bom_cycle_detected',
      { context: { outputVariantId } },
    );
  }
}

async function assertComponentsExist(lines: readonly BomInputLine[]): Promise<void> {
  const variantIds = lines.map((l) => l.componentVariantId).filter((v): v is string => Boolean(v));
  const hamperIds = lines.map((l) => l.hamperItemId).filter((v): v is string => Boolean(v));

  const [liveVariants, liveHampers] = await Promise.all([
    repo.liveVariantIds(variantIds),
    repo.liveHamperItemIds(hamperIds),
  ]);

  const missing = [
    ...variantIds.filter((id) => !liveVariants.has(id)),
    ...hamperIds.filter((id) => !liveHampers.has(id)),
  ];
  if (missing.length > 0) {
    throw new UnprocessableError(
      `${missing.length} component(s) do not exist or have been archived: ${missing.join(', ')}.`,
      'bom_component_not_found',
      { context: { missing } },
    );
  }
}

/**
 * An override naming a level this order has no line for is a mistake, not a
 * no-op. Silently ignoring it would let a completion report consumption that
 * never happened and still return 200.
 */
function assertOverridesMatchLines(
  overrides: ReadonlyMap<string, number>,
  lines: readonly { inventoryLevelId: string }[],
): void {
  const known = new Set(lines.map((l) => l.inventoryLevelId));
  const unknown = [...overrides.keys()].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new UnprocessableError(
      `${unknown.length} consumption override(s) name a stock level this order has no component line ` +
        `for: ${unknown.join(', ')}. Nothing was consumed.`,
      'production_line_not_found',
      { context: { unknown } },
    );
  }
}

async function buildBomDetail(
  outputVariantId: string,
  variant: repo.VariantRow,
  exec?: Tx,
): Promise<BomDetail> {
  const lines = exec
    ? await repo.findBomLines(outputVariantId, exec)
    : await repo.findBomLines(outputVariantId);
  if (lines.length === 0) throw new NotFoundError('Bill of materials for variant', outputVariantId);

  // One query for the whole line set: which components are themselves manufactured.
  const componentVariantIds = lines
    .map((l) => l.componentVariantId)
    .filter((v): v is string => v !== null);
  const manufactured = await repo.outputsWithBom(componentVariantIds);

  return {
    bomId: outputVariantId,
    outputVariantId,
    outputSku: variant.sku,
    outputName: variant.name,
    version: Math.max(...lines.map((l) => l.version)),
    lineCount: lines.length,
    hasWaste: lines.some((l) => l.wastePct > 0),
    hasSubAssemblies: componentVariantIds.some((id) => manufactured.has(id)),
    lines: lines.map((l) => ({
      id: l.id,
      componentKind: l.componentVariantId ? ('variant' as const) : ('hamper_item' as const),
      componentId: l.componentVariantId ?? l.hamperItemId ?? '',
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      wastePct: l.wastePct,
      // Computed here rather than stored: it is a view of two columns, and a
      // stored copy would go stale the first time either one is edited.
      effectiveQty: l.quantity * (1 + l.wastePct / 100),
      unit: l.unit,
      isSubstitutable: l.isSubstitutable,
      version: l.version,
      hasOwnBom: l.componentVariantId !== null && manufactured.has(l.componentVariantId),
    })),
  };
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toProductionSummary(row: repo.ProductionRow): ProductionSummary {
  return {
    id: row.id,
    productionNo: row.productionNo,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouseName,
    outputKind: row.outputVariantId ? 'variant' : 'hamper_item',
    // `CHECK production_orders_one_output` guarantees exactly one is set, so the
    // fallback is unreachable — it exists because the column types are nullable.
    outputId: row.outputVariantId ?? row.outputHamperItemId ?? '',
    outputSku: row.outputSku,
    outputName: row.outputName,
    status: row.status,
    plannedQty: row.plannedQty,
    producedQty: row.producedQty,
    scrappedQty: row.scrappedQty,
    batchNo: row.batchNo,
    lineCount: row.lineCount,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

async function buildProductionDetail(productionId: string, exec?: Tx): Promise<ProductionDetail> {
  const order = exec
    ? await repo.findProductionOrder(productionId, exec)
    : await repo.findProductionOrder(productionId);
  if (!order) throw new NotFoundError('Production order', productionId);

  const lines = exec
    ? await repo.findProductionLines(productionId, exec)
    : await repo.findProductionLines(productionId);

  const detailLines = lines.map((l) => ({
    id: l.id,
    inventoryLevelId: l.inventoryLevelId,
    componentKind: l.componentKind,
    componentId: l.componentId,
    sku: l.sku,
    name: l.name,
    plannedQty: l.plannedQty,
    consumedQty: l.consumedQty,
    varianceQty: l.consumedQty - l.plannedQty,
    unit: l.unit,
    availableQty: l.availableQty,
    shortageQty: Math.max(0, l.plannedQty - l.availableQty),
  }));

  return {
    ...toProductionSummary(order),
    note: order.note,
    // Recomputed on every read, never stored: stock moves for a hundred reasons
    // that have nothing to do with this order, and a cached answer would be wrong
    // by the time anyone acted on it.
    canBuild: detailLines.every((l) => l.shortageQty === 0),
    nextActions: productionEdgesFrom(order.status).map((e) => e.action),
    lines: detailLines,
  };
}

export { isProductionEditable };
