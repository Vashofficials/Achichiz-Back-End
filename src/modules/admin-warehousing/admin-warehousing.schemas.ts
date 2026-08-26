/**
 * Warehousing contracts — bin locations and inter-warehouse transfers.
 *
 * Two things are deliberately absent from every request body here:
 *
 *  - **`path`.** It is derived from the parent chain and written by the service.
 *    A client-settable materialised path is a denormalisation that is no longer
 *    derived from anything.
 *  - **`status`.** Transfers move through action endpoints (`/approve`,
 *    `/dispatch`), never through a status patch, so a status write can never
 *    skip the stock side effects the edge carries.
 */

import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import { LOCATION_KINDS, STOCK_TRANSFER_STATUSES } from '../../db/schema/index.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Matches `warehouse_locations_code_check`, so a bad code is 422 here rather than a 500 from the CHECK. */
const LOCATION_CODE = /^[A-Z0-9][A-Z0-9._-]{0,23}$/;

/* ------------------------------------------------------------ path params */

export const warehouseIdParam = z.object({
  warehouseId: z.uuid().describe('Warehouse id.'),
});

export const locationParams = z.object({
  warehouseId: z.uuid().describe('Warehouse id. The location must belong to it.'),
  locationId: z.uuid().describe('Location id.'),
});

export const transferIdParam = z.object({
  transferId: z.uuid().describe('Stock transfer id.'),
});

/* ---------------------------------------------------------------- locations */

export const locationKind = z
  .enum(LOCATION_KINDS)
  .describe('`zone` → `rack` → `shelf` → `bin`. A child may skip levels but never sit at or above its parent.');

export const locationListQuery = listQuery.extend({
  kind: z.enum(LOCATION_KINDS).optional().describe('Restrict to one level of the hierarchy.'),
  parentId: z.uuid().optional().describe('Direct children of this location only.'),
  pickable: z
    .enum(['true', 'false'])
    .optional()
    .describe('`true` for pickable locations only — the ones a pick list may route to.'),
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .describe('Include soft-deleted locations. Off by default.'),
  sort: z
    .string()
    .max(120)
    .optional()
    .describe('`path` (default), `code`, `kind`, `sortOrder`, `createdAt`. Prefix `-` for descending.'),
});

export const createLocationBody = z.object({
  parentId: z
    .uuid()
    .nullish()
    .describe('Parent location, or null/omitted for a top-level one. Must be in the same warehouse.'),
  kind: locationKind,
  code: z
    .string()
    .trim()
    .regex(LOCATION_CODE, 'Uppercase letters, digits, dot, underscore or hyphen; 1–24 characters, starting alphanumeric.')
    .describe('Segment code, unique within its parent — `B7`. Becomes the last segment of `path`.'),
  name: z.string().trim().max(120).nullish().describe('Human label, e.g. `Fragile goods, upper shelf`.'),
  isPickable: z
    .boolean()
    .default(true)
    .describe('False for staging, quarantine or overflow areas a pick list must not route to.'),
  sortOrder: z.number().int().min(0).max(100_000).default(0).describe('Display order among siblings.'),
});

export const updateLocationBody = z
  .object({
    parentId: z
      .uuid()
      .nullish()
      .describe(
        'Move the location under a different parent, or null to make it top-level. The whole subtree’s ' +
          '`path` is rewritten in the same transaction. A parent that is a descendant is rejected.',
      ),
    code: z
      .string()
      .trim()
      .regex(LOCATION_CODE, 'Uppercase letters, digits, dot, underscore or hyphen; 1–24 characters, starting alphanumeric.')
      .optional()
      .describe('Rename the segment. Rewrites `path` for this location and every descendant.'),
    name: z.string().trim().max(120).nullish().describe('Human label, or null to clear.'),
    isPickable: z.boolean().optional().describe('Whether pick lists may route here.'),
    sortOrder: z.number().int().min(0).max(100_000).optional().describe('Display order among siblings.'),
  })
  .describe('Every field is optional. `kind` is not editable — re-parenting a whole subtree is the honest operation.');

