/**
 * Value encoders (generator/values.ts): glide_duration / glide_time, template_value (incl. the
 * UI-built {reference} form and inline-script sub-fields), approval-rules grammar, lists, due_date.
 *
 * Owner: GENERATOR.
 */
import { describe, it, expect } from 'vitest';
import * as V from '../../../src/flow-builder/generator/values.js';

const pill = (s: string) => `{{P:${s}}}`;
const text = (s: string) => s.replace(/\{\{([^}]+)\}\}/g, (_m, b: string) => `{{P:${b}}}`);

describe('durations and times', () => {
  it('glide_duration = 1970-01-01 00:00:00 + duration (days roll the day of month)', () => {
    expect(V.durationToGlide({ days: 1, hours: 2, minutes: 30, seconds: 15 })).toBe('1970-01-02 02:30:15');
    expect(V.durationToGlide({ days: 2, hours: 12 })).toBe('1970-01-03 12:00:00');
    expect(V.durationToGlide({ hours: 4 })).toBe('1970-01-01 04:00:00');
    expect(V.durationToGlide('3 01:00:00')).toBe('1970-01-04 01:00:00');
    expect(V.durationToGlide(undefined)).toBe('1970-01-01 00:00:00');
  });

  it('glide_time is converted to UTC with the zone offset on 1970-01-01 (glide_time values are stored in UTC)', () => {
    expect(V.timeToGlide('08:00:00', 'Europe/Sofia')).toBe('1970-01-01 06:00:00');
    expect(V.timeToGlide('09:30:00', 'UTC')).toBe('1970-01-01 09:30:00');
    expect(V.timeToGlide('23:59:59')).toBe('1970-01-01 23:59:59');
    expect(() => V.timeToGlide('08:00', 'UTC')).toThrow(/invalid time/);
    expect(() => V.timeToGlide('08:00:00', 'Mars/Olympus')).toThrow(/unknown timezone/);
  });
});

describe('template_value', () => {
  it('encodes f=v^…^EQ with pills, stringified scalars and texts', () => {
    const enc = V.encodeTemplate({ impact: '1', state: 7, active: false, assignment_group: { pill: 'steps.l.Record' }, work_notes: { text: 'by {{trigger.current.number}}' } }, pill, text);
    expect(enc.value).toBe('impact=1^state=7^active=false^assignment_group={{P:steps.l.Record}}^work_notes=by {{P:trigger.current.number}}^EQ');
    expect(enc.scripts).toEqual({});
  });

  it('writes a static {reference} in the UI-built form field={"display","value"} (PDI-FACTS §8, FORMAT-DECISIONS D11)', () => {
    const enc = V.encodeTemplate({ assignment_group: { reference: '8a4cb6d4c61122780043b1642efcd52b', display: 'Procurement' }, description: 'x' }, pill, text);
    expect(enc.value).toBe('assignment_group={"display":"Procurement","value":"8a4cb6d4c61122780043b1642efcd52b"}^description=x^EQ');
  });

  it('an inline {script} sub-field writes the fd-scripted placeholder and a script map', () => {
    const enc = V.encodeTemplate({ work_notes: { script: 'return 1;' }, impact: '2' }, pill, text);
    expect(enc.value).toBe('work_notes=fd-scripted^impact=2^EQ');
    expect(enc.scripts).toEqual({ work_notes: 'return 1;' });
  });

  it('REFUSES a "^" in any literal part — it would inject extra field assignments (regression: work_notes:"note A^priority=1^state=7")', () => {
    const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return 'NO_THROW'; };
    expect(code(() => V.encodeTemplate({ work_notes: 'note A^priority=1^state=7' }, pill, text))).toBe('FLOW_BUILDER_INVALID_SPEC');
    expect(code(() => V.encodeTemplate({ work_notes: { text: 'x^EQ' } }, pill, text))).toBe('FLOW_BUILDER_INVALID_SPEC');
    expect(code(() => V.encodeTemplate({ assignment_group: { reference: '8a4cb6d4c61122780043b1642efcd52b', display: 'A^B' } }, pill, text))).toBe('FLOW_BUILDER_INVALID_SPEC');
    expect(code(() => V.encodeTemplate({ watch_list: { list: ['a^b'] } }, pill, text))).toBe('FLOW_BUILDER_INVALID_SPEC');
    expect(code(() => V.encodeTemplate({ 'x^y': '1' }, pill, text))).toBe('FLOW_BUILDER_INVALID_SPEC');
    // pills and scripts are not literal parts: still fine
    expect(code(() => V.encodeTemplate({ work_notes: { script: 'return "a^b";' }, assignment_group: { pill: 'steps.l.Record' } }, pill, text))).toBe('NO_THROW');
  });
});

