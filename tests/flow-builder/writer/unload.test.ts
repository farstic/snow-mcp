/**
 * xml/unload.ts — Retrieved Update Set <unload> emitter, mirrored on the genuine PDI capture
 * (tests/flow-builder/fixtures/pdi/flows/leaver-flow) and a genuine Retrieved Update Set export.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { planToUnloadXml, planToCapturePayloadXml, recordsToUnloadXml, sanitizeRecordUpdate, javaStringHash, snDateTime, snRecordedAt, cdata, PAYLOAD_TABLE_ORDER } from '../../../src/flow-builder/xml/unload.js';
import { samplePlan, SAMPLE_IDS } from './sample-plan.js';

const NOW = new Date('2026-09-24T10:15:30Z');
const ids = SAMPLE_IDS();

/** Top-level child elements of a record_update in order: [tag, action, query]. */
function elementsOf(payload: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  const re = /<(sys_[a-z0-9_]+) action="([A-Za-z_]+)"(?: query="([^"]*)")?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(payload))) out.push([m[1], m[2], m[3] ?? '']);
  return out;
}

describe('planToCapturePayloadXml — the platform-shaped record_update', () => {
  const payload = planToCapturePayloadXml(samplePlan());

  it('is a sys_hub_flow record_update with the flow row first, alphabetical fields and the plan sys_id', () => {
    expect(payload.startsWith('<?xml version="1.0" encoding="UTF-8"?><record_update sys_domain="global" table="sys_hub_flow"><sys_hub_flow action="INSERT_OR_UPDATE">')).toBe(true);
    expect(payload.endsWith('</record_update>')).toBe(true);
    const flowRow = payload.slice(0, payload.indexOf('</sys_hub_flow>'));
    const tags = [...flowRow.matchAll(/<([a-z_]+)(?: [^>]*)?\/?>/g)].map(m => m[1]).filter(t => t !== 'sys_hub_flow' && t !== 'record_update');
    expect(tags).toEqual([...tags].sort());
    expect(flowRow).toContain(`<sys_id>${ids.flow}</sys_id>`);
    expect(flowRow).toContain('<active>false</active>');
    expect(flowRow).toContain('<sys_scope display_value="Global">global</sys_scope>');
    expect(flowRow).toContain('<annotation/>'); // empty value → self-closing, as the platform emits
  });

  it('emits a delete_multiple per child table in the platform order, then the rows, with the housekeeping deletes', () => {
    const els = elementsOf(payload);
    const tables = els.map(e => e[0]);
    // platform order of the child blocks
    const firstIdx = (t: string) => tables.indexOf(t);
    expect(firstIdx('sys_hub_flow_stage')).toBeLessThan(firstIdx('sys_hub_flow_input'));
    expect(firstIdx('sys_hub_flow_input')).toBeLessThan(firstIdx('sys_hub_trigger_instance_v2'));
    expect(firstIdx('sys_hub_trigger_instance_v2')).toBeLessThan(firstIdx('sys_hub_action_instance_v2'));
    expect(firstIdx('sys_hub_action_instance_v2')).toBeLessThan(firstIdx('sys_hub_sub_flow_instance_v2'));
    expect(firstIdx('sys_hub_sub_flow_instance_v2')).toBeLessThan(firstIdx('sys_hub_flow_logic_instance_v2'));
    expect(firstIdx('sys_hub_flow_logic_instance_v2')).toBeLessThan(firstIdx('sys_hub_flow_variable'));
    expect(firstIdx('sys_hub_flow_variable')).toBeLessThan(firstIdx('sys_documentation'));

    expect(els).toContainEqual(['sys_hub_flow_stage', 'delete_multiple', `flow=${ids.flow}^sys_idNOT IN${ids.stage}`]);
    expect(els).toContainEqual(['sys_hub_trigger_instance_v2', 'delete_multiple', `flow=${ids.flow}^sys_idNOT IN${ids.trigger}`]);
    expect(els).toContainEqual(['sys_hub_action_instance_v2', 'delete_multiple', `flow=${ids.flow}^sys_idNOT IN${ids.logStep}`]);
    expect(els).toContainEqual(['sys_hub_flow_logic_instance_v2', 'delete_multiple', `flow=${ids.flow}^sys_idNOT IN${ids.ifStep}`]);
    expect(els).toContainEqual(['sys_hub_flow_variable', 'delete_multiple', `model=${ids.flow}^sys_idNOT IN${ids.variable}`]);
    // tables without planned rows still get the bare parent delete_multiple (as the platform does)
    expect(els).toContainEqual(['sys_hub_sub_flow_instance_v2', 'delete_multiple', `flow=${ids.flow}`]);
    expect(els).toContainEqual(['sys_hub_flow_input', 'delete_multiple', `model=${ids.flow}`]);
    expect(els).toContainEqual(['sys_hub_flow_output', 'delete_multiple', `model=${ids.flow}`]);
    // catalog-only table is skipped when the plan has none
    expect(tables).not.toContain('sys_flow_cat_variable_model');
    // housekeeping deletes
    expect(els).toContainEqual(['sys_translated_text', 'delete_multiple', `documentkey=${ids.flow}`]);
    expect(els).toContainEqual(['sys_variable_value', 'delete_multiple', `document_key=${ids.flow}`]);
    expect(els).toContainEqual(['sys_hub_alias_mapping', 'delete_multiple', `source_id=${ids.flow}`]);
    expect(els).toContainEqual(['sys_hub_alias_mapping', 'delete_multiple', `source_id=${ids.logStep}`]);
    expect(els).toContainEqual(['sys_hub_pill_compound', 'delete_multiple', `attached_to=${ids.flow}`]);
    expect(els).toContainEqual(['sys_choice', 'delete_multiple', `name=var__m_sys_hub_flow_variable_${ids.flow}`]);
    expect(els.slice(-2)).toEqual([['sys_flow_trigger_plan', 'delete_multiple', `plan_id=${ids.flow}`], ['sys_flow_subflow_plan', 'delete_multiple', `plan_id=${ids.flow}`]]);
    // every planned row is present as INSERT_OR_UPDATE
    for (const id of Object.values(ids)) expect(payload).toContain(`<sys_id>${id}</sys_id>`);
    expect(els.filter(e => e[1] === 'INSERT_OR_UPDATE')).toHaveLength(7);
    // no apply_defaults anywhere; flow references carry the display_value
    expect(payload).not.toContain('apply_defaults');
    expect(payload).toContain(`<flow display_value="P1 Log">${ids.flow}</flow>`);
    expect(payload).toContain(`<model display_value="P1 Log">${ids.flow}</model>`);
  });

  it('wraps text with markup or newlines in CDATA and escapes the rest', () => {
    const plan = samplePlan();
    plan.flow.fields.description = 'a < b & "c"\nline2';
    plan.flow.fields.annotation = 'Tom & Jerry';
    plan.instances[0].fields.values = 'plain]]>text';
    const p = planToCapturePayloadXml(plan);
    expect(p).toContain('<description><![CDATA[a < b & "c"\nline2]]></description>');
    expect(p).toContain('<annotation><![CDATA[Tom & Jerry]]></annotation>');
    expect(p).toContain('<values><![CDATA[plain]]]]><![CDATA[>text]]></values>');
    expect(cdata('x]]>y')).toBe('<![CDATA[x]]]]><![CDATA[>y]]>');
  });

  it('refuses a plan whose flow row is not sys_hub_flow', () => {
    const plan = samplePlan();
    plan.flow = { ...plan.flow, table: 'sys_hub_action_type_definition' };
    expect(() => planToCapturePayloadXml(plan)).toThrow(/sys_hub_flow/);
  });

  it('keeps the element order of the PAYLOAD_TABLE_ORDER constant consistent with the genuine capture', () => {
    expect([...PAYLOAD_TABLE_ORDER]).toEqual([
      'sys_hub_flow_stage', 'sys_flow_cat_variable_model', 'sys_hub_flow_input', 'sys_hub_flow_output',
      'sys_hub_trigger_instance_v2', 'sys_hub_action_instance_v2', 'sys_hub_sub_flow_instance_v2', 'sys_hub_flow_logic_instance_v2',
      'sys_hub_flow_variable', 'sys_documentation',
    ]);
    const genuine = join(process.cwd(), 'tests/flow-builder/fixtures/pdi/flows/leaver-flow/sys_update_xml_payload.xml');
    if (existsSync(genuine)) {
      const g = readFileSync(genuine, 'utf8');
      const order = [...new Set(elementsOf(g).map(e => e[0]))];
      const ours = [...new Set(elementsOf(planToCapturePayloadXml(samplePlan())).map(e => e[0]))];
      // every table we emit appears in the genuine payload, in the same relative order
      const genuinePos = ours.map(t => order.indexOf(t));
      expect(genuinePos.every(p => p >= 0)).toBe(true);
      expect(genuinePos).toEqual([...genuinePos].sort((a, b) => a - b));
      expect(g).not.toContain('apply_defaults');
    }
  });
});

