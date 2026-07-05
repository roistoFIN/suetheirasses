import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['api/**/*.test.ts'],
    teardownTimeout: 10_000,
    testTimeout: 30_000,
  },
});
