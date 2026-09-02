/**
 * The generic repository. One implementation, ~58 screens.
 *
 * Reads go through the Drizzle query builder with a projection built from the
 * descriptor's `columns` map, so the JSON keys are camelCase and every selected
 * column was named by the server.
 *
 * Writes are `sql` templates rather than `db.insert(table)` for one reason: the
 * registry is heterogeneous, so `table` is the base `PgTable` type and Drizzle's
 * insert/update builders are keyed to a *concrete* table type. Nothing is
 * concatenated — column names go through `sql.identifier()` after being looked
 * up in `descriptor.columns`, values are bound parameters, and every predicate is
 * a Drizzle `eq`/`inArray`/`isNull` object composed into the template. A client
 * string never reaches the SQL text.
 *
 * `updated_at` is deliberately not written: every table carrying it has a
 * `BEFORE UPDATE` trigger that maintains it (see `db/schema/identity.ts`).
 */

import { translateConstraintError } from './constraint-errors.js';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import type { ResourceDescriptor, ResourceRow } from './resource.types.js';

/** `descriptor.columns` key → the physical column name, or throw. */
function physical(descriptor: ResourceDescriptor, key: string): string {
  const column = descriptor.columns[key];
  if (!column) {
    // Unreachable from HTTP — the service validates against the same map first.
    // Reachable from a bad descriptor, which is worth failing loudly on.
    throw new Error(`${descriptor.slug}: '${key}' is not a declared column`);
  }
  return column.name;
}

const pkName = (descriptor: ResourceDescriptor): string => descriptor.primaryKey.name;

const aliveGuard = (descriptor: ResourceDescriptor): SQL | undefined => {
  const parts: SQL[] = [];
  if (descriptor.softDeleteColumn) parts.push(isNull(descriptor.softDeleteColumn));
  if (descriptor.baseFilter) parts.push(descriptor.baseFilter);
  return parts.length > 0 ? and(...parts) : undefined;
};

/* ------------------------------------------------------------------ reads */

export async function list(
  descriptor: ResourceDescriptor,
  opts: {
    projection: Record<string, (typeof descriptor.columns)[string]>;
    where: SQL | undefined;
    orderBy: SQL[];
    limit: number;
    offset: number;
  },
  exec: Executor = db,
): Promise<{ rows: ResourceRow[]; total: number }> {
  const base = exec.select(opts.projection).from(descriptor.table);
  const filtered = opts.where ? base.where(opts.where) : base;

  const rows = await filtered.orderBy(...opts.orderBy).limit(opts.limit).offset(opts.offset);

  const counted = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(descriptor.table)
    .where(opts.where);

  return { rows: rows, total: counted[0]?.n ?? 0 };
}

export async function findById(
  descriptor: ResourceDescriptor,
  id: string,
  projection: Record<string, (typeof descriptor.columns)[string]>,
  exec: Executor = db,
): Promise<ResourceRow | null> {
  const where = and(eq(descriptor.primaryKey, id), aliveGuard(descriptor));
  const rows = await exec.select(projection).from(descriptor.table).where(where).limit(1);
  return (rows[0]) ?? null;
}

/**
 * Distinct values for a filter key, for the console's dropdowns.
 *
 * The console computes these client-side today with `uniq(rows.map(...))` over
 * the whole in-memory array, which stops being possible the moment the list is
 * server-paginated.
 */
export async function distinctValues(
  descriptor: ResourceDescriptor,
  columnKey: string,
  limit: number,
  exec: Executor = db,
): Promise<string[]> {
  const column = descriptor.columns[columnKey];
  if (!column) return [];

  const rows = await exec
    .selectDistinct({ value: column })
    .from(descriptor.table)
    .where(aliveGuard(descriptor))
    .orderBy(asc(column))
    .limit(limit);

  return rows
    .map((r) => r.value)
    .filter((v): v is string | number | boolean => v !== null && v !== undefined)
    .map(String);
}

/* ----------------------------------------------------------------- writes */

