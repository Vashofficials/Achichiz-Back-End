import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests hit a real Postgres. Mocking a query builder tests the
    // mock, not the six-join admin filter that actually breaks.
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Each file gets its own DB from a template; running them in one process
    // keeps the pool count sane.
    pool: 'threads',
    poolOptions: { threads: { singleThread: false, maxThreads: 4 } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/db/migrations/**', 'src/**/*.test.ts', 'src/types/**'],
    },
  },
});
