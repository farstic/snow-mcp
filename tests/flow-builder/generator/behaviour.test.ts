/**
 * Generator behaviour: the PDI-learned constructs (Flow Error Handler, UI-built trigger descriptors,
 * action_type snapshot/definition pairs), pill typing sources and warnings,
 * semantic validation (unknown / hidden / missing inputs, forward pills, zero-approver trap),
 * determinism, and the design's P1 example.
 *
 * Owner: GENERATOR.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { generatePlan, readCatalog, canonicalRow } from '../../../src/flow-builder/generator/index.js';
import { parseSpec } from '../../../src/flow-builder/spec/schema.js';
import { decodeValues } from '../../../src/flow-builder/encode.js';
import { sysIdFor, sysIdToUuid, ELEMENT_KEYS } from '../../../src/flow-builder/ids.js';
import { ACTION_DEFINITIONS } from '../../../src/flow-builder/catalog/actions.js';
import { uiDescriptorTemplate, UI_DESCRIPTOR_TRIGGER_NAMES } from '../../../src/flow-builder/catalog/ui-descriptors.js';
import { TOP_LEVEL_TRY_SYS_ID, TOP_LEVEL_CATCH_SYS_ID } from '../../../src/flow-builder/catalog/error-handler.js';
import type { FlowSpec, RecordRow } from '../../../src/flow-builder/spec/types.js';
import { loadSpec } from './plans.js';
import { contextOptions } from './context.js';

const PDI = join(__dirname, '..', 'fixtures', 'pdi');
const readPdi = (p: string) => JSON.parse(readFileSync(join(PDI, p), 'utf8')) as unknown;
const rowsOf = (v: unknown) => (Array.isArray(v) ? v : Array.isArray((v as { rows?: unknown[] }).rows) ? (v as { rows: unknown[] }).rows : [v]) as Record<string, unknown>[];

function spec(input: unknown): FlowSpec {
  const r = parseSpec(input);
  if ('errors' in r) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

const values = (row: RecordRow) => decodeValues(String(row.fields.values)) as Record<string, unknown>;

/** A small flow skeleton for focused tests. */
function flowWith(steps: unknown[], extra: Record<string, unknown> = {}) {
  return spec({ spec_version: '1', flow: { key: 'bt', name: 'BT' }, trigger: { key: 't', type: 'record.created', table: 'incident' }, steps, ...extra });
}

async function errorsOf(p: Promise<unknown>): Promise<string[]> {
  try { await p; return []; } catch (e) { return ((e as { details?: { errors?: string[] } }).details?.errors) ?? [String((e as Error).message)]; }
}

