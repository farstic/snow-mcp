/**
 * FlowSpec schema additions that closed the former spec_patches gaps: trigger_strategy always / every,
 * an optional `label` on if / else_if / do_until, the `float` variable type and {template} items inside
 * {list} (several objects appended to an array.object variable) — parse side and generator side.
 */
import { describe, it, expect } from 'vitest';
import { parseSpec, TRIGGER_STRATEGIES, VARIABLE_TYPES } from '../../../src/flow-builder/spec/schema.js';
import { generatePlan } from '../../../src/flow-builder/generator/index.js';
import { encodeList } from '../../../src/flow-builder/generator/values.js';
import { decodeValues } from '../../../src/flow-builder/encode.js';
import { ServiceNowError } from '../../../src/utils/errors.js';
import type { FlowSpec, RecordPlan } from '../../../src/flow-builder/spec/types.js';

function ok(input: unknown): FlowSpec {
  const r = parseSpec(input);
  if ('errors' in r) throw new Error('expected a valid spec, got: ' + JSON.stringify(r.errors, null, 2));
  return r.spec;
}
function bad(input: unknown): string {
  const r = parseSpec(input);
  if ('spec' in r) throw new Error('expected errors, spec parsed');
  return r.errors.map(e => `${e.path}: ${e.message}`).join('\n');
}
async function semanticErrors(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    if (e instanceof ServiceNowError && e.code === 'FLOW_BUILDER_INVALID_SPEC') return ((e.details as { errors?: string[] } | undefined)?.errors ?? [e.message]).join('\n');
    throw e;
  }
  throw new Error('expected FLOW_BUILDER_INVALID_SPEC');
}

const base = (extra: Record<string, unknown>) => ({
  spec_version: '1',
  flow: { key: 'f', name: 'F' },
  trigger: { key: 't', type: 'record.created', table: 'incident' },
  steps: [{ kind: 'action', key: 'log', action: 'log', inputs: { log_level: 'info', log_message: 'x' } }],
  ...extra,
});
const withSteps = (steps: unknown[], extra: Record<string, unknown> = {}) => base({ steps, ...extra });
const values = (plan: RecordPlan, key: number) => decodeValues(String(plan.instances[key].fields.values)) as Record<string, unknown>;
const log = (key: string) => ({ kind: 'action', key, action: 'log', inputs: { log_level: 'info', log_message: 'x' } });

// ─── trigger_strategy ─────────────────────────────────────────────────────────

describe('trigger_strategy (record.updated / record.created_or_updated)', () => {
  it('accepts every catalogue choice: once, always, every, unique_changes', () => {
    expect([...TRIGGER_STRATEGIES]).toEqual(['once', 'always', 'every', 'unique_changes']);
    for (const type of ['record.updated', 'record.created_or_updated']) {
      for (const s of TRIGGER_STRATEGIES) {
        const spec = ok(base({ trigger: { key: 't', type, table: 'incident', trigger_strategy: s } }));
        expect((spec.trigger as { trigger_strategy?: string }).trigger_strategy).toBe(s);
      }
    }
  });

  it('rejects an unknown strategy and the field on record.created (strict)', () => {
    expect(bad(base({ trigger: { key: 't', type: 'record.updated', table: 'incident', trigger_strategy: 'sometimes' } }))).toMatch(/trigger\.trigger_strategy/);
    expect(bad(base({ trigger: { key: 't', type: 'record.created', table: 'incident', trigger_strategy: 'every' } }))).toMatch(/trigger_strategy|Unrecognized key/);
  });

  it('the generator stores always / every in the descriptor (value + choice label)', async () => {
    for (const [s, label] of [['always', 'Only if not currently running'], ['every', 'For every update']] as const) {
      const plan = await generatePlan(ok(base({ trigger: { key: 't', type: 'record.updated', table: 'incident', trigger_strategy: s } })));
      const entries = decodeValues(String(plan.trigger!.fields.trigger_inputs)) as { name: string; value: unknown; displayValue?: unknown; choiceList?: { fValue: string; fLabel: string }[] }[];
      const e = entries.find(x => x.name === 'trigger_strategy')!;
      expect(e.value).toBe(s);
      expect(e.displayValue).toBe(s);
      expect(e.choiceList?.find(c => c.fValue === s)?.fLabel).toBe(label);
      expect(plan.warnings.filter(w => /trigger_strategy/.test(w))).toEqual([]);
    }
  });
});

