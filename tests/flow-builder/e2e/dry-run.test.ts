/**
 * End-to-end dry run of the Flow Builder through the REAL tool router (routeToolInvocation), with
 * no instance: every ServiceNow call lands on the in-memory vi.fn fake client
 * (tests/flow-builder/writer/fake-client.ts). Nothing is mocked inside src/flow-builder — the spec
 * parser, generator, writer, verifier and XML emitters all run for real.
 *
 *   1. The design's reference spec 'P1 Incident Review' (tests/flow-builder/specs/p1_incident_review.json):
 *      snow_flow_plan offline → snow_flow_build (default transport = the ServiceNow IDE loader: one multipart
 *      POST of planToRecordUpdateXml(plan), then read-back of rows / version / capture) and the table_api
 *      transport → exact call sequence (dictionary reads, §2.2 pre-writes,
 *      existence pre-check, ordered POSTs carrying the planned sys_ids and fields, stale scan,
 *      sys_update_xml verification) → snow_flow_verify round trip → idempotent mode:'update' re-run →
 *      snow_flow_export_xml (update_set + record_update) as well-formed XML under a temp export root.
 *   2. One spec per major construct (every trigger family, the core actions, all flow logic, subflow
 *      definitions and calls, stages / variables, the Flow Error Handler): plan → build → export.
 *
 * Owner: INTEGRATOR.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeClient, baseTables, callSignature, parseRecordUpdate, specInstanceTables, TEST_NOW, type Row, type Call } from '../writer/fake-client.js';

const H = vi.hoisted(() => ({ fake: undefined as undefined | { client: unknown } }));

vi.mock('../../../src/servicenow/instances.js', () => ({
  instanceManager: {
    listAll: () => [
      { name: 'product', url: 'https://pdidemo01.service-now.com', group: 'PDI', environment: 'dev', active: false },
      { name: 'blockeddev', url: 'https://blockeddev.service-now.com', group: 'Blocked', environment: 'dev', active: true },
    ],
    getClient: (name?: string) => {
      if (name === 'product' && H.fake) return H.fake.client;
      throw new Error(`Unknown instance "${name}"`);
    },
    getCurrentName: () => 'blockeddev',
  },
}));

import { routeToolInvocation } from '../../../src/tools/index.js';
import { runInToolInvocationContext } from '../../../src/utils/invocation-context.js';
import { parseSpec } from '../../../src/flow-builder/spec/schema.js';
import { generatePlan } from '../../../src/flow-builder/generator/index.js';
import { plannedRows, CHILD_TABLES_BY_FLOW, CHILD_TABLES_BY_MODEL } from '../../../src/flow-builder/writer/index.js';
import { LOADER_LOAD_PATH, LOADER_PREFERENCE_NOTE } from '../../../src/flow-builder/writer/loader.js';
import { planToRecordUpdateXml } from '../../../src/flow-builder/xml/record-update.js';
import { TABLE_API_TRANSPORT_WARNING } from '../../../src/tools/flow-builder.js';
import { ACTION_DEFINITIONS, findAction } from '../../../src/flow-builder/catalog/actions.js';
import { clearActionTypeCache } from '../../../src/flow-builder/resolvers.js';
import type { FlowSpec, RecordPlan, RecordRow } from '../../../src/flow-builder/spec/types.js';
import type { ServiceNowClient } from '../../../src/servicenow/client.js';

// ─── fixtures ─────────────────────────────────────────────────────────────────

const SPEC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'specs');
const loadSpec = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(SPEC_DIR, `${name}.json`), 'utf8'));

const P1 = loadSpec('p1_incident_review');
/** P1 with its approver pill typed in the spec — what an offline export (the manual / no-REST channel) needs. */
const P1_TYPED = { ...P1, flow: { ...(P1.flow as Record<string, unknown>), pill_types: { 'trigger.current.assignment_group': 'reference' } } };
const US = 'a'.repeat(32);
const USER = 'u'.repeat(32);
const US_NAME = 'TEST_FLOW_TEST_V1';

/** sys_dictionary seen by the build's live pill typing: incident inherits these from task. */
const DICTIONARY: Record<string, Row[]> = {
  sys_db_object: [
    { sys_id: '1'.repeat(32), name: 'incident', 'super_class.name': 'task' },
    { sys_id: '2'.repeat(32), name: 'task', 'super_class.name': '' },
  ],
  sys_dictionary: [
    { sys_id: '3'.repeat(32), name: 'task', element: 'number', internal_type: 'string', reference: '' },
    { sys_id: '4'.repeat(32), name: 'task', element: 'urgency', internal_type: 'integer', reference: '' },
    { sys_id: '5'.repeat(32), name: 'task', element: 'assignment_group', internal_type: 'reference', reference: 'sys_user_group' },
  ],
};
const P1_TYPES: Record<string, string> = { number: 'string', urgency: 'integer', assignment_group: 'reference' };

const fakeId = (seed: string) => createHash('sha256').update(seed).digest('hex').slice(0, 32);

/**
 * Definition rows a live build resolves (read-only): every PDI-verified catalogue snapshot as a
 * sys_hub_action_type_snapshot row pointing at its definition (so the build keeps the catalogue ids),
 * and the subflow / custom-action definitions of tests/flow-builder/specs/_context.json with their
 * declared inputs / outputs.
 */
