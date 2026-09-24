/**
 * Tool-layer wiring of the instance resolvers (src/tools/flow-builder.ts → src/flow-builder/resolvers.ts):
 * snow_flow_plan with an instance, snow_flow_build and snow_flow_verify resolve subflows / custom actions /
 * action types through read-only queries; offline plan and export keep the catalogue values and say so.
 * Everything runs on the in-memory fake client — no instance is contacted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFakeClient, baseTables, parseRecordUpdate, type Row } from '../writer/fake-client.js';

const H = vi.hoisted(() => ({ fake: undefined as undefined | { client: unknown } }));

vi.mock('../../../src/servicenow/instances.js', () => ({
  instanceManager: {
    listAll: () => [
      { name: 'otherdev', url: 'https://otherdev.example.test', group: 'Dev', environment: 'dev', active: false },
      { name: 'blockeddev', url: 'https://blockeddev.example.test', group: 'Blocked', environment: 'dev', active: true },
    ],
    // blockeddev also hands out the fake: were a guard skipped, its reads would land in the fake's call log
    getClient: (name?: string) => {
      if ((name === 'otherdev' || name === 'blockeddev') && H.fake) return H.fake.client;
      throw new Error(`Unknown instance "${name}"`);
    },
    getCurrentName: () => 'blockeddev',
  },
}));

import { dispatchFlowBuilderAction, offlineActionTypeWarning } from '../../../src/tools/flow-builder.js';
import { clearActionTypeCache } from '../../../src/flow-builder/resolvers.js';
import { findAction, actionTypeIds } from '../../../src/flow-builder/catalog/actions.js';
import { decodeValues } from '../../../src/flow-builder/encode.js';
import { runInToolInvocationContext } from '../../../src/utils/invocation-context.js';
import type { ServiceNowClient } from '../../../src/servicenow/client.js';

const SUB = '5ab0000000000000000000000000000a';
const LOG = actionTypeIds(findAction('log')!);
const LATEST = '1a70000000000000000000000000000f';

/** The instance side: a subflow with typed inputs, the Log definition whose catalogue snapshot is absent (latest exists). */
function instanceTables(): Record<string, Row[]> {
  return {
    sys_db_object: [{ sys_id: '1'.repeat(32), name: 'incident', 'super_class.name': '' }],
    sys_dictionary: [{ sys_id: '2'.repeat(32), name: 'incident', element: 'number', internal_type: 'string', reference: '' }],
    sys_hub_flow: [{ sys_id: SUB, name: 'Example Notify', internal_name: 'example_notify', type: 'subflow', 'sys_scope.scope': 'global' }],
    sys_hub_flow_input: [
      { sys_id: '3'.repeat(32), model: SUB, element: 'message', label: 'Message', internal_type: 'string', mandatory: 'true', order: '1', default_value: '', reference: '' },
      { sys_id: '4'.repeat(32), model: SUB, element: 'attempts', label: 'Attempts', internal_type: 'integer', mandatory: 'false', order: '2', default_value: '', reference: '' },
    ],
    sys_hub_flow_output: [{ sys_id: '5'.repeat(32), model: SUB, element: 'ok', label: 'Ok', internal_type: 'boolean', mandatory: 'false', order: '1', default_value: '', reference: '' }],
    sys_hub_action_type_snapshot: [{ sys_id: LATEST, name: 'Log', parent_action: LOG.definition }],
    sys_hub_action_type_definition: [{ sys_id: LOG.definition, name: 'Log', latest_snapshot: LATEST }],
  };
}

const spec = (subflow: object, inputs: Record<string, unknown> = { message: 'hello', attempts: 2 }) => ({
  spec_version: '1',
  flow: { key: 'wiring', name: 'Wiring Test' },
  trigger: { key: 't', type: 'record.created', table: 'incident' },
  steps: [
    { kind: 'action', key: 'log', action: 'log', inputs: { log_level: 'info', log_message: { text: 'N {{trigger.current.number}}' } } },
    { kind: 'subflow', key: 'notify', subflow, inputs },
  ],
});

