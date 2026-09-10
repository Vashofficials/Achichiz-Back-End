import { authenticator } from 'otplib';
import { db } from './src/config/db.js';
import { staffUsers } from './src/db/schema/index.js';
import { eq } from 'drizzle-orm';

async function main() {
  console.log('1. Attempting login...');
  const loginRes = await fetch('http://localhost:4000/v1/admin/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'achichizofficial@gmail.com', password: 'AuditPassword123!' })
  });
  const loginJson = await loginRes.json();
  console.log('Login response status:', loginRes.status, JSON.stringify(loginJson, null, 2));

  if (loginJson.result?.status === 'enrolment_required') {
    const challengeToken = loginJson.result.challengeToken;
    console.log('2. Setting up 2FA...');
    const setupRes = await fetch('http://localhost:4000/v1/admin/auth/2fa/setup', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${challengeToken}`
      },
      body: JSON.stringify({ challengeToken })
    });
    const setupJson = await setupRes.json();
    console.log('Setup response:', JSON.stringify(setupJson, null, 2));
    const secret = setupJson.result.secret;
    const code = authenticator.generate(secret);
    console.log('Generated TOTP code:', code);

    console.log('3. Enabling 2FA...');
    const enableRes = await fetch('http://localhost:4000/v1/admin/auth/2fa/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken, code, deviceLabel: 'Audit Bot' })
    });
    const enableJson = await enableRes.json();
    console.log('Enable response:', JSON.stringify(enableJson, null, 2));
    console.log('Set-Cookie headers:', enableRes.headers.get('set-cookie'));
  } else if (loginJson.result?.status === 'mfa_required') {
    console.log('2. MFA is required. Fetching staff user secret from DB...');
    const [staff] = await db.select().from(staffUsers).where(eq(staffUsers.email, 'achichizofficial@gmail.com'));
    if (!staff || !staff.mfaSecret) {
      throw new Error('Staff or mfaSecret not found');
    }
    const challengeToken = loginJson.result.challengeToken;
    const code = authenticator.generate(staff.mfaSecret);
    console.log('Generated TOTP code from DB secret:', code);

    console.log('3. Verifying 2FA...');
    const verifyRes = await fetch('http://localhost:4000/v1/admin/auth/2fa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken, code, deviceLabel: 'Audit Bot' })
    });
    const verifyJson = await verifyRes.json();
    console.log('Verify response:', JSON.stringify(verifyJson, null, 2));
    console.log('Set-Cookie headers:', verifyRes.headers.get('set-cookie'));
  } else if (loginJson.result?.status === 'authenticated') {
    console.log('Already authenticated!');
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
