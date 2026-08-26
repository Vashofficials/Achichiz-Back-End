/**
 * Bundle contracts.
 *
 * Money is integer paise. `savingsPaise` is DERIVED from the component prices on
 * every read and is deliberately absent from the request bodies — see the note
 * on `bundleSavingsPaise` in `admin-bundles.availability.ts`.
 *
 * There is no `stockQty` field anywhere in this file, on purpose (§91). Ask
 * `/availability` instead.
 */

import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import { BUNDLE_STATUSES } from '../../db/schema/index.js';

const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const paise = (what: string) =>
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe(`Integer paise. ${what}`);

/* ------------------------------------------------------------ path params */

export const bundleIdParam = z.object({
  bundleId: z.uuid().describe('Bundle id.'),
});

/* ------------------------------------------------------------------ query */

export const bundleListQuery = listQuery.extend({
  status: z
    .string()
    .max(120)
    .optional()
    .describe('One status or a comma-separated list: `active`, `draft`, `archived`.'),
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .describe('Include soft-deleted bundles. Archived-by-status is a separate thing — use `status`.'),
  live: z
    .enum(['true', 'false'])
    .optional()
    .describe(
      '`true` returns only bundles sellable right now: status `active` AND inside the ' +
        '`startsAt`/`endsAt` window. A bundle whose window has closed is still `active` in the ' +
        'column — the schedule is what expires it, not the status.',
    ),
  variantId: z
    .uuid()
    .optional()
    .describe('Only bundles that contain this variant. The question to ask before discontinuing one.'),
  sort: z
    .string()
    .max(120)
    .optional()
    .describe('`createdAt` (default, descending), `name`, `handle`, `bundlePricePaise`, `startsAt`.'),
});

export const bundleAvailabilityQuery = z.object({
  quantity: z.coerce
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .default(1)
    .describe('How many bundles to ask about. Drives `shortage` and `canFulfil`, not `fulfillableQty`.'),
  warehouseId: z
    .uuid()
    .optional()
    .describe(
      'Compute against ONE warehouse. Omit for the network total — which assumes a split shipment ' +
        'is acceptable, and that is a fulfilment decision with a cost attached, not an availability fact.',
    ),
});

/* ------------------------------------------------------------------ bodies */

const bundleItemInput = z.object({
  variantId: z.uuid().describe('Product variant that goes in the box.'),
  quantity: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(1)
    .describe('Units of this variant per ONE bundle. `CHECK (quantity > 0)`.'),
  position: z.number().int().min(0).max(10_000).default(0).describe('Display order in the console and on the PDP.'),
});

export const createBundleBody = z.object({
  handle: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(HANDLE, 'Lower-case words joined by single hyphens, e.g. `diwali-desk-set`.')
    .describe('URL slug. Partial-unique among non-deleted bundles.'),
  name: z.string().trim().min(2).max(160).describe('Display name.'),
  bundlePricePaise: paise('What the customer pays for the whole box. 149900 = ₹1,499.00.'),
  status: z
    .enum(BUNDLE_STATUSES)
    .default('draft')
    .describe('`draft` until someone means it. Only `active` bundles are sellable.'),
  startsAt: z.iso.datetime().nullish().describe('ISO timestamp. Null means live as soon as it is active.'),
  endsAt: z.iso.datetime().nullish().describe('ISO timestamp. Null means it never expires on its own.'),
  items: z
    .array(bundleItemInput)
    .min(1)
    .max(50)
    .describe(
      'At least one. A bundle with no items has no components to compute availability from and would ' +
        'report itself unfulfillable forever.',
    ),
});

export const updateBundleBody = z
  .object({
    handle: z.string().trim().min(2).max(80).regex(HANDLE, 'Lower-case hyphenated slug.').optional(),
    name: z.string().trim().min(2).max(160).optional().describe('Display name.'),
    bundlePricePaise: paise('New bundle price.').optional(),
    status: z.enum(BUNDLE_STATUSES).optional().describe('`active`, `draft` or `archived`.'),
    startsAt: z.iso.datetime().nullish().describe('ISO timestamp, or null to clear.'),
    endsAt: z.iso.datetime().nullish().describe('ISO timestamp, or null to clear.'),
    items: z
      .array(bundleItemInput)
      .min(1)
      .max(50)
      .optional()
      .describe(
        'REPLACES the item list wholesale when present. Omit it to leave the contents alone. ' +
          '`bundle_items` is keyed by (bundleId, variantId) with no surrogate id, so there is nothing ' +
          'stable to patch a single row by.',
      ),
  })
  .describe('Every field optional.');

/* --------------------------------------------------------------- responses */

