/**
 * Check `serviceAccountKey.json` is present, valid and complete — and repair it
 * if a stray byte crept in ahead of the opening brace, which has happened twice
 * and produces a startup error that says nothing about a typo.
 *
 * This used to also emit `firebase-env.local.txt` for pasting into `.env`. That
 * approach is gone: the key is bind-mounted instead, so there is no env value to
 * prepare. See docs/FIX-FIREBASE-DEPLOY.md.
 *
 * Nothing key-shaped is printed — only a fingerprint.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FILE = 'serviceAccountKey.json';

if (!existsSync(FILE)) {
  console.error(`${FILE} not found. Download one from the Firebase console:`);
  console.error('  Project settings -> Service accounts -> Generate new private key');
  process.exit(1);
}

const raw = readFileSync(FILE, 'utf8');
const start = raw.indexOf('{');
const end = raw.lastIndexOf('}');

if (start === -1 || end === -1) {
  console.error(`No JSON object found in ${FILE}. Re-download it from the Firebase console.`);
  process.exit(1);
}

let key;
try {
  key = JSON.parse(raw.slice(start, end + 1));
} catch (e) {
  console.error('Still not valid JSON after trimming: ' + String(e).slice(0, 120));
  console.error('Re-download the key from Firebase console -> Project settings -> Service accounts.');
  process.exit(1);
}

if (start !== 0 || end !== raw.trimEnd().length - 1) {
  if (!existsSync(FILE + '.bak')) copyFileSync(FILE, FILE + '.bak');
  writeFileSync(FILE, JSON.stringify(key, null, 2) + '\n', 'utf8');
  console.log(`REPAIRED ${FILE}: removed ${start} stray leading byte(s). Backup at ${FILE}.bak`);
}

for (const field of ['project_id', 'client_email', 'private_key']) {
  if (!key[field]) {
    console.error(`Key is missing "${field}" — this is not a service-account key.`);
    process.exit(1);
  }
}

console.log('project_id  :', key.project_id);
console.log('client_email:', key.client_email);
console.log('key_id      :', String(key.private_key_id).slice(0, 8) + '…');
console.log('fingerprint :', createHash('sha256').update(key.private_key).digest('hex').slice(0, 16));
console.log('\nValid. It is mounted into the container by docker-compose.prod.yml — nothing to copy into .env.');
