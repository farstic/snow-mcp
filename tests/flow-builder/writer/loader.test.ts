/**
 * writer/loader.ts — loadPlan through the ServiceNow IDE loader (api/fluent/load/<scope>?targetUpdateSetId=…):
 * the exact call shape (one multipart part 'files' = planToRecordUpdateXml(plan)), error mapping,
 * the read-back verification (rows present, version '2', ONE sys_hub_flow_<id> capture row), activation
 * sequencing, the ACTIVE-flow / create-mode / update-set refusals, STALE handling (the loader's own
 * delete_multiple must be confirmed), NO sys_user_preference access for the load, and the activation bracket
 * (PDI finding 1: preferences set around activate_flows and restored; leaked rows moved or refused) plus the
 * platform-managed trigger inputs of record-triggered flows (PDI finding 2).
 */
import { describe, it, expect } from 'vitest';
import { ServiceNowError } from '../../../src/utils/errors.js';
import { loadPlan, describeLoadProtocol, isRecordTriggeredFlow, LOADER_LOAD_PATH, LOADER_PART_NAME, LOADER_TIMEOUT_MS, LOADER_PREFERENCE_NOTE, ACTIVATION_PREFERENCE_NOTE, type FlowLoadResult } from '../../../src/flow-builder/writer/loader.js';
import { plannedRows, ACTIVATE_FLOWS_PATH } from '../../../src/flow-builder/writer/index.js';
import { planToRecordUpdateXml } from '../../../src/flow-builder/xml/record-update.js';
import type { WriteOptions } from '../../../src/flow-builder/spec/types.js';
import type { ServiceNowClient } from '../../../src/servicenow/client.js';
import { makeFakeClient, baseTables, callSignature, parseRecordUpdate, matchesQuery, captureActivation, preferenceOf, stamp, type FakeOptions, type FakeState, type MultipartResponse, type Row } from './fake-client.js';
import { samplePlan, SAMPLE_IDS } from './sample-plan.js';

const US = 'a'.repeat(32);
const SCOPE = 'b'.repeat(32);
const opts = (o: Partial<WriteOptions> = {}): WriteOptions => ({ updateSet: { sys_id: US }, mode: 'create', activate: false, deleteStale: false, confirmDelete: [], ...o });
const fake = (o: FakeOptions = {}) => makeFakeClient({ username: 'mcp.user', tables: baseTables(), ...o });

async function errOf(p: Promise<unknown>): Promise<ServiceNowError> {
  try { await p; } catch (e) { return e as ServiceNowError; }
  throw new Error('expected a throw');
}
const writesOf = (calls: { method: string }[]) => calls.filter(c => ['createRecord', 'updateRecord', 'deleteRecord', 'requestJson', 'postMultipart'].includes(c.method));
const touchesPreferences = (calls: { method: string; table?: string }[]) => calls.some(c => c.table === 'sys_user_preference' || c.table === 'sys_user');
const respond = (r: MultipartResponse) => () => r;

/**
 * A custom loader: applies the document's delete_multiple (unless skipDeletes) and rows (optionally skipping one row,
 * or every row when rows:false), (re)captures into `captureSet` with sys_mod_count+1, answers `answerSet`.
 */
/** The function form of FakeOptions['loader']. */
type LoaderFn = Extract<NonNullable<FakeOptions['loader']>, (...args: never[]) => unknown>;

function customLoader(o: { skip?: string; skipDeletes?: boolean; rows?: boolean; captureSet?: string; answerSet?: string } = {}): LoaderFn {
  return (_path, files, params, st) => {
    const t = (n: string) => { if (!st.tables.has(n)) st.tables.set(n, new Map()); return st.tables.get(n)!; };
    for (const el of parseRecordUpdate(files[0].content)) {
      if (el.kind === 'delete') { if (!o.skipDeletes) for (const [id, row] of [...t(el.table).entries()]) if (matchesQuery(row, el.query)) t(el.table).delete(id); continue; }
      if (o.rows !== false && el.fields.sys_id !== o.skip) t(el.table).set(el.fields.sys_id, { ...(t(el.table).get(el.fields.sys_id) ?? {}), ...el.fields });
    }
    const name = `sys_hub_flow_${SAMPLE_IDS().flow}`;
    const set = o.captureSet ?? params.targetUpdateSetId;
    const prev = [...t('sys_update_xml').values()].find(x => x.name === name && x.update_set === set); // re-serialised in place
    const id = prev?.sys_id ?? '9'.repeat(32);
    t('sys_update_xml').set(id, { sys_id: id, name, update_set: set, payload: files[0].content, type: 'Flow', sys_mod_count: String(Number(prev?.sys_mod_count ?? -1) + 1), sys_updated_on: stamp(st.seq++) });
    return { status: 200, ok: true, statusText: 'OK', json: { result: { targetUpdateSetId: o.answerSet ?? params.targetUpdateSetId } } };
  };
}

/** The fake's tables as makeFakeClient input (to continue from one fake's state with another loader behaviour). */
function tablesOf(st: FakeState): Record<string, Row[]> {
  return Object.fromEntries([...st.tables.entries()].map(([name, rows]) => [name, [...rows.values()].map(r => ({ ...r }))]));
}

/** A fake that already holds the sample flow, loaded once into US (mode create). */
async function loadedOnce(): Promise<FakeState> {
  const { client, state } = fake();
  await loadPlan(client, samplePlan(), opts());
  return state;
}

/** Activation stub: flips the flow active, and captures the activation into `captureSet` (or nowhere). */
const activation = (captureSet?: string): FakeOptions['onRequest'] => (_m, _p, body, st) => {
  const id = (body as { flows: { sys_id: string }[] }).flows[0].sys_id;
  const row = st.tables.get('sys_hub_flow')!.get(id)!;
  row.active = 'true'; row.status = 'published'; row.latest_snapshot = '5'.repeat(32);
  if (captureSet) captureActivation(st, id, captureSet);
  return { result: { summary: { total: 1, succeeded: 1, failed: 0 } } };
};

/**
 * activate_flows as on the PDI (finding 1): flips the flow active and captures where the user's GLOBAL
 * sys_update_set preference points (`ignorePreference`: always into that set instead), optionally with the
 * two sys_documentation_var__m_sys_hub_flow_input_<id>_<element>_en rows, then (`repointTo`) re-points the
 * preference like the PDI did. New rows carry sys_created_by = `createdBy` (default the session user).
 */
const activationViaPreference = (o: { ignorePreference?: string; repointTo?: string; createdBy?: string; docs?: boolean } = {}): FakeOptions['onRequest'] => (_m, _p, body, st) => {
  const id = (body as { flows: { sys_id: string }[] }).flows[0].sys_id;
  const row = st.tables.get('sys_hub_flow')!.get(id)!;
  row.active = 'true'; row.status = 'published'; row.latest_snapshot = '5'.repeat(32);
  const set = o.ignorePreference ?? preferenceOf(st, 'mcp.user', 'sys_update_set') ?? 'DEFAULT';
  const createdBy = o.createdBy ?? 'mcp.user';
  captureActivation(st, id, set, { createdBy });
  if (o.docs) {
    const xml = st.tables.get('sys_update_xml')!;
    for (const el of ['current', 'table_name']) {
      const name = `sys_documentation_var__m_sys_hub_flow_input_${id}_${el}_en`;
      const docId = ((st.seq++).toString(16).padStart(8, '0') + 'd'.repeat(24)).slice(0, 32);
      xml.set(docId, { sys_id: docId, name, update_set: set, type: 'Documentation', payload: '<record_update/>', sys_mod_count: '0', sys_created_on: stamp(st.seq), sys_updated_on: stamp(st.seq++), sys_created_by: createdBy });
    }
  }
  if (o.repointTo) {
    const pref = [...(st.tables.get('sys_user_preference')?.values() ?? [])].find(p => p.user === 'u'.repeat(32) && p.name === 'sys_update_set');
    if (pref) pref.value = o.repointTo;
  }
  return { result: { summary: { total: 1, succeeded: 1, failed: 0 } } };
};

