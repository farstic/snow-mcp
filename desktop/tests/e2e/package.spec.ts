import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { existsSync, readdirSync, statSync, mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// L6 packaging smoke. Requires a real build first (run locally — Electron can't install in CI sandbox):
//   npm run package:mac   &&   npm run test:e2e
// Self-skips until electron-builder has produced a .app under release/.
const DESKTOP = resolve(__dirname, '..', '..');
const RELEASE = join(DESKTOP, 'release');

function findApp(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name.endsWith('.app')) return p;
    try { if (statSync(p).isDirectory()) { const found = findApp(p); if (found) return found; } } catch { /* skip */ }
  }
  return null;
}

function macExecutable(appPath: string): string | null {
  const macos = join(appPath, 'Contents', 'MacOS');
  if (!existsSync(macos)) return null;
  const bins = readdirSync(macos);
  return bins.length ? join(macos, bins[0]) : null;
}

test.describe('packaged app smoke', () => {
  let app: ElectronApplication | undefined;
  let dir: string | undefined;

  test.afterEach(async () => {
    if (app) { await app.close().catch(() => {}); app = undefined; }
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
  });

  test('the electron-builder package launches and bundles the MCP server', async () => {
    const appPath = findApp(RELEASE);
    test.skip(!appPath, 'No packaged app under release/ — run `npm run package:mac` first.');
    const exe = macExecutable(appPath!);
    test.skip(!exe, 'Could not locate the executable inside the .app bundle.');

    dir = mkdtempSync(join(tmpdir(), 'snmcp-pkg-'));
    app = await electron.launch({ executablePath: exe!, args: [`--user-data-dir=${dir}`] });

    const win = await app.firstWindow();
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(String(e)));
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('body')).toContainText(/welcome|servicenow|setup|dashboard/i);
    expect(errors, errors.join('\n')).toEqual([]);

    // electron-builder.yml bundles ../dist -> resources/server, so the packaged app can spawn the server.
    const bundled = await app.evaluate(async () => {
      const path = require('path');
      const fs = require('fs');
      const p = path.join(process.resourcesPath || '', 'server', 'server.js');
      return { p, exists: fs.existsSync(p) };
    });
    expect(bundled.exists, `expected bundled server at ${bundled.p}`).toBe(true);
  });
});
