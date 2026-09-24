import { describe, it, expect, beforeEach } from 'vitest';
import { requireFlowBuilder, requireFlowBuilderActivate, isFlowBuilderEnabled, isFlowBuilderActivateEnabled } from '../../src/utils/permissions.js';

const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as { code?: string }).code ?? 'NO_CODE'; }
  return 'NO_THROW';
};

describe('flow-builder permission flags', () => {
  beforeEach(() => {
    delete process.env.FLOW_BUILDER_ENABLED;
    delete process.env.FLOW_BUILDER_ACTIVATE_ENABLED;
    delete process.env.WRITE_ENABLED;
  });

  it('requireFlowBuilder needs FLOW_BUILDER_ENABLED=true exactly', () => {
    expect(code(requireFlowBuilder)).toBe('FLOW_BUILDER_NOT_ENABLED');
    process.env.FLOW_BUILDER_ENABLED = 'TRUE';
    expect(code(requireFlowBuilder)).toBe('FLOW_BUILDER_NOT_ENABLED');
    process.env.FLOW_BUILDER_ENABLED = 'true';
    expect(code(requireFlowBuilder)).toBe('NO_THROW');
    expect(isFlowBuilderEnabled()).toBe(true);
  });

  it('requireFlowBuilderActivate needs the builder flag, WRITE_ENABLED and the activate flag', () => {
    expect(code(requireFlowBuilderActivate)).toBe('FLOW_BUILDER_NOT_ENABLED');
    process.env.FLOW_BUILDER_ENABLED = 'true';
    expect(code(requireFlowBuilderActivate)).toBe('WRITE_NOT_ENABLED');
    process.env.WRITE_ENABLED = 'true';
    expect(code(requireFlowBuilderActivate)).toBe('FLOW_BUILDER_ACTIVATE_NOT_ENABLED');
    expect(isFlowBuilderActivateEnabled()).toBe(false);
    process.env.FLOW_BUILDER_ACTIVATE_ENABLED = 'true';
    expect(code(requireFlowBuilderActivate)).toBe('NO_THROW');
    expect(isFlowBuilderActivateEnabled()).toBe(true);
  });

  it('the activate flag alone never enables anything', () => {
    process.env.FLOW_BUILDER_ACTIVATE_ENABLED = 'true';
    expect(isFlowBuilderEnabled()).toBe(false);
    expect(isFlowBuilderActivateEnabled()).toBe(false);
    expect(code(requireFlowBuilderActivate)).toBe('FLOW_BUILDER_NOT_ENABLED');
  });
});
