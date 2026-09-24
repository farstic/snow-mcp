/**
 * writer/index.ts — writePlan: §2.2 pre-writes and their ORDER, the is_default / not-in-progress
 * refusals, session-derived user, scoped preference, create/update modes, sys_id honouring,
 * capture verification (parent-row form first, per-row fallback, leak diagnosis), STALE handling
 * (never implicit), activation with mandatory read-back.
 */
import { describe, it, expect } from 'vitest';
import { ServiceNowError } from '../../../src/utils/errors.js';
import { writePlan, verifyCapture, resolveUpdateSet, resolveSessionUser, plannedRows, pillTokensIn, describeCaptureProtocol, ACTIVATE_FLOWS_PATH } from '../../../src/flow-builder/writer/index.js';
import type { WriteOptions } from '../../../src/flow-builder/spec/types.js';
import { makeFakeClient, baseTables, callSignature } from './fake-client.js';
import { samplePlan, SAMPLE_IDS } from './sample-plan.js';

const US = 'a'.repeat(32);
const USER = 'u'.repeat(32);
const opts = (o: Partial<WriteOptions> = {}): WriteOptions => ({ updateSet: { sys_id: US }, mode: 'create', activate: false, deleteStale: false, confirmDelete: [], ...o });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as { code?: string }).code ?? 'NO_CODE'; }
  return 'NO_THROW';
}

