/**
 * snow_flow_build is callable ONLY as a direct MCP (stdio) tool call — the path on which the MCP
 * client's permission prompt and the §2.1 'write approved' gate see the tool by name.
 *
 * Regression for the review finding: snow_orch_playbook_exec (dry_run:false), the REST /api/tool
 * endpoint and A2A tasks all reached snow_flow_build through routeToolInvocation with a client that
 * passed the guard's identity check, so the permission prompt only ever saw the outer tool.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { requireDirectMcpInvocation } from '../../src/flow-builder/guards.js';
import { runInToolInvocationContext, currentToolInvocation } from '../../src/utils/invocation-context.js';
import type { ServiceNowClient } from '../../src/servicenow/client.js';
import type { ServiceNowMcpHttpServer } from '../../src/transport/http-server.js';

const SPEC = {
  spec_version: '1',
  flow: { key: 'transport_probe', name: 'Transport Probe' },
  trigger: { key: 't', type: 'record.created', table: 'incident' },
  steps: [{ kind: 'action', key: 'log', action: 'log', inputs: { log_message: 'x' } }],
};
const BUILD_ARGS = { spec: SPEC, instance: 'product', update_set: { name: 'TEST_X' } };

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try { if (typeof p === 'function') p(); else await p; } catch (e) { return (e as { code?: string }).code ?? 'NO_CODE'; }
  return 'NO_THROW';
}

const ENV_KEYS = ['FLOW_BUILDER_ENABLED', 'WRITE_ENABLED', 'NOW_ASSIST_ENABLED', 'FLOW_BUILDER_ALLOWED_INSTANCES', 'SERVICENOW_INSTANCE_URL', 'SERVICENOW_AUTH_METHOD', 'SERVICENOW_BASIC_USERNAME', 'SERVICENOW_BASIC_PASSWORD', 'LOG_LEVEL', 'RETRY_DELAY_MS', 'SNMCP_API_KEY', 'MCP_TOOL_PACKAGE'];
let saved: Record<string, string | undefined>;
beforeAll(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  process.env.SERVICENOW_INSTANCE_URL = 'https://dummy.service-now.com';
  process.env.SERVICENOW_AUTH_METHOD = 'basic';
  process.env.SERVICENOW_BASIC_USERNAME = 'd';
  process.env.SERVICENOW_BASIC_PASSWORD = 'd';
  process.env.LOG_LEVEL = 'error';
  process.env.RETRY_DELAY_MS = '1';
  delete process.env.SNMCP_API_KEY;
  delete process.env.MCP_TOOL_PACKAGE;
});
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => {
  process.env.FLOW_BUILDER_ENABLED = 'true';
  process.env.WRITE_ENABLED = 'true';
  process.env.NOW_ASSIST_ENABLED = 'true';
  process.env.FLOW_BUILDER_ALLOWED_INSTANCES = 'product';
});
afterEach(() => {
  for (const k of ['FLOW_BUILDER_ENABLED', 'WRITE_ENABLED', 'NOW_ASSIST_ENABLED', 'FLOW_BUILDER_ALLOWED_INSTANCES']) delete process.env[k];
});

describe('requireDirectMcpInvocation', () => {
  it('passes only for a direct MCP stdio call of the very same tool', async () => {
    expect(await codeOf(() => requireDirectMcpInvocation('snow_flow_build', { channel: 'mcp', transport: 'stdio', tool: 'snow_flow_build' }))).toBe('NO_THROW');
    expect(await codeOf(() => requireDirectMcpInvocation('snow_flow_build', undefined))).toBe('FLOW_BUILDER_TRANSPORT_REFUSED');
    expect(await codeOf(() => requireDirectMcpInvocation('snow_flow_build', { channel: 'mcp', transport: 'http', tool: 'snow_flow_build' }))).toBe('FLOW_BUILDER_TRANSPORT_REFUSED');
    expect(await codeOf(() => requireDirectMcpInvocation('snow_flow_build', { channel: 'mcp', transport: 'sse', tool: 'snow_flow_build' }))).toBe('FLOW_BUILDER_TRANSPORT_REFUSED');
    expect(await codeOf(() => requireDirectMcpInvocation('snow_flow_build', { channel: 'mcp', transport: 'stdio', tool: 'snow_orch_playbook_exec' }))).toBe('FLOW_BUILDER_NESTED_REFUSED');
  });

  it('reads the ambient context established by runInToolInvocationContext (and nothing outside it)', async () => {
    expect(currentToolInvocation()).toBeUndefined();
    await runInToolInvocationContext({ channel: 'mcp', transport: 'stdio', tool: 'snow_flow_build' }, async () => {
      await Promise.resolve();
      expect(currentToolInvocation()?.tool).toBe('snow_flow_build');
      expect(await codeOf(() => requireDirectMcpInvocation('snow_flow_build'))).toBe('NO_THROW');
    });
    expect(currentToolInvocation()).toBeUndefined();
  });
});

describe('snow_flow_build via the router', () => {
  it('is refused with no MCP context (programmatic use of the ./sdk export) before any other gate or instance contact', async () => {
    const { routeToolInvocation } = await import('../../src/tools/index.js');
    const probe = { queryRecords: () => { throw new Error('instance contacted'); } } as unknown as ServiceNowClient;
    expect(await codeOf(routeToolInvocation(probe, 'snow_flow_build', BUILD_ARGS))).toBe('FLOW_BUILDER_TRANSPORT_REFUSED');
  });

  it('passes the transport gate as a direct stdio call (the next gate then applies)', async () => {
    const { routeToolInvocation } = await import('../../src/tools/index.js');
    delete process.env.WRITE_ENABLED;
    const r = runInToolInvocationContext({ channel: 'mcp', transport: 'stdio', tool: 'snow_flow_build' }, () => routeToolInvocation({} as ServiceNowClient, 'snow_flow_build', BUILD_ARGS));
    expect(await codeOf(r)).toBe('WRITE_NOT_ENABLED');
  });

  it('snow_orch_playbook_exec: a snow_flow_build step is refused up front (denylist), even for an MCP call of the playbook', async () => {
    const { routeToolInvocation } = await import('../../src/tools/index.js');
    const { NESTED_TOOL_DENYLIST } = await import('../../src/tools/orchestration.js');
    expect(NESTED_TOOL_DENYLIST.has('snow_flow_build')).toBe(true);
    const probe = { queryRecords: () => { throw new Error('instance contacted'); } } as unknown as ServiceNowClient;
    const playbook = { playbook: { steps: [{ tool_name: 'snow_core_current_instance_read', args_template: {} }, { tool_name: 'snow_flow_build', args_template: { ...BUILD_ARGS, activate: true } }] }, dry_run: false };
    const r = runInToolInvocationContext({ channel: 'mcp', transport: 'stdio', tool: 'snow_orch_playbook_exec' }, () => routeToolInvocation(probe, 'snow_orch_playbook_exec', playbook));
    expect(await codeOf(r)).toBe('NESTED_TOOL_REFUSED');
    // a dry run only resolves templates and never executes — still allowed
    const dry = await runInToolInvocationContext({ channel: 'mcp', transport: 'stdio', tool: 'snow_orch_playbook_exec' }, () => routeToolInvocation(probe, 'snow_orch_playbook_exec', { ...playbook, dry_run: true }));
    expect(JSON.stringify(dry)).toContain('dry_run');
  });

  it('a nested call that slips past the denylist is still refused by the flow builder itself', async () => {
    const { routeToolInvocation } = await import('../../src/tools/index.js');
    // what the playbook executor does internally: the ambient context names the OUTER tool
    const r = runInToolInvocationContext({ channel: 'mcp', transport: 'stdio', tool: 'snow_orch_playbook_exec' }, () => routeToolInvocation({} as ServiceNowClient, 'snow_flow_build', BUILD_ARGS));
    expect(await codeOf(r)).toBe('FLOW_BUILDER_NESTED_REFUSED');
  });
});

describe('snow_flow_build over HTTP side doors', () => {
  let srv: ServiceNowMcpHttpServer;
  let base: string;
  beforeAll(async () => {
    const { ServiceNowMcpHttpServer } = await import('../../src/transport/http-server.js');
    const { mountApiRoutes } = await import('../../src/api/index.js');
    srv = new ServiceNowMcpHttpServer({ port: 0, host: '127.0.0.1', corsOrigin: '*', allowedOrigins: [] });
    mountApiRoutes(srv);
    await srv.start();
    base = `http://127.0.0.1:${(srv.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { if (srv) await srv.stop(); });

  const post = (path: string, body: unknown): Promise<{ status: number; json: { error?: string } }> => new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });

  it('REST POST /api/tool is refused (no MCP permission prompt on this path)', async () => {
    const r = await post('/api/tool', { name: 'snow_flow_build', arguments: BUILD_ARGS });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/only be invoked directly by an MCP client over the stdio server/);
  });

  it('an A2A task naming snow_flow_build fails with the transport refusal', async () => {
    const { taskManager } = await import('../../src/a2a/task-manager.js');
    const res = await taskManager.sendTask({ message: { role: 'user', parts: [{ type: 'data', data: { tool_name: 'snow_flow_build', arguments: BUILD_ARGS } }] } } as never);
    expect(res.status.state).toBe('failed');
    expect(JSON.stringify(res.status.message)).toMatch(/only be invoked directly by an MCP client/);
  });
});
