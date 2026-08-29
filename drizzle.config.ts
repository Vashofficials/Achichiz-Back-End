import { defineConfig } from 'drizzle-kit';

/**
 * `generate` only — never `push` outside a local machine.
 *
 * `push` diffs and applies straight to the database with no reviewable artifact,
 * which is fine for a scratch DB and a disaster on anything with data in it.
 * Migrations here are generated SQL, committed, reviewed in the PR, and applied
 * by an explicit pre-deploy job (never at app boot — N instances would race).
 */
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set before running drizzle-kit. No database fallback is configured.');
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
});
