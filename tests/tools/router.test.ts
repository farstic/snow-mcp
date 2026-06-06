import { describe, it, expect, beforeEach } from 'vitest';
import { collectToolCatalog } from '../../src/tools/index.js';

describe('collectToolCatalog – package system', () => {
  beforeEach(() => {
    delete process.env.MCP_TOOL_PACKAGE;
  });

  it('returns all 80+ tools when MCP_TOOL_PACKAGE is not set (full default)', () => {
    const tools = collectToolCatalog();
    expect(tools.length).toBeGreaterThanOrEqual(80);
  });

  it('returns a subset for service_desk package', () => {
    process.env.MCP_TOOL_PACKAGE = 'service_desk';
    const tools = collectToolCatalog();
    const names = tools.map(t => t.name);
    expect(names).toContain('snow_inc_incident_add');
    expect(names).toContain('snow_inc_incident_read');
    expect(names).toContain('snow_cat_request_approve');
    expect(names).not.toContain('snow_scr_business_rule_add');
    expect(names).not.toContain('snow_scr_changeset_commit');
  });

  it('platform_developer package includes scripting and ATF tools', () => {
    process.env.MCP_TOOL_PACKAGE = 'platform_developer';
    const tools = collectToolCatalog();
    const names = tools.map(t => t.name);
    expect(names).toContain('snow_scr_business_rules_index');
    expect(names).toContain('snow_atf_atf_suite_exec');
    expect(names).toContain('snow_atf_atf_failure_insight_read');
    expect(names).not.toContain('snow_inc_incident_add');
  });

  it('ai_developer package includes Now Assist tools', () => {
    process.env.MCP_TOOL_PACKAGE = 'ai_developer';
    const tools = collectToolCatalog();
    const names = tools.map(t => t.name);
    expect(names).toContain('snow_na_nlq_query');
    expect(names).toContain('snow_na_summary_generate');
    expect(names).toContain('snow_na_agentic_playbook_trigger');
    expect(names).toContain('snow_na_ms_copilot_topics_read');
  });

  it('returns full set for unknown package name', () => {
    process.env.MCP_TOOL_PACKAGE = 'nonexistent_package';
    const tools = collectToolCatalog();
    expect(tools.length).toBeGreaterThanOrEqual(80);
  });

  it('no duplicate tool names in full package', () => {
    const tools = collectToolCatalog();
    const names = tools.map(t => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('every tool has required MCP fields', () => {
    collectToolCatalog().forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.name).toBe('string');
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    });
  });
});
