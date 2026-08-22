/**
 * The resource descriptor — the type the whole generic admin engine is driven by.
 *
 * ## Why `fields` is separate from `columns` (02_admin_api.md §2.6)
 *
 * The admin console derives its edit form from `Object.keys(rows[0])` and guesses
 * each field's type from the runtime value plus a regex on the key
 * (`record-fields.ts:13-43`), then marks the first two as required
 * (`record-form.tsx:71`). Three things are wrong with that and all three are the
 * server's job to fix:
 *
 *  1. **Sample-dependent.** A seeded row with a `null` in a column makes the
 *     field vanish for every row; a boolean that happens to be `false`
 *     everywhere still types fine, but a `number` that is `null` in row 0 does
 *     not. The shape must not depend on which row came back first.
 *  2. **Flat only.** `Object.keys` cannot see `Order.address` or `Order.items`,
 *     so structured sub-data is invisible to the form.
 *  3. **`columns` conflates display and edit.** The products table's first
 *     column renders an `<img>` plus a two-line name/SKU block — a sensible
 *     table cell and a meaningless form field.
 *
 * So a descriptor carries BOTH, and they are allowed to disagree:
 *
 *  - `columns`     — every column this resource will ever return. The projection
 *                    allowlist for `?fields=`.
 *  - `listColumns` — the sensible default projection for a table.
 *  - `fields`      — the explicit, typed, per-field editable spec, with
 *                    `required` stated rather than inferred from position.
 *
 * `fields` is also what generates the create/update zod schemas, so the OpenAPI
 * document for `POST /v1/admin/products` describes the real body rather than
 * `additionalProperties: true`.
 *
 * ## Why everything is an allowlist
 *
 * `q`, `sort` and every `filter[...]` key reach a WHERE or ORDER BY clause. They
 * are matched against `searchable` / `sortable` / `filterable` by key, and the
 * matched entry supplies the Drizzle column object — a client-supplied string is
 * never interpolated into SQL, and an unknown key is a 400 rather than a silent
 * fallback that hides a typo.
 */

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Action, ModuleKey } from '../../lib/rbac-matrix.js';

/* ------------------------------------------------------------------ fields */

export const FIELD_KINDS = [
  'text',
  'long',
  'uuid',
  'number',
  'money',
  'percent',
  'date',
  'datetime',
  'boolean',
  'enum',
  'reference',
  'array',
  'object',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export type FieldSpec = {
  key: string;
  label: string;
  kind: FieldKind;
  /** Explicit, never positional. This is the fix for `record-form.tsx:71`. */
  required: boolean;
  /**
   * Computed or database-owned. It appears in the spec so the console can render
   * it, but it is absent from the create/update body schemas — which are strict,
   * so submitting it is a 422 rather than a write that appears to work.
   */
  readOnly?: boolean;
  /** `kind: 'enum'` — the permitted values, which also become the zod enum. */
  options?: readonly string[];
  /** `kind: 'reference'` — where the picker fetches its options. */
  reference?: { resource: string; labelField: string };
  /** `kind: 'array'` — the element spec. */
  of?: FieldSpec;
  /** `kind: 'object'` — the nested spec. */
  fields?: readonly FieldSpec[];
  /** Help text under the input. Becomes the OpenAPI description. */
  help?: string;
  /** Money is integer paise and percentages are basis points — say so in the UI. */
  unit?: 'paise' | 'basis_points' | 'grams' | 'millimetres' | 'days';
  max?: number;
  min?: number;
};

/* ----------------------------------------------------------------- filters */

export const FILTER_OPERATORS = [
  'eq',
  'ne',
  'in',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'isNull',
  'notNull',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** How a raw query-string value is turned into a bound parameter. */
export type FilterValueKind = 'string' | 'number' | 'boolean' | 'date' | 'uuid';

export type FilterSpec = {
  /** The query key: `?filter[status]=active`. */
  key: string;
  label: string;
  column: PgColumn;
  valueKind: FilterValueKind;
  /** Only these operators are accepted for this key. Anything else is a 400. */
  operators: readonly FilterOperator[];
  /** Static option list for a dropdown. Enum columns have one; free text does not. */
  options?: readonly string[];
};

/* ------------------------------------------------------------ bulk actions */

export type BulkActionSpec = {
  /** The wire value: `{ "action": "publish", "ids": [...] }`. */
  action: string;
  label: string;
  /**
   * The RBAC action required ON TOP of the resource's module. `archive` on a
   * catalogue resource asks for `catalogue:delete`, which only Catalogue Manager
   * and Super Admin hold — so the destructive bulk button is a real boundary and
   * not a styling choice.
   */
  requires: Action;
  /** Column patch, keyed by `columns` key. Values are bound, never interpolated. */
  set: Record<string, string | number | boolean | null>;
  /** Renders red, and asks for confirmation. */
  destructive?: boolean;
  description?: string;
};

/* -------------------------------------------------------------- descriptor */

export type ResourceDescriptor = {
  /** URL segment and registry key: `/v1/admin/products`. */
  slug: string;
  title: string;
  description: string;
  /** The nav group the console files it under. */
  group: string;
  /** Which RBAC module gates it. Every route for this resource derives from it. */
  module: ModuleKey;
  /** PascalCase, for operationIds: `adminListProducts` / `adminGetProduct`. */
  name: { singular: string; plural: string };
  /** OpenAPI tag. */
  tag: string;

  table: PgTable;
  primaryKey: PgColumn;
  /** Every exposable column, JSON key → column. The `?fields=` allowlist. */
  columns: Record<string, PgColumn>;
  /** Default projection for the list screen. */
  listColumns: readonly string[];
  /** Default projection for the detail screen. Defaults to every column. */
  detailColumns?: readonly string[];

  fields: readonly FieldSpec[];
  /** Columns `?q=` searches, OR-ed. Keys into `columns`. */
  searchable: readonly string[];
  filterable: readonly FilterSpec[];
  /** Keys into `columns`. `?sort=-createdAt,title` accepts several. */
  sortable: readonly string[];
  defaultSort: { field: string; direction: 'asc' | 'desc' };
  /** Per-resource default page size. Capped by `MAX_PER_PAGE` regardless. */
  defaultPerPage?: number;

  /**
   * Soft delete. When present, DELETE stamps this column and every read filters
   * on it being NULL — matching the console's own vocabulary, where the row menu
   * says "Archive" and audit history has to survive.
   */
  softDeleteColumn?: PgColumn;
  /** For tables with no `deleted_at`: DELETE flips a status column instead. */
  archiveStatus?: { column: PgColumn; value: string };

  bulkActions: readonly BulkActionSpec[];
};

export type ResourceRow = Record<string, unknown>;
