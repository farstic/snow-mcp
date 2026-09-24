import { describe, it, expect } from 'vitest';
import { parseSpec, PILL_RE, pillTokensOf, TRIGGER_TYPES, STEP_KINDS, VARIABLE_TYPES } from '../../../src/flow-builder/spec/schema.js';
import type { FlowSpec } from '../../../src/flow-builder/spec/types.js';

const SYS_ID = '0123456789abcdef0123456789abcdef';

function ok(input: unknown): FlowSpec {
  const r = parseSpec(input);
  if ('errors' in r) throw new Error('expected a valid spec, got: ' + JSON.stringify(r.errors, null, 2));
  return r.spec;
}
function bad(input: unknown): { path: string; message: string }[] {
  const r = parseSpec(input);
  if ('spec' in r) throw new Error('expected errors, spec parsed');
  return r.errors;
}
const messages = (errs: { path: string; message: string }[]) => errs.map(e => `${e.path}: ${e.message}`).join('\n');

/** The brief's example: P1 Incident Review. */
const P1_REVIEW = {
  spec_version: '1',
  flow: { key: 'p1_incident_review', name: 'P1 Incident Review', description: 'Logs, tags and requests approval for new P1 incidents', scope: 'global', run_as: 'system' },
  trigger: { key: 'trg', type: 'record.created', table: 'incident', condition: 'priority=1', run_flow_in: 'background' },
  steps: [
    { kind: 'action', key: 'log_p1', action: 'log', inputs: { log_level: 'info', log_message: { text: 'P1 created {{trigger.current.number}}' } } },
    { kind: 'action', key: 'tag', action: 'updateRecord',
      inputs: { table_name: 'incident', record: { pill: 'trigger.current' },
        values: { template: { impact: '1', work_notes: { text: 'Auto-tagged by P1 review flow ({{trigger.current.number}})' } } } } },
    { kind: 'if', key: 'is_urgent', condition: '{{trigger.current.urgency}}=1',
      then: [
        { kind: 'action', key: 'approve', action: 'askForApproval',
          inputs: { table: 'incident', record: { pill: 'trigger.current' }, approval_field: 'approval', journal_field: 'work_notes', approval_reason: 'P1 with urgency 1',
            approval_conditions: { approval_rules: { rule_sets: [{ action: 'Approves', rules: [[{ rule: 'Any', groups: [{ pill: 'trigger.current.assignment_group' }] }]] }] } } } },
        { kind: 'action', key: 'log_result', action: 'log', inputs: { log_level: 'info', log_message: { text: 'Approval state: {{steps.approve.approval_state}}' } } },
      ],
      else: { key: 'not_urgent', steps: [{ kind: 'end_flow', key: 'stop' }] } },
  ],
};

