import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Parsed at import time. If a key is missing or malformed the process dies here,
 * before the port binds, with a readable list of everything wrong — not on the
 * first request that happens to touch it.
 */
const csv = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  // 'silent' is a real pino level (log nothing) — the test suite relies on it.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_READONLY_URL: z.string().optional(),
  /**
   * Path to the CA bundle for a managed Postgres (AWS RDS / Lightsail).
   *
   * Set this and the connection verifies the server certificate properly. Leave
   * it unset and TLS still happens, but the certificate is not verified — which
   * is acceptable locally and is a man-in-the-middle risk in production, so the
   * pool logs loudly about it there.
   */
  DATABASE_CA_CERT: z.string().optional(),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  CORS_ORIGINS: z.string().default(''),

  JWT_CUSTOMER_SECRET: z.string().min(32, 'JWT_CUSTOMER_SECRET must be at least 32 characters'),
  JWT_STAFF_SECRET: z.string().min(32, 'JWT_STAFF_SECRET must be at least 32 characters'),
  JWT_CUSTOMER_TTL: z.string().default('15m'),
  JWT_STAFF_TTL: z.string().default('10m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  JWT_ISSUER: z.string().default('achichiz-api'),

  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),



  /**
   * Firebase Admin credentials. BOTH OPTIONAL, deliberately.
   *
   * Token verification resolves them lazily (`config/firebase.ts`) in the order
   * JSON → path → `serviceAccountKey.json` in the working directory, and fails
   * only when a token is actually presented. Requiring either here would stop
   * `openapi:generate`, CI and the test suite — none of which verify a token —
   * from booting at all.
   *
   * `FIREBASE_SERVICE_ACCOUNT_JSON` holds the key file's contents verbatim and is
   * preferred for the Lightsail deploy: nothing to ship to the box.
   */
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_API_KEY: z.string().optional(),

  AWS_REGION: z.string().default('ap-south-1'),
  AWS_ACCESS_KEY_ID: z.string().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('Achichiz <connect@achiachi.in>'),

  S3_ENDPOINT: z.string().default(''),
  S3_BUCKET: z.string().default('achichiz-media'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_PUBLIC_BASE_URL: z.string().default(''),

  DOCS_ADMIN_REQUIRE_AUTH: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  DOCS_ADMIN_IP_ALLOWLIST: z.string().default(''),

  /**
   * Gmail / Google Workspace SMTP. Setting USER and PASSWORD is what ENABLES
   * real email delivery — see `createEmailSender`.
   *
   * SMTP_PASSWORD must be a Google APP PASSWORD (myaccount.google.com →
   * Security → 2-Step Verification → App passwords), not the account password;
   * Google rejects the latter for SMTP. It is a credential: keep it out of the
   * repo and out of logs.
   *
   * EMAIL_FROM has to be SMTP_USER or an alias that mailbox owns — Gmail
   * silently rewrites a From it does not recognise, so mail appears to send and
   * arrives from the wrong address.
   */
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),

  /**
   * Where the admin panel is served, used to build password-reset and invite
   * links. No trailing slash.
   *
   * Without it the reset emails carried a bare token and nothing to click,
   * while the panel's /reset-password page reads `?token=&email=` and shows
   * "This reset link is missing its token" — so neither flow could be completed
   * by the person receiving the mail.
   */
  ADMIN_PANEL_URL: z
    .string()
    .default('https://admin.achichiz.com')
    .transform((v) => v.replace(/\/+$/, '')),

  /**
   * IPs exempt from the ABUSE limiters, so testing from a known network is not
   * throttled. Comma-separated exact addresses; empty disables the exemption.
   *
   * It deliberately does NOT cover the COST limiters (`otp`, `payment`,
   * `webhook`) — those exist because each request spends real money on SMS or
   * touches live Razorpay, and that is true no matter who is calling. A test
   * loop is precisely how an SMS bill runs away.
   */
  RATE_LIMIT_SKIP_IPS: z.string().default(''),

  FREE_SHIPPING_THRESHOLD_PAISE: z.coerce.number().int().nonnegative().default(99900),
  SHIPPING_FEE_PAISE: z.coerce.number().int().nonnegative().default(14900),
});

/* ------------------------------------------------------------- database TLS */

/**
 * TLS settings for a managed Postgres (AWS RDS / Lightsail).
 *
 * Lives here rather than in `config/db.ts` because BOTH the connection pool and
 * the standalone migration client need it. When it lived only in db.ts, the
 * migration runner connected unencrypted and RDS refused it with
 * `no pg_hba.conf entry ... no encryption` — a bug that only appears against a
 * real managed instance, never against local docker-compose.
 *
 * Three cases, in order:
 *   1. `DATABASE_CA_CERT` set   → verify the server certificate. Production.
 *   2. remote host, no bundle   → encrypt, skip verification, warn in production.
 *   3. localhost                → no TLS; local Postgres has no certificate.
 *
 * An explicit `sslmode=` in the URL still wins — node-postgres applies it first.
 */
export type DbSslConfig = { ca: string; rejectUnauthorized: true } | { rejectUnauthorized: false } | false | undefined;

export function resolveDbSsl(url: string, caCertPath: string | undefined, isProduction: boolean): DbSslConfig {
  if (url.includes('sslmode=disable')) return false;

  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

  if (caCertPath) {
    // Throws here, naming the path, rather than failing later as a TLS error.
    return { ca: readFileSync(caCertPath, 'utf8'), rejectUnauthorized: true };
  }
  if (isLocal) return undefined;

  if (isProduction) {
    console.error(
      '\n!!! DATABASE_CA_CERT is not set: the database connection is encrypted but the server ' +
        'certificate is NOT verified. Download the RDS CA bundle for your region and set DATABASE_CA_CERT.\n',
    );
  }
  return { rejectUnauthorized: false };
}

