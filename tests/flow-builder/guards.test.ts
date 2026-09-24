import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  resolveInstanceOrThrow, evaluateInstancePolicy, denyPatterns, allowedInstanceNames, hostOf, resolveExportPath,
  ENV_ALLOWED_INSTANCES, ENV_DENY_PATTERN, ENV_EXPORT_ROOT,
} from '../../src/flow-builder/guards.js';
import type { GuardDeps, InstanceEntryView } from '../../src/flow-builder/guards.js';
import type { ServiceNowClient } from '../../src/servicenow/client.js';

const clientFor = (name: string) => ({ __name: name } as unknown as ServiceNowClient);

const ENTRIES: InstanceEntryView[] = [
  { name: 'product', url: 'https://pdidemo01.service-now.com', group: 'PDI', environment: 'dev', active: false },
  { name: 'blockeddev', url: 'https://blockeddev.service-now.com', group: 'Blocked', environment: 'dev', active: true },
  { name: 'hostdev', url: 'https://blocked-host.service-now.com', group: 'Other', environment: 'dev', active: false },    // host matches
  { name: 'corp', url: 'https://corp.service-now.com', group: 'Blocked Group', environment: 'dev', active: false },       // group matches
  { name: 'otherdev', url: 'https://otherdev.service-now.com', group: 'Other', environment: 'blocked-like', active: false }, // environment matches
  { name: 'OtherTest', url: 'https://othertest.service-now.com', group: 'Other', environment: 'test', active: false },
];

/** The locally configured deny list used by these tests — there is no built-in default in code. */
const DENY = { [ENV_DENY_PATTERN]: 'blocked' };

const clients = new Map(ENTRIES.map(e => [e.name, clientFor(e.name)]));

function deps(env: Record<string, string | undefined>): GuardDeps {
  return {
    listAll: () => ENTRIES,
    getClient: (name: string) => {
      const c = clients.get(name);
      if (!c) throw new Error(`Unknown instance "${name}"`);
      return c;
    },
    env,
  };
}

const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as { code?: string }).code ?? 'NO_CODE'; }
  return 'NO_THROW';
};