describe('loadPlan — call shape', () => {
  it('POSTs ONE multipart part "files" = planToRecordUpdateXml(plan) to api/fluent/load/global?targetUpdateSetId=<set>, and nothing else writes', async () => {
    const { client, state } = fake();
    const plan = samplePlan();
    const r = await loadPlan(client, plan, opts());

    const loads = state.calls.filter(c => c.method === 'postMultipart');
    expect(loads).toHaveLength(1);
    const [load] = loads;
    expect(load.path).toBe(`${LOADER_LOAD_PATH}/global`);
    expect(load.params).toEqual({ targetUpdateSetId: US });
    expect(load.timeoutMs).toBe(LOADER_TIMEOUT_MS);
    expect(LOADER_TIMEOUT_MS).toBe(300000); // our timeout for the loader POST (a flow load compiles server-side)
    expect(load.files).toEqual([{ field: LOADER_PART_NAME, filename: `sys_hub_flow_${SAMPLE_IDS().flow}.xml`, contentType: 'application/xml', content: planToRecordUpdateXml(plan) }]);
    expect(LOADER_PART_NAME).toBe('files');

    // the only write is the load; no Table-API write, no activation, no preference, no sys_user lookup
    expect(writesOf(state.calls).map(c => c.method)).toEqual(['postMultipart']);
    expect(touchesPreferences(state.calls)).toBe(false);
    expect(r.preferences).toEqual([]);
    expect(r.preferencesNote).toBe(LOADER_PREFERENCE_NOTE);
    expect(r.summary).toContain('no sys_user_preference writes');

    // result
    const ids = SAMPLE_IDS();
    expect(r.transport).toBe('loader');
    expect(r.flowSysId).toBe(ids.flow);
    expect(r.updateSet).toEqual({ sys_id: US, name: 'TEST_FLOW_TEST_V1' });
    expect(r.scope).toEqual({ sys_id: 'global', scope: 'global', name: 'Global' });
    expect(r.loader).toMatchObject({ path: `${LOADER_LOAD_PATH}/global`, scopeId: 'global', targetUpdateSetId: US, http_status: 200, returnedUpdateSetId: US, file: { field: 'files', contentType: 'application/xml' } });
    expect(r.loader.file.bytes).toBe(Buffer.byteLength(planToRecordUpdateXml(plan), 'utf8'));
    expect(r.loader.deleteMultiple.map(d => d.table)).toEqual(expect.arrayContaining(['sys_hub_flow_variable', 'sys_hub_flow_stage', 'sys_hub_trigger_instance_v2', 'sys_hub_flow_logic_instance_v2', 'sys_hub_action_instance_v2']));
    expect(r.planned).toEqual(plannedRows(plan).map(x => ({ table: x.table, sys_id: x.sys_id })));
    expect(r.written).toEqual(plannedRows(plan).map(x => ({ table: x.table, sys_id: x.sys_id, action: 'inserted' })));
    expect(r.missing).toEqual([]);
    expect(r.flowState).toMatchObject({ version: '2', status: 'draft', active: 'false' });
    expect(r.capture).toMatchObject({ ok: true, mode: 'parent_row', expected: 7, found: 7, missing: [] });
    expect(r.capture.parentRow?.name).toBe(`sys_hub_flow_${ids.flow}`);
    expect(r.existedBefore).toEqual([]);
    expect(r.stale).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(r.activation).toEqual({ requested: false, attempted: false, ok: false });
    expect(r.warnings).toEqual([]);
  });

  it('reads happen in order: update set → existence pre-check → child scan → load → flow read-back → rows → child scan → capture', async () => {
    const { client, state } = fake();
    await loadPlan(client, samplePlan(), opts());
    const sig = callSignature(state.calls);
    const load = sig.indexOf(`postMultipart:${LOADER_LOAD_PATH}/global`);
    expect(sig[0]).toBe('getRecord:sys_update_set');
    expect(sig.slice(0, load).every(s => s.startsWith('queryRecords:') || s.startsWith('getRecord:'))).toBe(true);
    expect(sig[load + 1]).toBe('getRecord:sys_hub_flow');
    expect(sig[sig.length - 1]).toBe('queryRecords:sys_update_xml');
  });

  it('a scoped flow is REFUSED on the loader path (not yet proven on a PDI) before anything is sent', async () => {
    const { client, state } = fake({ tables: baseTables({ updateSet: { application: SCOPE } }) });
    const e = await errOf(loadPlan(client, samplePlan({ scope: 'x_example_app' }), opts()));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_SCOPED_REFUSED');
    expect(writesOf(state.calls)).toEqual([]);
  });

  it('a scoped flow (test-only opt-in) loads to api/fluent/load/<sys_scope sys_id>; <sys_scope> is display_value=<scope NAME>, text=<sys_id> (reference element form)', async () => {
    const { client, state } = fake({ tables: baseTables({ updateSet: { application: SCOPE } }) });
    const plan = samplePlan({ scope: 'x_example_app' });
    const r = await loadPlan(client, plan, { ...opts(), allowScopedUnverified: true });
    const [load] = state.calls.filter(c => c.method === 'postMultipart');
    expect(load.path).toBe(`${LOADER_LOAD_PATH}/${SCOPE}`);
    expect(r.scope).toEqual({ sys_id: SCOPE, scope: 'x_example_app', name: 'Test App' });
    const doc = load.files![0].content;
    const scopes = new Set(parseRecordUpdate(doc).filter(e => e.kind === 'row').map(e => (e as { fields: Record<string, string> }).fields.sys_scope));
    expect(scopes.has('x_example_app')).toBe(false);
    expect(scopes.has(SCOPE)).toBe(true);
    // the exact element: display_value = the scope name, text = the sys_scope sys_id — never display_value=<32-hex>
    expect(doc).toContain(`<sys_scope display_value="x_example_app">${SCOPE}</sys_scope>`);
    expect(doc).not.toContain(`display_value="${SCOPE}"`);
    expect(touchesPreferences(state.calls)).toBe(false); // no apps.current_app either
  });

  it('refuses a client without postMultipart before any call', async () => {
    const { fns, state } = fake();
    const bare = { ...fns, postMultipart: undefined } as unknown as ServiceNowClient;
    expect((await errOf(loadPlan(bare, samplePlan(), opts()))).code).toBe('FLOW_BUILDER_CLIENT_UNSUPPORTED');
    expect(state.calls).toEqual([]);
  });
});

describe('loadPlan — refusals before anything is sent', () => {
  it('update set: is_default / not in progress / wrong application', async () => {
    for (const [override, code] of [
      [{ is_default: 'true' }, 'FLOW_BUILDER_UPDATE_SET_IS_DEFAULT'],
      [{ state: 'complete' }, 'FLOW_BUILDER_UPDATE_SET_NOT_IN_PROGRESS'],
      [{ application: SCOPE }, 'FLOW_BUILDER_UPDATE_SET_SCOPE_MISMATCH'],
    ] as const) {
      const { client, state } = fake({ tables: baseTables({ updateSet: override }) });
      expect((await errOf(loadPlan(client, samplePlan(), opts()))).code).toBe(code);
      expect(writesOf(state.calls)).toEqual([]);
    }
  });

  it("mode:'create' refuses when planned rows exist; an ACTIVE existing flow is refused unless allowDeactivate", async () => {
    const { client, state } = fake();
    await loadPlan(client, samplePlan(), opts());
    state.calls.length = 0;
    expect((await errOf(loadPlan(client, samplePlan(), opts()))).code).toBe('FLOW_BUILDER_ROWS_EXIST');
    expect(writesOf(state.calls)).toEqual([]);

    const flow = state.tables.get('sys_hub_flow')!.get(SAMPLE_IDS().flow)!;
    flow.active = 'true'; flow.status = 'published';
    const e = await errOf(loadPlan(client, samplePlan(), opts({ mode: 'update' })));
    expect(e.code).toBe('FLOW_BUILDER_FLOW_ACTIVE');
    expect(writesOf(state.calls)).toEqual([]);

    const r = await loadPlan(client, samplePlan(), opts({ mode: 'update', allowDeactivate: true }));
    expect(r.previousFlowState).toMatchObject({ active: 'true', status: 'published' });
    expect(r.warnings.some(w => w.includes('was ACTIVE'))).toBe(true);
    expect(r.flowState).toMatchObject({ active: 'false', status: 'draft', version: '2' });
    expect(r.written.every(w => w.action === 'updated')).toBe(true);
  });

  it('STALE child rows the loader would delete must be confirmed (delete_stale + confirm_delete), else nothing is sent', async () => {
    const { client, state, table } = fake();
    const ids = SAMPLE_IDS();
    await loadPlan(client, samplePlan(), opts());
    const staleAction = '5'.repeat(32);
    const staleSubflow = '6'.repeat(32);
    table('sys_hub_action_instance_v2').set(staleAction, { sys_id: staleAction, flow: ids.flow, order: '9' });
    table('sys_hub_sub_flow_instance_v2').set(staleSubflow, { sys_id: staleSubflow, flow: ids.flow, order: '10' }); // no delete_multiple for this table (plan has no subflow calls)
    state.calls.length = 0;

    const e = await errOf(loadPlan(client, samplePlan(), opts({ mode: 'update' })));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_WOULD_DELETE');
    // the subflow table is EMPTY in the plan but populated on the instance: it is cleaned too, so its row needs confirming as well
    expect(e.details).toMatchObject({ unconfirmed: [{ table: 'sys_hub_action_instance_v2', sys_id: staleAction }, { table: 'sys_hub_sub_flow_instance_v2', sys_id: staleSubflow }], cleanedTables: ['sys_hub_sub_flow_instance_v2'] });
    expect(writesOf(state.calls)).toEqual([]);
    expect(table('sys_hub_action_instance_v2').has(staleAction)).toBe(true);

    expect((await errOf(loadPlan(client, samplePlan(), opts({ mode: 'update', deleteStale: true, confirmDelete: [staleAction] })))).code).toBe('FLOW_BUILDER_LOADER_WOULD_DELETE');
    expect(writesOf(state.calls)).toEqual([]);

    const r = await loadPlan(client, samplePlan(), opts({ mode: 'update', deleteStale: true, confirmDelete: [staleAction, staleSubflow] }));
    expect(r.existedBefore).toEqual(expect.arrayContaining([{ table: 'sys_hub_action_instance_v2', sys_id: staleAction }, { table: 'sys_hub_sub_flow_instance_v2', sys_id: staleSubflow }]));
    expect(r.deleted).toEqual([{ table: 'sys_hub_action_instance_v2', sys_id: staleAction }, { table: 'sys_hub_sub_flow_instance_v2', sys_id: staleSubflow }]); // applied by the loader's delete_multiple
    expect(r.stale).toEqual([]);
    expect(r.cleanedTables).toEqual(['sys_hub_sub_flow_instance_v2']);
    expect(r.loader.deleteMultiple).toContainEqual({ table: 'sys_hub_sub_flow_instance_v2', query: `flow=${ids.flow}` });
    expect(table('sys_hub_action_instance_v2').has(staleAction)).toBe(false);
    expect(table('sys_hub_sub_flow_instance_v2').has(staleSubflow)).toBe(false);
    expect(state.calls.some(c => c.method === 'deleteRecord')).toBe(false); // never a Table-API delete
  });

  it('deleteStale without confirmDelete is invalid', async () => {
    const { client } = fake();
    expect((await errOf(loadPlan(client, samplePlan(), opts({ deleteStale: true })))).code).toBe('INVALID_REQUEST');
  });
});

