import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { instanceManager } from '../../src/servicenow/instances.js';

// The wizard config (~/.config/servicenow-mcp/instances.json) takes precedence over env-only
// loading (steps 3/4). Skip those env-only cases if it happens to exist on this machine.
const wizardExists = existsSync(join(homedir(), '.config', 'servicenow-mcp', 'instances.json'));
const tmp = mkdtempSync(join(tmpdir(), 'snmcp-inst-'));
let n = 0;
function writeConfig(obj: unknown): string {
  const p = join(tmp, `instances-${n++}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function clearEnv() {
  for (const k of Object.keys(process.env)) if (/^SN_INSTANCE_[A-Z0-9_]+_/.test(k)) delete process.env[k];
  delete process.env.SN_INSTANCES_CONFIG;
  delete process.env.SN_DEFAULT_INSTANCE;
  delete process.env.SERVICENOW_INSTANCE_URL;
  process.env.LOG_LEVEL = 'error';
}

beforeEach(() => clearEnv());
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('multi-instance loading + switch precedence', () => {
  it('loads instances.json (SN_INSTANCES_CONFIG) and honors default_instance', () => {
    process.env.SN_INSTANCES_CONFIG = writeConfig({
      default_instance: 'prod',
      instances: {
        dev: { instance_url: 'https://dev.service-now.com', auth_method: 'basic', username: 'u', password: 'p' },
        prod: { instance_url: 'https://prod.service-now.com', auth_method: 'basic', group: 'Prod', environment: 'production' },
      },
    });
    instanceManager.reload();
    expect(instanceManager.listNames().sort()).toEqual(['dev', 'prod']);
    expect(instanceManager.getCurrentName()).toBe('prod');
    expect(instanceManager.listAll().find(i => i.name === 'prod')?.environment).toBe('production');
  });

  it('SN_INSTANCES_CONFIG takes precedence over legacy single-instance env', () => {
    process.env.SN_INSTANCES_CONFIG = writeConfig({ instances: { dev: { instance_url: 'https://dev.service-now.com', auth_method: 'basic' } } });
    process.env.SERVICENOW_INSTANCE_URL = 'https://legacy.service-now.com'; // must be ignored
    instanceManager.reload();
    expect(instanceManager.listNames()).toEqual(['dev']);
    expect(instanceManager.listNames()).not.toContain('default');
  });

  it('switch() changes the active instance; unknown name throws', () => {
    process.env.SN_INSTANCES_CONFIG = writeConfig({ default_instance: 'dev', instances: { dev: { instance_url: 'https://dev.service-now.com' }, prod: { instance_url: 'https://prod.service-now.com' } } });
    instanceManager.reload();
    expect(instanceManager.getCurrentName()).toBe('dev');
    instanceManager.switch('PROD'); // case-insensitive
    expect(instanceManager.getCurrentName()).toBe('prod');
    expect(instanceManager.listAll().find(i => i.name === 'prod')?.active).toBe(true);
    expect(() => instanceManager.switch('ghost')).toThrow(/Unknown instance/);
  });

  it('getClient() resolves by name (case-insensitive); unknown throws', () => {
    process.env.SN_INSTANCES_CONFIG = writeConfig({ default_instance: 'dev', instances: { dev: { instance_url: 'https://dev.service-now.com' }, prod: { instance_url: 'https://prod.service-now.com' } } });
    instanceManager.reload();
    expect(instanceManager.getClient()).toBeTruthy();        // current (dev)
    expect(instanceManager.getClient('PROD')).toBeTruthy();   // case-insensitive lookup
    expect(() => instanceManager.getClient('nope')).toThrow(/Unknown instance/);
  });

  it.skipIf(wizardExists)('falls back to legacy SERVICENOW_INSTANCE_URL registered as "default"', () => {
    process.env.SERVICENOW_INSTANCE_URL = 'https://legacy.service-now.com';
    instanceManager.reload();
    expect(instanceManager.listNames()).toContain('default');
    expect(instanceManager.getCurrentName()).toBe('default');
  });

  it.skipIf(wizardExists)('loads SN_INSTANCE_<NAME>_URL groups and honors SN_DEFAULT_INSTANCE', () => {
    process.env.SN_INSTANCE_DEV_URL = 'https://dev.service-now.com';
    process.env.SN_INSTANCE_PROD_URL = 'https://prod.service-now.com';
    process.env.SN_DEFAULT_INSTANCE = 'prod';
    instanceManager.reload();
    expect(instanceManager.listNames().sort()).toEqual(['dev', 'prod']);
    expect(instanceManager.getCurrentName()).toBe('prod');
  });
});