export const locationResponse = z.object({
  id: z.uuid().describe('Location id.'),
  warehouseId: z.uuid().describe('Owning warehouse.'),
  parentId: z.uuid().nullable().describe('Parent location, or null for a top-level one.'),
  kind: locationKind,
  code: z.string().describe('Segment code — the last part of `path`.'),
  name: z.string().nullable().describe('Human label.'),
  path: z
    .string()
    .describe('Materialised full path, `A/R3/S2/B7`. Server-derived — never accepted in a request body.'),
  depth: z.number().int().describe('Number of ancestors, derived from `path`. 0 for a top-level location.'),
  isPickable: z.boolean().describe('Whether pick lists may route here.'),
  sortOrder: z.number().int().describe('Display order among siblings.'),
  childCount: z.number().int().describe('Number of live direct children.'),
  stockedLevelCount: z.number().int().describe('How many inventory levels currently point at this location.'),
  archivedAt: z.string().nullable().describe('ISO timestamp when archived, or null while live.'),
  createdAt: z.string().describe('ISO timestamp.'),
});

/* ------------------------------------------------------ warehouse inventory */

export const warehouseInventoryQuery = listQuery.extend({
  locationId: z.uuid().optional().describe('Only levels stored at this bin location.'),
  lowStock: z
    .enum(['true', 'false'])
    .optional()
    .describe('`true` returns only levels where available ≤ reorder point.'),
  sort: z
    .string()
    .max(120)
    .optional()
    .describe('`sku` (default), `onHandQty`, `availableQty`, `reservedQty`, `incomingQty`, `lastMovementAt`.'),
});

export const warehouseInventoryRow = z.object({
  inventoryLevelId: z.uuid().describe('Inventory level id. This is what transfer and return lines lock on.'),
  stockableKind: z
    .enum(['variant', 'hamper_item', 'packaging'])
    .describe('Which of the three stockable kinds this level tracks. Exactly one, enforced by a CHECK.'),
  stockableId: z.uuid().describe('Id of the variant, hamper item or packaging material.'),
  sku: z.string().nullable().describe('SKU of the stockable, when it has one.'),
  title: z.string().nullable().describe('Display name of the stockable.'),
  onHandQty: z.number().int().describe('Physically present. Never negative.'),
  reservedQty: z.number().int().describe('Committed to carts and orders.'),
  availableQty: z.number().int().describe('`on_hand - reserved`, a GENERATED column. Cannot drift.'),
  incomingQty: z
    .number()
    .int()
    .describe('Expected to arrive: sent purchase orders plus transfers dispatched to this warehouse.'),
  reorderPoint: z.number().int().describe('Available at or below this raises a reorder suggestion.'),
  reorderQty: z.number().int().describe('Suggested quantity when reordering.'),
  locationId: z.uuid().nullable().describe('Bin location, when one is assigned.'),
  locationPath: z.string().nullable().describe('Materialised path of that location, e.g. `A/R3/S2/B7`.'),
  binLocation: z.string().nullable().describe('Legacy free-text bin, kept for rows that predate locations.'),
  lastMovementAt: z.string().nullable().describe('ISO timestamp of the last ledger write against this level.'),
});

/* ---------------------------------------------------------------- transfers */

export const transferStatus = z
  .enum(STOCK_TRANSFER_STATUSES)
  .describe(
    'The five statuses the database allows. `in_transit` covers both "dispatched" and "in transit" — ' +
      'dispatch is the event that puts stock in transit. `received` is terminal.',
  );

export const transferListQuery = listQuery.extend({
  status: z.string().max(200).optional().describe('One status or a comma-separated list.'),
  fromWarehouseId: z.uuid().optional().describe('Source warehouse.'),
  toWarehouseId: z.uuid().optional().describe('Destination warehouse.'),
  warehouseId: z.uuid().optional().describe('Either end — source OR destination.'),
  etaFrom: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').optional().describe('`YYYY-MM-DD`. Inclusive lower bound on ETA.'),
  etaTo: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').optional().describe('`YYYY-MM-DD`. Inclusive upper bound on ETA.'),
  sort: z.string().max(120).optional().describe('`-createdAt` (default), `createdAt`, `transferNo`, `status`, `etaOn`.'),
});

/**
 * A transfer line names a stockable, not an inventory level.
 *
 * That is what `stock_transfer_lines` stores, and it is the right shape: the
 * SOURCE level is resolved at dispatch and the DESTINATION level at receive.
 * Freezing a level id at draft time would pin the transfer to a row that may not
 * exist at the far end yet.
 */
export const transferLineInput = z
  .object({
    variantId: z.uuid().optional().describe('Product variant to move. Exactly one of this or `hamperItemId`.'),
    hamperItemId: z.uuid().optional().describe('Loose hamper item to move. Exactly one of this or `variantId`.'),
    quantity: z.number().int().positive().max(1_000_000).describe('Units to send. Must be positive.'),
  })
  .refine((line) => Boolean(line.variantId) !== Boolean(line.hamperItemId), {
    message: 'Give exactly one of `variantId` or `hamperItemId` — the database CHECK refuses both or neither.',
    path: ['variantId'],
  });

