/**
 * Contracts for the generic engine.
 *
 * The row shape is `Record<string, unknown>` on purpose: it is whatever
 * `?fields=` asked for, out of a per-resource allowlist. The precise per-resource
 * shapes that ARE pinned are the create and update bodies, which
 * `resource.fields.ts` generates from each descriptor's `fields` spec — so
 * `POST /v1/admin/products` publishes a real schema in the OpenAPI document
 * rather than `additionalProperties: true`.
 */

import { z } from 'zod';
import { listQuery, MAX_PER_PAGE } from '../../lib/pagination.js';
import { ACTIONS, MODULES } from '../../lib/rbac-matrix.js';
import { FIELD_KINDS, FILTER_OPERATORS } from './resource.types.js';

export const resourceRow = z
  .record(z.string(), z.unknown())
  .describe('One row, projected to the requested `fields`. The primary key is always present.');

export const resourceIdParam = z.object({
  id: z.uuid().describe('Row id.'),
});

/**
 * `.catchall()` keeps the `filter[...]` keys, which `validate()` would otherwise
 * strip: Express 5's default query parser does not expand brackets, so
 * `?filter[status]=live` arrives as the literal key `filter[status]`.
 */
export const resourceListQuery = listQuery
  .extend({
    sort: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Up to three comma-separated fields, `-` for descending: `-updatedAt,title`. A field outside ' +
          'the resource’s `sortable` list is a 400, never a silent fallback — an ORDER BY that ignored ' +
          'what you asked for is a list you will misread.',
      ),
    dir: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('Direction for a single-field `sort`, matching the console’s column headers. A `-` prefix wins.'),
    fields: z
      .string()
      .max(600)
      .optional()
      .describe('Comma-separated projection, validated against the resource’s column allowlist.'),
    withFilterOptions: z
      .enum(['true', 'false'])
      .optional()
      .describe(
        'Return distinct values for filters that have no static option list, so the console’s ' +
          'dropdowns do not have to compute them from an in-memory array. One extra query per such ' +
          'filter — ask for it on screen mount, not on every keystroke.',
      ),
  })
  .catchall(z.union([z.string(), z.array(z.string())]));

export const bulkBody = z.object({
  action: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('One of the resource’s declared `bulkActions`. Each declares the RBAC action it needs.'),
  ids: z
    .array(z.uuid())
    .min(1)
    .max(MAX_PER_PAGE)
    .describe(`Row ids. At most ${MAX_PER_PAGE} — the same ceiling as a page.`),
});

/* -------------------------------------------------------------- responses */

export const publishedField: z.ZodType = z.object({
  key: z.string().describe('JSON key, and the key in a create/update body.'),
  label: z.string().describe('Form label.'),
  kind: z.enum(FIELD_KINDS).describe('How to render and validate it.'),
  required: z.boolean().describe('Explicit, per field — not "the first two", which is what the console does today.'),
  readOnly: z.boolean().describe('Rendered but not accepted on write. Submitting it is a 422.'),
  options: z.array(z.string()).nullable().describe('`kind: enum` — the permitted values.'),
  reference: z
    .object({
      resource: z.string().describe('Slug to fetch options from.'),
      labelField: z.string().describe('Which field to show in the picker.'),
    })
    .nullable()
    .describe('`kind: reference` — where the picker looks.'),
  unit: z.string().nullable().describe('`paise`, `basis_points`, `grams`, `millimetres`, `days`.'),
  help: z.string().nullable().describe('Help text under the input.'),
  of: z.unknown().nullable().describe('`kind: array` — the element spec, same shape as this one.'),
  fields: z.array(z.unknown()).nullable().describe('`kind: object` — the nested specs.'),
});

export const resourceSchemaView = z.object({
  slug: z.string().describe('URL segment and registry key.'),
  title: z.string().describe('Screen title.'),
  description: z.string().describe('What the resource is.'),
  group: z.string().describe('Nav group.'),
  module: z.enum(MODULES).describe('The RBAC module gating every route for this resource.'),
  permissions: z
    .record(z.string(), z.enum(ACTIONS))
    .describe('operation → the action required, e.g. `{ "delete": "delete" }`.'),
  columns: z.array(z.string()).describe('Every selectable field. The `?fields=` allowlist.'),
  listColumns: z.array(z.string()).describe('Default table projection.'),
  fields: z.array(publishedField).describe('The editable spec. This is what the create/edit form renders.'),
  searchable: z.array(z.string()).describe('Fields `?q=` ORs across.'),
  sortable: z.array(z.string()).describe('Fields `?sort=` accepts.'),
  defaultSort: z
    .object({
      field: z.string().describe('Field name.'),
      direction: z.enum(['asc', 'desc']).describe('Direction.'),
    })
    .describe('Applied when `sort` is absent.'),
  defaultPerPage: z.number().int().describe(`Suggested page size. Hard-capped at ${MAX_PER_PAGE}.`),
  filters: z
    .array(
      z.object({
        key: z.string().describe('Query key: `?filter[<key>]=<value>`.'),
        label: z.string().describe('Dropdown label.'),
        valueKind: z.enum(['string', 'number', 'boolean', 'date', 'uuid']).describe('How the value is parsed.'),
        operators: z.array(z.enum(FILTER_OPERATORS)).describe('Operators this key accepts. Anything else is a 400.'),
        options: z.array(z.string()).nullable().describe('Static option list, when the column is an enum.'),
      }),
    )
    .describe('Every filterable key, with its permitted operators.'),
  bulkActions: z
    .array(
      z.object({
        action: z.string().describe('Wire value for `POST /{slug}/bulk`.'),
        label: z.string().describe('Button label.'),
        requires: z.enum(ACTIONS).describe('The RBAC action needed, on top of the resource’s module.'),
        destructive: z.boolean().describe('Render red and confirm.'),
        description: z.string().nullable().describe('What it does.'),
      }),
    )
    .describe('Declared bulk actions. The server re-checks `requires` — hiding the button is not the control.'),
  deleteBehaviour: z
    .enum(['soft', 'archived', 'hard'])
    .describe('`soft` stamps `deleted_at`, `archived` flips a status column, `hard` really removes the row.'),
});

export const bulkResult = z.object({
  action: z.string().describe('The action that ran.'),
  requested: z.number().int().describe('Ids sent.'),
  matched: z.number().int().describe('Ids that exist and are not already archived.'),
  updated: z.number().int().describe('Rows actually changed, from the single UPDATE statement.'),
  skipped: z.array(z.uuid()).describe('Ids that matched nothing. Not an error — rows move.'),
});

export const registryEntry = z.object({
  slug: z.string().describe('URL segment.'),
  title: z.string().describe('Screen title.'),
  group: z.string().describe('Nav group.'),
  module: z.enum(MODULES).describe('Gating RBAC module.'),
  basePath: z.string().describe('`/v1/admin/products` — the five CRUD routes hang off this.'),
  schemaPath: z.string().describe('Where to fetch the field spec.'),
});

export type ResourceSchemaResponse = z.infer<typeof resourceSchemaView>;
export type BulkResultResponse = z.infer<typeof bulkResult>;
