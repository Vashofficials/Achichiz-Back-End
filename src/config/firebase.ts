import { cert, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Load the service-account key from the project root.
const serviceAccountPath = join(process.cwd(), 'serviceAccountKey.json');
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8')) as ServiceAccount;

// Initialize Firebase Admin SDK
export const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
});
