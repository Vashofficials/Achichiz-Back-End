import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env, resolveDbSsl } from './env.js';
import { logger } from './logger.js';
import * as schema from '../db/schema/index.js';

const { Pool, types } = pg;

/**
 * node-postgres returns BIGINT (OID 20) as a string by default, to avoid silent
 * precision loss. Every BIGINT in this schema is either a paise amount or an
 * identity key — both comfortably inside Number.MAX_SAFE_INTEGER (₹90,071,992,547
 * in paise). Parsing to number here is what lets `mode: 'number'` in the Drizzle
 * bigint columns be honest.
 */
types.setTypeParser(types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`BIGINT ${value} exceeds Number.MAX_SAFE_INTEGER — refusing to lose precision`);
  }
  return n;
});

/** NUMERIC must never silently become a float. Nothing in this schema should use it for money. */
types.setTypeParser(types.builtins.NUMERIC, (value: string) => value);

/** Shared with the migration runner — see `resolveDbSsl` in config/env.ts. */
const resolveSsl = (): pg.PoolConfig['ssl'] =>
  resolveDbSsl(env.DATABASE_URL, env.DATABASE_CA_CERT, env.isProduction);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: resolveSsl(),
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  // Managed Postgres across the public internet is slower to hand out a
  // connection than a local socket; 5s times out on a cold pool.
  connectionTimeoutMillis: 15_000,
  application_name: 'achichiz-api',
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client error');
});

export const db: NodePgDatabase<typeof schema> = drizzle(pool, {
  schema,
  logger: env.LOG_LEVEL === 'trace',
});

/**
 * Read-only pool for the reports module. Connecting through a role that lacks
 * INSERT/UPDATE/DELETE is what makes "reports are read-only" a guarantee rather
 * than a convention.
 */
export const readonlyPool = env.DATABASE_READONLY_URL
  ? new Pool({
      connectionString: env.DATABASE_READONLY_URL,
      ssl: resolveSsl(),
      connectionTimeoutMillis: 15_000,
      max: Math.max(2, Math.floor(env.DATABASE_POOL_MAX / 2)),
      application_name: 'achichiz-api-reports',
    })
  : pool;

export const readonlyDb: NodePgDatabase<typeof schema> =
  readonlyPool === pool ? db : drizzle(readonlyPool, { schema });

export type Db = typeof db;
/** A transaction handle. Services that must run inside one accept this. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either a pooled connection or an open transaction. Repositories accept this. */
export type Executor = Db | Tx;

export async function closeDb(): Promise<void> {
  await pool.end();
  if (readonlyPool !== pool) await readonlyPool.end();
}