describe('planToUnloadXml — the Retrieved Update Set envelope', () => {
  const xml = planToUnloadXml(samplePlan(), { updateSetName: 'TEST_P1_LOG_V1', description: 'P1 log flow', now: NOW, author: 'tester' });

  it('has the genuine envelope fields, one Flow update record and a CDATA payload', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><unload unload_date="2026-09-24 10:15:30">')).toBe(true);
    expect(xml.trimEnd().endsWith('</unload>')).toBe(true);
    // sys_remote_update_set
    for (const f of ['application', 'application_name', 'application_scope', 'application_version', 'collisions', 'commit_date', 'deleted', 'description', 'inserted', 'name', 'origin_sys_id', 'parent', 'release_date', 'remote_base_update_set', 'remote_parent_id', 'remote_sys_id', 'state', 'summary', 'sys_class_name', 'sys_created_by', 'sys_created_on', 'sys_id', 'sys_mod_count', 'sys_updated_by', 'sys_updated_on', 'update_set', 'update_source', 'updated']) {
      expect(xml, f).toMatch(new RegExp(`<${f}[ />]`));
    }
    expect(xml).toContain('<state>loaded</state>');
    expect(xml).toContain('<name>TEST_P1_LOG_V1</name>');
    expect(xml).toContain('<description>P1 log flow</description>');
    expect(xml).toContain('<application display_value="Global">global</application>');
    expect(xml).toContain('<application_scope>global</application_scope>');
    expect(xml).toContain('<sys_class_name>sys_remote_update_set</sys_class_name>');
    // exactly one sys_update_xml, the Flow form: name sys_hub_flow_<id>, type Flow, empty table, target_name = flow name
    expect(xml.match(/<sys_update_xml action="INSERT_OR_UPDATE">/g)).toHaveLength(1);
    expect(xml).toContain(`<name>sys_hub_flow_${ids.flow}</name>`);
    expect(xml).toContain('<type>Flow</type>');
    expect(xml).toContain('<table/>');
    expect(xml).toContain('<target_name>P1 Log</target_name>');
    expect(xml).toContain('<category>customer</category>');
    expect(xml).toContain('<update_domain>global</update_domain>');
    expect(xml).toContain('<replace_on_upgrade>false</replace_on_upgrade>');
    expect(xml).toContain('<action>INSERT_OR_UPDATE</action>');
    for (const f of ['payload_hash', 'update_guid', 'update_guid_history', 'sys_recorded_at', 'comments', 'view', 'update_set', 'remote_update_set']) expect(xml, f).toMatch(new RegExp(`<${f}[ />]`));
    expect(xml).toContain('<payload><![CDATA[<?xml version="1.0" encoding="UTF-8"?><record_update sys_domain="global" table="sys_hub_flow">');
    expect(xml).toContain('<sys_created_by>tester</sys_created_by>');
    expect(xml).not.toContain('.split');
    expect(xml).not.toContain('apply_defaults');
    // remote_update_set on the record points at the envelope's sys_id
    const remoteId = /<sys_remote_update_set action="INSERT_OR_UPDATE">[\s\S]*?<sys_id>([0-9a-f]{32})<\/sys_id>/.exec(xml)![1];
    expect(xml).toContain(`<remote_update_set display_value="TEST_P1_LOG_V1">${remoteId}</remote_update_set>`);
  });

  it('is deterministic for the same plan + name + clock, and payload_hash / update_guid follow the payload', () => {
    const again = planToUnloadXml(samplePlan(), { updateSetName: 'TEST_P1_LOG_V1', description: 'P1 log flow', now: NOW, author: 'tester' });
    expect(again).toBe(xml);
    const payload = planToCapturePayloadXml(samplePlan(), { now: NOW, author: 'tester' });
    expect(xml).toContain(`<payload><![CDATA[${payload}]]></payload>`);
    expect(xml).toContain(`<payload_hash>${javaStringHash(payload)}</payload_hash>`);
    const guid = /<update_guid>([0-9a-f]{32})<\/update_guid>/.exec(xml)![1];
    expect(xml).toContain(`<update_guid_history>${guid}:${javaStringHash(payload)}</update_guid_history>`);
    const changed = planToUnloadXml(samplePlan({ name: 'P1 Log v2' }), { updateSetName: 'TEST_P1_LOG_V1', now: NOW, author: 'tester' });
    expect(/<update_guid>([0-9a-f]{32})<\/update_guid>/.exec(changed)![1]).not.toBe(guid);
  });

  it('carries the scope on a scoped flow and requires a name', () => {
    const scoped = planToUnloadXml(samplePlan({ scope: 'x_example_app' }), { updateSetName: 'TEST_S', now: NOW });
    expect(scoped).toContain('<application display_value="x_example_app">x_example_app</application>');
    expect(scoped).toContain('<application_scope>x_example_app</application_scope>');
    expect(() => planToUnloadXml(samplePlan(), { updateSetName: '  ' })).toThrow(/updateSetName/);
  });

  it('recordsToUnloadXml sanitises foreign record_update payloads (apply_defaults, split markers)', () => {
    const dirty = '<record_update><sys_hub_flow action="INSERT_OR_UPDATE" apply_defaults="true"><sys_id>x</sys_id></sys_hub_flow><.split/></record_update>';
    expect(sanitizeRecordUpdate(dirty)).toBe('<record_update><sys_hub_flow action="INSERT_OR_UPDATE"><sys_id>x</sys_id></sys_hub_flow></record_update>');
    const out = recordsToUnloadXml([{ name: 'sys_hub_flow_x', type: 'Flow', table: '', targetName: 'X', payload: dirty, sysId: 'c'.repeat(32) }], {
      updateSetName: 'RH', applicationSysId: 'global', applicationName: 'Global', applicationScope: 'global', remoteUpdateSetSysId: 'a'.repeat(32), remoteSysId: 'b'.repeat(32), now: NOW, author: 't',
    });
    expect(out).not.toContain('apply_defaults');
    expect(out).not.toContain('.split');
  });

  it('helper formats match the genuine export forms', () => {
    expect(snDateTime(NOW)).toBe('2026-09-24 10:15:30');
    // the leaver-flow row's sys_recorded_at (1a01085bc2e0000001) decodes to its last update instant: hex(ms << 4) + '000001'
    const leaverMs = Number(BigInt('0x1a01085bc2e0') >> 4n);
    expect(new Date(leaverMs).toISOString()).toBe('2026-08-17T16:19:55.054Z');
    expect(snRecordedAt(new Date(leaverMs))).toBe('1a01085bc2e0000001');
    expect(javaStringHash('')).toBe(0);
    expect(javaStringHash('abc')).toBe(96354);
    expect(Number.isInteger(javaStringHash('x'.repeat(5000)))).toBe(true);
  });
});

