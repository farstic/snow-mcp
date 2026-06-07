import { defineConfig } from '@playwright/test';

// Web-mode E2E: serve.cjs serves the built renderer; chromium loads it in browser mode
// (no Electron preload -> window.api undefined -> the api.ts web fallback). Run: npm run test:e2e:web
const PORT = 4178;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/web.spec.ts',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: 'web', use: { browserName: 'chromium' } }],
  webServer: {
    command: `PORT=${PORT} node serve.cjs`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
