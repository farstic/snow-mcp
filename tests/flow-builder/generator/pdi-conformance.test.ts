/**
 * Conformance of the generated rows with UI-built rows read on the PDI (tests/flow-builder/fixtures/pdi,
 * PDI-FACTS.md): for every construct a UI-built fixture covers, the parts of the stored form the generator
 * writes must match what Workflow Studio stored — sys_ids of definitions, input names and their order,
 * value encodings, key order of the gzip+base64 `values` objects, the block / order / parent structure.
 *
 * Deliberate, documented differences (src/flow-builder/FORMAT-DECISIONS.md) are not asserted here: the
 * generator writes a minimal entry (no full `parameter` mirror, only the inputs that carry a value) that the
 * platform expands itself when the flow is activated (live loader runs).
 *
 * Owner: GENERATOR.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { generatePlan, maxLengthFor } from '../../../src/flow-builder/generator/index.js';
import { parseSpec } from '../../../src/flow-builder/spec/schema.js';
import { decodeValues } from '../../../src/flow-builder/encode.js';
import { findAction, actionTypeIds } from '../../../src/flow-builder/catalog/actions.js';
import { findLogic } from '../../../src/flow-builder/catalog/logic.js';
import type { FlowSpec, RecordPlan, RecordRow } from '../../../src/flow-builder/spec/types.js';
import { loadSpec, pdiRows, planRows, readPdi, specNames, type DRow } from './plans.js';
import { planFor } from './context.js';

type Entry = Record<string, unknown> & { name: string; value?: unknown; displayValue?: unknown; parameter?: Record<string, unknown> };
type LogicValues = Record<string, Entry[]>;

function spec(input: unknown): FlowSpec {
  const r = parseSpec(input);
  if ('errors' in r) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

const flowWith = (steps: unknown[], trigger: unknown = { key: 't', type: 'record.created', table: 'incident' }) =>
  spec({ spec_version: '1', flow: { key: 'conf', name: 'Conformance' }, trigger, steps });

const logicSysId = (key: string) => findLogic(key)!.sys_id;
const logicRows = (plan: RecordPlan, key: string) => plan.instances.filter(r => r.table === 'sys_hub_flow_logic_instance_v2' && r.fields.logic_definition === logicSysId(key));
const actionRows = (plan: RecordPlan, actionKey: string) => {
  const ids = actionTypeIds(findAction(actionKey)!);
  return plan.instances.filter(r => r.table === 'sys_hub_action_instance_v2' && r.fields.action_type === ids.snapshot);
};
const valuesOf = <T = Entry[]>(r: RecordRow | DRow | Record<string, unknown>, key = 'values'): T => {
  const f = 'fields' in r && typeof r.fields === 'object' ? (r.fields as Record<string, unknown>) : (r as Record<string, unknown>);
  const decodedKey = `${key}_decoded`;
  return (decodedKey in f ? f[decodedKey] : decodeValues(String(f[key]))) as T;
};
/** True when `sub` appears in `full` in the same relative order. */
const isSubsequence = (sub: string[], full: string[]) => { let i = 0; for (const x of full) if (x === sub[i]) i++; return i === sub.length; };

/** Every construct plan, generated once. */
const allPlans = async () => Promise.all(specNames().map(async n => ({ name: n, plan: await planFor(n) })));

// ─── gzip + base64 values ─────────────────────────────────────────────────────