describe('Flow Error Handler (PDI error-handler-subflow-snapshot)', () => {
  it('TOP_LEVEL_TRY at order 0 wraps the body; TOP_LEVEL_CATCH carries the verbatim __status__ / enabled inputs; handler steps nest under the catch', async () => {
    const plan = await generatePlan(spec(loadSpec('pdi_error_handler')), contextOptions());
    const [tryRow, body, catchRow, handler] = plan.instances;
    expect(tryRow.fields.logic_definition).toBe(TOP_LEVEL_TRY_SYS_ID);
    expect(tryRow.fields.order).toBe('0');
    expect(tryRow.fields.parent_ui_id).toBeUndefined();
    expect(body.fields.parent_ui_id).toBe(tryRow.fields.ui_id);
    expect(body.fields.order).toBe('1');
    expect(catchRow.fields.logic_definition).toBe(TOP_LEVEL_CATCH_SYS_ID);
    expect(catchRow.fields.order).toBe('2');
    expect(catchRow.fields.parent_ui_id).toBeUndefined();
    expect(handler.fields.parent_ui_id).toBe(catchRow.fields.ui_id);
    expect(handler.fields.order).toBe('3');

    const pdiLogic = rowsOf(readPdi('flows/error-handler-subflow-snapshot/sys_hub_flow_logic_instance_v2.json'));
    const pdiTry = pdiLogic.find(r => r.logic_type === 'TOP_LEVEL_TRY')!;
    const pdiCatch = pdiLogic.find(r => r.logic_type === 'TOP_LEVEL_CATCH')!;
    expect(values(tryRow)).toEqual(pdiTry.values_decoded);
    expect(Object.keys(values(tryRow))).toEqual(Object.keys(pdiTry.values_decoded as object));
    expect(values(catchRow)).toEqual(pdiCatch.values_decoded);
    expect(Object.keys(values(catchRow))).toEqual(Object.keys(pdiCatch.values_decoded as object));

    const msg = decodeValues(String(handler.fields.values)) as { name: string; value: string }[];
    expect(msg.find(e => e.name === 'log_message')!.value).toBe(`Failed: {{${catchRow.fields.ui_id}.__status__.message}} ({{${catchRow.fields.ui_id}.__status__.code}})`);
    const lc = plan.labelCache as Record<string, unknown>[];
    const status = lc.find(e => e.name === `${catchRow.fields.ui_id}.__status__.message`)!;
    expect(status).toMatchObject({ label: '1 - Error Handler➛Error Status➛Message', type: 'string', reference: '', reference_display: 'Message' });
    expect(lc.find(e => e.name === `${catchRow.fields.ui_id}.__status__.code`)).toMatchObject({ type: 'integer' });
  });

  it('error.* pills outside the handler are rejected', async () => {
    const errs = await errorsOf(generatePlan(flowWith([{ kind: 'action', key: 'l', action: 'log', inputs: { log_message: { text: '{{error.message}}' } } }]), {}));
    expect(errs.join('\n')).toMatch(/only valid inside error_handler/);
  });
});

describe('UI-built trigger descriptors (FORMAT-DECISIONS D5)', () => {
  it('ship for Service Catalog, Daily, Repeat and Inbound Email', () => {
    expect([...UI_DESCRIPTOR_TRIGGER_NAMES].sort()).toEqual(['Daily', 'Inbound Email', 'Repeat', 'Service Catalog']);
  });

  it('the Service Catalog descriptor is the PDI leaver-flow entry with only value / display / triggerInstanceSysId set by the generator', async () => {
    const plan = await generatePlan(spec({ spec_version: '1', flow: { key: 'sc', name: 'SC' }, trigger: { key: 't', type: 'catalog.service_catalog', run_flow_in: 'foreground' }, steps: [] }));
    const entries = decodeValues(String(plan.trigger!.fields.trigger_inputs)) as Record<string, unknown>[];
    const pdi = rowsOf(readPdi('flows/leaver-flow/sys_hub_trigger_instance_v2.json'))[0].trigger_inputs_decoded as Record<string, unknown>[];
    expect(entries).toHaveLength(pdi.length);
    const strip = (e: Record<string, unknown>) => { const c = { ...e }; delete c.value; delete c.displayValue; delete c.triggerInstanceSysId; return c; };
    expect(entries.map(strip)).toEqual(pdi.map(strip));
    expect(Object.keys(entries[0])).toEqual(Object.keys(pdi[0]));
    expect(entries[0]).toMatchObject({ name: 'run_flow_in', value: 'foreground', displayValue: 'Run flow in foreground', triggerInstanceSysId: '' });
  });

  it('Inbound Email stores booleans as 1/0, integers as strings, and keeps the captured default for stop_condition_evaluation', async () => {
    const plan = await generatePlan(spec({ spec_version: '1', flow: { key: 'em', name: 'EM' }, trigger: { key: 't', type: 'email.inbound', email_conditions: 'type=received', order: 5 }, steps: [] }));
    const e = Object.fromEntries((decodeValues(String(plan.trigger!.fields.trigger_inputs)) as { name: string; value: unknown }[]).map(x => [x.name, x.value]));
    expect(e).toEqual({ email_conditions: 'type=received', order: '5', stop_condition_evaluation: '1', target_table: '' });
    expect(uiDescriptorTemplate('Created')).toBeUndefined();
  });

  it('Daily stores glide_time with the HH:MM:SS display value; record triggers use the generic descriptor built from the definition', async () => {
    const plan = await generatePlan(spec({ spec_version: '1', flow: { key: 'd', name: 'D' }, trigger: { key: 't', type: 'scheduled.daily', time: '22:00:00' }, steps: [] }));
    expect(decodeValues(String(plan.trigger!.fields.trigger_inputs))).toMatchObject([{ name: 'time', value: '1970-01-01 22:00:00', displayValue: '22:00:00' }]);
    const rec = await generatePlan(flowWith([]));
    const first = (decodeValues(String(rec.trigger!.fields.trigger_inputs)) as Record<string, unknown>[])[0];
    expect(Object.keys(first).slice(0, 3)).toEqual(['triggerInstanceSysId', 'label', 'internalType']);
  });
});