describe('writePlan — §2.2 pre-writes happen BEFORE any flow row, in order', () => {
  it('resolves update set → user → scope → preference, then writes flow → variables → docs → stages → trigger → instances', async () => {
    const { client, state, table } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    const plan = samplePlan();
    const r = await writePlan(client, plan, opts());

    const sig = callSignature(state.calls);
    const firstFlowWrite = sig.findIndex(s => s === 'createRecord:sys_hub_flow');
    expect(firstFlowWrite).toBeGreaterThan(0);
    const pre = sig.slice(0, firstFlowWrite);
    // update set read, sys_user read, preference read + write all precede the first flow-family write
    expect(pre).toContain('getRecord:sys_update_set');
    expect(pre).toContain('queryRecords:sys_user');
    expect(pre.indexOf('getRecord:sys_update_set')).toBeLessThan(pre.indexOf('queryRecords:sys_user'));
    expect(pre.indexOf('queryRecords:sys_user')).toBeLessThan(pre.indexOf('queryRecords:sys_user_preference'));
    expect(pre.indexOf('queryRecords:sys_user_preference')).toBeLessThan(pre.indexOf('createRecord:sys_user_preference'));
    const prefWrite = state.calls.find(c => c.method === 'createRecord' && c.table === 'sys_user_preference')!;
    expect(prefWrite.data).toEqual({ user: USER, name: 'sys_update_set', value: US, type: 'string' });
    // no createRecord/updateRecord on any flow table before the preference write
    const prefIdx = sig.indexOf('createRecord:sys_user_preference');
    expect(sig.slice(0, prefIdx).filter(s => /^(createRecord|updateRecord|deleteRecord):/.test(s))).toEqual([]);

    // write order == plannedRows order
    const writes = state.calls.filter(c => c.method === 'createRecord' && c.table !== 'sys_user_preference').map(c => `${c.table}:${c.data!.sys_id}`);
    expect(writes).toEqual(plannedRows(plan).map(r => `${r.table}:${r.sys_id}`));
    expect(writes[0]).toMatch(/^sys_hub_flow:/);
    expect(writes.at(-1)).toMatch(/^sys_hub_action_instance_v2:/);

    // client-supplied sys_ids were sent and every row is on the instance
    const ids = SAMPLE_IDS();
    expect(table('sys_hub_flow').get(ids.flow)?.name).toBe('P1 Log');
    expect(table('sys_hub_flow').get(ids.flow)?.active).toBe('false');
    expect(table('sys_hub_action_instance_v2').get(ids.logStep)?.parent_ui_id).toBeDefined();

    expect(r.user).toEqual({ sys_id: USER, user_name: 'mcp.user' });
    expect(r.updateSet).toEqual({ sys_id: US, name: 'TEST_FLOW_TEST_V1' });
    expect(r.preferences).toEqual([{ name: 'sys_update_set', sys_id: expect.any(String), value: US, action: 'inserted' }]);
    expect(r.written).toHaveLength(7);
    expect(r.written.every(w => w.action === 'inserted')).toBe(true);
    expect(r.stale).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(r.activation).toEqual({ requested: false, attempted: false, ok: false });
    expect(r.capture.mode).toBe('parent_row');
    expect(r.capture.ok).toBe(true);
    expect(r.capture.found).toBe(7);
    expect(r.capture.missing).toEqual([]);
    expect(r.capture.parentRow?.name).toBe(`sys_hub_flow_${ids.flow}`);
    expect(r.summary).toContain('capture verified');
    expect(r.summary).toContain('not requested');
    // no delete, no requestJson
    expect(state.calls.some(c => c.method === 'deleteRecord' || c.method === 'requestJson')).toBe(false);
  });

  it('keeps an already-correct preference and updates a wrong one instead of inserting duplicates', async () => {
    const tables = baseTables();
    tables.sys_user_preference = [{ sys_id: 'p'.repeat(32), user: USER, name: 'sys_update_set', value: 'c'.repeat(32) }];
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables });
    const r = await writePlan(client, samplePlan(), opts());
    expect(r.preferences).toEqual([{ name: 'sys_update_set', sys_id: 'p'.repeat(32), value: US, action: 'updated' }]);
    const upd = state.calls.find(c => c.method === 'updateRecord' && c.table === 'sys_user_preference')!;
    expect(upd.sysId).toBe('p'.repeat(32));
    expect(upd.data).toEqual({ value: US });

    const { client: c2, state: s2 } = makeFakeClient({ username: 'mcp.user', tables: { ...baseTables(), sys_user_preference: [{ sys_id: 'p'.repeat(32), user: USER, name: 'sys_update_set', value: US }] } });
    const r2 = await writePlan(c2, samplePlan({ flowKey: 'other' }), opts());
    expect(r2.preferences[0].action).toBe('kept');
    expect(s2.calls.some(c => c.table === 'sys_user_preference' && c.method !== 'queryRecords')).toBe(false);
  });

  it('a scoped flow also sets apps.current_app and rewrites the scope name to the sys_scope sys_id on every row', async () => {
    const { client, state, table } = makeFakeClient({ username: 'mcp.user', tables: baseTables({ updateSet: { application: 'b'.repeat(32) } }) });
    const r = await writePlan(client, samplePlan({ scope: 'x_example_app' }), opts());
    expect(r.scope).toEqual({ sys_id: 'b'.repeat(32), scope: 'x_example_app', name: 'Test App' });
    expect(r.preferences.map(p => `${p.name}=${p.value}`)).toEqual([`sys_update_set=${US}`, `apps.current_app=${'b'.repeat(32)}`]);
    const sig = callSignature(state.calls);
    expect(sig.filter(s => s === 'createRecord:sys_user_preference')).toHaveLength(2);
    expect(sig.lastIndexOf('createRecord:sys_user_preference')).toBeLessThan(sig.indexOf('createRecord:sys_hub_flow'));
    for (const row of [table('sys_hub_flow'), table('sys_hub_flow_variable'), table('sys_hub_action_instance_v2')]) {
      for (const r of row.values()) expect(r.sys_scope).toBe('b'.repeat(32));
    }
    expect(r.warnings.some(w => w.includes('belongs to application'))).toBe(false);
  });

  it('REFUSES (before any write) an update set that belongs to another application than the scoped flow', async () => {
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables() }); // update set application = global
    let err: ServiceNowError | undefined;
    try { await writePlan(client, samplePlan({ scope: 'x_example_app' }), opts()); } catch (e) { err = e as ServiceNowError; }
    expect(err?.code).toBe('FLOW_BUILDER_UPDATE_SET_SCOPE_MISMATCH');
    expect(err?.message).toContain('belongs to application global');
    expect(state.calls.filter(c => ['createRecord', 'updateRecord', 'deleteRecord', 'requestJson'].includes(c.method))).toEqual([]);
  });

  it('REFUSES a global flow written into an update set of a scoped application, and a scoped flow with an empty application', async () => {
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables({ updateSet: { application: 'b'.repeat(32) } }) });
    expect(await codeOf(writePlan(client, samplePlan(), opts()))).toBe('FLOW_BUILDER_UPDATE_SET_SCOPE_MISMATCH');
    const { client: c2, state: s2 } = makeFakeClient({ username: 'mcp.user', tables: baseTables({ updateSet: { application: '' } }) });
    expect(await codeOf(writePlan(c2, samplePlan({ scope: 'x_example_app' }), opts()))).toBe('FLOW_BUILDER_UPDATE_SET_SCOPE_MISMATCH');
    for (const calls of [state.calls, s2.calls]) expect(calls.filter(c => ['createRecord', 'updateRecord', 'deleteRecord', 'requestJson'].includes(c.method))).toEqual([]);
  });
});

