/**
 * Corporate bulk order contracts.
 *
 * ## What a bulk order IS
 *
 * A `corporate_campaigns` row plus its `campaign_recipients`. The API says
 * "bulk order" because that is what the console and the spec (§88) call it; the
 * table keeps its name, because renaming it would be a migration that buys
 * nothing and breaks every existing reference.
 *
 * ## Demand comes from recipients, never from a typed number
 *
 * There is no `quantity` field on a bulk order. The demand IS the recipient list:
 * 800 recipients wanting the same hamper is 800 units. A separately-typed
 * quantity would be a second opinion about the same fact, and the two would
 * disagree the first time somebody uploaded a corrected spreadsheet.
 *
 * ## Money is integer paise. Quantities are whole units.
 */

import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import { CAMPAIGN_STATUSES } from '../../db/schema/index.js';

/* ------------------------------------------------------------ path params */

export const bulkOrderIdParam = z.object({
  bulkOrderId: z.uuid().describe('Corporate campaign id.'),
});

/* ------------------------------------------------------------ list / write */

export const bulkOrderListQuery = listQuery.extend({
  status: z
    .string()
    .max(200)
    .optional()
    .describe(
      'One status or a comma-separated list: `planning`, `recipients_pending`, `in_dispatch`, ' +
        '`completed`, `cancelled`.',
    ),
  accountId: z.uuid().optional().describe('Restrict to one corporate account.'),
  ownerId: z.uuid().optional().describe('Restrict to one staff owner.'),
  sort: z
    .string()
    .max(120)
    .optional()
    .describe('`createdAt` (default, descending), `campaignNo`, `name`, `status`, `windowStartOn`, `budgetPaise`.'),
});

export const createBulkOrderBody = z.object({
  accountId: z.uuid().describe('The corporate account this campaign belongs to. Required — a bulk order without a buyer is not one.'),
  quotationId: z
    .uuid()
    .optional()
    .describe('The quotation this campaign was won from, if any. Must belong to the same account.'),
  name: z.string().trim().min(1).max(200).describe('What the client calls it — “Diwali 2026”.'),
  budgetPaise: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Approved spend, integer paise. Informational: nothing here refuses to exceed it.'),
  windowStartOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .describe('First dispatch date. Procurement lead times are measured back from this.'),
  windowEndOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .describe('Last dispatch date. `CHECK campaign_window` refuses an end before the start.'),
  ownerId: z.uuid().nullish().describe('Staff owner. Defaults to the caller.'),
});

export const updateBulkOrderBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    budgetPaise: z.number().int().min(0).optional(),
    windowStartOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    windowEndOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    ownerId: z.uuid().nullish(),
    status: z
      .enum(CAMPAIGN_STATUSES)
      .optional()
      .describe(
        'Moving to `cancelled` does NOT release held stock — call POST /release first, or the units stay ' +
          'reserved against a campaign nobody is running.',
      ),
  })
  .describe('Every field optional.');

/* -------------------------------------------------------- inventory check */

export const inventoryCheckBody = z
  .object({
    warehouseId: z
      .uuid()
      .optional()
      .describe('Check against one warehouse only. Omit to consider every warehouse.'),
  })
  .describe('Optional. Reads only — this endpoint reserves nothing.');

export const reserveBody = z
  .object({
    warehouseId: z
      .uuid()
      .optional()
      .describe('Draw only from this warehouse. Omit to allocate across all of them, largest first.'),
    allowPartial: z
      .boolean()
      .default(false)
      .describe(
        'By default a shortfall on ANY variant reserves NOTHING — a half-reserved campaign is worse ' +
          'than an unreserved one, because the shortfall is invisible until dispatch. Set true to hold ' +
          'what is available and accept the gap, which is the right call when the rest is on a PO.',
      ),
    note: z
      .string()
      .trim()
      .max(2_000)
      .nullish()
      .describe(
        'Why this hold was placed. `corporate_campaigns` has no note column, so this is recorded in the ' +
          'ADMIN AUDIT LOG against this operation rather than on the campaign — which is where the reason ' +
          'for a stock hold belongs anyway.',
      ),
  })
  .describe('Optional.');

export const releaseBody = z
  .object({
    reason: z
      .string()
      .trim()
      .max(2_000)
      .optional()
      .describe('Why the hold was given up. Recorded in the admin audit log, not on the campaign.'),
  })
  .describe('Optional.');

export const procurementPlanBody = z
  .object({
    warehouseId: z.uuid().optional().describe('Measure the shortfall against one warehouse only.'),
  })
  .describe('Optional. Reads only — this endpoint creates no purchase orders.');

export const fulfillmentPlanQuery = z.object({
  groupBy: z
    .enum(['warehouse', 'state', 'variant'])
    .default('warehouse')
    .describe('How to group the dispatch plan. `warehouse` is the picking view; `state` is the courier view.'),
});

