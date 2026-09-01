/**
 * Why did the email not arrive?
 *
 * `forgotPassword` catches send failures and only logs them — deliberately, so
 * a mail outage cannot be used to probe which accounts exist. The cost is that
 * the operator sees a cheerful "we've sent a reset link" for a send that threw.
 *
 * This calls the REAL sender and prints whatever it throws, which is the one
 * piece of information the swallow removes.
 *
 * It SENDS A REAL EMAIL, to the address given on the command line and nowhere
 * else. Run it with the address you are expecting mail at.
 */

import { createSmtpEmailSender, defaultFrom } from '../src/integrations/email/index.js';
import { env } from '../src/config/env.js';

const to = process.argv[2];
if (!to) {
  console.error('usage: tsx qa/10-email-diagnose.ts <recipient@example.com>');
  process.exit(2);
}

console.log('configuration');
console.log(`  NODE_ENV     : ${env.NODE_ENV}`);
console.log(`  SMTP host    : ${env.SMTP_HOST}:${env.SMTP_PORT}`);
console.log(`  SMTP user    : ${env.SMTP_USER || 'NOT SET — delivery is disabled'}`);
console.log(`  SMTP password: ${env.SMTP_PASSWORD ? 'set' : 'NOT SET — delivery is disabled'}`);
console.log(`  EMAIL_FROM   : ${defaultFrom()}`);
console.log(`  recipient    : ${to}\n`);

if (!env.SMTP_USER || !env.SMTP_PASSWORD) {
  console.log('SMTP_USER / SMTP_PASSWORD are unset, so the app uses the no-op sender');
  console.log('and delivers nothing. Set both, then run this again.');
  process.exit(1);
}

/*
 * Gmail rewrites a From it does not own, so mail "sends" and arrives from the
 * wrong address. Worth catching here rather than wondering later.
 */
if (!defaultFrom().includes(env.SMTP_USER)) {
  console.log(`NOTE: EMAIL_FROM does not contain SMTP_USER (${env.SMTP_USER}).`);
  console.log('      Gmail will rewrite the From unless it is a verified alias.\n');
}

try {
  const result = await createSmtpEmailSender().send({
    to,
    subject: 'Achichiz admin — email delivery test',
    text:
      'This is a delivery test for the Achichiz admin console.\n\n' +
      'If you are reading this, SMTP is configured correctly and password-reset ' +
      'and staff-invite emails will reach this address.\n\n' +
      'Nothing about your account has changed.\n',
  });
  console.log('SENT — the mail server accepted the message.');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nIf it still does not arrive, the failure is after the handoff:');
  console.log('check the spam folder first.');
} catch (err) {
  const cause = (err as { cause?: unknown }).cause ?? err;
  const e = cause as { code?: string; responseCode?: number; message?: string };
  console.log('FAILED — this is the error the reset flow was hiding:\n');
  console.log(`  code    : ${e.code ?? '(none)'}`);
  console.log(`  status  : ${e.responseCode ?? '(none)'}`);
  console.log(`  message : ${e.message ?? String(cause)}`);

  const m = `${e.code ?? ''} ${e.message ?? ''}`;
  console.log('\nlikely cause:');
  if (/EAUTH|535|Username and Password not accepted/i.test(m)) {
    console.log('  Google rejected the credentials. SMTP_PASSWORD must be a 16-character APP');
    console.log('  PASSWORD, not the account password, and 2-Step Verification must be on:');
    console.log('  myaccount.google.com -> Security -> 2-Step Verification -> App passwords.');
  } else if (/ETIMEDOUT|ECONNREFUSED|ESOCKET|ECONNECTION/i.test(m)) {
    console.log('  Could not reach the SMTP server. Outbound port 465/587 may be blocked —');
    console.log('  common on cloud hosts. Try the other port, or ask the provider to open it.');
  } else if (/self.signed|certificate|TLS/i.test(m)) {
    console.log('  TLS negotiation failed. Port 465 needs secure:true, 587 needs secure:false.');
  } else {
    console.log('  Unrecognised — the message above is the authoritative detail.');
  }
  process.exit(1);
}
