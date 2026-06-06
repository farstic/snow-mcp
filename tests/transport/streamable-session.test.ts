import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getOriginPolicy } from '../../src/transport/index.js';
import type { ServiceNowMcpHttpServer } from '../../src/transport/http-server.js';

const PORT = 38217;
const BASE = `http://127.0.0.1:${PORT}`;

// A throwaway MCP server factory (one per session, like production).
function makeServer(): Server {
  const s = new Server({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return s;
}

function post(path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers } },
      (res) => {
        let data = '';
        let settled = false;
        res.on('data', (c) => { data += c; });
        const done = () => { if (settled) return; settled = true; resolve({ status: res.statusCode || 0, headers: res.headers, body: data }); res.destroy(); };
        res.on('end', done);
        setTimeout(done, 1200); // initialize returns an open SSE stream — resolve on headers
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

describe('Streamable HTTP transport — per-session isolation', () => {
  let httpServer: ServiceNowMcpHttpServer | null = null;

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'error';
    process.env.TRANSPORT = 'http';
    process.env.PORT = String(PORT);
    process.env.HOST = '127.0.0.1';
    const { connectTransport } = await import('../../src/transport/index.js');
    httpServer = await connectTransport(makeServer(), 0, makeServer);
  });
  afterAll(async () => { if (httpServer) await httpServer.stop(); });

  it('getOriginPolicy allow-lists localhost + configured host and ALLOWED_ORIGINS', () => {
    const { allowedHosts, allowedOrigins } = getOriginPolicy();
    expect(allowedHosts).toContain(`127.0.0.1:${PORT}`);
    expect(allowedHosts).toContain(`localhost:${PORT}`);
    expect(allowedOrigins).toContain(`http://127.0.0.1:${PORT}`);
  });

  it('rejects a non-initialize POST with no session (400, JSON-RPC -32000)', async () => {
    const r = await post('/mcp', {}, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(r.status).toBe(400);
    expect(r.body).toContain('-32000');
  }, 10000);

  it('creates a distinct session per initialize (no shared transport)', async () => {
    const a = await post('/mcp', {}, INIT);
    const b = await post('/mcp', {}, INIT);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers['mcp-session-id']).toBeTruthy();
    expect(b.headers['mcp-session-id']).toBeTruthy();
    expect(a.headers['mcp-session-id']).not.toBe(b.headers['mcp-session-id']);
  }, 10000);

  it('rejects a POST referencing an unknown session id (400)', async () => {
    const r = await post('/mcp', { 'mcp-session-id': 'does-not-exist' }, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    expect(r.status).toBe(400);
  }, 10000);
});
