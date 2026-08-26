/**
 * Bill-of-materials and production contracts.
 *
 * ## What a `bomId` is
 *
 * There is no `boms` table. `product_bom_lines` is a LINE table keyed to its
 * output by `variant_id NOT NULL`, with `hamper_item_id` / `component_variant_id`
 * naming the INPUT (`CHECK bom_exactly_one_component`). A bill of materials is
 * therefore exactly "the set of lines whose `variant_id` is X", and `bomId`
 * **is** that output variant id. Inventing a surrogate header id in application
 * code would be a second identity for something the database already identifies.
 *
 * ## Quantities are not money
 *
 * `quantity` and `wastePct` are NUMERIC in the database and come back as
 * JSON numbers here, because they are physical measurements — 105.5 g of wax —
 * not currency. Every money field in this file is still integer paise.
 */

import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import { PRODUCTION_STATUSES, UOM } from '../../db/schema/index.js';

/* ------------------------------------------------------------ path params */

export const bomIdParam = z.object({
  bomId: z
    .uuid()
    .describe(
      'The OUTPUT variant id. `product_bom_lines` has no header table — a BOM *is* its output, so the ' +
        'output variant identifies it.',
    ),
});

export const productionIdParam = z.object({
  productionId: z.uuid().describe('Production order id.'),
});

/* =============================================================== BOM lines */

const quantity = (what: string) =>
  z
    .number()
    .positive()
    .max(1_000_000)
    .describe(`NUMERIC(10,3) — up to three decimals. ${what}`);

const bomLineInput = z
  .object({
    componentVariantId: z
      .uuid()
      .optional()
      .describe('A product variant that goes IN. Exactly one of this or `hamperItemId`.'),
    hamperItemId: z
      .uuid()
      .optional()
      .describe('A loose hamper item that goes IN. Exactly one of this or `componentVariantId`.'),
    quantity: quantity('How much of this component ONE unit of the output needs, before waste.'),
    wastePct: z
      .number()
      .min(0)
      .max(99.99)
      .default(0)
      .describe(
        'Expected loss on this line, as a percentage of the input: `effective = quantity × (1 + pct/100)`. ' +
          '100 g of wax at 5 is 105 g. NUMERIC(5,2), `CHECK (waste_pct >= 0 AND waste_pct < 100)`. It is ' +
          'per LINE, not per BOM — 5% on wax and 0% on a bottle are both true at once.',
      ),
    unit: z
      .enum(UOM)
      .default('piece')
      .describe(
        'Unit of measure. Conversion between units is deliberately NOT modelled, so this must already ' +
          'match the unit the component’s stock is counted in.',
      ),
    isSubstitutable: z
      .boolean()
      .default(false)
      .describe('Whether a picker may swap this component for an equivalent when it is short.'),
  })
  .refine((v) => [v.componentVariantId, v.hamperItemId].filter(Boolean).length === 1, {
    message:
      'Give exactly one of `componentVariantId` or `hamperItemId` — `CHECK bom_exactly_one_component` ' +
      'refuses anything else.',
    path: ['componentVariantId'],
  });

export const bomListQuery = listQuery.extend({
  outputVariantId: z.uuid().optional().describe('Restrict to one output.'),
  componentVariantId: z
    .uuid()
    .optional()
    .describe('Every BOM that consumes this variant. The question to ask before discontinuing it.'),
  hamperItemId: z.uuid().optional().describe('Every BOM that consumes this hamper item.'),
  hasWaste: z
    .enum(['true', 'false'])
    .optional()
    .describe('`true` returns only BOMs with at least one line carrying a non-zero `wastePct`.'),
  sort: z.string().max(120).optional().describe('`sku` (default), `lineCount`, `version`.'),
});

export const createBomBody = z.object({
  outputVariantId: z
    .uuid()
    .describe('The variant this BOM builds. One BOM per output — a second create is a 409.'),
  version: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(1)
    .describe('`CHECK (version >= 1)`. Stamped on every line so a recipe change is visible in history.'),
  lines: z
    .array(bomLineInput)
    .min(1)
    .max(200)
    .describe('At least one component. A BOM with no lines describes nothing.'),
});

export const updateBomBody = z
  .object({
    version: z.number().int().min(1).max(100_000).optional().describe('Bump when the recipe genuinely changes.'),
    lines: z
      .array(bomLineInput)
      .min(1)
      .max(200)
      .optional()
      .describe(
        'REPLACES every line of this BOM in one transaction. Omit to change only `version`. Existing ' +
          'production orders are unaffected — their `production_order_lines` are a snapshot taken when ' +
          'the order was created, which is what makes planned-vs-consumed comparable across a recipe change.',
      ),
  })
  .describe('Every field optional.');

