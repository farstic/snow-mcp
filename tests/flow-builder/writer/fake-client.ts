/**
 * In-memory fake ServiceNowClient for writer / tool tests.
 *
 * Tables are plain maps (table → sys_id → fields, every value a string). A tiny encoded-query
 * interpreter supports `a=b`, `a!=b`, `aINx,y`, `aNOT INx,y`, `aSTARTSWITHx`, `^` (AND) and `^OR`
 * groups, plus `ORDERBY*` (ignored). Every method is a vi.fn and every call is appended to
 * `calls` in order so tests can assert the §2.2 sequence.
 *
 * Capture simulation: when `capture` is 'parent' (the PDI form), every write to a flow-family table
 * upserts ONE sys_update_xml row `sys_hub_flow_<flow>` whose payload lists `<sys_id>…</sys_id>` of
 * every child written so far, in the update set named by the writing user's `sys_update_set`
 * preference at write time (or 'DEFAULT' when unset — the leak). 'per_row' writes one row per record;
 * 'none' writes nothing.
 */
import { vi } from 'vitest';
import { ServiceNowError } from '../../../src/utils/errors.js';
import type { ServiceNowClient } from '../../../src/servicenow/client.js';

export type Row = Record<string, string>;
export interface MultipartFile { field: string; filename: string; content: string; contentType: string }
export interface MultipartResponse { status: number; ok: boolean; statusText: string; json?: unknown; text?: string }
export interface Call {
  method: string; table?: string; query?: string; sysId?: string; data?: Record<string, unknown>; path?: string; body?: unknown;
  /** postMultipart only: the query parameters and the parts. */
  params?: Record<string, string>; files?: MultipartFile[]; timeoutMs?: number;
}

/**
 * Loader simulation for postMultipart:
 *   'apply'      (default) parse the <record_update>, apply delete_multiple + INSERT_OR_UPDATE rows, capture ONE
 *                sys_update_xml sys_hub_flow_<id> (payload = the document) in params.targetUpdateSetId, answer 200.
 *   'version1'   like 'apply' but sys_hub_flow.version stays '1' (what the Table API does).
 *   'no_capture' like 'apply' but writes no sys_update_xml row.
 *   'noop'       200 naming the target set, but applies and captures NOTHING (a load that did nothing).
 *   'absent'     404 "Requested URI does not represent any resource".
 *   a function:  full control.
 */
export type LoaderBehaviour = 'apply' | 'version1' | 'no_capture' | 'noop' | 'absent'
  | ((path: string, files: MultipartFile[], params: Record<string, string>, state: FakeState) => MultipartResponse | Promise<MultipartResponse>);

export interface FakeOptions {
  username?: string;
  tables?: Record<string, Row[]>;
  capture?: 'parent' | 'per_row' | 'none';
  /** Simulate a platform that ignores the client-supplied sys_id on POST. */
  honourSysId?: boolean;
  /** Called for requestJson; throw a ServiceNowError to simulate a non-2xx. */
  onRequest?: (method: string, path: string, body: unknown, state: FakeState) => unknown;
  /** Hook after a row is stored (e.g. to flip active=true on activation). */
  onWrite?: (table: string, row: Row, state: FakeState) => void;
  /** postMultipart (ServiceNow IDE loader) behaviour; default 'apply'. */
  loader?: LoaderBehaviour;
}

function unescapeXml(s: string): string {
  return s.replace(/&#13;/g, '\r').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

type RecordUpdateElement = { kind: 'delete'; table: string; query: string } | { kind: 'row'; table: string; fields: Row };

/** The rows and delete_multiple elements of a <record_update> document, in document order. */
export function parseRecordUpdate(xml: string): RecordUpdateElement[] {
  const out: RecordUpdateElement[] = [];
  const re = /<([A-Za-z0-9_]+) action="delete_multiple" query="([^"]*)"\/>|<([A-Za-z0-9_]+) action="INSERT_OR_UPDATE"[^>]*>([\s\S]*?)<\/\3>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1]) { out.push({ kind: 'delete', table: m[1], query: unescapeXml(m[2]) }); continue; }
    const fields: Row = {};
    const fr = /<([A-Za-z0-9_]+)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
    let f: RegExpExecArray | null;
    while ((f = fr.exec(m[4]))) fields[f[1]] = unescapeXml(f[2] ?? '');
    out.push({ kind: 'row', table: m[3], fields });
  }
  return out;
}