describe('action_type / action_type_parent (FORMAT-DECISIONS D6)', () => {
  it('uses the snapshot in action_type and its definition (sys_hub_action_type_snapshot.parent_action) in action_type_parent', async () => {
    const plan = await generatePlan(flowWith([
      { kind: 'action', key: 'l', action: 'log', inputs: { log_message: 'x' } },
      { kind: 'action', key: 'g', action: 'getCatalogVariables', inputs: { requested_item: { pill: 'trigger.current' }, template_catalog_item: { reference: 'a'.repeat(32) } } },
      { kind: 'action', key: 'n', action: 'addWorknoteLinkToContext', inputs: { table: 'incident', record: { pill: 'trigger.current' }, journal_field: 'work_notes' } },
    ]));
    expect(plan.instances[0].fields).toMatchObject({ action_type: '5bc1bcc6531003003bf1d9109ec587d4', action_type_parent: '0e0ae8c2531003003bf1d9109ec587c8' });
    expect(plan.instances[1].fields).toMatchObject({ action_type: '330ba3abc31013002841b63b12d3aee8', action_type_parent: '22f0b88cc3c632002841b63b12d3aeff' });
    // every catalogue action carries its definition (catalogue built from the instance's snapshot rows)
    expect(plan.instances[2].fields).toMatchObject({ action_type: 'fd4a0fb70f003300ecf0cc52ff767e2a', action_type_parent: 'ae790f770f003300ecf0cc52ff767efa' });
    expect(Object.keys(ACTION_DEFINITIONS)).toHaveLength(33);
    for (const ids of Object.values(ACTION_DEFINITIONS)) expect(ids.definition).not.toBe(ids.snapshot);
  });

  it('resolveActionType overrides both ids per instance', async () => {
    const plan = await generatePlan(flowWith([{ kind: 'action', key: 'l', action: 'log', inputs: { log_message: 'x' } }]), {
      resolveActionType: async a => (a.key === 'log' ? { snapshot: 'c'.repeat(32), definition: 'd'.repeat(32) } : undefined),
    });
    expect(plan.instances[0].fields).toMatchObject({ action_type: 'c'.repeat(32), action_type_parent: 'd'.repeat(32) });
  });
});

