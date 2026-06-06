import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { collectToolCatalog, routeToolInvocation, ROLE_BUNDLE_MAP } from '../../src/tools/index.js';
import type { ServiceNowClient } from '../../src/servicenow/client.js';

const EXPECTED = 394;

// canonical old -> new map produced by scripts/build-rename-map.mjs
const renameMap: Record<string, string> = JSON.parse(
  readFileSync(new URL('../../tool-rename-map.json', import.meta.url), 'utf8')
);

// every client method call throws — so a *recognised* tool body either validates/permission-throws
// or hits the client and throws; only an *unrecognised* name produces UNKNOWN_TOOL.
const throwingClient = new Proxy(
  {},
  { get: () => (..._args: unknown[]) => { throw new Error('MOCK_CLIENT_CALL'); } }
) as unknown as ServiceNowClient;

describe('tool catalog parity (394-tool migration guard)', () => {
  let prevPackage: string | undefined;
  beforeEach(() => {
    prevPackage = process.env.MCP_TOOL_PACKAGE;
    delete process.env.MCP_TOOL_PACKAGE;
  });
  afterEach(() => {
    if (prevPackage === undefined) delete process.env.MCP_TOOL_PACKAGE;
    else process.env.MCP_TOOL_PACKAGE = prevPackage;
  });

  it('1. exposes exactly 394 tools (count parity)', () => {
    expect(collectToolCatalog().length).toBe(EXPECTED);
  });

  it('2. all tool names are unique and namespaced (snow_)', () => {
    const names = collectToolCatalog().map(t => t.name);
    expect(new Set(names).size).toBe(EXPECTED);
    expect(names.every(n => n.startsWith('snow_'))).toBe(true);
  });

  it('3. rename map is a total bijection equal to the live catalog', () => {
    const oldKeys = Object.keys(renameMap);
    const newVals = Object.values(renameMap);
    expect(oldKeys.length).toBe(EXPECTED);
    expect(new Set(oldKeys).size).toBe(EXPECTED);
    expect(new Set(newVals).size).toBe(EXPECTED);

    const catalog = new Set(collectToolCatalog().map(t => t.name));
    const mapped = new Set(newVals);
    // sets must be equal in both directions (catches map/codegen drift)
    expect([...mapped].filter(n => !catalog.has(n))).toEqual([]);
    expect([...catalog].filter(n => !mapped.has(n))).toEqual([]);
  });

  it('4. every catalog tool is reachable by the dispatcher (no UNKNOWN_TOOL)', async () => {
    const orphans: string[] = [];
    for (const { name } of collectToolCatalog()) {
      try {
        await routeToolInvocation(throwingClient, name, {});
      } catch (e) {
        if ((e as { code?: string }).code === 'UNKNOWN_TOOL') orphans.push(name);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('5. every role bundle references only live tool names', () => {
    const catalog = new Set(collectToolCatalog().map(t => t.name));
    const dead: Record<string, string[]> = {};
    for (const [bundle, names] of Object.entries(ROLE_BUNDLE_MAP)) {
      const missing = names.filter(n => !catalog.has(n));
      if (missing.length) dead[bundle] = missing;
    }
    expect(dead).toEqual({});
  });
});
