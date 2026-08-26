import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok, paginated, pageMeta } from '../../lib/http.js';
import * as bundlesService from './admin-bundles.service.js';
import {
  bundleArchiveResponse,
  bundleAvailabilityQuery,
  bundleAvailabilityResponse,
  bundleDetail,
  bundleIdParam,
  bundleListQuery,
  bundleSummary,
  createBundleBody,
  updateBundleBody,
} from './admin-bundles.schemas.js';

/**
 * Bundles — a fixed set of variants sold as one box.
 *
 * The whole module exists to make one thing impossible: a bundle with its own
 * stock number. A bundle is an assertion about other rows ("one bottle, one pen,
 * one diary"), so its availability is COMPUTED from those rows every time it is
 * asked for and never stored (§91). There is no `stockQty` in any request or
 * response here, and `/availability` is the only endpoint that answers the
 * question.
 *
 * CRUD sits under `promotions:*` because a bundle is a merchandising object.
 * `/availability` sits under `inventory:view` because it reads the stock
 * position — a marketer may build the box without being able to read the
 * warehouse.
 */
export const adminBundlesRouter: Router = Router();

const TAG = 'Admin bundles';

/* ------------------------------------------------------------------ list */

defineRoute(adminBundlesRouter, {
  method: 'get',
  path: '/v1/admin/bundles',
  surface: 'admin',
  operationId: 'adminListBundles',
  summary: 'List bundles',
  description:
    'Every bundle with its contents summarised — `itemCount` distinct variants, `unitCount` units in the ' +
    'box — and the saving worked out.\n\n' +
    '`savingsPaise` is DERIVED on every read (`SUM(component price × quantity) − bundlePrice`) and is not ' +
    'a column. A component’s price changes without the bundle being touched, and a stored saving would ' +
    'then be advertising a discount that no longer exists. A negative saving is returned as-is: it means ' +
    'the box costs more than its parts, which is a pricing mistake worth seeing rather than clamping to zero.\n\n' +
    '`isLive` is not `status`. A bundle is sellable when it is `active` AND inside its `startsAt`/`endsAt` ' +
    'window; a window that has closed leaves the status untouched, so filtering on `status=active` alone ' +
    'returns bundles nobody can buy. `?live=true` applies the real test.\n\n' +
    '`?variantId=` returns every bundle containing that variant — the question to ask before ' +
    'discontinuing it.\n\n' +
    'There is no stock figure on this screen. Ask `/availability` per bundle.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'promotions', action: 'view' },
  request: { query: bundleListQuery },
  responses: {
    200: { description: 'A page of bundles.', schema: z.array(bundleSummary) },
    400: { description: 'An unrecognised status value.' },
  },
  handler: async ({ query }) => {
    const { items, total } = await bundlesService.listBundles(query);
    return paginated(items, pageMeta(total, query.page, query.perPage));
  },
});

/* ---------------------------------------------------------------- create */

defineRoute(adminBundlesRouter, {
  method: 'post',
  path: '/v1/admin/bundles',
  surface: 'admin',
  operationId: 'adminCreateBundle',
  summary: 'Create a bundle',
  description:
    'The bundle and its contents in ONE transaction. A bundle with no items is refused by the schema ' +
    'rather than created empty: an empty bundle has no components to compute availability from, and the ' +
    'honest answer for it would be `fulfillableQty: 0` forever.\n\n' +
    '`items` is validated before anything is written. A duplicate variant collides with ' +
    '`PRIMARY KEY (bundle_id, variant_id)` and a discontinued variant would produce a bundle that can ' +
    'never ship; both come back as field-level issues instead of a constraint violation from three ' +
    'layers down.\n\n' +
    '**No stock row is created.** That is the point of the module — see §91 and `/availability`.\n\n' +
    'Handles are partial-unique among non-archived bundles, so archiving one frees its slug for a ' +
    'replacement. A clash with a live bundle is a 409.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'promotions', action: 'create' },
  rateLimit: 'default',
  request: { body: createBundleBody },
  responses: {
    201: { description: 'The bundle and its contents.', schema: bundleDetail },
    409: { description: 'That handle already belongs to a live bundle.' },
    422: { description: '`invalid_bundle_items` (duplicate or discontinued variant) or `invalid_schedule_window`.' },
  },
  handler: async ({ body }) => created(await bundlesService.createBundle(body)),
});

/* ---------------------------------------------------------- availability */

