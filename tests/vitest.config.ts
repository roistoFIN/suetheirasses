import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['api/**/*.test.ts'],
    teardownTimeout: 10_000,
    testTimeout: 30_000,
    // test-setup.ts's setupTestDatabase() memoizes its Prisma client/test-db
    // creation at module scope, assuming one shared process — but each test
    // FILE gets its own worker (and thus its own module instance) unless
    // parallelism is disabled, so multiple files were independently racing
    // to create+migrate the same test_db_test database. A file that lost
    // that race ran its tests against a database with no tables yet.
    fileParallelism: false,
  },
});
