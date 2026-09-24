/**
 * src/tools/flow-builder.ts — manifest, argument validation and GATE ORDER.
 * The generator and writer are implemented. The fake clients here only have queryRecords, so a
 * call that reaches the WRITER is refused with FLOW_BUILDER_CLIENT_UNSUPPORTED (its first check) -
 * that code is the "every guard passed" marker. End-to-end runs against a full fake client live in
 * tests/flow-builder/tools/flow-builder-tools.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { fakeClients, entries } = vi.hoisted(() => {
  const entries = [
    { name: 'product', url: 'https://pdidemo01.service-now.com', group: 'PDI', environment: 'dev', active: false },
    { name: 'blockeddev', url: 'https://blockeddev.service-now.com', group: 'Blocked', environment: 'dev', active: true },
  ];
  const fakeClients = new Map(entries.map(e => [e.name, { __name: e.name, queryRecords: async () => ({ count: 0, records: [] }) }]));
  return { fakeClients, entries };
});

vi.mock('../../src/servicenow/instances.js', () => ({
  instanceManager: {
    listAll: () => entries,
    getClient: (name?: string) => {
      const c = fakeClients.get(name ?? 'blockeddev');
      if (!c) throw new Error(`Unknown instance "${name}"`);
      return c;
    },
    getCurrentName: () => 'blockeddev',
  },
}));

import { flowBuilderToolManifest, dispatchFlowBuilderAction, FLOW_BUILDER_TOOL_NAMES, decodeRowForReview, makeDictionaryPillTypeResolver } from '../../src/tools/flow-builder.js';
import { encodeValues } from '../../src/flow-builder/encode.js';
import type { ServiceNowClient } from '../../src/servicenow/client.js';
import { runInToolInvocationContext } from '../../src/utils/invocation-context.js';
/** snow_flow_build only runs as a DIRECT MCP (stdio) call — tests enter that context explicitly. */
const mcpBuild = (c: ServiceNowClient, args: Record<string, unknown>) => runInToolInvocationContext({ channel: 'mcp', transport: 'stdio', tool: 'snow_flow_build' }, () => dispatchFlowBuilderAction(c, 'snow_flow_build', args));


const productClient = fakeClients.get('product') as unknown as ServiceNowClient;
const blockedClient = fakeClients.get('blockeddev') as unknown as ServiceNowClient;

const SPEC = {
  spec_version: '1',
  flow: { key: 'p1_log', name: 'P1 Log' },
  trigger: { key: 't', type: 'record.created', table: 'incident', condition: 'priority=1' },
  steps: [{ kind: 'action', key: 'log', action: 'log', inputs: { log_level: 'info', log_message: { text: 'P1 {{trigger.current.number}}' } } }],
};

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as { code?: string }).code ?? 'NO_CODE'; }
  return 'NO_THROW';
}

