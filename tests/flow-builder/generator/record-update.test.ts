/**
 * planToRecordUpdateXml: the <record_update> document the ServiceNow IDE loader applies. Its element
 * vocabulary is compared with the platform's own capture of a UI-built flow
 * (tests/flow-builder/fixtures/pdi/flows/leaver-flow/sys_update_xml_payload.xml): the same per-table
 * delete_multiple queries, the per-action sys_hub_alias_mapping cleanup, no cleanup for
 * sys_documentation, and data-row fields that are columns the platform itself serialises. The exact
 * document of every construct spec is pinned by construct-snapshots.test.ts; here the round trip of every
 * field value through XML escaping, sys_update_name and the refusals are unit-tested.
 *
 * Owner: GENERATOR.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { planToRecordUpdateXml, escapeXmlText, sysUpdateName } from '../../../src/flow-builder/xml/record-update.js';
import type { RecordPlan } from '../../../src/flow-builder/spec/types.js';
import { parseRecordUpdate } from '../writer/fake-client.js';
import { PDI_DIR, specNames } from './plans.js';
import { planFor } from './context.js';

type Element = ReturnType<typeof parseRecordUpdate>[number];

const UI = parseRecordUpdate(readFileSync(join(PDI_DIR, 'flows', 'leaver-flow', 'sys_update_xml_payload.xml'), 'utf8'));
const UI_FLOW_ID = String((UI.find(e => e.kind === 'row' && e.table === 'sys_hub_flow') as { fields: Record<string, string> }).fields.sys_id);

/** table → the columns the platform serialised for it in the UI capture. */
const UI_FIELDS = new Map<string, Set<string>>();
for (const e of UI) if (e.kind === 'row') { const s = UI_FIELDS.get(e.table) ?? new Set<string>(); Object.keys(e.fields).forEach(k => s.add(k)); UI_FIELDS.set(e.table, s); }

/**
 * Fields the generator writes that the UI capture does not carry (FORMAT-DECISIONS.md, "<record_update>
 * document"): sys_update_name on child rows, and two fields that are not columns of their table
 * (`active` on sys_hub_action_instance_v2, `category` on sys_hub_trigger_instance_v2) — the loader ignores them.
 */
const EXTRA_FIELDS: Record<string, string[]> = {
  sys_hub_action_instance_v2: ['sys_update_name', 'active'],
  sys_hub_trigger_instance_v2: ['sys_update_name', 'category'],
  sys_hub_flow_logic_instance_v2: ['sys_update_name'],
  sys_hub_sub_flow_instance_v2: ['sys_update_name'],
  sys_hub_flow_stage: ['sys_update_name'],
};

/** The key a child table's delete_multiple uses, as the platform wrote it. */
function uiCleanupKey(table: string): string | undefined {
  const d = UI.find(e => e.kind === 'delete' && e.table === table) as { query: string } | undefined;
  return d?.query.split('=')[0];
}

const deletes = (doc: Element[]) => doc.filter((e): e is Extract<Element, { kind: 'delete' }> => e.kind === 'delete');
const rows = (doc: Element[]) => doc.filter((e): e is Extract<Element, { kind: 'row' }> => e.kind === 'row');

describe('planToRecordUpdateXml — against the platform capture of a UI-built flow', () => {
  it('the capture itself: flow/model-keyed cleanups with the kept sys_ids, one alias cleanup per action instance, none for sys_documentation', () => {
    expect(uiCleanupKey('sys_hub_flow_stage')).toBe('flow');
    expect(uiCleanupKey('sys_hub_flow_input')).toBe('model');
    for (const t of ['sys_hub_trigger_instance_v2', 'sys_hub_action_instance_v2', 'sys_hub_sub_flow_instance_v2', 'sys_hub_flow_logic_instance_v2']) expect(uiCleanupKey(t), t).toBe('flow');
    for (const d of deletes(UI).filter(x => x.query.includes('^sys_idNOT IN'))) {
      const kept = d.query.split('^sys_idNOT IN')[1].split(',');
      expect(kept.sort(), d.table).toEqual(rows(UI).filter(r => r.table === d.table).map(r => String(r.fields.sys_id)).sort());
    }
    const actionIds = rows(UI).filter(r => r.table === 'sys_hub_action_instance_v2').map(r => String(r.fields.sys_id));
    const aliasIds = deletes(UI).filter(d => d.table === 'sys_hub_alias_mapping').map(d => d.query.replace('source_id=', ''));
    expect(aliasIds.filter(id => id !== UI_FLOW_ID).sort()).toEqual(actionIds.sort());
    expect(deletes(UI).some(d => d.table === 'sys_documentation')).toBe(false);
  });

  for (const name of specNames()) {
    it(`${name}: cleanups keyed and listed as the platform writes them; every field a column the platform serialises (or a documented extra)`, async () => {
      const plan = await planFor(name);
      const doc = parseRecordUpdate(planToRecordUpdateXml(plan));
      const flowId = plan.flow.sys_id;
      for (const d of deletes(doc)) {
        if (d.table === 'sys_hub_alias_mapping') continue;
        const [key, rest] = d.query.split('=');
        const uiKey = uiCleanupKey(d.table) ?? (d.table === 'sys_hub_flow_variable' || d.table === 'sys_hub_flow_output' ? 'model' : undefined);
        expect(key, d.table).toBe(uiKey);
        expect(rest.startsWith(`${flowId}^sys_idNOT IN`), d.query).toBe(true);
        expect(d.query.split('^sys_idNOT IN')[1].split(',').sort(), d.table).toEqual(rows(doc).filter(r => r.table === d.table).map(r => String(r.fields.sys_id)).sort());
      }
      const actionIds = rows(doc).filter(r => r.table === 'sys_hub_action_instance_v2').map(r => String(r.fields.sys_id));
      const aliasIds = deletes(doc).filter(d => d.table === 'sys_hub_alias_mapping').map(d => d.query.replace('source_id=', ''));
      for (const id of actionIds) expect(aliasIds, id).toContain(id);
      expect(deletes(doc).some(d => d.table === 'sys_documentation')).toBe(false);
      for (const r of rows(doc)) {
        const ui = UI_FIELDS.get(r.table);
        if (!ui) continue; // variables / outputs / complex objects: no such row in this capture
        const extra = Object.keys(r.fields).filter(k => !ui.has(k) && !(EXTRA_FIELDS[r.table] ?? []).includes(k));
        expect(extra, r.table).toEqual([]);
      }
    });
  }
});

