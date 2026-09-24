/**
 * src/tools/flow-builder.ts with the WRITER filled in: the handlers of snow_flow_plan (live checks),
 * snow_flow_build (writer wiring, activation → isError), snow_flow_verify and snow_flow_export_xml
 * (update_set format) end to end against the in-memory fake client. generatePlan is mocked with the
 * sample plan (GENERATOR's module); the record_update emitter runs for real (the default loader transport
 * posts its output) and is stubbed once for the record_update export test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFakeClient, baseTables, callSignature, captureActivation } from '../writer/fake-client.js';
import { samplePlan, SAMPLE_IDS } from '../writer/sample-plan.js';
import { ServiceNowError } from '../../../src/utils/errors.js';

const H = vi.hoisted(() => ({ fake: undefined as undefined | ReturnType<typeof import('../writer/fake-client.js').makeFakeClient>, blocked: { __name: 'blockeddev' } }));

vi.mock('../../../src/servicenow/instances.js', () => ({
  instanceManager: {
    listAll: () => [
      { name: 'product', url: 'https://pdidemo01.service-now.com', group: 'PDI', environment: 'dev', active: false },
      { name: 'blockeddev', url: 'https://blockeddev.service-now.com', group: 'Blocked', environment: 'dev', active: true },
    ],
    getClient: (name?: string) => {
      if (name === 'product') return H.fake!.client;
      if (name === 'blockeddev') return H.blocked;
      throw new Error(`Unknown instance "${name}"`);
    },
    getCurrentName: () => 'blockeddev',
  },
}));

vi.mock('../../../src/flow-builder/generator/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/flow-builder/generator/index.js')>();
  return {
    ...mod,
    generatePlan: vi.fn(async (spec: { flow: { key: string; name: string; scope?: string } }) => samplePlan({ flowKey: spec.flow.key, name: spec.flow.name, scope: spec.flow.scope ?? 'global' })),
    readCatalog: vi.fn(() => [{ kind: 'action', name: 'log', sys_id: 'dbc1bcc6531003003bf1d9109ec587d2', inputs: [], outputs: [] }]),
  };
});

vi.mock('../../../src/flow-builder/xml/record-update.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/flow-builder/xml/record-update.js')>();
  return { ...mod, planToRecordUpdateXml: vi.fn(mod.planToRecordUpdateXml) };
});

import { dispatchFlowBuilderAction, runLiveChecks, TABLE_API_TRANSPORT_WARNING } from '../../../src/tools/flow-builder.js';
import { planToRecordUpdateXml } from '../../../src/flow-builder/xml/record-update.js';
import { LOADER_LOAD_PATH, LOADER_PREFERENCE_NOTE } from '../../../src/flow-builder/writer/loader.js';
import type { ServiceNowClient } from '../../../src/servicenow/client.js';
import { runInToolInvocationContext } from '../../../src/utils/invocation-context.js';
/** snow_flow_build only runs as a DIRECT MCP (stdio) call — tests enter that context explicitly. */
const mcpBuild = (c: ServiceNowClient, args: Record<string, unknown>) => runInToolInvocationContext({ channel: 'mcp', transport: 'stdio', tool: 'snow_flow_build' }, () => dispatchFlowBuilderAction(c, 'snow_flow_build', args));

import { parseSpec } from '../../../src/flow-builder/spec/schema.js';

const SPEC = {
  spec_version: '1',
  flow: { key: 'p1_log', name: 'P1 Log' },
  trigger: { key: 't', type: 'record.created', table: 'incident', condition: 'priority=1' },
  steps: [{ kind: 'action', key: 'log', action: 'log', inputs: { log_level: 'info', log_message: { text: 'P1 {{trigger.current.number}}' } } }],
};
const DEFS = {
  sys_db_object: [{ sys_id: '0'.repeat(32), name: 'incident' }],
  sys_hub_action_type_definition: [{ sys_id: 'dbc1bcc6531003003bf1d9109ec587d2', name: 'Log' }],
  sys_hub_flow_logic_definition: [{ sys_id: 'af4e1945c3e232002841b63b12d3ae3e', name: 'If' }],
};

