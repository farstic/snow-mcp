/**
 * pills.ts (symbolic → platform pill rewriting) and labels.ts (label_cache builder) — GENERATOR part.
 *
 * Owner: GENERATOR.
 */
import { describe, it, expect } from 'vitest';
import { toPlatformPill, toPlatformPillName, rewritePills, platformPillsInText, type PillContext } from '../../../src/flow-builder/pills.js';
import { buildLabelCache, labelCase, type PillUsage } from '../../../src/flow-builder/labels.js';

const ctx: PillContext = {
  triggerPrefix: 'Created_1',
  stepUuid: k => (k === 'look' ? '11111111-2222-3333-4444-555555555555' : undefined),
  loopUuid: k => (k === 'each' ? '66666666-7777-8888-9999-000000000000' : undefined),
  errorHandlerUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
};

describe('toPlatformPill', () => {
  it('rewrites every root', () => {
    expect(toPlatformPill('trigger.current', ctx)).toBe('{{Created_1.current}}');
    expect(toPlatformPill('trigger.current.caller_id.email', ctx)).toBe('{{Created_1.current.caller_id.email}}');
    expect(toPlatformPill('steps.look.Record.state', ctx)).toBe('{{11111111-2222-3333-4444-555555555555.Record.state}}');
    expect(toPlatformPill('steps.look.Catalog Task', ctx)).toBe('{{11111111-2222-3333-4444-555555555555.Catalog Task}}');
    expect(toPlatformPill('loop.each.item.number', ctx)).toBe('{{66666666-7777-8888-9999-000000000000.item.number}}');
    expect(toPlatformPill('vars.note', ctx)).toBe('{{flow_variable.note}}');
    expect(toPlatformPill('inputs.target.number', ctx)).toBe('{{subflow.target.number}}');
    expect(toPlatformPill('error.message', ctx)).toBe('{{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.__status__.message}}');
    expect(toPlatformPill(`static.${'a'.repeat(32)}`, ctx)).toBe(`{{static.${'a'.repeat(32)}}}`);
  });

  it('refuses unknown targets and pills that need a trigger / an error handler', () => {
    expect(() => toPlatformPillName('steps.nope.Record', ctx)).toThrow(/unknown step "nope"/);
    expect(() => toPlatformPillName('loop.nope.item', ctx)).toThrow(/unknown for_each "nope"/);
    expect(() => toPlatformPillName('trigger.current', { ...ctx, triggerPrefix: '' })).toThrow(/needs a trigger/);
    expect(() => toPlatformPillName('error.message', { ...ctx, errorHandlerUuid: undefined })).toThrow(/error_handler/);
    expect(() => toPlatformPillName('nope.x', ctx)).toThrow(/invalid symbolic pill/);
  });
});

describe('rewritePills / platformPillsInText', () => {
  it('rewrites mixed text and leaves the empty {{}} placeholder alone (UI due_date "date")', () => {
    expect(rewritePills('P1 {{trigger.current.number}} by {{ vars.note }}', ctx)).toBe('P1 {{Created_1.current.number}} by {{flow_variable.note}}');
    expect(rewritePills('{"date":"{{}}"}', ctx)).toBe('{"date":"{{}}"}');
    expect(platformPillsInText('{{a.b}} {{a.b}} {{}} {{c}}')).toEqual(['a.b', 'c']);
  });
});

describe('buildLabelCache', () => {
  it('one entry per pill in first-use order; each input listed once per instance; static pills named with their braces', () => {
    const u = (platform: string, instanceUuid: string, inputName: string): PillUsage => ({ platform, symbolic: '', instanceUuid, inputName });
    const lc = buildLabelCache([
      u('Created_1.current.number', 'i1', 'log_message'),
      u('Created_1.current', 'i2', 'record'),
      u('Created_1.current.number', 'i1', 'log_message'),
      u('Created_1.current.number', 'i3', 'ah_subject'),
      u(`static.${'a'.repeat(32)}`, 'i3', 'approval_conditions'),
    ], p => (p === 'Created_1.current'
      ? { type: 'reference', base_type: 'reference', label: 'Trigger - Record Created➛Incident Record', reference: 'incident', reference_display: 'Incident', attributes: {} }
      : p.startsWith('static.')
        ? { type: 'reference', base_type: 'reference', label: 'Example Group', reference: 'sys_user_group', reference_display: 'Group' }
        : { type: 'string', base_type: 'string', label: 'Trigger - Record Created➛Incident Record➛Number', reference: '', reference_display: 'Number', parent_table_name: 'incident', column_name: 'number' }));
    expect(lc.map(e => e.name)).toEqual(['Created_1.current.number', 'Created_1.current', `{{static.${'a'.repeat(32)}}}`]);
    expect(lc[0].usedInstances).toEqual({ i1: ['log_message'], i3: ['ah_subject'] });
    // the UI key order (PDI-FACTS §6): reference keys before type, parent_table_name / column_name after base_type, usedInstances, then attributes (absent on a dot-walk)
    expect(Object.keys(lc[0])).toEqual(['name', 'label', 'reference', 'reference_display', 'type', 'base_type', 'parent_table_name', 'column_name', 'usedInstances']);
    expect(Object.keys(lc[1])).toEqual(['name', 'label', 'reference', 'reference_display', 'type', 'base_type', 'usedInstances', 'attributes']);
    expect(lc[1]).toMatchObject({ reference: 'incident', reference_display: 'Incident' });
    expect(lc[2]).toEqual({ name: `{{static.${'a'.repeat(32)}}}`, label: 'Example Group', reference: 'sys_user_group', reference_display: 'Group', type: 'reference', base_type: 'reference', usedInstances: { i3: ['approval_conditions'] } });
  });

  it('writes choices after column_name and keeps column_name of records pills', () => {
    const lc = buildLabelCache([{ platform: 'x.Records', symbolic: '', instanceUuid: 'i', inputName: 'items' }],
      () => ({ type: 'records', base_type: 'records', label: 'x➛Records', column_name: 'Records', choices: [{ label: 'A', value: 'a', order: 0 }], attributes: {} }));
    expect(lc[0].column_name).toBe('Records');
    expect(Object.keys(lc[0])).toEqual(['name', 'label', 'type', 'base_type', 'column_name', 'choices', 'usedInstances', 'attributes']);
  });
});

describe('label helpers', () => {
  it('labelCase title-cases each _-word', () => {
    expect(labelCase('caller_id')).toBe('Caller Id');
    expect(labelCase('sys_id')).toBe('Sys Id');
  });
});