export const bomExplosionQuery = z.object({
  quantity: z.coerce
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .default(1)
    .describe('Units of the output to build. Multiplies every requirement below it.'),
  mode: z
    .enum(['full', 'direct'])
    .default('full')
    .describe(
      '`full` recurses to raw materials, compounding waste at each level. `direct` returns only the ' +
        'immediate components — what a run consumes when the sub-assemblies are things the warehouse ' +
        'already stocks rather than things it makes in the same batch.',
    ),
  warehouseId: z
    .uuid()
    .optional()
    .describe('Resolve each requirement against this warehouse’s stock, adding `available` and `shortage`.'),
});

/* ---------------------------------------------------------- BOM responses */

export const bomLineResponse = z.object({
  id: z.uuid().describe('BOM line id.'),
  componentKind: z.enum(['variant', 'hamper_item']).describe('Which kind of thing goes in.'),
  componentId: z.uuid().describe('Id of the component variant or hamper item.'),
  sku: z.string().nullable().describe('Component SKU.'),
  name: z.string().nullable().describe('Component name.'),
  quantity: z.number().describe('Per ONE unit of the output, before waste.'),
  wastePct: z.number().describe('Expected loss on this line, percent of the input.'),
  effectiveQty: z
    .number()
    .describe('`quantity × (1 + wastePct/100)` — what one unit of the output actually costs in this component.'),
  unit: z.enum(UOM).describe('Unit of measure.'),
  isSubstitutable: z.boolean().describe('Whether a picker may swap it.'),
  version: z.number().int().describe('Recipe version this line belongs to.'),
  hasOwnBom: z
    .boolean()
    .describe('True when this component is itself manufactured — the explosion recurses through it.'),
});

export const bomSummary = z.object({
  bomId: z.uuid().describe('The output variant id. There is no separate BOM id.'),
  outputVariantId: z.uuid().describe('Same value, named for what it is.'),
  outputSku: z.string().nullable().describe('Output SKU.'),
  outputName: z.string().nullable().describe('Output product title and option label.'),
  version: z.number().int().describe('Highest version across the lines.'),
  lineCount: z.number().int().describe('Number of component lines.'),
  hasWaste: z.boolean().describe('True when any line carries a non-zero `wastePct`.'),
  hasSubAssemblies: z.boolean().describe('True when at least one component is itself manufactured.'),
});

export const bomDetail = bomSummary.extend({
  lines: z.array(bomLineResponse).describe('The component lines.'),
});

export const bomExplosionLine = z.object({
  componentKind: z.enum(['variant', 'hamper_item']).describe('Which kind of thing this is.'),
  componentId: z.uuid().describe('Id of the component.'),
  sku: z.string().nullable().describe('Component SKU.'),
  name: z.string().nullable().describe('Component name.'),
  unit: z.enum(UOM).describe('Unit of measure. Never converted — see the BOM line note.'),
  rawQty: z
    .number()
    .describe('Exact, waste-compounded, summed over every path that reaches it. Unrounded.'),
  requiredQty: z
    .number()
    .describe(
      'What to take off the shelf: `rawQty` rounded UP — whole units for `piece`, three decimals ' +
        'otherwise. Rounded ONCE, after the paths were summed. You cannot buy 104.7 g of wax and expect ' +
        'the batch to come out.',
    ),
  depth: z.number().int().describe('Deepest level at which this component was reached. 1 is a direct component.'),
  paths: z
    .array(z.string())
    .describe('How it was reached. More than one entry is a diamond, and the quantities were SUMMED.'),
  availableQty: z.number().int().nullable().describe('Sellable stock at `warehouseId`, or null if none was given.'),
  shortageQty: z.number().nullable().describe('`requiredQty − available`, floored at 0. Null without a warehouse.'),
});

