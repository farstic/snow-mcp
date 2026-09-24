/**
 * snow_flow_export_xml — implicit-delete safety (review finding): the emitted file carries
 * platform-shaped delete_multiple elements (`flow=<id>^sys_idNOT IN<planned>` per child table plus the
 * housekeeping deletes). With spec.flow.sys_id (adopting an EXISTING flow) an import deletes every child
 * row of that flow the plan does not carry, and Import Preview does not show it. The export must refuse
 * such a spec without replace_existing:true and must always return the delete_multiple list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchFlowBuilderAction } from '../../src/tools/flow-builder.js';
import { listDeleteMultiples } from '../../src/flow-builder/xml/unload.js';
import { sysIdFor, ELEMENT_KEYS } from '../../src/flow-builder/ids.js';
import type { ServiceNowClient } from '../../src/servicenow/client.js';

const ADOPTED = 'e'.repeat(32);
const base = (flow: Record<string, unknown> = {}) => ({
  spec_version: '1',
  flow: { key: 'export_probe', name: 'Export Probe', ...flow },
  trigger: { key: 't', type: 'record.created', table: 'incident' },
  steps: [{ kind: 'action', key: 'log', action: 'log', inputs: { log_message: 'x' } }],
});
const noClient = undefined as unknown as ServiceNowClient;

let root: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { FLOW_BUILDER_ENABLED: process.env.FLOW_BUILDER_ENABLED, FLOW_BUILDER_EXPORT_ROOT: process.env.FLOW_BUILDER_EXPORT_ROOT };
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fb-export-safety-')));
  process.env.FLOW_BUILDER_ENABLED = 'true';
  process.env.FLOW_BUILDER_EXPORT_ROOT = root;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as { code?: string }).code ?? 'NO_CODE'; }
  return 'NO_THROW';
}

describe('snow_flow_export_xml — adopting an existing flow', () => {
  for (const format of ['update_set', 'record_update'] as const) {
    it(`${format}: refuses spec.flow.sys_id without replace_existing:true and writes no file`, async () => {
      const args = { spec: base({ sys_id: ADOPTED }), format, update_set_name: 'TEST_ADOPT', out_path: `adopt_${format}.xml` };
      expect(await codeOf(dispatchFlowBuilderAction(noClient, 'snow_flow_export_xml', args))).toBe('FLOW_BUILDER_EXPORT_REPLACES_EXISTING');
      expect(existsSync(join(root, `adopt_${format}.xml`))).toBe(false);
      expect(await codeOf(dispatchFlowBuilderAction(noClient, 'snow_flow_export_xml', { ...args, replace_existing: 'yes' }))).toBe('FLOW_BUILDER_EXPORT_REPLACES_EXISTING');

      const r = await dispatchFlowBuilderAction(noClient, 'snow_flow_export_xml', { ...args, replace_existing: true });
      expect(r.ok).toBe(true);
      expect(r.flowSysId).toBe(ADOPTED);
      expect(r.adoptsExistingFlow).toBe(true);
      // the child deletes against the ADOPTED flow are spelled out
      expect(r.delete_multiple).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'sys_hub_action_instance_v2', query: expect.stringMatching(new RegExp(`^flow=${ADOPTED}\\^sys_idNOT IN`)) }),
      ]));
      expect(r.delete_multiple_note).toMatch(/Preview does not list them/);
    });
  }
});

describe('snow_flow_export_xml — the delete_multiple list is always returned', () => {
  it('lists exactly the delete_multiple elements the update_set file carries, unescaped', async () => {
    const r = await dispatchFlowBuilderAction(noClient, 'snow_flow_export_xml', { spec: base(), format: 'update_set', update_set_name: 'TEST_NEW', out_path: 'new.xml' });
    const flowId = sysIdFor('export_probe', ELEMENT_KEYS.flow);
    expect(r.adoptsExistingFlow).toBe(false);
    const xml = readFileSync(r.path, 'utf8');
    expect(r.delete_multiple).toEqual(listDeleteMultiples(xml));
    expect(r.delete_multiple.length).toBe((xml.match(/action="delete_multiple"/g) ?? []).length);
    expect(r.delete_multiple.length).toBeGreaterThan(0);
    expect(r.delete_multiple).toEqual(expect.arrayContaining([
      { table: 'sys_translated_text', query: `documentkey=${flowId}` },
      expect.objectContaining({ table: 'sys_hub_action_instance_v2', query: expect.stringContaining(`flow=${flowId}^sys_idNOT IN`) }),
    ]));
  });

  it('listDeleteMultiples unescapes the query attribute and ignores other actions', () => {
    const xml = '<x><a action="INSERT_OR_UPDATE"/><sys_choice action="delete_multiple" query="name=a&amp;b^value&lt;3"/><![CDATA[<t action="delete_multiple" query="flow=1^sys_idNOT IN2,3"/>]]></x>';
    expect(listDeleteMultiples(xml)).toEqual([
      { table: 'sys_choice', query: 'name=a&b^value<3' },
      { table: 't', query: 'flow=1^sys_idNOT IN2,3' },
    ]);
  });
});
