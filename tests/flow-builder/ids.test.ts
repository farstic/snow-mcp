import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sysIdFor, sysIdToUuid, uuidToSysId, isSysId, ELEMENT_KEYS, SYS_ID_RE, UUID_RE } from '../../src/flow-builder/ids.js';

describe('sysIdFor', () => {
  it('is deterministic and 32 lowercase hex chars', () => {
    const a = sysIdFor('p1_incident_review', 'step:log_p1');
    const b = sysIdFor('p1_incident_review', 'step:log_p1');
    expect(a).toBe(b);
    expect(a).toMatch(SYS_ID_RE);
    expect(isSysId(a)).toBe(true);
  });

  it('is exactly the first 32 hex chars of sha256(flowKey + ":" + elementKey)', () => {
    const expected = createHash('sha256').update('flow_a:step:x', 'utf8').digest('hex').slice(0, 32);
    expect(sysIdFor('flow_a', 'step:x')).toBe(expected);
  });

  it('differs per flow key and per element key', () => {
    expect(sysIdFor('a', 'x')).not.toBe(sysIdFor('b', 'x'));
    expect(sysIdFor('a', 'x')).not.toBe(sysIdFor('a', 'y'));
    // the separator matters: ('ab','c') vs ('a','bc')
    expect(sysIdFor('ab', 'c')).not.toBe(sysIdFor('a', 'bc'));
  });

  it('rejects empty keys', () => {
    expect(() => sysIdFor('', 'x')).toThrow(/flowKey is required/);
    expect(() => sysIdFor('a', '')).toThrow(/elementKey is required/);
  });

  it('ELEMENT_KEYS produce distinct, stable element keys', () => {
    const keys = [ELEMENT_KEYS.flow, ELEMENT_KEYS.trigger, ELEMENT_KEYS.variable('n'), ELEMENT_KEYS.variableDoc('n'), ELEMENT_KEYS.input('n'), ELEMENT_KEYS.output('n'),
      ELEMENT_KEYS.stage('n'), ELEMENT_KEYS.step('n'), ELEMENT_KEYS.branch('n'), ELEMENT_KEYS.errorHandler('n'), ELEMENT_KEYS.aliasMapping('n')];
    expect(new Set(keys).size).toBe(keys.length);
    expect(ELEMENT_KEYS.step('log_p1')).toBe('step:log_p1');
  });
});

describe('sysIdToUuid / uuidToSysId', () => {
  it('formats 8-4-4-4-12 and round-trips', () => {
    const id = '0123456789abcdef0123456789abcdef';
    const uuid = sysIdToUuid(id);
    expect(uuid).toBe('01234567-89ab-cdef-0123-456789abcdef');
    expect(uuid).toMatch(UUID_RE);
    expect(uuidToSysId(uuid)).toBe(id);
    expect(uuidToSysId(uuid.toUpperCase())).toBe(id);
  });

  it('round-trips a derived id', () => {
    const id = sysIdFor('f', 'step:s');
    expect(uuidToSysId(sysIdToUuid(id))).toBe(id);
  });

  it('rejects malformed input', () => {
    expect(() => sysIdToUuid('abc')).toThrow(/not a 32-char/);
    expect(() => sysIdToUuid('0123456789ABCDEF0123456789ABCDEF')).toThrow(/not a 32-char/);
    expect(() => uuidToSysId('0123456789abcdef0123456789abcdef')).toThrow(/not a uuid/);
    expect(isSysId(42)).toBe(false);
  });
});