export interface FakeState {
  tables: Map<string, Map<string, Row>>;
  calls: Call[];
  seq: number;
}

const FLOW_FAMILY = new Set([
  'sys_hub_flow', 'sys_hub_flow_variable', 'sys_hub_flow_input', 'sys_hub_flow_output', 'sys_documentation', 'sys_hub_flow_stage',
  'sys_hub_trigger_instance_v2', 'sys_hub_action_instance_v2', 'sys_hub_sub_flow_instance_v2', 'sys_hub_flow_logic_instance_v2',
]);

/** A distinct sys_updated_on per call (seconds after 10:00:00). */
export function stamp(n: number): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `2026-09-24 ${p(10 + Math.floor(n / 3600) % 14)}:${p(Math.floor(n / 60) % 60)}:${p(n % 60)}`;
}

function randomSysId(seq: number): string {
  return (seq.toString(16).padStart(8, '0') + 'f'.repeat(24)).slice(0, 32);
}

function matchTerm(row: Row, term: string): boolean {
  if (term.startsWith('ORDERBY')) return true;
  let m: RegExpExecArray | null;
  if ((m = /^([a-z0-9_.]+)NOT IN(.*)$/.exec(term))) return !m[2].split(',').includes(row[m[1]] ?? '');
  if ((m = /^([a-z0-9_.]+)IN(.*)$/.exec(term))) return m[2].split(',').includes(row[m[1]] ?? '');
  if ((m = /^([a-z0-9_.]+)STARTSWITH(.*)$/.exec(term))) return (row[m[1]] ?? '').startsWith(m[2]);
  if ((m = /^([a-z0-9_.]+)!=(.*)$/.exec(term))) return (row[m[1]] ?? '') !== m[2];
  if ((m = /^([a-z0-9_.]+)=(.*)$/.exec(term))) return (row[m[1]] ?? '') === m[2];
  throw new Error(`fake client: unsupported query term ${JSON.stringify(term)}`);
}

export function matchesQuery(row: Row, query: string): boolean {
  if (!query) return true;
  const groups = query.split('^OR');
  return groups.some(g => g.split('^').filter(Boolean).every(t => matchTerm(row, t)));
}