describe('writePlan — refusals (nothing is written)', () => {
  const noWrites = (calls: { method: string }[]) => expect(calls.filter(c => ['createRecord', 'updateRecord', 'deleteRecord', 'requestJson'].includes(c.method))).toEqual([]);

  it('refuses an update set with is_default=true', async () => {
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables({ updateSet: { is_default: 'true' } }) });
    expect(await codeOf(writePlan(client, samplePlan(), opts()))).toBe('FLOW_BUILDER_UPDATE_SET_IS_DEFAULT');
    noWrites(state.calls);
  });

  it('refuses an update set that is not in progress', async () => {
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables({ updateSet: { state: 'complete' } }) });
    expect(await codeOf(writePlan(client, samplePlan(), opts()))).toBe('FLOW_BUILDER_UPDATE_SET_NOT_IN_PROGRESS');
    noWrites(state.calls);
  });

  it('refuses an unknown or ambiguous update set (by sys_id and by name)', async () => {
    const t = baseTables();
    t.sys_update_set.push({ sys_id: 'd'.repeat(32), name: 'TEST_FLOW_TEST_V1', state: 'in progress', is_default: 'false', application: 'global' });
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: t });
    expect(await codeOf(writePlan(client, samplePlan(), opts({ updateSet: { sys_id: 'e'.repeat(32) } })))).toBe('FLOW_BUILDER_UPDATE_SET_NOT_FOUND');
    expect(await codeOf(writePlan(client, samplePlan(), opts({ updateSet: { name: 'NOPE' } })))).toBe('FLOW_BUILDER_UPDATE_SET_NOT_FOUND');
    expect(await codeOf(writePlan(client, samplePlan(), opts({ updateSet: { name: 'TEST_FLOW_TEST_V1' } })))).toBe('FLOW_BUILDER_UPDATE_SET_AMBIGUOUS');
    expect(await codeOf(writePlan(client, samplePlan(), opts({ updateSet: {} })))).toBe('INVALID_REQUEST');
    noWrites(state.calls);
  });

  it('resolves the update set by name when it is unique', async () => {
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    const us = await resolveUpdateSet(client, { name: 'TEST_FLOW_TEST_V1' });
    expect(us).toEqual({ sys_id: US, name: 'TEST_FLOW_TEST_V1', state: 'in progress', is_default: false, application: 'global' });
  });

  it('derives the user from the client configuration only — refuses when it cannot', async () => {
    const { client, state } = makeFakeClient({ username: undefined, tables: baseTables() });
    expect(await codeOf(writePlan(client, samplePlan(), opts()))).toBe('FLOW_BUILDER_USER_UNRESOLVED');
    noWrites(state.calls);
    const { client: c2 } = makeFakeClient({ username: 'ghost', tables: baseTables() });
    expect(await codeOf(resolveSessionUser(c2))).toBe('FLOW_BUILDER_USER_UNRESOLVED');
    const t = baseTables();
    t.sys_user.push({ sys_id: 'v'.repeat(32), user_name: 'mcp.user' });
    const { client: c3 } = makeFakeClient({ username: 'mcp.user', tables: t });
    expect(await codeOf(resolveSessionUser(c3))).toBe('FLOW_BUILDER_USER_UNRESOLVED'); // two matches
  });

  it("mode:'create' refuses when any planned row already exists (before writing anything)", async () => {
    const ids = SAMPLE_IDS();
    const t = baseTables();
    t.sys_hub_action_instance_v2 = [{ sys_id: ids.logStep, flow: ids.flow, order: '2' }];
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: t });
    let err: ServiceNowError | undefined;
    try { await writePlan(client, samplePlan(), opts()); } catch (e) { err = e as ServiceNowError; }
    expect(err?.code).toBe('FLOW_BUILDER_ROWS_EXIST');
    expect((err?.details as { existing: unknown[] }).existing).toEqual([{ table: 'sys_hub_action_instance_v2', sys_id: ids.logStep }]);
    // the read-only pre-check runs BEFORE the preference upsert: a refused build mutates nothing
    noWrites(state.calls);
  });

  it("mode:'update' REFUSES to rewrite an ACTIVE flow (the planned row is draft/inactive) unless allowDeactivate", async () => {
    const ids = SAMPLE_IDS();
    const { client, state, table } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    await writePlan(client, samplePlan(), opts());
    const flowRow = table('sys_hub_flow').get(ids.flow)!;
    flowRow.active = 'true'; flowRow.status = 'published'; flowRow.latest_snapshot = 's'.repeat(32);
    state.calls.length = 0;

    let err: ServiceNowError | undefined;
    try { await writePlan(client, samplePlan(), opts({ mode: 'update' })); } catch (e) { err = e as ServiceNowError; }
    expect(err?.code).toBe('FLOW_BUILDER_FLOW_ACTIVE');
    expect((err?.details as { current: unknown }).current).toEqual({ active: 'true', status: 'published', latest_snapshot: 's'.repeat(32) });
    noWrites(state.calls); // nothing written, not even the preference
    expect(table('sys_hub_flow').get(ids.flow)!.active).toBe('true'); // the live flow is untouched

    // explicit opt-in: the flow is rewritten as draft/inactive, the previous state is reported
    const r = await writePlan(client, samplePlan(), opts({ mode: 'update', allowDeactivate: true }));
    expect(r.previousFlowState).toEqual({ active: 'true', status: 'published', latest_snapshot: 's'.repeat(32) });
    expect(r.warnings.some(w => w.includes('was ACTIVE') && w.includes('stays inactive'))).toBe(true);
    expect(table('sys_hub_flow').get(ids.flow)!.active).toBe('false');
  });

  it("mode:'update' on an existing INACTIVE flow proceeds and reports the previous state", async () => {
    const ids = SAMPLE_IDS();
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    await writePlan(client, samplePlan(), opts());
    const r = await writePlan(client, samplePlan(), opts({ mode: 'update' }));
    expect(r.previousFlowState).toMatchObject({ active: 'false', status: 'draft' });
    expect(r.written.every(w => w.action === 'updated')).toBe(true);
    expect(r.flowSysId).toBe(ids.flow);
  });

  it('aborts when the platform does not honour the client-supplied sys_id', async () => {
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), honourSysId: false });
    let err: ServiceNowError | undefined;
    try { await writePlan(client, samplePlan(), opts()); } catch (e) { err = e as ServiceNowError; }
    expect(err?.code).toBe('FLOW_BUILDER_SYS_ID_NOT_HONOURED');
    expect((err?.details as { written: unknown[] }).written).toEqual([]); // aborted on the very first row
  });

  it('rejects a client without the extended surface, a plan with duplicate ids, and deleteStale without confirmDelete', async () => {
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    const bare = { queryRecords: async () => ({ count: 0, records: [] }) } as unknown as typeof client;
    expect(await codeOf(writePlan(bare, samplePlan(), opts()))).toBe('FLOW_BUILDER_CLIENT_UNSUPPORTED');
    const dup = samplePlan();
    dup.instances[1] = { ...dup.instances[1], sys_id: dup.instances[0].sys_id };
    expect(await codeOf(writePlan(client, dup, opts()))).toBe('INVALID_REQUEST');
    expect(await codeOf(writePlan(client, samplePlan(), opts({ deleteStale: true })))).toBe('INVALID_REQUEST');
  });
});