describe('planToCapturePayloadXml — fields the genuine capture carries and the plan does not', () => {
  it('adds audit fields on every row, sys_class_name on flow / var-dictionary / documentation rows, sys_update_name + sys_name on the flow row', () => {
    const p = planToCapturePayloadXml(samplePlan(), { now: NOW, author: 'tester' });
    const rowCount = elementsOf(p).filter(e => e[1] === 'INSERT_OR_UPDATE').length;
    expect(p.match(/<sys_created_by>tester<\/sys_created_by>/g)).toHaveLength(rowCount);
    expect(p.match(/<sys_updated_on>2026-09-24 10:15:30<\/sys_updated_on>/g)).toHaveLength(rowCount);
    expect(p.match(/<sys_mod_count>0<\/sys_mod_count>/g)).toHaveLength(rowCount);
    const flowRow = p.slice(0, p.indexOf('</sys_hub_flow>'));
    expect(flowRow).toContain(`<sys_update_name>sys_hub_flow_${ids.flow}</sys_update_name>`);
    expect(flowRow).toContain('<sys_name>P1 Log</sys_name>');
    expect(flowRow).toContain('<sys_class_name>sys_hub_flow</sys_class_name>');
    expect(p).toContain('<sys_class_name>sys_hub_flow_variable</sys_class_name>');
    expect(p).toContain('<sys_class_name>sys_documentation</sys_class_name>');
    // the trigger and stage rows carry no sys_class_name in the genuine capture
    const trig = /<sys_hub_trigger_instance_v2 action="INSERT_OR_UPDATE">[\s\S]*?<\/sys_hub_trigger_instance_v2>/.exec(p)![0];
    expect(trig).not.toContain('sys_class_name');
  });

  it('never overrides a value the plan already carries', () => {
    const plan = samplePlan();
    plan.flow.fields.sys_class_name = 'sys_hub_flow';
    plan.flow.fields.sys_name = 'Custom';
    const p = planToCapturePayloadXml(plan, { now: NOW });
    expect(p).toContain('<sys_name>Custom</sys_name>');
    expect(p.match(/<sys_class_name>sys_hub_flow<\/sys_class_name>/g)).toHaveLength(1);
  });

  it('emits rows of tables not keyed to the flow (sys_complex_object) WITHOUT a delete_multiple, after the documentation rows', () => {
    const plan = samplePlan();
    const coId = 'c0'.repeat(16);
    plan.variables.push({ table: 'sys_complex_object', sys_id: coId, fields: { name: `FD${ids.variable}`, namespace: 'FlowDesigner', type: 'complex_object_collection', serialized_content: '{"a":1}' } });
    const p = planToCapturePayloadXml(plan, { now: NOW });
    const els = elementsOf(p);
    expect(els.filter(e => e[0] === 'sys_complex_object')).toEqual([['sys_complex_object', 'INSERT_OR_UPDATE', '']]);
    expect(p).toContain(`<sys_id>${coId}</sys_id>`);
    const tables = els.map(e => e[0]);
    expect(tables.lastIndexOf('sys_documentation')).toBeLessThan(tables.indexOf('sys_complex_object'));
    // no delete_multiple anywhere is keyed on flow= for a table outside the platform order
    for (const e of els.filter(x => x[1] === 'delete_multiple')) expect((PAYLOAD_TABLE_ORDER as readonly string[]).includes(e[0]) || !/^flow=|^model=/.test(e[2]), e.join(' ')).toBe(true);
  });

  it('a catalog flow gets the sys_flow_cat_variable cleanup keyed on the model row, as captured', () => {
    const plan = samplePlan();
    const modelId = 'd1'.repeat(16);
    plan.variables.push({ table: 'sys_flow_cat_variable_model', sys_id: modelId, fields: { id: ids.flow, name: 'P1 Log' } });
    const els = elementsOf(planToCapturePayloadXml(plan, { now: NOW }));
    const i = els.findIndex(e => e[0] === 'sys_flow_cat_variable_model' && e[1] === 'INSERT_OR_UPDATE');
    expect(els[i - 1]).toEqual(['sys_flow_cat_variable_model', 'delete_multiple', `id=${ids.flow}^sys_idNOT IN${modelId}`]);
    expect(els[i + 1]).toEqual(['sys_flow_cat_variable', 'delete_multiple', `flow_catalog_model=${modelId}`]);
  });

  it('refuses a plan with a second sys_hub_flow row among the children', () => {
    const plan = samplePlan();
    plan.variables.push({ table: 'sys_hub_flow', sys_id: 'e'.repeat(32), fields: { name: 'x' } });
    expect(() => planToCapturePayloadXml(plan)).toThrow(/second sys_hub_flow/);
  });

  it('mirrors the genuine Leaver-flow payload: same table sequence for the tables both carry', () => {
    const genuine = join(process.cwd(), 'tests/flow-builder/fixtures/pdi/flows/leaver-flow/sys_update_xml_payload.xml');
    if (!existsSync(genuine)) return;
    const g = elementsOf(readFileSync(genuine, 'utf8'));
    const ours = elementsOf(planToCapturePayloadXml(samplePlan(), { now: NOW }));
    const seq = (els: [string, string, string][]) => els.filter(e => e[1] === 'delete_multiple').map(e => `${e[0]}:${e[2].replace(/[0-9a-f]{32}/g, 'ID').replace(/(ID,)*ID/g, 'IDS')}`);
    // every housekeeping / child delete_multiple we emit exists in the genuine capture in the same form
    const genuineSet = new Set(seq(g));
    for (const d of seq(ours)) expect(genuineSet.has(d) || genuineSet.has(d.replace(/\^sys_idNOT INIDS$/, '')) || genuineSet.has(`${d}^sys_idNOT INIDS`), d).toBe(true);
  });
});