describe('pill typing', () => {
  it('uses resolvePillType for record fields and falls back to string with a warning when unresolved', async () => {
    const s = flowWith([{ kind: 'action', key: 'l', action: 'log', inputs: { log_message: { text: '{{trigger.current.priority}} {{trigger.current.nope}}' } } }]);
    const plan = await generatePlan(s, { resolvePillType: async (t, p) => (t === 'incident' && p === 'priority' ? 'integer' : undefined) });
    const lc = plan.labelCache as Record<string, unknown>[];
    expect(lc.find(e => e.name === 'Created_1.current.priority')).toMatchObject({ type: 'integer', base_type: 'integer', parent_table_name: 'incident', column_name: 'priority' });
    expect(lc.find(e => e.name === 'Created_1.current.nope')).toMatchObject({ type: 'string' });
    expect(plan.warnings.join('\n')).toMatch(/incident\.nope not found in the dictionary/);
    const offline = await generatePlan(s);
    expect(offline.warnings.join('\n')).toMatch(/no dictionary resolver/);
    expect(offline.pills.map(p => p.platform)).toEqual(['Created_1.current.priority', 'Created_1.current.nope']);
  });

  it('flow-variable types come from the spec; label_cache base keys stay first and the UI keys follow', async () => {
    const plan = await generatePlan(flowWith(
      [{ kind: 'action', key: 'l', action: 'log', inputs: { log_message: { text: '{{vars.count}}' } } }, { kind: 'action', key: 'u', action: 'updateRecord', inputs: { table_name: 'incident', record: { pill: 'trigger.current' }, values: { template: { impact: '1' } } } }],
      { variables: [{ name: 'count', type: 'integer' }] },
    ));
    const lc = plan.labelCache as Record<string, unknown>[];
    expect(lc[0]).toEqual({ name: 'flow_variable.count', label: 'Flow Variables➛Count', type: 'integer', base_type: 'integer', usedInstances: { [String(plan.instances[0].fields.ui_id)]: ['log_message'] }, attributes: {}, reference_table: null, reference_display: null });
    expect(Object.keys(lc[1])).toEqual(['name', 'label', 'type', 'base_type', 'usedInstances', 'attributes', 'reference']);
    expect(lc[1].reference).toBe('incident');
  });
});