describe("writePlan — mode:'update' and STALE handling", () => {
  it('PATCHes existing rows, POSTs missing ones, reports stale rows and never deletes without confirmation', async () => {
    const ids = SAMPLE_IDS();
    const { client, state, table } = makeFakeClient({ username: 'mcp.user', tables: baseTables() });
    await writePlan(client, samplePlan(), opts());
    // simulate a manual edit in the designer: an extra action row and a stale variable
    table('sys_hub_action_instance_v2').set('5'.repeat(32), { sys_id: '5'.repeat(32), flow: ids.flow, order: '3' });
    table('sys_hub_flow_variable').set('7'.repeat(32), { sys_id: '7'.repeat(32), model: ids.flow, element: 'old' });
    state.calls.length = 0;

    const plan = samplePlan();
    plan.instances.push({ table: 'sys_hub_flow_logic_instance_v2', sys_id: 'e'.repeat(32), fields: { flow: ids.flow, order: 3, ui_id: 'x', logic_definition: 'd176605ea76103004f27b0d2187901c7', values: '' } });
    const r = await writePlan(client, plan, opts({ mode: 'update' }));
    expect(r.written.filter(w => w.action === 'updated')).toHaveLength(7);
    expect(r.written.filter(w => w.action === 'inserted')).toEqual([{ table: 'sys_hub_flow_logic_instance_v2', sys_id: 'e'.repeat(32), action: 'inserted' }]);
    expect(state.calls.filter(c => c.method === 'updateRecord' && c.table === 'sys_hub_flow')).toHaveLength(1);
    expect(r.stale).toEqual(expect.arrayContaining([
      { table: 'sys_hub_action_instance_v2', sys_id: '5'.repeat(32) },
      { table: 'sys_hub_flow_variable', sys_id: '7'.repeat(32) },
    ]));
    expect(r.stale).toHaveLength(2);
    expect(r.deleted).toEqual([]);
    expect(state.calls.some(c => c.method === 'deleteRecord')).toBe(false);
    expect(r.warnings.some(w => w.includes('STALE') && w.includes('kept'))).toBe(true);

    // deleteStale with a confirm list: only the listed sys_id goes
    state.calls.length = 0;
    const r2 = await writePlan(client, plan, opts({ mode: 'update', deleteStale: true, confirmDelete: ['5'.repeat(32)] }));
    expect(r2.deleted).toEqual([{ table: 'sys_hub_action_instance_v2', sys_id: '5'.repeat(32) }]);
    expect(state.calls.filter(c => c.method === 'deleteRecord')).toEqual([{ method: 'deleteRecord', table: 'sys_hub_action_instance_v2', sysId: '5'.repeat(32) }]);
    expect(r2.stale).toEqual([{ table: 'sys_hub_flow_variable', sys_id: '7'.repeat(32) }]);
    expect(r2.warnings.some(w => w.includes('not listed in confirm_delete'))).toBe(true);
    expect(table('sys_hub_flow_variable').has('7'.repeat(32))).toBe(true);
  });
});

