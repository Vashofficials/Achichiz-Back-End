/**
 * The filter, sort, search and projection compiler.
 *
 * Everything here turns an untrusted query string into Drizzle predicate
 * objects. Three rules, and they are the whole security story of the generic
 * engine:
 *
 *  1. **No string reaches SQL.** Every condition is built with `eq`/`ilike`/
 *     `inArray`/… against a `PgColumn` taken from the descriptor. Values are
 *     bound parameters. There is no template literal anywhere in this file.
 *  2. **Column names are matched, not passed through.** A filter key is looked
 *     up in `filterable`, a sort field in `sortable`, a projection field in
 *     `columns`. The client supplies a key; the descriptor supplies the column.
 *  3. **Unknown means 400, not "ignore it".** A silently dropped filter shows a
 *     list that looks filtered and is not, which on a refunds screen is a
 *     genuinely dangerous UI.
 */

import { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, ne, or, type SQL } from 'drizzle-orm';
import { BadRequestError } from '../../lib/errors.js';
import { MAX_PER_PAGE } from '../../lib/pagination.js';
import type { FilterOperator, FilterSpec, FilterValueKind, ResourceDescriptor } from './resource.types.js';

/* ------------------------------------------------------ query-key parsing */

/** `filter[status]`, `filter[status][in]`, `filter.status`, `filter.status.in`. */
const FILTER_KEY = /^filter(?:\[([A-Za-z][A-Za-z0-9_]*)\](?:\[([a-zA-Z]+)\])?|\.([A-Za-z][A-Za-z0-9_]*)(?:\.([a-zA-Z]+))?)$/;

export type RawFilter = { key: string; operator: string; value: string };

/**
 * Pull the filter entries out of the raw query object.
 *
 * Both bracket and dot forms are accepted because Express 5's default query
 * parser does not expand brackets into nested objects — `?filter[status]=live`
 * arrives as the literal key `filter[status]`, and a client that "helpfully"
 * sends `filter.status` should not silently do nothing.
 */
export function extractRawFilters(query: Record<string, unknown>): RawFilter[] {
  const out: RawFilter[] = [];
  for (const [rawKey, rawValue] of Object.entries(query)) {
    const match = FILTER_KEY.exec(rawKey);
    if (!match) continue;
    const key = match[1] ?? match[3];
    if (!key) continue;
    const operator = match[2] ?? match[4] ?? 'eq';
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      if (typeof value === 'string') out.push({ key, operator, value });
    }
  }
  return out;
}

/* ------------------------------------------------------- value coercion */

function coerce(value: string, kind: FilterValueKind, spec: FilterSpec): string | number | boolean | Date {
  switch (kind) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new BadRequestError(`Filter \`${spec.key}\` expects a number, got '${value}'.`);
      }
      return n;
    }
    case 'boolean': {
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      throw new BadRequestError(`Filter \`${spec.key}\` expects true or false, got '${value}'.`);
    }
    case 'date': {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestError(`Filter \`${spec.key}\` expects a date, got '${value}'.`);
      }
      return parsed;
    }
    case 'uuid': {
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
        throw new BadRequestError(`Filter \`${spec.key}\` expects a uuid, got '${value}'.`);
      }
      return value;
    }
    case 'string':
      if (spec.options && spec.options.length > 0 && !spec.options.includes(value)) {
        throw new BadRequestError(
          `Filter \`${spec.key}\` must be one of: ${spec.options.join(', ')}. Got '${value}'.`,
        );
      }
      return value;
  }
}

/** `%` and `_` are LIKE metacharacters. Values are bound, but they still glob. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/* -------------------------------------------------------------- compilers */

const isFilterOperator = (value: string, spec: FilterSpec): value is FilterOperator =>
  (spec.operators as readonly string[]).includes(value);

export function compileFilters(descriptor: ResourceDescriptor, raw: readonly RawFilter[]): SQL[] {
  const byKey = new Map(descriptor.filterable.map((f) => [f.key, f]));
  const conditions: (SQL | undefined)[] = [];

  for (const entry of raw) {
    const spec = byKey.get(entry.key);
    if (!spec) {
      throw new BadRequestError(
        `\`${entry.key}\` is not a filterable field on ${descriptor.slug}. ` +
          `Filterable: ${descriptor.filterable.map((f) => f.key).join(', ') || '(none)'}.`,
      );
    }
    if (!isFilterOperator(entry.operator, spec)) {
      throw new BadRequestError(
        `Operator \`${entry.operator}\` is not allowed on \`${entry.key}\`. ` +
          `Allowed: ${spec.operators.join(', ')}.`,
      );
    }

    switch (entry.operator) {
      case 'isNull':
        conditions.push(isNull(spec.column));
        break;
      case 'notNull':
        conditions.push(isNotNull(spec.column));
        break;
      case 'in': {
        const values = entry.value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => coerce(v, spec.valueKind, spec));
        if (values.length === 0) {
          throw new BadRequestError(`Filter \`${entry.key}\` with \`in\` needs at least one value.`);
        }
        if (values.length > 100) {
          throw new BadRequestError(`Filter \`${entry.key}\` accepts at most 100 values.`);
        }
        conditions.push(inArray(spec.column, values));
        break;
      }
      case 'contains':
        conditions.push(ilike(spec.column, `%${escapeLike(entry.value)}%`));
        break;
      case 'ne':
        conditions.push(ne(spec.column, coerce(entry.value, spec.valueKind, spec)));
        break;
      case 'lt':
        conditions.push(lt(spec.column, coerce(entry.value, spec.valueKind, spec)));
        break;
      case 'lte':
        conditions.push(lte(spec.column, coerce(entry.value, spec.valueKind, spec)));
        break;
      case 'gt':
        conditions.push(gt(spec.column, coerce(entry.value, spec.valueKind, spec)));
        break;
      case 'gte':
        conditions.push(gte(spec.column, coerce(entry.value, spec.valueKind, spec)));
        break;
      case 'eq':
        conditions.push(eq(spec.column, coerce(entry.value, spec.valueKind, spec)));
        break;
    }
  }

  return conditions.filter((c): c is SQL => Boolean(c));
}