describe('approval rules grammar (PDI-FACTS §8, FORMAT-DECISIONS.md)', () => {
  it('single group rule', () => {
    expect(V.encodeApprovalRules({ rule_sets: [{ action: 'Approves', rules: [[{ rule: 'Any', groups: [{ pill: 'steps.l.Record' }] }]] }] }, pill))
      .toBe('ApprovesAnyG[{{P:steps.l.Record}}]');
  });

  it('users + groups, rule sets joined by Or, bare sys_ids become static pills', () => {
    const s = V.encodeApprovalRules({
      rule_sets: [
        { action: 'Approves', rules: [[{ rule: 'All', users: [{ pill: 'trigger.current.caller_id' }, 'a'.repeat(32)], groups: [{ reference: 'b'.repeat(32) }] }]] },
        { action: 'Rejects', rules: [[{ rule: 'Any', users: [{ pill: 'trigger.current.caller_id' }] }]] },
      ],
    }, pill);
    expect(s).toBe(`ApprovesAllU[{{P:trigger.current.caller_id}},{{static.${'a'.repeat(32)}}}]G[{{static.${'b'.repeat(32)}}}]OrRejectsAnyU[{{P:trigger.current.caller_id}}]`);
  });

  it('count / percent / manual and the & / | separators', () => {
    const s = V.encodeApprovalRules({
      rule_sets: [{ action: 'ApprovesRejects', rules: [
        [{ rule: { count: 2 }, groups: ['c'.repeat(32)] }, { rule: { percent: 50 }, users: ['d'.repeat(32)] }],
        [{ rule: 'Res', manual: true }],
      ] }],
    }, pill);
    expect(s).toBe(`ApprovesRejects2#G[{{static.${'c'.repeat(32)}}}]|50%U[{{static.${'d'.repeat(32)}}}]&ResM`);
  });

  it('the due_date default is the UI-built JSON (PDI-FACTS §8)', () => {
    expect(JSON.parse(V.DUE_DATE_DEFAULT)).toEqual({ action: 'none', date_type: 'actual', date: '{{}}', duration: 1, duration_type: 'days', schedule: '', schedule_label: '' });
    expect(Object.keys(JSON.parse(V.DUE_DATE_DEFAULT))).toEqual(['action', 'date_type', 'date', 'duration', 'duration_type', 'schedule', 'schedule_label']);
  });
});

describe('lists and scalars', () => {
  it('slushbucket items are <sys_id>:item_option_new; glide_list is comma-joined', () => {
    const a = 'a'.repeat(32); const b = 'b'.repeat(32);
    expect(V.encodeList([a, { reference: b }], 'slushbucket', pill)).toBe(`${a}:item_option_new,${b}:item_option_new`);
    expect(V.encodeList([`${a}:item_option_new_set`], 'slushbucket', pill)).toBe(`${a}:item_option_new_set`);
    expect(V.encodeList([a, { pill: 'trigger.current.caller_id' }], 'glide_list', pill)).toBe(`${a},{{P:trigger.current.caller_id}}`);
  });

  it('booleans and integers keep their JSON type for typed inputs', () => {
    expect(V.coerceScalar('true', 'boolean')).toBe(true);
    expect(V.coerceScalar(0, 'boolean')).toBe(false);
    expect(V.coerceScalar('20', 'integer')).toBe(20);
    expect(V.coerceScalar('x', 'string')).toBe('x');
    expect(V.stringifyScalar(1.5)).toBe('1.5');
  });

  it('internal_name derivation: lowercase, spaces → _, " - " → __', () => {
    expect(V.internalNameFor('Change - Normal - Implement')).toBe('change__normal__implement');
    expect(V.internalNameFor('P1 Incident Review')).toBe('p1_incident_review');
  });

  it('valueKind rejects an unknown object form', () => {
    expect(() => V.valueKind({ nope: 1 } as never)).toThrow(/unrecognised value/);
  });
});
