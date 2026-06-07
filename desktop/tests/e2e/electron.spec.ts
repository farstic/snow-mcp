import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Playwright compiles specs to CommonJS, so use __dirname / global require (not import.meta).
const DESKTOP = resolve(__dirname, '..', '..');
const MAIN = join(DESKTOP, 'dist', 'main', 'index.js');
const RUN_LIVE = !!process.env.RUN_LIVE_E2E;

// electron binary path is resolved lazily (so `playwright test --list` works without it installed)
async function launchApp(userData: string, env: Record<string, string> = {}): Promise<ElectronApplication> {
  const electronPath = require('electron') as unknown as string;
  return electron.launch({
    executablePath: electronPath,
    args: [MAIN, `--user-data-dir=${userData}`],
    env: { ...process.env, ...env },
  });
}

const tempDir = () => mkdtempSync(join(tmpdir(), 'snmcp-e2e-'));
function seedConfig(dir: string, instance: Record<string, unknown>) {
  // config-store leaves non-`enc:` values as-is on load, so a plaintext seed makes the app non-first-run.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    instances: [instance], activeInstance: instance.name, theme: 'dark', telemetry: false, autoUpdate: true,
  }));
}

test.describe('Electron app E2E', () => {
  let app: ElectronApplication | undefined;
  let dir: string | undefined;

  test.afterEach(async () => {
    if (app) { await app.close().catch(() => {}); app = undefined; }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
  });

  test('launches and renders the first-run setup with no uncaught errors', async () => {
    dir = tempDir();
    app = await launchApp(dir);
    const win = await app.firstWindow();
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(String(e)));
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('body')).toContainText(/welcome|servicenow|setup|get started|dashboard/i);
    expect(errors, errors.join('\n')).toEqual([]); // no uncaught renderer exceptions
  });

  test('with a seeded instance, the main UI renders and the sidebar navigates', async () => {
    dir = tempDir();
    seedConfig(dir, { name: 'dev', instanceUrl: 'https://dev.service-now.com', authMethod: 'basic', username: 'u', password: 'p', toolPackage: 'full', writeEnabled: false });
    app = await launchApp(dir);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('body')).toContainText(/dashboard|instances|tools|settings/i);
    for (const label of ['Tools', 'Logs', 'Settings']) {
      await win.getByText(label, { exact: false }).first().click().catch(() => {});
    }
    await expect(win.locator('body')).toContainText(/settings|providers|appearance/i);
  });

  test('DEV variant: renames the app yet --user-data-dir still wins (isolation precedence)', async () => {
    dir = tempDir();
    // SNMCP_VARIANT=dev triggers app.setName('servicenow-mcp-dev'). The --user-data-dir switch
    // must STILL win (we never call setPath), so the test keeps its temp-dir isolation and a real
    // ~/Library/Application Support/servicenow-mcp-dev is never touched.
    app = await launchApp(dir, { SNMCP_VARIANT: 'dev' });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    expect(realpathSync(userData)).toBe(realpathSync(dir));
    const name = await app.evaluate(({ app: a }) => a.getName());
    expect(name).toBe('servicenow-mcp-dev');
  });

  test('LIVE: start the server from the dashboard and load tools', async () => {
    test.skip(!RUN_LIVE, 'set RUN_LIVE_E2E=1 (+ SERVICENOW_* creds) to run the live flow');
    dir = tempDir();
    seedConfig(dir, {
      name: 'pdi',
      instanceUrl: process.env.SERVICENOW_INSTANCE_URL,
      authMethod: 'basic',
      username: process.env.SERVICENOW_BASIC_USERNAME,
      password: process.env.SERVICENOW_BASIC_PASSWORD,
      toolPackage: 'full',
      writeEnabled: false,
    });
    app = await launchApp(dir);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.getByRole('button', { name: /start/i }).first().click();
    await expect(win.locator('body')).toContainText(/running|online|connected/i, { timeout: 30_000 });
    await win.getByText('Tools', { exact: false }).first().click();
    await expect(win.locator('body')).toContainText(/snow_/i, { timeout: 30_000 });
  });
});