function definitionTables(): Record<string, Row[]> {
  const ctx = JSON.parse(readFileSync(join(SPEC_DIR, '_context.json'), 'utf8')) as {
    subflows: Record<string, { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] }>;
    customActions: Record<string, { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] }>;
  };
  const t: Record<string, Row[]> = {
    sys_hub_action_type_snapshot: Object.entries(ACTION_DEFINITIONS).map(([key, ids]) => ({ sys_id: ids.snapshot, name: findAction(key)!.name, parent_action: ids.definition })),
    sys_hub_flow: [], sys_hub_flow_input: [], sys_hub_flow_output: [],
    sys_hub_action_type_definition: [], sys_hub_action_input: [], sys_hub_action_output: [],
  };
  const vars = (table: string, model: string, list: { name: string; type: string }[]) =>
    list.forEach((v, i) => t[table].push({ sys_id: fakeId(`${table}:${model}:${v.name}`), model, element: v.name, internal_type: v.type, order: String(i + 1), mandatory: 'false', default_value: '' }));
  for (const [id, d] of Object.entries(ctx.subflows)) {
    t.sys_hub_flow.push({ sys_id: id, name: `Example subflow ${id.slice(0, 6)}`, internal_name: `example_subflow_${id.slice(0, 6)}`, type: 'subflow', 'sys_scope.scope': 'global' });
    vars('sys_hub_flow_input', id, d.inputs); vars('sys_hub_flow_output', id, d.outputs);
  }
  for (const [id, d] of Object.entries(ctx.customActions)) {
    t.sys_hub_action_type_definition.push({ sys_id: id, name: `Example action ${id.slice(0, 6)}`, internal_name: `example_action_${id.slice(0, 6)}`, 'sys_scope.scope': 'x_example_app' });
    vars('sys_hub_action_input', id, d.inputs); vars('sys_hub_action_output', id, d.outputs);
  }
  return t;
}

/** One spec per major construct (tests/flow-builder/specs). */
const CONSTRUCTS: { name: string; construct: string }[] = [
  { name: 'trg_record_created', construct: 'record.created trigger (advanced options)' },
  { name: 'trg_record_created_or_updated', construct: 'record.created_or_updated trigger' },
  { name: 'ritm_fulfilment', construct: 'record.updated trigger + createCatalogTask + if / end_flow' },
  { name: 'trg_daily', construct: 'scheduled.daily trigger' },
  { name: 'trg_weekly', construct: 'scheduled.weekly trigger' },
  { name: 'trg_monthly', construct: 'scheduled.monthly trigger' },
  { name: 'trg_repeat', construct: 'scheduled.repeat trigger' },
  { name: 'trg_run_once', construct: 'scheduled.run_once trigger' },
  { name: 'trg_service_catalog', construct: 'catalog.service_catalog trigger' },
  { name: 'trg_inbound_email', construct: 'email.inbound trigger' },
  { name: 'trg_sla_task', construct: 'sla.task trigger' },
  { name: 'trg_knowledge', construct: 'knowledge.management trigger' },
  { name: 'trg_remote_table', construct: 'remote_table.query trigger' },
  { name: 'record_actions', construct: 'record / attachment / task / event / wait / notification actions + for_each' },
  { name: 'catalog_actions', construct: 'catalog actions (Get Catalog Variables, Create Catalog Task, ...)' },
  { name: 'email_actions', construct: 'inbound-email actions + sendEmail / waitForEmailReply' },
  { name: 'sla_actions', construct: 'SLA percentage timer + if' },
  { name: 'flow_logic', construct: 'all flow logic: set / append (one object and a {list} of {template} objects) variables, for_each, skip / exit, wait x3, try/catch, do_in_parallel, do_until (labelled)' },
  { name: 'incident_triage', construct: 'flow variables + stages + approval + lookups + subflow call' },
  { name: 'level_check_subflow', construct: 'subflow definition (inputs / outputs / assign_subflow_outputs)' },
  { name: 'review_subflow', construct: 'subflow definition (complex inputs)' },
  { name: 'flow_options', construct: 'custom action + subflow call by sys_id' },
  { name: 'pdi_error_handler', construct: 'Flow Error Handler (try / catch rows, error.* pills)' },
];

// ─── environment ──────────────────────────────────────────────────────────────

const ENV_KEYS = ['FLOW_BUILDER_ENABLED', 'FLOW_BUILDER_ACTIVATE_ENABLED', 'WRITE_ENABLED', 'FLOW_BUILDER_ALLOWED_INSTANCES', 'FLOW_BUILDER_DENY_PATTERN', 'FLOW_BUILDER_EXPORT_ROOT'];
let saved: Record<string, string | undefined>;
let exportRoot: string;