export function makeFakeClient(opts: FakeOptions = {}) {
  const state: FakeState = { tables: new Map(), calls: [], seq: 1 };
  const capture = opts.capture ?? 'parent';
  const honour = opts.honourSysId ?? true;
  for (const [t, rows] of Object.entries(opts.tables ?? {})) {
    const map = new Map<string, Row>();
    for (const r of rows) map.set(r.sys_id, { ...r });
    state.tables.set(t, map);
  }
  const table = (t: string) => { if (!state.tables.has(t)) state.tables.set(t, new Map()); return state.tables.get(t)!; };

  function currentUpdateSetFor(): string {
    const user = [...table('sys_user').values()].find(u => u.user_name === opts.username);
    const pref = user ? [...table('sys_user_preference').values()].find(p => p.user === user.sys_id && p.name === 'sys_update_set') : undefined;
    return pref?.value ?? 'DEFAULT';
  }

  function flowIdOf(t: string, row: Row): string | undefined {
    if (t === 'sys_hub_flow') return row.sys_id;
    if (row.flow) return row.flow;
    if (row.model) return row.model;
    if (t === 'sys_documentation') { const m = /_([0-9a-f]{32})$/.exec(row.name ?? ''); return m?.[1]; }
    return undefined;
  }

  function recordCapture(t: string, row: Row): void {
    if (capture === 'none' || t === 'sys_user_preference' || t === 'sys_update_xml') return;
    const us = currentUpdateSetFor();
    const xml = table('sys_update_xml');
    // Tables outside the flow family (e.g. sys_complex_object) are captured as their own row in every mode.
    if (capture === 'per_row' || !FLOW_FAMILY.has(t)) {
      const name = `${t}_${row.sys_id}`;
      const existing = [...xml.values()].find(x => x.name === name && x.update_set === us);
      const id = existing?.sys_id ?? randomSysId(state.seq++);
      xml.set(id, { sys_id: id, name, type: t === 'sys_hub_flow' ? 'Flow' : t, table: t, update_set: us, payload: `<record_update><${t}><sys_id>${row.sys_id}</sys_id></${t}></record_update>`, sys_updated_on: '2026-09-24 10:00:00' });
      return;
    }
    const flowId = flowIdOf(t, row);
    if (!flowId) return;
    const name = `sys_hub_flow_${flowId}`;
    const children: string[] = [];
    for (const ft of FLOW_FAMILY) for (const r of table(ft).values()) if (flowIdOf(ft, r) === flowId) children.push(r.sys_id);
    const existing = [...xml.values()].find(x => x.name === name && x.update_set === us);
    const id = existing?.sys_id ?? randomSysId(state.seq++);
    xml.set(id, {
      sys_id: id, name, type: 'Flow', table: '', update_set: us, target_name: table('sys_hub_flow').get(flowId)?.name ?? '',
      payload: `<?xml version="1.0" encoding="UTF-8"?><record_update sys_domain="global" table="sys_hub_flow">${children.map(c => `<sys_id>${c}</sys_id>`).join('')}</record_update>`,
      payload_hash: String(children.length), update_guid: randomSysId(state.seq++), sys_updated_on: '2026-09-24 10:00:00',
    });
  }

  const project = (row: Row, fields?: string): Row => {
    if (!fields) return { ...row };
    const out: Row = {};
    for (const f of fields.split(',').map(s => s.trim()).filter(Boolean)) if (f in row) out[f] = row[f];
    if (!('sys_id' in out) && row.sys_id) out.sys_id = row.sys_id;
    return out;
  };

  const client = {
    getConfiguredUsername: vi.fn(() => opts.username),
    queryRecords: vi.fn(async (p: { table: string; query?: string; fields?: string; limit?: number; orderBy?: string }) => {
      state.calls.push({ method: 'queryRecords', table: p.table, query: p.query ?? '' });
      const rows = [...table(p.table).values()].filter(r => matchesQuery(r, p.query ?? '')).slice(0, p.limit ?? 10).map(r => project(r, p.fields));
      return { count: rows.length, records: rows };
    }),
    getRecord: vi.fn(async (t: string, sysId: string, fields?: string) => {
      state.calls.push({ method: 'getRecord', table: t, sysId });
      const r = table(t).get(sysId);
      if (!r) throw new ServiceNowError(`No Record found`, 'NOT_FOUND', { status: 404 });
      return project(r, fields);
    }),
    createRecord: vi.fn(async (t: string, data: Record<string, unknown>) => {
      state.calls.push({ method: 'createRecord', table: t, data });
      const wanted = typeof data.sys_id === 'string' ? data.sys_id : undefined;
      const sysId = honour && wanted ? wanted : randomSysId(state.seq++);
      const row: Row = {};
      for (const [k, v] of Object.entries(data)) row[k] = String(v);
      row.sys_id = sysId;
      table(t).set(sysId, row);
      opts.onWrite?.(t, row, state);
      recordCapture(t, row);
      return { ...row };
    }),
    updateRecord: vi.fn(async (t: string, sysId: string, data: Record<string, unknown>) => {
      state.calls.push({ method: 'updateRecord', table: t, sysId, data });
      const row = table(t).get(sysId);
      if (!row) throw new ServiceNowError('No Record found', 'NOT_FOUND', { status: 404 });
      for (const [k, v] of Object.entries(data)) row[k] = String(v);
      opts.onWrite?.(t, row, state);
      recordCapture(t, row);
      return { ...row };
    }),
    deleteRecord: vi.fn(async (t: string, sysId: string) => {
      state.calls.push({ method: 'deleteRecord', table: t, sysId });
      if (!table(t).delete(sysId)) throw new ServiceNowError('No Record found', 'NOT_FOUND', { status: 404 });
    }),
    postMultipart: vi.fn(async (path: string, files: MultipartFile[], params: Record<string, string> = {}, timeoutMs?: number): Promise<MultipartResponse> => {
      state.calls.push({ method: 'postMultipart', path, params: { ...params }, files: files.map(f => ({ ...f })), timeoutMs });
      const behaviour = opts.loader ?? 'apply';
      if (typeof behaviour === 'function') return behaviour(path, files, params, state);
      if (behaviour === 'noop') return { status: 200, ok: true, statusText: 'OK', json: { result: { targetUpdateSetId: params.targetUpdateSetId ?? '' } } };
      if (behaviour === 'absent') return { status: 404, ok: false, statusText: 'Not Found', json: { error: { message: 'Requested URI does not represent any resource', detail: '' }, status: 'failure' } };
      const target = params.targetUpdateSetId ?? '';
      for (const file of files) {
        let flowId: string | undefined;
        for (const el of parseRecordUpdate(file.content)) {
          if (el.kind === 'delete') {
            const t = table(el.table);
            for (const [id, row] of [...t.entries()]) if (matchesQuery(row, el.query)) t.delete(id);
            continue;
          }
          const sysId = el.fields.sys_id;
          const t = table(el.table);
          const row: Row = { ...(t.get(sysId) ?? {}), ...el.fields };
          if (el.table === 'sys_hub_flow') { flowId = sysId; if (behaviour === 'version1') row.version = '1'; }
          t.set(sysId, row);
        }
        if (flowId && behaviour !== 'no_capture') {
          const xml = table('sys_update_xml');
          const name = `sys_hub_flow_${flowId}`;
          const existing = [...xml.values()].find(x => x.name === name && x.update_set === target);
          const id = existing?.sys_id ?? randomSysId(state.seq++);
          xml.set(id, {
            sys_id: id, name, type: 'Flow', table: '', update_set: target, target_name: table('sys_hub_flow').get(flowId)?.name ?? '',
            payload: file.content, payload_hash: String(file.content.length), update_guid: randomSysId(state.seq++),
            // every capture write re-serialises the row: sys_mod_count +1, a new sys_updated_on
            sys_mod_count: String(Number(existing?.sys_mod_count ?? -1) + 1), sys_updated_on: stamp(state.seq++),
          });
        }
      }
      return { status: 200, ok: true, statusText: 'OK', json: { result: { targetUpdateSetId: target } } };
    }),
    requestJson: vi.fn(async (method: string, path: string, body?: unknown) => {
      state.calls.push({ method: 'requestJson', path, body });
      if (!opts.onRequest) throw new ServiceNowError('Requested URI does not represent any resource', 'INVALID_REQUEST', { status: 400, body: '{"error":{"message":"Requested URI does not represent any resource"}}' });
      return opts.onRequest(method, path, body, state);
    }),
  };
  return { client: client as unknown as ServiceNowClient, fns: client, state, table };
}