// ─── label on if / else_if / do_until ────────────────────────────────────────

describe('label on if / else_if / do_until', () => {
  const IF = {
    kind: 'if', key: 'is_p1', label: 'Is P1', condition: '{{trigger.current.priority}}=1', then: [log('a')],
    else_if: [{ key: 'is_p2', label: 'Is P2', condition: '{{trigger.current.priority}}=2', steps: [log('b')] }],
    else: { key: 'other', steps: [log('c')] },
  };
  const UNTIL = { kind: 'do_until', key: 'poll', label: 'Poll until resolved', condition: '{{trigger.current.state}}=6', steps: [log('d')] };

  it('parses the label on the step and on each else_if branch', () => {
    const spec = ok(withSteps([IF, UNTIL]));
    const s = spec.steps as unknown as { label?: string; else_if?: { label?: string }[] }[];
    expect(s[0].label).toBe('Is P1');
    expect(s[0].else_if?.[0].label).toBe('Is P2');
    expect(s[1].label).toBe('Poll until resolved');
  });

  it('rejects an empty label, a label on else / for_each (strict)', () => {
    expect(bad(withSteps([{ ...IF, label: '' }]))).toMatch(/steps\.0\.label/);
    expect(bad(withSteps([{ ...IF, else: { key: 'other', label: 'x', steps: [] } }]))).toMatch(/Unrecognized key|label/);
    expect(bad(withSteps([{ kind: 'for_each', key: 'fe', label: 'x', items: { pill: 'trigger.current' }, steps: [] }]))).toMatch(/Unrecognized key|label/);
  });

  it('the generator writes condition_name before condition; unlabelled blocks keep the single condition input', async () => {
    const plan = await generatePlan(ok(withSteps([IF, UNTIL])), { resolvePillType: async () => 'string' });
    const logic = plan.instances.map((r, i) => ({ r, i })).filter(x => x.r.table === 'sys_hub_flow_logic_instance_v2');
    const inputsOf = (i: number) => (values(plan, i).inputs as { name: string; value: unknown }[]).map(e => [e.name, e.value]);
    expect(inputsOf(logic[0].i)).toEqual([['condition_name', 'Is P1'], ['condition', expect.stringMatching(/=1$/)]]);
    expect(inputsOf(logic[1].i)).toEqual([['condition_name', 'Is P2'], ['condition', expect.stringMatching(/=2$/)]]);
    // logic rows in flat order: If, Else If, Else, Do Until
    expect(logic).toHaveLength(4);
    expect(inputsOf(logic[2].i)).toEqual([]);
    expect(inputsOf(logic[3].i)).toEqual([['condition_name', 'Poll until resolved'], ['condition', expect.stringMatching(/=6$/)]]);

    const plain = await generatePlan(ok(withSteps([{ ...IF, label: undefined, else_if: undefined, else: undefined }])), { resolvePillType: async () => 'string' });
    expect((values(plain, 0).inputs as { name: string }[]).map(e => e.name)).toEqual(['condition']);
  });
});

// ─── float ────────────────────────────────────────────────────────────────────

describe('float variable type', () => {
  it('is a declared variable type and generates internal_type float, max_length 40 (the value float inputs / outputs carry on the instance)', async () => {
    expect(VARIABLE_TYPES).toContain('float');
    const plan = await generatePlan(ok(withSteps(
      [{ kind: 'set_variables', key: 'set', assign: { ratio: 2.25 } }],
      { variables: [{ name: 'ratio', type: 'float' }] },
    )));
    expect(plan.variables[0].fields).toMatchObject({ element: 'ratio', internal_type: 'float', max_length: '40' });
    expect(plan.warnings).toEqual([]);
  });

  it('a float subflow input is accepted too', () => {
    ok({ spec_version: '1', flow: { key: 's', name: 'S', type: 'subflow' }, inputs: [{ name: 'ratio', type: 'float' }], steps: [] });
  });
});

// ─── {template} items inside {list} ──────────────────────────────────────────