export const bomExplosionResponse = z.object({
  bomId: z.uuid().describe('The output variant.'),
  outputSku: z.string().nullable().describe('Output SKU.'),
  quantity: z.number().int().describe('Units of the output the explosion was run for.'),
  mode: z.enum(['full', 'direct']).describe('`full` recursed to raw materials; `direct` stopped at one level.'),
  warehouseId: z.uuid().nullable().describe('The warehouse stock was resolved against, or null.'),
  maxDepth: z.number().int().describe('Deepest level reached. 1 means a flat BOM.'),
  nodeCount: z.number().int().describe('Component visits during the walk. A cheap smell test for a fat BOM.'),
  canBuild: z
    .boolean()
    .nullable()
    .describe('True when every requirement is covered at that warehouse. Null without a warehouse.'),
  leaves: z.array(bomExplosionLine).describe('Raw materials — the pick list. Nothing in the graph makes these.'),
  subAssemblies: z
    .array(bomExplosionLine)
    .describe('Components that are themselves manufactured. Informational: they were exploded, not picked.'),
});

export const bomArchiveResponse = z.object({
  bomId: z.uuid().describe('The output variant.'),
  removedLineCount: z.number().int().describe('How many `product_bom_lines` rows were removed.'),
});

/* ========================================================= production orders */

export const productionListQuery = listQuery.extend({
  status: z
    .string()
    .max(200)
    .optional()
    .describe('One status or a comma-separated list: `draft`, `planned`, `in_progress`, `completed`, `cancelled`.'),
  warehouseId: z.uuid().optional().describe('Restrict to one warehouse.'),
  outputVariantId: z.uuid().optional().describe('Restrict to one output variant.'),
  batchNo: z.string().trim().max(80).optional().describe('Exact batch number.'),
  sort: z.string().max(120).optional().describe('`createdAt` (default, descending), `productionNo`, `plannedQty`, `status`.'),
});

export const createProductionOrderBody = z
  .object({
    warehouseId: z
      .uuid()
      .describe('Where the components come from and the finished goods land. One warehouse per order.'),
    outputVariantId: z.uuid().optional().describe('The finished variant. Exactly one output.'),
    outputHamperItemId: z.uuid().optional().describe('The finished hamper item. Exactly one output.'),
    plannedQty: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .describe('Units to build. `CHECK (planned_qty > 0)`. Sizes every component line.'),
    batchNo: z.string().trim().max(80).nullish().describe('Batch/lot reference for traceability.'),
    note: z.string().trim().max(2_000).nullish().describe('Free text, kept on the order.'),
    status: z
      .enum(['draft', 'planned'])
      .default('planned')
      .describe(
        'Where the order starts. `planned` is the normal case; `draft` is for something still being ' +
          'costed. Nothing later may set it back.',
      ),
    mode: z
      .enum(['full', 'direct'])
      .default('full')
      .describe(
        'How the component lines are derived from the BOM when `lines` is omitted. `full` explodes to raw ' +
          'materials — an intermediate the warehouse does not stock cannot be consumed. `direct` takes ' +
          'the immediate components only.',
      ),
    lines: z
      .array(
        z.object({
          componentVariantId: z.uuid().optional().describe('Component variant. Exactly one target.'),
          hamperItemId: z.uuid().optional().describe('Component hamper item. Exactly one target.'),
          packagingId: z.uuid().optional().describe('Packaging material. Exactly one target.'),
          plannedQty: quantity('Total for the whole run, not per unit. Overrides whatever the BOM says.'),
          unit: z.enum(UOM).default('piece').describe('Unit of measure.'),
        }),
      )
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Explicit component lines. Omit to derive them from the output’s BOM, which is the normal path. ' +
          'Supply them for a run whose recipe differs from the standing BOM — a substitution, a trial batch.',
      ),
  })
  .refine((v) => [v.outputVariantId, v.outputHamperItemId].filter(Boolean).length === 1, {
    message:
      'Give exactly one of `outputVariantId` or `outputHamperItemId` — `CHECK production_orders_one_output` ' +
      'refuses anything else.',
    path: ['outputVariantId'],
  });

export const completeProductionOrderBody = z
  .object({
    producedQty: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe('Good units that came out. Defaults to `plannedQty`. May be 0 for a batch that failed entirely.'),
    scrappedQty: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .default(0)
      .describe(
        'Units started and unusable. Their components were still consumed, which is why this is recorded ' +
          'rather than folded into a smaller `producedQty`.',
      ),
    batchNo: z.string().trim().max(80).nullish().describe('Set or correct the batch number at completion.'),
    note: z.string().trim().max(2_000).nullish().describe('What happened on the floor.'),
    lines: z
      .array(
        z.object({
          inventoryLevelId: z.uuid().describe('The production line to override, identified by its stock level.'),
          consumedQty: quantity('What was ACTUALLY taken. Defaults to the planned quantity.'),
        }),
      )
      .max(200)
      .optional()
      .describe(
        'Actual consumption, per line. Anything not listed consumes its planned quantity. `plannedQty` is ' +
          'never overwritten — the difference between the two is the only honest signal for tuning ' +
          '`wastePct` later.',
      ),
  })
  .describe('Every field optional. An empty body completes the run exactly as planned.');