export const bundleItemResponse = z.object({
  variantId: z.uuid().describe('The variant.'),
  sku: z.string().nullable().describe('Variant SKU.'),
  title: z.string().nullable().describe('Product title and option label.'),
  quantity: z.number().int().describe('Units per ONE bundle.'),
  position: z.number().int().describe('Display order.'),
  unitPricePaise: z.number().int().describe('The variant’s own list price, integer paise.'),
  archived: z.boolean().describe('True when the variant itself is soft-deleted — a bundle that can never ship.'),
});

export const bundleSummary = z.object({
  id: z.uuid().describe('Bundle id.'),
  handle: z.string().describe('URL slug.'),
  name: z.string().describe('Display name.'),
  bundlePricePaise: z.number().int().describe('What the customer pays, integer paise.'),
  componentTotalPaise: z.number().int().describe('SUM(component list price × quantity), integer paise.'),
  savingsPaise: z
    .number()
    .int()
    .describe(
      'Derived, never stored: `componentTotal − bundlePrice`. Negative means the bundle costs more ' +
        'than its parts, which is a pricing mistake rather than a number to clamp.',
    ),
  savingsBp: z.number().int().describe('The saving as basis points of the component total. 2500 = 25%.'),
  status: z.enum(BUNDLE_STATUSES).describe('Stored status.'),
  isLive: z.boolean().describe('`active` AND inside the schedule window, evaluated now.'),
  itemCount: z.number().int().describe('Distinct variants in the box.'),
  unitCount: z.number().int().describe('Total units in the box, quantities summed.'),
  startsAt: z.string().nullable().describe('ISO timestamp or null.'),
  endsAt: z.string().nullable().describe('ISO timestamp or null.'),
  archivedAt: z.string().nullable().describe('ISO timestamp when soft-deleted, or null.'),
  createdAt: z.string().describe('ISO timestamp.'),
  updatedAt: z.string().describe('ISO timestamp.'),
});

export const bundleDetail = bundleSummary.extend({
  items: z.array(bundleItemResponse).describe('The contents, in `position` order.'),
});

export const bundleComponentAvailability = z.object({
  variantId: z.uuid().describe('The component.'),
  sku: z.string().nullable().describe('Component SKU.'),
  title: z.string().nullable().describe('Component name.'),
  required: z.number().int().describe('Units consumed by ONE bundle.'),
  available: z
    .number()
    .int()
    .describe('Sellable units — `on_hand − reserved`, the GENERATED column. Never on-hand alone.'),
  onHand: z.number().int().describe('Physically present, for context.'),
  reserved: z.number().int().describe('Already promised to a cart, order or hold.'),
  shortage: z
    .number()
    .int()
    .describe('Units still needed to build `quantity` bundles. 0 when this component covers it.'),
  fulfillableQty: z.number().int().describe('Whole bundles this component alone could cover.'),
  isLimiting: z.boolean().describe('True when this component is setting the MIN. These are what to reorder.'),
});

export const bundleAvailabilityResponse = z.object({
  bundleId: z.uuid().describe('The bundle.'),
  handle: z.string().describe('URL slug.'),
  warehouseId: z.uuid().nullable().describe('The warehouse asked about, or null for the network total.'),
  requestedQty: z.number().int().describe('The quantity the question was asked about.'),
  fulfillableQty: z
    .number()
    .int()
    .describe(
      '`MIN(floor(componentAvailable / requiredQty))`. Computed on every read; there is no stock row ' +
        'for a bundle and there never will be (§91).',
    ),
  canFulfil: z.boolean().describe('`fulfillableQty >= quantity`.'),
  limitingVariantIds: z.array(z.uuid()).describe('The components setting the constraint.'),
  components: z.array(bundleComponentAvailability).describe('Per-component working, in bundle order.'),
});

export const bundleArchiveResponse = z.object({
  id: z.uuid().describe('Bundle id.'),
  handle: z.string().describe('URL slug — freed for reuse by a new bundle once archived.'),
  status: z.enum(BUNDLE_STATUSES).describe('Always `archived` after this call.'),
  archivedAt: z.string().describe('ISO timestamp of the soft delete.'),
});

export type BundleListQuery = z.infer<typeof bundleListQuery>;
export type BundleAvailabilityQuery = z.infer<typeof bundleAvailabilityQuery>;
export type CreateBundleBody = z.infer<typeof createBundleBody>;
export type UpdateBundleBody = z.infer<typeof updateBundleBody>;
export type BundleSummary = z.infer<typeof bundleSummary>;
export type BundleDetail = z.infer<typeof bundleDetail>;
export type BundleAvailabilityResponse = z.infer<typeof bundleAvailabilityResponse>;
export type BundleArchiveResponse = z.infer<typeof bundleArchiveResponse>;
