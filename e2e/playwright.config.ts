import { defineConfig } from '@playwright/test';

/**
 * E2E — module1.md §11 (blocking): sign in, invite, workspace, agent.
 *
 * Runs against a live local stack (pnpm stack:up + pnpm dev), through the REAL identity
 * provider's login UI. Nothing is mocked: this is the check that the pieces the unit and
 * integration suites test separately actually fit together.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env['WEB_PUBLIC_URL'] ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env['PLAYWRIGHT_CHROMIUM_PATH']
      ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] }
      : {},
  },
});