export const cancelProductionOrderBody = z
  .object({
    reason: z.string().trim().max(2_000).optional().describe('Why. Appended to the order’s note.'),
  })
  .describe('Optional.');

export const productionLineResponse = z.object({
  id: z.uuid().describe('Production order line id.'),
  inventoryLevelId: z.uuid().describe('The stock level this line draws from.'),
  componentKind: z.enum(['variant', 'hamper_item', 'packaging']).describe('What kind of stockable it is.'),
  componentId: z.uuid().nullable().describe('Id of the component.'),
  sku: z.string().nullable().describe('Component SKU.'),
  name: z.string().nullable().describe('Component name.'),
  plannedQty: z
    .number()
    .describe('From the BOM, waste included. NEVER overwritten by what actually happened.'),
  consumedQty: z.number().describe('What was actually taken. 0 until the order completes.'),
  varianceQty: z
    .number()
    .describe('`consumed − planned`. Positive means the run used more than the recipe says. This is the tuning signal.'),
  unit: z.enum(UOM).describe('Unit of measure.'),
  availableQty: z.number().int().describe('Sellable stock at this level right now.'),
  shortageQty: z
    .number()
    .describe('`planned − available`, floored at 0. Non-zero means completion will fail with `insufficient_stock`.'),
});

export const productionSummary = z.object({
  id: z.uuid().describe('Production order id.'),
  productionNo: z.string().describe('`PRD-2026-00001`, from the row-locked document series.'),
  warehouseId: z.uuid().describe('Warehouse.'),
  warehouseName: z.string().nullable().describe('Warehouse name.'),
  outputKind: z.enum(['variant', 'hamper_item']).describe('What is being made.'),
  outputId: z.uuid().describe('Id of the output variant or hamper item.'),
  outputSku: z.string().nullable().describe('Output SKU.'),
  outputName: z.string().nullable().describe('Output name.'),
  status: z.enum(PRODUCTION_STATUSES).describe('Stored status.'),
  plannedQty: z.number().int().describe('Units planned.'),
  producedQty: z.number().int().describe('Good units produced. 0 until completion.'),
  scrappedQty: z.number().int().describe('Units started and unusable.'),
  batchNo: z.string().nullable().describe('Batch/lot reference.'),
  lineCount: z.number().int().describe('Component lines.'),
  startedAt: z.string().nullable().describe('ISO timestamp or null.'),
  completedAt: z.string().nullable().describe('ISO timestamp or null.'),
  createdAt: z.string().describe('ISO timestamp.'),
});

export const productionDetail = productionSummary.extend({
  note: z.string().nullable().describe('Free text.'),
  canBuild: z
    .boolean()
    .describe('True when every component line is currently covered. Recomputed on every read, never stored.'),
  nextActions: z
    .array(z.enum(['plan', 'start', 'complete', 'cancel']))
    .describe('The legal transitions from here, so the console can disable buttons rather than discover a 422.'),
  lines: z.array(productionLineResponse).describe('Component lines, planned beside consumed.'),
});

export type BomListQuery = z.infer<typeof bomListQuery>;
export type BomExplosionQuery = z.infer<typeof bomExplosionQuery>;
export type CreateBomBody = z.infer<typeof createBomBody>;
export type UpdateBomBody = z.infer<typeof updateBomBody>;
export type BomSummary = z.infer<typeof bomSummary>;
export type BomDetail = z.infer<typeof bomDetail>;
export type BomExplosionResponse = z.infer<typeof bomExplosionResponse>;
export type BomArchiveResponse = z.infer<typeof bomArchiveResponse>;
export type ProductionListQuery = z.infer<typeof productionListQuery>;
export type CreateProductionOrderBody = z.infer<typeof createProductionOrderBody>;
export type CompleteProductionOrderBody = z.infer<typeof completeProductionOrderBody>;
export type CancelProductionOrderBody = z.infer<typeof cancelProductionOrderBody>;
export type ProductionSummary = z.infer<typeof productionSummary>;
export type ProductionDetail = z.infer<typeof productionDetail>;