describe('capture verification', () => {
  it('falls back to the per-row form and reports missing rows', async () => {
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), capture: 'per_row' });
    const r = await writePlan(client, samplePlan(), opts());
    expect(r.capture.mode).toBe('per_row');
    expect(r.capture.found).toBe(7);
    expect(r.capture.ok).toBe(true);
  });

  it('THROWS FLOW_BUILDER_CAPTURE_NOT_VERIFIED on an unverified capture, carrying the full write result and the leak diagnosis', async () => {
    const ids = SAMPLE_IDS();
    const t = baseTables();
    t.sys_update_xml = [{ sys_id: 'x'.repeat(32), name: `sys_hub_flow_${ids.flow}`, update_set: 'DEFAULT', payload: '' }];
    const { client } = makeFakeClient({ username: 'mcp.user', tables: t, capture: 'none' });
    let err: ServiceNowError | undefined;
    try { await writePlan(client, samplePlan(), opts()); } catch (e) { err = e as ServiceNowError; }
    expect(err?.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    const r = err!.details as { capture: { mode: string; ok: boolean; otherUpdateSets: string[] }; written: unknown[]; warnings: string[]; summary: string };
    expect(r.capture.mode).toBe('unverified');
    expect(r.capture.ok).toBe(false);
    expect(r.capture.otherUpdateSets).toEqual(['DEFAULT']);
    expect(r.written).toHaveLength(7); // the rows ARE on the instance — the error says which
    expect(r.warnings.some(w => w.includes('NOT verified') && w.includes('DEFAULT'))).toBe(true);
    expect(r.summary).toContain('NOT verified');
  });

  it('a partial capture (rows missing from the set) is also an error, and activation is never attempted on an uncaptured flow', async () => {
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), capture: 'none', onRequest: () => ({ result: {} }) });
    let err: ServiceNowError | undefined;
    try { await writePlan(client, samplePlan(), opts({ activate: true })); } catch (e) { err = e as ServiceNowError; }
    expect(err?.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    expect(state.calls.some(c => c.method === 'requestJson')).toBe(false);
    const r = err!.details as { activation: { requested: boolean; attempted: boolean; ok: boolean }; summary: string };
    expect(r.activation).toMatchObject({ requested: true, attempted: false, ok: false });
    expect(r.summary).toContain('NOT attempted');
  });

  it('verifyCapture counts parent-payload and per-row coverage separately (mixed form stays parent_row)', async () => {
    const ids = SAMPLE_IDS();
    const t = baseTables();
    const plan = samplePlan();
    const all = plannedRows(plan).map(r => ({ table: r.table, sys_id: r.sys_id }));
    const coId = 'c0'.repeat(16);
    t.sys_update_xml = [
      { sys_id: 'x'.repeat(32), name: `sys_hub_flow_${ids.flow}`, update_set: US, type: 'Flow', payload: all.map(r => `<sys_id>${r.sys_id}</sys_id>`).join(''), update_guid: 'g', payload_hash: '1' },
      { sys_id: 'y'.repeat(32), name: `sys_complex_object_${coId}`, update_set: US, type: 'Complex Object', payload: '' },
    ];
    const { client } = makeFakeClient({ username: 'mcp.user', tables: t });
    const c = await verifyCapture(client, US, ids.flow, [...all, { table: 'sys_complex_object', sys_id: coId }]);
    expect(c.mode).toBe('parent_row');
    expect(c.coveredByParent).toBe(all.length);
    expect(c.coveredPerRow).toBe(1);
    expect(c.ok).toBe(true);
  });

  it('a per-row capture whose sys_hub_flow_<id> row holds only the flow record is reported as per_row', async () => {
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), capture: 'per_row' });
    const r = await writePlan(client, samplePlan(), opts());
    expect(r.capture.mode).toBe('per_row');
    // the flow's own per-row record IS named sys_hub_flow_<id>: it covers the flow row only, never a child
    expect(r.capture.coveredByParent).toBe(1);
    expect(r.capture.coveredPerRow + r.capture.coveredByParent).toBe(7);
  });

  it('verifyCapture flags children missing from the parent payload', async () => {
    const ids = SAMPLE_IDS();
    const t = baseTables();
    t.sys_update_xml = [{ sys_id: 'x'.repeat(32), name: `sys_hub_flow_${ids.flow}`, update_set: US, type: 'Flow', payload: `<record_update><sys_id>${ids.flow}</sys_id><sys_id>${ids.trigger}</sys_id></record_update>`, update_guid: 'g', payload_hash: '1' }];
    const { client } = makeFakeClient({ username: 'mcp.user', tables: t });
    const rows = plannedRows(samplePlan()).map(r => ({ table: r.table, sys_id: r.sys_id }));
    const c = await verifyCapture(client, US, ids.flow, rows);
    expect(c.mode).toBe('parent_row');
    expect(c.found).toBe(2);
    expect(c.missing).toHaveLength(5);
    expect(c.ok).toBe(false);
  });
});

