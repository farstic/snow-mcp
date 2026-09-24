/**
 * Tool-invocation context — WHO is calling a tool, carried through async code with AsyncLocalStorage.
 *
 * Only the MCP server's CallTool handler (src/server.ts) establishes a context, naming the MCP transport
 * and the tool the MCP client asked for. Everything else that reaches routeToolInvocation — the REST
 * API (/api/tool), A2A tasks, this package's programmatic ./sdk export (src/sdk), and tools that call other tools (e.g.
 * snow_orch_playbook_exec) — runs either with NO context or with a context whose `tool` is the OUTER
 * tool. High-risk tools (snow_flow_build) use this to refuse any invocation that did not come directly
 * from an MCP client, where the client's own permission prompt and the §2.1 'write approved' gate apply.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type McpTransportName = 'stdio' | 'sse' | 'http';

export interface ToolInvocationContext {
  channel: 'mcp';
  transport: McpTransportName;
  /** The tool the MCP client invoked (the outermost tool of this call chain). */
  tool: string;
}

const storage = new AsyncLocalStorage<Readonly<ToolInvocationContext>>();

/** Run `fn` with the given invocation context (used by src/server.ts for every MCP CallTool request). */
export function runInToolInvocationContext<T>(ctx: ToolInvocationContext, fn: () => T): T {
  return storage.run(Object.freeze({ ...ctx }), fn);
}

/** The current invocation context, or undefined outside an MCP CallTool request. */
export function currentToolInvocation(): Readonly<ToolInvocationContext> | undefined {
  return storage.getStore();
}
