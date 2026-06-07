import { describe, it, expect } from 'vitest';
import { isSafeExternalUrl, sanitizeError, isValidInstanceUrl, CONFIG_SET_ALLOWLIST, resolveBuildVariant } from '../../main/security';

describe('main/security helpers', () => {
  it('isSafeExternalUrl allows http/https/mailto, rejects everything else', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(true);
    expect(isSafeExternalUrl('mailto:a@b.com')).toBe(true);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });

  it('sanitizeError strips API-key-like patterns', () => {
    expect(sanitizeError('boom sk-ant-abc123XYZ_- end')).toContain('sk-ant-***');
    expect(sanitizeError('AIzaSyABCDEFGHIJ')).toContain('AIza***');
    expect(sanitizeError('gsk_abc123def')).toContain('gsk_***');
    expect(sanitizeError('https://x?key=supersecret&y=1')).toContain('key=***');
    expect(sanitizeError('sk-or-abcdef123')).toContain('sk-or-***');
    expect(sanitizeError('a plain message')).toBe('a plain message');
  });

  it('isValidInstanceUrl requires https', () => {
    expect(isValidInstanceUrl('https://x.service-now.com')).toBe(true);
    expect(isValidInstanceUrl('http://x.service-now.com')).toBe(false);
    expect(isValidInstanceUrl('ftp://x')).toBe(false);
    expect(isValidInstanceUrl('garbage')).toBe(false);
  });

  it('CONFIG_SET_ALLOWLIST gates renderer-writable keys', () => {
    expect(CONFIG_SET_ALLOWLIST.has('theme')).toBe(true);
    expect(CONFIG_SET_ALLOWLIST.has('settings')).toBe(true);
    expect(CONFIG_SET_ALLOWLIST.has('password')).toBe(false);
    expect(CONFIG_SET_ALLOWLIST.has('instances')).toBe(false);
  });
});

describe('resolveBuildVariant (DEV/prod data-dir isolation)', () => {
  it('explicit SNMCP_VARIANT wins in both directions, over name and isDev', () => {
    expect(resolveBuildVariant({ envVariant: 'dev', appName: 'servicenow-mcp-desktop' })).toBe('dev');
    expect(resolveBuildVariant({ envVariant: 'prod', appName: 'servicenow-mcp-dev', isDev: true })).toBe('prod');
  });

  it('detects a packaged DEV build by its bundled name ending in -dev', () => {
    expect(resolveBuildVariant({ appName: 'servicenow-mcp-dev' })).toBe('dev');
  });

  it('does NOT false-positive on prod names (no substring "dev" trap)', () => {
    // The shipped prod name and a hypothetical "developer" rename must both resolve to prod.
    expect(resolveBuildVariant({ appName: 'servicenow-mcp-desktop' })).toBe('prod');
    expect(resolveBuildVariant({ appName: 'servicenow-mcp-developer-edition' })).toBe('prod');
  });

  it('unpackaged development (--dev) defaults to dev so `npm run dev` never touches prod data', () => {
    expect(resolveBuildVariant({ appName: 'servicenow-mcp-desktop', isDev: true })).toBe('dev');
  });

  it('defaults to prod when nothing signals dev', () => {
    expect(resolveBuildVariant({ appName: 'servicenow-mcp-desktop' })).toBe('prod');
    expect(resolveBuildVariant({})).toBe('prod');
  });
});
