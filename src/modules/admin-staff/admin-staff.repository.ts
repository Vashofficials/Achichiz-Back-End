/**
 * Drizzle queries for staff accounts. No business rules, no HTTP.
 *
 * Every read filters `deleted_at IS NULL`. Removal is a soft delete, because the
 * email uniqueness index is itself partial (`uq_staff_email ... WHERE deleted_at
 * IS NULL`) — the schema is explicitly designed so a departed member's address
 * can be re-used, which a hard DELETE would achieve only by also cascading away
 * their sessions and audit trail.
 */

import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import { roles, staffUserWarehouses, staffUsers } from '../../db/schema/index.js';
import { offsetOf, parseSort } from '../../lib/pagination.js';
import type { StaffListQuery } from './admin-staff.schemas.js';

export type StaffRow = {
  id: string;
  fullName: string;
  email: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  mfaEnabled: boolean;
  status: string;
  lastActiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const SORTABLE = ['fullName', 'email', 'status', 'createdAt', 'lastActiveAt'] as const;

const columns = {
  id: staffUsers.id,
  fullName: staffUsers.fullName,
  email: staffUsers.email,
  roleId: staffUsers.roleId,
  roleKey: roles.key,
  roleName: roles.name,
  mfaEnabled: staffUsers.mfaEnabled,
  status: staffUsers.status,
  lastActiveAt: staffUsers.lastActiveAt,
  createdAt: staffUsers.createdAt,
  updatedAt: staffUsers.updatedAt,
};

const sortColumn: Record<string, unknown> = {
  fullName: staffUsers.fullName,
  email: staffUsers.email,
  status: staffUsers.status,
  createdAt: staffUsers.createdAt,
  lastActiveAt: staffUsers.lastActiveAt,
};

export async function listStaff(
  query: StaffListQuery,
  exec: Executor = db,
): Promise<{ rows: StaffRow[]; total: number }> {
  const filters = [isNull(staffUsers.deletedAt)];
  if (query.status) filters.push(eq(staffUsers.status, query.status));
  if (query.roleId) filters.push(eq(staffUsers.roleId, query.roleId));
  if (query.q) {
    const needle = `%${query.q}%`;
    // `!` is safe: `or()` returns undefined only for an empty argument list.
    filters.push(or(ilike(staffUsers.fullName, needle), ilike(staffUsers.email, needle))!);
  }
  const where = and(...filters);

  const { field, direction } = parseSort(query.sort, SORTABLE, { field: 'fullName', direction: 'asc' });
  const col = sortColumn[field] ?? staffUsers.fullName;

  const [rows, counted] = await Promise.all([
    exec
      .select(columns)
      .from(staffUsers)
      .innerJoin(roles, eq(roles.id, staffUsers.roleId))
      .where(where)
      .orderBy(direction === 'desc' ? desc(col as never) : asc(col as never))
      .limit(query.perPage)
      .offset(offsetOf(query.page, query.perPage)),
    exec.select({ n: sql<number>`count(*)::int` }).from(staffUsers).where(where),
  ]);

  return { rows: rows, total: counted[0]?.n ?? 0 };
}

export async function findById(id: string, exec: Executor = db): Promise<StaffRow | null> {
  const rows = await exec
    .select(columns)
    .from(staffUsers)
    .innerJoin(roles, eq(roles.id, staffUsers.roleId))
    .where(and(eq(staffUsers.id, id), isNull(staffUsers.deletedAt)))
    .limit(1);
  return (rows[0] as StaffRow | undefined) ?? null;
}

/** Case-insensitive, and blind to soft-deleted rows — matching `uq_staff_email`. */
export async function emailTaken(email: string, excludeId: string | null, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .select({ id: staffUsers.id })
    .from(staffUsers)
    .where(
      and(
        sql`lower(${staffUsers.email}) = lower(${email})`,
        isNull(staffUsers.deletedAt),
        excludeId ? sql`${staffUsers.id} <> ${excludeId}` : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function roleExists(roleId: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).limit(1);
  return rows.length > 0;
}

/** Has this account ever set a password? Governs whether `active` is reachable. */
export async function hasPassword(id: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .select({ h: staffUsers.passwordHash })
    .from(staffUsers)
    .where(eq(staffUsers.id, id))
    .limit(1);
  return Boolean(rows[0]?.h);
}

/**
 * Live `super_admin` accounts other than `excludeId`.
 *
 * Guards the last-administrator case: suspending or deleting the only remaining
 * super admin locks everyone out of the panel permanently, and no endpoint in
 * this API can undo it.
 */
export async function otherActiveSuperAdmins(excludeId: string, exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(staffUsers)
    .innerJoin(roles, eq(roles.id, staffUsers.roleId))
    .where(
      and(
        eq(roles.key, 'super_admin'),
        eq(staffUsers.status, 'active'),
        isNull(staffUsers.deletedAt),
        sql`${staffUsers.id} <> ${excludeId}`,
      ),
    );
  return rows[0]?.n ?? 0;
}

export async function insertStaff(
  values: typeof staffUsers.$inferInsert,
  exec: Executor = db,
): Promise<string> {
  const rows = await exec.insert(staffUsers).values(values).returning({ id: staffUsers.id });
  return rows[0]!.id;
}

export async function updateStaff(
  id: string,
  patch: Partial<typeof staffUsers.$inferInsert>,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(staffUsers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(staffUsers.id, id));
}

export async function softDelete(id: string, exec: Executor = db): Promise<void> {
  await exec
    .update(staffUsers)
    .set({ deletedAt: new Date(), status: 'suspended', updatedAt: new Date() })
    .where(eq(staffUsers.id, id));
}

/* --------------------------------------------------------- warehouse scope */

export async function scopeFor(id: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .select({ w: staffUserWarehouses.warehouseId })
    .from(staffUserWarehouses)
    .where(eq(staffUserWarehouses.staffUserId, id));
  return rows.map((r) => r.w);
}

/** Scopes for many members in one round trip, so the list is not N+1. */
export async function scopesFor(ids: string[], exec: Executor = db): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await exec
    .select({ s: staffUserWarehouses.staffUserId, w: staffUserWarehouses.warehouseId })
    .from(staffUserWarehouses)
    .where(inArray(staffUserWarehouses.staffUserId, ids));
  for (const r of rows) out.set(r.s, [...(out.get(r.s) ?? []), r.w]);
  return out;
}

export async function replaceScope(id: string, warehouseIds: string[], exec: Executor = db): Promise<void> {
  await exec.delete(staffUserWarehouses).where(eq(staffUserWarehouses.staffUserId, id));
  if (warehouseIds.length > 0) {
    await exec
      .insert(staffUserWarehouses)
      .values(warehouseIds.map((w) => ({ staffUserId: id, warehouseId: w })));
  }
}
