/**
 * WRITER × GENERATOR end-to-end on the fake client: a real spec → generatePlan → writePlan / verifyFlow /
 * planToUnloadXml. Asserts the P3 gate ("a mock-client run of a spec produces exactly the planned call
 * sequence") with the rows the generator actually emits — including rows of tables that are not keyed
 * to the flow (sys_complex_object for an array.object variable).
 *
 * The spec deliberately avoids askForApproval: its due_date default currently trips the GENERATOR's
 * pill rewriter (see the WRITER report); the writer is indifferent to which actions a plan carries.
 */
import { describe, it, expect } from 'vitest';
import { parseSpec } from '../../../src/flow-builder/spec/schema.js';
import { generatePlan } from '../../../src/flow-builder/generator/index.js';
import { writePlan, verifyFlow, plannedRows } from '../../../src/flow-builder/writer/index.js';
import { planToUnloadXml } from '../../../src/flow-builder/xml/unload.js';
import type { FlowSpec, RecordPlan, WriteOptions } from '../../../src/flow-builder/spec/types.js';
import { makeFakeClient, baseTables, callSignature } from './fake-client.js';

const US = 'a'.repeat(32);
const USER = 'u'.repeat(32);
const opts = (o: Partial<WriteOptions> = {}): WriteOptions => ({ updateSet: { sys_id: US }, mode: 'create', activate: false, deleteStale: false, confirmDelete: [], ...o });

const SPEC = {
  spec_version: '1',
  flow: { key: 'p1_incident_review_e2e', name: 'P1 Incident Review E2E', description: 'Logs and tags new P1 incidents', scope: 'global', run_as: 'system' },
  trigger: { key: 'trg', type: 'record.created', table: 'incident', condition: 'priority=1', run_flow_in: 'background' },
  variables: [{ name: 'note', type: 'string' }, { name: 'items', type: 'array.object' }],
  stages: [{ value: 'triage', label: 'Triage' }],
  steps: [
    { kind: 'action', key: 'log_p1', action: 'log', stage: 'triage', inputs: { log_level: 'info', log_message: { text: 'P1 created {{trigger.current.number}}' } } },
    { kind: 'action', key: 'tag', action: 'updateRecord', inputs: { table_name: 'incident', record: { pill: 'trigger.current' }, values: { template: { impact: '1', work_notes: { text: 'Auto-tagged ({{trigger.current.number}})' } } } } },
    { kind: 'if', key: 'is_urgent', condition: '{{trigger.current.urgency}}=1',
      then: [{ kind: 'action', key: 'log_urgent', action: 'log', inputs: { log_level: 'warn', log_message: { text: 'Urgent {{trigger.current.number}}' } } }],
      else: { key: 'not_urgent', steps: [{ kind: 'end_flow', key: 'stop' }] } },
  ],
};

const TYPES: Record<string, string> = { number: 'string', urgency: 'integer', assignment_group: 'reference' };

async function plan(): Promise<RecordPlan> {
  const r = parseSpec(SPEC);
  if ('errors' in r) throw new Error(JSON.stringify(r.errors));
  return generatePlan(r.spec as FlowSpec, { resolvePillType: async (_t, p) => TYPES[p] ?? 'string' });
}