defineRoute(adminBundlesRouter, {
  method: 'get',
  path: '/v1/admin/bundles/:bundleId/availability',
  surface: 'admin',
  operationId: 'adminGetBundleAvailability',
  summary: 'How many of this bundle can we ship?',
  description:
    'Computed, never stored (§91).\n\n' +
    '```\nfulfillable(component) = floor(component.available / component.required)\n' +
    'fulfillable(bundle)    = MIN over components\n```\n\n' +
    'A gift set of 1 bottle + 1 pen + 1 diary against 100 / 75 / 100 available is **75** bundles — not ' +
    '275, and not 100. The scarcest component is the answer, so `limitingVariantIds` names the ones ' +
    'setting the MIN rather than leaving the caller to re-derive them.\n\n' +
    '`available` is sellable stock (`on_hand − reserved`, the GENERATED column), never on-hand alone: ' +
    'units already promised to a paid order are physically present but spoken for, and counting them ' +
    'here is precisely how a bundle oversells. A component with **zero** available makes the whole ' +
    'bundle unfulfillable however healthy the rest are, and a component with no stock row at all is read ' +
    'as zero rather than skipped.\n\n' +
    '`?quantity=` drives `shortage` and `canFulfil`; `fulfillableQty` is the unconditional answer either ' +
    'way. `?warehouseId=` narrows to one warehouse — omitting it sums the network, which silently assumes ' +
    'a split shipment is acceptable, and that is a fulfilment decision with a cost attached rather than ' +
    'an availability fact.\n\n' +
    'Gated on `inventory:view`, not `promotions:view`: this reads the warehouse.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: bundleIdParam, query: bundleAvailabilityQuery },
  responses: {
    200: { description: 'The MIN, and the per-component working behind it.', schema: bundleAvailabilityResponse },
    404: { description: 'No such bundle, or no such warehouse.' },
  },
  handler: async ({ params, query }) => ok(await bundlesService.getAvailability(params.bundleId, query)),
});

/* --------------------------------------------------------------- archive */

defineRoute(adminBundlesRouter, {
  method: 'post',
  path: '/v1/admin/bundles/:bundleId/archive',
  surface: 'admin',
  operationId: 'adminArchiveBundle',
  summary: 'Archive a bundle',
  description:
    'Soft delete (§96): `status` becomes `archived` and `deletedAt` is stamped. The row stays, because ' +
    'orders that already contain the bundle still name it, and the partial unique index frees the handle ' +
    'for a replacement.\n\n' +
    'Archiving an already-archived bundle is a no-op that returns the original `archivedAt`, not a 422. ' +
    'A double-click is not a mistake here — unlike releasing a stock hold twice, there is no second ' +
    'effect to guard against.\n\n' +
    'Nothing is deleted from `bundle_items`: the contents are what made the historical price mean ' +
    'something.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'promotions', action: 'delete' },
  rateLimit: 'default',
  request: { params: bundleIdParam },
  responses: {
    200: { description: 'The archived bundle.', schema: bundleArchiveResponse },
    404: { description: 'No such bundle.' },
  },
  handler: async ({ params }) => ok(await bundlesService.archiveBundle(params.bundleId)),
});

/* ------------------------------------------------------------------- get */

defineRoute(adminBundlesRouter, {
  method: 'get',
  path: '/v1/admin/bundles/:bundleId',
  surface: 'admin',
  operationId: 'adminGetBundle',
  summary: 'Get one bundle',
  description:
    'The bundle with its contents resolved — SKU, title and the variant’s own list price per line, which ' +
    'is what `savingsPaise` is computed from.\n\n' +
    '`archived: true` on a line means the VARIANT has been discontinued while still sitting in the box. ' +
    'That bundle can never ship, and it is surfaced here rather than discovered at checkout.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'promotions', action: 'view' },
  request: { params: bundleIdParam },
  responses: {
    200: { description: 'The bundle and its contents.', schema: bundleDetail },
    404: { description: 'No such bundle.' },
  },
  handler: async ({ params }) => ok(await bundlesService.getBundle(params.bundleId)),
});

/* ---------------------------------------------------------------- update */

defineRoute(adminBundlesRouter, {
  method: 'patch',
  path: '/v1/admin/bundles/:bundleId',
  surface: 'admin',
  operationId: 'adminUpdateBundle',
  summary: 'Update a bundle',
  description:
    'Every field optional. `items`, when present, **replaces** the contents wholesale inside the same ' +
    'transaction — `bundle_items` is keyed by `(bundleId, variantId)` with no surrogate id, so there is ' +
    'nothing stable to patch a single line by. Omit `items` to leave the box alone.\n\n' +
    'Editing an archived bundle is a 422. Archiving freed its handle, so an edit could resurrect a row ' +
    'that now collides with a live bundle.\n\n' +
    '`endsAt` must be after `startsAt`. A window that is never open is refused rather than stored as a ' +
    'bundle that silently never sells.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'promotions', action: 'edit' },
  rateLimit: 'default',
  request: { params: bundleIdParam, body: updateBundleBody },
  responses: {
    200: { description: 'The updated bundle.', schema: bundleDetail },
    404: { description: 'No such bundle.' },
    409: { description: 'That handle already belongs to another live bundle.' },
    422: { description: '`bundle_archived`, `invalid_bundle_items`, or `invalid_schedule_window`.' },
  },
  handler: async ({ params, body }) => ok(await bundlesService.updateBundle(params.bundleId, body)),
});
