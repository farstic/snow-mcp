import { describe, it, expect } from 'vitest';
import { ServiceNowError, formatServiceNowError } from '../../src/utils/errors.js';

describe('formatServiceNowError', () => {
  it('is message + code when the error carries no errors list', () => {
    expect(formatServiceNowError(new ServiceNowError('boom', 'X'))).toBe('Error: boom (Code: X)');
    expect(formatServiceNowError(new ServiceNowError('boom', 'X', { status: 500 }))).toBe('Error: boom (Code: X)');
  });

  it('appends each entry of details.errors (strings and {path, message})', () => {
    const e = new ServiceNowError('spec is invalid (2 errors)', 'FLOW_BUILDER_INVALID_SPEC', { errors: [{ path: 'trigger.type', message: 'bad type' }, 'step "a": unknown input "b"'] });
    expect(formatServiceNowError(e)).toBe('Error: spec is invalid (2 errors) (Code: FLOW_BUILDER_INVALID_SPEC)\n- trigger.type: bad type\n- step "a": unknown input "b"');
  });

  it('caps the list', () => {
    const e = new ServiceNowError('many', 'X', { errors: Array.from({ length: 25 }, (_, i) => `e${i}`) });
    const lines = formatServiceNowError(e).split('\n');
    expect(lines).toHaveLength(22);
    expect(lines[21]).toBe('- … 5 more');
  });
});