describe('writePlan on a generated plan', () => {
  it('runs the §2.2 pre-writes first, then writes exactly plannedRows() in order with the generated sys_ids', async () => {
    const p = await plan();
    const { client, state, table } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    const r = await writePlan(client, p, opts());

    const sig = callSignature(state.calls);
    const firstFlowWrite = sig.indexOf('createRecord:sys_hub_flow');
    expect(sig.slice(0, firstFlowWrite)).toEqual([
      'getRecord:sys_update_set',
      'queryRecords:sys_user',
      // existence pre-check (read-only, before any write), one sys_idIN query per planned table
      ...[...new Set(plannedRows(p).map(x => x.table))].map(t => `queryRecords:${t}`),
      'queryRecords:sys_user_preference',
      'createRecord:sys_user_preference',
    ]);
    const writes = state.calls.filter(c => c.method === 'createRecord' && c.table !== 'sys_user_preference').map(c => `${c.table}:${c.data!.sys_id}`);
    expect(writes).toEqual(plannedRows(p).map(x => `${x.table}:${x.sys_id}`));
    expect(state.calls.some(c => c.method === 'updateRecord' || c.method === 'deleteRecord' || c.method === 'requestJson')).toBe(false);

    expect(r.user).toEqual({ sys_id: USER, user_name: 'mcp.user' });
    expect(r.written).toHaveLength(plannedRows(p).length);
    expect(r.written.every(w => w.action === 'inserted')).toBe(true);
    expect(table('sys_hub_flow').get(p.flow.sys_id)?.active).toBe('false');
    expect(table('sys_hub_flow').get(p.flow.sys_id)?.status).toBe('draft');
    expect(r.stale).toEqual([]);
    expect(r.activation).toEqual({ requested: false, attempted: false, ok: false });
  });

  it('capture: the flow family is covered by the one sys_hub_flow_<id> row, the sys_complex_object row by its own row', async () => {
    const p = await plan();
    expect(plannedRows(p).some(x => x.table === 'sys_complex_object')).toBe(true);
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    const r = await writePlan(client, p, opts());
    expect(r.capture.mode).toBe('parent_row');
    expect(r.capture.ok).toBe(true);
    expect(r.capture.coveredPerRow).toBe(plannedRows(p).filter(x => x.table === 'sys_complex_object').length);
    expect(r.capture.coveredByParent + r.capture.coveredPerRow).toBe(plannedRows(p).length);
    expect(r.capture.parentRow?.type).toBe('Flow');
  });

  it("a re-run in mode:'update' PATCHes every row (idempotent, same deterministic ids) and reports no STALE", async () => {
    const p = await plan();
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    await writePlan(client, p, opts());
    const before = state.calls.length;
    const p2 = await plan();
    expect(plannedRows(p2).map(x => x.sys_id)).toEqual(plannedRows(p).map(x => x.sys_id));
    const r = await writePlan(client, p2, opts({ mode: 'update' }));
    const second = state.calls.slice(before);
    expect(second.filter(c => c.method === 'createRecord' && c.table !== 'sys_user_preference')).toEqual([]);
    expect(second.filter(c => c.method === 'updateRecord' && c.table !== 'sys_user_preference')).toHaveLength(plannedRows(p).length);
    expect(r.written.every(w => w.action === 'updated')).toBe(true);
    expect(r.preferences[0].action).toBe('kept');
    expect(r.stale).toEqual([]);
  });

  it('verifyFlow reads the written flow back with no diffs and every pill resolved', async () => {
    const p = await plan();
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    await writePlan(client, p, opts());
    const v = await verifyFlow(client, p.flow.sys_id, p);
    expect(v.found).toBe(true);
    expect(v.diffs).toEqual([]);
    expect(v.unresolvedPills).toEqual([]);
    expect(v.instances.map(i => i.sys_id).sort()).toEqual(p.instances.map(i => i.sys_id).sort());
    expect(v.ok).toBe(true);
  });

  it('planToUnloadXml of the same plan carries every planned row inside the single Flow update record', async () => {
    const p = await plan();
    const xml = planToUnloadXml(p, { updateSetName: 'TEST_P1_E2E', now: new Date('2026-09-24T10:00:00Z') });
    expect(xml.match(/<sys_update_xml action="INSERT_OR_UPDATE">/g)).toHaveLength(1);
    for (const x of plannedRows(p)) expect(xml, `${x.table} ${x.sys_id}`).toContain(`<sys_id>${x.sys_id}</sys_id>`);
    expect(xml).not.toContain('apply_defaults');
    expect(xml).not.toMatch(/<sys_complex_object action="delete_multiple"/);
  });
});
