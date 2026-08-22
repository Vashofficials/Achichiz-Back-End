import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, noContent, ok, paginated, pageMeta } from '../../lib/http.js';
import { MAX_PER_PAGE } from '../../lib/pagination.js';
import * as resources from './admin-resources.service.js';
import { createBodySchema, updateBodySchema } from './resource.fields.js';
import { RESOURCES } from './resource.registry.js';
import {
  bulkBody,
  bulkResult,
  registryEntry,
  resourceIdParam,
  resourceListQuery,
  resourceRow,
  resourceSchemaView,
} from './admin-resources.schemas.js';
import type { ResourceDescriptor } from './resource.types.js';

/**
 * THE GENERIC ENGINE'S HTTP SURFACE.
 *
 * One handler set, registered once per resource. The loop is the point: adding
 * a descriptor to `resource.registry.ts` produces seven endpoints, seven OpenAPI
 * operations, per-resource zod request bodies and seven correctly-scoped
 * permission gates, with no handler to write.
 *
 * **Why a route per resource rather than one `/v1/admin/:resource` route.**
 * `defineRoute` requires a literal `permission: { module, action }` at
 * declaration time, and the module is a property of the resource — `catalogue`
 * for products, `content` for FAQs, `promotions` for coupons. A single wildcard
 * route could only declare one module, so the check would have to move inside
 * the handler, where "did anyone remember it" becomes a question again. It also
 * means the published document names every endpoint and its real body, instead
 * of one operation with a path parameter and `additionalProperties: true`.
 *
 * Registration order matters in exactly two places: `/schema` and `/bulk` are
 * declared before `/:id`, so Express matches the literal segments first.
 */
export const adminResourceRouter: Router = Router();

const TAG_INDEX = 'Admin resources';

const LIST_NOTE =
  'Server-paginated, server-filtered, server-sorted. Every knob is an allowlist: `?q=` ORs across the ' +
  'resource’s `searchable` columns, `?sort=` accepts up to three of its `sortable` fields (`-` for ' +
  'descending), `?fields=` projects out of its `columns`, and `?filter[key][op]=value` is matched ' +
  'against its `filterable` entries — key AND operator. An unknown key, operator, sort field or ' +
  'projection field is a 400, not a silent fallback: a list that looks filtered and is not is worse ' +
  `than an error. \`perPage\` is capped at ${MAX_PER_PAGE} in two places. Fetch the exact vocabulary ` +
  'from `/schema`.';

