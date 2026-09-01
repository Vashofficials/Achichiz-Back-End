/**
 * Why did the reset email not arrive?
 *
 * `forgotPassword` catches send failures and only logs them — deliberately, so
 * a mail outage cannot be used to probe which accounts exist. The cost is that
 * the operator sees a cheerful "we've sent a reset link" for a send that threw.
 *
 * This calls the REAL SES sender and prints whatever it throws, which is the
 * one piece of information the swallow removes.
 *
 * It SENDS A REAL EMAIL, to the address given on the command line and nowhere
 * else. Run it with the address you are expecting mail at.
 */

import { createSesEmailSender, defaultFrom } from '../src/integrations/ses/index.js';
import { env } from '../src/config/env.js';

const to = process.argv[2];
if (!to) {
  console.error('usage: tsx qa/10-ses-diagnose.ts <recipient@example.com>');
  process.exit(2);
}

console.log('configuration');
console.log(`  NODE_ENV        : ${env.NODE_ENV}`);
console.log(`  AWS region      : ${env.AWS_REGION ?? '(unset)'}`);
console.log(`  AWS key present : ${env.AWS_ACCESS_KEY_ID ? 'yes' : 'NO — sender would fall back to dev/logging'}`);
console.log(`  EMAIL_FROM      : ${defaultFrom()}`);
console.log(`  recipient       : ${to}\n`);

const sender = createSesEmailSender();

try {
  const result = await sender.send({
    to,
    subject: 'Achichiz admin — email delivery test',
    text:
      'This is a delivery test for the Achichiz admin console.\n\n' +
      'If you are reading this, SES is configured correctly and password-reset ' +
      'and invite emails will reach this address.\n\n' +
      'Nothing about your account has changed.\n',
  });
  console.log('SENT — SES accepted the message.');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nIf it still does not arrive, the failure is after SES: check the');
  console.log('spam folder, then the SES suppression list for this address.');
} catch (err) {
  const e = err as { name?: string; message?: string; $metadata?: unknown };
  console.log('FAILED — this is the error the reset flow was hiding:\n');
  console.log(`  name    : ${e.name ?? '(none)'}`);
  console.log(`  message : ${e.message ?? String(err)}`);
  if (e.$metadata) console.log(`  meta    : ${JSON.stringify(e.$metadata)}`);

  const m = `${e.name ?? ''} ${e.message ?? ''}`;
  console.log('\nlikely cause:');
  if (/not verified|MessageRejected/i.test(m)) {
    console.log('  SES is in SANDBOX mode, or the FROM identity is not verified in this region.');
    console.log('  In sandbox, EVERY recipient must also be verified. Request production');
    console.log('  access, or verify this recipient address in the SES console.');
  } else if (/security token|SignatureDoesNotMatch|InvalidClientTokenId|AccessDenied/i.test(m)) {
    console.log('  The AWS credentials are wrong, expired, or lack ses:SendEmail.');
  } else if (/Could not connect|ENOTFOUND|timeout/i.test(m)) {
    console.log('  Network/region problem reaching the SES endpoint.');
  } else {
    console.log('  Unrecognised — the message above is the authoritative detail.');
  }
  process.exit(1);
}