describe('values blobs (PDI break-continue-instances, dountil-timer-subflow)', () => {
  const pdiLogic = [...pdiRows('samples/break-continue-instances.json'), ...pdiRows('flows/dountil-timer-subflow/sys_hub_flow_logic_instance_v2.json')];
  const UI_KEY_ORDER = Object.keys(pdiLogic[0].values_decoded as object);

  it('the UI key order of a logic values object is the same on every UI-built row', () => {
    expect(UI_KEY_ORDER).toEqual(['outputsToAssign', 'inputs', 'variables', 'decisionTableInputs', 'dynamicInputs', 'workflowInputs']);
    for (const r of [...pdiLogic, ...pdiRows('flows/parallel-change-implement-snapshot/sys_hub_flow_logic_instance_v2.json'), ...pdiRows('samples/for-each-instances.json')]) {
      expect(Object.keys(r.values_decoded as object)).toEqual(UI_KEY_ORDER);
    }
  });

  it('every logic row of every construct spec uses the UI key order', async () => {
    let n = 0;
    for (const { name, plan } of await allPlans()) {
      for (const r of plan.instances.filter(x => x.table === 'sys_hub_flow_logic_instance_v2')) {
        expect(Object.keys(valuesOf<object>(r)), `${name} order ${String(r.fields.order)}`).toEqual(UI_KEY_ORDER);
        n++;
      }
    }
    expect(n).toBeGreaterThan(40);
  });

  it('an empty logic row (Break / Continue / End / Try / Catch / Parallel / Parallel Branch / Else) has the byte-identical deflate stream of the UI blob; only the gzip OS header byte differs', async () => {
    const ui = Buffer.from(String(pdiRows('samples/break-continue-instances.json')[0].values), 'base64');
    const plan = await planFor('flow_logic');
    const kinds = ['exit_loop', 'skip_iteration', 'try', 'catch', 'do_in_parallel', 'parallel_block'];
    const triage = await planFor('incident_triage');
    const rows = [...kinds.flatMap(k => logicRows(plan, k)), ...logicRows(triage, 'else'), ...logicRows(triage, 'end_flow')];
    expect(rows.length).toBeGreaterThanOrEqual(kinds.length + 2);
    for (const r of rows) {
      const ours = Buffer.from(String(r.fields.values), 'base64');
      expect(ours.subarray(10).equals(ui.subarray(10)), String(r.fields.order)).toBe(true);
      expect(ours.subarray(0, 9).equals(ui.subarray(0, 9))).toBe(true);
      expect(valuesOf<object>(r)).toEqual(pdiRows('samples/break-continue-instances.json')[0].values_decoded);
    }
  });
});

// ─── flow logic ───────────────────────────────────────────────────────────────

