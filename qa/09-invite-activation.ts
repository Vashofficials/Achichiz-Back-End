/**
 * The whole invite chain, end to end, against the real database.
 *
 *   invite  ->  email  ->  link  ->  set password  ->  account usable
 *
 * Each step consumes the OUTPUT of the previous one — the token is scraped from
 * the rendered email and parsed out of the link exactly as a recipient's browser
 * would, never read from the database. That is the point: the previous bug was
 * not a broken function, it was two working halves that could not be joined,
 * and only a test that travels the whole path catches it.
 *
 * The final login asserts `enrolment_required`, not a session. A write-capable
 * role must enrol TOTP before it gets a token, so that outcome IS success: it
 * proves the password verified and the policy engine was reached.
 *
 * SAFETY: sender stubbed, nothing delivered. Account is created, activated,
 * then soft-deleted. Service functions are called directly, so no rate limiter
 * or account-lockout counter is touched.
 */

import { setEmailSender } from '../src/integrations/email/index.js';

let lastEmail = '';
setEmailSender({
  send: async (m) => {
    lastEmail = m.text ?? '';
    return { messageId: 'stubbed', accepted: [m.to] } as never;
  },
});

const [{ db }, staff, auth, { roles, staffUsers }, { eq }] = await Promise.all([
  import('../src/config/db.js'),
  import('../src/modules/admin-staff/admin-staff.service.js'),
  import('../src/modules/admin-auth/admin-auth.service.js'),
  import('../src/db/schema/index.js'),
  import('drizzle-orm'),
]);

const STAMP = Date.now().toString(36);
const EMAIL = `qa-activate-${STAMP}@example.test`;
const PASSWORD = `QaActivate${STAMP}A1`;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`);
};

const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'catalogue_manager')).limit(1);
if (!role) throw new Error('expected the seeded roles to exist');

let id = '';
try {
  /* ------------------------------------------------------------- 1. invite */
  console.log('\n1. invite');
  const created = await staff.inviteStaff({ fullName: 'QA Activation', email: EMAIL, roleId: role.id });
  id = created.id;
  check('account created as `invited`', created.status === 'invited', `status=${created.status}`);

  /* -------------------------------------------- 2. read the link like a human */
  console.log('\n2. the emailed link');
  const url = /https?:\/\/\S+/.exec(lastEmail)?.[0];
  check('email carries a link', Boolean(url));
  const parsed = url ? new URL(url) : null;
  const token = parsed?.searchParams.get('token') ?? '';
  const linkEmail = parsed?.searchParams.get('email') ?? '';
  check('link targets /reset-password', parsed?.pathname === '/reset-password');
  check('link carries the invitee address', linkEmail === EMAIL, `got ${linkEmail}`);
  check('link carries a token', token.length > 20, `length ${token.length}`);

  /* ------------------------------- 3. set the password using ONLY the link */
  console.log('\n3. set password from the link');
  await auth.resetPassword({ email: linkEmail, token, newPassword: PASSWORD });
  check('resetPassword accepted the emailed token', true);

  const [row] = await db
    .select({ status: staffUsers.status, hash: staffUsers.passwordHash })
    .from(staffUsers)
    .where(eq(staffUsers.id, id))
    .limit(1);
  check('account flipped invited -> active', row?.status === 'active', `status=${row?.status}`);
  check('password is stored (hashed)', Boolean(row?.hash) && !row?.hash?.includes(PASSWORD));

  /* ------------------------------------------------- 4. the token is spent */
  console.log('\n4. the token is single-use');
  try {
    await auth.resetPassword({ email: linkEmail, token, newPassword: `${PASSWORD}z` });
    check('reusing the token is refused', false, 'it was ACCEPTED — the token is replayable');
  } catch {
    check('reusing the token is refused', true);
  }

  /* --------------------------------------------------- 5. the account works */
  console.log('\n5. sign in');
  const login = await auth.login({ email: EMAIL, password: PASSWORD }, {});
  check(
    'correct password reaches the MFA policy (enrolment_required)',
    login.result.status === 'enrolment_required',
    `got ${login.result.status}`,
  );
  check('no session issued before TOTP enrolment', login.result.tokens === null);

  try {
    await auth.login({ email: EMAIL, password: 'WrongPassword123' }, {});
    check('a wrong password is rejected', false, 'it was ACCEPTED');
  } catch {
    check('a wrong password is rejected', true);
  }

  /* ------------------------------------------------ 6. forgot password flow */
  // Run against THIS throwaway account only. Never the real administrator.
  console.log('\n6. forgot password');
  lastEmail = '';
  await auth.forgotPassword(EMAIL);
  const resetUrl = /https?:\/\/\S+/.exec(lastEmail)?.[0];
  const resetParsed = resetUrl ? new URL(resetUrl) : null;
  const resetToken = resetParsed?.searchParams.get('token') ?? '';
  check('reset email carries a link', Boolean(resetUrl));
  check('reset link targets /reset-password', resetParsed?.pathname === '/reset-password');
  check('reset link carries a token', resetToken.length > 20, `length ${resetToken.length}`);

  const ROTATED = `QaRotated${STAMP}B2`;
  await auth.resetPassword({ email: EMAIL, token: resetToken, newPassword: ROTATED });
  const after = await auth.login({ email: EMAIL, password: ROTATED }, {});
  check('the new password works', after.result.status === 'enrolment_required', `got ${after.result.status}`);

  try {
    await auth.login({ email: EMAIL, password: PASSWORD }, {});
    check('the OLD password stops working', false, 'it was ACCEPTED — the reset did not take');
  } catch {
    check('the OLD password stops working', true);
  }

  // An unknown address must look identical to a known one, or the endpoint is
  // an account-enumeration oracle.
  await auth.forgotPassword(`nobody-${STAMP}@example.test`);
  check('an unknown address is handled without throwing', true);
} finally {
  if (id) {
    console.log('\ncleanup');
    await staff.deleteStaff(id, 'qa-not-this-account');
    check('test account soft-deleted', (await staff.listStaff({ page: 1, perPage: 5, q: `qa-activate-${STAMP}` })).total === 0);
  }
  console.log(`\n${pass}/${pass + fail} checks passed · 0 emails delivered (sender stubbed)`);
  process.exit(fail === 0 ? 0 : 1);
}
