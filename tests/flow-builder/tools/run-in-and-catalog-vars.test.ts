/**
 * Tool-layer wiring of the two live findings (src/tools/flow-builder.ts → src/flow-builder/resolvers.ts), on the
 * in-memory fake client — no instance is contacted:
 *
 *   A) scheduled.run_once run_in is read by the platform in the instance time zone (glide.sys.default.tz, or the
 *      authenticated user's sys_user.time_zone when set): an ISO-8601 run_in is converted with that zone on a live
 *      plan / build; a run_in not in the future is warned about (plan) and refused (build, FLOW_BUILDER_RUN_IN_PAST)
 *      unless allow_past_run:true; offline plan / export refuse an ISO run_in.
 *   B) Get Catalog Variables outputs are the template item's variables (item_option_new + variable sets), typed from
 *      the question type on a live plan / build / verify; an unknown name is a spec error; offline = string + warning.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFakeClient, baseTables, parseRecordUpdate, TEST_NOW, type Row } from '../writer/fake-client.js';

const H = vi.hoisted(() => ({ fake: undefined as undefined | { client: unknown } }));

vi.mock('../../../src/servicenow/instances.js', () => ({
  instanceManager: {
    listAll: () => [{ name: 'otherdev', url: 'https://otherdev.example.test', group: 'Dev', environment: 'dev', active: false }],
    getClient: (name?: string) => {
      if (name === 'otherdev' && H.fake) return H.fake.client;
      throw new Error(`Unknown instance "${name}"`);
    },
    getCurrentName: () => 'otherdev',
  },
}));

import { dispatchFlowBuilderAction, PAST_RUN_NOTE } from '../../../src/tools/flow-builder.js';
import { clearActionTypeCache } from '../../../src/flow-builder/resolvers.js';
import { decodeValues } from '../../../src/flow-builder/encode.js';
import { runInToolInvocationContext } from '../../../src/utils/invocation-context.js';
import type { ServiceNowClient } from '../../../src/servicenow/client.js';

const USER = 'd'.repeat(32);
const ITEM = 'c0000000000000000000000000000001';
const SET = 'c0000000000000000000000000000002';
const MRVS = 'c0000000000000000000000000000003';
const vid = (n: number) => `f${String(n).padStart(31, '0')}`;

/** A catalog item with one variable per question type + a single-row and a multi-row variable set. */
function catalogTables(): Record<string, Row[]> {
  const v = (n: number, name: string, type: string, extra: Partial<Row> = {}): Row => ({
    sys_id: vid(n), name, question_text: name, type, reference: '', order: String(n * 100), cat_item: ITEM, variable_set: '', active: 'true', ...extra,
  });
  return {
    sc_cat_item: [{ sys_id: ITEM, name: 'Example Laptop' }],
    item_option_new: [
      v(1, 'short_name', '6'), v(2, 'notes', '2'), v(3, 'laptop_type', '5'), v(4, 'size', '3'), v(5, 'urgent', '7'),
      v(6, 'requested_for', '8', { reference: 'sys_user' }), v(7, 'needed_by', '9'), v(8, 'deliver_at', '10'),
      v(9, 'wide_text', '16'), v(10, 'watchers', '21'), v(11, 'header_label', '11'),
      v(12, 'retired_one', '6', { active: 'false' }),
      v(13, 'address_line', '6', { cat_item: '', variable_set: SET }),
      v(14, 'mrvs_column', '6', { cat_item: '', variable_set: MRVS }),
    ],
    io_set_item: [{ sys_id: 'e0000000000000000000000000000001', sc_cat_item: ITEM, variable_set: SET, order: '1' }, { sys_id: 'e0000000000000000000000000000002', sc_cat_item: ITEM, variable_set: MRVS, order: '2' }],
    item_option_new_set: [
      { sys_id: SET, name: 'Address', internal_name: 'address', title: 'Address', type: 'one_to_one' },
      { sys_id: MRVS, name: 'Devices', internal_name: 'devices', title: 'Devices', type: 'one_to_many' },
    ],
    sys_db_object: [{ sys_id: '1'.repeat(32), name: 'sys_user', 'super_class.name': '' }],
    sys_dictionary: [{ sys_id: '2'.repeat(32), name: 'sys_user', element: 'email', internal_type: 'email', reference: '' }],
  };
}

