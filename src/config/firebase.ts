/**
 * Firebase Admin, initialised LAZILY.
 *
 * The previous version read `serviceAccountKey.json` and called `initializeApp`
 * at module top level, so merely *importing* anything downstream of it crashed on
 * a machine without the key. That machine is not hypothetical: CI gate 1 runs
 * `npx tsx src/lib/openapi/generate.ts`, which imports `src/routes.ts` and with it
 * the whole module graph, on a box that has no service-account key and no reason
 * to have one. Generating a document is metadata work; it must not need secrets.
 *
 * Same reasoning, same shape as `middleware/rate-limit.ts` (which defers building
 * its RedisStore) and `config/redis.ts` (`lazyConnect: true`). Nothing here
 * touches the filesystem or the network until the first token is actually
 * verified, and the failure — when there is one — names every way to fix it.
 *
 * Nothing in this file ever logs or embeds the key material. Error messages carry
 * the ORIGIN of a credential (which variable, which path), never its contents.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cert, getApps, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app';
import { env } from './env.js';

/** The dev-time convention: a key file sitting in the project root. */
export const SERVICE_ACCOUNT_FILENAME = 'serviceAccountKey.json';

/**
 * A named app rather than `[DEFAULT]`, so initialising ours is idempotent and
 * cannot collide with anything else that ever calls `initializeApp()`.
 */
export const FIREBASE_APP_NAME = 'achichiz-admin';

/* ------------------------------------------------------- credential sources */

/** Only the fields this module reads. Taking them as an argument keeps the resolver pure. */
export type FirebaseCredentialEnv = {
  FIREBASE_SERVICE_ACCOUNT_JSON?: string | undefined;
  FIREBASE_SERVICE_ACCOUNT_PATH?: string | undefined;
};

export type CredentialSource =
  | { kind: 'inline'; origin: 'FIREBASE_SERVICE_ACCOUNT_JSON'; json: string }
  | { kind: 'file'; origin: 'FIREBASE_SERVICE_ACCOUNT_PATH' | 'cwd'; path: string }
  | { kind: 'none' };

/**
 * Where the credentials come from, in order of precedence. Pure — it takes the
 * environment and a "does the file exist" answer rather than looking either up,
 * so the ordering can be tested without a key on disk.
 *
 *   1. `FIREBASE_SERVICE_ACCOUNT_JSON` — the key JSON itself. Preferred for the
 *      Lightsail deploy: there is no file to ship, chmod or forget to rotate.
 *   2. `FIREBASE_SERVICE_ACCOUNT_PATH` — an explicit path, for a mounted secret.
 *   3. `serviceAccountKey.json` in the working directory — current dev behaviour.
 */
export function resolveCredentialSource(
  cfg: FirebaseCredentialEnv,
  cwdHasFile: boolean,
  cwd: string = process.cwd(),
): CredentialSource {
  const inline = cfg.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (inline) return { kind: 'inline', origin: 'FIREBASE_SERVICE_ACCOUNT_JSON', json: inline };

  const path = cfg.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  if (path) return { kind: 'file', origin: 'FIREBASE_SERVICE_ACCOUNT_PATH', path };

  if (cwdHasFile) return { kind: 'file', origin: 'cwd', path: join(cwd, SERVICE_ACCOUNT_FILENAME) };

  return { kind: 'none' };
}

/** Actionable, and it names all three options — this is what an operator sees at 2am. */
export function missingCredentialsMessage(cwd: string = process.cwd()): string {
  return (
    'Firebase Admin credentials are not configured, so no ID token can be verified. Provide ONE of, ' +
    'in order of precedence: (1) FIREBASE_SERVICE_ACCOUNT_JSON — the service-account key JSON itself, ' +
    'preferred for deploys because there is no file to ship; (2) FIREBASE_SERVICE_ACCOUNT_PATH — a path ' +
    `to the key file; (3) a ${SERVICE_ACCOUNT_FILENAME} file in the working directory (${cwd}). ` +
    'Download a key from the Firebase console under Project settings → Service accounts.'
  );
}

/* --------------------------------------------------------------- parsing */

/** Reads the property under either the snake_case (file) or camelCase spelling. */
function stringField(record: Record<string, unknown>, snake: string, camel: string): string | undefined {
  const value = record[snake] ?? record[camel];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * JSON text → the three fields `cert()` needs, or a readable failure.
 *
 * `origin` is a label like `FIREBASE_SERVICE_ACCOUNT_JSON` or a file path. The
 * key body is never included in any message thrown from here.
 */
export function parseServiceAccount(json: string, origin: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      `${origin} does not contain valid JSON. It must be the service-account key file verbatim, ` +
        'including its surrounding braces.',
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${origin} is not a JSON object, so it cannot be a Firebase service-account key.`);
  }

  const record: Record<string, unknown> = { ...parsed };
  const projectId = stringField(record, 'project_id', 'projectId');
  const clientEmail = stringField(record, 'client_email', 'clientEmail');
  const privateKey = stringField(record, 'private_key', 'privateKey');

  if (!projectId || !clientEmail || !privateKey) {
    const missing = [
      projectId ? null : 'project_id',
      clientEmail ? null : 'client_email',
      privateKey ? null : 'private_key',
    ].filter((f): f is string => f !== null);
    throw new Error(
      `${origin} is missing ${missing.join(', ')}. A Firebase service-account key contains all three.`,
    );
  }

  return {
    projectId,
    clientEmail,
    /*
     * A key passed through an environment variable usually arrives with literal
     * backslash-n instead of newlines — shells, systemd unit files and CI secret
     * stores all do this. `cert()` then fails deep inside the crypto layer with
     * an opaque PEM error. Undoing it here is a no-op for a key read from a file.
     */
    privateKey: privateKey.replace(/\\n/g, '\n'),
  };
}

/* ------------------------------------------------------------ the lazy app */

let app: App | null = null;

/**
 * Whether `initializeApp` has actually run in this process.
 *
 * Exported so a test can assert that importing the auth modules did NOT reach
 * Firebase — the regression this whole file exists to prevent.
 */
export function isFirebaseInitialised(): boolean {
  return app !== null;
}

/** Test seam: forget the memoised app so the next call re-resolves credentials. */
export function resetFirebaseAppForTests(): void {
  app = null;
}

/**
 * The app, built on FIRST USE. Throws — with the message above — if no credential
 * source is configured. Never called at import time by anything in this codebase.
 */
export function getFirebaseApp(): App {
  if (app) return app;

  const cwd = process.cwd();
  const source = resolveCredentialSource(env, existsSync(join(cwd, SERVICE_ACCOUNT_FILENAME)), cwd);

  if (source.kind === 'none') throw new Error(missingCredentialsMessage(cwd));

  let json: string;
  let origin: string;

  if (source.kind === 'inline') {
    json = source.json;
    origin = 'FIREBASE_SERVICE_ACCOUNT_JSON';
  } else {
    origin = source.origin === 'cwd' ? source.path : `FIREBASE_SERVICE_ACCOUNT_PATH (${source.path})`;
    try {
      json = readFileSync(source.path, 'utf8');
    } catch (err) {
      throw new Error(`The Firebase service-account key at ${origin} could not be read.`, { cause: err });
    }
  }

  const credential = cert(parseServiceAccount(json, origin));
  app = getApps().find((a) => a.name === FIREBASE_APP_NAME) ?? initializeApp({ credential }, FIREBASE_APP_NAME);
  return app;
}