const ENV_KEYS = ['FLOW_BUILDER_ENABLED', 'FLOW_BUILDER_ACTIVATE_ENABLED', 'WRITE_ENABLED', 'FLOW_BUILDER_ALLOWED_INSTANCES', 'FLOW_BUILDER_DENY_PATTERN', 'FLOW_BUILDER_EXPORT_ROOT'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FLOW_BUILDER_DENY_PATTERN = 'blocked'; // the locally configured deny list (no default in code)
  process.env.FLOW_BUILDER_ENABLED = 'true';
  process.env.FLOW_BUILDER_ALLOWED_INSTANCES = 'product';
  H.fake = makeFakeClient({ username: 'mcp.user', tables: { ...baseTables(), ...DEFS } });
});
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const client = () => H.fake!.client;
const build = (extra: Record<string, unknown> = {}) => mcpBuild(client(), { spec: SPEC, instance: 'product', update_set: { name: 'TEST_FLOW_TEST_V1' }, ...extra });
async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as { code?: string }).code ?? 'NO_CODE'; }
  return 'NO_THROW';
}
const writes = () => H.fake!.state.calls.filter(c => ['createRecord', 'updateRecord', 'deleteRecord', 'requestJson', 'postMultipart'].includes(c.method));

describe('snow_flow_catalog_read', () => {
  it('returns the catalogue entries', async () => {
    const r = await dispatchFlowBuilderAction(client(), 'snow_flow_catalog_read', {});
    expect(r.count).toBe(1);
    expect(r.entries[0].name).toBe('log');
  });
});

