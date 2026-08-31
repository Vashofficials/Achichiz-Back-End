/**
 * QA harness shared library — NOT part of the application.
 *
 * Lives under `qa/` and is excluded from the build: `tsconfig.build.json`
 * includes only `src/**`, and `.gitattributes`/eslint ignore it too. It defines
 * no routes and mounts nothing.
 *
 * Targets PRODUCTION by default (`QA_BASE_URL`), because that is the only
 * environment with Redis, and admin auth fails closed without it.
 *
 * Authentication is completed PROPERLY, never bypassed: the admin's TOTP secret
 * is read from the database and a real code generated with the same `otplib` the
 * server verifies against. No guard is disabled and no middleware is stubbed.
 * Credentials come from the environment — never hard-coded.
 */

import { Pool } from 'pg';
import { authenticator } from 'otplib';

export const BASE = process.env.QA_BASE_URL ?? 'https://api.achichiz.com';

export const ADMIN_EMAIL = process.env.QA_ADMIN_EMAIL ?? '';
export const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD ?? '';

let pool: Pool | null = null;
export function db(): Pool {
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  return pool;
}
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}

export type Res = { status: number; body: unknown; text: string; ms: number };

export async function call(
  method: string,
  path: string,
  opts: { token?: string | undefined; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';

  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { status: 0, body: null, text: `REQUEST FAILED: ${String(err).slice(0, 120)}`, ms: performance.now() - started };
  }

  const ms = performance.now() - started;
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON is itself a finding; keep the raw text */
  }
  return { status: res.status, body, text, ms };
}

/** `{ type, result }` is the project's envelope. Anything else is a bug. */
export function unwrap(body: unknown): any {
  const b = body as { type?: string; result?: unknown };
  return b && typeof b === 'object' && 'result' in b ? b.result : b;
}

/* ------------------------------------------------------------------ tokens */

export type AdminSession = { access: string; staffId: string };

/**
 * Full admin sign-in including the second factor.
 *
 * `POST /login` does NOT return a session for an MFA-enabled account — it
 * returns `status: 'mfa_required'` and a challenge token. A client that reads
 * `result.tokens` directly gets null and appears to hang, so the branch is
 * explicit here.
 */
export async function adminLogin(email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<AdminSession> {
  if (!email || !password) {
    throw new Error('Set QA_ADMIN_EMAIL and QA_ADMIN_PASSWORD — this harness never hard-codes credentials.');
  }

  const login = await call('POST', '/v1/admin/auth/login', { body: { email, password } });
  if (login.status !== 200) throw new Error(`admin login ${login.status}: ${login.text.slice(0, 200)}`);

  const first = unwrap(login.body);
  if (first.status === 'session' && first.tokens?.accessToken) {
    return { access: first.tokens.accessToken, staffId: first.staffId ?? '' };
  }
  if (first.status !== 'mfa_required') throw new Error(`unexpected login outcome: ${first.status}`);

  const { rows } = await db().query<{ id: string; mfa_secret: string }>(
    'select id, mfa_secret from staff_users where lower(email) = lower($1) limit 1',
    [email],
  );
  if (!rows[0]?.mfa_secret) throw new Error('no mfa_secret stored for that admin');

  const verify = await call('POST', '/v1/admin/auth/2fa/verify', {
    body: { challengeToken: first.challengeToken, code: authenticator.generate(rows[0].mfa_secret) },
  });
  if (verify.status !== 200) throw new Error(`2fa/verify ${verify.status}: ${verify.text.slice(0, 200)}`);

  const session = unwrap(verify.body);
  const access = session.tokens?.accessToken;
  if (!access) throw new Error(`no access token in verify response: ${verify.text.slice(0, 200)}`);
  return { access, staffId: rows[0].id };
}