describe('parseSpec — valid specs', () => {
  it('accepts the brief\'s P1 Incident Review example and applies defaults', () => {
    const spec = ok(P1_REVIEW);
    expect(spec.flow.type).toBe('flow');
    expect(spec.flow.run_as).toBe('system');
    expect(spec.trigger?.type).toBe('record.created');
    const first = spec.steps[0];
    expect(first.kind).toBe('action');
    if (first.kind === 'action') expect(first.inputs.log_level).toBe('info');
  });

  it('accepts a JSON string', () => {
    const spec = ok(JSON.stringify(P1_REVIEW));
    expect(spec.flow.key).toBe('p1_incident_review');
  });

  it('defaults run_as to "user" and scope to "global"', () => {
    const spec = ok({ spec_version: '1', flow: { key: 'f', name: 'F' }, trigger: { key: 't', type: 'record.created', table: 'incident' }, steps: [] });
    expect(spec.flow.run_as).toBe('user');
    expect(spec.flow.scope).toBe('global');
  });

  it('accepts every trigger type', () => {
    const triggers: Record<string, unknown>[] = [
      { key: 't', type: 'record.created', table: 'incident', condition: 'active=true', run_flow_in: 'background', run_on_extended: true, run_when_setting: 'both', run_when_user_setting: 'one_of', run_when_user_list: [SYS_ID, { reference: SYS_ID, display: 'Abel Tuter', table: 'sys_user' }] },
      { key: 't', type: 'record.updated', table: 'incident', trigger_strategy: 'unique_changes' },
      { key: 't', type: 'record.created_or_updated', table: 'incident', trigger_strategy: 'once' },
      { key: 't', type: 'scheduled.daily', time: '08:00:00', timezone: 'Europe/Sofia' },
      { key: 't', type: 'scheduled.weekly', day_of_week: 'monday', time: '08:00:00' },
      { key: 't', type: 'scheduled.weekly', day_of_week: 3, time: '08:00:00' },
      { key: 't', type: 'scheduled.monthly', day_of_month: 15, time: '23:30:00' },
      { key: 't', type: 'scheduled.repeat', repeat: { hours: 4 } },
      { key: 't', type: 'scheduled.repeat', repeat: '1 00:00:00' },
      { key: 't', type: 'scheduled.run_once', run_in: '2026-12-31 23:59:00' },
      { key: 't', type: 'email.inbound', email_conditions: 'subject LIKE P1', order: 100, stop_condition_evaluation: true, target_table: 'incident' },
      { key: 't', type: 'catalog.service_catalog', run_flow_in: 'foreground' },
      { key: 't', type: 'sla.task' },
      { key: 't', type: 'knowledge.management' },
      { key: 't', type: 'remote_table.query', table: 'u_remote' },
      { key: 't', type: 'custom', definition: SYS_ID, trigger_type: 'application', name: 'Application', inputs: { event: 'x.y' } },
    ];
    for (const trigger of triggers) {
      ok({ spec_version: '1', flow: { key: 'f', name: 'F' }, trigger, steps: [] });
    }
    expect(TRIGGER_TYPES.length).toBe(14);
  });

  it('accepts every step kind and every value form in one flow', () => {
    const spec = ok({
      spec_version: '1',
      flow: { key: 'all_constructs', name: 'All constructs', run_with_roles: ['itil'], category: 'ITSM', access: 'public', annotation: 'a', flow_priority: 'HIGH', show_draft_actions: false, allow_high_security_roles: false, callable_by_client_api: false, internal_name: 'all_constructs' },
      trigger: { key: 't', type: 'record.created', table: 'incident' },
      variables: [
        { name: 'note', label: 'Note', type: 'string', default: 'x' },
        { name: 'counter', type: 'integer', default: 0 },
        { name: 'flag', type: 'boolean' },
        { name: 'grp', type: 'reference', reference_table: 'sys_user_group' },
        { name: 'cis', type: 'records', reference_table: 'cmdb_ci' },
        { name: 'sev', type: 'choice', choices: [{ value: '1', label: 'High' }] },
      ],
      stages: [
        { value: 'triage', label: 'Triage' },
        { value: 'approval', label: 'Approval', always_show: true, duration: { days: 1 } },
      ],
      steps: [
        { kind: 'action', key: 'a1', action: 'log', stage: 'triage', annotation: 'first', inputs: {
          s: 'plain', n: 1, b: true,
          p: { pill: 'trigger.current.caller_id.email' },
          t: { text: 'hello {{vars.note}} {{static.' + SYS_ID + '}}' },
          tpl: { template: { impact: '1', 'assignment_group': { reference: SYS_ID }, 'u_nested.x': { pill: 'vars.grp' } } },
          c: { conditions: 'active=true^priority={{trigger.current.priority}}' },
          r: { reference: SYS_ID, display: 'Service Desk', table: 'sys_user_group' },
          ap: { approval_rules: { rule_sets: [
            { action: 'ApprovesRejects', rules: [[{ rule: { count: 2 }, users: [SYS_ID, { pill: 'trigger.current.caller_id' }], manual: true }], [{ rule: { percent: 50 }, groups: [{ reference: SYS_ID }] }]] },
            { action: 'Rejects', rules: [[{ rule: 'All', manual: true }]] },
          ] } },
          d1: { duration: { days: 1, hours: 2 } }, d2: { duration: '1 02:00:00' }, d3: { duration: '02:00:00' },
          l: { list: ['a', { pill: 'vars.grp' }, { reference: SYS_ID }] },
          sc: { script: 'return 1;' },
        } },
        { kind: 'custom_action', key: 'ca', definition: { name: 'My Action', scope: 'x_example_app' }, inputs: { x: 'y' } },
        { kind: 'subflow', key: 'sf', subflow: { sys_id: SYS_ID }, inputs: { message: { pill: 'steps.a1.Record' } }, wait_for_completion: false, show_stages: true },
        { kind: 'set_variables', key: 'sv', assign: { note: 'n', counter: 2, flag: true } },
        { kind: 'append_variables', key: 'av', assign: { cis: { pill: 'steps.a1.Records' } } },
        { kind: 'if', key: 'i', condition: '{{vars.counter}}>1', then: [{ kind: 'end_flow', key: 'e1' }],
          else_if: [{ key: 'ei', condition: '{{vars.counter}}=0', steps: [{ kind: 'action', key: 'a2', action: 'log' }] }],
          else: { key: 'el', steps: [{ kind: 'action', key: 'a3', action: 'log' }] } },
        { kind: 'for_each', key: 'fe', items: { pill: 'steps.a1.Records' }, steps: [
          { kind: 'action', key: 'a4', action: 'log', inputs: { m: { text: '{{loop.fe.item.name}}' } } },
          { kind: 'if', key: 'i2', condition: '{{loop.fe.item.active}}=false', then: [{ kind: 'skip_iteration', key: 'sk' }] },
          { kind: 'exit_loop', key: 'xl' },
        ] },
        { kind: 'do_until', key: 'du', condition: '{{vars.flag}}=true', steps: [{ kind: 'exit_loop', key: 'xl2' }] },
        { kind: 'try_catch', key: 'tc', try: [{ kind: 'action', key: 'a5', action: 'log' }], catch: { key: 'c', steps: [{ kind: 'action', key: 'a6', action: 'log', inputs: { m: { text: '{{error.message}}' } } }] } },
        { kind: 'do_in_parallel', key: 'par', branches: [{ key: 'b1', steps: [{ kind: 'action', key: 'a7', action: 'log' }] }, { key: 'b2', steps: [] }] },
        { kind: 'wait', key: 'w1', duration: { minutes: 5 } },
        { kind: 'wait', key: 'w2', duration_type: 'relative', duration: '01:00:00', relative_operator: 'before', relative_datetime: { pill: 'trigger.current.due_date' }, schedule: SYS_ID },
        { kind: 'wait', key: 'w3', duration_type: 'percentage', percentage: 50, percentage_datetime: { pill: 'trigger.current.due_date' } },
        { kind: 'action', key: 'a8', action: 'createCatalogTask', inputs: { catalog_variables: { list: ['requested_for', 'justification'] } } },
      ],
      error_handler: { steps: [{ kind: 'action', key: 'eh_log', action: 'log', inputs: { m: { text: '{{error.message}}' } } }] },
    });
    expect(spec.error_handler?.key).toBe('error_handler');
    const sf = spec.steps.find(s => s.kind === 'subflow');
    expect(sf && sf.kind === 'subflow' ? sf.wait_for_completion : undefined).toBe(false);
    const w1 = spec.steps.find(s => s.key === 'w1');
    expect(w1 && w1.kind === 'wait' ? w1.duration_type : undefined).toBe('explicit');
    expect(STEP_KINDS.length).toBe(15);
    expect(VARIABLE_TYPES).toContain('glide_duration');
  });

  it('accepts a subflow with inputs, outputs and assign_subflow_outputs', () => {
    const spec = ok({
      spec_version: '1',
      flow: { key: 'level_check_subflow', name: 'Level Check Subflow', type: 'subflow', run_as: 'system' },
      inputs: [{ name: 'message', label: 'Message', type: 'string', mandatory: true }, { name: 'severity', type: 'integer' }],
      outputs: [{ name: 'result', type: 'string' }, { name: 'ok', type: 'boolean' }],
      steps: [
        { kind: 'action', key: 'sub_log', action: 'log', inputs: { log_level: 'info', log_message: { text: 'Sub got {{inputs.message}}' } } },
        { kind: 'if', key: 'sub_if', condition: '{{inputs.severity}}>=3', then: [{ kind: 'assign_subflow_outputs', key: 'hi', assign: { result: 'high', ok: true } }],
          else: { key: 'sub_else', steps: [{ kind: 'assign_subflow_outputs', key: 'lo', assign: { result: 'low', ok: false } }] } },
      ],
    });
    expect(spec.flow.type).toBe('subflow');
    expect(spec.trigger).toBeUndefined();
  });

  it('accepts an explicit flow sys_id (adopting an existing flow)', () => {
    const spec = ok({ spec_version: '1', flow: { key: 'f', name: 'F', sys_id: SYS_ID }, trigger: { key: 't', type: 'record.created', table: 'incident' }, steps: [] });
    expect(spec.flow.sys_id).toBe(SYS_ID);
  });
});

