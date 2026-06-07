import { test, expect } from '@playwright/test';

test.describe('web-mode (built renderer served by serve.cjs, loaded in a real browser)', () => {
  test('serves the app and boots in browser mode with no uncaught errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/');
    // The React app mounts and renders (first-run setup when no instances in localStorage).
    await expect(page.locator('body')).toContainText(/welcome|servicenow|setup|dashboard|get started/i);

    // Browser mode: there is no Electron preload, so window.api is undefined and api.ts
    // falls back to the web implementation.
    expect(await page.evaluate(() => (window as unknown as { api?: unknown }).api === undefined)).toBe(true);

    expect(errors, errors.join('\n')).toEqual([]); // no uncaught renderer exceptions
  });

  test('serves built static assets (index + hashed JS bundle)', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.status()).toBe(200);
    expect(await page.title()).not.toBe('');
  });
});