describe('semantic validation', () => {
  it('rejects unknown actions / inputs, hidden inputs and missing mandatory inputs', async () => {
    const errs = await errorsOf(generatePlan(flowWith([
      { kind: 'action', key: 'a', action: 'noSuchAction' },
      { kind: 'action', key: 'b', action: 'log', inputs: { log_mesage: 'x' } },
      { kind: 'action', key: 'c', action: 'recordProducer', inputs: { catalog_item: 'a'.repeat(32), record_table: 'x' } },
      { kind: 'action', key: 'd', action: 'updateRecord', inputs: { table_name: 'incident' } },
    ])));
    const all = errs.join('\n');
    expect(all).toMatch(/unknown action "noSuchAction"/);
    expect(all).toMatch(/unknown input "log_mesage"/);
    expect(all).toMatch(/"record_table" is hidden/);
    expect(all).toMatch(/mandatory input "record" is missing/);
  });

  it('rejects a pill to a step that runs later', async () => {
    const errs = await errorsOf(generatePlan(flowWith([
      { kind: 'action', key: 'a', action: 'log', inputs: { log_message: { text: '{{steps.b.Record}}' } } },
      { kind: 'action', key: 'b', action: 'lookUpRecord', inputs: { table: 'incident' } },
    ])));
    expect(errs.join('\n')).toMatch(/refers to step "b" which runs later/);
  });

  it('rejects a string-typed pill in an approver slot (the zero-approver trap)', async () => {
    const errs = await errorsOf(generatePlan(flowWith([
      { kind: 'action', key: 'ap', action: 'askForApproval', inputs: { table: 'incident', record: { pill: 'trigger.current' }, approval_conditions: { approval_rules: { rule_sets: [{ action: 'Approves', rules: [[{ rule: 'Any', groups: [{ pill: 'trigger.current.short_description' }] }]] }] } } } },
    ]), { resolvePillType: async () => 'string' }));
    expect(errs.join('\n')).toMatch(/approver pill "trigger.current.short_description" is string-typed/);
  });

  const approverSteps = [
    { kind: 'action', key: 'ap', action: 'askForApproval', inputs: { table: 'incident', record: { pill: 'trigger.current' }, approval_conditions: { approval_rules: { rule_sets: [{ action: 'Approves', rules: [[{ rule: 'Any', groups: [{ pill: 'trigger.current.assignment_group' }] }]] }] } } } },
  ];
  const withPillTypes = (types: Record<string, string>) => spec({ spec_version: '1', flow: { key: 'bt', name: 'BT', pill_types: types }, trigger: { key: 't', type: 'record.created', table: 'incident' }, steps: approverSteps });

  it('FAILS CLOSED on an untyped approver pill: offline (no resolver) and a failed dictionary walk are errors by default', async () => {
    // regression: an unresolved approver pill used to be skipped (`if (info.unresolved) continue`) — every offline plan and export
    const offline = await errorsOf(generatePlan(flowWith(approverSteps)));
    expect(offline.join('\n')).toMatch(/approver pill "trigger.current.assignment_group" could not be typed/);
    expect(offline.join('\n')).toMatch(/flow\.pill_types/);
    const walkFailed = await errorsOf(generatePlan(flowWith(approverSteps), { resolvePillType: async () => undefined }));
    expect(walkFailed.join('\n')).toMatch(/could not be typed/);
  });

  it("approverPillPolicy 'report' (snow_flow_plan) lists the unverified approver instead of failing", async () => {
    const plan = await generatePlan(flowWith(approverSteps), { approverPillPolicy: 'report' });
    expect(plan.unverifiedApprovers).toEqual([{ step: 'ap', pill: 'trigger.current.assignment_group' }]);
    expect(plan.warnings.some(w => w.includes('UNVERIFIED'))).toBe(true);
    const typed = await generatePlan(flowWith(approverSteps), { approverPillPolicy: 'report', resolvePillType: async () => 'reference' });
    expect(typed.unverifiedApprovers).toBeUndefined();
  });

  it('flow.pill_types types a record-field pill offline (before the resolver), fixing the approver check and the label_cache type', async () => {
    const resolver = vi.fn(async () => 'string');
    const plan = await generatePlan(withPillTypes({ 'trigger.current.assignment_group': 'reference' }), { resolvePillType: resolver });
    expect(resolver).not.toHaveBeenCalled(); // the declaration is authoritative
    expect(plan.pills.find(p => p.symbolic === 'trigger.current.assignment_group')?.type).toBe('reference');
    const lc = plan.labelCache as { name: string; type: string }[];
    expect(lc.find(e => e.name.includes('assignment_group'))?.type).toBe('reference');
    expect(plan.warnings.some(w => w.includes('assignment_group'))).toBe(false);
    // a declared string type is still refused in an approver slot
    const errs = await errorsOf(generatePlan(withPillTypes({ 'trigger.current.assignment_group': 'string' })));
    expect(errs.join('\n')).toMatch(/is string-typed/);
  });

  it('flow.pill_types keys must be valid symbolic pills', () => {
    const r = parseSpec({ spec_version: '1', flow: { key: 'bt', name: 'BT', pill_types: { 'not a pill': 'reference' } }, trigger: { key: 't', type: 'record.created', table: 'incident' }, steps: [] });
    expect('errors' in r).toBe(true);
  });

  it('fills the UI due_date default when askForApproval omits it', async () => {
    const plan = await generatePlan(flowWith([
      { kind: 'action', key: 'ap', action: 'askForApproval', inputs: { table: 'incident', record: { pill: 'trigger.current' }, approval_conditions: { approval_rules: { rule_sets: [{ action: 'Approves', rules: [[{ rule: 'Any', groups: [{ pill: 'trigger.current.assignment_group' }] }]] }] } } } },
    ]), { resolvePillType: async () => 'reference' });
    const e = (decodeValues(String(plan.instances[0].fields.values)) as { name: string; value: string }[]).find(x => x.name === 'due_date')!;
    expect(e.value).toBe('{"action":"none","date_type":"actual","date":"{{}}","duration":1,"duration_type":"days","schedule":"","schedule_label":""}');
  });
});