describe('snow_flow_build', () => {
  it('defaults to transport "loader": one multipart load of the plan XML, verified by read-back, no preference and no Table-API write', async () => {
    process.env.WRITE_ENABLED = 'true';
    const r = await build();
    const ids = SAMPLE_IDS();
    expect(r.transport).toBe('loader');
    expect(r.flowSysId).toBe(ids.flow);
    expect(r.instanceName).toBe('product');
    expect(r.rowCount).toBe(7);
    expect(r.preferences).toEqual([]);
    expect(r.preferencesNote).toBe(LOADER_PREFERENCE_NOTE);
    expect(r.flowState).toMatchObject({ version: '2', active: 'false', status: 'draft' });
    expect(r.capture).toMatchObject({ ok: true, mode: 'parent_row', found: 7 });
    expect(r.transport_warning).toBeUndefined();
    expect(writes().map(c => c.method)).toEqual(['postMultipart']);
    const [load] = writes();
    expect(load.path).toBe(`${LOADER_LOAD_PATH}/global`);
    expect(load.params).toEqual({ targetUpdateSetId: 'a'.repeat(32) });
    expect(load.files![0].content).toBe(planToRecordUpdateXml(samplePlan()));
    expect(H.fake!.state.calls.some(c => c.table === 'sys_user_preference' || c.table === 'sys_user')).toBe(false);
  });

  it('transport must be "loader" or "table_api" (checked before the instance is resolved)', async () => {
    process.env.WRITE_ENABLED = 'true';
    expect(await codeOf(build({ transport: 'import' }))).toBe('INVALID_REQUEST');
    expect(H.fake!.state.calls).toEqual([]);
  });

  it('loader error codes surface through the tool (endpoint absent, version not 2)', async () => {
    process.env.WRITE_ENABLED = 'true';
    H.fake = makeFakeClient({ username: 'mcp.user', tables: { ...baseTables(), ...DEFS }, loader: 'absent' });
    expect(await codeOf(build())).toBe('FLOW_BUILDER_LOADER_UNAVAILABLE');
    H.fake = makeFakeClient({ username: 'mcp.user', tables: { ...baseTables(), ...DEFS }, loader: 'version1' });
    expect(await codeOf(build())).toBe('FLOW_BUILDER_LOADER_VERSION_MISMATCH');
  });

  it('a table_api error keeps the transport warning in its details', async () => {
    process.env.WRITE_ENABLED = 'true';
    await build();
    H.fake!.table('sys_hub_flow').get(SAMPLE_IDS().flow)!.active = 'true';
    let err: ServiceNowError | undefined;
    try { await build({ transport: 'table_api', mode: 'update' }); } catch (e) { err = e as ServiceNowError; }
    expect(err?.code).toBe('FLOW_BUILDER_FLOW_ACTIVE');
    expect(err!.details).toMatchObject({ transport: 'table_api', transport_warning: TABLE_API_TRANSPORT_WARNING });
  });

  it('transport "table_api" (diagnostics): preference first, rows in order, capture verified, draft/inactive — and the version-1 warning', async () => {
    process.env.WRITE_ENABLED = 'true';
    const r = await build({ transport: 'table_api' });
    const ids = SAMPLE_IDS();
    expect(r.transport).toBe('table_api');
    expect(r.transport_warning).toBe(TABLE_API_TRANSPORT_WARNING);
    expect(r.transport_warning).toMatch(/stays version 1/);
    expect(r.warnings[0]).toBe(TABLE_API_TRANSPORT_WARNING);
    expect(r.summary).toMatch(/not usable by Flow Designer/);
    expect(H.fake!.state.calls.some(c => c.method === 'postMultipart')).toBe(false);
    expect(r.flowSysId).toBe(ids.flow);
    expect(r.instanceName).toBe('product');
    expect(r.rowCount).toBe(7);
    expect(r.written).toHaveLength(7);
    expect(r.capture.ok).toBe(true);
    expect(r.capture.mode).toBe('parent_row');
    expect(r.activation.requested).toBe(false);
    const sig = callSignature(H.fake!.state.calls);
    expect(sig.indexOf('createRecord:sys_user_preference')).toBeLessThan(sig.indexOf('createRecord:sys_hub_flow'));
    expect(sig.filter(s => s.startsWith('requestJson'))).toEqual([]);
    expect(H.fake!.table('sys_hub_flow').get(ids.flow)).toMatchObject({ active: 'false', status: 'draft', name: 'P1 Log' });
  });

  it('guards still fire in front of the writer (deny wins, allow list, write flag)', async () => {
    expect(await codeOf(build())).toBe('WRITE_NOT_ENABLED');
    process.env.WRITE_ENABLED = 'true';
    expect(await codeOf(mcpBuild(H.blocked as unknown as ServiceNowClient, { spec: SPEC, instance: 'blockeddev', update_set: { name: 'x' } }))).toBe('FLOW_BUILDER_INSTANCE_DENIED');
    delete process.env.FLOW_BUILDER_ALLOWED_INSTANCES;
    expect(await codeOf(build())).toBe('FLOW_BUILDER_ALLOW_LIST_UNSET');
    expect(writes()).toEqual([]);
  });

  it('refuses an is_default update set and a non-in-progress one before touching any flow row', async () => {
    process.env.WRITE_ENABLED = 'true';
    H.fake = makeFakeClient({ username: 'mcp.user', tables: { ...baseTables({ updateSet: { is_default: 'true' } }), ...DEFS } });
    expect(await codeOf(build())).toBe('FLOW_BUILDER_UPDATE_SET_IS_DEFAULT');
    expect(writes()).toEqual([]);
    H.fake = makeFakeClient({ username: 'mcp.user', tables: { ...baseTables({ updateSet: { state: 'complete' } }), ...DEFS } });
    expect(await codeOf(build())).toBe('FLOW_BUILDER_UPDATE_SET_NOT_IN_PROGRESS');
    expect(writes()).toEqual([]);
    expect(await codeOf(build({ transport: 'table_api' }))).toBe('FLOW_BUILDER_UPDATE_SET_NOT_IN_PROGRESS');
    expect(writes()).toEqual([]);
  });

  it("a second build in mode:'create' is refused; mode:'update' PATCHes", async () => {
    process.env.WRITE_ENABLED = 'true';
    await build();
    expect(await codeOf(build())).toBe('FLOW_BUILDER_ROWS_EXIST');
    const r = await build({ mode: 'update' });
    expect(r.written.every((w: { action: string }) => w.action === 'updated')).toBe(true);
  });

  it('activate:true with a failing / absent endpoint is an error that still carries the write result', async () => {
    process.env.WRITE_ENABLED = 'true';
    process.env.FLOW_BUILDER_ACTIVATE_ENABLED = 'true';
    let err: ServiceNowError | undefined;
    try { await build({ activate: true }); } catch (e) { err = e as ServiceNowError; }
    expect(err?.code).toBe('FLOW_BUILDER_ACTIVATION_FAILED');
    const d = err!.details as { written: unknown[]; activation: { attempted: boolean; http_status: number; ok: boolean; read_back: { active: string } } };
    expect(d.written).toHaveLength(7);
    expect(d.activation).toMatchObject({ attempted: true, http_status: 400, ok: false, read_back: { active: 'false' } });
    expect(err!.message).toContain('NOT active');
  });

  it('activate:true that succeeds returns normally with the read-back', async () => {
    process.env.WRITE_ENABLED = 'true';
    process.env.FLOW_BUILDER_ACTIVATE_ENABLED = 'true';
    H.fake = makeFakeClient({
      username: 'mcp.user', tables: { ...baseTables(), ...DEFS },
      onRequest: (_m, _p, body, state) => {
        const id = (body as { flows: { sys_id: string }[] }).flows[0].sys_id;
        const row = state.tables.get('sys_hub_flow')!.get(id)!;
        row.active = 'true'; row.status = 'published'; row.latest_snapshot = '5'.repeat(32);
        captureActivation(state, id, 'a'.repeat(32)); // the activation lands in the target set
        return { result: { summary: 'ok', results: [] } };
      },
    });
    const r = await build({ activate: true });
    expect(r.activation).toMatchObject({ ok: true, http_status: 200, read_back: { active: 'true', status: 'published' } });
    expect(r.activation.capture_after.ok).toBe(true);
    expect(r.activationCapture).toMatchObject({ ok: true, parentChanged: true, activeInPayload: true, leaks: [] });
  });

  it('activate:true without FLOW_BUILDER_ACTIVATE_ENABLED never reaches the writer', async () => {
    process.env.WRITE_ENABLED = 'true';
    expect(await codeOf(build({ activate: true }))).toBe('FLOW_BUILDER_ACTIVATE_NOT_ENABLED');
    expect(writes()).toEqual([]);
  });
});