describe('flow logic against UI-built rows', () => {
  it('Break / Continue: the logic definitions of the UI rows, nested under their loop', async () => {
    const ui = pdiRows('samples/break-continue-instances.json');
    const byType = Object.fromEntries(ui.map(r => [r.logic_type, r]));
    expect(logicSysId('exit_loop')).toBe(byType.BREAK.logic_definition);
    expect(logicSysId('skip_iteration')).toBe(byType.CONTINUE.logic_definition);
    for (const r of ui) expect(r.parent_ui_id).not.toBe('');
    const plan = await planFor('flow_logic');
    const loop = logicRows(plan, 'for_each')[0];
    for (const k of ['exit_loop', 'skip_iteration']) {
      const row = logicRows(plan, k)[0];
      const parentIf = plan.instances.find(x => x.fields.ui_id === row.fields.parent_ui_id)!;
      expect(parentIf.fields.parent_ui_id).toBe(loop.fields.ui_id);
    }
  });

  it('For Each: one `items` input whose value and display value are the same step-output pill, as in the UI rows', async () => {
    const ui = pdiRows('samples/for-each-instances.json').map(r => valuesOf<LogicValues>(r).inputs);
    for (const inputs of ui) {
      expect(inputs.map(e => e.name)).toEqual(['items']);
      expect(inputs[0].displayValue).toBe(inputs[0].value);
    }
    expect(String(ui[0][0].value)).toMatch(/^\{\{[0-9a-f-]{36}\.Records\}\}$/);
    const plan = await planFor('flow_logic');
    const [first, second] = logicRows(plan, 'for_each').map(r => valuesOf<LogicValues>(r).inputs);
    const lookup = actionRows(plan, 'lookUpRecords')[0];
    expect(first.map(e => e.name)).toEqual(['items']);
    expect(first[0].value).toBe(`{{${String(lookup.fields.ui_id)}.Records}}`);
    expect(first[0].displayValue).toBe(first[0].value);
    // an array flow variable: the UI stores {{flow_variable.<name>}} (samples/for-each-instances.json)
    expect(ui.some(i => i[0].value === '{{flow_variable.trainings}}')).toBe(true);
    expect(second[0].value).toBe('{{flow_variable.entries}}');
  });

  it('Do Until: condition_name then condition, the condition an encoded query over step-output pills (dountil-timer-subflow)', async () => {
    const ui = pdiRows('flows/dountil-timer-subflow/sys_hub_flow_logic_instance_v2.json').find(r => r.logic_type === 'DOUNTIL')!;
    expect(ui.logic_definition).toBe(logicSysId('do_until'));
    const uiInputs = valuesOf<LogicValues>(ui).inputs;
    const plan = await planFor('flow_logic');
    const ours = valuesOf<LogicValues>(logicRows(plan, 'do_until')[0]).inputs;
    expect(ours.map(e => e.name)).toEqual(uiInputs.map(e => e.name));
    for (const list of [ours, uiInputs]) {
      expect(list[1].displayValue).toBe(list[1].value);
      expect(String(list[1].value)).toMatch(/^\{\{[0-9a-f-]{36}\.Record\.state\}\}=/);
    }
  });

  it('Wait for a duration: the seven timer inputs in the UI order with the UI input ids, duration_type / timer_duration in the UI storage form', async () => {
    const uiTimers = pdiRows('flows/dountil-timer-subflow/sys_hub_flow_logic_instance_v2.json').filter(r => r.logic_type === 'TIMER');
    expect(uiTimers.length).toBe(2);
    const uiInputs = valuesOf<LogicValues>(uiTimers[0]).inputs;
    expect(uiTimers[0].logic_definition).toBe(logicSysId('wait'));
    const plan = await planFor('flow_logic');
    const waits = logicRows(plan, 'wait').map(r => valuesOf<LogicValues>(r).inputs);
    expect(waits.length).toBe(4);
    for (const ours of waits) {
      expect(ours.map(e => e.name)).toEqual(uiInputs.map(e => e.name));
      expect(ours.map(e => e.id)).toEqual(uiInputs.map(e => e.parameter!.id));
    }
    const explicit = waits[0];
    expect(explicit[0]).toMatchObject({ value: uiInputs[0].value, displayValue: uiInputs[0].displayValue }); // explicit_duration / Explicit duration
    expect(String(explicit[3].value)).toMatch(/^1970-01-01 \d\d:\d\d:\d\d$/);
    expect(String(uiInputs[3].value)).toMatch(/^1970-01-01 \d\d:\d\d:\d\d$/);
  });

  it('Set Flow Variables: `variables` and `inputs` list the assigned variables in assignment order and flow_variables_assigned names them (set-flow-variables-instances)', async () => {
    const check = (r: Record<string, unknown>, values: LogicValues) => {
      const names = values.variables.map(e => e.name);
      expect(values.inputs.map(e => e.name)).toEqual(names);
      expect(r.flow_variables_assigned).toBe(names.join(','));
    };
    for (const r of pdiRows('samples/set-flow-variables-instances.json')) check(r, valuesOf<LogicValues>(r));
    const plan = await planFor('flow_logic');
    const rows = logicRows(plan, 'set_variables');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      check(r.fields, valuesOf<LogicValues>(r));
      // variables[].id is the sys_hub_flow_variable sys_id (UI: PDI-FACTS §6)
      for (const e of valuesOf<LogicValues>(r).variables) {
        expect(plan.variables.find(v => v.table === 'sys_hub_flow_variable' && v.fields.element === e.name)?.sys_id).toBe(e.id);
      }
    }
  });

  it('Assign Subflow Outputs: `outputsToAssign` carries the outputs, `inputs` is empty and outputs_assigned names them (assign-subflow-outputs-instances)', async () => {
    const check = (r: Record<string, unknown>, values: LogicValues) => {
      expect(values.inputs).toEqual([]);
      expect(r.outputs_assigned).toBe(values.outputsToAssign.map(e => e.name).join(','));
    };
    const ui = pdiRows('samples/assign-subflow-outputs-instances.json');
    for (const r of ui) check(r, valuesOf<LogicValues>(r));
    const plan = await planFor('level_check_subflow');
    const rows = logicRows(plan, 'assign_subflow_outputs');
    expect(rows.length).toBe(2);
    for (const r of rows) check(r.fields, valuesOf<LogicValues>(r));
  });

  it('Do In Parallel: blocks under the parallel row with plain orders; the first child of a block carries "<block order>➛<order>", later children plain (parallel-change-implement-snapshot)', async () => {
    const shape = (logic: { ui_id: unknown; parent_ui_id: unknown; order: unknown; kind: string }[], actions: { parent_ui_id: unknown; order: unknown }[]) => {
      const par = logic.find(r => r.kind === 'parallel')!;
      const blocks = logic.filter(r => r.kind === 'block');
      expect(par.parent_ui_id || '').toBe('');
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      for (const b of blocks) {
        expect(b.parent_ui_id).toBe(par.ui_id);
        expect(String(b.order)).toMatch(/^\d+$/);
        const children = [...logic.filter(r => r.parent_ui_id === b.ui_id), ...actions.filter(r => r.parent_ui_id === b.ui_id)]
          .map(r => String(r.order)).sort((x, y) => parseInt(x.split('➛').pop()!) - parseInt(y.split('➛').pop()!));
        expect(children[0]).toBe(`${String(b.order)}➛${Number(b.order) + 1}`);
        for (const c of children.slice(1)) expect(c).toMatch(/^\d+$/);
      }
    };
    const uiLogic = pdiRows('flows/parallel-change-implement-snapshot/sys_hub_flow_logic_instance_v2.json');
    expect(uiLogic.find(r => r.logic_type === 'PARALLEL')!.logic_definition).toBe(logicSysId('do_in_parallel'));
    expect(uiLogic.find(r => r.logic_type === 'PARALLELBLOCK')!.logic_definition).toBe(logicSysId('parallel_block'));
    const kindOf = (t: unknown) => (t === 'PARALLEL' ? 'parallel' : t === 'PARALLELBLOCK' ? 'block' : 'other');
    const uiSteps = [...pdiRows('flows/parallel-change-implement-snapshot/sys_hub_action_instance_v2.json'), ...pdiRows('flows/parallel-change-implement-snapshot/sys_hub_sub_flow_instance_v2.json')];
    shape(uiLogic.map(r => ({ ...r, kind: kindOf(r.logic_type) })) as never, uiSteps as never);

    const plan = await planFor('flow_logic');
    const kind = (r: RecordRow) => (r.fields.logic_definition === logicSysId('do_in_parallel') ? 'parallel' : r.fields.logic_definition === logicSysId('parallel_block') ? 'block' : 'other');
    const logic = plan.instances.filter(r => r.table === 'sys_hub_flow_logic_instance_v2').map(r => ({ ...r.fields, kind: kind(r) }));
    const actions = plan.instances.filter(r => r.table !== 'sys_hub_flow_logic_instance_v2').map(r => r.fields);
    shape(logic as never, actions as never);
  });
});

