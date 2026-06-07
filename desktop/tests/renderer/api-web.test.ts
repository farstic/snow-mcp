import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeApiMock } from './setup';

/**
 * Tests for the BROWSER / web-mode fallback in renderer/src/api.ts.
 *
 * api.ts computes `isElectron = window.api !== undefined` at MODULE LOAD and
 * exports `api = isElectron ? window.api : webApi`. To exercise the web branch
 * we delete window.api, reset the module registry, and re-import a fresh copy.
 *
 * Because we mutate window.api / localStorage, we restore both in afterEach so
 * other test files keep seeing the shared mock installed by setup.ts.
 */

const ACTIVE_KEY = 'servicenow-mcp:config:activeInstance';
const INSTANCES_KEY = 'servicenow-mcp:instances';

const SAMPLE_INSTANCE: InstanceConfig = {
  name: 'dev',
  instanceUrl: 'https://dev12345.service-now.com',
  authMethod: 'basic',
  username: 'admin',
  password: 'secret',
};

/** Load a fresh web-mode `api` (window.api absent at module load). */
async function loadWebApi() {
  delete (window as unknown as { api?: unknown }).api;
  vi.resetModules();
  const mod = await import('../../renderer/src/api');
  return mod.api;
}

describe('api.ts (web-mode fallback)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    // Restore the shared window.api mock and clean global state for other files.
    vi.restoreAllMocks();
    localStorage.clear();
    (window as unknown as { api: unknown }).api = makeApiMock();
    vi.resetModules();
  });

  it('falls back to the web implementation when window.api is undefined', async () => {
    const api = await loadWebApi();
    // The web api object is a plain object of async methods, not the IPC bridge.
    expect(api).toBeTruthy();
    expect(typeof api.listInstances).toBe('function');
    expect(typeof api.routeToolInvocation).toBe('function');
  });

  it('listInstances reads instances from localStorage', async () => {
    localStorage.setItem(INSTANCES_KEY, JSON.stringify([SAMPLE_INSTANCE]));
    const api = await loadWebApi();

    const instances = await api.listInstances();
    expect(Array.isArray(instances)).toBe(true);
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe('dev');
  });

  it('getAllConfig surfaces the stored active instance from localStorage', async () => {
    localStorage.setItem(INSTANCES_KEY, JSON.stringify([SAMPLE_INSTANCE]));
    localStorage.setItem(ACTIVE_KEY, JSON.stringify('dev'));
    const api = await loadWebApi();

    const cfg = await api.getAllConfig();
    expect(cfg.activeInstance).toBe('dev');
    expect(Array.isArray(cfg.instances)).toBe(true);
  });

  it('routeToolInvocation issues a ServiceNow REST fetch and returns the parsed records', async () => {
    localStorage.setItem(INSTANCES_KEY, JSON.stringify([SAMPLE_INSTANCE]));
    localStorage.setItem(ACTIVE_KEY, JSON.stringify('dev'));

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: [{ number: 'INC0010001' }, { number: 'INC0010002' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const api = await loadWebApi();
    // Server must be running for routeToolInvocation to proceed.
    await api.startServer('dev');

    const res = await api.routeToolInvocation('snow_core_records_query', { table: 'incident' });

    expect(res.success).toBe(true);
    const result = res.result as { count: number; records: unknown[] };
    expect(result.count).toBe(2);
    expect(result.records).toHaveLength(2);

    // A fetch went out to the proxied table API with a GET.
    expect(fetchSpy).toHaveBeenCalled();
    const [calledUrl, calledOpts] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    expect(String(calledUrl)).toContain('/api/now/table/incident');
    expect((calledOpts as RequestInit | undefined)?.method).toBe('GET');
  });

  it('routeToolInvocation returns an error result when the server is not running', async () => {
    localStorage.setItem(INSTANCES_KEY, JSON.stringify([SAMPLE_INSTANCE]));
    localStorage.setItem(ACTIVE_KEY, JSON.stringify('dev'));
    const fetchSpy = vi.spyOn(global, 'fetch');

    const api = await loadWebApi();
    const res = await api.routeToolInvocation('snow_core_records_query', { table: 'incident' });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not running/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
