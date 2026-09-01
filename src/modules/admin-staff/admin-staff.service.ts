/**
 * Staff lifecycle rules.
 *
 * Three constraints in `staff_users` drive most of what follows, and breaking
 * any of them is a 500 rather than a clean 422, so they are enforced here first:
 *
 *   uq_staff_email               email is unique among NON-DELETED rows only
 *   staff_active_needs_password  status='active' requires a password_hash
 *   staff_users_status_check     status is exactly invited | active | suspended
 *
 * Withdrawing access always terminates sessions in BOTH places: the
 * `staff_sessions` rows (which gate refresh) and the Redis revocation set (which
 * gates the already-issued access tokens). Doing only the first leaves a
 * suspended member working normally until their access token expires.
 */

import { randomBytes } from 'node:crypto';
import { db } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { maskEmail } from '../../integrations/ses/index.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { revokeSessions } from '../auth/session-store.js';
import * as authRepo from '../admin-auth/admin-auth.repository.js';
import * as repo from './admin-staff.repository.js';
import type { StaffAccount, InviteStaffInput, StaffListQuery, UpdateStaffInput } from './admin-staff.schemas.js';


const view = (row: repo.StaffRow, warehouseScope: string[]): StaffAccount => ({
  id: row.id,
  fullName: row.fullName,
  email: row.email,
  roleId: row.roleId,
  roleKey: row.roleKey,
  roleName: row.roleName,
  warehouseScope,
  mfaEnabled: row.mfaEnabled,
  status: row.status as StaffAccount['status'],
  lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

async function loadOr404(id: string): Promise<repo.StaffRow> {
  const row = await repo.findById(id);
  if (!row) throw new NotFoundError('No such staff account.');
  return row;
}

/**
 * End every live session for one member, in both stores.
 * Returns how many were actually terminated.
 */
async function terminateSessions(staffId: string): Promise<number> {
  const sessionIds = await authRepo.revokeAllSessions(staffId);
  if (sessionIds.length > 0) await revokeSessions(sessionIds);
  return sessionIds.length;
}

/**
 * An operator who suspends or deletes their own account loses the session
 * mid-request and has no endpoint left to undo it with.
 */
function assertNotSelf(target: repo.StaffRow, actorId: string, verb: string): void {
  if (target.id === actorId) {
    throw new UnprocessableError(`You cannot ${verb} your own account.`, 'staff_self_action');
  }
}

/**
 * Refuse changes that would strand the panel with no administrator.
 *
 * Suspending, deleting and demoting the last active super admin are the same
 * lockout by three different routes, so all three come through here.
 */
async function assertNotLastAdmin(target: repo.StaffRow, verb: string): Promise<void> {
  if (target.roleKey !== 'super_admin' || target.status !== 'active') return;
  if ((await repo.otherActiveSuperAdmins(target.id)) === 0) {
    throw new UnprocessableError(
      `This is the last active super admin. Promote another account before you ${verb} this one.`,
      'staff_last_super_admin',
    );
  }
}

/* --------------------------------------------------------------- the reads */

export async function listStaff(
  query: StaffListQuery,
): Promise<{ rows: StaffAccount[]; total: number }> {
  const { rows, total } = await repo.listStaff(query);
  const scopes = await repo.scopesFor(rows.map((r) => r.id));
  return { rows: rows.map((r) => view(r, scopes.get(r.id) ?? [])), total };
}

export async function getStaff(id: string): Promise<StaffAccount> {
  const row = await loadOr404(id);
  return view(row, await repo.scopeFor(id));
}

/* -------------------------------------------------------------- the writes */

export async function inviteStaff(input: InviteStaffInput): Promise<StaffAccount> {
  if (!(await repo.roleExists(input.roleId))) {
    throw new UnprocessableError('That role does not exist.', 'role_not_found');
  }
  if (await repo.emailTaken(input.email, null)) {
    throw new ConflictError('A staff account already uses that email.');
  }

  const id = await db.transaction(async (tx) => {
    const newId = await repo.insertStaff(
      {
        email: input.email,
        fullName: input.fullName,
        roleId: input.roleId,
        // No password here — Firebase holds it. The CHECK permits NULL precisely
        // while `invited`, and `resetPassword` flips the row to `active` once
        // Firebase reports a password was set.
        status: 'invited',
        invitedAt: new Date(),
      },
      tx,
    );
    if (input.warehouseScope?.length) await repo.replaceScope(newId, input.warehouseScope, tx);
    return newId;
  });

  /*
   * The Firebase user must exist before Google will email a reset for it.
   *
   * It is created with a random password nobody ever sees — not left
   * passwordless — so the `password` provider exists from the start. Without
   * that provider `signInWithPassword` has nothing to check against, which is
   * exactly the state that blocks the existing Google-Sign-In admin. The only
   * way into the account is the reset link below.
   */
  try {
    await ensureFirebaseUser(input.email, input.fullName);
    const firebaseRest = await import('../auth/firebase-rest.js');
    await firebaseRest.sendPasswordResetEmail(input.email);
  } catch (err) {
    // The staff row exists either way. A failure here must not roll it back, or
    // the operator retries, hits the email conflict, and cannot proceed at all —
    // use the password-reset endpoint to send another.
    logger.error({ err, staffId: id }, 'staff invite email failed to send');
  }

  return getStaff(id);
}

/**
 * Create the Firebase user for a staff address, or accept that it is already there.
 *
 * `email-already-exists` is a success for our purposes: somebody who shopped on
 * the storefront, or signed in with Google, already has a Firebase identity, and
 * that same identity is what the console will authenticate against.
 */
async function ensureFirebaseUser(email: string, displayName: string): Promise<void> {
  const [{ getAuth }, { getFirebaseApp }] = await Promise.all([
    import('firebase-admin/auth'),
    import('../../config/firebase.js'),
  ]);
  try {
    await getAuth(getFirebaseApp()).createUser({
      email,
      displayName,
      // 32 random bytes. Never logged, never sent, never recoverable — the
      // account is reachable only through the reset link.
      password: randomBytes(32).toString('base64url'),
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/email-already-exists') throw err;
    logger.info({ email: maskEmail(email) }, 'staff invite reused an existing firebase user');
  }
}

export async function updateStaff(id: string, input: UpdateStaffInput): Promise<StaffAccount> {
  const row = await loadOr404(id);

  if (input.email && (await repo.emailTaken(input.email, id))) {
    throw new ConflictError('Another staff account already uses that email.');
  }
  if (input.roleId && !(await repo.roleExists(input.roleId))) {
    throw new UnprocessableError('That role does not exist.', 'role_not_found');
  }
  if (input.status === 'active' && !(await repo.hasPassword(id))) {
    throw new UnprocessableError(
      'This account has not set a password yet, so it cannot be activated. Re-send the invite instead.',
      'staff_needs_password',
    );
  }
  const reassigning = Boolean(input.roleId && input.roleId !== row.roleId);
  if (input.status === 'suspended' || reassigning) {
    await assertNotLastAdmin(row, input.status === 'suspended' ? 'suspend' : 'reassign');
  }

  const suspending = input.status === 'suspended' && row.status !== 'suspended';

  await db.transaction(async (tx) => {
    const patch: Parameters<typeof repo.updateStaff>[1] = {};
    if (input.fullName !== undefined) patch.fullName = input.fullName;
    if (input.email !== undefined) patch.email = input.email;
    if (input.roleId !== undefined) patch.roleId = input.roleId;
    if (input.status !== undefined) patch.status = input.status;
    if (Object.keys(patch).length > 0) await repo.updateStaff(id, patch, tx);
    if (input.warehouseScope !== undefined) await repo.replaceScope(id, input.warehouseScope, tx);
  });

  // A role change alters the permissions baked into the staff JWT, so the old
  // token must not keep working with the old grants.
  if (suspending || reassigning) await terminateSessions(id);

  return getStaff(id);
}

export async function deactivateStaff(
  id: string,
  actorId: string,
  reason?: string,
): Promise<{ id: string; status: 'suspended'; revokedSessions: number }> {
  const row = await loadOr404(id);
  assertNotSelf(row, actorId, 'suspend');
  await assertNotLastAdmin(row, 'suspend');

  await repo.updateStaff(id, { status: 'suspended' });
  const revokedSessions = await terminateSessions(id);
  logger.info({ staffId: id, actorId, reason }, 'staff account deactivated');

  return { id, status: 'suspended', revokedSessions };
}

/**
 * Back to `active` — but only if a password was ever set.
 *
 * Reviving a never-activated invite as `active` violates
 * `staff_active_needs_password`, so it returns to `invited` instead and the
 * caller can re-send the invite.
 */
export async function reactivateStaff(
  id: string,
): Promise<{ id: string; status: 'active' | 'invited'; revokedSessions: number }> {
  const row = await loadOr404(id);
  if (row.status !== 'suspended') {
    throw new UnprocessableError('That account is not suspended.', 'staff_not_suspended');
  }
  const status = (await repo.hasPassword(id)) ? 'active' : 'invited';
  await repo.updateStaff(id, { status });
  return { id, status, revokedSessions: 0 };
}

export async function revokeStaffSessions(id: string): Promise<{ revokedSessions: number }> {
  await loadOr404(id);
  return { revokedSessions: await terminateSessions(id) };
}

export async function sendPasswordReset(id: string): Promise<{ sent: true }> {
  const row = await loadOr404(id);

  /*
   * Google sends this, exactly as it does for the member-initiated reset on the
   * sign-in screen. Both paths end at the same `oobCode`, so there is one way to
   * set a staff password and one place it lives.
   *
   * `ensureFirebaseUser` covers the account invited before this module existed,
   * which has a staff row but no Firebase identity to reset.
   */
  try {
    await ensureFirebaseUser(row.email, row.fullName);
    const firebaseRest = await import('../auth/firebase-rest.js');
    await firebaseRest.sendPasswordResetEmail(row.email);
  } catch (err) {
    logger.error({ err, staffId: id }, 'staff password reset email failed to send');
  }

  return { sent: true };
}

export async function deleteStaff(
  id: string,
  actorId: string,
): Promise<{ id: string; deleted: true; revokedSessions: number }> {
  const row = await loadOr404(id);
  assertNotSelf(row, actorId, 'delete');
  await assertNotLastAdmin(row, 'delete');

  await repo.softDelete(id);
  const revokedSessions = await terminateSessions(id);
  logger.info({ staffId: id, actorId }, 'staff account deleted');

  return { id, deleted: true, revokedSessions };
}
