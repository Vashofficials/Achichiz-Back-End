/**
 * Inventory-core contracts.
 *
 * Every field carries `.describe()` — that text becomes the OpenAPI description
 * and it is what the console team reads instead of guessing from a field name.
 *
 * A note on the movement vocabulary. Migration `0003_inventory.sql` widened the
 * `stock_movements_movement_type_check` constraint from seven values to eleven
 * (adding `production`, `raw_material_consumption`, `stock_count`, `loss`,
 * `found`) and the reference vocabulary from seven to ten. The Drizzle table in
 * `db/schema/inventory.ts` still carries the 0001 unions in its `$type<>`
 * annotation, and the migration is the authoritative artifact — see the header of
 * `db/schema/inventory-ops.ts`, which says so explicitly. The full vocabularies
 * are therefore declared here, against the live CHECK constraints, and the
 * repository casts once at the insert boundary with that fact recorded next to
 * the cast. Narrowing the API to the stale union instead would make `loss` and
 * `found` unreachable through any endpoint, which is the wrong direction to
 * resolve the mismatch.
 */

import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import { RESERVATION_REASONS } from '../../db/schema/index.js';
import { STOCK_STATES } from './admin-inventory.stock.js';

/* --------------------------------------------------------- vocabularies */

/** The eleven movement types the live CHECK constraint accepts. */
export const MOVEMENT_TYPES = [
  'inbound',
  'outbound',
  'adjustment',
  'transfer_out',
  'transfer_in',
  'damage',
  'return_in',
  'production',
  'raw_material_consumption',
  'stock_count',
  'loss',
  'found',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** The ten reference types the live CHECK constraint accepts. */
export const REFERENCE_TYPES = [
  'purchase_order',
  'goods_receipt',
  'order',
  'stock_transfer',
  'return',
  'adjustment',
  'import',
  'production_order',
  'stock_count',
  'purchase_return',
] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

/**
 * The movement types an operator may pick on a MANUAL adjustment.
 *
 * `transfer_in` / `transfer_out` are excluded because a transfer that writes only
 * one leg leaves stock invented or destroyed — those belong to the transfer
 * workflow, which writes both legs in one transaction. `production` and
 * `raw_material_consumption` are excluded for the same reason: they are the two
 * halves of a production run and must move together. `stock_count` is excluded
 * because §40 says a count posts its variance only through APPROVAL, never by
 * someone typing the number in by hand.
 */
export const ADJUSTMENT_MOVEMENT_TYPES = [
  'adjustment',
  'inbound',
  'outbound',
  'damage',
  'return_in',
  'loss',
  'found',
] as const;
export type AdjustmentMovementType = (typeof ADJUSTMENT_MOVEMENT_TYPES)[number];

export const STOCKABLE_KINDS = ['variant', 'hamper_item', 'packaging'] as const;
export type StockableKind = (typeof STOCKABLE_KINDS)[number];

/**
 * `z.coerce.boolean()` is wrong for a query string — `Boolean('false')` is `true`,
 * so `?belowReorderPoint=false` would filter. Parse the literal instead, exactly
 * as `catalogue.schemas.ts` does.
 */
const boolParam = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/* --------------------------------------------------------------- params */

export const skuParam = z.object({
  sku: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('Stock-keeping unit. Resolved against `product_variants.sku` first, then `hamper_items.sku`, then `packaging_materials.sku`.'),
});

export const movementIdParam = z.object({
  movementId: z
    .string()
    .regex(/^\d{1,19}$/)
    .describe('Movement id. `stock_movements.id` is a BIGINT identity, so it travels as a decimal string — a JSON number would silently lose precision past 2^53.'),
});

export const reservationIdParam = z.object({
  id: z.uuid().describe('Reservation id.'),
});

/* -------------------------------------------------------------- queries */

const warehouseFilter = z.uuid().optional().describe('Restrict to one warehouse.');

export const inventoryListQuery = listQuery.extend({
  sort: z
    .string()
    .max(120)
    .optional()
    .describe('`sku` (default), `-availableQty`, `availableQty`, `onHandQty`, `reservedQty`, `-lastMovementAt`, `warehouse`.'),
  q: z.string().trim().min(1).max(120).optional().describe('Matches SKU or item name, case-insensitively.'),
  warehouseId: warehouseFilter,
  locationId: z.uuid().optional().describe('Restrict to one bin/shelf/rack/zone (`warehouse_locations.id`).'),
  kind: z
    .enum(STOCKABLE_KINDS)
    .optional()
    .describe('`inventory_levels` is polymorphic — a row is a finished `variant`, a loose `hamper_item`, or a `packaging` material.'),
  state: z
    .enum(STOCK_STATES)
    .optional()
    .describe('`out` = nothing sellable · `low` = at or below the reorder point · `in` = above it.'),
  belowReorderPoint: boolParam
    .optional()
    .describe('`true` returns only levels at or below their reorder point — the buying queue.'),
});

export const movementListQuery = listQuery.extend({
  sort: z.string().max(120).optional().describe('`-occurredAt` (default), `occurredAt`, `quantityDelta`, `-id`.'),
  q: z.string().trim().min(1).max(120).optional().describe('Matches SKU, item name or `referenceLabel`.'),
  sku: z.string().trim().max(64).optional().describe('One SKU. The whole history for one item.'),
  warehouseId: warehouseFilter,
  movementType: z
    .string()
    .max(200)
    .optional()
    .describe('One type or a comma-separated list: `?movementType=damage,loss`. An unknown value is a 400, not an empty page.'),
  referenceType: z.string().max(200).optional().describe('One type or a comma-separated list.'),
  referenceId: z.uuid().optional().describe('Everything a single document did — one order, one GRN, one transfer.'),
  actorId: z.uuid().optional().describe('Movements recorded by one staff member.'),
  from: z.string().optional().describe('ISO date or timestamp. Inclusive lower bound on `occurredAt`.'),
  to: z.string().optional().describe('ISO date or timestamp. Inclusive upper bound on `occurredAt`.'),
});

export const alertListQuery = listQuery.extend({
  sort: z.string().max(120).optional().describe('`availableQty` (default, most urgent first), `sku`, `-shortfallQty`.'),
  q: z.string().trim().min(1).max(120).optional().describe('Matches SKU or item name.'),
  warehouseId: warehouseFilter,
  kind: z.enum(STOCKABLE_KINDS).optional().describe('Restrict to variants, hamper items or packaging.'),
});

export const reorderListQuery = listQuery.extend({
  sort: z.string().max(120).optional().describe('`-shortfallQty` (default), `sku`, `leadTimeDays`.'),
  q: z.string().trim().min(1).max(120).optional().describe('Matches SKU or item name.'),
  warehouseId: warehouseFilter,
  supplierId: z.uuid().optional().describe('Only items whose preferred supplier is this one — one buyer’s worklist.'),
});

export const reservationListQuery = listQuery.extend({
  sort: z.string().max(120).optional().describe('`-createdAt` (default), `createdAt`, `expiresAt`, `quantity`.'),
  sku: z.string().trim().max(64).optional().describe('Holds against one SKU.'),
  warehouseId: warehouseFilter,
  reason: z
    .enum(RESERVATION_REASONS)
    .optional()
    .describe('`cart` (expires) · `order` (never expires) · `manual_hold` · `quotation`.'),
  status: z
    .enum(['active', 'released', 'expired', 'all'])
    .default('active')
    .describe('`active` (default) is unreleased and unexpired — the holds that are actually consuming stock right now.'),
});

export const inventoryAuditQuery = listQuery.extend({
  sort: z.string().max(120).optional().describe('`-occurredAt` (default) or `occurredAt`.'),
  q: z.string().trim().min(1).max(120).optional().describe('Matches the entity label or the action.'),
  action: z.string().max(120).optional().describe('e.g. `inventory.adjusted`, `inventory.reserved`, `inventory.released`.'),
  entityId: z.uuid().optional().describe('Everything recorded against one inventory level.'),
  actorStaffId: z.uuid().optional().describe('Everything one staff member did to stock.'),
  from: z.string().optional().describe('ISO date or timestamp, inclusive.'),
  to: z.string().optional().describe('ISO date or timestamp, inclusive.'),
});

export const inventoryNotificationQuery = listQuery.extend({
  sort: z.string().max(120).optional().describe('`-createdAt` (default) or `createdAt`.'),
  unreadOnly: boolParam.optional().describe('`true` returns only notifications with no `readAt`.'),
  priority: z.enum(['high', 'normal', 'low']).optional().describe('Restrict to one priority.'),
});

export const availabilityQuery = z.object({
  warehouseId: warehouseFilter,
  quantity: z.coerce
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .optional()
    .describe('Ask a yes/no question: can this many units be promised right now? Sets `canFulfil` per warehouse and overall.'),
});

export const dashboardQuery = z.object({
  warehouseId: warehouseFilter,
});

export const EXPORT_FORMATS = ['csv', 'json'] as const;

export const inventoryExportQuery = z.object({
  format: z.enum(EXPORT_FORMATS).default('csv').describe('`csv` (default, a downloadable attachment) or `json`.'),
  warehouseId: warehouseFilter,
  kind: z.enum(STOCKABLE_KINDS).optional().describe('Restrict to variants, hamper items or packaging.'),
  state: z.enum(STOCK_STATES).optional().describe('Export only `out`, `low` or `in` rows.'),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(50_000)
    .default(10_000)
    .describe('Row cap. Maximum 50,000 — an unbounded export of a growing table is an outage waiting for a slow month.'),
});

/* --------------------------------------------------------------- bodies */

export const adjustmentBody = z.object({
  sku: z.string().trim().min(1).max(64).describe('The item to adjust.'),
  warehouseId: z.uuid().describe('Which warehouse’s stock moved. Stock is per item × warehouse; there is no global figure to adjust.'),
  quantityDelta: z
    .number()
    .int()
    .refine((v) => v !== 0, 'quantityDelta must not be zero')
    .describe('Signed change. Positive adds, negative removes. Never zero — the ledger CHECK rejects a movement of nothing.'),
  movementType: z
    .enum(ADJUSTMENT_MOVEMENT_TYPES)
    .default('adjustment')
    .describe('Why the stock moved, in the ledger’s vocabulary. Transfer, production and stock-count types are not adjustable by hand — each writes two coordinated rows or requires an approval.'),
  reason: z
    .string()
    .trim()
    .min(3)
    .max(400)
    .describe('Required. Goes on the movement as `note` and into the activity log. An adjustment with no stated reason is indistinguishable from an error.'),
  referenceType: z.enum(REFERENCE_TYPES).optional().describe('The kind of document this adjustment answers to, if any.'),
  referenceId: z.uuid().optional().describe('That document’s id.'),
  referenceLabel: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe('Human-readable document number for the ledger screen — `PO-2026-02291`, `ACH104422`.'),
});

export const bulkAdjustBody = z.object({
  reason: z
    .string()
    .trim()
    .min(3)
    .max(400)
    .describe('Applies to every line. A single stated reason is what makes a fifty-line correction reviewable later.'),
  movementType: z
    .enum(ADJUSTMENT_MOVEMENT_TYPES)
    .default('adjustment')
    .describe('Default type for lines that do not name their own.'),
  referenceType: z.enum(REFERENCE_TYPES).optional().describe('Applies to every line.'),
  referenceId: z.uuid().optional().describe('Applies to every line.'),
  referenceLabel: z.string().trim().max(64).optional().describe('Applies to every line.'),
  adjustments: z
    .array(
      z.object({
        sku: z.string().trim().min(1).max(64).describe('The item to adjust.'),
        warehouseId: z.uuid().describe('Which warehouse.'),
        quantityDelta: z
          .number()
          .int()
          .refine((v) => v !== 0, 'quantityDelta must not be zero')
          .describe('Signed change for this line.'),
        movementType: z
          .enum(ADJUSTMENT_MOVEMENT_TYPES)
          .optional()
          .describe('Overrides the batch type for this line only.'),
        note: z.string().trim().max(400).optional().describe('Appended to the batch reason on this line’s movement.'),
      }),
    )
    .min(1)
    .max(200)
    .describe('At most 200 lines. Every (`sku`, `warehouseId`) pair must be distinct — two deltas against one level in one batch is ambiguous, so it is refused rather than guessed at.'),
});

export const reservationBody = z.object({
  sku: z.string().trim().min(1).max(64).describe('The item to hold.'),
  warehouseId: z.uuid().describe('Which warehouse the units are held in.'),
  quantity: z.number().int().positive().max(1_000_000).describe('How many units to hold. Must fit inside current sellable stock.'),
  expiresAt: z
    .iso
    .datetime()
    .optional()
    .describe('When the hold lapses. Omit for an open-ended hold; the sweeper only releases holds that carry an expiry, so an open-ended one stays until someone releases it.'),
  note: z.string().trim().max(400).optional().describe('Why this stock is being held. Recorded in the activity log.'),
});

export const releaseReservationBody = z.object({
  reason: z.string().trim().max(400).optional().describe('Why the hold is being lifted. Recorded in the activity log.'),
});

export const purchaseDraftBody = z.object({
  supplierId: z.uuid().describe('Who to buy from. Required — a draft with no supplier has no cost, no MOQ and no lead time, which is most of what a purchase order is.'),
  warehouseId: z.uuid().describe('Which warehouse the goods are being bought for.'),
  expectedOn: z.iso.date().optional().describe('`YYYY-MM-DD`. Defaults to today plus the supplier’s longest lead time across the drafted lines.'),
  notes: z.string().trim().max(2_000).optional().describe('Internal note on the draft.'),
  skus: z
    .array(z.string().trim().min(1).max(64))
    .max(200)
    .optional()
    .describe('Restrict the generated draft to these SKUs. Omit to draft every item this supplier supplies that is at or below its reorder point in this warehouse.'),
  lines: z
    .array(
      z.object({
        sku: z.string().trim().min(1).max(64).describe('The item to buy.'),
        quantity: z.number().int().positive().max(1_000_000).describe('Quantity to order, before MOQ rounding.'),
        unitCostPaise: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Integer paise. Overrides the supplier catalogue cost for this line.'),
      }),
    )
    .min(1)
    .max(200)
    .optional()
    .describe('Explicit lines, overriding the reorder engine entirely. Quantities are still rounded UP to the supplier’s MOQ — a purchase order the supplier will reject is not a saving.'),
});

/* ------------------------------------------------------------ responses */

export const stockableRef = z.object({
  kind: z.enum(STOCKABLE_KINDS).describe('Which of the three polymorphic targets this level points at.'),
  id: z.uuid().describe('Id of the variant, hamper item or packaging material.'),
  sku: z.string().describe('The SKU.'),
  name: z.string().describe('Display name. For a variant this is the product title plus its option label.'),
});

export const inventoryLevelSummary = z.object({
  id: z.uuid().describe('`inventory_levels` row id. This is what movements and reservations point at.'),
  item: stockableRef,
  warehouseId: z.uuid().describe('Warehouse id.'),
  warehouseCode: z.string().describe('Warehouse code, e.g. `WH-MUM-AND`.'),
  warehouseName: z.string().describe('Warehouse name.'),
  binLocation: z.string().nullable().describe('Free-text bin label carried on the level row.'),
  locationId: z.uuid().nullable().describe('Structured `warehouse_locations` id, when the item has been binned properly.'),
  onHandQty: z.number().int().describe('Physically present.'),
  reservedQty: z.number().int().describe('Held for a cart, order, quotation or manual hold. Present but not sellable.'),
  availableQty: z.number().int().describe('Sellable. A GENERATED column in Postgres (`on_hand_qty - reserved_qty`), so it cannot drift from the two numbers above.'),
  incomingQty: z.number().int().describe('On a purchase order that has not landed yet.'),
  reorderPoint: z.number().int().describe('Act when the inventory position reaches this.'),
  reorderQty: z.number().int().describe('The house’s normal order size for this item.'),
  state: z.enum(STOCK_STATES).describe('`out` · `low` · `in`, derived from `availableQty` against `reorderPoint`.'),
  unitCostPaise: z.number().int().nullable().describe('Integer paise. Cost of one unit, for valuation. Null when the item has no recorded cost.'),
  stockValuePaise: z.number().int().describe('Integer paise. `onHandQty × unitCostPaise`, or 0 when there is no cost.'),
  lastMovementAt: z.iso.datetime().nullable().describe('When stock last moved here.'),
});

export const stockMovementResponse = z.object({
  id: z.string().describe('BIGINT identity as a decimal string.'),
  inventoryLevelId: z.uuid().describe('The level this movement applied to.'),
  item: stockableRef,
  warehouseId: z.uuid().describe('Warehouse id.'),
  warehouseCode: z.string().describe('Warehouse code.'),
  movementType: z.enum(MOVEMENT_TYPES).describe('What kind of movement this was.'),
  quantityDelta: z.number().int().describe('Signed change to on-hand. Never zero.'),
  balanceAfter: z.number().int().describe('On-hand balance immediately after this movement. The ledger reconstructs any historical position from this column alone.'),
  referenceType: z.enum(REFERENCE_TYPES).nullable().describe('The kind of document behind it.'),
  referenceId: z.uuid().nullable().describe('That document’s id.'),
  referenceLabel: z.string().nullable().describe('That document’s human-readable number.'),
  note: z.string().nullable().describe('Free text recorded with the movement.'),
  actorId: z.uuid().nullable().describe('Staff member who caused it. Null for system movements.'),
  occurredAt: z.iso.datetime().describe('When it happened.'),
});

export const warehouseAvailability = z.object({
  warehouseId: z.uuid().describe('Warehouse id.'),
  warehouseCode: z.string().describe('Warehouse code.'),
  warehouseName: z.string().describe('Warehouse name.'),
  onHandQty: z.number().int().describe('Physically present here.'),
  reservedQty: z.number().int().describe('Held here.'),
  availableQty: z.number().int().describe('Sellable here.'),
  incomingQty: z.number().int().describe('Inbound here.'),
  state: z.enum(STOCK_STATES).describe('`out` · `low` · `in` for this warehouse alone.'),
  canFulfil: z.boolean().nullable().describe('Whether `?quantity=` fits in this warehouse’s sellable stock. Null when no quantity was asked about.'),
});

export const availabilityResponse = z.object({
  item: stockableRef,
  totalOnHandQty: z.number().int().describe('Across every warehouse in scope.'),
  totalReservedQty: z.number().int().describe('Across every warehouse in scope.'),
  totalAvailableQty: z.number().int().describe('Across every warehouse in scope.'),
  totalIncomingQty: z.number().int().describe('Across every warehouse in scope.'),
  state: z.enum(STOCK_STATES).describe('Network-wide state. This is the value the storefront should surface — never the raw number (§16).'),
  requestedQty: z.number().int().nullable().describe('Echo of `?quantity=`.'),
  canFulfil: z.boolean().nullable().describe('Whether one single warehouse can cover `?quantity=`. A split shipment is a fulfilment decision, not an availability fact, so this is deliberately NOT the network total.'),
  canFulfilAcrossWarehouses: z.boolean().nullable().describe('Whether the network total covers `?quantity=`, if you are willing to split.'),
  warehouses: z.array(warehouseAvailability).describe('Per-warehouse breakdown.'),
});

export const reservationResponse = z.object({
  id: z.uuid().describe('Reservation id.'),
  inventoryLevelId: z.uuid().describe('The level whose `reservedQty` this hold consumes.'),
  item: stockableRef,
  warehouseId: z.uuid().describe('Warehouse id.'),
  warehouseCode: z.string().describe('Warehouse code.'),
  quantity: z.number().int().describe('Units held.'),
  reason: z.enum(RESERVATION_REASONS).describe('`cart` · `order` · `manual_hold` · `quotation`.'),
  cartId: z.uuid().nullable().describe('The cart that owns it, for a `cart` hold.'),
  orderId: z.uuid().nullable().describe('The order that owns it, for an `order` hold.'),
  expiresAt: z.iso
    .datetime()
    .nullable()
    .describe('When it lapses. Null means it never does — order-backed holds and open-ended manual holds.'),
  releasedAt: z.iso.datetime().nullable().describe('When it was released. Null while active.'),
  isActive: z.boolean().describe('Unreleased and not past its expiry — i.e. still consuming sellable stock.'),
  createdAt: z.iso.datetime().describe('When it was placed.'),
});

export const inventoryDetail = z.object({
  item: stockableRef,
  totalOnHandQty: z.number().int().describe('Across every warehouse.'),
  totalReservedQty: z.number().int().describe('Across every warehouse.'),
  totalAvailableQty: z.number().int().describe('Across every warehouse.'),
  totalIncomingQty: z.number().int().describe('Across every warehouse.'),
  totalStockValuePaise: z.number().int().describe('Integer paise. On-hand across the network at unit cost.'),
  state: z.enum(STOCK_STATES).describe('Network-wide `out` · `low` · `in`.'),
  levels: z.array(inventoryLevelSummary).describe('One row per warehouse holding this item.'),
  recentMovements: z.array(stockMovementResponse).describe('The last 20 ledger entries across every warehouse, newest first.'),
  reservations: z.array(reservationResponse).describe('Every hold currently consuming stock.'),
  incoming: z
    .array(
      z.object({
        purchaseOrderId: z.uuid().describe('Purchase order id.'),
        poNo: z.string().describe('Purchase order number.'),
        supplierName: z.string().describe('Who it is coming from.'),
        warehouseId: z.uuid().describe('Where it is going.'),
        status: z.string().describe('`draft`, `sent` or `partially_received`.'),
        orderedQty: z.number().int().describe('Quantity on the line.'),
        receivedQty: z.number().int().describe('Already received against it.'),
        outstandingQty: z.number().int().describe('`orderedQty - receivedQty` — what is still owed.'),
        expectedOn: z.iso.date().nullable().describe('Expected arrival date.'),
      }),
    )
    .describe('Open purchase-order lines for this item. A received or cancelled PO does not appear.'),
});

export const adjustmentResult = z.object({
  inventoryLevelId: z.uuid().describe('The level that changed.'),
  item: stockableRef,
  warehouseId: z.uuid().describe('Warehouse id.'),
  movementId: z.string().describe('The ledger row this wrote, as a decimal string. The ledger is append-only — a correction is a NEW reversing movement, never an edit to this one.'),
  movementType: z.enum(MOVEMENT_TYPES).describe('What was recorded.'),
  quantityDelta: z.number().int().describe('The signed change applied.'),
  onHandQtyBefore: z.number().int().describe('On-hand as the locked row read before the write.'),
  onHandQty: z.number().int().describe('On-hand after. Equals `balanceAfter`.'),
  reservedQty: z.number().int().describe('Unchanged by an adjustment — only reservations move this.'),
  availableQty: z.number().int().describe('Sellable after.'),
  balanceAfter: z.number().int().describe('The running balance written onto the movement row.'),
  occurredAt: z.iso.datetime().describe('When it was recorded.'),
});

export const bulkAdjustResult = z.object({
  applied: z.number().int().describe('How many lines were written. Equals the number of lines sent — this endpoint is all-or-nothing.'),
  totalQuantityDelta: z.number().int().describe('Sum of every signed delta in the batch.'),
  results: z.array(adjustmentResult).describe('One entry per line, each with its OWN movement row, in the deterministic lock order the batch used (ascending `inventory_level_id`).'),
});

export const reorderLine = z.object({
  inventoryLevelId: z.uuid().describe('The level that triggered.'),
  item: stockableRef,
  warehouseId: z.uuid().describe('Warehouse id.'),
  warehouseCode: z.string().describe('Warehouse code.'),
  onHandQty: z.number().int().describe('Physically present.'),
  reservedQty: z.number().int().describe('Already promised.'),
  availableQty: z.number().int().describe('Sellable.'),
  incomingQty: z.number().int().describe('Already on order.'),
  inventoryPosition: z.number().int().describe('`onHand - reserved + incoming`. What the buying decision is actually made against.'),
  reorderPoint: z.number().int().describe('The trigger level.'),
  reorderQty: z.number().int().describe('The house order size.'),
  targetLevel: z.number().int().describe('`reorderPoint + reorderQty` — the level the suggestion restores.'),
  shortfallQty: z.number().int().describe('`targetLevel - inventoryPosition`, floored at zero. Before MOQ rounding.'),
  suggestedQty: z.number().int().describe('What to put on the purchase order: the shortfall rounded UP to a whole multiple of the supplier’s MOQ.'),
  moq: z.number().int().describe('Supplier minimum order quantity. 1 when no supplier catalogue entry exists.'),
  leadTimeDays: z.number().int().describe('Supplier lead time in days. 0 when unknown.'),
  supplierId: z.uuid().nullable().describe('Preferred supplier, or the cheapest if none is flagged preferred.'),
  supplierName: z.string().nullable().describe('Preferred supplier name.'),
  supplierSku: z.string().nullable().describe('What the SUPPLIER calls this item — what goes on the PO they receive.'),
  isPreferredSupplier: z.boolean().describe('False when the supplier shown is merely the cheapest match rather than one flagged preferred.'),
  unitCostPaise: z.number().int().describe('Integer paise, from the supplier catalogue. 0 when unknown.'),
  estimatedCostPaise: z.number().int().describe('Integer paise. `suggestedQty × unitCostPaise`.'),
});

export const purchaseDraftResponse = z.object({
  purchaseOrderId: z.uuid().describe('The created purchase order.'),
  poNo: z.string().describe('Document number from `document_number_series`, e.g. `PO-2026-00042`.'),
  status: z.literal('draft').describe('Always `draft`. This endpoint never sends anything to a supplier — that is `POST /purchase-orders/:poId/send`, behind its own permission.'),
  supplierId: z.uuid().describe('Who it is addressed to.'),
  supplierName: z.string().describe('Supplier name.'),
  warehouseId: z.uuid().describe('Where the goods are going.'),
  expectedOn: z.iso.date().nullable().describe('Expected arrival, defaulted from the longest lead time on the draft.'),
  subtotalPaise: z.number().int().describe('Integer paise. Sum of the line totals.'),
  taxPaise: z.number().int().describe('Integer paise. Always 0 on a draft — GST is resolved when the goods are received and invoiced, and a guessed figure here would be a statutory number nobody computed.'),
  totalPaise: z.number().int().describe('Integer paise. `subtotalPaise + taxPaise`.'),
  lines: z
    .array(
      z.object({
        id: z.uuid().describe('Purchase-order line id.'),
        sku: z.string().describe('The SKU ordered.'),
        description: z.string().describe('What appears on the document.'),
        orderedQty: z.number().int().describe('Quantity, already rounded up to the supplier’s MOQ.'),
        moq: z.number().int().describe('The MOQ the quantity was rounded to.'),
        unitCostPaise: z.number().int().describe('Integer paise per unit.'),
        lineTotalPaise: z.number().int().describe('Integer paise. `orderedQty × unitCostPaise`.'),
      }),
    )
    .describe('The drafted lines.'),
});

export const inventoryDashboard = z.object({
  warehouseId: z.uuid().nullable().describe('Echo of `?warehouseId=`. Null means the whole network.'),
  trackedItemCount: z.number().int().describe('Distinct items with an inventory level in scope.'),
  levelCount: z.number().int().describe('Rows in `inventory_levels` in scope — items × warehouses.'),
  totalOnHandQty: z.number().int().describe('Units physically present.'),
  totalReservedQty: z.number().int().describe('Units held.'),
  totalAvailableQty: z.number().int().describe('Units sellable.'),
  totalIncomingQty: z.number().int().describe('Units on open purchase orders.'),
  stockValuePaise: z.number().int().describe('Integer paise. On-hand at unit cost. Items with no recorded cost contribute nothing rather than a guess.'),
  outOfStockCount: z.number().int().describe('Levels with nothing sellable.'),
  lowStockCount: z.number().int().describe('Levels at or below their reorder point but not yet at zero.'),
  reorderCount: z.number().int().describe('Levels whose inventory position is at or below the reorder point — the buying queue.'),
  activeReservationCount: z.number().int().describe('Holds currently consuming stock.'),
  expiringReservationCount: z.number().int().describe('Active holds that lapse within 24 hours.'),
  movementsLast24h: z.number().int().describe('Ledger rows in the last 24 hours.'),
  movementsLast7d: z.number().int().describe('Ledger rows in the last 7 days.'),
  openPurchaseOrderCount: z.number().int().describe('Purchase orders in `draft`, `sent` or `partially_received`.'),
  openPurchaseOrderValuePaise: z.number().int().describe('Integer paise. Committed spend on those orders.'),
  warehouses: z
    .array(
      z.object({
        warehouseId: z.uuid().describe('Warehouse id.'),
        warehouseCode: z.string().describe('Warehouse code.'),
        warehouseName: z.string().describe('Warehouse name.'),
        levelCount: z.number().int().describe('Levels held here.'),
        onHandQty: z.number().int().describe('Units here.'),
        reservedQty: z.number().int().describe('Units held here.'),
        availableQty: z.number().int().describe('Units sellable here.'),
        stockValuePaise: z.number().int().describe('Integer paise.'),
        outOfStockCount: z.number().int().describe('Levels at zero sellable here.'),
        lowStockCount: z.number().int().describe('Levels at or below reorder point here.'),
      }),
    )
    .describe('Per-warehouse breakdown. Omitted warehouses hold no stock at all.'),
});

export const inventoryAuditEvent = z.object({
  id: z.string().describe('BIGINT identity as a decimal string.'),
  occurredAt: z.iso.datetime().describe('When.'),
  action: z.string().describe('e.g. `inventory.adjusted`, `inventory.reserved`, `inventory.released`, `inventory.purchase_draft_created`.'),
  actorLabel: z.string().describe('Who, as recorded at the time.'),
  actorRole: z.string().nullable().describe('The role they held then — not the role they hold now.'),
  actorStaffId: z.uuid().nullable().describe('Staff id.'),
  entityType: z.string().describe('`inventory_level`, `inventory_reservation` or `purchase_order`.'),
  entityId: z.uuid().nullable().describe('The row it happened to.'),
  entityLabel: z.string().nullable().describe('Denormalised label — usually the SKU.'),
  beforeData: z.unknown().nullable().describe('The quantities before, as JSON. Queryable and diffable, unlike a rendered string.'),
  afterData: z.unknown().nullable().describe('The quantities after, as JSON.'),
  changedFields: z.array(z.string()).nullable().describe('Which fields moved.'),
  requestId: z.string().nullable().describe('Correlates with the API request log.'),
});

export const inventoryNotification = z.object({
  id: z.uuid().describe('Notification id.'),
  kind: z.literal('inventory').describe('Always `inventory` — this endpoint is the inventory slice of the staff notification feed.'),
  priority: z.enum(['high', 'normal', 'low']).describe('`high` is a stockout on something that is selling.'),
  title: z.string().describe('One-line headline.'),
  body: z.string().nullable().describe('Detail.'),
  linkUrl: z.string().nullable().describe('Where the console should send the operator.'),
  entityType: z.string().nullable().describe('What it is about.'),
  entityId: z.uuid().nullable().describe('Which row.'),
  readAt: z.iso.datetime().nullable().describe('Null while unread.'),
  createdAt: z.iso.datetime().describe('When it was raised.'),
});

/* ------------------------------------------------------------------ types */

export type StockableRef = z.infer<typeof stockableRef>;
export type InventoryLevelSummary = z.infer<typeof inventoryLevelSummary>;
export type StockMovementResponse = z.infer<typeof stockMovementResponse>;
export type AvailabilityResponse = z.infer<typeof availabilityResponse>;
export type InventoryDetail = z.infer<typeof inventoryDetail>;
export type ReservationResponse = z.infer<typeof reservationResponse>;
export type AdjustmentResult = z.infer<typeof adjustmentResult>;
export type BulkAdjustResult = z.infer<typeof bulkAdjustResult>;
export type ReorderLine = z.infer<typeof reorderLine>;
export type PurchaseDraftResponse = z.infer<typeof purchaseDraftResponse>;
export type InventoryDashboard = z.infer<typeof inventoryDashboard>;
export type InventoryAuditEvent = z.infer<typeof inventoryAuditEvent>;
export type InventoryNotification = z.infer<typeof inventoryNotification>;
export type AdjustmentBody = z.infer<typeof adjustmentBody>;
export type BulkAdjustBody = z.infer<typeof bulkAdjustBody>;
export type ReservationBody = z.infer<typeof reservationBody>;
export type PurchaseDraftBody = z.infer<typeof purchaseDraftBody>;
export type InventoryListQuery = z.infer<typeof inventoryListQuery>;
export type MovementListQuery = z.infer<typeof movementListQuery>;
export type AlertListQuery = z.infer<typeof alertListQuery>;
export type ReorderListQuery = z.infer<typeof reorderListQuery>;
export type ReservationListQuery = z.infer<typeof reservationListQuery>;
export type InventoryAuditQuery = z.infer<typeof inventoryAuditQuery>;
export type InventoryNotificationQuery = z.infer<typeof inventoryNotificationQuery>;
export type InventoryExportQuery = z.infer<typeof inventoryExportQuery>;
export type AvailabilityQuery = z.infer<typeof availabilityQuery>;
export type DashboardQuery = z.infer<typeof dashboardQuery>;
