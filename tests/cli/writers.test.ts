import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock child_process so the Claude Code path (`claude mcp add`) never runs a real command.
vi.mock('child_process', () => ({ execSync: vi.fn() }));

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { writeClientConfig } from '../../src/cli/writers/index.js';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'snmcp-writers-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => vi.clearAllMocks());

const basic: any = { instanceUrl: 'https://x.service-now.com', authMethod: 'basic', username: 'u', password: 'p', writeEnabled: true, scriptingEnabled: false, cmdbWriteEnabled: false, atfEnabled: false, nowAssistEnabled: false, toolPackage: 'service_desk' };
const oauth: any = { instanceUrl: 'https://y.service-now.com', authMethod: 'oauth', clientId: 'cid', clientSecret: 'sec', username: 'u', password: 'p', writeEnabled: false, scriptingEnabled: false, cmdbWriteEnabled: false, atfEnabled: false, nowAssistEnabled: false };
const dc = (writeMethod: string, configPath: string): any => ({ writeMethod, configPath, name: 'test', displayName: 'Test' });

describe('CLI config writers', () => {
  it('json-mcpServers writes a node+args+env entry', () => {
    const p = join(dir, 'mcp.json');
    const r = writeClientConfig(dc('json-mcpServers', p), basic);
    expect(r.success).toBe(true);
    const e = JSON.parse(readFileSync(p, 'utf8')).mcpServers['servicenow-mcp'];
    expect(e.command).toBe('node');
    expect(e.args[0]).toMatch(/dist[\\/]server\.js$/);
    expect(e.env.SERVICENOW_INSTANCE_URL).toBe(basic.instanceUrl);
    expect(e.env.WRITE_ENABLED).toBe('true');
    expect(e.env.SERVICENOW_BASIC_USERNAME).toBe('u');
    expect(e.env.MCP_TOOL_PACKAGE).toBe('service_desk');
  });

  it('json-servers (VS Code) uses the servers key + type stdio', () => {
    const p = join(dir, 'vscode.json');
    writeClientConfig(dc('json-servers', p), basic);
    const e = JSON.parse(readFileSync(p, 'utf8')).servers['servicenow-mcp'];
    expect(e.type).toBe('stdio');
    expect(e.command).toBe('node');
  });

  it('env writer emits KEY=VALUE lines', () => {
    const p = join(dir, 'dotenv.env');
    writeClientConfig(dc('env', p), basic);
    const txt = readFileSync(p, 'utf8');
    expect(txt).toContain('SERVICENOW_INSTANCE_URL=https://x.service-now.com');
    expect(txt).toContain('WRITE_ENABLED=true');
  });

  it('oauth instance writes OAuth env keys, not basic', () => {
    const p = join(dir, 'oauth.json');
    writeClientConfig(dc('json-mcpServers', p), oauth);
    const e = JSON.parse(readFileSync(p, 'utf8')).mcpServers['servicenow-mcp'];
    expect(e.env.SERVICENOW_OAUTH_CLIENT_ID).toBe('cid');
    expect(e.env.SERVICENOW_OAUTH_CLIENT_SECRET).toBe('sec');
    expect(e.env.SERVICENOW_BASIC_USERNAME).toBeUndefined();
  });

  it('mergeJsonConfig preserves existing keys and entries', () => {
    const p = join(dir, 'merge.json');
    writeFileSync(p, JSON.stringify({ other: 1, mcpServers: { existing: { command: 'x' } } }));
    writeClientConfig(dc('json-mcpServers', p), basic);
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    expect(cfg.other).toBe(1);
    expect(cfg.mcpServers.existing.command).toBe('x');
    expect(cfg.mcpServers['servicenow-mcp']).toBeTruthy();
  });

  it('command (Claude Code) runs `claude mcp add` via execSync', () => {
    const r = writeClientConfig(dc('command', 'unused'), basic);
    expect(r.success).toBe(true);
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(String((execSync as any).mock.calls[0][0])).toContain('claude mcp add servicenow-mcp node');
  });

  it('unknown write method returns a failure result', () => {
    const r = writeClientConfig(dc('bogus', 'x'), basic);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Unknown write method/);
  });
});