describe('loadPlan — loader error mapping', () => {
  const cases: [string, FakeOptions['loader'], string][] = [
    ['404 (endpoint absent)', 'absent', 'FLOW_BUILDER_LOADER_UNAVAILABLE'],
    ['400 "does not represent any resource"', respond({ status: 400, ok: false, statusText: 'Bad Request', json: { error: { message: 'Requested URI does not represent any resource' } } }), 'FLOW_BUILDER_LOADER_UNAVAILABLE'],
    ['401', respond({ status: 401, ok: false, statusText: 'Unauthorized', json: { error: { message: 'User Not Authenticated' } } }), 'FLOW_BUILDER_LOADER_AUTH_REFUSED'],
    ['403', respond({ status: 403, ok: false, statusText: 'Forbidden', text: 'forbidden' }), 'FLOW_BUILDER_LOADER_AUTH_REFUSED'],
    ['500 with result.error', respond({ status: 500, ok: false, statusText: 'Server Error', json: { result: { error: 'compile failed: bad trigger' } } }), 'FLOW_BUILDER_LOADER_FAILED'],
    ['400 other', respond({ status: 400, ok: false, statusText: 'Bad Request', text: 'malformed' }), 'FLOW_BUILDER_LOADER_FAILED'],
    ['200 carrying result.error', respond({ status: 200, ok: true, statusText: 'OK', json: { result: { error: 'partial' } } }), 'FLOW_BUILDER_LOADER_FAILED'],
    ['200 with a non-JSON body (SSO / login page)', respond({ status: 200, ok: true, statusText: 'OK', text: '<html><body>Log in</body></html>' }), 'FLOW_BUILDER_LOADER_FAILED'],
    ['200 with an empty body', respond({ status: 200, ok: true, statusText: 'OK', text: '' }), 'FLOW_BUILDER_LOADER_FAILED'],
    ['200 JSON without result.targetUpdateSetId', respond({ status: 200, ok: true, statusText: 'OK', json: { result: {} } }), 'FLOW_BUILDER_LOADER_FAILED'],
    ['200 naming ANOTHER update set', customLoader({ answerSet: 'd'.repeat(32) }), 'FLOW_BUILDER_LOADER_FAILED'],
  ];
  for (const [name, loader, code] of cases) {
    it(`${name} → ${code}`, async () => {
      const { client, state } = fake({ loader });
      const e = await errOf(loadPlan(client, samplePlan(), opts()));
      expect(e.code).toBe(code);
      expect(e.details).toMatchObject({ flowSysId: SAMPLE_IDS().flow, loader: { path: `${LOADER_LOAD_PATH}/global`, targetUpdateSetId: US } });
      expect(writesOf(state.calls).map(c => c.method)).toEqual(['postMultipart']);
      expect(touchesPreferences(state.calls)).toBe(false);
    });
  }

  it('the failure body is carried for FLOW_BUILDER_LOADER_FAILED', async () => {
    const { client } = fake({ loader: respond({ status: 500, ok: false, statusText: 'Server Error', json: { result: { error: 'compile failed: bad trigger' } } }) });
    const e = await errOf(loadPlan(client, samplePlan(), opts()));
    expect(e.message).toContain('compile failed: bad trigger');
    expect((e.details as { body: unknown }).body).toEqual({ result: { error: 'compile failed: bad trigger' } });
  });

  it('a transport failure (no response) is FLOW_BUILDER_LOADER_FAILED and says the load may have been applied', async () => {
    const { client } = fake({ loader: () => { throw new ServiceNowError('postMultipart: no response within 120000 ms', 'TIMEOUT'); } });
    const e = await errOf(loadPlan(client, samplePlan(), opts()));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_FAILED');
    expect(e.message).toMatch(/may or may not have been applied/);
    expect((e.details as { cause: string }).cause).toBe('TIMEOUT');
  });
});

describe('loadPlan — read-back verification (errors, never warnings)', () => {
  it("sys_hub_flow.version != '2' → FLOW_BUILDER_LOADER_VERSION_MISMATCH with the full result; activation never attempted", async () => {
    const { client, state } = fake({ loader: 'version1' });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_VERSION_MISMATCH');
    const d = e.details as { flowState: { version: string }; capture: { ok: boolean }; activation: { attempted: boolean; message: string }; written: unknown[] };
    expect(d.flowState.version).toBe('1');
    expect(d.capture.ok).toBe(true);
    expect(d.written).toHaveLength(7);
    expect(d.activation).toMatchObject({ requested: true, attempted: false });
    expect(state.calls.some(c => c.method === 'requestJson')).toBe(false);
  });

  it('no sys_hub_flow_<id> row in the target set → FLOW_BUILDER_CAPTURE_NOT_VERIFIED', async () => {
    const { client, state } = fake({ loader: 'no_capture' });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    expect((e.details as { capture: { ok: boolean; mode: string } }).capture).toMatchObject({ ok: false, mode: 'unverified' });
    expect(state.calls.some(c => c.method === 'requestJson')).toBe(false);
  });

  it('a capture in ANOTHER update set is reported (otherUpdateSets) and refused', async () => {
    const other = 'c'.repeat(32);
    const { client } = fake({ loader: customLoader({ captureSet: other }) });
    const e = await errOf(loadPlan(client, samplePlan(), opts()));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    expect((e.details as { capture: { otherUpdateSets: string[] } }).capture.otherUpdateSets).toEqual([other]);
  });

  it('a planned row absent after a 200 → FLOW_BUILDER_LOADER_ROWS_MISSING listing it', async () => {
    const ids = SAMPLE_IDS();
    const { client } = fake({ loader: customLoader({ skip: ids.logStep }) });
    const e = await errOf(loadPlan(client, samplePlan(), opts()));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_ROWS_MISSING');
    expect((e.details as { missing: unknown[] }).missing).toEqual([{ table: 'sys_hub_action_instance_v2', sys_id: ids.logStep }]);
  });

  it('a different targetUpdateSetId in the response is an ERROR even when the target set also holds a capture', async () => {
    const { client } = fake({ loader: customLoader({ answerSet: 'd'.repeat(32) }) });
    const e = await errOf(loadPlan(client, samplePlan(), opts()));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_FAILED');
    expect(e.message).toContain(`targetUpdateSetId=${'d'.repeat(32)}`);
  });
});