describe('structure, stages and determinism', () => {
  it('generates the design P1 example exactly as the design describes it', async () => {
    const plan = await generatePlan(spec(loadSpec('p1_incident_review')), { resolvePillType: async (_t, p) => (p === 'assignment_group' ? 'reference' : 'string') });
    expect(plan.instances.map(r => `${r.fields.order}:${r.table === 'sys_hub_action_instance_v2' ? 'A' : 'L'}`)).toEqual(['1:A', '2:A', '3:L', '4:A', '5:A', '6:L', '7:L']);
    const [, , ifRow, approve, logResult, elseRow, end] = plan.instances;
    expect(approve.fields.parent_ui_id).toBe(ifRow.fields.ui_id);
    expect(logResult.fields.parent_ui_id).toBe(ifRow.fields.ui_id);
    expect(elseRow.fields.parent_ui_id).toBeUndefined();
    expect(end.fields.parent_ui_id).toBe(elseRow.fields.ui_id);
    const ap = decodeValues(String(approve.fields.values)) as { name: string; value: string }[];
    expect(ap.find(e => e.name === 'approval_conditions')!.value).toBe('ApprovesAnyG[{{Created_1.current.assignment_group}}]');
    expect(plan.flow.fields).toMatchObject({ run_as: 'system', status: 'draft', active: 'false', version: '2', internal_name: 'p1_incident_review', flow_priority: '' });
    const tpl = decodeValues(String(plan.instances[1].fields.values)) as { name: string; value: string }[];
    expect(tpl.find(e => e.name === 'values')!.value).toBe('impact=1^work_notes=Auto-tagged by P1 review flow ({{Created_1.current.number}})^EQ');
  });

  it('is deterministic, honours flow.sys_id and derives every id from the flow key', async () => {
    // offline: the untyped approver pill is reported, not fatal, so the id derivation can be compared
    const a = await generatePlan(spec(loadSpec('p1_incident_review')), { approverPillPolicy: 'report' });
    const b = await generatePlan(spec(loadSpec('p1_incident_review')), { approverPillPolicy: 'report' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.flow.sys_id).toBe(sysIdFor('p1_incident_review', ELEMENT_KEYS.flow));
    expect(a.instances[0].sys_id).toBe(sysIdFor('p1_incident_review', ELEMENT_KEYS.step('log_p1')));
    expect(a.instances[0].fields.ui_id).toBe(sysIdToUuid(a.instances[0].sys_id));
    const adopted = spec({ ...(loadSpec('p1_incident_review') as object), flow: { key: 'p1_incident_review', name: 'P1', sys_id: 'e'.repeat(32) } });
    const c = await generatePlan(adopted, { approverPillPolicy: 'report' });
    expect(c.flow.sys_id).toBe('e'.repeat(32));
    expect(c.instances.every(r => r.fields.flow === 'e'.repeat(32))).toBe(true);
  });

  it('stages: UI states JSON, component_indexes = flat order − 1 per entry point, stage_id = uuid of the row', async () => {
    const plan = await generatePlan(flowWith([
      { kind: 'action', key: 'a', action: 'log', stage: 'one', inputs: { log_message: 'x' } },
      { kind: 'if', key: 'i', condition: 'active=true', then: [{ kind: 'action', key: 'b', action: 'log', stage: 'two', inputs: { log_message: 'y' } }],
        else: { key: 'e', steps: [{ kind: 'action', key: 'c', action: 'log', stage: 'two', inputs: { log_message: 'z' } }] } },
    ], { stages: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two', duration: { days: 2 }, always_show: true }] }));
    expect(plan.stages.map(s => [s.fields.value, s.fields.component_indexes, s.fields.order, s.fields.duration, s.fields.always_show])).toEqual([
      ['one', '0', '0', '1970-01-01 00:00:00', 'false'], ['two', '2,4', '1', '1970-01-03 00:00:00', 'true'],
    ]);
    expect(JSON.parse(String(plan.stages[0].fields.states))).toEqual({ pending: 'Pending - has not started', inprogress: 'In progress', skipped: 'Skipped', complete: 'Completed', error: 'Error' });
    expect(plan.stages[0].fields.stage_id).toBe(sysIdToUuid(plan.stages[0].sys_id));
  });

  it('do_in_parallel: block rows take plain orders, the first child of each block the composite order', async () => {
    const plan = await generatePlan(flowWith([{ kind: 'do_in_parallel', key: 'p', branches: [
      { key: 'b1', steps: [{ kind: 'action', key: 'a1', action: 'log', inputs: { log_message: 'a' } }, { kind: 'action', key: 'a2', action: 'log', inputs: { log_message: 'b' } }] },
      { key: 'b2', steps: [{ kind: 'action', key: 'c1', action: 'log', inputs: { log_message: 'c' } }] },
    ] }, { kind: 'action', key: 'after', action: 'log', inputs: { log_message: 'd' } }]));
    expect(plan.instances.map(r => String(r.fields.order))).toEqual(['1', '2', '2➛3', '4', '5', '5➛6', '7']);
    const [par, b1, a1, , b2] = plan.instances;
    expect(b1.fields.parent_ui_id).toBe(par.fields.ui_id);
    expect(a1.fields.parent_ui_id).toBe(b1.fields.ui_id);
    expect(b2.fields.parent_ui_id).toBe(par.fields.ui_id);
  });
});

describe('escape hatches', () => {
  it('a custom trigger builds minimal descriptor entries and warns', async () => {
    const plan = await generatePlan(spec({ spec_version: '1', flow: { key: 'ct', name: 'CT' }, trigger: { key: 't', type: 'custom', definition: 'a'.repeat(32), trigger_type: 'rest_async', name: 'REST API - Asynchronous', inputs: { path: '/x' } }, steps: [] }));
    expect(plan.trigger!.fields).toMatchObject({ name: 'REST API - Asynchronous', trigger_definition: 'a'.repeat(32), trigger_type: 'rest_async' });
    expect(decodeValues(String(plan.trigger!.fields.trigger_inputs))).toMatchObject([{ name: 'path', value: '/x' }]);
    expect(plan.warnings.join('\n')).toMatch(/custom trigger/);
  });

  it('a subflow by name needs an instance; a custom action by sys_id without a resolver infers types and warns', async () => {
    const errs = await errorsOf(generatePlan(flowWith([{ kind: 'subflow', key: 's', subflow: { name: 'My Sub' } }])));
    expect(errs.join('\n')).toMatch(/needs an instance to resolve the sys_id/);
    const plan = await generatePlan(flowWith([{ kind: 'custom_action', key: 'c', definition: { sys_id: 'b'.repeat(32) }, inputs: { rec: { pill: 'trigger.current' }, flag: true, n: 3 } }]));
    expect((decodeValues(String(plan.instances[0].fields.values)) as { name: string; parameter: { type: string } }[]).map(e => [e.name, e.parameter.type])).toEqual([['rec', 'reference'], ['flag', 'boolean'], ['n', 'integer']]);
    expect(plan.instances[0].fields).toMatchObject({ action_type: 'b'.repeat(32), action_type_parent: 'b'.repeat(32) });
    expect(plan.warnings.join('\n')).toMatch(/not resolved — input types are inferred/);
  });
});

describe('structure (continued)', () => {

  it('condition labels (condition_name) are written when a step carries one', async () => {
    const s = flowWith([{ kind: 'if', key: 'i', condition: 'active=true', then: [] }]);
    (s.steps[0] as { label?: string }).label = 'Is active';
    const plan = await generatePlan(s);
    expect((values(plan.instances[0]).inputs as { name: string }[]).map(e => e.name)).toEqual(['condition_name', 'condition']);
  });

  it('canonicalRow orders fields sys_id, sys_scope, then alphabetically', () => {
    expect(Object.keys(canonicalRow({ table: 't', sys_id: 'x', fields: { z: 1, sys_scope: 'g', a: 2, sys_id: 'x' } }).fields)).toEqual(['sys_id', 'sys_scope', 'a', 'z']);
  });
});

describe('readCatalog (snow_flow_catalog_read)', () => {
  it('lists the 13 triggers, 33 core actions and every logic kind incl. the error handler', () => {
    const all = readCatalog();
    expect(all.filter(e => e.kind === 'trigger')).toHaveLength(13);
    expect(all.filter(e => e.kind === 'action')).toHaveLength(33);
    const logic = all.filter(e => e.kind === 'logic').map(e => e.name);
    for (const k of ['if', 'else_if', 'else', 'for_each', 'end_flow', 'set_variables', 'append_variables', 'assign_subflow_outputs', 'wait', 'try', 'catch', 'do_in_parallel', 'parallel_block', 'do_until', 'exit_loop', 'skip_iteration', 'error_handler.try', 'error_handler.catch']) expect(logic).toContain(k);
  });

  it('filters by key, label or spec type, case-insensitively', () => {
    expect(readCatalog('Look Up Record').map(e => e.name)).toEqual(['lookUpRecord']);
    expect(readCatalog('record_create').map(e => e.name)).toEqual(['record.created']);
    const gcv = readCatalog('getCatalogVariables')[0] as { sys_id: string; action_type_parent?: string };
    expect(gcv.sys_id).toBe('330ba3abc31013002841b63b12d3aee8');
    expect(gcv.action_type_parent).toBe('22f0b88cc3c632002841b63b12d3aeff');
  });
});

describe('dont_fail_on_error spec name and its earlier alias', () => {
  const lookup = (inputs: Record<string, unknown>) => flowWith([
    { kind: 'action', key: 'lk', action: 'lookUpRecord', inputs: { table: 'incident', conditions: 'active=true', ...inputs } },
  ]);
  const stored = async (inputs: Record<string, unknown>) => {
    const plan = await generatePlan(lookup(inputs), contextOptions());
    const row = plan.instances.find(r => r.table === 'sys_hub_action_instance_v2')!;
    return (decodeValues(String(row.fields.values)) as { name: string; value: unknown }[]).find(e => e.name === '__snc_dont_fail_on_error');
  };

  it('dont_fail_on_error and dont_fail_flow_on_error both set the stored __snc_dont_fail_on_error input and produce the same row', async () => {
    const canonical = await stored({ dont_fail_on_error: true });
    const alias = await stored({ dont_fail_flow_on_error: true });
    expect(canonical).toMatchObject({ name: '__snc_dont_fail_on_error', value: true });
    expect(alias).toEqual(canonical);
  });

  it('the single-underscore _snc_dont_fail_on_error inputs accept the alias too', async () => {
    const plan = await generatePlan(flowWith([
      { kind: 'action', key: 'sub', action: 'submitCatalogItemRequest', inputs: { catalog_item: { reference: '0000000000000000000000000000d001', display: 'Example Item' }, dont_fail_flow_on_error: true } },
    ]), contextOptions());
    const row = plan.instances.find(r => r.table === 'sys_hub_action_instance_v2')!;
    const entries = decodeValues(String(row.fields.values)) as { name: string; value: unknown }[];
    expect(entries.filter(e => /snc_dont_fail_on_error$/.test(e.name))).toEqual([expect.objectContaining({ name: '_snc_dont_fail_on_error', value: true })]);
  });

  it('setting both names on one step is a spec error', async () => {
    const errors = await errorsOf(generatePlan(lookup({ dont_fail_on_error: true, dont_fail_flow_on_error: false }), contextOptions()));
    expect(errors.join('\n')).toMatch(/is set more than once \(dont_fail_on_error, dont_fail_flow_on_error\)/);
  });
});
