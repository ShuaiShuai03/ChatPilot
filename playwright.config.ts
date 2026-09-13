import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 1_500 },
  reporter: 'list',
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
});
