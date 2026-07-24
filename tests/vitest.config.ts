import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['api/**/*.test.ts'],
    teardownTimeout: 10_000,
    testTimeout: 30_000,
    // See global-setup.ts: it creates/migrates the shared test_db_test
    // database exactly once before any test file's own worker starts,
    // which is what actually eliminates the race (see its doc comment).
    // fileParallelism: false is kept as a cheap second guard — it makes
    // any accidental future duplicate-setup-style race far less likely to
    // manifest, at a small cost in wall-clock time for this small suite.
    globalSetup: './global-setup.ts',
    fileParallelism: false,
  },
});
