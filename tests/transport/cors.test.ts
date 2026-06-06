import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { ServiceNowMcpHttpServer } from '../../src/transport/http-server.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

// Minimal HTTP request helper that lets us set the (browser-forbidden) Origin header.
function request(base: string, path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP server CORS / Origin handling', () => {
  let srv: ServiceNowMcpHttpServer | undefined;
  async function start(corsOrigin: string, allowedOrigins: string[]): Promise<string> {
    srv = new ServiceNowMcpHttpServer({ port: 0, host: '127.0.0.1', corsOrigin, allowedOrigins });
    srv.get('/ping', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }, false);
    await srv.start();
    const port = (srv.getHttpServer().address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }
  afterEach(async () => { if (srv) await srv.stop(); srv = undefined; });

  it('reflects an allow-listed Origin and sets Vary: Origin', async () => {
    const base = await start('*', ['http://localhost:5173']);
    const r = await request(base, '/ping', { headers: { Origin: 'http://localhost:5173' } });
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(String(r.headers['vary'] || '')).toContain('Origin');
  });

  it('does NOT echo a non-allow-listed Origin (falls back to configured corsOrigin)', async () => {
    const base = await start('*', ['http://localhost:5173']);
    const r = await request(base, '/ping', { headers: { Origin: 'http://evil.example.com' } });
    expect(r.headers['access-control-allow-origin']).toBe('*');
  });

  it('answers an OPTIONS preflight with 204', async () => {
    const base = await start('*', []);
    const r = await request(base, '/ping', { method: 'OPTIONS' });
    expect(r.status).toBe(204);
  });
});
