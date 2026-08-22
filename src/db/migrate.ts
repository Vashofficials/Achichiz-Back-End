import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { env, resolveDbSsl } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Applies pending migrations, in filename order, each in its own transaction.
 *
 * Run as an explicit pre-deploy job — NEVER at app boot. Boot-time migration on
 * a horizontally scaled service means N instances racing to alter the same table.
 *
 * The advisory lock is what makes a concurrent second runner wait rather than
 * duplicate work. It is released automatically when the session ends, including
 * if the process is killed mid-run.
 */
const LOCK_ID = 4_120_250_806; // arbitrary, stable
const DIR = resolve(import.meta.dirname, 'migrations');

async function main(): Promise<void> {
  // Same TLS resolution as the pool — a managed instance refuses an unencrypted
  // connection outright (`no pg_hba.conf entry ... no encryption`).
  const client = new pg.Client({
    connectionString: env.DATABASE_URL,
    ssl: resolveDbSsl(env.DATABASE_URL, env.DATABASE_CA_CERT, env.isProduction),
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum    TEXT NOT NULL
      )
    `);

    logger.info('acquiring migration advisory lock');
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

    const applied = new Map<string, string>(
      (await client.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM schema_migrations'))
        .rows.map((r) => [r.filename, r.checksum]),
    );

    const files = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const filename of files) {
      const sql = readFileSync(resolve(DIR, filename), 'utf8');
      const checksum = await sha256(sql);
      const previous = applied.get(filename);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${filename} has changed since it was applied. Migrations are forward-only — ` +
              `add a new one instead of editing a merged file.`,
          );
        }
        continue;
      }

      logger.info({ filename }, 'applying migration');
      await client.query('BEGIN');
      try {
        await client.query(stripOuterTransaction(sql));
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          checksum,
        ]);
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${filename} failed and was rolled back: ${String(err)}`, { cause: err });
      }
    }

    logger.info({ applied: count, total: files.length }, count ? 'migrations applied' : 'database up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

/**
 * Remove a file-level `BEGIN;` / `COMMIT;` pair so the RUNNER's transaction is the
 * only one.
 *
 * PostgreSQL does not nest transactions. A `BEGIN` inside an open transaction is
 * merely a warning, but the file's `COMMIT` closes the runner's transaction early
 * — so the `INSERT INTO schema_migrations` that follows lands in autocommit,
 * outside any transaction. It looks fine until that INSERT fails: the migration is
 * then applied but unrecorded, and re-runs on the next deploy against a schema it
 * has already changed.
 *
 * The checksum is computed over the ORIGINAL file text, so stripping here never
 * invalidates a migration already recorded.
 */
function stripOuterTransaction(sql: string): string {
  return sql.replace(/^\s*BEGIN\s*;/i, '').replace(/COMMIT\s*;\s*$/i, '');
}

async function sha256(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'migration failed');
  process.exit(1);
});