const ENV_KEYS = ['FLOW_BUILDER_ENABLED', 'FLOW_BUILDER_ACTIVATE_ENABLED', 'WRITE_ENABLED', 'FLOW_BUILDER_ALLOWED_INSTANCES', 'FLOW_BUILDER_DENY_PATTERN', 'FLOW_BUILDER_EXPORT_ROOT'];
let saved: Record<string, string | undefined>;
let exportRoot: string;
beforeAll(() => { exportRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-builder-wiring-'))); });
afterAll(() => { rmSync(exportRoot, { recursive: true, force: true }); });
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FLOW_BUILDER_ENABLED = 'true';
  process.env.WRITE_ENABLED = 'true';
  process.env.FLOW_BUILDER_ALLOWED_INSTANCES = 'otherdev';
  process.env.FLOW_BUILDER_DENY_PATTERN = 'blocked';
  process.env.FLOW_BUILDER_EXPORT_ROOT = exportRoot;
  clearActionTypeCache();
});
afterEach(() => {
  H.fake = undefined;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function newFake(extra: Record<string, Row[]> = {}) {
  const f = makeFakeClient({ username: 'flow.builder.test', tables: { ...baseTables(), ...instanceTables(), ...extra } });
  H.fake = f;
  return f;
}
const client = (f: ReturnType<typeof newFake>) => f.client as unknown as ServiceNowClient;
const call = (f: ReturnType<typeof newFake>, name: string, args: Record<string, unknown>) =>
  runInToolInvocationContext({ channel: 'mcp', transport: 'stdio', tool: name }, () => dispatchFlowBuilderAction(client(f), name, args));
const reads = (f: ReturnType<typeof newFake>, table: string) => f.state.calls.filter(c => c.table === table);
const writes = (f: ReturnType<typeof newFake>) => f.state.calls.filter(c => !['queryRecords', 'getRecord'].includes(c.method));
async function codeAndErrors(p: Promise<unknown>): Promise<{ code: string; errors: string }> {
  try { await p; } catch (e) {
    const err = e as { code?: string; details?: { errors?: unknown[] } };
    return { code: err.code ?? 'NO_CODE', errors: JSON.stringify(err.details?.errors ?? []) };
  }
  return { code: 'NO_THROW', errors: '' };
}

describe('snow_flow_plan', () => {
  it('with an instance: subflow by name resolved with typed inputs, action type from the instance, no offline warning', async () => {
    const f = newFake();
    const r = await call(f, 'snow_flow_plan', { spec: spec({ name: 'Example Notify' }), instance: 'otherdev' });
    expect(r.ok).toBe(true);
    expect(r.live).toBe(true);
    const sub = r.plan.instances.find((x: { table: string }) => x.table === 'sys_hub_sub_flow_instance_v2');
    expect(sub.fields.subflow).toBe(SUB);
    expect(sub.fields.subflow_inputs.decoded.map((e: { name: string; parameter: { type: string } }) => [e.name, e.parameter.type])).toEqual([['message', 'string'], ['attempts', 'integer']]);
    const act = r.plan.instances.find((x: { table: string }) => x.table === 'sys_hub_action_instance_v2');
    expect(act.fields).toMatchObject({ action_type: LATEST, action_type_parent: LOG.definition });
    expect(r.plan.warnings).not.toContain(offlineActionTypeWarning('plan'));
    expect(r.plan.warnings.some((w: string) => /latest_snapshot/.test(w))).toBe(true);
    expect(reads(f, 'sys_hub_action_type_snapshot').length).toBeGreaterThan(0);
    expect(reads(f, 'sys_hub_flow_input').map(c => c.query)).toContain(`model=${SUB}`);
    expect(writes(f)).toEqual([]);
  });

  it('with an instance: a missing subflow is REPORTED by the dry run (ok:false, stage "generate", errors + warnings) — not thrown', async () => {
    const f = newFake();
    const r = await call(f, 'snow_flow_plan', { spec: spec({ name: 'Missing Subflow' }), instance: 'otherdev' });
    expect(r).toMatchObject({ ok: false, stage: 'generate', instance: 'otherdev', live: true });
    expect(r.errors.join('\n')).toMatch(/step "notify": subflow "Missing Subflow" was not found on the instance/);
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(r.warnings.some((w: string) => /latest_snapshot/.test(w))).toBe(true); // the rest of the generation still reports
    expect(r.writes).toMatch(/^none/);
    expect(writes(f)).toEqual([]);
  });

  it('with an instance: an ambiguous subflow is reported the same way', async () => {
    const f = newFake({ sys_hub_flow: [
      { sys_id: SUB, name: 'Example Notify', internal_name: 'example_notify', type: 'subflow', 'sys_scope.scope': 'global' },
      { sys_id: '5ab0000000000000000000000000000b', name: 'Example Notify', internal_name: 'example_notify_2', type: 'subflow', 'sys_scope.scope': 'x_example_app' },
    ] });
    const r = await call(f, 'snow_flow_plan', { spec: spec({ name: 'Example Notify' }), instance: 'otherdev' });
    expect(r).toMatchObject({ ok: false, stage: 'generate' });
    expect(r.errors.join('\n')).toMatch(/is ambiguous — 2 match/);
  });

  it('offline (no instance, or live:false): catalogue ids kept, said in warnings, no instance read', async () => {
    for (const extra of [{}, { instance: 'otherdev', live: false }]) {
      const f = newFake();
      const r = await call(f, 'snow_flow_plan', { spec: spec({ sys_id: SUB }), ...extra });
      expect(r.live).toBe(false);
      const act = r.plan.instances.find((x: { table: string }) => x.table === 'sys_hub_action_instance_v2');
      expect(act.fields).toMatchObject({ action_type: LOG.snapshot, action_type_parent: LOG.definition });
      expect(r.plan.warnings).toContain(offlineActionTypeWarning('plan'));
      expect(r.plan.warnings.some((w: string) => /step "notify": subflow .* not resolved — input types are inferred/.test(w))).toBe(true);
      expect(f.state.calls).toEqual([]);
    }
  });

  it('offline: a subflow referenced by name still needs an instance — reported as ok:false, stage "generate"', async () => {
    const f = newFake();
    const r = await call(f, 'snow_flow_plan', { spec: spec({ name: 'Example Notify' }) });
    expect(r).toMatchObject({ ok: false, stage: 'generate', live: false });
    expect(r.errors.join('\n')).toMatch(/needs an instance to resolve the sys_id/);
    expect(f.state.calls).toEqual([]);
  });

  it('a parse error keeps its own stage (control)', async () => {
    const r = await call(newFake(), 'snow_flow_plan', { spec: { spec_version: '1' } });
    expect(r).toMatchObject({ ok: false, stage: 'parse' });
  });

  it('offline: no catalogue action step → no action-type warning', async () => {
    const f = newFake();
    const s = spec({ sys_id: SUB });
    s.steps = s.steps.filter(x => x.kind !== 'action');
    const r = await call(f, 'snow_flow_plan', { spec: s });
    expect(r.plan.warnings).not.toContain(offlineActionTypeWarning('plan'));
  });
});

describe('snow_flow_build', () => {
  it('resolves before writing: the loaded document carries the instance subflow types and action ids; the action-type cache spares the second build', async () => {
    const f = newFake();
    const r = await call(f, 'snow_flow_build', { spec: spec({ name: 'example_notify' }), instance: 'otherdev', update_set: { sys_id: 'a'.repeat(32) } });
    expect(r.transport).toBe('loader');
    const [load] = f.state.calls.filter(c => c.method === 'postMultipart');
    const rows = parseRecordUpdate(load.files![0].content).filter(e => e.kind === 'row') as { table: string; fields: Row }[];
    const sub = rows.find(x => x.table === 'sys_hub_sub_flow_instance_v2')!;
    expect(sub.fields.subflow).toBe(SUB);
    expect((decodeValues(sub.fields.subflow_inputs) as { name: string; parameter: { type: string } }[]).map(e => e.parameter.type)).toEqual(['string', 'integer']);
    expect(rows.find(x => x.table === 'sys_hub_action_instance_v2')!.fields).toMatchObject({ action_type: LATEST, action_type_parent: LOG.definition });
    expect(r.warnings.some((w: string) => /latest_snapshot/.test(w))).toBe(true);
    // every resolver read happened before the load
    const loadAt = f.state.calls.indexOf(load);
    for (const t of ['sys_hub_flow_input', 'sys_hub_action_type_snapshot']) expect(f.state.calls.findIndex(c => c.table === t)).toBeLessThan(loadAt);

    const before = reads(f, 'sys_hub_action_type_snapshot').length;
    await call(f, 'snow_flow_build', { spec: spec({ name: 'example_notify' }), instance: 'otherdev', update_set: { sys_id: 'a'.repeat(32) }, mode: 'update' });
    expect(reads(f, 'sys_hub_action_type_snapshot').length).toBe(before);
  });

  it('a missing mandatory subflow input or an ambiguous subflow refuses the build before any write', async () => {
    const f = newFake({ sys_hub_flow: [
      { sys_id: SUB, name: 'Example Notify', internal_name: 'example_notify', type: 'subflow', 'sys_scope.scope': 'global' },
      { sys_id: '5ab0000000000000000000000000000b', name: 'Example Notify', internal_name: 'example_notify_2', type: 'subflow', 'sys_scope.scope': 'x_example_app' },
    ] });
    const amb = await codeAndErrors(call(f, 'snow_flow_build', { spec: spec({ name: 'Example Notify' }), instance: 'otherdev', update_set: { sys_id: 'a'.repeat(32) } }));
    expect(amb.code).toBe('FLOW_BUILDER_INVALID_SPEC');
    expect(amb.errors).toMatch(/is ambiguous — 2 match/);
    const mand = await codeAndErrors(call(f, 'snow_flow_build', { spec: spec({ sys_id: SUB }, { attempts: 1 }), instance: 'otherdev', update_set: { sys_id: 'a'.repeat(32) } }));
    expect(mand.code).toBe('FLOW_BUILDER_INVALID_SPEC');
    expect(mand.errors).toMatch(/mandatory input \\"message\\" of \\"Example Notify\\" is missing/);
    expect(writes(f)).toEqual([]);
  });
});

describe('snow_flow_verify / snow_flow_export_xml', () => {
  it('verify with a spec resolves the subflow on the instance (read-only)', async () => {
    const f = newFake();
    const r = await call(f, 'snow_flow_verify', { spec: spec({ name: 'Example Notify' }), instance: 'otherdev' });
    expect(r.found).toBe(false); // nothing built — but generation resolved the name instead of failing
    expect(reads(f, 'sys_hub_flow').some(c => c.query === 'type=subflow^name=Example Notify')).toBe(true);
    expect(writes(f)).toEqual([]);
  });

  it('verify with a spec whose subflow was deleted after the build: the flow is still read back (no diff), ok:false, spec_errors', async () => {
    const f = newFake();
    const built = await call(f, 'snow_flow_build', { spec: spec({ name: 'Example Notify' }), instance: 'otherdev', update_set: { sys_id: 'a'.repeat(32) } });
    f.table('sys_hub_flow').delete(SUB); // the called subflow disappears from the instance
    const writesBefore = writes(f).length;
    const r = await call(f, 'snow_flow_verify', { spec: spec({ name: 'Example Notify' }), instance: 'otherdev' });
    expect(r).toMatchObject({ ok: false, planned: false, found: true, flowSysId: built.flowSysId, instanceName: 'otherdev' });
    expect(r.spec_errors.join('\n')).toMatch(/step "notify": subflow "Example Notify" was not found on the instance/);
    expect(Array.isArray(r.spec_warnings)).toBe(true);
    expect(r.spec_note).toMatch(/WITHOUT a plan diff/);
    expect(r.instances.length).toBeGreaterThan(0); // the read-back itself ran
    expect(writes(f).length).toBe(writesBefore); // read-only
  });

  it('verify: an error that is not a spec error still propagates', async () => {
    const f = newFake();
    f.fns.queryRecords.mockImplementation(async () => { throw Object.assign(new Error('ACL refused'), { code: 'INSUFFICIENT_PRIVILEGES' }); });
    const r = await codeAndErrors(call(f, 'snow_flow_verify', { spec: spec({ name: 'Example Notify' }), instance: 'otherdev' }));
    expect(r.code).toBe('INSUFFICIENT_PRIVILEGES');
  });

  it('export is offline: catalogue ids, the offline warning, no instance call', async () => {
    const f = newFake();
    const r = await call(f, 'snow_flow_export_xml', { spec: spec({ sys_id: SUB }), format: 'record_update', out_path: 'wiring.xml' });
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain(offlineActionTypeWarning('export'));
    expect(f.state.calls).toEqual([]);
  });
});

// ─── guard before any resolver read ──────────────────────────────────────────

describe('the instance guard runs before ANY resolver read', () => {
  const CA = 'ca70000000000000000000000000000a';
  /** Every resolver-backed step kind: a catalogue action, a subflow by NAME and a custom action by sys_id. */
  const richSpec = () => ({
    spec_version: '1',
    flow: { key: 'guarded', name: 'Guarded' },
    trigger: { key: 't', type: 'record.created', table: 'incident' },
    steps: [
      { kind: 'action', key: 'log', action: 'log', inputs: { log_level: 'info', log_message: 'x' } },
      { kind: 'subflow', key: 'notify', subflow: { name: 'Example Notify' }, inputs: { message: 'hello' } },
      { kind: 'custom_action', key: 'close', definition: { sys_id: CA }, inputs: { note: 'done' } },
    ],
  });
  const richFake = () => newFake({
    sys_hub_action_type_definition: [
      { sys_id: LOG.definition, name: 'Log', latest_snapshot: LATEST },
      { sys_id: CA, name: 'Example Close', internal_name: 'example_close', 'sys_scope.scope': 'global' },
    ],
    sys_hub_action_input: [{ sys_id: '6'.repeat(32), model: CA, element: 'note', label: 'Note', internal_type: 'string', mandatory: 'false', order: '1', default_value: '', reference: '' }],
  });
  const queries = (f: ReturnType<typeof newFake>) => f.state.calls.filter(c => c.method === 'queryRecords' || c.method === 'getRecord');
  const build = { update_set: { sys_id: 'a'.repeat(32) } };

  it('control: on the allowed instance the same spec does read (subflow, custom action, action type)', async () => {
    const f = richFake();
    const r = await call(f, 'snow_flow_plan', { spec: richSpec(), instance: 'otherdev' });
    expect(r.live).toBe(true);
    expect(r.stage).toBeUndefined();
    for (const t of ['sys_hub_flow', 'sys_hub_action_type_definition', 'sys_hub_action_type_snapshot']) expect(reads(f, t).length, t).toBeGreaterThan(0);
  });

  it('denied instance (blockeddev matches the deny pattern): plan / build / verify refuse with ZERO reads', async () => {
    for (const [tool, extra] of [['snow_flow_plan', {}], ['snow_flow_build', build], ['snow_flow_verify', {}]] as const) {
      const f = richFake();
      const r = await codeAndErrors(call(f, tool, { spec: richSpec(), instance: 'blockeddev', ...extra }));
      expect(r.code, tool).toBe('FLOW_BUILDER_INSTANCE_DENIED');
      expect(queries(f), tool).toEqual([]);
      expect(writes(f), tool).toEqual([]);
    }
  });

  it('allow list unset: plan / build / verify refuse with ZERO reads', async () => {
    for (const [tool, extra] of [['snow_flow_plan', {}], ['snow_flow_build', build], ['snow_flow_verify', {}]] as const) {
      delete process.env.FLOW_BUILDER_ALLOWED_INSTANCES;
      const f = richFake();
      const r = await codeAndErrors(call(f, tool, { spec: richSpec(), instance: 'otherdev', ...extra }));
      expect(r.code, tool).toBe('FLOW_BUILDER_ALLOW_LIST_UNSET');
      expect(queries(f), tool).toEqual([]);
    }
  });

  it('live:false on an allowed instance: an offline result (the by-name subflow reported, not resolved) with ZERO reads', async () => {
    const f = richFake();
    const r = await call(f, 'snow_flow_plan', { spec: richSpec(), instance: 'otherdev', live: false });
    expect(r).toMatchObject({ ok: false, stage: 'generate', live: false, instance: 'otherdev' });
    expect(r.errors.join('\n')).toMatch(/step "notify": subflow by name .* needs an instance to resolve the sys_id/);
    expect(f.state.calls).toEqual([]);

    // and with the subflow referenced by sys_id the offline plan succeeds — still without a single read
    const s = richSpec();
    (s.steps[1] as { subflow: object }).subflow = { sys_id: SUB };
    const g = richFake();
    const ok = await call(g, 'snow_flow_plan', { spec: s, instance: 'otherdev', live: false });
    expect(ok.live).toBe(false);
    expect(ok.plan.warnings).toContain(offlineActionTypeWarning('plan'));
    expect(g.state.calls).toEqual([]);
  });
});
