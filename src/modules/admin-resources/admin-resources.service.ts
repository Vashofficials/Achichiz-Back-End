/**
 * The generic resource service — the whole of admin CRUD, once.
 *
 * Two boundaries are enforced here rather than at the edge:
 *
 *  1. **Allowlists.** `?q=`, `?sort=`, `?fields=` and every `filter[...]` key are
 *     matched against the descriptor before anything touches a query. See
 *     `resource.filters.ts` — nothing in this module builds SQL from a string.
 *  2. **Bulk-action permissions.** A route can only declare ONE `(module, action)`
 *     pair, but `POST /{slug}/bulk` dispatches actions of different severities:
 *     "Publish" is an `edit`, "Archive" is a `delete`. The route asks for `edit`
 *     and the action's own `requires` is checked against the caller's grants
 *     here — so a Content Manager can publish an FAQ and an Operations Manager,
 *     who has `content:view` only, cannot.
 */

import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { offsetOf, type ListQuery } from '../../lib/pagination.js';
import { permissionKey, type Action } from '../../lib/rbac-matrix.js';
import * as repo from './admin-resources.repository.js';
import { publishField, writableFields } from './resource.fields.js';
import {
  boundedPerPage,
  compileOrderBy,
  compileProjection,
  compileWhere,
  extractRawFilters,
  parseSortTerms,
} from './resource.filters.js';
import { RESOURCES } from './resource.registry.js';
import type { BulkResultResponse, ResourceSchemaResponse } from './admin-resources.schemas.js';
import type { FieldSpec, ResourceDescriptor, ResourceRow } from './resource.types.js';
import type { StaffAuth } from '../../lib/openapi/define-route.js';

/** The RBAC action each operation asks for. Same table for every resource. */
export const OPERATION_ACTIONS = {
  list: 'view',
  read: 'view',
  schema: 'view',
  create: 'create',
  update: 'edit',
  delete: 'delete',
  bulk: 'edit',
} as const satisfies Record<string, Action>;

export type ResourceListQuery = ListQuery & {
  dir?: 'asc' | 'desc' | undefined;
  fields?: string | undefined;
  withFilterOptions?: 'true' | 'false' | undefined;
};

/* ------------------------------------------------------------ coercion */

const fieldMap = (descriptor: ResourceDescriptor): Map<string, FieldSpec> =>
  new Map(descriptor.fields.map((f) => [f.key, f]));

/**
 * JSON → a value the driver can bind.
 *
 * Only `datetime` needs work: a `timestamptz` column wants a Date, and handing
 * it an ISO string relies on Postgres's parser agreeing with JavaScript's about
 * a value the client typed. `date` columns are the opposite — they want the
 * `YYYY-MM-DD` string, because constructing a Date from one and sending it back
 * shifts the day in any timezone west of UTC.
 */
function toDbValue(value: unknown, field: FieldSpec | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (field?.kind === 'datetime' && typeof value === 'string') return new Date(value);
  return value;
}

function toDbPatch(descriptor: ResourceDescriptor, body: Record<string, unknown>): Record<string, unknown> {
  const fields = fieldMap(descriptor);
  const writable = new Set(writableFields(descriptor).map((f) => f.key));
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    // The zod body is strict, so this is belt-and-braces: a field that became
    // readOnly after a client shipped must not silently keep writing.
    if (!writable.has(key) || !descriptor.columns[key]) continue;
    patch[key] = toDbValue(value, fields.get(key));
  }
  return patch;
}

/* ---------------------------------------------------------------- list */

export async function listRows(
  descriptor: ResourceDescriptor,
  query: ResourceListQuery,
  rawQuery: Record<string, unknown>,
): Promise<{
  items: ResourceRow[];
  total: number;
  page: number;
  perPage: number;
  filters: Record<string, string[]>;
}> {
  const perPage = boundedPerPage(query.perPage, descriptor);
  const filters = extractRawFilters(rawQuery);
  const where = compileWhere(descriptor, filters, query.q);
  const orderBy = compileOrderBy(descriptor, parseSortTerms(query.sort, descriptor, query.dir));
  const projection = compileProjection(descriptor, query.fields, descriptor.listColumns);

  const { rows, total } = await repo.list(descriptor, {
    projection,
    where,
    orderBy,
    limit: perPage,
    offset: offsetOf(query.page, perPage),
  });

  return {
    items: rows,
    total,
    page: query.page,
    perPage,
    filters: await filterOptions(descriptor, query.withFilterOptions === 'true'),
  };
}

/**
 * Option lists for the filter dropdowns.
 *
 * Static enum options are free. Anything else costs a `SELECT DISTINCT` per
 * filter, so it is opt-in — the console should ask on screen mount, not on every
 * keystroke.
 */
async function filterOptions(
  descriptor: ResourceDescriptor,
  includeDynamic: boolean,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};

  for (const filter of descriptor.filterable) {
    if (filter.options && filter.options.length > 0) {
      out[filter.key] = [...filter.options];
      continue;
    }
    if (!includeDynamic || filter.valueKind !== 'string') continue;
    if (!descriptor.columns[filter.key]) continue;
    out[filter.key] = await repo.distinctValues(descriptor, filter.key, 100);
  }

  return out;
}

/* ---------------------------------------------------------------- read */