describe('loadPlan — activation', () => {
  it('activate:true → user resolved before sending; load, verify, THEN preferences set → activate_flows → preferences restored → capture check', async () => {
    const { client, state } = fake({ onRequest: activationViaPreference() });
    const r = await loadPlan(client, samplePlan(), opts({ activate: true }));
    const sig = callSignature(state.calls);
    const load = sig.indexOf(`postMultipart:${LOADER_LOAD_PATH}/global`);
    const act = sig.indexOf(`requestJson:${ACTIVATE_FLOWS_PATH}`);
    expect(load).toBeGreaterThanOrEqual(0);
    // the preference owner is resolved (read-only) before anything is sent; the LOAD touches no preference
    expect(sig.indexOf('queryRecords:sys_user')).toBeGreaterThanOrEqual(0);
    expect(sig.indexOf('queryRecords:sys_user')).toBeLessThan(load);
    expect(sig.slice(0, act).filter(s => s.endsWith(':sys_user_preference'))).toEqual(sig.slice(act - 4, act));
    expect(act).toBeGreaterThan(load);
    // verification reads sit between the load and the activation
    expect(sig.slice(load + 1, act)).toContain('queryRecords:sys_update_xml');
    // immediately before activate_flows: read + set sys_update_set, read + set apps.current_app
    expect(sig.slice(act - 4, act)).toEqual(['queryRecords:sys_user_preference', 'createRecord:sys_user_preference', 'queryRecords:sys_user_preference', 'createRecord:sys_user_preference']);
    // immediately after: the mandatory read-back, then the restore (read, delete, read back) of both preferences
    expect(sig.slice(act + 1, act + 8)).toEqual([
      'getRecord:sys_hub_flow',
      'queryRecords:sys_user_preference', 'deleteRecord:sys_user_preference', 'queryRecords:sys_user_preference',
      'queryRecords:sys_user_preference', 'deleteRecord:sys_user_preference', 'queryRecords:sys_user_preference',
    ]);
    expect(sig.slice(act + 8).some(s => s.endsWith(':sys_user_preference'))).toBe(false);
    expect(state.calls.filter(c => c.method === 'createRecord' && c.table === 'sys_user_preference').map(c => c.data)).toEqual([
      { user: 'u'.repeat(32), name: 'sys_update_set', value: US, type: 'string' },
      { user: 'u'.repeat(32), name: 'apps.current_app', value: 'global', type: 'string' },
    ]);
    const call = state.calls[act];
    expect(call.path).toBe(`${ACTIVATE_FLOWS_PATH}?sysparm_transaction_scope=global`);
    expect(call.body).toEqual({ flows: [{ sys_id: SAMPLE_IDS().flow, active: '', state: '' }], actions: [] });
    expect(r.activation).toMatchObject({ requested: true, attempted: true, ok: true, http_status: 200, read_back: { active: 'true', status: 'published' } });
    expect(r.activation.capture_after?.ok).toBe(true);
    expect(r.activationCapture).toMatchObject({ ok: true, parentChanged: true, activeInPayload: true, leaks: [], moved: [], duplicatesRemoved: [] });
    expect(r.activationCapture!.watched).toContain(`name=sys_hub_flow_${SAMPLE_IDS().flow}`);
    expect(r.activationCapture!.watched).toContain(`nameIN${`sys_hub_flow_snapshot_${'5'.repeat(32)}`},sys_hub_flow_${'5'.repeat(32)}`);
    expect(r.activationCapture!.watched).toContain(`nameSTARTSWITHsys_documentation_var__m_sys_hub_flow_input_${SAMPLE_IDS().flow}`);
    // before / set / restore / after — nothing existed, so the rows set for the activation are deleted again
    expect(r.activationPreferences).toEqual({
      user: { sys_id: 'u'.repeat(32), user_name: 'mcp.user' },
      restored: true,
      note: ACTIVATION_PREFERENCE_NOTE,
      entries: [
        { name: 'sys_update_set', before: { exists: false }, set: { value: US, action: 'inserted', sys_id: expect.any(String) }, restore: { action: 'deleted' }, after: { exists: false }, restored: true },
        { name: 'apps.current_app', before: { exists: false }, set: { value: 'global', action: 'inserted', sys_id: expect.any(String) }, restore: { action: 'deleted' }, after: { exists: false }, restored: true },
      ],
    });
    expect(state.tables.get('sys_user_preference')?.size ?? 0).toBe(0);
    expect(r.preferences).toEqual([]);
    expect(r.preferencesNote).toBe(ACTIVATION_PREFERENCE_NOTE);
    expect(r.summary).toContain('activation OK');
    expect(r.summary).toContain('set only around activate_flows and restored');
  });

  it('an absent activation endpoint is reported (not thrown) by loadPlan — the tool turns it into FLOW_BUILDER_ACTIVATION_FAILED; the preferences are restored all the same', async () => {
    const { client, state } = fake();
    const r = await loadPlan(client, samplePlan(), opts({ activate: true }));
    expect(r.activation).toMatchObject({ attempted: true, ok: false, http_status: 400, read_back: { active: 'false' } });
    expect(r.activation.message).toMatch(/not available/);
    expect(r.activationPreferences?.restored).toBe(true);
    expect(state.tables.get('sys_user_preference')?.size ?? 0).toBe(0);
  });

  it('activate:true without a resolvable user (no configured username) is refused BEFORE anything is sent', async () => {
    const { client, state } = fake({ username: undefined, onRequest: activationViaPreference() });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_USER_UNRESOLVED');
    expect(writesOf(state.calls)).toEqual([]);
  });

  it('setting the activation preferences fails → FLOW_BUILDER_ACTIVATION_PREFERENCE_FAILED, activate_flows never called, what was set is restored', async () => {
    const { client, state, fns } = fake({ onRequest: activationViaPreference() });
    const orig = fns.createRecord.getMockImplementation()!;
    let n = 0;
    fns.createRecord.mockImplementation(async (t: string, data: Record<string, unknown>) => {
      if (t === 'sys_user_preference' && ++n === 2) throw new ServiceNowError('Insufficient rights to insert sys_user_preference', 'FORBIDDEN', { status: 403 });
      return orig(t, data);
    });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_ACTIVATION_PREFERENCE_FAILED');
    expect(state.calls.some(c => c.method === 'requestJson')).toBe(false);
    const d = e.details as FlowLoadResult;
    expect(d.activation).toMatchObject({ requested: true, attempted: false, ok: false });
    expect(d.activationPreferences).toMatchObject({ restored: true, entries: [{ name: 'sys_update_set', restore: { action: 'deleted' } }, { name: 'apps.current_app', restore: { action: 'kept' } }] });
    expect(state.tables.get('sys_user_preference')?.size ?? 0).toBe(0);
  });

  it('a preference that cannot be restored → FLOW_BUILDER_PREFERENCE_NOT_RESTORED (after a verified capture), with before/after in the result', async () => {
    const { client, fns } = fake({ onRequest: activationViaPreference() });
    const orig = fns.deleteRecord.getMockImplementation()!;
    fns.deleteRecord.mockImplementation(async (t: string, id: string) => {
      if (t === 'sys_user_preference') throw new ServiceNowError('Operation against file sys_user_preference was aborted', 'FORBIDDEN', { status: 403 });
      return orig(t, id);
    });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_PREFERENCE_NOT_RESTORED');
    const d = e.details as FlowLoadResult;
    expect(d.activation.ok).toBe(true);
    expect(d.activationCapture!.ok).toBe(true);
    expect(d.activationPreferences!.restored).toBe(false);
    expect(d.activationPreferences!.entries[0]).toMatchObject({ name: 'sys_update_set', before: { exists: false }, restore: { action: 'failed' }, after: { exists: true, value: US }, restored: false });
    expect(d.summary).toContain('NOT restored');
  });
});