const ENV_KEYS = ['FLOW_BUILDER_ENABLED', 'FLOW_BUILDER_ACTIVATE_ENABLED', 'WRITE_ENABLED', 'FLOW_BUILDER_ALLOWED_INSTANCES', 'FLOW_BUILDER_DENY_PATTERN', 'FLOW_BUILDER_EXPORT_ROOT'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FLOW_BUILDER_DENY_PATTERN = 'blocked'; // the locally configured deny list (no default in code)
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const enable = () => { process.env.FLOW_BUILDER_ENABLED = 'true'; };
const allowProduct = () => { process.env.FLOW_BUILDER_ALLOWED_INSTANCES = 'product'; };

describe('manifest', () => {
  it('exposes exactly the five fixed tool names with the fixed required arguments', () => {
    const tools = flowBuilderToolManifest();
    expect(tools.map(t => t.name)).toEqual([...FLOW_BUILDER_TOOL_NAMES]);
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    expect(byName.snow_flow_catalog_read.inputSchema.required).toEqual([]);
    expect(byName.snow_flow_plan.inputSchema.required).toEqual(['spec']);
    expect(byName.snow_flow_build.inputSchema.required).toEqual(['spec', 'instance', 'update_set']);
    expect(byName.snow_flow_verify.inputSchema.required).toEqual(['instance']);
    expect(byName.snow_flow_export_xml.inputSchema.required).toEqual(['spec', 'format', 'out_path']);
    expect(byName.snow_flow_build.description).toContain('**[Write]**');
    for (const t of tools) expect(t.description.length).toBeGreaterThan(40);
  });

  it('snow_flow_build: transport loader (default) | table_api, and the description warns that table_api flows stay version 1', () => {
    const build = flowBuilderToolManifest().find(t => t.name === 'snow_flow_build')!;
    const transport = (build.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>).transport;
    expect(transport.enum).toEqual(['loader', 'table_api']);
    expect(transport.description).toMatch(/"loader" \(default\)/);
    expect(build.description).toContain('api/fluent/load/<scope>?targetUpdateSetId=');
    expect(build.description).toContain('NO sys_user_preference write');
    expect(build.description).toMatch(/table_api.*stays version 1.*NOT usable by Flow Designer/s);
    const plan = flowBuilderToolManifest().find(t => t.name === 'snow_flow_plan')!;
    expect((plan.inputSchema.properties as Record<string, { enum?: string[] }>).transport.enum).toEqual(['loader', 'table_api']);
  });

  it('returns null for names it does not own', async () => {
    expect(await dispatchFlowBuilderAction(productClient, 'snow_flow_flows_index', {})).toBeNull();
  });
});

describe('feature flag gate (every tool)', () => {
  it('refuses every tool with FLOW_BUILDER_NOT_ENABLED before anything else', async () => {
    for (const name of FLOW_BUILDER_TOOL_NAMES) {
      expect(await codeOf(dispatchFlowBuilderAction(productClient, name, { spec: SPEC, instance: 'product', update_set: { name: 'x' }, format: 'record_update', out_path: 'a.xml' })), name).toBe('FLOW_BUILDER_NOT_ENABLED');
    }
  });
});

describe('snow_flow_catalog_read', () => {
  it('returns the offline catalogue once enabled (whole, or one entry by name)', async () => {
    enable();
    const all = await dispatchFlowBuilderAction(productClient, 'snow_flow_catalog_read', {});
    expect(all.count).toBeGreaterThan(40);
    const one = await dispatchFlowBuilderAction(productClient, 'snow_flow_catalog_read', { name: 'log' });
    expect(one.count).toBeGreaterThan(0);
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_catalog_read', { name: 'no_such_entry_xyz' }))).toBe('NOT_FOUND');
  });
});

describe('snow_flow_plan', () => {
  beforeEach(enable);

  it('returns structured errors for an invalid spec instead of throwing', async () => {
    const r = await dispatchFlowBuilderAction(productClient, 'snow_flow_plan', { spec: { spec_version: '1', flow: { key: 'f', name: 'F' }, steps: [] } });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('parse');
    expect(r.errors.map((e: { message: string }) => e.message)).toContain('a flow requires a trigger');
    const r2 = await dispatchFlowBuilderAction(productClient, 'snow_flow_plan', {});
    expect(r2.ok).toBe(false);
  });

  it('with a valid spec and no instance it generates the plan without touching any instance', async () => {
    const spy = vi.spyOn(blockedClient as unknown as { queryRecords: () => Promise<unknown> }, 'queryRecords');
    const r = await dispatchFlowBuilderAction(blockedClient, 'snow_flow_plan', { spec: SPEC });
    expect(r.ok).toBe(true);
    expect(r.live).toBe(false);
    expect(r.instance).toBeUndefined();
    expect(r.rowCount).toBeGreaterThan(2);
    expect(r.writes).toContain('none');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const r2 = await dispatchFlowBuilderAction(productClient, 'snow_flow_plan', { spec: JSON.stringify(SPEC) });
    expect(r2.plan.flow.sys_id).toBe(r.plan.flow.sys_id); // deterministic ids
  });

  it('with an instance the guards run BEFORE generatePlan', async () => {
    expect(await codeOf(dispatchFlowBuilderAction(blockedClient, 'snow_flow_plan', { spec: SPEC, instance: 'blockeddev' }))).toBe('FLOW_BUILDER_INSTANCE_DENIED');
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_plan', { spec: SPEC, instance: 'product' }))).toBe('FLOW_BUILDER_ALLOW_LIST_UNSET');
    allowProduct();
    const r = await dispatchFlowBuilderAction(productClient, 'snow_flow_plan', { spec: SPEC, instance: 'product' });
    expect(r.instance).toBe('product');
    expect(r.live).toBe(true);
    expect(r.liveChecks.tables).toEqual([{ table: 'incident', where: 'trigger.table', exists: false }]); // the fake has no sys_db_object rows
    expect(r.ok).toBe(false);
    expect(await codeOf(dispatchFlowBuilderAction(blockedClient, 'snow_flow_plan', { spec: SPEC, instance: 'product' }))).toBe('FLOW_BUILDER_CLIENT_MISMATCH');
  });
});

describe('snow_flow_build — gate order', () => {
  const good = () => ({ spec: SPEC, instance: 'product', update_set: { name: 'TEST_FLOW_BUILDER_TEST' } });
  beforeEach(enable);

  it('needs WRITE_ENABLED after the builder flag', async () => {
    expect(await codeOf(mcpBuild(productClient, good()))).toBe('WRITE_NOT_ENABLED');
  });

  it('validates the arguments before resolving the instance', async () => {
    process.env.WRITE_ENABLED = 'true';
    expect(await codeOf(mcpBuild(productClient, { ...good(), update_set: undefined }))).toBe('INVALID_REQUEST');
    expect(await codeOf(mcpBuild(productClient, { ...good(), update_set: {} }))).toBe('INVALID_REQUEST');
    expect(await codeOf(mcpBuild(productClient, { ...good(), mode: 'upsert' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(mcpBuild(productClient, { ...good(), delete_stale: true }))).toBe('INVALID_REQUEST');
    expect(await codeOf(mcpBuild(productClient, { ...good(), transport: 'xml' }))).toBe('INVALID_REQUEST');
  });

  it('activate:true needs FLOW_BUILDER_ACTIVATE_ENABLED and is checked before the instance', async () => {
    process.env.WRITE_ENABLED = 'true';
    expect(await codeOf(mcpBuild(productClient, { ...good(), activate: true }))).toBe('FLOW_BUILDER_ACTIVATE_NOT_ENABLED');
  });

  it('instance is required, deny wins, allow list is default-deny, router client must match', async () => {
    process.env.WRITE_ENABLED = 'true';
    expect(await codeOf(mcpBuild(productClient, { ...good(), instance: undefined }))).toBe('FLOW_BUILDER_INSTANCE_REQUIRED');
    process.env.FLOW_BUILDER_ALLOWED_INSTANCES = 'product,blockeddev';
    expect(await codeOf(mcpBuild(blockedClient, { ...good(), instance: 'blockeddev' }))).toBe('FLOW_BUILDER_INSTANCE_DENIED');
    delete process.env.FLOW_BUILDER_ALLOWED_INSTANCES;
    expect(await codeOf(mcpBuild(productClient, good()))).toBe('FLOW_BUILDER_ALLOW_LIST_UNSET');
    allowProduct();
    expect(await codeOf(mcpBuild(blockedClient, good()))).toBe('FLOW_BUILDER_CLIENT_MISMATCH');
  });

  it('with every gate passed, an invalid spec is rejected and a valid one reaches the writer', async () => {
    process.env.WRITE_ENABLED = 'true';
    allowProduct();
    expect(await codeOf(mcpBuild(productClient, { ...good(), spec: { spec_version: '1' } }))).toBe('FLOW_BUILDER_INVALID_SPEC');
    expect(await codeOf(mcpBuild(productClient, good()))).toBe('FLOW_BUILDER_CLIENT_UNSUPPORTED'); // loader: no postMultipart on this bare fake
    expect(await codeOf(mcpBuild(productClient, { ...good(), transport: 'table_api' }))).toBe('FLOW_BUILDER_CLIENT_UNSUPPORTED');
    expect(await codeOf(mcpBuild(undefined as unknown as ServiceNowClient, { ...good(), update_set: { sys_id: '0123456789abcdef0123456789abcdef' }, mode: 'update', delete_stale: true, confirm_delete: ['0123456789abcdef0123456789abcdef'] }))).toBe('FLOW_BUILDER_CLIENT_UNSUPPORTED');
  });
});

describe('snow_flow_verify', () => {
  beforeEach(() => { enable(); allowProduct(); });

  it('requires the instance and either flow_sys_id or spec', async () => {
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_verify', {}))).toBe('FLOW_BUILDER_INSTANCE_REQUIRED');
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_verify', { instance: 'product' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_verify', { instance: 'product', flow_sys_id: 'ABC' }))).toBe('INVALID_REQUEST');
  });

  it('reaches the WRITER verifier by sys_id and by spec (refuses this bare fake client)', async () => {
    // verifyFlow is implemented (WRITER): the first thing it does is check the client surface, so the
    // query-only fake used here is refused — proof that every guard in front of it passed.
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_verify', { instance: 'product', flow_sys_id: '0123456789abcdef0123456789abcdef' }))).toBe('FLOW_BUILDER_CLIENT_UNSUPPORTED');
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_verify', { instance: 'product', spec: SPEC }))).toBe('FLOW_BUILDER_CLIENT_UNSUPPORTED');
    expect(await codeOf(dispatchFlowBuilderAction(blockedClient, 'snow_flow_verify', { instance: 'blockeddev', flow_sys_id: '0123456789abcdef0123456789abcdef' }))).toBe('FLOW_BUILDER_INSTANCE_DENIED');
  });
});

describe('snow_flow_export_xml', () => {
  let root: string;
  beforeEach(() => { enable(); root = mkdtempSync(join(tmpdir(), 'fb-tool-export-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('validates format and confines the path before generating', async () => {
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_export_xml', { spec: SPEC, format: 'xml', out_path: 'a.xml' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_export_xml', { spec: SPEC, format: 'update_set', out_path: 'a.xml' }))).toBe('INVALID_REQUEST');
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_export_xml', { spec: SPEC, format: 'record_update', out_path: 'a.xml' }))).toBe('FLOW_BUILDER_EXPORT_ROOT_UNSET');
    process.env.FLOW_BUILDER_EXPORT_ROOT = root;
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_export_xml', { spec: SPEC, format: 'record_update', out_path: '../a.xml' }))).toBe('FLOW_BUILDER_EXPORT_OUTSIDE_ROOT');
    expect(await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_export_xml', { spec: SPEC, format: 'record_update', out_path: 'a.txt' }))).toBe('FLOW_BUILDER_EXPORT_NOT_XML');
  });

  it('with a confined path it writes exactly the named file inside the root and nothing else', async () => {
    process.env.FLOW_BUILDER_EXPORT_ROOT = root;
    const r = await dispatchFlowBuilderAction(productClient, 'snow_flow_export_xml', { spec: SPEC, format: 'update_set', update_set_name: 'TEST_X', out_path: 'flow.xml' });
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, 'flow.xml'))).toBe(true);
    expect(readdirSync(root)).toEqual(['flow.xml']);
    // record_update is the GENERATOR's emitter: whatever it does, no guard refuses a confined path
    const code = await codeOf(dispatchFlowBuilderAction(productClient, 'snow_flow_export_xml', { spec: SPEC, format: 'record_update', out_path: 'rec.xml' }));
    expect(code).not.toMatch(/^FLOW_BUILDER_EXPORT_|^INVALID_REQUEST$|^FLOW_BUILDER_NOT_ENABLED$/);
    expect(readdirSync(root).every(n => n === 'flow.xml' || n === 'rec.xml')).toBe(true);
  });
});