export async function readRow(
  descriptor: ResourceDescriptor,
  id: string,
  fields: string | undefined,
): Promise<ResourceRow> {
  const projection = compileProjection(
    descriptor,
    fields,
    descriptor.detailColumns ?? Object.keys(descriptor.columns),
  );
  const row = await repo.findById(descriptor, id, projection);
  if (!row) throw new NotFoundError(descriptor.name.singular, id);
  return row;
}

/* -------------------------------------------------------------- create */

export async function createRow(
  descriptor: ResourceDescriptor,
  body: Record<string, unknown>,
): Promise<ResourceRow> {
  // Refused before touching the database, so the caller gets the real reason
  // rather than a not-null violation naming a column they cannot send.
  if (descriptor.createUnsupported) {
    throw new BadRequestError(descriptor.createUnsupported);
  }

  const patch = toDbPatch(descriptor, body);
  if (Object.keys(patch).length === 0) {
    throw new BadRequestError(`Nothing to create — no writable field was supplied.`);
  }
  const id = await repo.insertRow(descriptor, patch);
  return readRow(descriptor, id, undefined);
}

/* -------------------------------------------------------------- update */

/**
 * PATCH, not PUT.
 *
 * The console's form only ever submits the fields it rendered, which is a subset
 * derived from the descriptor — it has never had the whole row to replace.
 */
export async function updateRow(
  descriptor: ResourceDescriptor,
  id: string,
  body: Record<string, unknown>,
): Promise<ResourceRow> {
  const patch = toDbPatch(descriptor, body);
  if (Object.keys(patch).length === 0) {
    throw new BadRequestError('Nothing to change — no writable field was supplied.');
  }
  const changed = await repo.updateRow(descriptor, id, patch);
  if (!changed) throw new NotFoundError(descriptor.name.singular, id);
  return readRow(descriptor, id, undefined);
}

/* -------------------------------------------------------------- delete */

export async function deleteRow(descriptor: ResourceDescriptor, id: string): Promise<void> {
  const { deleted } = await repo.removeRow(descriptor, id);
  if (!deleted) throw new NotFoundError(descriptor.name.singular, id);
}

/* ---------------------------------------------------------------- bulk */

export async function runBulkAction(
  descriptor: ResourceDescriptor,
  input: { action: string; ids: string[] },
  auth: StaffAuth,
): Promise<BulkResultResponse> {
  const spec = descriptor.bulkActions.find((a) => a.action === input.action);
  if (!spec) {
    throw new BadRequestError(
      `\`${input.action}\` is not a bulk action on ${descriptor.slug}. ` +
        `Available: ${descriptor.bulkActions.map((a) => a.action).join(', ') || '(none)'}.`,
    );
  }

  // The route could only declare one permission. This is the per-action one.
  const required = permissionKey(descriptor.module, spec.requires);
  if (!auth.permissions.has(required)) {
    throw new ForbiddenError(
      `Your role (${auth.role}) cannot ${spec.requires} ${descriptor.module}, which “${spec.label}” requires.`,
      { context: { required, role: auth.role, action: spec.action } },
    );
  }

  const matched = await repo.existingIds(descriptor, input.ids);
  const updated = await repo.bulkSet(descriptor, matched, spec.set);
  const matchedSet = new Set(matched);

  return {
    action: spec.action,
    requested: input.ids.length,
    matched: matched.length,
    updated,
    skipped: input.ids.filter((id) => !matchedSet.has(id)),
  };
}

/* -------------------------------------------------------------- schema */

export function describeResource(descriptor: ResourceDescriptor): ResourceSchemaResponse {
  return {
    slug: descriptor.slug,
    title: descriptor.title,
    description: descriptor.description,
    group: descriptor.group,
    module: descriptor.module,
    permissions: { ...OPERATION_ACTIONS },
    columns: Object.keys(descriptor.columns),
    listColumns: [...descriptor.listColumns],
    /** null when the resource can be created; a human reason when it cannot. */
    createUnsupported: descriptor.createUnsupported ?? null,
    fields: descriptor.fields.map(publishField),
    searchable: [...descriptor.searchable],
    sortable: [...descriptor.sortable],
    defaultSort: descriptor.defaultSort,
    defaultPerPage: descriptor.defaultPerPage ?? 25,
    filters: descriptor.filterable.map((f) => ({
      key: f.key,
      label: f.label,
      valueKind: f.valueKind,
      operators: [...f.operators],
      options: f.options ? [...f.options] : null,
    })),
    bulkActions: descriptor.bulkActions.map((a) => ({
      action: a.action,
      label: a.label,
      requires: a.requires,
      destructive: a.destructive ?? false,
      description: a.description ?? null,
    })),
    deleteBehaviour: descriptor.softDeleteColumn ? 'soft' : descriptor.archiveStatus ? 'archived' : 'hard',
  };
}

/** The registry index, filtered to what the caller may actually see. */
export function listRegistry(auth: StaffAuth): {
  slug: string;
  title: string;
  group: string;
  module: ResourceDescriptor['module'];
  basePath: string;
  schemaPath: string;
}[] {
  return RESOURCES.filter((r) => auth.permissions.has(permissionKey(r.module, 'view'))).map((r) => ({
    slug: r.slug,
    title: r.title,
    group: r.group,
    module: r.module,
    basePath: `/v1/admin/${r.slug}`,
    schemaPath: `/v1/admin/${r.slug}/schema`,
  }));
}