/** `?q=cork` → `(title ILIKE '%cork%' OR sku ILIKE '%cork%')`, or nothing. */
export function compileSearch(descriptor: ResourceDescriptor, q: string | undefined): SQL | undefined {
  const term = q?.trim();
  if (!term || descriptor.searchable.length === 0) return undefined;

  const pattern = `%${escapeLike(term)}%`;
  const clauses = descriptor.searchable
    .map((key) => descriptor.columns[key])
    .filter((column): column is NonNullable<typeof column> => Boolean(column))
    .map((column) => ilike(column, pattern));

  return clauses.length > 0 ? or(...clauses) : undefined;
}

/** The `AND` of filters, search and the soft-delete guard. */
export function compileWhere(
  descriptor: ResourceDescriptor,
  raw: readonly RawFilter[],
  q: string | undefined,
  extra: readonly (SQL | undefined)[] = [],
): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    ...compileFilters(descriptor, raw),
    compileSearch(descriptor, q),
    descriptor.softDeleteColumn ? isNull(descriptor.softDeleteColumn) : undefined,
    descriptor.baseFilter,
    ...extra,
  ];
  const present = conditions.filter((c): c is SQL => Boolean(c));
  return present.length > 0 ? and(...present) : undefined;
}

/* ----------------------------------------------------------------- sort */

export type SortTerm = { field: string; direction: 'asc' | 'desc' };

/**
 * `-placedAt,orderNo` → two terms, in that order.
 *
 * Unknown fields throw rather than falling back, for the same reason unknown
 * filters do: an ORDER BY that quietly ignored what you asked for is a list you
 * will misread. The primary key is appended as a tiebreak so pagination is
 * stable across pages when the sort column has duplicates.
 */
export function parseSortTerms(
  sort: string | undefined,
  descriptor: ResourceDescriptor,
  direction?: 'asc' | 'desc',
): SortTerm[] {
  if (!sort?.trim()) {
    return [{ field: descriptor.defaultSort.field, direction: direction ?? descriptor.defaultSort.direction }];
  }

  const terms: SortTerm[] = [];
  for (const raw of sort.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const descending = token.startsWith('-');
    const field = token.replace(/^[-+]/, '');
    if (!descriptor.sortable.includes(field)) {
      throw new BadRequestError(
        `\`${field}\` is not sortable on ${descriptor.slug}. Sortable: ${descriptor.sortable.join(', ')}.`,
      );
    }
    // An explicit `?dir=` applies to a single-field sort, which is the shape the
    // console's column headers produce. A `-` prefix always wins.
    terms.push({ field, direction: descending ? 'desc' : (direction ?? 'asc') });
  }

  if (terms.length === 0) {
    return [{ field: descriptor.defaultSort.field, direction: direction ?? descriptor.defaultSort.direction }];
  }
  if (terms.length > 3) throw new BadRequestError('Sort by at most three fields.');
  return terms;
}

export function compileOrderBy(descriptor: ResourceDescriptor, terms: readonly SortTerm[]): SQL[] {
  const clauses: SQL[] = [];
  for (const term of terms) {
    const column = descriptor.columns[term.field];
    if (!column) continue;
    clauses.push(term.direction === 'desc' ? desc(column) : asc(column));
  }
  // Stable pagination: without a unique tiebreak, rows with equal sort keys can
  // appear on two pages or on none.
  clauses.push(asc(descriptor.primaryKey));
  return clauses;
}

/* ----------------------------------------------------------- projection */

/**
 * `?fields=sku,title` → the selected columns, validated against `columns`.
 *
 * The primary key is always included: a row the client cannot address is not
 * useful, and every row action needs it.
 */
export function compileProjection(
  descriptor: ResourceDescriptor,
  fields: string | undefined,
  fallback: readonly string[],
): Record<string, (typeof descriptor.columns)[string]> {
  const requested = fields
    ?.split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  const keys = requested && requested.length > 0 ? requested : [...fallback];

  const projection: Record<string, (typeof descriptor.columns)[string]> = {};
  for (const key of keys) {
    const column = descriptor.columns[key];
    if (!column) {
      throw new BadRequestError(
        `\`${key}\` is not a field on ${descriptor.slug}. ` +
          `Available: ${Object.keys(descriptor.columns).join(', ')}.`,
      );
    }
    projection[key] = column;
  }

  const pkKey = Object.entries(descriptor.columns).find(([, c]) => c === descriptor.primaryKey)?.[0] ?? 'id';
  projection[pkKey] ??= descriptor.primaryKey;

  return projection;
}

/* ------------------------------------------------------------ pagination */

/**
 * The cap is re-asserted here as well as in the zod schema.
 *
 * Two gates on the same number is not redundancy for its own sake: the schema
 * protects the HTTP boundary, this protects every other caller of the service,
 * and the console currently paginates 90 screens client-side over full arrays —
 * the first thing that happens when it meets a real API is `?perPage=100000`.
 */
export function boundedPerPage(perPage: number, descriptor: ResourceDescriptor): number {
  const requested = Number.isFinite(perPage) && perPage > 0 ? perPage : (descriptor.defaultPerPage ?? 25);
  return Math.min(requested, MAX_PER_PAGE);
}
