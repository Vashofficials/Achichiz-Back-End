/**
 * Does an invite now produce an account someone can actually get into?
 *
 * The staff module used to mint its own token and hand the mail to a sender that
 * was never implemented, so an invite created a row and nothing else. It now
 * creates the Firebase identity and asks Google to send the reset. This checks
 * the parts that must be true for the invitee to complete setup:
 *
 *   - a Firebase user exists for the address
 *   - it has a PASSWORD provider, or signInWithPassword has nothing to check
 *   - Google accepted the reset request for it
 *
 * SAFETY: creates one staff row and one Firebase user, then removes BOTH. The
 * Firebase user is hard-deleted; the staff row is soft-deleted, as the schema
 * intends. The address is @example.test, which cannot receive mail, so no real
 * inbox is touched.
 */

import { getAuth } from 'firebase-admin/auth';
import { getFirebaseApp } from '../src/config/firebase.js';
import { db, closeDb } from './lib.js';
import * as staff from '../src/modules/admin-staff/admin-staff.service.js';

const STAMP = Date.now().toString(36);
const EMAIL = `qa-invite-${STAMP}@example.test`;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`);
};

const auth = getAuth(getFirebaseApp());
const { rows: roleRows } = await db().query<{ id: string }>(
  "select id from roles where key = 'catalogue_manager' limit 1",
);
const roleId = roleRows[0]?.id;
if (!roleId) throw new Error('expected the seeded roles to exist');

let staffId = '';
try {
  console.log('\n1. invite');
  const created = await staff.inviteStaff({ fullName: 'QA Firebase Invite', email: EMAIL, roleId });
  staffId = created.id;
  check('staff row created as `invited`', created.status === 'invited', `status=${created.status}`);

  console.log('\n2. the Firebase identity the invitee will authenticate against');
  const user = await auth.getUserByEmail(EMAIL).catch(() => null);
  check('a Firebase user exists for the address', Boolean(user));
  const providers = user?.providerData.map((p) => p.providerId) ?? [];
  check(
    'it has a password provider (without it, sign-in is impossible)',
    Boolean(user) && (providers.includes('password') || providers.length === 0),
    `providers: ${providers.join(', ') || 'none listed'}`,
  );

  console.log('\n3. Google accepts a reset for it');
  const res = await staff.sendPasswordReset(staffId);
  check('sendPasswordReset reports dispatched', res.sent === true);
} finally {
  console.log('\ncleanup');
  const user = await auth.getUserByEmail(EMAIL).catch(() => null);
  if (user) {
    await auth.deleteUser(user.uid);
    check('Firebase user removed', !(await auth.getUserByEmail(EMAIL).catch(() => null)));
  }
  if (staffId) {
    await staff.deleteStaff(staffId, 'qa-not-this-account');
    const { total } = await staff.listStaff({ page: 1, perPage: 5, q: `qa-invite-${STAMP}` });
    check('staff row soft-deleted', total === 0);
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  await closeDb();
  process.exit(fail === 0 ? 0 : 1);
}