/* ------------------------------------------------------------- responses */

const allocationRow = z.object({
  inventoryLevelId: z.uuid().describe('The stock level the units come from.'),
  warehouseId: z.uuid().describe('Warehouse.'),
  warehouseName: z.string().nullable().describe('Warehouse name.'),
  quantity: z.number().int().describe('Units taken from this warehouse. Always greater than zero.'),
});

export const demandLine = z.object({
  variantId: z.uuid().describe('The gift.'),
  sku: z.string().nullable().describe('Variant SKU.'),
  name: z.string().nullable().describe('Product title and option label.'),
  requiredQty: z.number().int().describe('Units this campaign needs. The recipient count for this variant.'),
  recipientCount: z.number().int().describe('Recipients wanting it.'),
  availableQty: z.number().int().describe('Sellable units across the warehouses in scope.'),
  allocatedQty: z.number().int().describe('What the allocation could cover.'),
  shortageQty: z
    .number()
    .int()
    .describe('`requiredQty − allocatedQty`, floored at 0. Non-zero means buy, make, or substitute.'),
  allocations: z
    .array(allocationRow)
    .describe('Where the units would come from. §88 — these sum to exactly `allocatedQty`.'),
});

export const inventoryCheckResponse = z.object({
  bulkOrderId: z.uuid().describe('The campaign.'),
  warehouseId: z.uuid().nullable().describe('The single warehouse checked, or null for all of them.'),
  recipientCount: z.number().int().describe('Recipients on the campaign.'),
  unassignedRecipientCount: z
    .number()
    .int()
    .describe(
      'Recipients with no gift chosen yet. Reported rather than skipped — “we cannot plan for 43 people” ' +
        'is the answer a planner needs, and a quiet total is the one that ships 43 empty boxes.',
    ),
  totalRequiredQty: z.number().int().describe('Units across every assigned recipient.'),
  totalAllocatableQty: z.number().int().describe('Units the warehouses in scope could cover right now.'),
  totalShortageQty: z.number().int().describe('The gap. 0 means the campaign is coverable today.'),
  canFulfil: z.boolean().describe('True when every line is fully covered.'),
  lines: z.array(demandLine).describe('One line per distinct gift.'),
});

export const reserveResponse = z.object({
  bulkOrderId: z.uuid().describe('The campaign.'),
  reservedUnits: z.number().int().describe('Units now held for this campaign, including any prior hold.'),
  newlyReservedUnits: z.number().int().describe('Units this call placed.'),
  shortageQty: z.number().int().describe('Units the campaign still needs. 0 on a full reservation.'),
  partial: z.boolean().describe('True when `allowPartial` was used and a gap remains.'),
  reservationIds: z.array(z.uuid()).describe('The `inventory_reservations` rows created.'),
  lines: z.array(demandLine).describe('What was held, per gift.'),
});

export const releaseResponse = z.object({
  bulkOrderId: z.uuid().describe('The campaign.'),
  releasedUnits: z.number().int().describe('Units returned to sellable stock.'),
  releasedReservationCount: z.number().int().describe('Reservation rows closed.'),
  remainingReservedUnits: z
    .number()
    .int()
    .describe('Still held. Zero unless a reservation was created concurrently.'),
});

export const procurementPlanLine = z.object({
  variantId: z.uuid().describe('What to buy.'),
  sku: z.string().nullable().describe('Variant SKU.'),
  name: z.string().nullable().describe('Product title and option label.'),
  shortageQty: z.number().int().describe('Units the campaign is short.'),
  orderQty: z
    .number()
    .int()
    .describe('What to put on the purchase order: `shortageQty` rounded UP to the supplier’s MOQ.'),
  supplierId: z.uuid().nullable().describe('Preferred supplier, or the cheapest when none is marked preferred.'),
  supplierName: z.string().nullable().describe('Supplier name. Null when nobody supplies this variant.'),
  leadTimeDays: z.number().int().nullable().describe('Stated lead time. Null when the supplier has never said.'),
  estimatedCostPaise: z
    .number()
    .int()
    .nullable()
    .describe('`orderQty × unit cost`, integer paise. Null when no cost is on file.'),
  orderByDate: z
    .string()
    .nullable()
    .describe('The date this must be ordered by to land before the window opens. Null without a window or lead time.'),
  meetsWindow: z
    .boolean()
    .describe('False when ordering today still misses the window. Stated as a fact, not softened into a warning.'),
});

export const procurementPlanResponse = z.object({
  bulkOrderId: z.uuid().describe('The campaign.'),
  windowStartOn: z.string().nullable().describe('The date lead times are measured back from.'),
  totalOrderQty: z.number().int().describe('Units to purchase across every line.'),
  estimatedTotalPaise: z
    .number()
    .int()
    .nullable()
    .describe(
      'Null when ANY line lacks a cost. A total that silently omits the three most expensive items is ' +
        'worse than no total.',
    ),
  lateLineCount: z.number().int().describe('Lines that cannot arrive in time however promptly they are ordered.'),
  longestLeadTimeDays: z.number().int().nullable().describe('The critical path, in days.'),
  lines: z.array(procurementPlanLine).describe('One line per variant to buy. Creates nothing — this is a plan.'),
});

