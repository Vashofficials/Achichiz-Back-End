/**
 * The staff lifecycle, exercised against the real database.
 *
 * The schema constraints are the whole risk in this module — `uq_staff_email` is
 * partial, `staff_active_needs_password` blocks the obvious reactivate, and both
 * only fail at write time. Unit tests on the zod contracts cannot reach them, so
 * this drives the service layer directly and asserts what the tables actually
 * did.
 *
 * SAFETY:
 *   - the email sender is stubbed, so NO mail is sent (this runs with
 *     NODE_ENV=production, where the real sender is SES);
 *   - the account it creates is `invited` with no password, so it cannot sign in
 *     even if cleanup fails;
 *   - everything is prefixed `qa-staff-` and soft-deleted at the end;
 *   - it touches no existing account.
 */

import { setEmailSender } from '../src/integrations/ses/index.js';

const sent: string[] = [];
setEmailSender({
  send: async (m) => {
    sent.push(m.to);
    return { messageId: 'stubbed', accepted: [m.to] } as never;
  },
});

const [{ db }, staff, repo, { roles, staffUsers }, { and, eq, isNull }] = await Promise.all([
  import('../src/config/db.js'),
  import('../src/modules/admin-staff/admin-staff.service.js'),
  import('../src/modules/admin-staff/admin-staff.repository.js'),
  import('../src/db/schema/index.js'),
  import('drizzle-orm'),
]);

const STAMP = Date.now().toString(36);
const EMAIL = `qa-staff-${STAMP}@example.test`;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `\n        ${detail}` : ''}`);
};

async function expectReject(label: string, code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(label, false, 'it was ACCEPTED — the guard did not fire');
  } catch (err) {
    const actual = (err as { code?: string }).code ?? '';
    check(label, actual === code, `expected code ${code}, got ${actual}: ${(err as Error).message}`);
  }
}

const main = async (): Promise<void> => {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'catalogue_manager')).limit(1);
  const [admin] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'super_admin')).limit(1);
  if (!role || !admin) throw new Error('expected the seeded system roles to exist');

  let id = '';
  try {
    console.log('--- invite ---');
    const created = await staff.inviteStaff({ fullName: `QA Staff ${STAMP}`, email: EMAIL, roleId: role.id });
    id = created.id;
    check('created as `invited`', created.status === 'invited', `status=${created.status}`);
    check('no password set yet', !(await repo.hasPassword(id)));
    check('an invite email was dispatched (stubbed)', sent.includes(EMAIL));
    check('scope defaults to empty = all warehouses', created.warehouseScope.length === 0);

    console.log('\n--- constraint guards ---');
    await expectReject('a duplicate email is a 409, not a Postgres error', 'conflict', () =>
      staff.inviteStaff({ fullName: 'Dup', email: EMAIL.toUpperCase(), roleId: role.id }),
    );
    await expectReject('activating a passwordless account is refused', 'staff_needs_password', () =>
      staff.updateStaff(id, { status: 'active' }),
    );
    await expectReject('an unknown role is refused', 'role_not_found', () =>
      staff.updateStaff(id, { roleId: '00000000-0000-4000-8000-000000000000' }),
    );

    console.log('\n--- update ---');
    const renamed = await staff.updateStaff(id, { fullName: 'QA Staff Renamed', roleId: admin.id });
    check('name changed', renamed.fullName === 'QA Staff Renamed');
    check('role reassigned', renamed.roleKey === 'super_admin', `roleKey=${renamed.roleKey}`);

    console.log('\n--- last-super-admin guard ---');
    // This account is now super_admin but still `invited`. The guard counts only
    // ACTIVE ones, so it must NOT make the real administrator look expendable.
    const [realAdmin] = await db
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(and(eq(staffUsers.roleId, admin.id), eq(staffUsers.status, 'active'), isNull(staffUsers.deletedAt)))
      .limit(1);
    check('a real active super admin exists to protect', Boolean(realAdmin));
    if (realAdmin) {
      const backups = await repo.otherActiveSuperAdmins(realAdmin.id);
      check(
        'the invited account does NOT count as a backup for the real admin',
        backups === 0,
        `otherActiveSuperAdmins(real) = ${backups}, expected 0 — an invited account was counted as active`,
      );
    }
    check('the real admin IS counted when protecting this account', (await repo.otherActiveSuperAdmins(id)) >= 1);

    console.log('\n--- suspend / restore ---');
    const off = await staff.deactivateStaff(id, 'not-this-account', 'qa lifecycle');
    check('suspended', off.status === 'suspended');
    const on = await staff.reactivateStaff(id);
    check('restored to `invited`, not `active`, with no password', on.status === 'invited', `status=${on.status}`);

    await expectReject('you cannot suspend your own account', 'staff_self_action', () =>
      staff.deactivateStaff(id, id),
    );

    console.log('\n--- sessions ---');
    const rev = await staff.revokeStaffSessions(id);
    check('revoke returns a count (0 for a never-signed-in account)', rev.revokedSessions === 0);

    console.log('\n--- list & filter ---');
    const listed = await staff.listStaff({ page: 1, perPage: 25, q: `qa-staff-${STAMP}` });
    check('the new account is findable by search', listed.rows.some((r) => r.id === id), `total=${listed.total}`);
  } finally {
    if (id) {
      console.log('\n--- cleanup ---');
      const gone = await staff.deleteStaff(id, 'not-this-account');
      check('soft-deleted', gone.deleted === true);
      const [row] = await db
        .select({ d: staffUsers.deletedAt })
        .from(staffUsers)
        .where(eq(staffUsers.id, id))
        .limit(1);
      check('row retained with deleted_at set (not hard-deleted)', Boolean(row?.d));
      check('and it no longer appears in reads', (await repo.findById(id)) === null);
      check('the email is free for re-use', !(await repo.emailTaken(EMAIL, null)));
    }
    console.log(`\n${pass}/${pass + fail} checks passed`);
    console.log(`emails actually sent to a real provider: 0 (sender stubbed; ${sent.length} intercepted)`);
    process.exit(fail === 0 ? 0 : 1);
  }
};

await main();
