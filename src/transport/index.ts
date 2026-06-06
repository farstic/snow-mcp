/**
 * Transport factory — selects and configures the MCP transport based on TRANSPORT env var.
 *
 * Supported transports:
 *   stdio (default) — Standard I/O (child process pipes)
 *   sse             — Server-Sent Events over HTTP
 *   http            — Streamable HTTP (MCP 2025-03-26 spec)
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../utils/logging.js';
import { createHttpServer, type ServiceNowMcpHttpServer } from './http-server.js';
import { getPackageVersion } from '../utils/version.js';

export type TransportType = 'stdio' | 'sse' | 'http';

export function getTransportType(): TransportType {
  const transport = (process.env.TRANSPORT || 'stdio').toLowerCase();
  if (transport === 'sse' || transport === 'http') return transport;
  return 'stdio';
}

/**
 * Connect the MCP server to the selected transport.
 * Returns the HTTP server instance if using SSE/HTTP transport (for mounting API routes).
 */
export async function connectTransport(
  server: Server,
  toolCount: number,
  createServerFn?: () => Server,
): Promise<ServiceNowMcpHttpServer | null> {
  const transportType = getTransportType();

  if (transportType === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info(`ServiceNow MCP Toolkit server running on stdio [${toolCount} tools]`);
    return null;
  }

  // HTTP-based transports (SSE or Streamable HTTP)
  const httpServer = createHttpServer();

  if (transportType === 'sse') {
    await setupSseTransport(server, httpServer);
  } else {
    // Streamable HTTP isolates each session with its own server; fall back to the shared one.
    await setupStreamableHttpTransport(createServerFn || (() => server), httpServer);
  }

  logger.info(`ServiceNow MCP Toolkit server running on ${transportType} [${toolCount} tools]`);
  return httpServer;
}

/**
 * SSE Transport — GET /sse opens an SSE stream, POST /messages sends client messages.
 */
async function setupSseTransport(server: Server, httpServer: ServiceNowMcpHttpServer): Promise<void> {
  const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');

  const sessions = new Map<string, InstanceType<typeof SSEServerTransport>>();

  httpServer.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    sessions.set(sessionId, transport);

    req.on('close', () => {
      sessions.delete(sessionId);
      logger.info(`SSE session closed: ${sessionId}`);
    });

    await server.connect(transport);
    logger.info(`SSE session connected: ${sessionId}`);
  }, true);

  httpServer.post('/messages', async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing sessionId' }));
      return;
    }

    const transport = sessions.get(sessionId)!;
    await transport.handlePostMessage(req, res);
  }, true);

  // Health endpoint (no auth required)
  addHealthRoute(httpServer);
  await httpServer.start();
}

/**
 * Streamable HTTP Transport — POST/GET/DELETE /mcp.
 * One transport (with its own MCP Server) per session, keyed by the `mcp-session-id`
 * header, so concurrent clients can't collide on a shared transport. DNS-rebinding
 * protection validates Host/Origin against an allowlist.
 */
async function setupStreamableHttpTransport(createServerFn: () => Server, httpServer: ServiceNowMcpHttpServer): Promise<void> {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { isInitializeRequest } = await import('@modelcontextprotocol/sdk/types.js');
  const { randomUUID } = await import('crypto');

  type SHT = InstanceType<typeof StreamableHTTPServerTransport>;
  const transports = new Map<string, SHT>();
  const { allowedHosts, allowedOrigins } = getOriginPolicy();
  const sessionOf = (req: { headers: Record<string, string | string[] | undefined> }): string | undefined => {
    const raw = req.headers['mcp-session-id'];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const badSession = (res: { writeHead: (n: number, h: Record<string, string>) => void; end: (b: string) => void }) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
  };

  httpServer.post('/mcp', async (req, res) => {
    const sid = sessionOf(req);
    const body = (req as { body?: unknown }).body;
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      if (sid || !isInitializeRequest(body)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID, and not an initialize request' }, id: null }));
        return;
      }
      const created: SHT = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableDnsRebindingProtection: true,
        allowedHosts,
        allowedOrigins,
        onsessioninitialized: (id: string) => { transports.set(id, created); logger.info(`MCP session initialized: ${id}`); },
      });
      created.onclose = () => { if (created.sessionId) { transports.delete(created.sessionId); logger.info(`MCP session closed: ${created.sessionId}`); } };
      await createServerFn().connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  }, true);

  httpServer.get('/mcp', async (req, res) => {
    const sid = sessionOf(req);
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) return badSession(res);
    await transport.handleRequest(req, res);
  }, true);

  httpServer.delete('/mcp', async (req, res) => {
    const sid = sessionOf(req);
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) return badSession(res);
    await transport.handleRequest(req, res);
  }, true);

  addHealthRoute(httpServer);
  await httpServer.start();
}

/** Host/Origin allowlists for DNS-rebinding protection, from bind config + ALLOWED_ORIGINS env. */
export function getOriginPolicy(): { allowedHosts: string[]; allowedOrigins: string[] } {
  const port = process.env.PORT || '3000';
  const host = process.env.HOST || '0.0.0.0';
  const hosts = new Set<string>([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `${host}:${port}`]);
  const origins = new Set<string>([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  for (const extra of (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    origins.add(extra);
    try { hosts.add(new URL(extra).host); } catch { /* not a URL — skip */ }
  }
  return { allowedHosts: [...hosts], allowedOrigins: [...origins] };
}

/** Shared health endpoint — no auth required. */
function addHealthRoute(httpServer: ServiceNowMcpHttpServer): void {
  httpServer.get('/health', async (_req, res) => {
    const { collectToolCatalog } = await import('../tools/index.js');
    const tools = collectToolCatalog();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      name: 'servicenow-mcp',
      version: getPackageVersion(),
      transport: getTransportType(),
      tools_count: tools.length,
      timestamp: new Date().toISOString(),
    }));
  }, false);
}

export { ServiceNowMcpHttpServer } from './http-server.js';