describe('planToRecordUpdateXml — serialisation', () => {
  it('round-trips every plan field value through XML escaping', async () => {
    const plan = await planFor('incident_triage');
    const doc = rows(parseRecordUpdate(planToRecordUpdateXml(plan)));
    const planRowsFlat = [plan.flow, ...plan.variables, ...plan.documentation, ...plan.stages, plan.trigger!, ...plan.instances];
    for (const row of planRowsFlat) {
      const x = doc.find(r => r.table === row.table && r.fields.sys_id === row.sys_id);
      expect(x, `${row.table} ${row.sys_id}`).toBeDefined();
      for (const [k, v] of Object.entries(row.fields)) expect(x!.fields[k] ?? '', `${row.table}.${k}`).toBe(String(v));
    }
  });

  it('writes the XML declaration and <record_update table="sys_hub_flow"> first; every data row starts with sys_id, sys_scope, sys_update_name', async () => {
    const xml = planToRecordUpdateXml(await planFor('flow_logic'));
    expect(xml.split('\n').slice(0, 2)).toEqual(['<?xml version="1.0"?>', '<record_update table="sys_hub_flow">']);
    let n = 0;
    for (const m of xml.matchAll(/action="INSERT_OR_UPDATE"[^>]*>\n\s*<(\w+)[^\n]*\n\s*<(\w+)[^\n]*\n\s*<(\w+)/g)) { expect([m[1], m[2], m[3]]).toEqual(['sys_id', 'sys_scope', 'sys_update_name']); n++; }
    expect(n).toBeGreaterThan(30);
  });

  it('escapes markup, ampersands and carriage returns; no trailing newline', () => {
    expect(escapeXmlText('a<b>&c\r\n')).toBe('a&lt;b&gt;&amp;c&#13;\n');
    const plan: RecordPlan = {
      flowKey: 'x', flow: { table: 'sys_hub_flow', sys_id: 'f'.repeat(32), fields: { sys_id: 'f'.repeat(32), sys_scope: 'global', description: 'A & B <c>', name: 'X' } },
      variables: [], documentation: [], stages: [], instances: [], labelCache: [], pills: [], warnings: [],
    };
    const xml = planToRecordUpdateXml(plan);
    expect(xml).toContain('<description>A &amp; B &lt;c&gt;</description>');
    expect(xml.endsWith('</record_update>')).toBe(true);
    expect(xml).not.toContain('delete_multiple');
  });

  it('sys_update_name: <table>_<sys_id>, sys_documentation keyed by name, element and language (as in the platform capture)', () => {
    expect(sysUpdateName({ table: 'sys_hub_flow', sys_id: 'a'.repeat(32), fields: {} })).toBe(`sys_hub_flow_${'a'.repeat(32)}`);
    expect(sysUpdateName({ table: 'sys_documentation', sys_id: 'b'.repeat(32), fields: { name: 'var__m_x', element: 'note', language: 'en' } })).toBe('sys_documentation_var__m_x_note_en');
    const uiFlow = rows(UI).find(r => r.table === 'sys_hub_flow')!;
    expect(uiFlow.fields.sys_update_name).toBe(`sys_hub_flow_${UI_FLOW_ID}`);
  });

  it('refuses a plan without a sys_hub_flow row', () => {
    expect(() => planToRecordUpdateXml({} as RecordPlan)).toThrow(/no sys_hub_flow row/);
  });
});
