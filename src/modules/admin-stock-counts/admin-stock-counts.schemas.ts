/**
 * Stock-count contracts.
 *
 * Quantities are integers of the stockable's own unit. There is no money on a
 * count sheet at all: valuing a variance is a finance question answered from the
 * ledger afterwards, and a `varianceValuePaise` on this document would be a
 * number computed at count time from a cost that may change before approval.
 */

import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import { STOCK_COUNT_KINDS, STOCK_COUNT_STATUSES } from '../../db/schema/index.js';
import { COUNT_ACTIONS } from './admin-stock-counts.state.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = (what: string) =>
  z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').describe(`\`YYYY-MM-DD\`. ${what}`);

/** Quantities are counted units, never money. Capped so a fat-fingered paste is a 422, not a write. */
const qty = (what: string) => z.number().int().min(0).max(10_000_000).describe(what);

/* ------------------------------------------------------------ path params */

export const countIdParam = z.object({
  countId: z.uuid().describe('Stock count id.'),
});

/* ------------------------------------------------------------------ list */

export const countListQuery = listQuery.extend({
  warehouseId: z.uuid().optional().describe('Only counts for this warehouse.'),
  locationId: z
    .uuid()
    .optional()
    .describe('Only counts scoped to this location. Whole-warehouse counts have no location and are excluded.'),
  status: z
    .string()
    .max(120)
    .optional()
    .describe(
      `Comma-separated. One or more of: ${STOCK_COUNT_STATUSES.join(', ')}. An unrecognised value is a 400 ` +
        'rather than a silently empty page.',
    ),
  kind: z.enum(STOCK_COUNT_KINDS).optional().describe('`full` (everything), `cycle` (a rolling slice), or `spot`.'),
  scheduledFrom: isoDate('Earliest `scheduledFor`, inclusive.').optional(),
  scheduledTo: isoDate('Latest `scheduledFor`, inclusive.').optional(),
  sort: z
    .string()
    .max(120)
    .optional()
    .describe('`-createdAt` (default), `countNo`, `status`, `scheduledFor`, `completedAt`.'),
});

/** Item paging lives on the DETAIL route: a full-warehouse count has thousands of lines. */
export const countDetailQuery = z.object({
  itemPage: z.coerce.number().int().positive().default(1).describe('1-indexed page of count lines.'),
  itemPerPage: z.coerce
    .number()
    .int()
    .positive()
    .max(200)
    .default(50)
    .describe('Count lines per page. Maximum 200. The header totals always cover the WHOLE count, not the page.'),
  onlyVariances: z
    .enum(['true', 'false'])
    .default('false')
    .describe('`true` returns only counted lines whose variance is non-zero — the work queue for an approver.'),
  uncountedOnly: z
    .enum(['true', 'false'])
    .default('false')
    .describe('`true` returns only lines nobody has counted yet — the work queue for a counter.'),
});

/* ----------------------------------------------------------------- create */

export const createCountBody = z.object({
  warehouseId: z.uuid().describe('The warehouse being counted. Stock is per warehouse; there is no global count.'),
  locationId: z
    .uuid()
    .nullish()
    .describe(
      'Narrow the count to one zone/rack/shelf/bin. Null or omitted counts the WHOLE warehouse. The scope ' +
        'includes descendants: counting a zone counts every bin under it.',
    ),
  kind: z
    .enum(STOCK_COUNT_KINDS)
    .default('cycle')
    .describe(
      '`full` is a wall-to-wall stocktake, `cycle` is the rolling slice most warehouses run weekly, `spot` ' +
        'is one operator checking a handful of bins. The kind does not change the arithmetic — it is how the ' +
        'count is reported on afterwards.',
    ),
  scheduledFor: isoDate('When the counting is meant to happen. Advisory; nothing enforces it.').optional(),
  note: z.string().trim().max(2_000).nullish().describe('Why this count was raised.'),
});

/* ------------------------------------------------------------------ start */

export const startCountBody = z
  .object({
    countedBy: z
      .uuid()
      .nullish()
      .describe('Staff member doing the counting. Defaults to the caller.'),
  })
  .describe('Optional. Starting a count is what FREEZES `systemQty` for every level in scope.');

/* ------------------------------------------------------------------ items */

export const countItemInput = z.object({
  sku: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('SKU of the item on the shelf. It must already be in this count’s scope — see the endpoint notes.'),
  countedQty: qty('What was physically counted. Zero is a legitimate answer and means the bin is empty.'),
  recountQty: qty('Optional second count, when the first showed a variance worth re-checking.').optional(),
  reason: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .describe('Why the numbers differ, in the counter’s words. Copied onto the movement note at approval.'),
});