describe('deny pattern / allow list parsing', () => {
  it('has no built-in deny default; the configured comma-separated list is compiled case-insensitively', () => {
    expect(denyPatterns({})).toEqual([]);
    expect(denyPatterns({ [ENV_DENY_PATTERN]: '  ' })).toEqual([]);
    expect(denyPatterns({ [ENV_DENY_PATTERN]: ' , ' })).toEqual([]);
    const list = denyPatterns({ [ENV_DENY_PATTERN]: ' blocked , ^prod ,' });
    expect(list.map(r => r.source)).toEqual(['blocked', '^prod']);
    expect(list.every(r => r.flags.includes('i'))).toBe(true);
    expect(list.some(r => r.test('BLOCKEDDEV'))).toBe(true);
    expect(list.some(r => r.test('PRODUCTION'))).toBe(true);
    expect(() => denyPatterns({ [ENV_DENY_PATTERN]: 'ok,[' })).toThrow(expect.objectContaining({ code: 'FLOW_BUILDER_BAD_DENY_PATTERN' }));
  });

  it('treats an unset or blank allow list as "refuse everything"', () => {
    expect(allowedInstanceNames({})).toBeUndefined();
    expect(allowedInstanceNames({ [ENV_ALLOWED_INSTANCES]: '' })).toBeUndefined();
    expect(allowedInstanceNames({ [ENV_ALLOWED_INSTANCES]: ' , ' })).toBeUndefined();
    expect(allowedInstanceNames({ [ENV_ALLOWED_INSTANCES]: 'Product, otherdev ,' })).toEqual(['product', 'otherdev']);
  });

  it('hostOf extracts the lower-cased host and tolerates junk', () => {
    expect(hostOf('https://BlockedDev.service-now.com/api')).toBe('blockeddev.service-now.com');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('evaluateInstancePolicy', () => {
  const allowAll = { [ENV_ALLOWED_INSTANCES]: ENTRIES.map(e => e.name).join(',') };

  it('denies on alias, host, group and environment — and the configured deny list wins over the allow list', () => {
    const env = { ...allowAll, ...DENY };
    expect(evaluateInstancePolicy(ENTRIES[1], env)).toMatchObject({ allowed: false, code: 'FLOW_BUILDER_INSTANCE_DENIED', reason: expect.stringContaining('alias "blockeddev"') });
    expect(evaluateInstancePolicy(ENTRIES[2], env)).toMatchObject({ allowed: false, code: 'FLOW_BUILDER_INSTANCE_DENIED', reason: expect.stringContaining('host "blocked-host.service-now.com"') });
    expect(evaluateInstancePolicy(ENTRIES[3], env)).toMatchObject({ allowed: false, code: 'FLOW_BUILDER_INSTANCE_DENIED', reason: expect.stringContaining('group "Blocked Group"') });
    expect(evaluateInstancePolicy(ENTRIES[4], env)).toMatchObject({ allowed: false, code: 'FLOW_BUILDER_INSTANCE_DENIED', reason: expect.stringContaining('environment "blocked-like"') });
    expect(evaluateInstancePolicy(ENTRIES[0], env)).toMatchObject({ allowed: true });
  });

  it('without a deny list the allow list is the only control', () => {
    expect(evaluateInstancePolicy(ENTRIES[1], allowAll)).toMatchObject({ allowed: true });
    expect(evaluateInstancePolicy(ENTRIES[1], { [ENV_ALLOWED_INSTANCES]: 'product' })).toMatchObject({ allowed: false, code: 'FLOW_BUILDER_INSTANCE_NOT_ALLOWED' });
  });

  it('refuses everything when the allow list is unset, then allows only listed aliases (case-insensitive)', () => {
    expect(evaluateInstancePolicy(ENTRIES[0], {})).toMatchObject({ allowed: false, code: 'FLOW_BUILDER_ALLOW_LIST_UNSET' });
    expect(evaluateInstancePolicy(ENTRIES[0], { [ENV_ALLOWED_INSTANCES]: 'otherdev' })).toMatchObject({ allowed: false, code: 'FLOW_BUILDER_INSTANCE_NOT_ALLOWED' });
    expect(evaluateInstancePolicy(ENTRIES[0], { [ENV_ALLOWED_INSTANCES]: 'PRODUCT' })).toMatchObject({ allowed: true });
    expect(evaluateInstancePolicy(ENTRIES[5], { [ENV_ALLOWED_INSTANCES]: 'othertest' })).toMatchObject({ allowed: true });
  });

  it('every entry of a multi-pattern deny list applies, and each one wins over the allow list', () => {
    const env = { [ENV_ALLOWED_INSTANCES]: 'othertest,blockeddev,hostdev,corp', [ENV_DENY_PATTERN]: 'blocked,^othertest$' };
    expect(evaluateInstancePolicy(ENTRIES[5], env)).toMatchObject({ allowed: false, code: 'FLOW_BUILDER_INSTANCE_DENIED' });
    expect(evaluateInstancePolicy(ENTRIES[1], env).allowed).toBe(false);
    expect(evaluateInstancePolicy(ENTRIES[2], env).allowed).toBe(false); // host blocked-host
    expect(evaluateInstancePolicy(ENTRIES[3], env).allowed).toBe(false); // group "Blocked Group"
    expect(code(() => resolveInstanceOrThrow({ instance: 'blockeddev' }, undefined, deps(env)))).toBe('FLOW_BUILDER_INSTANCE_DENIED');
  });

  it('an invalid deny pattern fails closed: every instance is refused, even allow-listed ones', () => {
    for (const pattern of ['[', 'ok,(', 'blocked,*bad']) {
      const env = { ...allowAll, [ENV_DENY_PATTERN]: pattern };
      for (const entry of ENTRIES) {
        expect(evaluateInstancePolicy(entry, env), `${pattern} / ${entry.name}`).toMatchObject({ allowed: false, code: 'FLOW_BUILDER_BAD_DENY_PATTERN' });
      }
      expect(code(() => resolveInstanceOrThrow({ instance: 'product' }, undefined, deps(env))), pattern).toBe('FLOW_BUILDER_BAD_DENY_PATTERN');
    }
  });
});

describe('resolveInstanceOrThrow', () => {
  const allowProduct = { [ENV_ALLOWED_INSTANCES]: 'product,othertest' };

  it('requires an explicit instance (never falls back to the current one)', () => {
    expect(code(() => resolveInstanceOrThrow({}, undefined, deps(allowProduct)))).toBe('FLOW_BUILDER_INSTANCE_REQUIRED');
    expect(code(() => resolveInstanceOrThrow({ instance: '' }, undefined, deps(allowProduct)))).toBe('FLOW_BUILDER_INSTANCE_REQUIRED');
    expect(code(() => resolveInstanceOrThrow({ instance: 42 }, undefined, deps(allowProduct)))).toBe('FLOW_BUILDER_INSTANCE_REQUIRED');
    // the active (current) blocked entry is never used implicitly
    expect(ENTRIES.find(e => e.active)?.name).toBe('blockeddev');
  });

  it('rejects an unknown alias and lists the available ones', () => {
    try {
      resolveInstanceOrThrow({ instance: 'nope' }, undefined, deps(allowProduct));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('FLOW_BUILDER_UNKNOWN_INSTANCE');
      expect(((e as { details?: { available: string[] } }).details?.available)).toContain('product');
    }
  });

  it('denies by alias / host / group / environment before consulting the allow list', () => {
    const allowEverything = { [ENV_ALLOWED_INSTANCES]: ENTRIES.map(e => e.name).join(','), ...DENY };
    for (const name of ['blockeddev', 'BLOCKEDDEV', 'hostdev', 'corp', 'otherdev']) {
      expect(code(() => resolveInstanceOrThrow({ instance: name }, undefined, deps(allowEverything))), name).toBe('FLOW_BUILDER_INSTANCE_DENIED');
    }
  });

  it('refuses when the allow list is unset or does not list the alias', () => {
    expect(code(() => resolveInstanceOrThrow({ instance: 'product' }, undefined, deps({})))).toBe('FLOW_BUILDER_ALLOW_LIST_UNSET');
    expect(code(() => resolveInstanceOrThrow({ instance: 'product' }, undefined, deps({ [ENV_ALLOWED_INSTANCES]: 'othertest' })))).toBe('FLOW_BUILDER_INSTANCE_NOT_ALLOWED');
  });

  it('re-resolves the client itself and returns the entry facts', () => {
    const r = resolveInstanceOrThrow({ instance: 'product' }, undefined, deps(allowProduct));
    expect(r.client).toBe(clients.get('product'));
    expect(r).toMatchObject({ name: 'product', host: 'pdidemo01.service-now.com', group: 'PDI', environment: 'dev' });
    // case-insensitive alias lookup returns the canonical name
    expect(resolveInstanceOrThrow({ instance: 'othertest' }, undefined, deps(allowProduct)).name).toBe('OtherTest');
  });

  it('accepts the router client only when it IS the re-resolved client, aborts on a mismatch', () => {
    expect(resolveInstanceOrThrow({ instance: 'product' }, clients.get('product'), deps(allowProduct)).name).toBe('product');
    expect(code(() => resolveInstanceOrThrow({ instance: 'product' }, clients.get('blockeddev'), deps(allowProduct)))).toBe('FLOW_BUILDER_CLIENT_MISMATCH');
    expect(code(() => resolveInstanceOrThrow({ instance: 'product' }, clientFor('other'), deps(allowProduct)))).toBe('FLOW_BUILDER_CLIENT_MISMATCH');
  });
});

describe('resolveExportPath', () => {
  let root: string;
  let rootReal: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fb-export-root-'));
    rootReal = realpathSync.native(root); // tmpdir() may be an 8.3 short path on Windows
    outside = mkdtempSync(join(tmpdir(), 'fb-export-outside-'));
    mkdirSync(join(root, 'sub'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses when the export root is unset or not a directory', () => {
    expect(code(() => resolveExportPath('a.xml', {}))).toBe('FLOW_BUILDER_EXPORT_ROOT_UNSET');
    expect(code(() => resolveExportPath('a.xml', { [ENV_EXPORT_ROOT]: join(root, 'does-not-exist') }))).toBe('FLOW_BUILDER_EXPORT_ROOT_INVALID');
    writeFileSync(join(root, 'file.txt'), 'x');
    expect(code(() => resolveExportPath('a.xml', { [ENV_EXPORT_ROOT]: join(root, 'file.txt') }))).toBe('FLOW_BUILDER_EXPORT_ROOT_INVALID');
  });

  it('resolves relative paths under the root and accepts absolute paths inside it', () => {
    const env = { [ENV_EXPORT_ROOT]: root };
    const p = resolveExportPath('sub/flow.xml', env);
    expect(p.toLowerCase()).toBe(resolve(rootReal, 'sub', 'flow.xml').toLowerCase());
    const abs = resolveExportPath(join(root, 'flow.XML'), env);
    expect(abs.toLowerCase().startsWith(rootReal.toLowerCase() + sep)).toBe(true);
  });

  it('refuses paths that escape the root, non-xml names, missing parents, directories and symlinks', () => {
    const env = { [ENV_EXPORT_ROOT]: root };
    expect(code(() => resolveExportPath('../escape.xml', env))).toBe('FLOW_BUILDER_EXPORT_OUTSIDE_ROOT');
    expect(code(() => resolveExportPath(join(outside, 'x.xml'), env))).toBe('FLOW_BUILDER_EXPORT_OUTSIDE_ROOT');
    expect(code(() => resolveExportPath('sub/../../escape.xml', env))).toBe('FLOW_BUILDER_EXPORT_OUTSIDE_ROOT');
    expect(code(() => resolveExportPath('flow.txt', env))).toBe('FLOW_BUILDER_EXPORT_NOT_XML');
    expect(code(() => resolveExportPath('nope/flow.xml', env))).toBe('FLOW_BUILDER_EXPORT_PARENT_MISSING');
    expect(code(() => resolveExportPath('', env))).toBe('FLOW_BUILDER_EXPORT_PATH_REQUIRED');
    expect(code(() => resolveExportPath(undefined, env))).toBe('FLOW_BUILDER_EXPORT_PATH_REQUIRED');
    mkdirSync(join(root, 'dir.xml'));
    expect(code(() => resolveExportPath('dir.xml', env))).toBe('FLOW_BUILDER_EXPORT_IS_DIRECTORY');
  });

  it('refuses a symlinked parent that leads outside the root and a symlinked target', () => {
    const env = { [ENV_EXPORT_ROOT]: root };
    let linked = false;
    try {
      symlinkSync(outside, join(root, 'link'), 'junction');
      linked = true;
    } catch { /* symlink creation not permitted here — skip */ }
    if (linked) {
      expect(code(() => resolveExportPath('link/flow.xml', env))).toBe('FLOW_BUILDER_EXPORT_OUTSIDE_ROOT');
    }
    let fileLinked = false;
    try {
      writeFileSync(join(outside, 'target.xml'), '<x/>');
      symlinkSync(join(outside, 'target.xml'), join(root, 'alias.xml'), 'file');
      fileLinked = true;
    } catch { /* not permitted — skip */ }
    if (fileLinked) {
      expect(code(() => resolveExportPath('alias.xml', env))).toBe('FLOW_BUILDER_EXPORT_SYMLINK');
    }
  });
});