/* ---------------------------------------------------------- Razorpay guards */

/**
 * Razorpay key ids carry their own mode. `rzp_live_…` moves real money on a real
 * bank account; `rzp_test_…` moves nothing. Confusing the two is the single most
 * expensive configuration mistake this system can make, so the mode is derived
 * from the key itself rather than from a separate flag someone can forget to set.
 *
 * Every function below is PURE — it takes the values rather than reading `env` —
 * so the guards can be unit-tested without a process that has keys.
 */
export type RazorpayKeyMode = 'test' | 'live' | 'unknown';

export function razorpayKeyMode(keyId: string): RazorpayKeyMode {
  if (keyId.startsWith('rzp_live_')) return 'live';
  if (keyId.startsWith('rzp_test_')) return 'test';
  return 'unknown';
}

/** `rzp_live_ABC123…` → `rzp_live_…`. The only form of a key id that may be printed or logged. */
export function razorpayKeyLabel(keyId: string): string {
  if (!keyId) return '(unset)';
  const mode = razorpayKeyMode(keyId);
  return mode === 'unknown' ? `${keyId.slice(0, 4)}…` : `${mode === 'live' ? 'rzp_live_' : 'rzp_test_'}…`;
}

/**
 * All three Razorpay variables, or none.
 *
 * A half-configured gateway is the worst of both worlds: checkout succeeds, the
 * customer is charged, and every webhook is then rejected as unsigned — so the
 * order never becomes paid and nobody finds out until a customer complains. It
 * has to fail at boot, not at the first checkout.
 */
export function razorpayConfigIssues(cfg: {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}): string[] {
  const vars = [
    ['RAZORPAY_KEY_ID', cfg.keyId],
    ['RAZORPAY_KEY_SECRET', cfg.keySecret],
    ['RAZORPAY_WEBHOOK_SECRET', cfg.webhookSecret],
  ] as const;

  const set = vars.filter(([, value]) => value.length > 0);
  // Nothing configured at all is legitimate: `openapi:generate`, CI and the test
  // suite all run without a gateway.
  if (set.length === 0) return [];

  return vars
    .filter(([, value]) => value.length === 0)
    .map(
      ([name]) =>
        `${name} is empty while ${set.map(([n]) => n).join(', ')} ${set.length === 1 ? 'is' : 'are'} set — ` +
        'configure all three Razorpay variables or none of them.',
    );
}

/**
 * The live-key guard: a `rzp_live_` key outside production is refused.
 *
 * A dev server, a CI run or a staging box pointed at live keys does not fail
 * safely — it takes real money from real cards, and the first symptom is a
 * settlement report nobody can explain.
 */
export function razorpayLiveKeyError(keyId: string, nodeEnv: string): string | null {
  if (razorpayKeyMode(keyId) !== 'live' || nodeEnv === 'production') return null;
  return (
    `REFUSING TO USE LIVE RAZORPAY KEYS: RAZORPAY_KEY_ID is a live key (rzp_live_…) but NODE_ENV is ` +
    `"${nodeEnv}", not "production". A non-production process using live keys charges real cards and ` +
    `moves real money. Use a rzp_test_… key here, or set NODE_ENV=production if this really is production.`
  );
}

/** The mirror: test keys in production means no order can ever actually be paid for. */
export function razorpayTestKeyInProductionError(keyId: string, nodeEnv: string): string | null {
  if (razorpayKeyMode(keyId) !== 'test' || nodeEnv !== 'production') return null;
  return (
    'RAZORPAY_KEY_ID is a TEST key (rzp_test_…) but NODE_ENV is "production". No real payment can ' +
    'succeed against test keys — every customer checkout on this deployment will take no money.'
  );
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // Deliberately console, not the logger — the logger depends on this module.
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const raw = parsed.data;

const razorpayIssues = razorpayConfigIssues({
  keyId: raw.RAZORPAY_KEY_ID,
  keySecret: raw.RAZORPAY_KEY_SECRET,
  webhookSecret: raw.RAZORPAY_WEBHOOK_SECRET,
});
if (razorpayIssues.length > 0) {
  console.error(`\nIncomplete Razorpay configuration:\n${razorpayIssues.map((i) => `  - ${i}`).join('\n')}\n`);
  process.exit(1);
}

/*
 * Loud at boot, and refused again at client construction (`payments.razorpay.ts`).
 * Not `process.exit` here: `openapi:generate` and the preflight script must still
 * be able to load a live-keyed .env and tell the operator what is wrong.
 */
const liveKeyError = razorpayLiveKeyError(raw.RAZORPAY_KEY_ID, raw.NODE_ENV);
if (liveKeyError) console.error(`\n!!! ${liveKeyError}\n`);

const testKeyError = razorpayTestKeyInProductionError(raw.RAZORPAY_KEY_ID, raw.NODE_ENV);
if (testKeyError) console.error(`\n!!! ${testKeyError}\n`);

export const env = Object.freeze({
  ...raw,
  corsOrigins: csv(raw.CORS_ORIGINS),
  docsAdminIpAllowlist: csv(raw.DOCS_ADMIN_IP_ALLOWLIST),
  rateLimitSkipIps: csv(raw.RATE_LIMIT_SKIP_IPS),
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
});

export type Env = typeof env;
