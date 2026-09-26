import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/connectors/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
    ],
    environment: 'node',
    passWithNoTests: true,
  },
});