describe('snow_flow_plan — live checks (read-only)', () => {
  it('without an instance: no live checks, ok, no client call', async () => {
    const r = await dispatchFlowBuilderAction(client(), 'snow_flow_plan', { spec: SPEC });
    expect(r.ok).toBe(true);
    expect(r.live).toBe(false);
    expect(r.liveChecks).toBeUndefined();
    expect(r.captureProtocol.length).toBeGreaterThan(5);
    expect(H.fake!.state.calls).toEqual([]);
  });

  it('captureProtocol describes the loader path by default and the preference path only for transport "table_api"', async () => {
    const r = await dispatchFlowBuilderAction(client(), 'snow_flow_plan', { spec: SPEC, update_set: { name: 'TEST_X' } });
    expect(r.transport).toBe('loader');
    const text = r.captureProtocol.join('\n');
    expect(text).toContain(`${LOADER_LOAD_PATH}/<scopeId>?targetUpdateSetId=`);
    expect(text).toContain('No sys_user_preference is read or written');
    expect(text).not.toContain('Upsert sys_user_preference');
    expect(r.transport_warning).toBeUndefined();

    const t = await dispatchFlowBuilderAction(client(), 'snow_flow_plan', { spec: SPEC, transport: 'table_api' });
    expect(t.transport).toBe('table_api');
    expect(t.captureProtocol.join('\n')).toContain('Upsert sys_user_preference');
    expect(t.transport_warning).toBe(TABLE_API_TRANSPORT_WARNING);
    expect(H.fake!.state.calls).toEqual([]);
  });

  it('with an instance: checks tables and the planned flow, reports problems, never writes', async () => {
    const r = await dispatchFlowBuilderAction(client(), 'snow_flow_plan', { spec: SPEC, instance: 'product' });
    expect(r.live).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.liveChecks.tables).toEqual([{ table: 'incident', where: 'trigger.table', exists: true }]);
    expect(r.liveChecks.flow).toEqual({ sys_id: SAMPLE_IDS().flow, exists: false });
    expect(r.liveChecks.problems).toEqual([]);
    expect(writes()).toEqual([]);
    expect(r.writes).toContain('dry run');

    // a table that does not exist → problem, ok:false
    const spec2 = { ...SPEC, flow: { key: 'k2', name: 'K2' }, trigger: { ...SPEC.trigger, table: 'u_nope' } };
    const r2 = await dispatchFlowBuilderAction(client(), 'snow_flow_plan', { spec: spec2, instance: 'product' });
    expect(r2.ok).toBe(false);
    expect(r2.liveChecks.problems[0]).toContain('u_nope');
  });

  it('after a build, plan reports the existing flow (mode update needed) and STALE rows; same-name flows too', async () => {
    process.env.WRITE_ENABLED = 'true';
    await build();
    const ids = SAMPLE_IDS();
    H.fake!.table('sys_hub_action_instance_v2').set('5'.repeat(32), { sys_id: '5'.repeat(32), flow: ids.flow, order: '9' });
    H.fake!.table('sys_hub_flow').set('c'.repeat(32), { sys_id: 'c'.repeat(32), name: 'P1 Log' });
    H.fake!.state.calls.length = 0;
    const r = await dispatchFlowBuilderAction(client(), 'snow_flow_plan', { spec: SPEC, instance: 'product', update_set: { name: 'TEST_FLOW_TEST_V1' } });
    expect(r.ok).toBe(false);
    expect(r.liveChecks.flow).toMatchObject({ exists: true, name: 'P1 Log', active: 'false', status: 'draft' });
    expect(r.liveChecks.stale).toEqual([{ table: 'sys_hub_action_instance_v2', sys_id: '5'.repeat(32) }]);
    expect(r.liveChecks.sameName).toEqual([{ sys_id: 'c'.repeat(32), name: 'P1 Log' }]);
    expect(r.liveChecks.problems.some((p: string) => p.includes("mode:'update'"))).toBe(true);
    expect(r.captureProtocol[0]).toContain('TEST_FLOW_TEST_V1');
    expect(writes()).toEqual([]);
  });

  it('runLiveChecks checks {reference,table} values, static pills and {sys_id} definition refs', async () => {
    const parsed = parseSpec({
      spec_version: '1', flow: { key: 'refs', name: 'Refs' },
      trigger: { key: 't', type: 'record.created', table: 'incident' },
      steps: [
        { kind: 'action', key: 'a', action: 'createRecord', inputs: { table: 'incident', fields: { template: { assignment_group: { reference: '1'.repeat(32), table: 'sys_user_group' } } } } },
        { kind: 'action', key: 'b', action: 'log', inputs: { log_message: { text: 'x {{static.' + '2'.repeat(32) + '}}' } } },
        { kind: 'subflow', key: 's', subflow: { sys_id: '3'.repeat(32) } },
      ],
    });
    if ('errors' in parsed) throw new Error(JSON.stringify(parsed.errors));
    H.fake!.table('sys_user_group').set('1'.repeat(32), { sys_id: '1'.repeat(32), name: 'Service Desk' });
    const plan = samplePlan({ flowKey: 'refs', name: 'Refs' });
    const r = await runLiveChecks(client(), parsed.spec, plan);
    expect(r.tables.map(t => t.table).sort()).toEqual(['incident']);
    expect(r.references).toEqual(expect.arrayContaining([
      { table: 'sys_user_group', sys_id: '1'.repeat(32), where: expect.stringContaining('assignment_group'), exists: true },
      { table: '', sys_id: '2'.repeat(32), where: expect.stringContaining('log_message'), exists: 'unknown_table' },
      { table: 'sys_hub_flow', sys_id: '3'.repeat(32), where: expect.stringContaining('subflow'), exists: false },
    ]));
    expect(r.problems).toEqual([expect.stringContaining(`sys_hub_flow ${'3'.repeat(32)}`)]);
    expect(writes()).toEqual([]);
  });

  it('runLiveChecks takes the table of a bare {reference} / sys_id from the action input (a remote-table reference tries its real tables)', async () => {
    const ITEM = '6'.repeat(32), SET = '7'.repeat(32), MISSING = '8'.repeat(32);
    const parsed = parseSpec({
      spec_version: '1', flow: { key: 'cat', name: 'Cat' },
      trigger: { key: 't', type: 'catalog.service_catalog' },
      steps: [
        { kind: 'action', key: 'task', action: 'createCatalogTask', inputs: { ah_requested_item: { pill: 'trigger.request_item' }, ah_short_description: 'x', template_catalog_item: { reference: ITEM } } },
        { kind: 'action', key: 'vars', action: 'getCatalogVariables', inputs: { requested_item: { pill: 'trigger.request_item' }, template_catalog_item: SET } },
        { kind: 'action', key: 'vars2', action: 'getCatalogVariables', inputs: { requested_item: { pill: 'trigger.request_item' }, template_catalog_item: { reference: MISSING } } },
      ],
    });
    if ('errors' in parsed) throw new Error(JSON.stringify(parsed.errors));
    H.fake!.table('sc_cat_item').set(ITEM, { sys_id: ITEM, name: 'Example Item' });
    H.fake!.table('item_option_new_set').set(SET, { sys_id: SET, title: 'Example Set' });
    const r = await runLiveChecks(client(), parsed.spec, samplePlan({ flowKey: 'cat', name: 'Cat' }));
    expect(r.references).toEqual([
      { table: 'sc_cat_item', sys_id: ITEM, where: expect.stringContaining('template_catalog_item'), exists: true },
      { table: 'item_option_new_set', sys_id: SET, where: expect.stringContaining('template_catalog_item'), exists: true },
      { table: 'sc_cat_item / item_option_new_set', sys_id: MISSING, where: expect.stringContaining('template_catalog_item'), exists: false },
    ]);
    expect(r.problems).toEqual([expect.stringContaining(`sc_cat_item / item_option_new_set ${MISSING}`)]);
    expect(writes()).toEqual([]);
  });
});

