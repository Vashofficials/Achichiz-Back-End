/**
 * Drizzle queries for staff authentication. No business rules, no HTTP.
 *
 * Recovery-code digests live in `app_settings` under `staff.mfa.recovery.<id>`.
 * The shipped schema has no recovery-code table and `src/db/**` is not ours to
 * change; `app_settings` is a key/JSONB store that already exists for exactly
 * this kind of small operational state, and only sha256 digests are written.
 */

import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../config/db.js';
import {
  appSettings,
  otpChallenges,
  rolePermissions,
  roles,
  staffSessions,
  staffUserWarehouses,
  staffUsers,
  type StaffSession,
  type StaffUser,
} from '../../db/schema/index.js';

export type StaffWithRole = {
  staff: StaffUser;
  roleKey: string;
  roleName: string;
};

const RECOVERY_KEY = (staffId: string): string => `staff.mfa.recovery.${staffId}`;

/* ------------------------------------------------------------------ reads */

/**
 * Case-insensitive because `staff_users.email` is CITEXT in the database while
 * Drizzle sees it as `text` — comparing with `lower()` on both sides keeps the
 * behaviour identical whichever side runs it.
 */
export async function findByEmail(email: string, exec: Executor = db): Promise<StaffWithRole | null> {
  const rows = await exec
    .select({ staff: staffUsers, roleKey: roles.key, roleName: roles.name })
    .from(staffUsers)
    .innerJoin(roles, eq(roles.id, staffUsers.roleId))
    .where(and(sql`lower(${staffUsers.email}) = lower(${email})`, isNull(staffUsers.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findById(staffId: string, exec: Executor = db): Promise<StaffWithRole | null> {
  const rows = await exec
    .select({ staff: staffUsers, roleKey: roles.key, roleName: roles.name })
    .from(staffUsers)
    .innerJoin(roles, eq(roles.id, staffUsers.roleId))
    .where(and(eq(staffUsers.id, staffId), isNull(staffUsers.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/** `['orders:view', 'orders:refund', ...]` — the wire format the JWT carries. */
export async function permissionsForRole(roleId: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .select({ module: rolePermissions.module, action: rolePermissions.action })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((r) => `${r.module}:${r.action}`).sort();
}

/** Zero rows means "all warehouses" — see the schema comment on the table. */
export async function warehouseScopeFor(staffId: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .select({ warehouseId: staffUserWarehouses.warehouseId })
    .from(staffUserWarehouses)
    .where(eq(staffUserWarehouses.staffUserId, staffId));
  return rows.map((r) => r.warehouseId);
}

export async function listActiveSessions(staffId: string, exec: Executor = db): Promise<StaffSession[]> {
  return exec
    .select()
    .from(staffSessions)
    .where(
      and(
        eq(staffSessions.staffUserId, staffId),
        isNull(staffSessions.revokedAt),
        gt(staffSessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(staffSessions.lastActiveAt));
}

export async function findLiveSessionByRefreshHash(
  hash: string,
  exec: Executor = db,
): Promise<StaffSession | null> {
  const rows = await exec
    .select()
    .from(staffSessions)
    .where(eq(staffSessions.refreshTokenHash, hash))
    .limit(1);
  return rows[0] ?? null;
}

export async function findSession(
  sessionId: string,
  exec: Executor = db,
): Promise<StaffSession | null> {
  const rows = await exec.select().from(staffSessions).where(eq(staffSessions.id, sessionId)).limit(1);
  return rows[0] ?? null;
}

/* ----------------------------------------------------------------- writes */

export async function insertSession(
  values: typeof staffSessions.$inferInsert,
  exec: Executor = db,
): Promise<StaffSession> {
  const rows = await exec.insert(staffSessions).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to create a staff session');
  return row;
}

export async function rotateSession(
  sessionId: string,
  refreshTokenHash: string,
  expiresAt: Date,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(staffSessions)
    .set({ refreshTokenHash, expiresAt, lastActiveAt: new Date() })
    .where(eq(staffSessions.id, sessionId));
}

export async function revokeSessionRow(sessionId: string, exec: Executor = db): Promise<void> {
  await exec
    .update(staffSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(staffSessions.id, sessionId), isNull(staffSessions.revokedAt)));
}

/** "Sign out everywhere", and the automatic response to a refresh-token replay. */
export async function revokeAllSessions(staffId: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .update(staffSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(staffSessions.staffUserId, staffId), isNull(staffSessions.revokedAt)))
    .returning({ id: staffSessions.id });
  return rows.map((r) => r.id);
}

export async function updateStaff(
  staffId: string,
  patch: Partial<typeof staffUsers.$inferInsert>,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(staffUsers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(staffUsers.id, staffId));
}

/**
 * Failed-login accounting.
 *
 * The increment and the lock decision are one statement so two parallel guesses
 * cannot both read `4` and both write `5`.
 */
export async function registerFailedLogin(
  staffId: string,
  threshold: number,
  lockMinutes: number,
  exec: Executor = db,
): Promise<void> {
  await exec.execute(sql`
    UPDATE staff_users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= ${threshold}
             THEN now() + (${lockMinutes} || ' minutes')::interval
             ELSE locked_until
           END,
           updated_at = now()
     WHERE id = ${staffId}::uuid
  `);
}

export async function clearFailedLogins(staffId: string, exec: Executor = db): Promise<void> {
  await exec
    .update(staffUsers)
    .set({ failedLoginCount: 0, lockedUntil: null, lastActiveAt: new Date(), updatedAt: new Date() })
    .where(eq(staffUsers.id, staffId));
}

/* -------------------------------------------------------- recovery codes */

export async function putRecoveryCodes(
  staffId: string,
  digests: readonly string[],
  exec: Executor = db,
): Promise<void> {
  await exec
    .insert(appSettings)
    .values({
      key: RECOVERY_KEY(staffId),
      value: { digests },
      description: 'sha256 digests of unused 2FA recovery codes. Never the codes themselves.',
      isPublic: false,
      updatedBy: staffId,
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: { digests }, updatedBy: staffId, updatedAt: new Date() },
    });
}

export async function getRecoveryCodes(staffId: string, exec: Executor = db): Promise<string[]> {
  const rows = await exec
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, RECOVERY_KEY(staffId)))
    .limit(1);

  const value = rows[0]?.value;
  if (!value || typeof value !== 'object' || !('digests' in value)) return [];
  const digests = (value).digests;
  return Array.isArray(digests) ? digests.filter((d): d is string => typeof d === 'string') : [];
}

/* --------------------------------------------------------- password reset */

export async function insertResetChallenge(
  values: typeof otpChallenges.$inferInsert,
  exec: Executor = db,
): Promise<void> {
  await exec.insert(otpChallenges).values(values);
}

export async function findLiveResetChallenge(
  email: string,
  exec: Executor = db,
): Promise<typeof otpChallenges.$inferSelect | null> {
  const rows = await exec
    .select()
    .from(otpChallenges)
    .where(
      and(
        sql`lower(${otpChallenges.destination}) = lower(${email})`,
        eq(otpChallenges.purpose, 'password_reset'),
        isNull(otpChallenges.consumedAt),
        gt(otpChallenges.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function consumeResetChallenge(id: string, exec: Executor = db): Promise<void> {
  await exec.update(otpChallenges).set({ consumedAt: new Date() }).where(eq(otpChallenges.id, id));
}

export async function bumpResetAttempts(id: string, exec: Executor = db): Promise<void> {
  await exec
    .update(otpChallenges)
    .set({ attempts: sql`${otpChallenges.attempts} + 1` })
    .where(eq(otpChallenges.id, id));
}