export const submitCountItemsBody = z.object({
  items: z
    .array(countItemInput)
    .min(1)
    .max(500)
    .describe('Up to 500 lines. All-or-nothing: one bad SKU rejects the whole submission and writes nothing.'),
});

/* --------------------------------------------------------------- complete */

export const completeCountBody = z
  .object({
    allowUncounted: z
      .boolean()
      .default(false)
      .describe(
        'Completing a sheet with lines nobody counted is refused unless this is `true`. It is an explicit ' +
          'acknowledgement, not a formality: an uncounted line is simply skipped at approval, so leaving one ' +
          'silently means that SKU was never checked despite appearing on a signed-off count.',
      ),
    note: z.string().trim().max(2_000).nullish().describe('Closing note from the counter.'),
  })
  .describe('Marks the counting finished. No stock moves here — completion is not approval.');

/* ---------------------------------------------------------------- approve */

export const approveCountBody = z
  .object({
    note: z.string().trim().max(2_000).nullish().describe('Approver’s note. Written onto every movement this posts.'),
  })
  .describe('Approval is the ONLY step that moves stock, and it moves it by exactly the variance.');

/* -------------------------------------------------------------- responses */

const countAction = z.enum(COUNT_ACTIONS);

export const countTransition = z.object({
  to: z.enum(STOCK_COUNT_STATUSES).describe('Status this edge leads to.'),
  action: countAction.describe('The action that takes it there.'),
  label: z.string().describe('Human label for the edge.'),
  movesStock: z.boolean().describe('Whether taking this edge writes to `inventory_levels`. Only `approve` does.'),
  sideEffects: z.array(z.string()).describe('What else happens when it is taken.'),
});

export const countItemResponse = z.object({
  id: z.uuid().describe('Count line id.'),
  inventoryLevelId: z.uuid().describe('The (item, warehouse) level this line counts.'),
  itemKind: z.enum(['variant', 'hamper_item', 'packaging']).describe('Which of the three stockables this is.'),
  itemId: z.uuid().describe('Id of the variant, hamper item or packaging material.'),
  sku: z.string().nullable().describe('Our SKU for it.'),
  name: z.string().nullable().describe('Display name.'),
  binLocation: z.string().nullable().describe('Free-text bin on the level, if one is set.'),
  locationPath: z.string().nullable().describe('Materialised location path, e.g. `A/R3/S2/B7`.'),
  systemQty: z
    .number()
    .int()
    .describe('What the system believed when the count STARTED. Frozen — never re-read at approval.'),
  countedQty: z.number().int().nullable().describe('What was counted. Null means nobody has counted this line yet.'),
  varianceQty: z
    .number()
    .int()
    .nullable()
    .describe(
      'countedQty − systemQty, or null when uncounted. Note this is NOT the raw generated column: that reads ' +
        '`COALESCE(counted,0) − system`, which for an uncounted line looks like a full write-off.',
    ),
  recountQty: z.number().int().nullable().describe('Second count, when one was taken.'),
  reason: z.string().nullable().describe('The counter’s explanation.'),
  countedAt: z.string().nullable().describe('ISO timestamp of the count.'),
  countedBy: z.uuid().nullable().describe('Staff member who counted it.'),
});

export const countTotalsResponse = z.object({
  itemsInScope: z.number().int().describe('Lines frozen at start. The size of the sheet.'),
  itemsCounted: z.number().int().describe('Lines with a `countedQty`.'),
  itemsUncounted: z.number().int().describe('Lines still blank. These are SKIPPED at approval, never zeroed.'),
  itemsWithVariance: z.number().int().describe('Counted lines that disagree with the frozen system quantity.'),
  netVarianceQty: z
    .number()
    .int()
    .describe('Sum of signed variances. Reported alongside `absVarianceQty` because +5 and −5 net to a clean zero.'),
  absVarianceQty: z.number().int().describe('Sum of absolute variances. This is the number that measures accuracy.'),
});

