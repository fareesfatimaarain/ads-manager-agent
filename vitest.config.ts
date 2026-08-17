import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests need a live database and run under vitest.integration.config.ts.
    exclude: ['tests/integration/**', 'node_modules/**'],
    environment: 'node',
    // Money-path modules are held to a higher bar than the rest of the codebase.
    coverage: {
      provider: 'v8',
      include: ['src/stats/**', 'src/guardrails/**', 'src/decisions/**'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
