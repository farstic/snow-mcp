/**
 * writer/index.ts — verifyFlow: read-back, decoding, plan diff, unresolved pills, capture rows,
 * record trigger, recent contexts. Read-only: no write method may be called.
 */
import { describe, it, expect } from 'vitest';
import { writePlan, verifyFlow } from '../../../src/flow-builder/writer/index.js';
import { encodeValues, decodeValues } from '../../../src/flow-builder/encode.js';
import type { WriteOptions } from '../../../src/flow-builder/spec/types.js';
import { makeFakeClient, baseTables } from './fake-client.js';
import { samplePlan, SAMPLE_IDS, EMPTY_LOGIC_VALUES } from './sample-plan.js';

const US = 'a'.repeat(32);
const opts: WriteOptions = { updateSet: { sys_id: US }, mode: 'create', activate: false, deleteStale: false, confirmDelete: [] };

const DEFS = {
  sys_hub_action_type_definition: [{ sys_id: 'dbc1bcc6531003003bf1d9109ec587d2', name: 'Log' }],
  sys_hub_flow_logic_definition: [{ sys_id: 'af4e1945c3e232002841b63b12d3ae3e', name: 'If' }],
};

async function written() {
  const fake = makeFakeClient({ username: 'mcp.user', tables: { ...baseTables(), ...DEFS } });
  await writePlan(fake.client, samplePlan(), opts);
  fake.state.calls.length = 0;
  return fake;
}