export const countSummary = z.object({
  id: z.uuid().describe('Stock count id.'),
  countNo: z.string().describe('`CNT-2026-00001`, from the row-locked document series.'),
  warehouseId: z.uuid().describe('Warehouse counted.'),
  warehouseCode: z.string().nullable().describe('Warehouse short code.'),
  locationId: z.uuid().nullable().describe('Location scope, or null for the whole warehouse.'),
  locationPath: z.string().nullable().describe('Materialised path of the scoped location.'),
  kind: z.enum(STOCK_COUNT_KINDS).describe('`full`, `cycle` or `spot`.'),
  status: z.enum(STOCK_COUNT_STATUSES).describe('Stored status. Five values, fixed by the database CHECK.'),
  scheduledFor: z.string().nullable().describe('`YYYY-MM-DD`, or null.'),
  startedAt: z.string().nullable().describe('ISO timestamp when `systemQty` was frozen.'),
  completedAt: z.string().nullable().describe('ISO timestamp when counting finished.'),
  approvedAt: z.string().nullable().describe('ISO timestamp when the variance was posted.'),
  createdBy: z.uuid().nullable().describe('Who raised it.'),
  countedBy: z.uuid().nullable().describe('Who counted it.'),
  approvedBy: z.uuid().nullable().describe('Who approved it. Never null on an approved count — a CHECK enforces it.'),
  note: z.string().nullable().describe('Free text.'),
  totals: countTotalsResponse.describe('Roll-up over the WHOLE count, not the returned page of lines.'),
  createdAt: z.string().describe('ISO timestamp.'),
});

export const countDetail = countSummary.extend({
  items: z.array(countItemResponse).describe('One page of count lines. Page with `?itemPage` / `?itemPerPage`.'),
  itemPage: z.number().int().describe('Which page of lines this is.'),
  itemPerPage: z.number().int().describe('Lines per page.'),
  itemTotal: z.number().int().describe('Lines matching the line filter, across all pages.'),
  transitions: z.array(countTransition).describe('What can legally happen next, from the state machine itself.'),
});

export const countMovementResponse = z.object({
  movementId: z.string().describe('Ledger row id. BIGINT, carried as a decimal STRING — a JSON number loses precision past 2^53.'),
  inventoryLevelId: z.uuid().describe('Level the movement was posted against.'),
  sku: z.string().nullable().describe('SKU adjusted.'),
  systemQty: z.number().int().describe('The frozen figure the variance was measured against.'),
  countedQty: z.number().int().describe('What was counted.'),
  varianceQty: z.number().int().describe('The signed quantity this movement moved. Never zero — zero writes no row.'),
  onHandQtyBefore: z.number().int().describe('On-hand immediately before the adjustment.'),
  onHandQty: z.number().int().describe('On-hand immediately after. Equals the movement’s `balanceAfter`.'),
  reservedQty: z.number().int().describe('Reserved units, untouched by a count.'),
  availableQty: z.number().int().describe('`onHandQty − reservedQty`, the GENERATED column.'),
});

export const countApprovalResult = z.object({
  count: countSummary.describe('The count, now `approved`.'),
  itemsAdjusted: z
    .number()
    .int()
    .describe('How many movements were written. Smaller than `itemsCounted` on a healthy count — zero variance writes nothing.'),
  itemsSkippedUncounted: z.number().int().describe('Lines nobody counted. Deliberately untouched.'),
  netVarianceQty: z.number().int().describe('Sum of the signed adjustments posted.'),
  absVarianceQty: z.number().int().describe('Sum of their absolute values.'),
  movements: z
    .array(countMovementResponse)
    .describe('One entry per adjustment, in the ascending inventory-level-id order the locks were taken.'),
});

export const submitItemsResult = z.object({
  countId: z.uuid().describe('The count.'),
  accepted: z.number().int().describe('Lines recorded. Equals the number submitted — this endpoint is all-or-nothing.'),
  items: z.array(countItemResponse).describe('The lines as they now stand, variance included.'),
  totals: countTotalsResponse.describe('Roll-up over the whole count after this submission.'),
});

export type CountListQuery = z.infer<typeof countListQuery>;
export type CountDetailQuery = z.infer<typeof countDetailQuery>;
export type CreateCountBody = z.infer<typeof createCountBody>;
export type StartCountBody = z.infer<typeof startCountBody>;
export type SubmitCountItemsBody = z.infer<typeof submitCountItemsBody>;
export type CompleteCountBody = z.infer<typeof completeCountBody>;
export type ApproveCountBody = z.infer<typeof approveCountBody>;
export type CountSummary = z.infer<typeof countSummary>;
export type CountDetail = z.infer<typeof countDetail>;
export type CountItemResponse = z.infer<typeof countItemResponse>;
export type CountApprovalResult = z.infer<typeof countApprovalResult>;
export type SubmitItemsResult = z.infer<typeof submitItemsResult>;
