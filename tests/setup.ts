import { beforeAll } from 'vitest';

/**
 * Test environment defaults.
 *
 * Set BEFORE any src module is imported — `config/env.ts` parses and freezes
 * process.env at import time, so anything assigned later is ignored.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.JWT_CUSTOMER_SECRET ??= 'test-customer-secret-at-least-32-characters-long';
process.env.JWT_STAFF_SECRET ??= 'test-staff-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL ??= 'postgres://achichiz:achichiz@localhost:5432/achichiz_test';
process.env.REDIS_URL ??= 'redis://localhost:6379/1';
process.env.CORS_ORIGINS ??= 'http://localhost:3000';

beforeAll(() => {
  if (!process.env.DATABASE_URL?.includes('test')) {
    throw new Error(
      `Refusing to run tests against ${process.env.DATABASE_URL} — the database name must contain "test". ` +
        `The suite truncates tables.`,
    );
  }
});
