/**
 * Can every active staff member still sign in AFTER the swap to Firebase?
 *
 * Run this BEFORE deploying. Staff passwords now live in Firebase, so an active
 * account that has no Firebase user — or has one with no PASSWORD provider,
 * which is the case for anyone created via Google Sign-In — cannot authenticate
 * at all once this ships. There is no fallback and no self-service recovery:
 * fixing it afterwards means direct database access.
 *
 * Read-only. Sends nothing, changes nothing.
 */

import { getAuth } from 'firebase-admin/auth';
import { getFirebaseApp } from '../src/config/firebase.js';
import { db, closeDb } from './lib.js';

type Row = { email: string; status: string; role: string };

const { rows } = await db().query<Row>(`
  select s.email, s.status, r.key as role
    from staff_users s join roles r on r.id = s.role_id
   where s.deleted_at is null and s.status = 'active'
   order by s.email`);

const auth = getAuth(getFirebaseApp());
let blocked = 0;

console.log(`checking ${rows.length} active staff account(s) against Firebase\n`);

for (const row of rows) {
  let verdict: string;
  try {
    const user = await auth.getUserByEmail(row.email);
    const providers = user.providerData.map((p) => p.providerId);
    // `password` is the only provider signInWithPassword can use. A google.com
    // user has no password credential until they complete a reset.
    const hasPassword = providers.includes('password');
    if (hasPassword) {
      verdict = `OK       can sign in (providers: ${providers.join(', ') || 'password'})`;
    } else {
      blocked++;
      verdict = `BLOCKED  Firebase user exists but has NO password provider (${providers.join(', ') || 'none'})`;
    }
    if (user.disabled) {
      blocked++;
      verdict = 'BLOCKED  the Firebase user is disabled';
    }
  } catch {
    blocked++;
    verdict = 'BLOCKED  no Firebase user for this address at all';
  }
  console.log(`  ${verdict}\n           ${row.email}  (${row.role})`);
}

console.log();
if (blocked === 0) {
  console.log('SAFE TO DEPLOY — every active staff account can authenticate against Firebase.');
} else {
  console.log(`DO NOT DEPLOY — ${blocked} account(s) would be locked out of the admin panel.`);
  console.log();
  console.log('Fix each one first: use Forgot password on the sign-in screen (Firebase sends');
  console.log('the mail) and complete it. That creates the password provider. Then re-run this.');
}

await closeDb();
process.exit(blocked === 0 ? 0 : 1);
