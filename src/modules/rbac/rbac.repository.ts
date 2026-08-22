/**
 * Drizzle queries for roles and grants. No business rules, no HTTP.
 *
 * These are reads of the DERIVED copy. `lib/rbac-matrix.ts` is the source and
 * `db/seed/roles.ts` is what projects it into these two tables; nothing here
 * writes a grant, because a hand-edited grant that a re-seed would silently undo
 * is worse than no endpoint at all.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import { rolePermissions, roles, staffUsers } from '../../db/schema/index.js';

export type RoleRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  staffCount: number;
  grantCount: number;
};

const staffCount = sql<number>`(
  SELECT count(*)::int FROM staff_users su
   WHERE su.role_id = ${roles.id} AND su.deleted_at IS NULL)`;

const grantCount = sql<number>`(
  SELECT count(*)::int FROM role_permissions rp WHERE rp.role_id = ${roles.id})`;

export async function listRoles(exec: Executor = db): Promise<RoleRow[]> {
  return exec
    .select({
      id: roles.id,
      key: roles.key,
      name: roles.name,
      description: roles.description,
      isSystem: roles.isSystem,
      staffCount,
      grantCount,
    })
    .from(roles)
    .orderBy(asc(roles.name));
}

export async function findRole(roleId: string, exec: Executor = db): Promise<RoleRow | null> {
  const rows = await exec
    .select({
      id: roles.id,
      key: roles.key,
      name: roles.name,
      description: roles.description,
      isSystem: roles.isSystem,
      staffCount,
      grantCount,
    })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findRoleByKey(key: string, exec: Executor = db): Promise<RoleRow | null> {
  const rows = await exec.select({ id: roles.id }).from(roles).where(eq(roles.key, key)).limit(1);
  const id = rows[0]?.id;
  return id ? findRole(id, exec) : null;
}

export async function grantsForRole(
  roleId: string,
  exec: Executor = db,
): Promise<{ module: string; action: string }[]> {
  return exec
    .select({ module: rolePermissions.module, action: rolePermissions.action })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId))
    .orderBy(asc(rolePermissions.module), asc(rolePermissions.action));
}

/** Every grant in the system, keyed by role, for the matrix screen. */
export async function allGrants(
  exec: Executor = db,
): Promise<{ roleKey: string; module: string; action: string }[]> {
  return exec
    .select({ roleKey: roles.key, module: rolePermissions.module, action: rolePermissions.action })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .orderBy(asc(roles.key), asc(rolePermissions.module), asc(rolePermissions.action));
}

export async function membersOfRole(
  roleId: string,
  exec: Executor = db,
): Promise<{ id: string; fullName: string; email: string; status: string }[]> {
  return exec
    .select({
      id: staffUsers.id,
      fullName: staffUsers.fullName,
      email: staffUsers.email,
      status: staffUsers.status,
    })
    .from(staffUsers)
    .where(and(eq(staffUsers.roleId, roleId), isNull(staffUsers.deletedAt)))
    .orderBy(asc(staffUsers.fullName));
}