export async function insertRow(
  descriptor: ResourceDescriptor,
  values: Record<string, unknown>,
  exec: Executor = db,
): Promise<string> {
  const entries = Object.entries(values);
  if (entries.length === 0) throw new Error(`${descriptor.slug}: refusing to insert an empty row`);

  const columnList = sql.join(
    entries.map(([key]) => sql.identifier(physical(descriptor, key))),
    sql`, `,
  );
  const valueList = sql.join(
    entries.map(([, value]) => sql`${value}`),
    sql`, `,
  );

  /*
   * Integrity violations are the caller's problem, not a server fault. Without
   * this translation a duplicate handle, an unknown `stateCode` or a failed
   * check constraint all surfaced as 500 "Something went wrong on our end".
   */
  let result;
  try {
    result = await exec.execute<{ id: string }>(sql`
      INSERT INTO ${descriptor.table} (${columnList})
      VALUES (${valueList})
      RETURNING ${sql.identifier(pkName(descriptor))} AS id
    `);
  } catch (err) {
    const translated = translateConstraintError(err, descriptor.slug);
    throw translated ?? err;
  }

  const id = result.rows[0]?.id;
  if (!id) throw new Error(`${descriptor.slug}: insert returned no id`);
  return id;
}

/** Returns false when nothing matched — an id that is gone, or already archived. */
export async function updateRow(
  descriptor: ResourceDescriptor,
  id: string,
  patch: Record<string, unknown>,
  exec: Executor = db,
): Promise<boolean> {
  const entries = Object.entries(patch);
  if (entries.length === 0) return true;

  const assignments = sql.join(
    entries.map(([key, value]) => sql`${sql.identifier(physical(descriptor, key))} = ${value}`),
    sql`, `,
  );
  const where = and(eq(descriptor.primaryKey, id), aliveGuard(descriptor));

  // Same reasoning as insertRow: a PATCH can violate the same constraints.
  let result;
  try {
    result = await exec.execute(sql`
      UPDATE ${descriptor.table} SET ${assignments} WHERE ${where}
    `);
  } catch (err) {
    const translated = translateConstraintError(err, descriptor.slug);
    throw translated ?? err;
  }
  return (result.rowCount ?? 0) > 0;
}

/**
 * Delete, in whichever sense the descriptor declares.
 *
 * Soft delete first (`deleted_at`), then a status flip (`archiveStatus`), and a
 * hard `DELETE` only when the resource declares neither — because the console's
 * own vocabulary for this button is "Archive", and losing audit history to a
 * misclick is not recoverable.
 */
export async function removeRow(
  descriptor: ResourceDescriptor,
  id: string,
  exec: Executor = db,
): Promise<{ deleted: boolean; mode: 'soft' | 'archived' | 'hard' }> {
  const where = and(eq(descriptor.primaryKey, id), aliveGuard(descriptor));

  if (descriptor.softDeleteColumn) {
    const result = await exec.execute(sql`
      UPDATE ${descriptor.table}
         SET ${sql.identifier(descriptor.softDeleteColumn.name)} = now()
       WHERE ${where}
    `);
    return { deleted: (result.rowCount ?? 0) > 0, mode: 'soft' };
  }

  if (descriptor.archiveStatus) {
    const result = await exec.execute(sql`
      UPDATE ${descriptor.table}
         SET ${sql.identifier(descriptor.archiveStatus.column.name)} = ${descriptor.archiveStatus.value}
       WHERE ${where}
    `);
    return { deleted: (result.rowCount ?? 0) > 0, mode: 'archived' };
  }

  const result = await exec.execute(sql`DELETE FROM ${descriptor.table} WHERE ${where}`);
  return { deleted: (result.rowCount ?? 0) > 0, mode: 'hard' };
}

/** Which of these ids actually exist and are not archived. */
export async function existingIds(
  descriptor: ResourceDescriptor,
  ids: readonly string[],
  exec: Executor = db,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await exec
    .select({ id: descriptor.primaryKey })
    .from(descriptor.table)
    .where(and(inArray(descriptor.primaryKey, [...ids]), aliveGuard(descriptor)));
  return rows.map((r) => String(r.id));
}

/** One statement for the whole selection: a bulk action is atomic or it is a loop with a race. */
export async function bulkSet(
  descriptor: ResourceDescriptor,
  ids: readonly string[],
  patch: Record<string, string | number | boolean | null>,
  exec: Executor = db,
): Promise<number> {
  const entries = Object.entries(patch);
  if (ids.length === 0 || entries.length === 0) return 0;

  const assignments = sql.join(
    entries.map(([key, value]) => sql`${sql.identifier(physical(descriptor, key))} = ${value}`),
    sql`, `,
  );
  const where = and(inArray(descriptor.primaryKey, [...ids]), aliveGuard(descriptor));

  const result = await exec.execute(sql`
    UPDATE ${descriptor.table} SET ${assignments} WHERE ${where}
  `);
  return result.rowCount ?? 0;
}
