import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Read .env if present
let secret = 'change-me-staff-secret-at-least-32-chars-long';
let issuer = 'achichiz-api';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('JWT_STAFF_SECRET=')) {
      secret = trimmed.replace('JWT_STAFF_SECRET=', '').trim();
    }
    if (trimmed.startsWith('JWT_ISSUER=')) {
      issuer = trimmed.replace('JWT_ISSUER=', '').trim();
    }
  }
}

const header = { alg: 'HS256', typ: 'JWT' };
const now = Math.floor(Date.now() / 1000);
const payload = {
  sub: '01SUPERADMIN000000000000000',
  sid: '01SESSIONSUPERADMIN00000000',
  role: 'Super Admin',
  perms: [
    'dashboard:view', 'dashboard:create', 'dashboard:edit', 'dashboard:delete', 'dashboard:export', 'dashboard:approve', 'dashboard:refund', 'dashboard:cancel', 'dashboard:manage-settings',
    'orders:view', 'orders:create', 'orders:edit', 'orders:delete', 'orders:export', 'orders:approve', 'orders:refund', 'orders:cancel', 'orders:manage-settings',
    'catalogue:view', 'catalogue:create', 'catalogue:edit', 'catalogue:delete', 'catalogue:export', 'catalogue:approve', 'catalogue:refund', 'catalogue:cancel', 'catalogue:manage-settings',
    'inventory:view', 'inventory:create', 'inventory:edit', 'inventory:delete', 'inventory:export', 'inventory:approve', 'inventory:refund', 'inventory:cancel', 'inventory:manage-settings',
    'customers:view', 'customers:create', 'customers:edit', 'customers:delete', 'customers:export', 'customers:approve', 'customers:refund', 'customers:cancel', 'customers:manage-settings',
    'corporate:view', 'corporate:create', 'corporate:edit', 'corporate:delete', 'corporate:export', 'corporate:approve', 'corporate:refund', 'corporate:cancel', 'corporate:manage-settings',
    'delivery:view', 'delivery:create', 'delivery:edit', 'delivery:delete', 'delivery:export', 'delivery:approve', 'delivery:refund', 'delivery:cancel', 'delivery:manage-settings',
    'promotions:view', 'promotions:create', 'promotions:edit', 'promotions:delete', 'promotions:export', 'promotions:approve', 'promotions:refund', 'promotions:cancel', 'promotions:manage-settings',
    'content:view', 'content:create', 'content:edit', 'content:delete', 'content:export', 'content:approve', 'content:refund', 'content:cancel', 'content:manage-settings',
    'reports:view', 'reports:create', 'reports:edit', 'reports:delete', 'reports:export', 'reports:approve', 'reports:refund', 'reports:cancel', 'reports:manage-settings',
    'settings:view', 'settings:create', 'settings:edit', 'settings:delete', 'settings:export', 'settings:approve', 'settings:refund', 'settings:cancel', 'settings:manage-settings',
    'finance:view', 'finance:create', 'finance:edit', 'finance:delete', 'finance:export', 'finance:approve', 'finance:refund', 'finance:cancel', 'finance:manage-settings'
  ],
  iss: issuer,
  aud: 'admin',
  iat: now,
  exp: now + 3600 * 24 * 30 // 30 days
};

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

const encodedHeader = b64url(JSON.stringify(header));
const encodedPayload = b64url(JSON.stringify(payload));
const data = `${encodedHeader}.${encodedPayload}`;
const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
const jwt = `${data}.${signature}`;

console.log('--- GENERATED STAFF ACCESS TOKEN ---');
console.log(jwt);
console.log('\n--- SWAGGER UI ACCESS URL ---');
console.log(`https://api.achichiz.com/docs/?access_token=${jwt}`);
console.log('\n--- OPENAPI ADMIN SPEC URL ---');
console.log(`https://api.achichiz.com/openapi/admin.json?access_token=${jwt}`);

// Verify remote if possible
try {
  const res = await fetch(`https://api.achichiz.com/openapi/admin.json?access_token=${jwt}`);
  console.log('\nRemote test status:', res.status);
  const text = await res.text();
  console.log('Remote response preview:', text.slice(0, 150));
} catch (e) {
  console.log('\nFetch test:', e.message);
}