const fulfillmentGroup = z.object({
  key: z.string().describe('Warehouse id, state code, or variant id, depending on `groupBy`.'),
  label: z.string().nullable().describe('Human-readable name for the group.'),
  recipientCount: z.number().int().describe('Recipients in this group.'),
  unitCount: z.number().int().describe('Units to dispatch from or to this group.'),
});

export const fulfillmentPlanResponse = z.object({
  bulkOrderId: z.uuid().describe('The campaign.'),
  groupBy: z.enum(['warehouse', 'state', 'variant']).describe('How the plan was grouped.'),
  reservedUnits: z.number().int().describe('Units currently held for this campaign.'),
  plannedUnits: z
    .number()
    .int()
    .describe(
      '§88 — this equals `reservedUnits` exactly when the campaign is fully reserved. A plan that ' +
        'dispatches 799 against a hold of 800 has one recipient nobody will ever ship to.',
    ),
  balanced: z
    .boolean()
    .describe('True when `plannedUnits` equals `reservedUnits`. False means reserve or release first.'),
  unreservedUnits: z.number().int().describe('Demand not yet held. Reserve before dispatching.'),
  groups: z.array(fulfillmentGroup).describe('The dispatch groups.'),
});

export const bulkOrderSummary = z.object({
  id: z.uuid().describe('Campaign id.'),
  campaignNo: z.string().describe('`CMP-2026-00001`, from the row-locked document series.'),
  accountId: z.uuid().describe('Corporate account.'),
  accountName: z.string().nullable().describe('Company name.'),
  quotationId: z.uuid().nullable().describe('Source quotation, if any.'),
  quotationNo: z.string().nullable().describe('Quotation number.'),
  name: z.string().describe('Campaign name.'),
  status: z.enum(CAMPAIGN_STATUSES).describe('Stored status.'),
  budgetPaise: z.number().int().describe('Approved spend, integer paise.'),
  windowStartOn: z.string().nullable().describe('First dispatch date.'),
  windowEndOn: z.string().nullable().describe('Last dispatch date.'),
  ownerId: z.uuid().nullable().describe('Staff owner.'),
  recipientCount: z.number().int().describe('Recipients uploaded.'),
  assignedRecipientCount: z.number().int().describe('Recipients with a gift chosen.'),
  dispatchedRecipientCount: z.number().int().describe('Recipients dispatched or delivered.'),
  reservedUnits: z.number().int().describe('Units currently held. Derived from `inventory_reservations`, never stored.'),
  createdAt: z.string().describe('ISO timestamp.'),
});

export const bulkOrderDetail = bulkOrderSummary.extend({
  totalRequiredQty: z.number().int().describe('Units across every assigned recipient.'),
  unassignedRecipientCount: z.number().int().describe('Recipients with no gift chosen.'),
  demand: z.array(
    z.object({
      variantId: z.uuid().describe('The gift.'),
      sku: z.string().nullable().describe('Variant SKU.'),
      name: z.string().nullable().describe('Product title and option label.'),
      requiredQty: z.number().int().describe('Units needed.'),
      recipientCount: z.number().int().describe('Recipients wanting it.'),
    }),
  ).describe('Demand, aggregated from the recipient list. There is no typed quantity to disagree with it.'),
});

export type BulkOrderListQuery = z.infer<typeof bulkOrderListQuery>;
export type CreateBulkOrderBody = z.infer<typeof createBulkOrderBody>;
export type UpdateBulkOrderBody = z.infer<typeof updateBulkOrderBody>;
export type InventoryCheckBody = z.infer<typeof inventoryCheckBody>;
export type ReserveBody = z.infer<typeof reserveBody>;
export type ReleaseBody = z.infer<typeof releaseBody>;
export type ProcurementPlanBody = z.infer<typeof procurementPlanBody>;
export type FulfillmentPlanQuery = z.infer<typeof fulfillmentPlanQuery>;
export type BulkOrderSummary = z.infer<typeof bulkOrderSummary>;
export type BulkOrderDetail = z.infer<typeof bulkOrderDetail>;
export type InventoryCheckResponse = z.infer<typeof inventoryCheckResponse>;
export type ReserveResponse = z.infer<typeof reserveResponse>;
export type ReleaseResponse = z.infer<typeof releaseResponse>;
export type ProcurementPlanResponse = z.infer<typeof procurementPlanResponse>;
export type FulfillmentPlanResponse = z.infer<typeof fulfillmentPlanResponse>;