beforeAll(() => { exportRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-builder-e2e-'))); });
afterAll(() => { rmSync(exportRoot, { recursive: true, force: true }); });

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FLOW_BUILDER_DENY_PATTERN = 'blocked'; // the locally configured deny list (no default in code)
  process.env.FLOW_BUILDER_ENABLED = 'true';
  process.env.WRITE_ENABLED = 'true';
  process.env.FLOW_BUILDER_ALLOWED_INSTANCES = 'product';
  process.env.FLOW_BUILDER_EXPORT_ROOT = exportRoot;
  clearActionTypeCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TEST_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  H.fake = undefined;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function newFake(extra: Record<string, Row[]> = {}) {
  const fake = makeFakeClient({ username: 'mcp.user', tables: { ...baseTables(), ...DICTIONARY, ...definitionTables(), ...specInstanceTables(), ...extra } });
  H.fake = fake;
  return fake;
}

/** Every routed call is made as a DIRECT MCP (stdio) call of that tool — what src/server.ts establishes. */
const route = (client: ServiceNowClient, name: string, args: Record<string, unknown>) =>
  runInToolInvocationContext({ channel: 'mcp', transport: 'stdio', tool: name }, () => routeToolInvocation(client, name, args));

// ─── helpers ──────────────────────────────────────────────────────────────────

async function expectedPlan(spec: Record<string, unknown>, types: Record<string, string> = {}): Promise<RecordPlan> {
  const r = parseSpec(spec);
  if ('errors' in r) throw new Error(JSON.stringify(r.errors));
  return generatePlan(r.spec as FlowSpec, { resolvePillType: async (_t, p) => types[p] });
}

/** The row order a build writes, rebuilt from the decoded plan that snow_flow_plan returns. */
function reviewOrder(plan: { flow: RecordRow; variables: RecordRow[]; documentation: RecordRow[]; stages: RecordRow[]; trigger?: RecordRow; instances: RecordRow[] }): string[] {
  return [plan.flow, ...plan.variables, ...plan.documentation, ...plan.stages, ...(plan.trigger ? [plan.trigger] : []), ...plan.instances].map(r => `${r.table}:${r.sys_id}`);
}

const apiFields = (row: RecordRow): Record<string, string> =>
  Object.fromEntries(Object.entries(row.fields).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]));

const isRead = (c: Call) => c.method === 'queryRecords' || c.method === 'getRecord';
const writeCalls = (calls: Call[]) => calls.filter(c => c.method === 'createRecord' || c.method === 'updateRecord' || c.method === 'deleteRecord' || c.method === 'requestJson' || c.method === 'postMultipart');
const loaderCalls = (calls: Call[]) => calls.filter(c => c.method === 'postMultipart');
/** Every sys_id a <record_update> document carries as a data row. */
const idsInDocument = (xml: string) => parseRecordUpdate(xml).filter(e => e.kind === 'row').map(e => (e as { fields: Row }).fields.sys_id);

/**
 * Minimal XML 1.0 well-formedness check (no dependency): one root element, balanced and correctly
 * nested tags, quoted and unique attributes, only predefined / numeric entity references, terminated
 * CDATA sections and comments, nothing but whitespace outside the root. Returns the root name.
 */
function assertWellFormed(xml: string): string {
  const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
  let i = 0;
  if (xml.startsWith('<?xml')) {
    const end = xml.indexOf('?>');
    if (end < 0) throw new Error('unterminated XML declaration');
    i = end + 2;
  }
  const stack: string[] = [];
  let root: string | undefined;
  let rootDone = false;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = lt < 0 ? xml.slice(i) : xml.slice(i, lt);
    if (ENTITY.test(text)) throw new Error(`bad entity reference near offset ${i}: ${text.slice(0, 60)}`);
    if (stack.length === 0 && text.trim()) throw new Error(`text outside the root element at offset ${i}`);
    if (lt < 0) break;
    if (xml.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) throw new Error('CDATA outside the root element');
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) throw new Error(`unterminated CDATA at offset ${lt}`);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw new Error(`unterminated comment at offset ${lt}`);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) throw new Error(`unexpected markup at offset ${lt}`);
    // find the end of the tag, honouring quoted attribute values
    let j = lt + 1;
    let quote = '';
    for (; j < xml.length; j++) {
      const ch = xml[j];
      if (quote) { if (ch === quote) quote = ''; else if (ch === '<') throw new Error(`"<" inside an attribute value at offset ${j}`); }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      else if (ch === '<') throw new Error(`"<" inside a tag at offset ${j}`);
    }
    if (j >= xml.length) throw new Error(`unterminated tag at offset ${lt}`);
    const body = xml.slice(lt + 1, j);
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (open !== name) throw new Error(`</${name}> closes <${open ?? '(nothing)'}> at offset ${lt}`);
      if (stack.length === 0) rootDone = true;
    } else {
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const m = NAME.exec(inner);
      if (!m) throw new Error(`bad element name at offset ${lt}: <${body.slice(0, 40)}`);
      const name = m[0];
      if (stack.length === 0) {
        if (rootDone || root !== undefined) throw new Error(`second root element <${name}> at offset ${lt}`);
        root = name;
      }
      let rest = inner.slice(name.length);
      const seen = new Set<string>();
      const ATTR = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/;
      let a: RegExpExecArray | null;
      while ((a = ATTR.exec(rest))) {
        if (seen.has(a[1])) throw new Error(`duplicate attribute ${a[1]} on <${name}>`);
        seen.add(a[1]);
        const v = a[3] ?? a[4] ?? '';
        if (ENTITY.test(v)) throw new Error(`bad entity in attribute ${a[1]} on <${name}>`);
        rest = rest.slice(a[0].length);
      }
      if (rest.trim()) throw new Error(`malformed attributes on <${name}>: ${rest.slice(0, 40)}`);
      if (selfClosing) { if (stack.length === 0) rootDone = true; }
      else stack.push(name);
    }
    i = j + 1;
  }
  if (stack.length) throw new Error(`unclosed element(s): ${stack.join(' > ')}`);
  if (!root) throw new Error('no root element');
  return root;
}

