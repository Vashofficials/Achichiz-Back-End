/**
 * What does the invite email actually SAY?
 *
 * The bug this guards against is not a crash — it is an email that arrives
 * looking fine and cannot be acted on, which is what shipped: a bare token with
 * no link, while the panel's /reset-password page requires `?token=&email=`.
 *
 * SAFETY: the sender is stubbed, so nothing is delivered (this runs with
 * NODE_ENV=production, where the real sender is SES). The account created is
 * `invited` with no password — unusable — and is soft-deleted at the end.
 */

import { setEmailSender } from '../src/integrations/email/index.js';

let captured: { to: string; subject: string; text: string } | null = null;
setEmailSender({
  send: async (m) => {
    captured = { to: m.to, subject: m.subject, text: m.text ?? '' };
    return { messageId: 'stubbed', accepted: [m.to] } as never;
  },
});

const [{ db }, staff, { roles }, { eq }] = await Promise.all([
  import('../src/config/db.js'),
  import('../src/modules/admin-staff/admin-staff.service.js'),
  import('../src/db/schema/index.js'),
  import('drizzle-orm'),
]);

const STAMP = Date.now().toString(36);
const EMAIL = `qa-invite-${STAMP}@example.test`;

const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'catalogue_manager')).limit(1);
if (!role) throw new Error('expected the seeded roles to exist');

const created = await staff.inviteStaff({ fullName: 'QA Invitee', email: EMAIL, roleId: role.id });

console.log('='.repeat(72));
console.log(`To:      ${captured?.to}`);
console.log(`Subject: ${captured?.subject}`);
console.log('-'.repeat(72));
console.log(captured?.text);
console.log('='.repeat(72));

/* The link must be one the panel can actually parse. */
const url = /https?:\/\/\S+/.exec(captured?.text ?? '')?.[0];
const parsed = url ? new URL(url) : null;
const checks: [string, boolean][] = [
  ['email contains a clickable link', Boolean(url)],
  ['link targets /reset-password', parsed?.pathname === '/reset-password'],
  ['link carries a token', Boolean(parsed?.searchParams.get('token'))],
  ['link carries the invitee email', parsed?.searchParams.get('email') === EMAIL],
  ['token is also shown as a fallback', (captured?.text.match(/[A-Za-z0-9_-]{40,}/g)?.length ?? 0) >= 1],
];
for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);

await staff.deleteStaff(created.id, 'qa-not-this-account');
console.log('\ncleanup: invited account soft-deleted; 0 emails actually sent.');
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
