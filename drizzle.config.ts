import { defineConfig } from 'drizzle-kit';

/**
 * `generate` only — never `push` outside a local machine.
 *
 * `push` diffs and applies straight to the database with no reviewable artifact,
 * which is fine for a scratch DB and a disaster on anything with data in it.
 * Migrations here are generated SQL, committed, reviewed in the PR, and applied
 * by an explicit pre-deploy job (never at app boot — N instances would race).
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://dbmasteruser:Bhupendra2003@ls-d586012c863d30504758724618319c1f2189b683.chu4osuyqe3m.ap-south-1.rds.amazonaws.com:5432/postgres',
  },
  verbose: true,
  strict: true,
});