/** The record_update carried in each <payload> of an <unload> (CDATA sections joined). */
function payloadsOf(unload: string): string[] {
  return [...unload.matchAll(/<payload>([\s\S]*?)<\/payload>/g)].map(m =>
    [...m[1].matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map(c => c[1]).join('')
  );
}

// ─── 1. P1 Incident Review ────────────────────────────────────────────────────

describe('dry run — P1 Incident Review (design reference spec)', () => {
  it('snow_flow_plan (offline) returns the full plan, touches no instance and writes nothing', async () => {
    const fake = newFake();
    const r = await route(fake.client, 'snow_flow_plan', { spec: P1 });
    // offline, the approver pill trigger.current.assignment_group has no verified type: listed, ok:false
    expect(r.ok).toBe(false);
    expect(r.unverified_approvers).toEqual([{ step: 'approve', pill: 'trigger.current.assignment_group' }]);
    expect(r.unverified_approvers_note).toMatch(/REFUSE/);
    const typed = await route(fake.client, 'snow_flow_plan', { spec: P1_TYPED });
    expect(typed.ok).toBe(true);
    expect(typed.unverified_approvers).toBeUndefined();
    expect(r.live).toBe(false);
    expect(r.writes).toContain('none');
    expect(fake.state.calls).toEqual([]);

    const plan = r.plan;
    expect(plan.flow.table).toBe('sys_hub_flow');
    expect(plan.flow.fields).toMatchObject({ name: 'P1 Incident Review', active: 'false', status: 'draft', run_as: 'system' });
    expect(plan.trigger.table).toBe('sys_hub_trigger_instance_v2');
    expect(plan.trigger.fields.trigger_definition).toBe('798916a0c31322002841b63b12d3ae7c');
    // instances in flat order: log, updateRecord, If, askForApproval, log, Else, End Flow
    expect(plan.instances.map((i: RecordRow) => i.table)).toEqual([
      'sys_hub_action_instance_v2', 'sys_hub_action_instance_v2', 'sys_hub_flow_logic_instance_v2',
      'sys_hub_action_instance_v2', 'sys_hub_action_instance_v2', 'sys_hub_flow_logic_instance_v2', 'sys_hub_flow_logic_instance_v2',
    ]);
    expect(plan.instances.map((i: RecordRow) => i.fields.action_type ?? i.fields.logic_definition)).toEqual([
      '5bc1bcc6531003003bf1d9109ec587d4', 'f9d01dd2c31332002841b63b12d3aea1', 'af4e1945c3e232002841b63b12d3ae3e',
      'f8f2e9920b10030085c083eb37673abd', '5bc1bcc6531003003bf1d9109ec587d4', '1f781bf3c32232002841b63b12d3aee6', 'd176605ea76103004f27b0d2187901c7',
    ]);
    expect(plan.instances.map((i: RecordRow) => String(i.fields.order))).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    // parent_ui_id: approve + log_result sit under the If, End Flow under the Else
    const ui = plan.instances.map((i: RecordRow) => i.fields.ui_id);
    expect(plan.instances[3].fields.parent_ui_id).toBe(ui[2]);
    expect(plan.instances[4].fields.parent_ui_id).toBe(ui[2]);
    expect(plan.instances[6].fields.parent_ui_id).toBe(ui[5]);
    // the approval step: rules grammar + pill rewriting
    const approval = JSON.stringify(plan.instances[3].fields.values);
    expect(approval).toContain('ApprovesAnyG[{{Created_1.current.assignment_group}}]');
    expect(JSON.stringify(plan.instances[4].fields.values)).toContain(`{{${plan.instances[3].fields.ui_id}.approval_state}}`);
    expect(plan.pills.map((p: { symbolic: string }) => p.symbolic)).toEqual([
      'trigger.current.number', 'trigger.current', 'trigger.current.urgency', 'trigger.current.assignment_group', 'steps.approve.approval_state',
    ]);
    // the capture protocol a build would run is spelled out
    expect(r.captureProtocol.join('\n')).toMatch(/sys_user_preference/);
    expect(r.captureProtocol.join('\n')).toMatch(/sys_update_xml/);
  });

  it('snow_flow_build (default transport = loader): reads → ONE loader POST of the plan XML → read-back verification; no preference, no Table-API write', async () => {
    const fake = newFake();
    const expected = await expectedPlan(P1, P1_TYPES);
    const rows = plannedRows(expected);

    const r = await route(fake.client, 'snow_flow_build', { spec: P1, instance: 'product', update_set: { name: US_NAME } });
    const sig = callSignature(fake.state.calls);

    // (a) live pill typing + action-type resolution = dictionary / snapshot READS only, before anything else
    const firstUs = sig.indexOf('queryRecords:sys_update_set');
    expect(firstUs).toBeGreaterThan(0);
    expect(new Set(sig.slice(0, firstUs))).toEqual(new Set(['queryRecords:sys_dictionary', 'queryRecords:sys_db_object', 'queryRecords:sys_hub_action_type_snapshot']));

    // (b) the fixed sequence: update set → existence pre-check → child scan → ONE loader POST → read-back
    const planTables = [...new Set(rows.map(x => x.table))];
    const childScan = [...CHILD_TABLES_BY_FLOW.map(t => `queryRecords:${t}`), ...CHILD_TABLES_BY_MODEL.map(t => `queryRecords:${t}`), 'queryRecords:sys_documentation'];
    const managedScan = ['queryRecords:sys_hub_flow_input', 'queryRecords:sys_documentation']; // P1 is record-triggered (PDI finding 2)
    expect(sig.slice(firstUs)).toEqual([
      'queryRecords:sys_update_set',                  // in progress, is_default=false, application = flow's
      ...planTables.map(t => `queryRecords:${t}`),    // existence pre-check
      ...childScan,                                   // child rows before (what delete_multiple would remove)
      ...managedScan,                                 // record trigger: platform-managed inputs current / table_name (+ docs)
      'queryRecords:sys_hub_alias_mapping',          // alias rows of the planned instances (housekeeping delete, as the platform capture writes it)
      'queryRecords:sys_update_xml',                  // the target set's parent capture row BEFORE the load
      `postMultipart:${LOADER_LOAD_PATH}/global`,     // the load
      'getRecord:sys_hub_flow',                       // version / status / active
      ...planTables.map(t => `queryRecords:${t}`),    // every planned row present
      ...childScan,                                   // child rows after (deleted / stale)
      ...managedScan,                                 // platform-managed inputs after the load
      'queryRecords:sys_update_xml',                  // capture in the target update set
      'queryRecords:sys_update_xml',                  // the parent capture row AFTER the load (must have changed)
    ]);
    // no sys_user / sys_user_preference access at all, no Table-API write, no activation call
    expect(sig.some(s => /sys_user(_preference)?$/.test(s))).toBe(false);
    expect(fake.state.calls.some(c => ['createRecord', 'updateRecord', 'deleteRecord', 'requestJson'].includes(c.method))).toBe(false);

    // the loader call: path, query, one 'files' part = planToRecordUpdateXml(plan)
    const [load] = loaderCalls(fake.state.calls);
    expect(load.path).toBe(`${LOADER_LOAD_PATH}/global`);
    expect(load.params).toEqual({ targetUpdateSetId: US });
    expect(load.files).toHaveLength(1);
    expect(load.files![0]).toMatchObject({ field: 'files', filename: `sys_hub_flow_${expected.flow.sys_id}.xml`, contentType: 'application/xml' });
    expect(load.files![0].content).toBe(planToRecordUpdateXml(expected));
    expect(assertWellFormed(load.files![0].content)).toBe('record_update');
    expect(new Set(idsInDocument(load.files![0].content))).toEqual(new Set(rows.map(x => x.sys_id)));

    // result
    expect(r.transport).toBe('loader');
    expect(r.flowSysId).toBe(expected.flow.sys_id);
    expect(r.instanceName).toBe('product');
    expect(r.rowCount).toBe(rows.length);
    expect(r.updateSet).toEqual({ sys_id: US, name: US_NAME });
    expect(r.preferences).toEqual([]);
    expect(r.preferencesNote).toBe(LOADER_PREFERENCE_NOTE);
    expect(r.loader).toMatchObject({ path: `${LOADER_LOAD_PATH}/global`, scopeId: 'global', targetUpdateSetId: US, http_status: 200, returnedUpdateSetId: US });
    expect(r.flowState).toMatchObject({ version: '2', status: 'draft', active: 'false' });
    expect(r.written).toEqual(rows.map(x => ({ table: x.table, sys_id: x.sys_id, action: 'inserted' })));
    expect(r.missing).toEqual([]);
    expect(r.capture).toMatchObject({ ok: true, mode: 'parent_row', expected: rows.length, found: rows.length, missing: [] });
    expect(r.captureRow.changed).toBe(true);
    expect(r.housekeepingDeletes).toEqual([]);
    expect(r.fieldDiffs).toEqual([]);
    expect(r.stale).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(r.activation).toEqual({ requested: false, attempted: false, ok: false });
    expect(r.warnings).toEqual([]);
    expect(r.summary).toContain('no sys_user_preference writes');
  });

  it('snow_flow_build transport:"table_api" (diagnostics only) keeps the §2.2 Table-API sequence and carries the version-1 warning', async () => {
    const fake = newFake();
    const expected = await expectedPlan(P1, P1_TYPES);
    const rows = plannedRows(expected);

    const r = await route(fake.client, 'snow_flow_build', { spec: P1, instance: 'product', update_set: { name: US_NAME }, transport: 'table_api' });
    expect(r.transport).toBe('table_api');
    expect(r.transport_warning).toBe(TABLE_API_TRANSPORT_WARNING);
    expect(r.warnings[0]).toBe(TABLE_API_TRANSPORT_WARNING);
    expect(r.summary).toMatch(/^\[table_api — diagnostics only/);
    expect(loaderCalls(fake.state.calls)).toEqual([]);
    const sig = callSignature(fake.state.calls);

    // (a) live pill typing + action-type resolution = READS only, before anything else (incident → task inheritance hop)
    const firstUs = sig.indexOf('queryRecords:sys_update_set');
    expect(firstUs).toBeGreaterThan(0);
    expect(fake.state.calls.slice(0, firstUs).every(isRead)).toBe(true);
    expect(new Set(sig.slice(0, firstUs))).toEqual(new Set(['queryRecords:sys_dictionary', 'queryRecords:sys_db_object', 'queryRecords:sys_hub_action_type_snapshot']));

    // (b) from the update-set lookup on, the whole sequence is fixed
    const planTables = [...new Set(rows.map(x => x.table))];
    expect(sig.slice(firstUs)).toEqual([
      'queryRecords:sys_update_set',            // §2.2 step 1 — in progress, is_default=false
      'queryRecords:sys_user',                  // §2.2 step 2 — the AUTHENTICATED user
      ...planTables.map(t => `queryRecords:${t}`),              // existence pre-check (read-only, BEFORE any write)
      'queryRecords:sys_user_preference',       // §2.2 step 3 — read the preference …
      'createRecord:sys_user_preference',       //               … and set it
      ...rows.map(x => `createRecord:${x.table}`),              // ordered POSTs
      ...CHILD_TABLES_BY_FLOW.map(t => `queryRecords:${t}`),    // STALE scan
      ...CHILD_TABLES_BY_MODEL.map(t => `queryRecords:${t}`),
      'queryRecords:sys_documentation',
      'queryRecords:sys_update_xml',            // §2.2 step 5 — capture verification
    ]);

    // §2.2 details: the right update set, the user derived from the session, the preference value
    const usQuery = fake.state.calls[firstUs];
    expect(usQuery.query).toBe(`name=${US_NAME}`);
    expect(fake.fns.getConfiguredUsername).toHaveBeenCalled();
    expect(fake.state.calls[firstUs + 1].query).toBe('user_name=mcp.user');
    const prefRead = firstUs + 2 + planTables.length;
    expect(fake.state.calls[prefRead].query).toBe(`user=${USER}^name=sys_update_set`);
    expect(fake.state.calls[prefRead + 1].data).toEqual({ user: USER, name: 'sys_update_set', value: US, type: 'string' });

    // ordered POSTs carry exactly the planned sys_ids and field values
    const posts = fake.state.calls.filter(c => c.method === 'createRecord' && c.table !== 'sys_user_preference');
    expect(posts.map(c => `${c.table}:${c.data!.sys_id}`)).toEqual(rows.map(x => `${x.table}:${x.sys_id}`));
    posts.forEach((c, n) => expect(c.data, `${rows[n].table} ${rows[n].sys_id}`).toEqual({ sys_id: rows[n].sys_id, ...apiFields(rows[n]) }));
    expect(fake.state.calls.some(c => c.method === 'updateRecord' || c.method === 'deleteRecord' || c.method === 'requestJson')).toBe(false);

    // sys_update_xml verification: one sys_hub_flow_<id> row in OUR update set holding every planned row
    const xmlQuery = fake.state.calls[fake.state.calls.length - 1];
    expect(xmlQuery.query).toBe(`update_set=${US}^name=sys_hub_flow_${expected.flow.sys_id}`);
    expect(r.capture).toMatchObject({ ok: true, mode: 'parent_row', expected: rows.length, found: rows.length, missing: [] });
    expect(r.capture.parentRow.type).toBe('Flow');

    // result
    expect(r.flowSysId).toBe(expected.flow.sys_id);
    expect(r.instanceName).toBe('product');
    expect(r.rowCount).toBe(rows.length);
    expect(r.updateSet).toEqual({ sys_id: US, name: US_NAME });
    expect(r.user).toEqual({ sys_id: USER, user_name: 'mcp.user' });
    expect(r.written).toEqual(rows.map(x => ({ table: x.table, sys_id: x.sys_id, action: 'inserted' })));
    expect(r.stale).toEqual([]);
    expect(r.activation).toEqual({ requested: false, attempted: false, ok: false });
    expect(r.warnings).toEqual([TABLE_API_TRANSPORT_WARNING]); // the live dictionary typed every pill; only the transport warning
    expect(fake.table('sys_hub_flow').get(expected.flow.sys_id)).toMatchObject({ active: 'false', status: 'draft' });
  });

  it('the build and the offline plan agree on every row and sys_id (deterministic ids), on both transports', async () => {
    const fake = newFake();
    const planned = await route(fake.client, 'snow_flow_plan', { spec: P1 });
    await route(fake.client, 'snow_flow_build', { spec: P1, instance: 'product', update_set: { sys_id: US } });
    const [load] = loaderCalls(fake.state.calls);
    expect(new Set(idsInDocument(load.files![0].content))).toEqual(new Set(reviewOrder(planned.plan).map(o => o.split(':')[1])));

    const fake2 = newFake();
    await route(fake2.client, 'snow_flow_build', { spec: P1, instance: 'product', update_set: { sys_id: US }, transport: 'table_api' });
    const posts = fake2.state.calls.filter(c => c.method === 'createRecord' && c.table !== 'sys_user_preference').map(c => `${c.table}:${c.data!.sys_id}`);
    expect(posts).toEqual(reviewOrder(planned.plan));
  });

  it('snow_flow_verify reads the loaded flow back with no diffs and every pill resolved; a mode:"update" re-run is one more load, all rows updated', async () => {
    const fake = newFake();
    const built = await route(fake.client, 'snow_flow_build', { spec: P1, instance: 'product', update_set: { sys_id: US } });

    let mark = fake.state.calls.length;
    const v = await route(fake.client, 'snow_flow_verify', { spec: P1, instance: 'product' });
    expect(writeCalls(fake.state.calls.slice(mark))).toEqual([]); // verify is read-only
    expect(v.found).toBe(true);
    expect(v.diffs).toEqual([]);
    expect(v.unresolvedPills).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.instanceName).toBe('product');

    const byId = await route(fake.client, 'snow_flow_verify', { flow_sys_id: built.flowSysId, instance: 'product' });
    expect(byId.found).toBe(true);
    expect(byId.unresolvedPills).toEqual([]);

    mark = fake.state.calls.length;
    const again = await route(fake.client, 'snow_flow_build', { spec: P1, instance: 'product', update_set: { sys_id: US }, mode: 'update' });
    const writes = writeCalls(fake.state.calls.slice(mark));
    expect(writes.map(c => c.method)).toEqual(['postMultipart']);
    expect(again.written.every((w: { action: string }) => w.action === 'updated')).toBe(true);
    expect(again.written.map((w: { table: string; sys_id: string }) => `${w.table}:${w.sys_id}`)).toEqual(built.written.map((w: { table: string; sys_id: string }) => `${w.table}:${w.sys_id}`));
    expect(again.preferences).toEqual([]);
    expect(again.capture.ok).toBe(true);
    expect(again.stale).toEqual([]);
    expect(again.deleted).toEqual([]);
    // still exactly one capture row for the flow in the target set
    expect([...fake.table('sys_update_xml').values()].filter(x => x.name === `sys_hub_flow_${built.flowSysId}`)).toHaveLength(1);
  });

  it('a string-typed approver pill (dictionary says string) is refused before any write — the zero-approver trap', async () => {
    const fake = makeFakeClient({
      username: 'mcp.user',
      tables: { ...baseTables(), sys_dictionary: [{ sys_id: '6'.repeat(32), name: 'incident', element: 'assignment_group', internal_type: 'string', reference: '' }] },
    });
    H.fake = fake;
    await expect(route(fake.client, 'snow_flow_build', { spec: P1, instance: 'product', update_set: { sys_id: US } }))
      .rejects.toMatchObject({ code: 'FLOW_BUILDER_INVALID_SPEC' });
    expect(writeCalls(fake.state.calls)).toEqual([]);
  });

  it('snow_flow_export_xml writes a well-formed <unload> (and <record_update>) under the export root', async () => {
    const fake = newFake();
    const expected = await expectedPlan(P1_TYPED);

    // regression: export always generates offline, so an untyped approver pill used to be exported with a warning only
    await expect(route(fake.client, 'snow_flow_export_xml', { spec: P1, format: 'update_set', update_set_name: 'TEST_P1', out_path: 'p1_untyped.xml' }))
      .rejects.toMatchObject({ code: 'FLOW_BUILDER_INVALID_SPEC' });

    const r = await route(fake.client, 'snow_flow_export_xml', { spec: P1_TYPED, format: 'update_set', update_set_name: 'TEST_P1_INCIDENT_REVIEW', description: 'P1 Incident Review', out_path: 'p1/../p1_incident_review.xml' });
    expect(fake.state.calls).toEqual([]); // offline
    expect(r.ok).toBe(true);
    expect(r.path).toBe(join(exportRoot, 'p1_incident_review.xml'));
    expect(r.flowSysId).toBe(expected.flow.sys_id);
    const xml = readFileSync(r.path, 'utf8');
    expect(r.bytes).toBe(Buffer.byteLength(xml, 'utf8'));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(assertWellFormed(xml)).toBe('unload');
    expect(xml.match(/<sys_remote_update_set action="INSERT_OR_UPDATE">/g)).toHaveLength(1);
    expect(xml).toContain('<name>TEST_P1_INCIDENT_REVIEW</name>');
    expect(xml).toContain('<state>loaded</state>');
    expect(xml.match(/<sys_update_xml action="INSERT_OR_UPDATE">/g)).toHaveLength(1);
    expect(xml).toContain(`<name>sys_hub_flow_${expected.flow.sys_id}</name>`);
    expect(xml).not.toContain('apply_defaults');

    const payloads = payloadsOf(xml);
    expect(payloads).toHaveLength(1);
    expect(assertWellFormed(payloads[0])).toBe('record_update');
    for (const x of plannedRows(expected)) expect(payloads[0], `${x.table} ${x.sys_id}`).toContain(`<sys_id>${x.sys_id}</sys_id>`);

    const ru = await route(fake.client, 'snow_flow_export_xml', { spec: P1_TYPED, format: 'record_update', out_path: 'p1_record_update.xml' });
    const ruXml = readFileSync(ru.path, 'utf8');
    expect(assertWellFormed(ruXml)).toBe('record_update');
    for (const x of plannedRows(expected)) expect(ruXml).toContain(x.sys_id);

    // confinement: nothing outside the root, nothing but the two files inside it
    await expect(route(fake.client, 'snow_flow_export_xml', { spec: P1, format: 'record_update', out_path: '../escape.xml' }))
      .rejects.toMatchObject({ code: 'FLOW_BUILDER_EXPORT_OUTSIDE_ROOT' });
    expect(readdirSync(exportRoot).sort()).toEqual(['p1_incident_review.xml', 'p1_record_update.xml']);
  });

  it('the guards still hold on the router path: a denied instance is refused and the instance is mandatory', async () => {
    const fake = newFake();
    await expect(route(fake.client, 'snow_flow_build', { spec: P1, instance: 'blockeddev', update_set: { sys_id: US } }))
      .rejects.toMatchObject({ code: 'FLOW_BUILDER_INSTANCE_DENIED' });
    await expect(route(fake.client, 'snow_flow_build', { spec: P1, update_set: { sys_id: US } }))
      .rejects.toMatchObject({ code: 'FLOW_BUILDER_INSTANCE_REQUIRED' });
    expect(fake.state.calls).toEqual([]);
  });
});

// ─── 2. one spec per major construct ──────────────────────────────────────────

describe('dry run — one spec per major construct (plan → build → export)', () => {
  for (const c of CONSTRUCTS) {
    it(`${c.name}: ${c.construct}`, async () => {
      const spec = loadSpec(c.name);
      const fake = newFake();

      // plan: offline, no instance contact
      const planned = await route(fake.client, 'snow_flow_plan', { spec });
      expect(planned.ok, JSON.stringify(planned.errors ?? '')).toBe(true);
      expect(fake.state.calls).toEqual([]);
      const order = reviewOrder(planned.plan);
      expect(order.length).toBe(planned.rowCount);

      // build (loader, the default): reads, then ONE loader POST carrying every planned row, then read-back
      const built = await route(fake.client, 'snow_flow_build', { spec, instance: 'product', update_set: { sys_id: US } });
      const sig = callSignature(fake.state.calls);
      const firstUs = sig.indexOf('getRecord:sys_update_set');
      expect(firstUs).toBeGreaterThanOrEqual(0);
      const loadAt = sig.indexOf(`postMultipart:${LOADER_LOAD_PATH}/global`);
      expect(loadAt).toBeGreaterThan(firstUs);
      expect(fake.state.calls.slice(0, loadAt).every(isRead)).toBe(true);
      expect(fake.state.calls.slice(loadAt + 1).every(isRead)).toBe(true);
      const writes = writeCalls(fake.state.calls);
      expect(writes.map(w => w.method)).toEqual(['postMultipart']);
      expect(writes[0].params).toEqual({ targetUpdateSetId: US });
      const doc = writes[0].files![0].content;
      expect(assertWellFormed(doc)).toBe('record_update');
      expect(new Set(idsInDocument(doc))).toEqual(new Set(order.map(o => o.split(':')[1])));
      expect(sig.some(s => s.endsWith(':sys_user_preference'))).toBe(false);
      expect(sig[sig.length - 1]).toBe('queryRecords:sys_update_xml');
      expect(built.transport).toBe('loader');
      expect(built.flowState.version).toBe('2');
      expect(built.missing).toEqual([]);
      expect(built.capture.ok).toBe(true);
      expect(built.capture.mode).toBe('parent_row');
      expect(built.capture.found).toBe(order.length);
      expect(built.written).toHaveLength(order.length);
      expect(built.activation.attempted).toBe(false);

      // export: well-formed <unload> carrying every planned row
      const out = `${c.name}.xml`;
      const ex = await route(fake.client, 'snow_flow_export_xml', { spec, format: 'update_set', update_set_name: `TEST_${c.name.toUpperCase()}`, out_path: out });
      expect(ex.path).toBe(join(exportRoot, out));
      const xml = readFileSync(ex.path, 'utf8');
      expect(assertWellFormed(xml)).toBe('unload');
      const payloads = payloadsOf(xml);
      expect(payloads).toHaveLength(1);
      expect(assertWellFormed(payloads[0])).toBe('record_update');
      for (const id of order.map(o => o.split(':')[1])) expect(payloads[0]).toContain(`<sys_id>${id}</sys_id>`);
    });
  }
});

describe('assertWellFormed (the test helper itself)', () => {
  it('accepts well-formed documents and rejects the usual breakages', () => {
    expect(assertWellFormed('<?xml version="1.0"?><a x="1"><b/><c><![CDATA[<x>&]]></c>&amp;</a>')).toBe('a');
    for (const bad of ['<a><b></a></b>', '<a>', '<a></a><b/>', '<a>&nbsp;</a>', '<a x="1" x="2"/>', '<a x=1/>', 'text<a/>', '<a><![CDATA[x</a>']) {
      expect(() => assertWellFormed(bad), bad).toThrow();
    }
  });
});