describe('activation', () => {
  const activateOk = (_m: string, _p: string, body: unknown, state: { tables: Map<string, Map<string, Record<string, string>>> }) => {
    const id = (body as { flows: { sys_id: string }[] }).flows[0].sys_id;
    const row = state.tables.get('sys_hub_flow')!.get(id)!;
    row.active = 'true'; row.status = 'published'; row.latest_snapshot = 'snap'.padEnd(32, '0');
    return { result: { summary: 'activated 1 flow', results: [{ sys_id: id, status: 'success' }] } };
  };

  it('POSTs activate_flows with the design body + scope param, then reads back active/status/latest_snapshot and re-verifies capture', async () => {
    const ids = SAMPLE_IDS();
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), onRequest: activateOk });
    const r = await writePlan(client, samplePlan(), opts({ activate: true }));
    const post = state.calls.find(c => c.method === 'requestJson')!;
    expect(post.path).toBe(`${ACTIVATE_FLOWS_PATH}?sysparm_transaction_scope=global`);
    expect(post.body).toEqual({ flows: [{ sys_id: ids.flow, active: '', state: '' }], actions: [] });
    const sig = callSignature(state.calls);
    const postIdx = sig.indexOf(`requestJson:${ACTIVATE_FLOWS_PATH}`);
    expect(sig.slice(postIdx + 1)).toContain('getRecord:sys_hub_flow'); // mandatory read-back after the POST
    expect(sig.slice(postIdx + 1)).toContain('queryRecords:sys_update_xml'); // re-verified capture
    expect(r.activation.requested).toBe(true);
    expect(r.activation.attempted).toBe(true);
    expect(r.activation.http_status).toBe(200);
    expect(r.activation.ok).toBe(true);
    expect(r.activation.scope).toBe('global');
    expect(r.activation.read_back).toEqual({ active: 'true', status: 'published', latest_snapshot: 'snap'.padEnd(32, '0') });
    expect(r.activation.capture_after?.ok).toBe(true);
    expect(r.summary).toContain('activation OK');
  });

  it('sends the sys_scope SYS_ID (not the scope name) as sysparm_transaction_scope on a scoped flow', async () => {
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables({ updateSet: { application: 'b'.repeat(32) } }), onRequest: activateOk });
    const r = await writePlan(client, samplePlan({ scope: 'x_example_app' }), opts({ activate: true }));
    expect(state.calls.find(c => c.method === 'requestJson')!.path).toBe(`${ACTIVATE_FLOWS_PATH}?sysparm_transaction_scope=${'b'.repeat(32)}`);
    expect(r.activation.scope).toBe('b'.repeat(32));
  });

  it('a 200 whose summary reports failures but whose read-back is active is ok with a note; other HTTP errors are failures, not "endpoint absent"', async () => {
    const partial = (_m: string, _p: string, body: unknown, state: { tables: Map<string, Map<string, Record<string, string>>> }) => {
      const id = (body as { flows: { sys_id: string }[] }).flows[0].sys_id;
      const row = state.tables.get('sys_hub_flow')!.get(id)!;
      row.active = 'true'; row.status = 'published';
      return { result: { summary: { total: 2, succeeded: 1, failed: 1 }, results: [] } };
    };
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), onRequest: partial });
    const r = await writePlan(client, samplePlan(), opts({ activate: true }));
    expect(r.activation.ok).toBe(true);
    expect(r.activation.message).toContain('reported 1/2 failed');

    const { client: c403 } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), onRequest: () => { throw new ServiceNowError('Forbidden', 'FORBIDDEN', { status: 403, body: '{"error":{"message":"User Not Authorized"}}' }); } });
    const r403 = await writePlan(c403, samplePlan({ flowKey: 'k403' }), opts({ activate: true }));
    expect(r403.activation.http_status).toBe(403);
    expect(r403.activation.ok).toBe(false);
    expect(r403.activation.message).toContain('failed (HTTP 403)');
    expect(r403.activation.message).not.toContain('sn_glider');
    expect(r403.activation.response).toEqual({ error: { message: 'User Not Authorized' } });

    const { client: c400 } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), onRequest: () => { throw new ServiceNowError('Bad Request', 'INVALID_REQUEST', { status: 400, body: '{"error":{"message":"invalid flow"}}' }); } });
    const r400 = await writePlan(c400, samplePlan({ flowKey: 'k400' }), opts({ activate: true }));
    expect(r400.activation.message).toContain('failed (HTTP 400)');

    const { client: c404 } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), onRequest: () => { throw new ServiceNowError('Not Found', 'NOT_FOUND', { status: 404, body: '' }); } });
    const r404 = await writePlan(c404, samplePlan({ flowKey: 'k404' }), opts({ activate: true }));
    expect(r404.activation.message).toContain('ServiceNow IDE store app (sn_glider) is required');
  });

  it('a 200 whose read-back is still inactive is NOT ok', async () => {
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), onRequest: () => ({ result: { summary: 'ok?', results: [] } }) });
    const r = await writePlan(client, samplePlan(), opts({ activate: true }));
    expect(r.activation.http_status).toBe(200);
    expect(r.activation.ok).toBe(false);
    expect(r.activation.read_back?.active).toBe('false');
    expect(r.activation.message).toContain('read-back shows active=false');
    expect(r.warnings.some(w => w.startsWith('activation FAILED'))).toBe(true);
  });

  it('a 422 carries the parsed result body; 400/404 mean the endpoint is absent — read-back still runs', async () => {
    const body422 = JSON.stringify({ result: { summary: '1 flow failed', results: [{ status: 'error', message: 'compile error' }] } });
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), onRequest: () => { throw new ServiceNowError('Unprocessable', 'API_ERROR', { status: 422, body: body422 }); } });
    const r = await writePlan(client, samplePlan(), opts({ activate: true }));
    expect(r.activation.http_status).toBe(422);
    expect(r.activation.response).toEqual(JSON.parse(body422));
    expect(r.activation.ok).toBe(false);
    expect(callSignature(state.calls).slice(callSignature(state.calls).indexOf(`requestJson:${ACTIVATE_FLOWS_PATH}`) + 1)).toContain('getRecord:sys_hub_flow');

    const { client: c2 } = makeFakeClient({ username: 'mcp.user', tables: baseTables() }); // default onRequest → 400
    const r2 = await writePlan(c2, samplePlan({ flowKey: 'k2' }), opts({ activate: true }));
    expect(r2.activation.http_status).toBe(400);
    expect(r2.activation.ok).toBe(false);
    expect(r2.activation.message).toContain('ServiceNow IDE store app (sn_glider) is required');
    expect(r2.activation.read_back?.active).toBe('false');
  });

  it('THROWS FLOW_BUILDER_CAPTURE_NOT_VERIFIED when the capture no longer verifies after activation (capture_after)', async () => {
    const leaky = (m: string, p: string, body: unknown, state: { tables: Map<string, Map<string, Record<string, string>>> }) => {
      const r = activateOk(m, p, body, state);
      // activation re-saved sys_hub_flow outside the target update set: our capture row is gone from it
      for (const x of state.tables.get('sys_update_xml')!.values()) x.update_set = 'DEFAULT';
      return r;
    };
    const { client } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), onRequest: leaky });
    let err: ServiceNowError | undefined;
    try { await writePlan(client, samplePlan(), opts({ activate: true })); } catch (e) { err = e as ServiceNowError; }
    expect(err?.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    const r = err!.details as { capture: { ok: boolean }; activation: { ok: boolean; capture_after: { ok: boolean; otherUpdateSets: string[] } } };
    expect(r.capture.ok).toBe(true);
    expect(r.activation.ok).toBe(true);
    expect(r.activation.capture_after.ok).toBe(false);
    expect(r.activation.capture_after.otherUpdateSets).toEqual(['DEFAULT']);
  });

  it('never calls activate_flows unless opts.activate is true', async () => {
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: baseTables(), onRequest: activateOk });
    await writePlan(client, samplePlan(), opts());
    expect(state.calls.some(c => c.method === 'requestJson')).toBe(false);
  });
});

describe('helpers', () => {
  it('pillTokensIn collects every {{...}} in nested structures', () => {
    const t = pillTokensIn({ a: 'x {{Created_1.current.number}} y', b: [{ c: '{{static.abc}}' }, '{{}}'], d: 3 });
    expect([...t].sort()).toEqual(['', 'Created_1.current.number', 'static.abc']);
  });

  it('describeCaptureProtocol names the target, the scoped step and the activation step', () => {
    const steps = describeCaptureProtocol(samplePlan({ scope: 'x_example_app' }), { name: 'TEST_X' });
    expect(steps[0]).toContain('name="TEST_X"');
    expect(steps.some(s => s.startsWith('3b.') && s.includes('apps.current_app'))).toBe(true);
    expect(steps.some(s => s.includes('7 planned sys_ids'))).toBe(true);
    expect(steps.at(-1)).toContain('activate_flows');
  });
});