describe('decodeRowForReview', () => {
  it('decodes gzip+base64 blobs and parses label_cache, leaving other fields alone', () => {
    const values = { outputsToAssign: [], variables: [], decisionTableInputs: [], dynamicInputs: [], workflowInputs: [], inputs: [{ name: 'condition', value: '{{Created_1.current.urgency}}=1' }] };
    const row = { table: 'sys_hub_flow_logic_instance_v2', sys_id: '0123456789abcdef0123456789abcdef', fields: { order: 3, values: encodeValues(values), label_cache: '[{"name":"x"}]', name: 'If', active: true } };
    const out = decodeRowForReview(row);
    expect(out.fields.values).toEqual({ decoded: values });
    expect(out.fields.label_cache).toEqual([{ name: 'x' }]);
    expect(out.fields.order).toBe(3);
    expect(out.fields.name).toBe('If');
    expect(row.fields.values).toEqual(expect.stringMatching(/^H4sI/)); // not mutated
  });
});

describe('makeDictionaryPillTypeResolver', () => {
  it('follows super_class for inherited fields and reference for dotted walks, caching lookups', async () => {
    const calls: string[] = [];
    const client = {
      queryRecords: async ({ table, query }: { table: string; query: string }) => {
        calls.push(`${table}:${query}`);
        const dict: Record<string, { internal_type: string; reference: string }> = {
          'task:number': { internal_type: 'string', reference: '' },
          'task:caller_id': { internal_type: { value: 'reference' } as unknown as string, reference: { value: 'sys_user' } as unknown as string },
          'sys_user:email': { internal_type: 'email', reference: '' },
          'incident:urgency': { internal_type: 'integer', reference: '' },
        };
        if (table === 'sys_dictionary') {
          const m = /^name=(\w+)\^element=(\w+)$/.exec(query)!;
          const hit = dict[`${m[1]}:${m[2]}`];
          return hit ? { count: 1, records: [hit] } : { count: 0, records: [] };
        }
        if (table === 'sys_db_object') {
          const m = /^name=(\w+)$/.exec(query)!;
          return m[1] === 'incident' ? { count: 1, records: [{ 'super_class.name': 'task' }] } : { count: 0, records: [] };
        }
        return { count: 0, records: [] };
      },
    } as unknown as ServiceNowClient;
    const resolve = makeDictionaryPillTypeResolver(client);
    expect(await resolve('incident', 'urgency')).toBe('integer');
    expect(await resolve('incident', 'number')).toBe('string');          // inherited from task
    expect(await resolve('incident', 'caller_id.email')).toBe('email');   // dotted walk through the reference
    expect(await resolve('incident', 'nope')).toBeUndefined();
    const before = calls.length;
    expect(await resolve('incident', 'number')).toBe('string');
    expect(calls.length).toBe(before); // cached
  });
});
