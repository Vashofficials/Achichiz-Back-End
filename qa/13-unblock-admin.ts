/**
 * Recover the locked-out administrator.
 *
 * Three separate mechanisms are currently refusing this account, and only the
 * outermost one is visible on the sign-in screen:
 *
 *   1. the `auth` rate limiter        429, resets on its own
 *   2. the account lockout            5 failed attempts -> locked_until
 *   3. NO FIREBASE PASSWORD           the actual cause; login now verifies
 *                                     against Firebase, and this account has
 *                                     only a google.com provider
 *
 * This clears (2) and re-sends the mail that fixes (3). It does NOT weaken
 * either mechanism: the lockout counter resets to zero and the rule stays fully
 * in force for the next five failures, exactly as for anyone else.
 *
 * The reset request goes STRAIGHT to Google, not through this API, so it works
 * while /v1/admin/auth/* is still returning 429.
 */

import { db, closeDb } from './lib.js';
import { env } from '../src/config/env.js';

const EMAIL = process.argv[2] ?? 'vashtechnical@gmail.com';

const read = async (): Promise<unknown> =>
  (
    await db().query(
      `select failed_login_count, locked_until,
              (locked_until is not null and locked_until > now()) as locked
         from staff_users where lower(email) = lower($1)`,
      [EMAIL],
    )
  ).rows[0];

console.log('lockout before :', JSON.stringify(await read()));

await db().query(
  `update staff_users
      set failed_login_count = 0, locked_until = null, updated_at = now()
    where lower(email) = lower($1)`,
  [EMAIL],
);

console.log('lockout after  :', JSON.stringify(await read()));

const res = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${env.FIREBASE_API_KEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: EMAIL }),
  },
);
console.log(`\nfirebase reset : HTTP ${res.status} ${res.ok ? 'ACCEPTED — check the inbox' : 'REJECTED'}`);
if (!res.ok) console.log(JSON.stringify(await res.json().catch(() => ({}))));

await closeDb();