describe('parseSpec — invalid specs', () => {
  const base = () => JSON.parse(JSON.stringify(P1_REVIEW)) as Record<string, any>;

  it('rejects non-JSON strings, non-objects and arrays', () => {
    expect(bad('{not json')[0].message).toMatch(/not valid JSON/);
    expect(bad(null)[0].message).toMatch(/must be a JSON object/);
    expect(bad(42)[0].message).toMatch(/must be a JSON object/);
    expect(bad([])[0].message).toMatch(/must be a JSON object/);
  });

  it('rejects a missing or unsupported spec_version', () => {
    expect(bad({ flow: {} })[0]).toEqual({ path: 'spec_version', message: expect.stringContaining('unsupported spec_version undefined') });
    expect(bad({ spec_version: '2' })[0].path).toBe('spec_version');
    expect(bad({ spec_version: 1 })[0].path).toBe('spec_version');
  });

  it('rejects unknown keys (strict objects) with a path', () => {
    const s = base(); s.flow.colour = 'red';
    expect(messages(bad(s))).toMatch(/^flow: Unrecognized key/m);
    const s2 = base(); s2.steps[0].bogus = 1;
    expect(messages(bad(s2))).toMatch(/^steps\.0: Unrecognized key/m);
  });

  it('rejects a flow without a trigger and a subflow with one', () => {
    const s = base(); delete s.trigger;
    expect(messages(bad(s))).toMatch(/a flow requires a trigger/);
    const sub = base(); sub.flow.type = 'subflow';
    expect(messages(bad(sub))).toMatch(/a subflow cannot have a trigger/);
  });

  it('rejects inputs/outputs on a flow and error_handler on a subflow', () => {
    const s = base(); s.inputs = [{ name: 'x', type: 'string' }];
    expect(messages(bad(s))).toMatch(/only valid for type "subflow"/);
    const sub = base(); delete sub.trigger; sub.flow.type = 'subflow'; sub.error_handler = { steps: [] };
    expect(messages(bad(sub))).toMatch(/error_handler is only valid for type "flow"/);
  });

  it('rejects bad keys and names', () => {
    const s = base(); s.flow.key = 'P1 Review';
    expect(messages(bad(s))).toMatch(/^flow\.key: /m);
    const s2 = base(); s2.steps[0].key = '1abc';
    expect(messages(bad(s2))).toMatch(/^steps\.0\.key: /m);
    const s3 = base(); s3.flow.name = '';
    expect(messages(bad(s3))).toMatch(/^flow\.name: /m);
    const s4 = base(); s4.trigger.table = 'Incident';
    expect(messages(bad(s4))).toMatch(/^trigger\.table: /m);
  });

  it('rejects duplicate keys anywhere in the tree', () => {
    const s = base(); s.steps[1].key = 'log_p1';
    expect(messages(bad(s))).toMatch(/duplicate key "log_p1" \(first used at steps\.0\.key\)/);
    const s2 = base(); s2.steps[2].else.key = 'trg';
    expect(messages(bad(s2))).toMatch(/duplicate key "trg"/);
    const s3 = base(); s3.steps[2].then[0].key = 'p1_incident_review';
    expect(messages(bad(s3))).toMatch(/duplicate key "p1_incident_review"/);
  });

  it('rejects invalid pill tokens and {pill} values', () => {
    const s = base(); s.steps[0].inputs.log_message = { text: 'bad {{current.number}}' };
    expect(messages(bad(s))).toMatch(/invalid pill token "\{\{current\.number\}\}"/);
    const s2 = base(); s2.steps[1].inputs.record = { pill: 'trigger' };
    expect(messages(bad(s2))).toMatch(/invalid symbolic pill/);
    const s3 = base(); s3.steps[2].condition = '{{steps.approve}}=1';
    expect(messages(bad(s3))).toMatch(/invalid pill token/);
    const s4 = base(); s4.trigger.condition = 'x={{static.notahexid}}';
    expect(messages(bad(s4))).toMatch(/invalid pill token/);
  });

  it('rejects pills that point at unknown targets', () => {
    const s = base(); s.steps[2].then[1].inputs.log_message = { text: '{{steps.nope.approval_state}}' };
    expect(messages(bad(s))).toMatch(/refers to unknown step "nope"/);
    const s2 = base(); s2.steps[0].inputs.log_message = { text: '{{vars.missing}}' };
    expect(messages(bad(s2))).toMatch(/refers to unknown flow variable "missing"/);
    const s3 = base(); s3.steps[0].inputs.log_message = { text: '{{loop.each.item}}' };
    expect(messages(bad(s3))).toMatch(/refers to unknown for_each "each"/);
    const s4 = base(); s4.steps[0].inputs.log_message = { text: '{{inputs.message}}' };
    expect(messages(bad(s4))).toMatch(/refers to unknown subflow input "message"/);
    const sub = base(); delete sub.trigger; sub.flow.type = 'subflow'; sub.steps = [{ kind: 'action', key: 'a', action: 'log', inputs: { m: { pill: 'trigger.current' } } }];
    expect(messages(bad(sub))).toMatch(/needs a trigger/);
  });

  it('rejects unknown stage, unknown variable and unknown subflow output', () => {
    const s = base(); s.steps[0].stage = 'triage';
    expect(messages(bad(s))).toMatch(/unknown stage "triage"/);
    const s2 = base(); s2.steps.push({ kind: 'set_variables', key: 'sv', assign: { nope: 1 } });
    expect(messages(bad(s2))).toMatch(/unknown flow variable "nope"/);
    const sub = base(); delete sub.trigger; sub.flow.type = 'subflow'; sub.outputs = [{ name: 'ok', type: 'boolean' }];
    sub.steps = [{ kind: 'assign_subflow_outputs', key: 'x', assign: { result: 'a' } }];
    expect(messages(bad(sub))).toMatch(/unknown subflow output "result"/);
  });

  it('rejects duplicate variable / stage names', () => {
    const s = base(); s.variables = [{ name: 'a', type: 'string' }, { name: 'a', type: 'integer' }];
    expect(messages(bad(s))).toMatch(/duplicate variables name "a"/);
    const s2 = base(); s2.stages = [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }];
    expect(messages(bad(s2))).toMatch(/duplicate stages value "x"/);
  });

  it('rejects loop-only and subflow-only constructs outside their context', () => {
    const s = base(); s.steps.push({ kind: 'exit_loop', key: 'x' });
    expect(messages(bad(s))).toMatch(/exit_loop is only valid inside for_each \/ do_until/);
    const s2 = base(); s2.steps[2].then.push({ kind: 'skip_iteration', key: 'x' });
    expect(messages(bad(s2))).toMatch(/skip_iteration is only valid inside/);
    const s3 = base(); s3.steps.push({ kind: 'assign_subflow_outputs', key: 'x', assign: { a: 1 } });
    expect(messages(bad(s3))).toMatch(/assign_subflow_outputs is only valid in a subflow/);
  });

  it('rejects an empty assign and a bad step kind', () => {
    const s = base(); s.variables = [{ name: 'a', type: 'string' }]; s.steps.push({ kind: 'set_variables', key: 'sv', assign: {} });
    expect(messages(bad(s))).toMatch(/assign needs at least one entry/);
    const s2 = base(); s2.steps.push({ kind: 'goto', key: 'g' });
    expect(messages(bad(s2))).toMatch(/^steps\.3\.kind: /m);
  });

  it('rejects wait steps missing their cross-field requirements', () => {
    const s = base(); s.steps.push({ kind: 'wait', key: 'w' });
    expect(messages(bad(s))).toMatch(/steps\.3\.duration: duration is required for duration_type explicit/);
    const s2 = base(); s2.steps.push({ kind: 'wait', key: 'w', duration_type: 'relative', duration: '01:00:00' });
    expect(messages(bad(s2))).toMatch(/relative_operator and relative_datetime are required/);
    const s3 = base(); s3.steps.push({ kind: 'wait', key: 'w', duration_type: 'percentage' });
    expect(messages(bad(s3))).toMatch(/percentage and percentage_datetime are required/);
  });

  it('rejects malformed durations, times and datetimes', () => {
    const s = base(); s.steps[0].inputs.d = { duration: '1:2' };
    expect(messages(bad(s))).toMatch(/duration/);
    const s2 = base(); s2.steps[0].inputs.d = { duration: {} };
    expect(messages(bad(s2))).toMatch(/duration needs at least one part/);
    const s3 = base(); s3.trigger = { key: 't', type: 'scheduled.daily', time: '8am' };
    expect(messages(bad(s3))).toMatch(/^trigger\.time: /m);
    const s4 = base(); s4.trigger = { key: 't', type: 'scheduled.run_once', run_in: 'tomorrow' };
    expect(messages(bad(s4))).toMatch(/run_in must be/);
    const s5 = base(); s5.trigger = { key: 't', type: 'scheduled.monthly', day_of_month: 32, time: '08:00:00' };
    expect(messages(bad(s5))).toMatch(/^trigger\.day_of_month: /m);
  });

  it('rejects an unknown trigger type and missing trigger fields', () => {
    const s = base(); s.trigger = { key: 't', type: 'record.deleted', table: 'incident' };
    expect(messages(bad(s))).toMatch(/^trigger\.type: /m);
    const s2 = base(); s2.trigger = { key: 't', type: 'record.created' };
    expect(messages(bad(s2))).toMatch(/^trigger\.table: /m);
    const s3 = base(); s3.trigger = { key: 't', type: 'custom', definition: 'xyz', trigger_type: 'a', name: 'A' };
    expect(messages(bad(s3))).toMatch(/^trigger\.definition: /m);
  });

  it('rejects approval rules without users/groups/manual and bad reference values', () => {
    const s = base(); s.steps[2].then[0].inputs.approval_conditions = { approval_rules: { rule_sets: [{ action: 'Approves', rules: [[{ rule: 'Any' }]] }] } };
    expect(messages(bad(s))).toMatch(/an approval rule needs users, groups or manual:true/);
    const s2 = base(); s2.steps[2].then[0].inputs.approval_conditions = { approval_rules: { rule_sets: [] } };
    expect(messages(bad(s2))).toMatch(/rule_sets/);
    const s3 = base(); s3.steps[0].inputs.r = { reference: 'not-a-sys-id' };
    expect(messages(bad(s3))).toMatch(/32-char lowercase hex sys_id/);
    const s4 = base(); s4.steps[2].then[0].inputs.approval_conditions = { approval_rules: { rule_sets: [{ action: 'Maybe', rules: [[{ rule: 'Any', manual: true }]] }] } };
    expect(messages(bad(s4))).toMatch(/action/);
  });

  it('rejects variable definitions that miss their dependent fields', () => {
    const s = base(); s.variables = [{ name: 'g', type: 'reference' }];
    expect(messages(bad(s))).toMatch(/variables\.0\.reference_table: reference_table is required for type reference/);
    const s2 = base(); s2.variables = [{ name: 'c', type: 'choice' }];
    expect(messages(bad(s2))).toMatch(/choices are required for type choice/);
    const s3 = base(); s3.variables = [{ name: 'c', type: 'money' }];
    expect(messages(bad(s3))).toMatch(/^variables\.0\.type: /m);
  });

  it('rejects a do_in_parallel with fewer than two branches and bad definition refs', () => {
    const s = base(); s.steps.push({ kind: 'do_in_parallel', key: 'p', branches: [{ key: 'b', steps: [] }] });
    expect(messages(bad(s))).toMatch(/^steps\.3\.branches: /m);
    const s2 = base(); s2.steps.push({ kind: 'subflow', key: 'sf', subflow: { name: '' } });
    expect(messages(bad(s2))).toMatch(/^steps\.3\.subflow/m);
    const s3 = base(); s3.steps.push({ kind: 'custom_action', key: 'ca', definition: { sys_id: 'nope' } });
    expect(messages(bad(s3))).toMatch(/^steps\.3\.definition/m);
  });

  it('rejects input names that are not snake_case and template keys that are not field paths', () => {
    const s = base(); s.steps[0].inputs['Log Level'] = 'x';
    expect(messages(bad(s))).toMatch(/input names are snake_case/);
    const s2 = base(); s2.steps[1].inputs.values = { template: { 'Impact!': '1' } };
    expect(messages(bad(s2))).toMatch(/^steps\.1\.inputs\.values\.template/m);
  });
});

