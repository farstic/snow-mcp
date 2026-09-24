import { describe, it, expect } from 'vitest';
import { parsePill, pillsInText, toPlatformPill, rewritePills } from '../../src/flow-builder/pills.js';
import { buildLabelCache, labelCase } from '../../src/flow-builder/labels.js';

const SYS_ID = '0123456789abcdef0123456789abcdef';

describe('parsePill', () => {
  it('parses every root', () => {
    expect(parsePill('trigger.current')).toEqual({ root: 'trigger', name: 'current', path: [] });
    expect(parsePill('trigger.current.caller_id.email')).toEqual({ root: 'trigger', name: 'current', path: ['caller_id', 'email'] });
    expect(parsePill('steps.approve.approval_state')).toEqual({ root: 'steps', key: 'approve', output: 'approval_state', path: [] });
    expect(parsePill('steps.ct.Catalog Task.number')).toEqual({ root: 'steps', key: 'ct', output: 'Catalog Task', path: ['number'] });
    expect(parsePill('loop.each_ci.item')).toEqual({ root: 'loop', key: 'each_ci', path: [] });
    expect(parsePill('loop.each_ci.item.name')).toEqual({ root: 'loop', key: 'each_ci', path: ['name'] });
    expect(parsePill('vars.note')).toEqual({ root: 'vars', name: 'note', path: [] });
    expect(parsePill('inputs.message')).toEqual({ root: 'inputs', name: 'message', path: [] });
    expect(parsePill('error.message')).toEqual({ root: 'error', name: 'message', path: [] });
    expect(parsePill(`static.${SYS_ID}`)).toEqual({ root: 'static', sys_id: SYS_ID });
  });

  it('trims surrounding whitespace and rejects invalid pills with a coded error', () => {
    expect(parsePill('  vars.note ')).toEqual({ root: 'vars', name: 'note', path: [] });
    expect(() => parsePill('current.number')).toThrow(expect.objectContaining({ code: 'FLOW_BUILDER_INVALID_PILL' }));
    expect(() => parsePill('steps.x')).toThrow(/invalid symbolic pill/);
  });
});

describe('pillsInText', () => {
  it('returns distinct trimmed tokens in order of first appearance', () => {
    expect(pillsInText('a {{vars.x}} b {{ vars.y }} c {{vars.x}}')).toEqual(['vars.x', 'vars.y']);
    expect(pillsInText('no pills')).toEqual([]);
  });
});

// The stub-era NOT_IMPLEMENTED assertions were retired once the GENERATOR implemented these
// functions; full coverage lives in tests/flow-builder/generator/pills-labels.test.ts.
describe('GENERATOR implementations keep the agreed signatures', () => {
  const ctx = { triggerPrefix: 'Created_1', stepUuid: () => undefined, loopUuid: () => undefined };
  it('toPlatformPill / rewritePills / buildLabelCache are implemented', () => {
    expect(toPlatformPill('vars.note', ctx)).toBe('{{flow_variable.note}}');
    expect(rewritePills('a {{vars.note}} b', ctx)).toBe('a {{flow_variable.note}} b');
    expect(buildLabelCache([], () => ({ type: 'string', base_type: 'string', label: 'x' }))).toEqual([]);
  });
});

describe('labelCase', () => {
  it('label-cases dotted-walk segments the way label_cache expects', () => {
    expect(labelCase('caller_id')).toBe('Caller Id');
    expect(labelCase('assignment_group')).toBe('Assignment Group');
    expect(labelCase('email')).toBe('Email');
    expect(labelCase('u__odd')).toBe('U Odd');
  });
});
