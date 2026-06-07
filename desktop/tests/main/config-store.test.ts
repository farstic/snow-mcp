import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigStore } from '../../main/config-store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snmcp-cfg-'));
  process.env.DESKTOP_TEST_USERDATA = dir;
  delete process.env.DESKTOP_TEST_NO_SAFESTORAGE;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const inst = (over: Record<string, unknown> = {}): any => ({
  name: 'dev', instanceUrl: 'https://dev.service-now.com', authMethod: 'basic',
  username: 'u', password: 'secret', ...over,
});

describe('ConfigStore — encryption + instance CRUD', () => {
  it('encrypts sensitive fields on disk but round-trips them in memory', () => {
    const s = new ConfigStore();
    s.addInstance(inst());
    const stored = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).instances[0];
    expect(stored.password.startsWith('enc:')).toBe(true); // encrypted at rest
    expect(stored.username).toBe('u');                      // non-sensitive stays plaintext
    expect(s.getInstances()[0].password).toBe('secret');    // decrypted in memory
  });

  it('persists encrypted credentials across a reload', () => {
    new ConfigStore().addInstance(inst());
    const reloaded = new ConfigStore();
    expect(reloaded.getInstances()[0].password).toBe('secret');
  });

  it('addInstance / removeInstance / getInstances', () => {
    const s = new ConfigStore();
    s.addInstance(inst());
    s.addInstance(inst({ name: 'prod' }));
    expect(s.getInstances().map((i) => i.name).sort()).toEqual(['dev', 'prod']);
    s.removeInstance('dev');
    expect(s.getInstances().map((i) => i.name)).toEqual(['prod']);
  });

  it('get/set round-trips simple config values', () => {
    const s = new ConfigStore();
    s.set('theme', 'dark');
    expect(s.get('theme')).toBe('dark');
  });

  it('falls back to an ephemeral key when safeStorage is unavailable (still round-trips in-process)', () => {
    process.env.DESKTOP_TEST_NO_SAFESTORAGE = '1';
    const s = new ConfigStore();
    s.addInstance(inst());
    expect(s.getInstances()[0].password).toBe('secret');
  });
});