/** Rows most writer tests start from: one user, one in-progress non-default update set, the global scope. */
export function baseTables(overrides: Partial<Record<'updateSet', Partial<Row>>> = {}): Record<string, Row[]> {
  return {
    sys_user: [{ sys_id: 'u'.repeat(32), user_name: 'mcp.user' }],
    sys_update_set: [{ sys_id: 'a'.repeat(32), name: 'TEST_FLOW_TEST_V1', state: 'in progress', is_default: 'false', application: 'global', ...(overrides.updateSet ?? {}) }],
    sys_scope: [{ sys_id: 'global', scope: 'global', name: 'Global' }, { sys_id: 'b'.repeat(32), scope: 'x_example_app', name: 'Test App' }],
  };
}

/** The `<method>:<table>` sequence, for order assertions. */
export function callSignature(calls: Call[]): string[] {
  return calls.map(c => c.method === 'requestJson' ? `requestJson:${c.path?.split('?')[0]}` : c.method === 'postMultipart' ? `postMultipart:${c.path}` : `${c.method}:${c.table}`);
}

/**
 * Simulate what activate_flows writes to sys_update_xml: the flow's parent capture row in `updateSetSysId`
 * (the set the user's preference points at — the target, or another set for a leak) is re-serialised with
 * <active>true</active> on the sys_hub_flow element; created when that set has none yet. `o.createdBy` is
 * stamped as sys_created_by / sys_updated_by (the session user of the activation) on a NEW row.
 */