describe('loadPlan — a load must be shown to have changed something (review finding: update mode)', () => {
  it('a 200 that applies NOTHING while an earlier load sits in the same set → FLOW_BUILDER_LOADER_NOT_APPLIED (rows, version and old capture alone would pass)', async () => {
    const st = await loadedOnce();
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: tablesOf(st), loader: 'noop' });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ mode: 'update' })));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_NOT_APPLIED');
    const d = e.details as FlowLoadResult;
    expect(d.missing).toEqual([]);
    expect(d.flowState?.version).toBe('2');
    expect(d.capture.ok).toBe(true); // the earlier capture — not proof of this load
    expect(d.captureRow.changed).toBe(false);
    expect(d.captureRow.after).toEqual(d.captureRow.before);
    expect(writesOf(state.calls).map(c => c.method)).toEqual(['postMultipart']);
  });

  it('a no-op load of a CHANGED spec fails the same way and never reaches activation', async () => {
    const st = await loadedOnce();
    const { client, state } = makeFakeClient({ username: 'mcp.user', tables: tablesOf(st), loader: 'noop', onRequest: activation(US) });
    const e = await errOf(loadPlan(client, samplePlan({ name: 'P1 Log v2' }), opts({ mode: 'update', activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_NOT_APPLIED');
    expect((e.details as FlowLoadResult).activation).toMatchObject({ requested: true, attempted: false });
    expect(state.calls.some(c => c.method === 'requestJson')).toBe(false);
  });

  it('a loader that re-captures but does not store the new values → FLOW_BUILDER_LOADER_READBACK_MISMATCH naming the field', async () => {
    const st = await loadedOnce();
    const { client } = makeFakeClient({ username: 'mcp.user', tables: tablesOf(st), loader: customLoader({ rows: false }) });
    const e = await errOf(loadPlan(client, samplePlan({ name: 'P1 Log v2' }), opts({ mode: 'update' })));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_READBACK_MISMATCH');
    const d = e.details as FlowLoadResult;
    expect(d.captureRow.changed).toBe(true);
    expect(d.fieldDiffs).toContainEqual({ table: 'sys_hub_flow', sys_id: SAMPLE_IDS().flow, field: 'name', expected: 'P1 Log v2', actual: 'P1 Log' });
  });

  it('a genuine update load passes: the capture row changed and every planned field matches', async () => {
    const st = await loadedOnce();
    const { client } = makeFakeClient({ username: 'mcp.user', tables: tablesOf(st) });
    const r = await loadPlan(client, samplePlan({ name: 'P1 Log v2' }), opts({ mode: 'update' }));
    expect(r.captureRow.changed).toBe(true);
    expect(Number(r.captureRow.after!.sys_mod_count)).toBe(Number(r.captureRow.before!.sys_mod_count) + 1);
    expect(r.fieldDiffs).toEqual([]);
    expect(r.written.every(w => w.action === 'updated')).toBe(true);
    expect(r.summary).toContain('capture verified');
  });
});

describe('loadPlan — an update that drops every row of a child table (review finding: stale children)', () => {
  const withoutLogic = () => { const p = samplePlan(); return { ...p, instances: p.instances.filter(i => i.table !== 'sys_hub_flow_logic_instance_v2') }; };

  it('the emptied table gets delete_multiple flow=<id>; unconfirmed → WOULD_DELETE and nothing is sent; confirmed → the loader deletes it', async () => {
    const ids = SAMPLE_IDS();
    const st = await loadedOnce();
    const { client, state, table } = makeFakeClient({ username: 'mcp.user', tables: tablesOf(st) });
    const e = await errOf(loadPlan(client, withoutLogic(), opts({ mode: 'update' })));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_WOULD_DELETE');
    expect(e.details).toMatchObject({ unconfirmed: [{ table: 'sys_hub_flow_logic_instance_v2', sys_id: ids.ifStep }], cleanedTables: ['sys_hub_flow_logic_instance_v2'] });
    expect(writesOf(state.calls)).toEqual([]);

    const r = await loadPlan(client, withoutLogic(), opts({ mode: 'update', deleteStale: true, confirmDelete: [ids.ifStep] }));
    const [load] = state.calls.filter(c => c.method === 'postMultipart');
    expect(load.files![0].content).toContain(`<sys_hub_flow_logic_instance_v2 action="delete_multiple" query="flow=${ids.flow}"/>`);
    expect(r.cleanedTables).toEqual(['sys_hub_flow_logic_instance_v2']);
    expect(r.deleted).toEqual([{ table: 'sys_hub_flow_logic_instance_v2', sys_id: ids.ifStep }]);
    expect(r.stale).toEqual([]);
    expect(table('sys_hub_flow_logic_instance_v2').has(ids.ifStep)).toBe(false);
  });

  it('a child row still attached after the load is an ERROR (FLOW_BUILDER_LOADER_STALE_ROWS), not a warning', async () => {
    const ids = SAMPLE_IDS();
    const st = await loadedOnce();
    const { client } = makeFakeClient({ username: 'mcp.user', tables: tablesOf(st), loader: customLoader({ skipDeletes: true }) });
    const e = await errOf(loadPlan(client, withoutLogic(), opts({ mode: 'update', deleteStale: true, confirmDelete: [ids.ifStep] })));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_STALE_ROWS');
    expect((e.details as FlowLoadResult).stale).toEqual([{ table: 'sys_hub_flow_logic_instance_v2', sys_id: ids.ifStep }]);
  });
});

describe('loadPlan — alias-mapping housekeeping deletes (review finding: consider)', () => {
  it('alias rows of the planned instances are counted before the load and reported as housekeepingDeletes; other alias rows are untouched', async () => {
    const ids = SAMPLE_IDS();
    const st = await loadedOnce();
    const ours = 'e'.repeat(32);
    const foreign = 'f'.repeat(32);
    const tables = tablesOf(st);
    tables.sys_hub_alias_mapping = [{ sys_id: ours, source_id: ids.logStep }, { sys_id: foreign, source_id: '0'.repeat(32) }];
    const { client, table } = makeFakeClient({ username: 'mcp.user', tables });
    const r = await loadPlan(client, samplePlan(), opts({ mode: 'update' }));
    expect(r.housekeepingDeletes).toEqual([{ table: 'sys_hub_alias_mapping', sys_id: ours, source_id: ids.logStep }]);
    expect(r.warnings.some(w => w.includes('housekeeping') && w.includes(ours))).toBe(true);
    expect(table('sys_hub_alias_mapping').has(ours)).toBe(false);
    expect(table('sys_hub_alias_mapping').has(foreign)).toBe(true);
  });
});

describe('loadPlan — activation capture (PDI finding 1: activate_flows follows the user preference, not targetUpdateSetId)', () => {
  const OTHER = 'c'.repeat(32);
  const FLOW_XML = () => `sys_hub_flow_${SAMPLE_IDS().flow}`;
  const DOC_XML = (el: string) => `sys_documentation_var__m_sys_hub_flow_input_${SAMPLE_IDS().flow}_${el}_en`;

  it('PDI reproduction: the preference points at a colleague\'s "Default 2" set and activate_flows re-points it — the activation is captured in the TARGET set and both preferences are restored exactly', async () => {
    const DEFAULT2 = OTHER;
    const u = 'u'.repeat(32);
    const prefs: Row[] = [
      { sys_id: '1'.repeat(32), user: u, name: 'sys_update_set', value: DEFAULT2, type: 'string' },
      { sys_id: '2'.repeat(32), user: u, name: 'apps.current_app', value: SCOPE, type: 'string' },
    ];
    const { client, state } = fake({ tables: { ...baseTables(), sys_user_preference: prefs }, onRequest: activationViaPreference({ docs: true, repointTo: 'e'.repeat(32) }) });
    const r = await loadPlan(client, samplePlan(), opts({ activate: true }));

    const xml = [...state.tables.get('sys_update_xml')!.values()];
    expect(xml.filter(x => x.update_set !== US)).toEqual([]); // nothing in "Default 2" (or anywhere else)
    expect(xml.map(x => x.name).sort()).toEqual([DOC_XML('current'), DOC_XML('table_name'), FLOW_XML()].sort());
    expect(xml.find(x => x.name === FLOW_XML())!.payload).toMatch(/<sys_hub_flow[^>]*>[\s\S]*?<active>true<\/active>/);
    expect(r.activationCapture).toMatchObject({ ok: true, parentChanged: true, activeInPayload: true, leaks: [], moved: [], duplicatesRemoved: [] });

    // restored to exactly the previous rows / values, although activate_flows re-pointed sys_update_set
    expect(preferenceOf(state, 'mcp.user', 'sys_update_set')).toBe(DEFAULT2);
    expect(preferenceOf(state, 'mcp.user', 'apps.current_app')).toBe(SCOPE);
    expect(state.tables.get('sys_user_preference')!.size).toBe(2);
    expect(r.activationPreferences!.entries).toEqual([
      { name: 'sys_update_set', before: { exists: true, sys_id: '1'.repeat(32), value: DEFAULT2 }, set: { value: US, action: 'updated', sys_id: '1'.repeat(32) }, restore: { action: 'updated' }, after: { exists: true, sys_id: '1'.repeat(32), value: DEFAULT2 }, restored: true },
      { name: 'apps.current_app', before: { exists: true, sys_id: '2'.repeat(32), value: SCOPE }, set: { value: 'global', action: 'updated', sys_id: '2'.repeat(32) }, restore: { action: 'updated' }, after: { exists: true, sys_id: '2'.repeat(32), value: SCOPE }, restored: true },
    ]);
    expect(r.activationPreferences!.restored).toBe(true);
  });

  it('a preference that already points at the target is kept, and kept again on restore', async () => {
    const u = 'u'.repeat(32);
    const { client, state } = fake({ tables: { ...baseTables(), sys_user_preference: [{ sys_id: '1'.repeat(32), user: u, name: 'sys_update_set', value: US, type: 'string' }] }, onRequest: activationViaPreference() });
    const r = await loadPlan(client, samplePlan(), opts({ activate: true }));
    expect(r.activationPreferences!.entries[0]).toMatchObject({ set: { action: 'kept' }, restore: { action: 'kept' }, restored: true });
    expect(state.calls.some(c => c.method === 'updateRecord' && c.table === 'sys_user_preference')).toBe(false);
    expect(preferenceOf(state, 'mcp.user', 'sys_update_set')).toBe(US);
  });

  it('safety net: an activation that still lands in ANOTHER set — the user\'s NEW rows are moved into the target set and the superseded load row is deleted there (target only)', async () => {
    const { client, state } = fake({ onRequest: activationViaPreference({ ignorePreference: OTHER, docs: true }) });
    const r = await loadPlan(client, samplePlan(), opts({ activate: true }));
    const loadRow = r.captureRow.after!;
    const ac = r.activationCapture!;
    expect(ac.moved.map(m => m.name).sort()).toEqual([DOC_XML('current'), DOC_XML('table_name'), FLOW_XML()].sort());
    expect(ac.moved.every(m => m.from_update_set === OTHER && m.to_update_set === US)).toBe(true);
    const movedParent = ac.moved.find(m => m.name === FLOW_XML())!;
    expect(ac.duplicatesRemoved).toEqual([{ name: FLOW_XML(), kept: movedParent.sys_id, deleted: loadRow.sys_id, deleted_updated_on: loadRow.sys_updated_on, ok: true }]);
    expect(ac).toMatchObject({ ok: true, parentChanged: true, activeInPayload: true, leaks: [] });
    // every move is a PATCH of update_set; the only sys_update_xml delete is the superseded row in the TARGET set
    expect(state.calls.filter(c => c.method === 'updateRecord' && c.table === 'sys_update_xml').map(c => c.data)).toEqual([{ update_set: US }, { update_set: US }, { update_set: US }]);
    expect(state.calls.filter(c => c.method === 'deleteRecord' && c.table === 'sys_update_xml').map(c => c.sysId)).toEqual([loadRow.sys_id]);
    const xml = [...state.tables.get('sys_update_xml')!.values()];
    expect(xml.filter(x => x.update_set === OTHER)).toEqual([]);
    expect(xml.filter(x => x.name === FLOW_XML())).toHaveLength(1);
    expect(r.warnings.join('\n')).toMatch(/moved into the target set/);
    expect(r.summary).toContain('3 row(s) moved into the target set');
  });

  it('a NEW row in another set created by ANOTHER user is never moved → FLOW_BUILDER_CAPTURE_NOT_VERIFIED naming it (preferences still restored)', async () => {
    const { client, state } = fake({ onRequest: activationViaPreference({ ignorePreference: OTHER, createdBy: 'colleague' }) });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    expect(e.message).toContain('OUTSIDE');
    const d = e.details as FlowLoadResult;
    expect(d.activation).toMatchObject({ attempted: true, ok: true });
    expect(d.activationCapture).toMatchObject({ ok: false, parentChanged: false, moved: [], leaks: [{ name: FLOW_XML(), update_set: OTHER, reason: 'created_by_other_user' }] });
    expect(d.activationPreferences!.restored).toBe(true);
    expect([...state.tables.get('sys_update_xml')!.values()].filter(x => x.update_set === OTHER)).toHaveLength(1); // left where it is
  });

  it('activation that lands in no update set (target row unchanged) → FLOW_BUILDER_CAPTURE_NOT_VERIFIED', async () => {
    const { client } = fake({ onRequest: activation() });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    expect(e.message).toContain('did not change during activation');
    expect((e.details as FlowLoadResult).activationCapture).toMatchObject({ ok: false, parentChanged: false, leaks: [], moved: [] });
  });

  it('a target row that changed but does not show <active>true</active> on sys_hub_flow → FLOW_BUILDER_CAPTURE_NOT_VERIFIED', async () => {
    const { client } = fake({
      onRequest: (m, p, body, st) => {
        const r = activation()!(m, p, body, st);
        const row = [...st.tables.get('sys_update_xml')!.values()].find(x => x.name === FLOW_XML() && x.update_set === US)!;
        row.sys_mod_count = String(Number(row.sys_mod_count) + 1); // re-written, payload still active=false
        return r;
      },
    });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    expect((e.details as FlowLoadResult).activationCapture).toMatchObject({ parentChanged: true, activeInPayload: false, ok: false });
  });

  it('a row that PRE-EXISTED in someone else\'s set and that activation re-writes is never moved (leak, pre_existing); one it leaves alone is not a leak', async () => {
    const preexisting = { sys_id: '7'.repeat(32), name: FLOW_XML(), update_set: OTHER, payload: '<record_update/>', sys_mod_count: '0', sys_updated_on: '2026-09-01 09:00:00', sys_created_by: 'mcp.user' };
    const leaking = fake({ tables: { ...baseTables(), sys_update_xml: [preexisting] }, onRequest: (m, p, body, st) => { const r = activation(US)!(m, p, body, st); captureActivation(st, (body as { flows: { sys_id: string }[] }).flows[0].sys_id, OTHER, { createdBy: 'mcp.user' }); return r; } });
    const e = await errOf(loadPlan(leaking.client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    const d = e.details as FlowLoadResult;
    expect(d.activationCapture!.leaks).toEqual([{ sys_id: preexisting.sys_id, name: FLOW_XML(), update_set: OTHER, reason: 'pre_existing' }]);
    expect(d.activationCapture!.moved).toEqual([]);
    expect(leaking.state.tables.get('sys_update_xml')!.get(preexisting.sys_id)!.update_set).toBe(OTHER); // never moved

    const quiet = fake({ tables: { ...baseTables(), sys_update_xml: [preexisting] }, onRequest: activation(US) });
    const r = await loadPlan(quiet.client, samplePlan(), opts({ activate: true }));
    expect(r.activationCapture).toMatchObject({ ok: true, leaks: [], moved: [] });
  });

  it('a snapshot row captured in another set during activation: moved when the user created it, a leak when someone else did', async () => {
    const snap = '5'.repeat(32);
    const withSnapshot = (createdBy: string): FakeOptions['onRequest'] => (m, p, body, st) => {
      const r = activation(US)!(m, p, body, st);
      st.tables.get('sys_update_xml')!.set('8'.repeat(32), { sys_id: '8'.repeat(32), name: `sys_hub_flow_snapshot_${snap}`, update_set: OTHER, sys_mod_count: '0', sys_created_on: stamp(st.seq), sys_updated_on: stamp(st.seq++), sys_created_by: createdBy });
      return r;
    };
    const mine = fake({ onRequest: withSnapshot('mcp.user') });
    const r = await loadPlan(mine.client, samplePlan(), opts({ activate: true }));
    expect(r.activationCapture).toMatchObject({ ok: true, leaks: [], moved: [{ sys_id: '8'.repeat(32), name: `sys_hub_flow_snapshot_${snap}`, from_update_set: OTHER, to_update_set: US }] });
    expect(mine.state.tables.get('sys_update_xml')!.get('8'.repeat(32))!.update_set).toBe(US);

    const foreign = fake({ onRequest: withSnapshot('') });
    const e = await errOf(loadPlan(foreign.client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    expect((e.details as FlowLoadResult).activationCapture!.leaks).toEqual([{ sys_id: '8'.repeat(32), name: `sys_hub_flow_snapshot_${snap}`, update_set: OTHER, reason: 'created_by_other_user' }]);
  });

  it('a move the instance refuses is an unmovable leak (move_failed) → FLOW_BUILDER_CAPTURE_NOT_VERIFIED', async () => {
    const { client, fns } = fake({ onRequest: activationViaPreference({ ignorePreference: OTHER }) });
    const orig = fns.updateRecord.getMockImplementation()!;
    fns.updateRecord.mockImplementation(async (t: string, id: string, data: Record<string, unknown>) => {
      if (t === 'sys_update_xml') throw new ServiceNowError('ACL refused', 'FORBIDDEN', { status: 403 });
      return orig(t, id, data);
    });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    expect((e.details as FlowLoadResult).activationCapture!.leaks).toMatchObject([{ name: FLOW_XML(), update_set: OTHER, reason: 'move_failed', message: 'ACL refused' }]);
  });

  // ─── review findings (fix-before-prod): destructive dedup before verification; movable pre-existing rows ───

  /** activate_flows lands in OTHER (moved back by the safety net), then `mutate` edits the activation row's payload there. */
  const activationThenEdit = (mutate: (payload: string) => string): FakeOptions['onRequest'] => (m, p, body, st) => {
    const r = activationViaPreference({ ignorePreference: OTHER })!(m, p, body, st);
    const row = [...st.tables.get('sys_update_xml')!.values()].find(x => x.name === FLOW_XML() && x.update_set === OTHER)!;
    row.payload = mutate(row.payload);
    return r;
  };

  it('the moved activation row LACKS a planned child → the superseded (complete) load row is NOT deleted; both stay; FLOW_BUILDER_CAPTURE_NOT_VERIFIED', async () => {
    const child = plannedRows(samplePlan()).find(x => x.table === 'sys_hub_action_instance_v2')!.sys_id;
    const { client, state } = fake({ onRequest: activationThenEdit(p => p.split(`<sys_id>${child}</sys_id>`).join('')) });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    const d = e.details as FlowLoadResult;
    const loadRow = d.captureRow.after!;
    const movedParent = d.activationCapture!.moved.find(m => m.name === FLOW_XML())!;
    expect(movedParent).toBeDefined();
    // nothing deleted from sys_update_xml at all — the only complete capture survives
    expect(state.calls.filter(c => c.method === 'deleteRecord' && c.table === 'sys_update_xml')).toEqual([]);
    const rowsInTarget = [...state.tables.get('sys_update_xml')!.values()].filter(x => x.name === FLOW_XML() && x.update_set === US);
    expect(rowsInTarget.map(x => x.sys_id).sort()).toEqual([loadRow.sys_id, movedParent.sys_id].sort());
    expect(d.activationCapture).toMatchObject({
      ok: false, duplicatesRemoved: [],
      duplicatesRefused: [{ name: FLOW_XML(), kept: movedParent.sys_id, superseded: [loadRow.sys_id], missing: [child], activeInPayload: true }],
    });
    expect(e.message).toContain('fails the capture check');
    expect(d.activationPreferences!.restored).toBe(true);
  });

  it('the moved activation row does not show <active>true</active> while the read-back says active → nothing deleted; FLOW_BUILDER_CAPTURE_NOT_VERIFIED', async () => {
    const { client, state } = fake({ onRequest: activationThenEdit(p => p.replace(/(<sys_hub_flow(?:\s[^>]*)?>[\s\S]*?)<active>true<\/active>/, '$1<active>false</active>')) });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    const d = e.details as FlowLoadResult;
    expect(d.activation.ok).toBe(true);
    expect(d.activationCapture!.duplicatesRefused).toMatchObject([{ name: FLOW_XML(), missing: [], activeInPayload: false }]);
    expect(d.activationCapture!.duplicatesRemoved).toEqual([]);
    expect(state.calls.filter(c => c.method === 'deleteRecord' && c.table === 'sys_update_xml')).toEqual([]);
  });

  it('a FULL safety-net page before activation (possible truncation) refuses the activation before any preference write or activate_flows', async () => {
    const flow = SAMPLE_IDS().flow;
    const old: Row[] = Array.from({ length: 200 }, (_, i) => ({
      sys_id: (i.toString(16).padStart(4, '0') + '6'.repeat(28)), name: `var__m_sys_hub_flow_input_${flow}_old${i}`, update_set: OTHER,
      sys_mod_count: '0', sys_created_on: '2026-09-01 09:00:00', sys_updated_on: '2026-09-01 09:00:00', sys_created_by: 'mcp.user',
    }));
    const { client, state } = fake({ tables: { ...baseTables(), sys_update_xml: old }, onRequest: activationViaPreference({ ignorePreference: OTHER }) });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    expect(e.message).toContain('activation was NOT attempted');
    expect(state.calls.some(c => c.method === 'requestJson')).toBe(false);
    expect(touchesPreferences(state.calls.filter(c => c.method !== 'queryRecords'))).toBe(false);
    expect(state.calls.some(c => c.table === 'sys_user_preference')).toBe(false);
    expect(state.calls.filter(c => c.table === 'sys_update_xml' && c.method !== 'queryRecords')).toEqual([]);
    const d = e.details as FlowLoadResult;
    expect(d.activation).toMatchObject({ requested: true, attempted: false, ok: false });
    expect(d.activationCapture).toMatchObject({ ok: false, moved: [], truncated: [`nameSTARTSWITHvar__m_sys_hub_flow_input_${flow}`] });
  });

  it('a FULL safety-net page after activation moves NOTHING (not even the user\'s own new parent row) → FLOW_BUILDER_CAPTURE_NOT_VERIFIED', async () => {
    const flow = SAMPLE_IDS().flow;
    const { client, state } = fake({
      onRequest: (m, p, body, st) => {
        const r = activationViaPreference({ ignorePreference: OTHER })!(m, p, body, st);
        const xml = st.tables.get('sys_update_xml')!;
        for (let i = 0; i < 200; i++) {
          const id = i.toString(16).padStart(4, '0') + '7'.repeat(28);
          xml.set(id, { sys_id: id, name: `var__m_sys_hub_flow_output_${flow}_n${i}`, update_set: OTHER, sys_mod_count: '0', sys_created_on: stamp(st.seq), sys_updated_on: stamp(st.seq), sys_created_by: 'mcp.user' });
        }
        st.seq++;
        return r;
      },
    });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    const d = e.details as FlowLoadResult;
    expect(d.activationCapture).toMatchObject({ ok: false, moved: [], truncated: [`nameSTARTSWITHvar__m_sys_hub_flow_output_${flow}`] });
    expect(state.calls.filter(c => c.method === 'updateRecord' && c.table === 'sys_update_xml')).toEqual([]);
    expect([...state.tables.get('sys_update_xml')!.values()].find(x => x.name === FLOW_XML() && x.update_set === OTHER)).toBeDefined();
    expect(e.message).toContain('NOTHING was moved');
    expect(d.activationPreferences!.restored).toBe(true);
  });

  it('an OLD row by the same user that is absent from the before-snapshot (e.g. hidden by paging) is never moved: created_before_activation', async () => {
    const oldRow = { sys_id: '6'.repeat(32), name: DOC_XML('current'), update_set: OTHER, payload: '<record_update/>', sys_mod_count: '0', sys_created_on: '2026-09-01 09:00:00', sys_updated_on: '2026-09-01 09:00:00', sys_created_by: 'mcp.user' };
    const { client, state } = fake({
      onRequest: (m, p, body, st) => {
        const r = activation(US)!(m, p, body, st);
        st.tables.get('sys_update_xml')!.set(oldRow.sys_id, { ...oldRow }); // visible only in the after-snapshot
        return r;
      },
    });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    const d = e.details as FlowLoadResult;
    expect(d.activationCapture!.watermark).toBe(d.captureRow.after!.sys_updated_on);
    expect(d.activationCapture!.leaks).toMatchObject([{ sys_id: oldRow.sys_id, update_set: OTHER, reason: 'created_before_activation' }]);
    expect(d.activationCapture!.moved).toEqual([]);
    expect(state.tables.get('sys_update_xml')!.get(oldRow.sys_id)!.update_set).toBe(OTHER);
  });

  it('the watermark is raised to the instance time of the preference write: a row created before it is not movable', async () => {
    const { client, fns } = fake({ onRequest: activationViaPreference({ ignorePreference: OTHER }) });
    const orig = fns.createRecord.getMockImplementation()!;
    fns.createRecord.mockImplementation(async (t: string, data: Record<string, unknown>) => {
      const row = await orig(t, data);
      return t === 'sys_user_preference' ? { ...row, sys_updated_on: '2026-09-24 23:59:00' } : row;
    });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ activate: true })));
    expect(e.code).toBe('FLOW_BUILDER_CAPTURE_NOT_VERIFIED');
    const d = e.details as FlowLoadResult;
    expect(d.activationCapture!.watermark).toBe('2026-09-24 23:59:00');
    expect(d.activationCapture!.leaks).toMatchObject([{ name: FLOW_XML(), reason: 'created_before_activation' }]);
    expect(d.activationCapture!.moved).toEqual([]);
  });
});

describe('loadPlan — platform-managed trigger inputs of a record-triggered flow (PDI finding 2)', () => {
  const MANAGED = { current: '3'.repeat(32), table_name: '4'.repeat(32), docCurrent: 'd3'.repeat(16), docTable: 'd4'.repeat(16) };

  /** What the platform creates for a record-triggered flow: sys_hub_flow_input current / table_name + sys_documentation (random ids). */
  function addPlatformInputs(st: FakeState, flowId = SAMPLE_IDS().flow): void {
    const t = (n: string) => { if (!st.tables.has(n)) st.tables.set(n, new Map()); return st.tables.get(n)!; };
    const name = `var__m_sys_hub_flow_input_${flowId}`;
    const attrs = 'element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper';
    t('sys_hub_flow_input').set(MANAGED.current, { sys_id: MANAGED.current, model: flowId, model_id: flowId, model_table: 'sys_hub_flow', name, element: 'current', internal_type: 'document_id', label: 'Record', mandatory: 'true', use_dependent_field: 'true', dependent_on_field: 'table_name', order: '100', attributes: `${attrs},uiType=document_id` });
    t('sys_hub_flow_input').set(MANAGED.table_name, { sys_id: MANAGED.table_name, model: flowId, model_id: flowId, model_table: 'sys_hub_flow', name, element: 'table_name', internal_type: 'table_name', label: 'Table Name', order: '101', max_length: '200', attributes: `${attrs},test_input_hidden=true,uiType=table_name` });
    t('sys_documentation').set(MANAGED.docCurrent, { sys_id: MANAGED.docCurrent, name, element: 'current', label: 'Record', language: 'en' });
    t('sys_documentation').set(MANAGED.docTable, { sys_id: MANAGED.docTable, name, element: 'table_name', label: 'Table Name', language: 'en' });
  }
  const managedReport = (fateInput: string, fateDoc = fateInput) => [
    { table: 'sys_hub_flow_input', sys_id: MANAGED.current, element: 'current', classification: 'platform_managed', fate: fateInput },
    { table: 'sys_hub_flow_input', sys_id: MANAGED.table_name, element: 'table_name', classification: 'platform_managed', fate: fateInput },
    { table: 'sys_documentation', sys_id: MANAGED.docCurrent, element: 'current', classification: 'platform_managed', fate: fateDoc },
    { table: 'sys_documentation', sys_id: MANAGED.docTable, element: 'table_name', classification: 'platform_managed', fate: fateDoc },
  ];
  /** The sample plan with a scheduled (non-record) trigger. */
  const dailyPlan = () => { const p = samplePlan(); return { ...p, trigger: { ...p.trigger!, fields: { ...p.trigger!.fields, name: 'Daily', trigger_type: 'daily', trigger_definition: '89142dc0c32222002841b63b12d3ae8a' } } }; };

  it('isRecordTriggeredFlow: Created / Updated / Created or Updated flows only', () => {
    expect(isRecordTriggeredFlow(samplePlan())).toBe(true);
    for (const tt of ['record_update', 'record_create_or_update']) {
      const p = samplePlan();
      expect(isRecordTriggeredFlow({ ...p, trigger: { ...p.trigger!, fields: { ...p.trigger!.fields, trigger_type: tt } } })).toBe(true);
    }
    expect(isRecordTriggeredFlow(dailyPlan())).toBe(false);
    const p = samplePlan();
    expect(isRecordTriggeredFlow({ ...p, trigger: undefined })).toBe(false);
    expect(isRecordTriggeredFlow({ ...p, flow: { ...p.flow, fields: { ...p.flow.fields, type: 'subflow' } } })).toBe(false);
  });

  it('PDI reproduction: a second load of the same flow is NOT blocked (no FLOW_BUILDER_LOADER_WOULD_DELETE); no sys_hub_flow_input delete_multiple; the rows are kept and reported platform_managed', async () => {
    const st = await loadedOnce();
    addPlatformInputs(st); // created by the platform on activation
    const { client, state, table } = makeFakeClient({ username: 'mcp.user', tables: tablesOf(st) });
    const r = await loadPlan(client, samplePlan(), opts({ mode: 'update' }));
    const [load] = state.calls.filter(c => c.method === 'postMultipart');
    expect(load.files![0].content).not.toContain('<sys_hub_flow_input action="delete_multiple"');
    expect(r.loader.deleteMultiple.some(d => d.table === 'sys_hub_flow_input')).toBe(false);
    expect(r.cleanedTables).toEqual([]);
    expect(r.platformManaged).toEqual(managedReport('kept'));
    expect(r.existedBefore).toEqual(expect.arrayContaining([{ table: 'sys_hub_flow_input', sys_id: MANAGED.current }, { table: 'sys_documentation', sys_id: MANAGED.docTable }]));
    expect(r.stale).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(table('sys_hub_flow_input').size).toBe(2);
    expect(table('sys_documentation').has(MANAGED.docCurrent)).toBe(true);
    expect(r.warnings.some(w => /STALE/.test(w))).toBe(false);
    expect(r.warnings.some(w => w.includes('platform-managed'))).toBe(true);
    expect(r.summary).toContain('4 platform-managed');
  });

  it('the same rows on a NON-record-triggered flow are ordinary stale rows (still confirmation-gated)', async () => {
    const { client, state } = fake();
    await loadPlan(client, dailyPlan(), opts());
    addPlatformInputs(state);
    state.calls.length = 0;
    const e = await errOf(loadPlan(client, dailyPlan(), opts({ mode: 'update' })));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_WOULD_DELETE');
    expect(e.details).toMatchObject({ cleanedTables: ['sys_hub_flow_input'], unconfirmed: [{ table: 'sys_hub_flow_input', sys_id: MANAGED.current }, { table: 'sys_hub_flow_input', sys_id: MANAGED.table_name }], platformManaged: [] });
    expect(writesOf(state.calls)).toEqual([]);
  });

  it('another stale input row still needs confirming; the platform-managed rows the cleanup also removes are reported deleted_by_load, never gated', async () => {
    const extra = '9a'.repeat(16);
    const st = await loadedOnce();
    addPlatformInputs(st);
    st.tables.get('sys_hub_flow_input')!.set(extra, { sys_id: extra, model: SAMPLE_IDS().flow, element: 'u_extra', name: `var__m_sys_hub_flow_input_${SAMPLE_IDS().flow}` });
    const { client, table } = makeFakeClient({ username: 'mcp.user', tables: tablesOf(st) });
    const e = await errOf(loadPlan(client, samplePlan(), opts({ mode: 'update' })));
    expect(e.code).toBe('FLOW_BUILDER_LOADER_WOULD_DELETE');
    expect(e.details).toMatchObject({ unconfirmed: [{ table: 'sys_hub_flow_input', sys_id: extra }], cleanedTables: ['sys_hub_flow_input'] });
    expect((e.details as { platformManaged: unknown[] }).platformManaged).toHaveLength(4);

    const r = await loadPlan(client, samplePlan(), opts({ mode: 'update', deleteStale: true, confirmDelete: [extra] }));
    expect(r.deleted).toEqual([{ table: 'sys_hub_flow_input', sys_id: extra }]);
    expect(r.platformManaged).toEqual(managedReport('deleted_by_load', 'kept'));
    expect(r.stale).toEqual([]);
    expect(table('sys_hub_flow_input').size).toBe(0);
  });

  it('platform-managed rows that appear DURING the load are reported created_by_load, not FLOW_BUILDER_LOADER_STALE_ROWS', async () => {
    const base = customLoader();
    const creating: FakeOptions['loader'] = (path, files, params, s) => { const res = base!(path, files, params, s); addPlatformInputs(s); return res; };
    const { client } = fake({ loader: creating });
    const r = await loadPlan(client, samplePlan(), opts());
    expect(r.platformManaged).toEqual(managedReport('created_by_load'));
    expect(r.stale).toEqual([]);
  });
});

describe('planToRecordUpdateXml options (loader)', () => {
  it('no options = the plain document (construct snapshots); the global scope option changes nothing', () => {
    const plan = samplePlan();
    expect(planToRecordUpdateXml(plan, { scope: { sys_id: 'global', scope: 'global' } })).toBe(planToRecordUpdateXml(plan));
    expect(planToRecordUpdateXml(plan, { cleanTables: [] })).toBe(planToRecordUpdateXml(plan));
  });

  it('scope option writes <sys_scope display_value="<name>"><sys_id>; a row with an empty sys_scope keeps display_value=""', () => {
    const plan = samplePlan({ scope: SCOPE });
    const xml = planToRecordUpdateXml(plan, { scope: { sys_id: SCOPE, scope: 'x_example_app' } });
    expect(xml).toContain(`<sys_scope display_value="x_example_app">${SCOPE}</sys_scope>`);
    expect(xml).not.toContain(`display_value="${SCOPE}"`);
    expect(xml).toContain('<sys_scope display_value=""/>'); // trigger / stage rows carry sys_scope ''
  });

  it('cleanTables emits delete_multiple flow=/model=<id> for EMPTY tables only, and refuses a non-child table', () => {
    const ids = SAMPLE_IDS();
    const p = samplePlan();
    const plan = { ...p, variables: [], documentation: [], instances: p.instances.filter(i => i.table !== 'sys_hub_flow_logic_instance_v2') };
    const xml = planToRecordUpdateXml(plan, { cleanTables: ['sys_hub_flow_variable', 'sys_hub_flow_logic_instance_v2', 'sys_hub_action_instance_v2'] });
    expect(xml).toContain(`<sys_hub_flow_variable action="delete_multiple" query="model=${ids.flow}"/>`);
    expect(xml).toContain(`<sys_hub_flow_logic_instance_v2 action="delete_multiple" query="flow=${ids.flow}"/>`);
    // a populated table keeps its normal NOT IN cleanup (cleanTables does not widen it)
    expect(xml).toContain(`<sys_hub_action_instance_v2 action="delete_multiple" query="flow=${ids.flow}^sys_idNOT IN${ids.logStep}"/>`);
    expect(xml).not.toContain(`<sys_hub_action_instance_v2 action="delete_multiple" query="flow=${ids.flow}"/>`);
    expect(() => planToRecordUpdateXml(plan, { cleanTables: ['sys_user'] })).toThrow(/not a flow child table/);
  });
});

describe('describeLoadProtocol', () => {
  it('names the loader endpoint, the part, targetUpdateSetId, the verification and the absence of preference writes', () => {
    const steps = describeLoadProtocol(samplePlan(), { name: 'TEST_X' }).join('\n');
    expect(steps).toContain('name="TEST_X"');
    expect(steps).toContain(`${LOADER_LOAD_PATH}/<scopeId>?targetUpdateSetId=`);
    expect(steps).toContain('"files"');
    expect(steps).toContain('No sys_user_preference is read or written');
    expect(steps).toContain('version = "2"');
    expect(steps).toContain('sys_update_xml');
    expect(steps).toContain('FLOW_BUILDER_LOADER_WOULD_DELETE');
    expect(steps).toContain('activate_flows');
  });
});

describe('loadPlan — planned column that does not exist on the instance (PDI 2026-09-24: `active` on sys_hub_action_instance_v2)', () => {
  it('update mode: a column the instance does not store is a warning, not FLOW_BUILDER_LOADER_READBACK_MISMATCH', async () => {
    const st = await loadedOnce();
    const plan = samplePlan();
    const action = plannedRows(plan).find(r => r.table === 'sys_hub_action_instance_v2')!;
    const column = Object.keys(action.fields).find(f => f !== 'sys_id' && f !== 'flow')!;
    const base = customLoader();
    // The instance ignores this column: strip it from every stored action-instance row after the load.
    const dropping: FakeOptions['loader'] = (path, files, params, s) => {
      const res = base!(path, files, params, s);
      for (const row of s.tables.get('sys_hub_action_instance_v2')?.values() ?? []) delete row[column];
      return res;
    };
    const { client } = makeFakeClient({ username: 'mcp.user', tables: tablesOf(st), loader: dropping });
    for (const row of [...(tablesOf(st).sys_hub_action_instance_v2 ?? [])]) delete (row as Row)[column];
    const r = await loadPlan(client, plan, opts({ mode: 'update' })) as FlowLoadResult;
    expect(r.fieldDiffs).toEqual([]);
    expect(r.warnings.join('\n')).toContain(`sys_hub_action_instance_v2.${column}`);
  });

  it('a real value mismatch on an existing column is still FLOW_BUILDER_LOADER_READBACK_MISMATCH', async () => {
    const st = await loadedOnce();
    const plan = samplePlan();
    const base = customLoader();
    const tampering: FakeOptions['loader'] = (path, files, params, s) => {
      const res = base!(path, files, params, s);
      const flow = s.tables.get('sys_hub_flow')!.get(SAMPLE_IDS().flow)!;
      flow.description = 'changed on the instance';
      return res;
    };
    const { client } = makeFakeClient({ username: 'mcp.user', tables: tablesOf(st), loader: tampering });
    expect((await errOf(loadPlan(client, plan, opts({ mode: 'update' })))).code).toBe('FLOW_BUILDER_LOADER_READBACK_MISMATCH');
  });
});