describe('{template} items inside {list}', () => {
  const VARS = { variables: [{ name: 'items', type: 'array.object' }, { name: 'tags', type: 'array.string' }] };
  const MANY = { list: [{ template: { number: 'INC0000001', priority: 1, done: true } }, { template: { number: { pill: 'trigger.current.number' }, priority: 3, done: false } }] };

  it('parse: a list of object literals is a valid value', () => {
    const spec = ok(withSteps([{ kind: 'append_variables', key: 'add', assign: { items: MANY } }], VARS));
    expect(((spec.steps[0] as unknown as { assign: { items: { list: unknown[] } } }).assign.items.list)).toHaveLength(2);
  });

  it('parse: the template "^" guard still applies inside list items', () => {
    expect(bad(withSteps([{ kind: 'append_variables', key: 'add', assign: { items: { list: [{ template: { note: 'a^b=1' } }] } } }], VARS))).toMatch(/contains "\^"/);
  });

  it('generate: appends every object as one collection with one "item" descriptor per element', async () => {
    const plan = await generatePlan(ok(withSteps([{ kind: 'append_variables', key: 'add', assign: { items: MANY } }], VARS)), { resolvePillType: async () => 'string' });
    const v = values(plan, 0).variables as { name: string; value: string; children: unknown[] }[];
    expect(v[0].name).toBe('items');
    const payload = JSON.parse(v[0].value) as { complexObject: { $COCollectionField: Record<string, unknown>[] } };
    expect(payload.complexObject.$COCollectionField).toEqual([
      { number: 'INC0000001', priority: 1, done: true },
      { number: '{{Created_1.current.number}}', priority: 3, done: false },
    ]);
    expect(v[0].children).toHaveLength(2);
    // the object schema is derived from the literals
    const co = plan.variables.find(r => r.table === 'sys_complex_object')!;
    expect(String(co.fields.serialized_content)).toContain('"priority":"Integer"');
  });

  it('generate: a mixed list (object literals and plain items) on an array.object append is a spec error', async () => {
    const mixed = { list: [{ template: { number: 'INC0000001' } }, 'loose'] };
    expect(await semanticErrors(generatePlan(ok(withSteps([{ kind: 'append_variables', key: 'add', assign: { items: mixed } }], VARS))))).toMatch(/every \{list\} item must be a \{template/);
  });

  it('generate: a {template} item anywhere else (action input, scalar-array append, template field) is a spec error', async () => {
    const LIST = { list: ['a', { template: { x: '1' } }] };
    const inAction = withSteps([{ kind: 'action', key: 'upd', action: 'updateRecord', inputs: { table_name: 'incident', record: { pill: 'trigger.current' }, values: { template: { work_notes: 'x' } }, } },
      { kind: 'action', key: 'cat', action: 'getCatalogVariables', inputs: { requested_item: { pill: 'trigger.current' }, template_catalog_item: 'e'.repeat(32), catalog_variables: LIST } }]);
    expect(await semanticErrors(generatePlan(ok(inAction), { resolvePillType: async () => 'reference' }))).toMatch(/step "cat": "catalog_variables": a \{template\} item inside \{list\} is only valid in an append_variables value/);
    expect(await semanticErrors(generatePlan(ok(withSteps([{ kind: 'append_variables', key: 'add', assign: { tags: LIST } }], VARS))))).toMatch(/step "add": "tags": a \{template\} item inside \{list\}/);
    const inTemplate = withSteps([{ kind: 'action', key: 'upd', action: 'updateRecord', inputs: { table_name: 'incident', record: { pill: 'trigger.current' }, values: { template: { watch_list: LIST } } } }]);
    expect(await semanticErrors(generatePlan(ok(inTemplate), { resolvePillType: async () => 'reference' }))).toMatch(/\{template\} object literal — only valid in an append_variables value/);
  });

  it('encodeList refuses a {template} item (defensive)', () => {
    expect(() => encodeList(['a', { template: { x: '1' } }], 'glide_list', s => s)).toThrow(/\{list\}\[1\] is a \{template\} object literal/);
    expect(encodeList(['a', { pill: 'p' }, { reference: 'b'.repeat(32) }], 'glide_list', s => `{{${s}}}`)).toBe(`a,{{p}},${'b'.repeat(32)}`);
  });
});