export function captureActivation(state: FakeState, flowSysId: string, updateSetSysId: string, o: { createdBy?: string } = {}): void {
  if (!state.tables.has('sys_update_xml')) state.tables.set('sys_update_xml', new Map());
  const xml = state.tables.get('sys_update_xml')!;
  const name = `sys_hub_flow_${flowSysId}`;
  const existing = [...xml.values()].find(x => x.name === name && x.update_set === updateSetSysId);
  const base = existing ?? [...xml.values()].find(x => x.name === name);
  const payload = (base?.payload ?? `<record_update table="sys_hub_flow"><sys_hub_flow action="INSERT_OR_UPDATE"><active>false</active><sys_id>${flowSysId}</sys_id></sys_hub_flow></record_update>`)
    .replace(/(<sys_hub_flow(?:\s[^>]*)?>[\s\S]*?)<active>false<\/active>/, '$1<active>true</active>');
  const id = existing?.sys_id ?? randomSysId(state.seq++);
  xml.set(id, {
    ...(base ?? {}), sys_id: id, name, type: 'Flow', update_set: updateSetSysId, payload, payload_hash: String(payload.length + 1),
    sys_mod_count: String(Number(existing?.sys_mod_count ?? -1) + 1), sys_updated_on: stamp(state.seq++),
    ...(existing ? {} : { sys_created_by: o.createdBy ?? '', sys_created_on: stamp(state.seq) }),
    ...(o.createdBy ? { sys_updated_by: o.createdBy } : {}),
  });
}

/** The value of a user's sys_user_preference `name` in the fake (undefined when there is no row). */
export function preferenceOf(state: FakeState, username: string, name: string): string | undefined {
  const user = [...(state.tables.get('sys_user')?.values() ?? [])].find(u => u.user_name === username);
  return [...(state.tables.get('sys_user_preference')?.values() ?? [])].find(p => p.user === user?.sys_id && p.name === name)?.value;
}

/**
 * Instance-side rows the construct specs need when they run through the LIVE resolvers:
 * the instance time zone (glide.sys.default.tz) for a scheduled.run_once run_in, and the catalog item
 * the catalog_actions spec's Get Catalog Variables / Create Catalog Task steps use (template_catalog_item
 * 0e5b6754…) with the variables its catalog_variables lists select.
 */
export function specInstanceTables(): Record<string, Row[]> {
  const item = '0e5b6754ca2a87acbcf41d2797317f4a';
  return {
    sys_properties: [{ sys_id: 'e'.repeat(32), name: 'glide.sys.default.tz', value: 'Europe/Brussels' }],
    sc_cat_item: [{ sys_id: item, name: 'Example Workstation' }],
    item_option_new: [
      { sys_id: '4e957a421d7d5b0c5d9c2abcc41dd042', name: 'device_model', question_text: 'Device model', type: '5', reference: '', order: '100', cat_item: item, variable_set: '', active: 'true' },
      { sys_id: '6318b2e346dd3cf758acd9dbd34a8f27', name: 'business_reason', question_text: 'Business reason', type: '2', reference: '', order: '200', cat_item: item, variable_set: '', active: 'true' },
      { sys_id: '483d00f9e57f162ea9132524f0de868d', name: 'delivery_date', question_text: 'Delivery date', type: '9', reference: '', order: '300', cat_item: item, variable_set: '', active: 'true' },
    ],
  };
}

/** A fixed clock for tests that check run_in against "now" (run_in values of the specs lie after it). */
export const TEST_NOW = new Date('2026-09-24T12:00:00Z');
