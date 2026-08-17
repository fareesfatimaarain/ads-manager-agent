import { defineConfig } from 'vitest/config';

/**
 * Integration suite. Requires a live Postgres — run `npm run db:up` first.
 *
 * Kept separate from the unit suite on purpose: `npm test` must stay fast and runnable with no
 * infrastructure, while these tests exercise the things that can only be verified against a
 * real database — CHECK constraints actually rejecting bad rows, transactions actually rolling
 * back, advisory locks actually serialising.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // Shared database: files must not race each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