describe('snow_flow_verify', () => {
  it('reads back by spec after a build (ok) and by sys_id for an unknown flow (not found)', async () => {
    process.env.WRITE_ENABLED = 'true';
    await build();
    H.fake!.state.calls.length = 0;
    const r = await dispatchFlowBuilderAction(client(), 'snow_flow_verify', { instance: 'product', spec: SPEC });
    expect(r.ok).toBe(true);
    expect(r.instanceName).toBe('product');
    expect(r.diffs).toEqual([]);
    expect(r.instances.map((i: { name: string }) => i.name)).toEqual(['If', 'Log']);
    expect(writes()).toEqual([]);
    const r2 = await dispatchFlowBuilderAction(client(), 'snow_flow_verify', { instance: 'product', flow_sys_id: 'f'.repeat(32) });
    expect(r2.found).toBe(false);
  });
});

describe('snow_flow_export_xml', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fb-writer-export-')); process.env.FLOW_BUILDER_EXPORT_ROOT = root; });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes the Retrieved Update Set file (one Flow record) under the export root, never contacting an instance', async () => {
    const r = await dispatchFlowBuilderAction(client(), 'snow_flow_export_xml', { spec: SPEC, format: 'update_set', update_set_name: 'TEST_P1_LOG_V1', description: 'd', out_path: 'p1.xml' });
    expect(r.ok).toBe(true);
    expect(realpathSync.native(r.path).toLowerCase()).toBe(realpathSync.native(join(root, 'p1.xml')).toLowerCase());
    expect(r.flowSysId).toBe(SAMPLE_IDS().flow);
    expect(r.rowCount).toBe(7);
    const xml = readFileSync(r.path, 'utf8');
    expect(xml).toContain('<unload unload_date=');
    expect(xml).toContain('<name>TEST_P1_LOG_V1</name>');
    expect(xml).toContain('<description>d</description>');
    expect(xml).toContain(`<name>sys_hub_flow_${SAMPLE_IDS().flow}</name>`);
    expect(xml).toContain('<type>Flow</type>');
    expect(xml.match(/<sys_update_xml action/g)).toHaveLength(1);
    expect(r.bytes).toBe(Buffer.byteLength(xml, 'utf8'));
    expect(H.fake!.state.calls).toEqual([]);
  });

  it('writes the record_update format through the GENERATOR emitter', async () => {
    vi.mocked(planToRecordUpdateXml).mockReturnValueOnce('<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_hub_flow"/>');
    const r = await dispatchFlowBuilderAction(client(), 'snow_flow_export_xml', { spec: SPEC, format: 'record_update', out_path: 'ru.xml' });
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toContain('<record_update table="sys_hub_flow"/>');
  });
});