export const createTransferBody = z.object({
  fromWarehouseId: z.uuid().describe('Source warehouse. Stock leaves here at dispatch.'),
  toWarehouseId: z.uuid().describe('Destination warehouse. Must differ from the source.'),
  etaOn: z
    .string()
    .regex(ISO_DATE, 'Use YYYY-MM-DD.')
    .nullish()
    .describe('`YYYY-MM-DD` the goods are expected to land. Informational.'),
  lines: z.array(transferLineInput).min(1).max(200).describe('At least one line. A transfer of nothing is not a document.'),
});

export const receiveTransferBody = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.uuid().describe('Transfer line id, from the transfer detail response.'),
        receivedQty: z
          .number()
          .int()
          .min(0)
          .max(1_000_000)
          .describe('Units that actually arrived. May be less than sent; never more.'),
      }),
    )
    .max(200)
    .optional()
    .describe(
      'Per-line arrivals. Omit entirely to receive every line in full, which is the common case. Any ' +
        'shortfall is goods lost in transit: they already left the source ledger and are simply never ' +
        'credited to the destination.',
    ),
  note: z.string().trim().max(500).optional().describe('Recorded on each `transfer_in` movement.'),
});

export const cancelTransferBody = z.object({
  reason: z.string().trim().min(3).max(400).describe('Why. Recorded for the audit trail.'),
});

export const transferLineResponse = z.object({
  id: z.uuid().describe('Transfer line id. Pass this back when receiving.'),
  variantId: z.uuid().nullable().describe('Product variant, when the line moves one.'),
  hamperItemId: z.uuid().nullable().describe('Hamper item, when the line moves one.'),
  sku: z.string().nullable().describe('SKU of the stockable.'),
  title: z.string().nullable().describe('Display name of the stockable.'),
  sentQty: z.number().int().describe('Units dispatched from the source.'),
  receivedQty: z.number().int().describe('Units credited at the destination. Zero until receipt.'),
  shortQty: z.number().int().describe('`sentQty - receivedQty` once received — units lost in transit.'),
});

export const transferSummary = z.object({
  id: z.uuid().describe('Transfer id.'),
  transferNo: z.string().describe('`TRF-2026-00061`, from the document-number series.'),
  status: transferStatus,
  fromWarehouseId: z.uuid().describe('Source warehouse.'),
  fromWarehouseName: z.string().nullable().describe('Source warehouse name.'),
  toWarehouseId: z.uuid().describe('Destination warehouse.'),
  toWarehouseName: z.string().nullable().describe('Destination warehouse name.'),
  lineCount: z.number().int().describe('Number of lines.'),
  totalSentQty: z.number().int().describe('Sum of `sentQty` across lines.'),
  totalReceivedQty: z.number().int().describe('Sum of `receivedQty` across lines.'),
  inTransitQty: z
    .number()
    .int()
    .describe('Units currently in neither warehouse’s available stock. Non-zero only while `in_transit`.'),
  etaOn: z.string().nullable().describe('`YYYY-MM-DD`, or null.'),
  dispatchedAt: z.string().nullable().describe('ISO timestamp, or null.'),
  receivedAt: z.string().nullable().describe('ISO timestamp, or null.'),
  createdAt: z.string().describe('ISO timestamp.'),
});

export const availableTransferAction = z.object({
  action: z.enum(['approve', 'dispatch', 'receive', 'cancel']).describe('The endpoint this edge corresponds to.'),
  to: transferStatus.describe('The status the transfer lands in.'),
  label: z.string().describe('Human label for the button.'),
  movesStock: z.boolean().describe('True when taking this edge writes to the ledger.'),
  sideEffects: z.array(z.string()).describe('What else happens. Render as a confirmation warning.'),
});

export const transferDetail = transferSummary.extend({
  requestedBy: z.uuid().nullable().describe('Staff member who raised it.'),
  lines: z.array(transferLineResponse).describe('The lines.'),
  availableActions: z
    .array(availableTransferAction)
    .describe('Legal edges from the current status, so the console never renders a button that 422s.'),
});

export type LocationResponse = z.infer<typeof locationResponse>;
export type WarehouseInventoryRow = z.infer<typeof warehouseInventoryRow>;
export type TransferSummaryResponse = z.infer<typeof transferSummary>;
export type TransferDetailResponse = z.infer<typeof transferDetail>;