describe('pill lexer helpers', () => {
  it('PILL_RE accepts the documented forms and rejects the rest', () => {
    for (const p of ['trigger.current', 'trigger.current.caller_id.email', 'trigger.request_item', 'steps.approve.approval_state', 'steps.ct.Catalog Task.number',
      'steps.lk.Record.assignment_group.manager', 'loop.each_ci.item', 'loop.each_ci.item.name', 'vars.note', 'vars.grp.name', 'inputs.message', 'error.message', `static.${SYS_ID}`]) {
      expect(PILL_RE.test(p), p).toBe(true);
    }
    for (const p of ['current.number', 'trigger', 'steps.approve', 'loop.x.items', 'vars.', 'static.123', 'Trigger.current', 'steps.Approve.x', 'error.message.x']) {
      expect(PILL_RE.test(p), p).toBe(false);
    }
  });

  it('pillTokensOf finds every {{...}} body', () => {
    expect(pillTokensOf('a {{x}} b {{ y.z }} c')).toEqual(['x', ' y.z ']);
    expect(pillTokensOf('none')).toEqual([]);
  });
});

describe('parseSpec — template values cannot inject field assignments', () => {
  const withTemplate = (template: Record<string, unknown>) => ({
    ...P1_REVIEW,
    steps: [{ kind: 'action', key: 'tag', action: 'updateRecord', inputs: { table_name: 'incident', record: { pill: 'trigger.current' }, values: { template } } }],
  });

  it('rejects "^" in a scalar, {text}, {conditions}, {reference} display or {list} item with FLOW_BUILDER_INVALID_SPEC-grade errors', () => {
    // regression: this spec used to be accepted and encoded as 'work_notes=note A^priority=1^state=7^EQ'
    const errs = bad(withTemplate({ work_notes: 'note A^priority=1^state=7' }));
    expect(messages(errs)).toMatch(/template field "work_notes".*contains "\^"/);
    expect(errs.some(e => e.path.endsWith('template.work_notes'))).toBe(true);
    for (const v of [{ text: 'a^b' }, { text: 'end^EQ' }, { conditions: 'active=true^priority=1' }, { reference: SYS_ID, display: 'A^B' }, { list: ['x^y'] }]) {
      expect(messages(bad(withTemplate({ short_description: v }))), JSON.stringify(v)).toMatch(/contains "\^"/);
    }
  });

  it('still accepts template values without "^" (pills and {script} are not literal parts)', () => {
    ok(withTemplate({ impact: '1', work_notes: { text: 'Tagged {{trigger.current.number}}' }, assignment_group: { pill: 'trigger.current.assignment_group' }, description: { script: 'return "a^b";' } }));
  });
});