describe('verifyFlow', () => {
  it('reports a missing flow without throwing', async () => {
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    const r = await verifyFlow(client, 'f'.repeat(32));
    expect(r.found).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.warnings[0]).toContain('does not exist');
    expect(state.calls.every(c => c.method === 'getRecord' || c.method === 'queryRecords')).toBe(true);
  });

  it('reads back a written flow, decodes blobs, names instances, resolves every pill and matches the plan', async () => {
    const { client, state } = await written();
    const ids = SAMPLE_IDS();
    const r = await verifyFlow(client, ids.flow, samplePlan());
    expect(r.found).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.diffs).toEqual([]);
    expect(r.unresolvedPills).toEqual([]);
    expect(r.flow?.name).toBe('P1 Log');
    expect(Array.isArray(r.flow?.label_cache)).toBe(true);
    expect(r.labelCacheEntries).toBe(3);
    expect((r.trigger?.trigger_inputs as unknown[]).length).toBe(2);
    expect(r.instances.map(i => `${i.order}:${i.name}`)).toEqual(['1:If', '2:Log']);
    const log = r.instances[1].decoded as { values: { name: string; value: string }[] };
    expect(log.values[1]).toMatchObject({ name: 'log_message', value: 'P1 {{Created_1.current.number}}' });
    expect(r.variables.map(v => v.element)).toEqual(['note']);
    expect(r.stages.map(s => s.value)).toEqual(['triage']);
    expect(r.updateXml).toHaveLength(1);
    expect(r.updateXml[0].update_set).toBe(US);
    expect(r.missingUpdateXml).toEqual([]);
    expect(r.recentContexts).toEqual([]);
    // read-only
    expect(state.calls.every(c => c.method === 'getRecord' || c.method === 'queryRecords')).toBe(true);
  });

  it('diffs field drift, decoded blob drift, missing planned rows and rows the plan does not know', async () => {
    const { client, table } = await written();
    const ids = SAMPLE_IDS();
    // drift: description edited in the UI; the If condition changed; the stage row deleted; a foreign action added
    table('sys_hub_flow').get(ids.flow)!.description = 'edited by hand';
    table('sys_hub_flow_logic_instance_v2').get(ids.ifStep)!.values = encodeValues({ ...EMPTY_LOGIC_VALUES, inputs: [{ name: 'condition', value: '{{Created_1.current.priority}}=2' }] });
    table('sys_hub_flow_stage').delete(ids.stage);
    table('sys_hub_action_instance_v2').set('9'.repeat(32), { sys_id: '9'.repeat(32), flow: ids.flow, order: '3', action_type_parent: 'dbc1bcc6531003003bf1d9109ec587d2', values: encodeValues([{ name: 'log_message', value: '{{deadbeef-0000-0000-0000-000000000000.Record.number}}' }]) });

    const r = await verifyFlow(client, ids.flow, samplePlan());
    expect(r.ok).toBe(false);
    const keys = r.diffs.map(d => `${d.table}.${d.field}`).sort();
    expect(keys).toEqual([
      'sys_hub_action_instance_v2.<row>',
      'sys_hub_flow.description',
      'sys_hub_flow_logic_instance_v2.values',
      'sys_hub_flow_stage.<row>',
    ]);
    expect(r.diffs.find(d => d.field === 'description')).toMatchObject({ expected: 'P1 incidents are logged', actual: 'edited by hand' });
    expect(r.diffs.find(d => d.table === 'sys_hub_flow_stage')).toMatchObject({ expected: 'present', actual: 'missing' });
    expect(r.diffs.find(d => d.table === 'sys_hub_action_instance_v2')).toMatchObject({ sys_id: '9'.repeat(32), actual: 'present (not in plan)' });
    expect(r.unresolvedPills).toEqual(['deadbeef-0000-0000-0000-000000000000.Record.number']);
    // the stage deletion also shows up in the plan-vs-payload check only if the payload lost it — the fake re-captures on write, not on delete
    expect(r.missingUpdateXml).toEqual([]);
  });

  it('label_cache is compared as a name-keyed set (entry order does not matter) and gzip blobs as canonical JSON', async () => {
    const { client, table } = await written();
    const ids = SAMPLE_IDS();
    const flow = table('sys_hub_flow').get(ids.flow)!;
    flow.label_cache = JSON.stringify((JSON.parse(flow.label_cache) as unknown[]).reverse());
    const log = table('sys_hub_action_instance_v2').get(ids.logStep)!;
    const decoded = decodeValues(log.values) as Record<string, unknown>[];
    log.values = encodeValues(decoded.map(e => Object.fromEntries(Object.entries(e).reverse())));
    const r = await verifyFlow(client, ids.flow, samplePlan());
    expect(r.diffs).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('reports the missing sys_update_xml row, the sys_flow_record_trigger behind remote_trigger_id and recent contexts', async () => {
    const ids = SAMPLE_IDS();
    const t = { ...baseTables(), ...DEFS,
      sys_hub_flow: [{ sys_id: ids.flow, name: 'P1 Log', type: 'flow', active: 'true', status: 'published', latest_snapshot: '', remote_trigger_id: 'd'.repeat(32), label_cache: '[]' }],
      sys_flow_record_trigger: [{ sys_id: 'd'.repeat(32), table: 'incident', condition: 'priority=1', on_insert: 'true', active: 'true' }],
      sys_flow_context: [{ sys_id: 'c1'.padEnd(32, '0'), flow: ids.flow, state: 'COMPLETE', sys_created_on: '2026-09-24 09:00:00' }, { sys_id: 'c2'.padEnd(32, '0'), flow: 'other'.padEnd(32, '0'), state: 'ERROR' }],
    };
    const { client } = makeFakeClient({ username: 'mcp.user', tables: t, capture: 'none' });
    const r = await verifyFlow(client, ids.flow);
    expect(r.found).toBe(true);
    expect(r.missingUpdateXml).toEqual([{ table: 'sys_hub_flow', sys_id: ids.flow }]);
    expect(r.recordTrigger).toMatchObject({ table: 'incident', condition: 'priority=1' });
    expect(r.recentContexts).toEqual([{ sys_id: 'c1'.padEnd(32, '0'), state: 'COMPLETE', sys_created_on: '2026-09-24 09:00:00' }]);
    expect(r.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('no sys_hub_trigger_instance_v2 row'),
      expect.stringContaining('no action / subflow / logic instance rows'),
      expect.stringContaining('not captured in any update set'),
      expect.stringContaining('active but has no latest_snapshot'),
    ]));
  });

  it('rejects a malformed flow sys_id', async () => {
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    await expect(verifyFlow(client, 'nope')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