// ─── actions ──────────────────────────────────────────────────────────────────

describe('actions against UI-built rows', () => {
  const UI_ACTIONS: { file: string; key: string }[] = [
    { file: 'flows/leaver-flow/sys_hub_action_instance_v2.json', key: 'log' },
    { file: 'flows/leaver-flow/sys_hub_action_instance_v2.json', key: 'sendNotification' },
    { file: 'flows/leaver-flow/sys_hub_action_instance_v2.json', key: 'createCatalogTask' },
    { file: 'flows/parallel-change-implement-snapshot/sys_hub_action_instance_v2.json', key: 'waitForCondition' },
    { file: 'samples/ask-for-approval-instances.json', key: 'askForApproval' },
    { file: 'samples/get-catalog-variables-instances.json', key: 'getCatalogVariables' },
  ];
  const uiRowsOf = (file: string, key: string) => pdiRows(file).filter(r => r.action_type === actionTypeIds(findAction(key)!).snapshot);

  it('the catalogue snapshot (action_type) and definition (action_type_parent) are the ids the UI rows store', () => {
    for (const { file, key } of UI_ACTIONS) {
      const rows = uiRowsOf(file, key);
      expect(rows.length, key).toBeGreaterThan(0);
      for (const r of rows) if (r.action_type_parent !== undefined) expect(r.action_type_parent, key).toBe(actionTypeIds(findAction(key)!).definition);
    }
  });

  /**
   * UI rows store the inputs in definition order (sys_hub_action_input.order), except: Send Notification stores
   * `notification` (order 3) first, and one Ask For Approval row stores approval_reason before approval_field
   * (both order 2). The generator writes definition order; activation rewrites every step's values into the
   * full Flow Designer form anyway (live loader runs, FORMAT-DECISIONS.md).
   */
  const ORDER_EXCEPTIONS = new Set(['sendNotification', 'askForApproval']);

  it('the generated entries of these actions follow the entry order of a UI row in every construct spec (definition order)', async () => {
    let checked = 0;
    for (const { name, plan } of await allPlans()) {
      for (const { file, key } of UI_ACTIONS) {
        const uiOrders = uiRowsOf(file, key).map(r => valuesOf<Entry[]>(r).map(e => e.name));
        for (const r of actionRows(plan, key)) {
          const ours = valuesOf(r).map(e => e.name);
          for (const n of ours) expect(uiOrders.flat(), `${name} ${key}: ${n}`).toContain(n);
          if (ORDER_EXCEPTIONS.has(key)) continue;
          expect(uiOrders.some(o => isSubsequence(ours, o)), `${name} ${key}: ${ours.join(',')} vs UI ${uiOrders.map(o => o.join(',')).join(' | ')}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('action_type_parent is the definition UI-built rows store for every action the PDI has UI rows of (samples/action-type-parent-pairs.json)', () => {
    const { pairs } = readPdi('samples/action-type-parent-pairs.json') as { pairs: { action: string; action_type: string; action_type_parent: string }[] };
    expect(pairs.length).toBeGreaterThanOrEqual(13);
    for (const p of pairs) {
      const ids = actionTypeIds(findAction(p.action)!);
      expect(ids.snapshot, p.action).toBe(p.action_type);
      expect(ids.definition, p.action).toBe(p.action_type_parent);
      expect(ids.definition, p.action).not.toBe(ids.snapshot);
    }
  });

  it('the generated entries follow the entry order of UI-built rows for Update Record, Look Up Record(s), Send Email, Update Multiple Records and the email actions (samples/action-values-entry-order.json)', async () => {
    const { rows } = readPdi('samples/action-values-entry-order.json') as { rows: { action: string; action_type: string; names: string[] }[] };
    const plans = await allPlans();
    let checked = 0;
    for (const u of rows) {
      expect(actionTypeIds(findAction(u.action)!).snapshot, u.action).toBe(u.action_type);
      for (const { name, plan } of plans) {
        for (const r of actionRows(plan, u.action)) {
          const ours = valuesOf(r).map(e => e.name);
          expect(isSubsequence(ours, u.names), `${name} ${u.action}: ${ours.join(',')} vs UI ${u.names.join(',')}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it('the documented order exception is real: Send Notification UI rows put notification first although its definition order is last', () => {
    const def = findAction('sendNotification')!.inputs.map(i => i.name);
    const ui = uiRowsOf('flows/leaver-flow/sys_hub_action_instance_v2.json', 'sendNotification').map(r => valuesOf(r).map(e => e.name));
    expect(def[def.length - 1]).toBe('notification');
    expect(ui[0][0]).toBe('notification');
  });

  it('Ask For Approval: approval_conditions uses the UI rule grammar and an omitted due_date gets the UI default verbatim', async () => {
    const grammar = /^(Approves|Rejects|ApprovesRejects)(Any|All|Res|\d+#|\d+%)(M|(U\[\{\{[^\]]+\}\}\])?(G\[\{\{[^\]]+\}\}\])?)(Or(Approves|Rejects).*)?$/;
    const ui = uiRowsOf('samples/ask-for-approval-instances.json', 'askForApproval').map(r => valuesOf(r));
    for (const v of ui) expect(String(v.find(e => e.name === 'approval_conditions')!.value)).toMatch(grammar);
    const uiDue = ui.map(v => v.find(e => e.name === 'due_date')!.value);
    const plan = await generatePlan(spec(loadSpec('p1_incident_review')), { resolvePillType: async (_t, p) => (p === 'assignment_group' ? 'reference' : 'string') });
    const ours = valuesOf(actionRows(plan, 'askForApproval')[0]);
    expect(String(ours.find(e => e.name === 'approval_conditions')!.value)).toMatch(grammar);
    expect(uiDue).toContain(ours.find(e => e.name === 'due_date')!.value);
  });

  it('Get Catalog Variables / Create Catalog Task: catalog_variables is the UI slushbucket form <sys_id>:item_option_new[_set]', async () => {
    const slush = /^[0-9a-f]{32}:item_option_new(_set)?$/;
    for (const r of uiRowsOf('samples/get-catalog-variables-instances.json', 'getCatalogVariables')) {
      for (const item of String(valuesOf(r).find(e => e.name === 'catalog_variables')!.value).split(',')) expect(item).toMatch(slush);
    }
    const plan = await planFor('catalog_actions');
    const rows = [...actionRows(plan, 'getCatalogVariables'), ...actionRows(plan, 'createCatalogTask')];
    const lists = rows.map(r => valuesOf(r).find(e => e.name === 'catalog_variables')).filter(Boolean);
    expect(lists.length).toBe(2);
    for (const e of lists) for (const item of String(e!.value).split(',')) expect(item).toMatch(slush);
  });

  it('a {reference} inside a {template} value is stored as {"display","value"} JSON, as in the UI Create Catalog Task ah_fields (leaver-flow)', async () => {
    const form = /^assignment_group=\{"display":"[^"]+","value":"[0-9a-f]{32}"\}(\^|$)/;
    const ui = uiRowsOf('flows/leaver-flow/sys_hub_action_instance_v2.json', 'createCatalogTask').map(r => String(valuesOf(r).find(e => e.name === 'ah_fields')!.value));
    for (const v of ui) expect(v).toMatch(form);
    const plan = await generatePlan(flowWith([
      { kind: 'action', key: 'task', action: 'createCatalogTask', inputs: {
        ah_requested_item: { pill: 'trigger.request_item' }, ah_short_description: 'Prepare',
        ah_fields: { template: { assignment_group: { reference: '0000000000000000000000000000d001', display: 'Hardware' }, description: 'Set up' } } } },
    ], { key: 't', type: 'catalog.service_catalog' }));
    expect(String(valuesOf(actionRows(plan, 'createCatalogTask')[0]).find(e => e.name === 'ah_fields')!.value))
      .toBe('assignment_group={"display":"Hardware","value":"0000000000000000000000000000d001"}^description=Set up^EQ');
  });

  it('step-output pills use the <ui_id>.<output> form and trigger pills the <definition name>_1 prefix (PDI-FACTS §7)', async () => {
    const ui = pdiRows('flows/leaver-flow/sys_hub_action_instance_v2.json').flatMap(r => valuesOf(r).map(e => String(e.value)));
    expect(ui.some(v => v.startsWith('{{Service Catalog_1.request_item'))).toBe(true);
    const plan = await planFor('catalog_actions');
    const pills = plan.instances.flatMap(r => (r.table === 'sys_hub_action_instance_v2' ? valuesOf(r).map(e => String(e.value)) : []));
    expect(pills).toContain('{{Service Catalog_1.request_item}}');
    const order = actionRows(plan, 'submitCatalogItemRequest')[0];
    expect(pills.some(v => v.includes(`{{${String(order.fields.ui_id)}.requested_item.number}}`))).toBe(true);
  });
});

// ─── subflow calls, stages, triggers ──────────────────────────────────────────

describe('subflow calls, stages and trigger rows against UI-built rows', () => {
  it('a subflow call stores wait_for_completion / show_stages as the UI does and one subflow_inputs entry per input, in the callee input order', async () => {
    const ui = pdiRows('flows/parallel-change-implement-snapshot/sys_hub_sub_flow_instance_v2.json')[0];
    expect([ui.wait_for_completion, ui.show_stages]).toEqual(['true', 'false']);
    const uiEntry = (ui.subflow_inputs_decoded as Entry[])[0];
    const plan = await planFor('incident_triage');
    const row = planRows(plan).find(r => r.table === 'sys_hub_sub_flow_instance_v2')!;
    expect([row.fields.wait_for_completion, row.fields.show_stages]).toEqual(['true', 'false']);
    const entries = row.fields.subflow_inputs as Entry[];
    expect(entries.map(e => e.name)).toEqual(['summary_text', 'level']);
    for (const e of entries) for (const k of Object.keys(e)) expect(Object.keys(uiEntry), k).toContain(k);
    expect(uiEntry.value).toMatch(/^\{\{Created or Updated_1\.current\}\}$/);
  });

  it('stages: the UI states JSON, ancestor_array_position -1, type standard (leaver-flow)', async () => {
    const ui = pdiRows('flows/leaver-flow/sys_hub_flow_stage.json').filter(r => r.type === 'standard');
    const plan = await planFor('incident_triage');
    expect(plan.stages.length).toBe(3);
    for (const s of plan.stages) {
      expect(JSON.parse(String(s.fields.states))).toEqual(JSON.parse(String(ui[0].states)));
      expect(String(s.fields.states)).toBe(String(ui[0].states));
      expect(s.fields.ancestor_array_position).toBe(ui[0].ancestor_array_position);
      expect(s.fields.type).toBe('standard');
    }
  });

  it('flow variables / inputs / outputs: the max_length UI-built rows store per table and type; sys_documentation with an empty plural (samples/*)', async () => {
    const TABLES = ['sys_hub_flow_variable', 'sys_hub_flow_input', 'sys_hub_flow_output'] as const;
    const uiLength = new Map<string, string>();
    for (const t of TABLES) {
      for (const r of pdiRows(`samples/${t}.json`)) if (!String(r.attributes ?? '').includes('co_type_name')) uiLength.set(`${t}.${String(r.internal_type)}`, String(r.max_length));
    }
    expect(uiLength.size).toBeGreaterThanOrEqual(6);
    const plans = await Promise.all(['flow_logic', 'incident_triage', 'review_subflow', 'level_check_subflow'].map(n => planFor(n)));
    const vars = plans.flatMap(p => p.variables).filter(r => (TABLES as readonly string[]).includes(r.table));
    let compared = 0;
    for (const v of vars) {
      const expected = uiLength.get(`${v.table}.${String(v.fields.internal_type)}`);
      if (expected && !String(v.fields.attributes ?? '').includes('co_type_name')) { expect(v.fields.max_length, `${v.table} ${String(v.fields.element)} ${String(v.fields.internal_type)}`).toBe(expected); compared++; }
    }
    expect(compared).toBeGreaterThanOrEqual(5);
    const uiDocs = pdiRows('samples/sys_documentation-for-variables.json');
    const docs = plans.flatMap(p => p.documentation);
    expect(docs.length).toBeGreaterThan(5);
    for (const d of docs) {
      expect(d.fields).toMatchObject({ plural: uiDocs[0].plural, language: uiDocs[0].language });
      expect(String(d.fields.name)).toMatch(/^var__m_sys_hub_flow_(variable|input|output)_[0-9a-f]{32}$/);
    }
  });

  it('max_length per table and type is the value the instance rows carry most often (samples/max-length-by-type.json; boolean variables: the rows the current release writes)', () => {
    const tally = readPdi('samples/max-length-by-type.json') as Record<string, { all: Record<string, Record<string, number>>; since_2026_03: Record<string, Record<string, number>> }>;
    const mode = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    let checked = 0;
    for (const table of ['sys_hub_flow_variable', 'sys_hub_flow_input', 'sys_hub_flow_output']) {
      for (const [type, counts] of Object.entries(tally[table].all)) {
        const recent = tally[table].since_2026_03[type];
        const expected = recent ? mode(recent) : mode(counts);
        expect(maxLengthFor(table, type), `${table}.${type}`).toBe(expected);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(30);
    // the one table-dependent case the current release shows: a boolean variable is 32, a boolean subflow input / output 40
    expect([maxLengthFor('sys_hub_flow_variable', 'boolean'), maxLengthFor('sys_hub_flow_input', 'boolean'), maxLengthFor('sys_hub_flow_output', 'boolean')]).toEqual(['32', '40', '40']);
    expect(maxLengthFor('sys_hub_flow_variable', 'array.string')).toBe('65000');
  });

  // Labels are not compared: the UI descriptor of a record trigger carries the input NAME as the label of the advanced
  // inputs (run_flow_in, …), the generic descriptor the definition label (FORMAT-DECISIONS.md, record-trigger descriptors).
  it('record triggers: every input the UI descriptor carries, with the UI type and mandatory flag (record-trigger-published-flow)', async () => {
    const ui = pdiRows('flows/record-trigger-published-flow/sys_hub_trigger_instance_v2.json')[0];
    const uiEntries = ui.trigger_inputs_decoded as Entry[];
    const plan = await planFor('trg_record_created_or_updated');
    expect(plan.trigger!.fields).toMatchObject({ name: ui.name, trigger_type: ui.trigger_type, trigger_definition: ui.trigger_definition });
    const ours = decodeValues(String(plan.trigger!.fields.trigger_inputs)) as Entry[];
    const pick = (e: Entry) => ({ name: e.name, internalType: e.internalType, mandatory: e.mandatory });
    const byName = (a: Entry[]) => a.map(pick).sort((x, y) => x.name.localeCompare(y.name));
    expect(byName(ours)).toEqual(byName(uiEntries));
  });

  it('record triggers (Created, Updated, Created or Updated): entry order, order field, attributes, choices and referenced table equal every UI-built row', async () => {
    const uiRows = [
      ...pdiRows('samples/trigger-instances-other-types.json'),
      ...pdiRows('flows/record-trigger-published-flow/sys_hub_trigger_instance_v2.json'),
      ...pdiRows('flows/parallel-change-implement-snapshot/sys_hub_trigger_instance_v2.json'),
    ].filter(r => /^record_/.test(String(r.trigger_type)));
    expect(uiRows.map(r => r.trigger_type).sort()).toEqual(['record_create', 'record_create_or_update', 'record_create_or_update', 'record_update']);
    const specFor: Record<string, string> = { record_create: 'trg_record_created', record_update: 'ritm_fulfilment', record_create_or_update: 'trg_record_created_or_updated' };
    for (const ui of uiRows) {
      const uiEntries = ui.trigger_inputs_decoded as Entry[];
      const plan = await planFor(specFor[String(ui.trigger_type)]);
      expect(plan.trigger!.fields.trigger_definition).toBe(ui.trigger_definition);
      const ours = decodeValues(String(plan.trigger!.fields.trigger_inputs)) as Entry[];
      const tag = String(ui.trigger_type);
      expect(ours.map(e => e.name), tag).toEqual(uiEntries.map(e => e.name));
      for (const u of uiEntries) {
        const o = ours.find(e => e.name === u.name)!;
        const up = u.parameter as Record<string, unknown>;
        const op = o.parameter as Record<string, unknown>;
        expect(o.order, `${tag} ${u.name} order`).toBe(u.order);
        // an input without attributes is stored by the UI as {"": ""} (the parsed empty attribute string)
        const uiAttrs = Object.fromEntries(Object.entries((up.attributes ?? {}) as Record<string, string>).filter(([k]) => k !== ''));
        expect(op.attributes ?? {}, `${tag} ${u.name} attributes`).toEqual(uiAttrs);
        expect(op.reference ?? '', `${tag} ${u.name} reference`).toBe(up.reference ?? '');
        expect(op.reference_display ?? '', `${tag} ${u.name} reference_display`).toBe(up.reference_display ?? '');
        const choices = (e: Entry) => ((e.choiceList as { fValue: string }[] | undefined) ?? []).map(c => c.fValue);
        // the same choices; their order is not stable across UI rows (the Updated row lists run_on_extended true/false,
        // the Created or Updated rows false/true), so only the set is compared
        expect(choices(o).sort(), `${tag} ${u.name} choices`).toEqual(choices(u).sort());
      }
    }
  });

  it('Remote Table Query: the u_table input carries the referenced table and its label, as the trigger definition does', async () => {
    const plan = await planFor('trg_remote_table');
    const [entry] = decodeValues(String(plan.trigger!.fields.trigger_inputs)) as Entry[];
    expect(entry.name).toBe('u_table');
    expect(entry.parameter).toMatchObject({ type: 'table_name', name: 'u_table', reference: 'sys_script_vtable', reference_display: 'Remote Table' });
    // the definition exported from the instance (catalog/source) holds the reference; sys_db_object labels sys_script_vtable "Remote Table"
    const exported = JSON.parse(readFileSync(new URL('../../../src/flow-builder/catalog/source/sys_hub_trigger_input.json', import.meta.url), 'utf8')) as { result: Record<string, string>[] };
    expect(exported.result.find(r => r.element === 'u_table')?.reference).toBe('sys_script_vtable');
  });

  it('trigger rows: name, trigger_type and definition of the UI-captured Daily / Repeat / Inbound Email / Service Catalog rows', async () => {
    const ui = [...pdiRows('samples/trigger-instances-other-types.json'), ...pdiRows('flows/leaver-flow/sys_hub_trigger_instance_v2.json')];
    for (const [specName, uiName] of [['trg_daily', 'Daily'], ['trg_repeat', 'Repeat'], ['trg_inbound_email', 'Inbound Email'], ['trg_service_catalog', 'Service Catalog']] as const) {
      const row = ui.find(r => r.name === uiName)!;
      expect(row, uiName).toBeDefined();
      const plan = await planFor(specName);
      expect(plan.trigger!.fields, specName).toMatchObject({ name: row.name, trigger_type: row.trigger_type, trigger_definition: row.trigger_definition });
    }
  });
});