const ENV_KEYS = ['FLOW_BUILDER_ENABLED', 'FLOW_BUILDER_ACTIVATE_ENABLED', 'WRITE_ENABLED', 'FLOW_BUILDER_ALLOWED_INSTANCES', 'FLOW_BUILDER_DENY_PATTERN', 'FLOW_BUILDER_EXPORT_ROOT'];
let saved: Record<string, string | undefined>;
let exportRoot: string;
beforeAll(() => { exportRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-builder-runin-'))); });
afterAll(() => { rmSync(exportRoot, { recursive: true, force: true }); });
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FLOW_BUILDER_ENABLED = 'true';
  process.env.WRITE_ENABLED = 'true';
  process.env.FLOW_BUILDER_ALLOWED_INSTANCES = 'otherdev';
  process.env.FLOW_BUILDER_EXPORT_ROOT = exportRoot;
  clearActionTypeCache();
  vi.useFakeTimers({ toFake: ['Date'] }); // 2026-09-24 12:00:00 UTC = 14:00:00 Europe/Brussels
  vi.setSystemTime(TEST_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  H.fake = undefined;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function newFake(o: { systemZone?: string; userZone?: string; extra?: Record<string, Row[]> } = {}) {
  const f = makeFakeClient({
    username: 'svc.mcp',
    tables: {
      ...baseTables(),
      sys_user: [{ sys_id: USER, user_name: 'svc.mcp', time_zone: o.userZone ?? '' }],
      sys_properties: o.systemZone === undefined ? [] : [{ sys_id: '9'.repeat(32), name: 'glide.sys.default.tz', value: o.systemZone }],
      ...catalogTables(),
      ...(o.extra ?? {}),
    },
  });
  H.fake = f;
  return f;
}
const client = (f: ReturnType<typeof newFake>) => f.client as unknown as ServiceNowClient;
const call = (f: ReturnType<typeof newFake>, name: string, args: Record<string, unknown>) =>
  runInToolInvocationContext({ channel: 'mcp', transport: 'stdio', tool: name }, () => dispatchFlowBuilderAction(client(f), name, args));
const writes = (f: ReturnType<typeof newFake>) => f.state.calls.filter(c => !['queryRecords', 'getRecord'].includes(c.method));
async function failure(p: Promise<unknown>): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  try { await p; } catch (e) {
    const err = e as { code?: string; message: string; details?: Record<string, unknown> };
    return { code: err.code ?? 'NO_CODE', message: err.message, details: err.details ?? {} };
  }
  return { code: 'NO_THROW', message: '', details: {} };
}

const runOnce = (run_in: string) => ({
  spec_version: '1', flow: { key: 'run_once_test', name: 'Run Once Test' },
  trigger: { key: 't', type: 'scheduled.run_once', run_in },
  steps: [{ kind: 'action', key: 'l', action: 'log', inputs: { log_message: 'scheduled' } }],
});

const runInOf = (triggerRow: { fields: Record<string, unknown> }) => {
  const raw = triggerRow.fields.trigger_inputs as { decoded?: unknown } | string;
  const entries = (typeof raw === 'string' ? decodeValues(raw) : raw.decoded) as { name: string; value: string; displayValue: string }[];
  return entries.find(e => e.name === 'run_in')!;
};

describe('A — run_in and the instance time zone', () => {
  it('live plan, Brussels (glide.sys.default.tz), SUMMER: an ISO instant becomes the Brussels wall time (+02:00)', async () => {
    const f = newFake({ systemZone: 'Europe/Brussels' });
    const r = await call(f, 'snow_flow_plan', { spec: runOnce('2026-10-01T12:00:00Z'), instance: 'otherdev' });
    expect(r.ok).toBe(true);
    expect(runInOf(r.plan.trigger)).toMatchObject({ value: '2026-10-01 14:00:00', displayValue: '2026-10-01 14:00:00' });
    expect(r.date_time_inputs).toEqual([{ input: 'run_in', given: '2026-10-01T12:00:00Z', form: 'iso', local: '2026-10-01 14:00:00', zone: 'Europe/Brussels', zone_source: 'glide.sys.default.tz', instance_now: '2026-09-24 14:00:00', in_future: true }]);
    expect(r.past_run_note).toBeUndefined();
    expect(f.state.calls.filter(c => c.table === 'sys_properties').map(c => c.query)).toEqual(['name=glide.sys.default.tz']);
    expect(f.state.calls.filter(c => c.table === 'sys_user').map(c => c.query)).toEqual(['user_name=svc.mcp']);
    expect(writes(f)).toEqual([]);
  });

  it('live plan, Brussels, WINTER: an ISO instant becomes the Brussels wall time (+01:00)', async () => {
    const f = newFake({ systemZone: 'Europe/Brussels' });
    const r = await call(f, 'snow_flow_plan', { spec: runOnce('2026-12-15T12:00:00Z'), instance: 'otherdev' });
    expect(runInOf(r.plan.trigger).value).toBe('2026-12-15 13:00:00');
  });

  it("the authenticated user's sys_user.time_zone is used over glide.sys.default.tz — both are read and the unverified precedence is a plan warning", async () => {
    const f = newFake({ systemZone: 'Europe/Brussels', userZone: 'America/New_York' });
    const r = await call(f, 'snow_flow_plan', { spec: runOnce('2026-12-15T12:00:00Z'), instance: 'otherdev' });
    expect(r.date_time_inputs[0]).toMatchObject({ local: '2026-12-15 07:00:00', zone: 'America/New_York', zone_source: 'sys_user.time_zone', instance_now: '2026-09-24 08:00:00' });
    expect(f.state.calls.filter(c => c.table === 'sys_properties').map(c => c.query)).toEqual(['name=glide.sys.default.tz']); // both zones are read
    expect(r.plan.warnings.join('\n')).toMatch(/trigger input "run_in": the user zone sys_user\.time_zone "America\/New_York" of svc\.mcp differs from the system zone glide\.sys\.default\.tz "Europe\/Brussels" — "America\/New_York" \(sys_user\.time_zone\) is used\. UNVERIFIED/);
    expect(writes(f)).toEqual([]);
  });

  it('the authenticated user row is not found: the system zone is used and the plan says so', async () => {
    const f = newFake({ systemZone: 'Europe/Brussels', extra: { sys_user: [] } });
    const r = await call(f, 'snow_flow_plan', { spec: runOnce('2026-12-15T12:00:00Z'), instance: 'otherdev' });
    expect(r.date_time_inputs[0]).toMatchObject({ local: '2026-12-15 13:00:00', zone: 'Europe/Brussels', zone_source: 'glide.sys.default.tz' });
    expect(r.plan.warnings.join('\n')).toMatch(/the sys_user row of svc\.mcp was not found \(missing, or not readable by this account\)/);
  });

  it('an unknown user zone falls back to the system zone with a warning', async () => {
    const f = newFake({ systemZone: 'Europe/Brussels', userZone: 'Mars/Olympus' });
    const r = await call(f, 'snow_flow_plan', { spec: runOnce('2026-12-15T12:00:00Z'), instance: 'otherdev' });
    expect(r.date_time_inputs[0]).toMatchObject({ zone: 'Europe/Brussels', zone_source: 'glide.sys.default.tz' });
    expect(r.plan.warnings.join('\n')).toMatch(/sys_user\.time_zone "Mars\/Olympus" of svc\.mcp is not a known IANA zone/);
  });

  it('past run_in: the plan WARNS (ok stays true, past_run_note), the build REFUSES before any write, allow_past_run:true builds', async () => {
    const f = newFake({ systemZone: 'Europe/Brussels' });
    // the PDI finding: 13:30 looked future in UTC but is already past in Brussels (14:00 there)
    const spec = runOnce('2026-09-24 13:30:00');
    const planned = await call(f, 'snow_flow_plan', { spec, instance: 'otherdev' });
    expect(planned.ok).toBe(true);
    expect(planned.date_time_inputs[0]).toMatchObject({ local: '2026-09-24 13:30:00', instance_now: '2026-09-24 14:00:00', in_future: false });
    expect(planned.past_run_note).toBe(PAST_RUN_NOTE);
    expect(planned.plan.warnings.join('\n')).toMatch(/is NOT in the future — the instance time is now 2026-09-24 14:00:00; on activation the flow would fire IMMEDIATELY/);

    const refused = await failure(call(f, 'snow_flow_build', { spec, instance: 'otherdev', update_set: { sys_id: 'a'.repeat(32) } }));
    expect(refused.code).toBe('FLOW_BUILDER_RUN_IN_PAST');
    expect(refused.message).toMatch(/"2026-09-24 13:30:00" is not in the future in the instance time zone Europe\/Brussels \(instance time now 2026-09-24 14:00:00\) — activating the flow would run it immediately\. Nothing was written/);
    expect(refused.details.dateTimeInputs).toEqual([expect.objectContaining({ input: 'run_in', in_future: false })]);
    expect(writes(f)).toEqual([]);

    const built = await call(f, 'snow_flow_build', { spec, instance: 'otherdev', update_set: { sys_id: 'a'.repeat(32) }, allow_past_run: true });
    expect(built.transport).toBe('loader');
    const [load] = f.state.calls.filter(c => c.method === 'postMultipart');
    const trigger = parseRecordUpdate(load.files![0].content).find(e => e.kind === 'row' && e.table === 'sys_hub_trigger_instance_v2') as { fields: Row };
    expect(runInOf({ fields: trigger.fields }).value).toBe('2026-09-24 13:30:00');
  });

  it('a future run_in builds without allow_past_run, and the ISO form lands converted in the loaded document', async () => {
    const f = newFake({ systemZone: 'Europe/Brussels' });
    await call(f, 'snow_flow_build', { spec: runOnce('2026-09-24T12:48:00Z'), instance: 'otherdev', update_set: { sys_id: 'a'.repeat(32) } });
    const [load] = f.state.calls.filter(c => c.method === 'postMultipart');
    const trigger = parseRecordUpdate(load.files![0].content).find(e => e.kind === 'row' && e.table === 'sys_hub_trigger_instance_v2') as { fields: Row };
    expect(runInOf({ fields: trigger.fields })).toMatchObject({ value: '2026-09-24 14:48:00', displayValue: '2026-09-24 14:48:00' });
  });

  it('offline plan / export: an ISO run_in is a spec error asking for an instance or the local form', async () => {
    const f = newFake({ systemZone: 'Europe/Brussels' });
    const planned = await call(f, 'snow_flow_plan', { spec: runOnce('2026-12-15T12:00:00Z') });
    expect(planned).toMatchObject({ ok: false, stage: 'generate' });
    expect(planned.errors.join('\n')).toMatch(/is an ISO-8601 instant — converting it .* needs the instance time zone: plan \/ build with an instance, or give the instance-local form/);
    const exported = await failure(call(f, 'snow_flow_export_xml', { spec: runOnce('2026-12-15T12:00:00Z'), format: 'record_update', out_path: 'iso.xml' }));
    expect(exported.code).toBe('FLOW_BUILDER_INVALID_SPEC');
    expect(JSON.stringify(exported.details.errors)).toMatch(/ISO-8601 instant/);
    // the local form still exports offline, unchecked
    const ok = await call(f, 'snow_flow_export_xml', { spec: runOnce('2026-12-15 12:00:00'), format: 'record_update', out_path: 'local.xml' });
    expect(ok.ok).toBe(true);
    expect(f.state.calls).toEqual([]);
  });

  it('zone unknown on the instance (no property, no user zone): ISO refused, a local run_in is built but reported unchecked', async () => {
    const f = newFake();
    const planned = await call(f, 'snow_flow_plan', { spec: runOnce('2026-12-15T12:00:00Z'), instance: 'otherdev' });
    expect(planned).toMatchObject({ ok: false, stage: 'generate' });
    expect(planned.errors.join('\n')).toMatch(/but the instance time zone is unknown \(glide\.sys\.default\.tz is not set and the user has no time_zone\)/);
    const local = await call(f, 'snow_flow_plan', { spec: runOnce('2026-12-15 12:00:00'), instance: 'otherdev' });
    expect(local.ok).toBe(true);
    expect(local.plan.warnings.join('\n')).toMatch(/NOT checked to lie in the future/);
  });
});

// ─── B — Get Catalog Variables outputs ───────────────────────────────────────

const gcvSpec = (text: string, gcvInputs: Record<string, unknown> = {}) => ({
  spec_version: '1', flow: { key: 'gcv_test', name: 'GCV Test' },
  trigger: { key: 't', type: 'catalog.service_catalog' },
  steps: [
    { kind: 'action', key: 'vars', action: 'getCatalogVariables', inputs: { requested_item: { pill: 'trigger.request_item' }, template_catalog_item: { reference: ITEM, display: 'Example Laptop' }, ...gcvInputs } },
    { kind: 'action', key: 'l', action: 'log', inputs: { log_message: { text } } },
  ],
});
const typesOf = (r: { plan: { pills: { symbolic: string; type: string }[] } }) =>
  Object.fromEntries(r.plan.pills.filter(p => p.symbolic.startsWith('steps.vars.')).map(p => [p.symbolic.slice('steps.vars.'.length), p.type]));

describe('B — Get Catalog Variables outputs typed from the catalog item', () => {
  it('live plan: each question type code maps to its flow type; variable sets are included (a multi-row set is one output)', async () => {
    const f = newFake();
    const names = ['short_name', 'notes', 'laptop_type', 'size', 'urgent', 'requested_for', 'needed_by', 'deliver_at', 'wide_text', 'watchers', 'header_label', 'address_line', 'devices'];
    const r = await call(f, 'snow_flow_plan', { spec: gcvSpec(names.map(n => `{{steps.vars.${n}}}`).join(' ') + ' {{steps.vars.requested_for.email}}'), instance: 'otherdev' });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(typesOf(r)).toEqual({
      short_name: 'string', notes: 'string', laptop_type: 'choice', size: 'choice', urgent: 'boolean', requested_for: 'reference',
      needed_by: 'glide_date', deliver_at: 'glide_date_time', wide_text: 'string', watchers: 'glide_list', header_label: 'string',
      address_line: 'string', devices: 'string', 'requested_for.email': 'email',
    });
    expect(r.plan.warnings.some((w: string) => /has no output/.test(w))).toBe(false);
    expect(r.plan.warnings.join('\n')).toMatch(/multi-row variable set "devices" is one output/);
    const lc = r.plan.flow.fields.label_cache as { name: string; reference?: string }[];
    expect(lc.find(e => e.name.endsWith('.requested_for'))?.reference).toBe('sys_user');
    expect(f.state.calls.filter(c => c.table === 'item_option_new').map(c => c.query)).toEqual([`cat_item=${ITEM}^active=true`, `variable_setIN${SET}^active=true`]);
    expect(writes(f)).toEqual([]);
  });

  it('live plan: an inactive variable or a misspelt name is a spec error listing the valid names', async () => {
    const f = newFake();
    const r = await call(f, 'snow_flow_plan', { spec: gcvSpec('{{steps.vars.retired_one}} {{steps.vars.laptoptype}}'), instance: 'otherdev' });
    expect(r).toMatchObject({ ok: false, stage: 'generate' });
    const valid = 'short_name, notes, laptop_type, size, urgent, requested_for, needed_by, deliver_at, wide_text, watchers, header_label, address_line, devices';
    expect(r.errors).toEqual([
      `pill steps.vars.retired_one: "retired_one" is not a variable of catalog item "Example Laptop" (${ITEM}) — valid outputs of step "vars": ${valid}`,
      `pill steps.vars.laptoptype: "laptoptype" is not a variable of catalog item "Example Laptop" (${ITEM}) — valid outputs of step "vars": ${valid}`,
    ]);
  });

  it('live plan: catalog_variables restricts the valid outputs to the selection (variables or a variable set)', async () => {
    const f = newFake();
    const sel = { catalog_variables: { list: [vid(3), `${SET}:item_option_new_set`] } };
    const ok = await call(f, 'snow_flow_plan', { spec: gcvSpec('{{steps.vars.laptop_type}} {{steps.vars.address_line}}', sel), instance: 'otherdev' });
    expect(ok.ok).toBe(true);
    expect(typesOf(ok)).toEqual({ laptop_type: 'choice', address_line: 'string' });
    const r = await call(f, 'snow_flow_plan', { spec: gcvSpec('{{steps.vars.urgent}}', sel), instance: 'otherdev' });
    expect(r.errors).toEqual([`pill steps.vars.urgent: "urgent" is not selected in catalog_variables of catalog item "Example Laptop" (${ITEM}) — valid outputs of step "vars": laptop_type, address_line`]);
  });

  it('a variable set as template_catalog_item: its own variables are the outputs', async () => {
    const f = newFake();
    const spec = gcvSpec('{{steps.vars.address_line}}', { template_catalog_item: { reference: SET } });
    const r = await call(f, 'snow_flow_plan', { spec, instance: 'otherdev' });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(typesOf(r)).toEqual({ address_line: 'string' });
    const bad = await call(f, 'snow_flow_plan', { spec: gcvSpec('{{steps.vars.laptop_type}}', { template_catalog_item: { reference: SET } }), instance: 'otherdev' });
    expect(bad.errors[0]).toMatch(/"laptop_type" is not a variable of variable set "Address" \(c0{30}2\) — valid outputs of step "vars": address_line/);
  });

  it('an item that is neither a catalog item nor a variable set refuses the build before any write', async () => {
    const f = newFake();
    const spec = gcvSpec('x', { template_catalog_item: { reference: '7'.repeat(32) } });
    const r = await failure(call(f, 'snow_flow_build', { spec, instance: 'otherdev', update_set: { sys_id: 'a'.repeat(32) } }));
    expect(r.code).toBe('FLOW_BUILDER_INVALID_SPEC');
    expect(JSON.stringify(r.details.errors)).toMatch(/template_catalog_item 7{32} is neither a catalog item \(sc_cat_item\) nor a variable set \(item_option_new_set\) on the instance/);
    expect(writes(f)).toEqual([]);
  });

  it('build and verify use the same typing (label_cache in the loaded document); verify reports an unknown name as spec_errors', async () => {
    const f = newFake();
    await call(f, 'snow_flow_build', { spec: gcvSpec('{{steps.vars.urgent}}'), instance: 'otherdev', update_set: { sys_id: 'a'.repeat(32) } });
    const [load] = f.state.calls.filter(c => c.method === 'postMultipart');
    const flow = parseRecordUpdate(load.files![0].content).find(e => e.kind === 'row' && e.table === 'sys_hub_flow') as { fields: Row };
    expect((JSON.parse(flow.fields.label_cache) as { name: string; type: string }[]).find(e => e.name.endsWith('.urgent'))?.type).toBe('boolean');
    const v = await call(f, 'snow_flow_verify', { spec: gcvSpec('{{steps.vars.urgnt}}'), instance: 'otherdev' });
    expect(v.ok).toBe(false);
    expect(v.spec_errors.join('\n')).toMatch(/"urgnt" is not a variable of catalog item "Example Laptop"/);
  });

  it('offline plan: unchanged — the pill is typed string with a warning, nothing is read', async () => {
    const f = newFake();
    const r = await call(f, 'snow_flow_plan', { spec: gcvSpec('{{steps.vars.urgent}}') });
    expect(r.ok).toBe(true);
    expect(typesOf(r)).toEqual({ urgent: 'string' });
    expect(r.plan.warnings).toContain('pill steps.vars.urgent: step "vars" has no output "urgent"; typed as string');
    expect(f.state.calls).toEqual([]);
  });
});
