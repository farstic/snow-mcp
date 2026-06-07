import { defineConfig } from '@playwright/test';

// Electron E2E. Run locally with a real Electron binary:  npm run test:e2e
// (Live flow:  RUN_LIVE_E2E=1 SERVICENOW_INSTANCE_URL=... SERVICENOW_BASIC_USERNAME=... SERVICENOW_BASIC_PASSWORD=... npm run test:e2e)
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/electron.spec.ts',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false, // Electron launches are heavy — run serially
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
});