function registerResource(descriptor: ResourceDescriptor): void {
  const { slug, module, name, tag, title } = descriptor;
  const base = `/v1/admin/${slug}`;
  const createBody = createBodySchema(descriptor);
  const updateBody = updateBodySchema(descriptor);

  /* ------------------------------------------------------------- list */
  defineRoute(adminResourceRouter, {
    method: 'get',
    path: base,
    surface: 'admin',
    operationId: `adminList${name.plural}`,
    summary: `List ${title.toLowerCase()}`,
    description: `${descriptor.description}\n\n${LIST_NOTE}`,
    tags: [tag],
    auth: 'staff',
    permission: { module, action: resources.OPERATION_ACTIONS.list },
    request: { query: resourceListQuery },
    responses: {
      200: {
        description: 'A page of rows, with `meta` and the filter option lists.',
        schema: z.array(resourceRow),
      },
      400: { description: 'An unknown filter key, operator, sort field or projection field.' },
    },
    handler: async ({ query, req }) => {
      const result = await resources.listRows(
        descriptor,
        query,
        req.query,
      );
      // `filters` rides along in `meta`, replacing the console's client-side
      // `uniq(rows.map(...))` — which stops working the moment the list is
      // genuinely paginated and only ever saw one page.
      const meta = {
        ...pageMeta(result.total, result.page, result.perPage),
        filters: result.filters,
      };
      return paginated(result.items, meta);
    },
  });

  /* ----------------------------------------------------------- schema */
  defineRoute(adminResourceRouter, {
    method: 'get',
    path: `${base}/schema`,
    surface: 'admin',
    operationId: `adminGet${name.singular}Schema`,
    summary: `Field spec for ${title.toLowerCase()}`,
    description:
      'The resource descriptor: columns, the explicit `fields` spec, searchable and sortable fields, ' +
      'every filter with its permitted operators, the bulk actions with the RBAC action each needs, ' +
      'and what DELETE actually does.\n\n' +
      '`fields` is deliberately NOT `columns`. The console currently derives its edit form from ' +
      '`Object.keys(rows[0])` and marks the first two fields required — so a null in the first row ' +
      'makes a field vanish, nested data is invisible, and "required" is positional. This endpoint is ' +
      'the fix: `required` is stated per field, `readOnly` is stated, enums carry their options, and ' +
      'references name the resource to fetch a picker from.',
    tags: [tag],
    auth: 'staff',
    permission: { module, action: resources.OPERATION_ACTIONS.schema },
    responses: {
      200: { description: 'The descriptor.', schema: resourceSchemaView },
    },
    handler: () => ok(resources.describeResource(descriptor)),
  });

  /* ------------------------------------------------------------- bulk */
  defineRoute(adminResourceRouter, {
    method: 'post',
    path: `${base}/bulk`,
    surface: 'admin',
    operationId: `adminBulk${name.plural}`,
    summary: `Bulk action on ${title.toLowerCase()}`,
    description:
      'Applies one declared action to a selection, in a single UPDATE — a loop of PATCHes would race ' +
      'anything else touching those rows.\n\n' +
      'The route declares `edit`, but each action ALSO declares its own `requires`, checked against ' +
      'your grants before anything is written: destructive actions ask for `delete`, which most roles ' +
      'do not hold on most modules. Ids that no longer exist come back in `skipped` rather than ' +
      'failing the batch — rows move while a table is on screen.',
    tags: [tag],
    auth: 'staff',
    permission: { module, action: resources.OPERATION_ACTIONS.bulk },
    request: { body: bulkBody },
    responses: {
      200: { description: 'What was matched and changed.', schema: bulkResult },
      400: { description: 'No such bulk action on this resource.' },
      403: { description: 'The action needs an RBAC action your role does not have.' },
    },
    handler: async ({ body, auth }) => ok(await resources.runBulkAction(descriptor, body, auth)),
  });

  /* ----------------------------------------------------------- create */
  defineRoute(adminResourceRouter, {
    method: 'post',
    path: base,
    surface: 'admin',
    operationId: `adminCreate${name.singular}`,
    summary: `Create a ${name.singular.toLowerCase()}`,
    description:
      'The body is generated from this resource’s `fields` spec, so required fields are required by ' +
      'name rather than by position, and the schema below is the real one — not ' +
      '`additionalProperties: true`.\n\n' +
      'Strict: an unrecognised key is a 422. A silently dropped field is how a price update appears to ' +
      'succeed without changing the price. Read-only fields are documented in `/schema` and rejected ' +
      'here. Database CHECK constraints still apply on top — an active product with no HSN code is ' +
      'refused by the database, because there is no invoice without one.',
    tags: [tag],
    auth: 'staff',
    permission: { module, action: resources.OPERATION_ACTIONS.create },
    request: { body: createBody },
    responses: {
      201: { description: 'The created row.', schema: resourceRow },
      409: { description: 'A unique constraint rejected it — a duplicate handle, SKU or code.' },
      422: { description: 'Validation failed, or a database constraint refused the row.' },
    },
    handler: async ({ body }) => created(await resources.createRow(descriptor, body as Record<string, unknown>)),
  });

  /* ------------------------------------------------------------- read */
  defineRoute(adminResourceRouter, {
    method: 'get',
    path: `${base}/:id`,
    surface: 'admin',
    operationId: `adminGet${name.singular}`,
    summary: `Get one ${name.singular.toLowerCase()}`,
    description:
      'Every column by default; narrow it with `?fields=`. An archived or soft-deleted row is a 404 ' +
      'here, the same as a row that never existed.',
    tags: [tag],
    auth: 'staff',
    permission: { module, action: resources.OPERATION_ACTIONS.read },
    request: {
      params: resourceIdParam,
      query: z.object({
        fields: z.string().max(600).optional().describe('Comma-separated projection, from the column allowlist.'),
      }),
    },
    responses: {
      200: { description: 'The row.', schema: resourceRow },
      404: { description: 'No such row, or it is archived.' },
    },
    handler: async ({ params, query }) => ok(await resources.readRow(descriptor, params.id, query.fields)),
  });

  /* ----------------------------------------------------------- update */
  defineRoute(adminResourceRouter, {
    method: 'patch',
    path: `${base}/:id`,
    surface: 'admin',
    operationId: `adminUpdate${name.singular}`,
    summary: `Update a ${name.singular.toLowerCase()}`,
    description:
      'PATCH rather than PUT, deliberately: the console’s form only ever submits the fields it ' +
      'rendered, so PUT would promise a full replacement the client has never had the data to make. ' +
      'Send at least one field. Unrecognised and read-only keys are rejected, not ignored.',
    tags: [tag],
    auth: 'staff',
    permission: { module, action: resources.OPERATION_ACTIONS.update },
    request: { params: resourceIdParam, body: updateBody },
    responses: {
      200: { description: 'The updated row.', schema: resourceRow },
      404: { description: 'No such row, or it is archived.' },
      409: { description: 'A unique constraint rejected it.' },
      422: { description: 'Validation failed, or a database constraint refused the change.' },
    },
    handler: async ({ params, body }) =>
      ok(await resources.updateRow(descriptor, params.id, body as Record<string, unknown>)),
  });

  /* ----------------------------------------------------------- delete */
  const behaviour = descriptor.softDeleteColumn
    ? 'Soft delete: `deleted_at` is stamped and every read filters it out. The row, and the audit ' +
      'history pointing at it, survive.'
    : descriptor.archiveStatus
      ? `Archive: \`status\` becomes \`${descriptor.archiveStatus.value}\`. This table has no ` +
        '`deleted_at` because other rows keep foreign keys to it.'
      : 'Hard delete. This resource declares neither a soft-delete column nor an archive status.';

  defineRoute(adminResourceRouter, {
    method: 'delete',
    path: `${base}/:id`,
    surface: 'admin',
    operationId: `adminDelete${name.singular}`,
    summary: `Archive a ${name.singular.toLowerCase()}`,
    description:
      `${behaviour}\n\nGated on \`${module}:delete\`, which is a much narrower grant than \`edit\` — ` +
      'across the eleven roles, `delete` exists on a module for its owner and for Super Admin, and ' +
      'nobody else.',
    tags: [tag],
    auth: 'staff',
    permission: { module, action: resources.OPERATION_ACTIONS.delete },
    request: { params: resourceIdParam },
    responses: {
      204: { description: 'Archived.' },
      404: { description: 'No such row, or it is already archived.' },
    },
    handler: async ({ params }) => {
      await resources.deleteRow(descriptor, params.id);
      return noContent();
    },
  });
}

/* --------------------------------------------------------- the index */

defineRoute(adminResourceRouter, {
  method: 'get',
  path: '/v1/admin/resources',
  surface: 'admin',
  operationId: 'adminListResources',
  summary: 'The resource registry',
  description:
    'Every generic resource this API serves, filtered to the ones your role can view. The console can ' +
    'build its nav from this instead of hardcoding 59 entries. Each carries its `basePath` (the five ' +
    'CRUD routes hang off it) and its `schemaPath` (the field spec that drives the forms).',
  tags: [TAG_INDEX],
  auth: 'staff',
  // Every role holds `dashboard:view`; the per-resource filtering inside the
  // handler is what actually decides what comes back.
  permission: { module: 'dashboard', action: 'view' },
  responses: {
    200: { description: 'Resources you can view.', schema: z.array(registryEntry) },
  },
  handler: ({ auth }) => ok(resources.listRegistry(auth)),
});

for (const descriptor of RESOURCES) registerResource(descriptor);
