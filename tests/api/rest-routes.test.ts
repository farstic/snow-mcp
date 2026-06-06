import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { ServiceNowMcpHttpServer } from '../../src/transport/http-server.js';

let srv: ServiceNowMcpHttpServer;
let base: string;

function call(path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { let json: any; try { json = JSON.parse(data); } catch { json = data; } resolve({ status: res.statusCode || 0, json }); });
      }
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

beforeAll(async () => {
  process.env.SERVICENOW_INSTANCE_URL = 'https://dummy.service-now.com';
  process.env.SERVICENOW_AUTH_METHOD = 'basic';
  process.env.SERVICENOW_BASIC_USERNAME = 'd';
  process.env.SERVICENOW_BASIC_PASSWORD = 'd';
  process.env.LOG_LEVEL = 'error';
  process.env.RETRY_DELAY_MS = '1';    // near-instant retries so stubbed network failures fail fast
  delete process.env.SNMCP_API_KEY;   // auth-middleware passes through with no key
  delete process.env.WRITE_ENABLED;
  delete process.env.MCP_TOOL_PACKAGE;
  const { ServiceNowMcpHttpServer } = await import('../../src/transport/http-server.js');
  const { mountApiRoutes } = await import('../../src/api/index.js');
  srv = new ServiceNowMcpHttpServer({ port: 0, host: '127.0.0.1', corsOrigin: '*', allowedOrigins: [] });
  mountApiRoutes(srv);
  await srv.start();
  base = `http://127.0.0.1:${(srv.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => { if (srv) await srv.stop(); });
afterEach(() => vi.restoreAllMocks());

describe('REST API — tools', () => {
  it('GET /api/tools lists all 394 tools', async () => {
    const r = await call('/api/tools');
    expect(r.status).toBe(200);
    expect(r.json.count).toBe(394);
    expect(r.json.tools).toHaveLength(394);
  });

  it('GET /api/tools/:name returns a single tool schema', async () => {
    const r = await call('/api/tools/snow_inc_incident_add');
    expect(r.status).toBe(200);
    expect(r.json.name).toBe('snow_inc_incident_add');
    expect(r.json.inputSchema?.type).toBe('object');
  });

  it('GET /api/tools/:name 404s for an unknown tool', async () => {
    const r = await call('/api/tools/snow_does_not_exist');
    expect(r.status).toBe(404);
    expect(r.json.error).toMatch(/not found/i);
  });

  it('POST /api/tool 400s when name is missing', async () => {
    const r = await call('/api/tool', { method: 'POST', body: { arguments: {} } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/name/i);
  });

  it('POST /api/tool maps a ServiceNowError to 400 (permission gate)', async () => {
    const r = await call('/api/tool', { method: 'POST', body: { name: 'snow_inc_incident_add', arguments: {} } });
    expect(r.status).toBe(400); // WRITE_NOT_ENABLED is a ServiceNowError
    expect(typeof r.json.error).toBe('string');
  });

  it('POST /api/tool maps a generic error to 500 (unknown instance)', async () => {
    const r = await call('/api/tool', { method: 'POST', body: { name: 'snow_core_records_query', instance: 'ghost', arguments: { table: 'incident' } } });
    expect(r.status).toBe(500);
  });

  it('POST /api/tool executes a read tool and returns its result', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ result: [{ sys_id: 'x', number: 'INC1' }] }),
    } as unknown as Response);
    const r = await call('/api/tool', { method: 'POST', body: { name: 'snow_core_records_query', arguments: { table: 'incident' } } });
    expect(r.status).toBe(200);
    expect(r.json.result).toBeTruthy();
  });
});

describe('REST API — resources & prompts', () => {
  it('GET /api/resources lists resources', async () => {
    const r = await call('/api/resources');
    expect(r.status).toBe(200);
    expect(r.json.count).toBeGreaterThan(0);
    expect(r.json.resources.length).toBe(r.json.count);
  });

  it('GET /api/resource 400s without a uri', async () => {
    const r = await call('/api/resource');
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/uri/i);
  });

  it('GET /api/resource reads a static resource (query-syntax)', async () => {
    const r = await call(`/api/resource?uri=${encodeURIComponent('servicenow://query-syntax')}`);
    expect(r.status).toBe(200);
    expect(r.json.result).toBeTruthy();
  });

  it('GET /api/resource 500s when the underlying read fails', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    const r = await call(`/api/resource?uri=${encodeURIComponent('servicenow://my-incidents')}`);
    expect(r.status).toBe(500);
  });

  it('GET /api/prompts lists prompts', async () => {
    const r = await call('/api/prompts');
    expect(r.status).toBe(200);
    expect(r.json.count).toBeGreaterThan(0);
  });
});

describe('REST API — instances', () => {
  it('GET /api/instances lists configured instances', async () => {
    const r = await call('/api/instances');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.instances)).toBe(true);
    expect(r.json.instances.length).toBeGreaterThan(0);
  });

  it('POST /api/instances/switch 400s without name', async () => {
    const r = await call('/api/instances/switch', { method: 'POST', body: {} });
    expect(r.status).toBe(400);
  });

  it('POST /api/instances/switch 400s for an unknown instance', async () => {
    const r = await call('/api/instances/switch', { method: 'POST', body: { name: 'ghost' } });
    expect(r.status).toBe(400);
  });

  it('POST /api/instances/switch succeeds for a configured instance', async () => {
    const list = await call('/api/instances');
    const name: string = list.json.instances[0].name ?? list.json.instances[0];
    const r = await call('/api/instances/switch', { method: 'POST', body: { name } });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
  });
});
