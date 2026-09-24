/**
 * Writer — Table-API writer with §2.2 update-set capture, and the read-back verifier.
 *
 * TRANSPORT NOTE (PDI, 24 Sep 2026): the Table-API path below cannot produce a working flow —
 * sys_hub_flow.version is dropped by the write ACL sys_hub_flow_base.version (the flow stays
 * version 1, Flow Designer ignores the _v2 rows, the update set captures only the flow row). The
 * default transport is the instance-side loader in ./loader.ts (loadPlan); writePlan stays for
 * non-flow experiments / diagnostics (snow_flow_build transport:'table_api'). The shared checks
 * (resolveUpdateSet, resolveScope, assertUpdateSetMatchesScope, checkActiveFlow, childRowsOnInstance,
 * verifyCapture, activateFlow) are used by both transports.
 *
 * writePlan(client, plan, opts) — owner: WRITER. What it does, in order:
 *   1. Resolve the target update set by sys_id or name; REFUSE unless state='in progress'
 *      AND is_default=false (the is_default capture-leak trap). A name must match exactly one row.
 *   2. Derive the authenticated user from the session: client.getConfiguredUsername() →
 *      sys_user.user_name (exactly one row). Never from a tool argument.
 *   3. Resolve the flow's scope (names → sys_scope sys_id, rewritten on every row). REFUSE when the
 *      update set's application is not the flow's application (scoped flow: application must equal
 *      the scope sys_id; global flow: application must be global) — the capture-redirect path.
 *   4. Pre-check existence of every planned sys_id (read-only, BEFORE any preference write).
 *      mode:'create' refuses when any row already exists (use mode:'update'). mode:'update' on an
 *      existing flow reads sys_hub_flow.active/status first and REFUSES an active flow
 *      (FLOW_BUILDER_FLOW_ACTIVE) unless opts.allowDeactivate — the planned row is draft/inactive.
 *   5. Upsert sys_user_preference name=sys_update_set (+ apps.current_app when the flow's
 *      sys_scope is not global) for that user. Then PATCH existing rows / POST missing ones.
 *      Write order: sys_hub_flow → variables → sys_documentation → stages → trigger → instances
 *      (plan.instances order). A POST whose returned sys_id differs from the client-supplied one
 *      aborts (the platform did not honour the id; pills / ui_id would be broken).
 *      STALE detection: child rows on the instance (flow=<id> / model=<id> / documentation names)
 *      absent from the plan are reported; deleted only with opts.deleteStale=true AND each sys_id
 *      listed in opts.confirmDelete. Never implicit.
 *   6. Verify capture in sys_update_xml: PRIMARY form (proven on the PDI) is ONE row named
 *      sys_hub_flow_<id> (type 'Flow') whose payload contains every planned child sys_id; the
 *      per-row form (one sys_update_xml per record) is the fallback. An unverified capture THROWS
 *      FLOW_BUILDER_CAPTURE_NOT_VERIFIED (details = the full write result) and activation is skipped:
 *      retroactive capture is impossible (§2.2), so uncaptured rows are a defect, not a warning.
 *   7. opts.activate=true (the tool has already passed requireFlowBuilderActivate()):
 *      POST api/now/wfa_fluent/activate_flows?sysparm_transaction_scope=<sys_scope sys_id> with
 *      {flows:[{sys_id,active:'',state:''}],actions:[]}; 200 and 422 both carry a result body;
 *      404, or 400 "does not represent any resource", means the endpoint is absent (the ServiceNow IDE
 *      store app sn_glider, which registers it as a sys_ws_operation, is missing); any other status is a failure. Then the MANDATORY read-back
 *      of sys_hub_flow.active/status/latest_snapshot — ok only when active='true' — and a second
 *      capture verification (activation mutates sys_hub_flow server-side); a failed second
 *      verification also throws FLOW_BUILDER_CAPTURE_NOT_VERIFIED.
 *
 * verifyFlow(client, flowSysId, plan?) — owner: WRITER. Read-only read-back of sys_hub_flow
 *   (type=flow|subflow), trigger, *_instance_v2 rows, variables/inputs/outputs and stages filtered
 *   by the DRAFT flow sys_id (published flows also carry snapshot copies keyed by the snapshot id);
 *   decodes values / trigger_inputs / subflow_inputs; diffs against the plan when given (gzip blobs
 *   compared as canonical JSON, label_cache as a name-keyed set); every {{...}} in the decoded blobs
 *   must appear in label_cache or be static./empty; missing sys_update_xml rows; the
 *   sys_flow_record_trigger behind remote_trigger_id; the last sys_flow_context rows.
 *
 * Owner: WRITER.
 */
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ServiceNowRecord } from '../../servicenow/types.js';
import { ServiceNowError } from '../../utils/errors.js';
import { logger } from '../../utils/logging.js';
import { decodeValues, looksLikeGzipB64 } from '../encode.js';
import { SYS_ID_RE } from '../ids.js';
import type {
  RecordPlan,
  RecordRow,
  WriteOptions,
  WriteResult,
  WrittenRow,
  VerifyResult,
  CaptureVerification,
  ActivationResult,
} from '../spec/types.js';

export type { WriteOptions, WriteResult, VerifyResult };

// ─── constants ────────────────────────────────────────────────────────────────

/** Activation endpoint of the ServiceNow IDE store app (sn_glider): a registered sys_ws_operation on the instance (POST /api/now/wfa_fluent/activate_flows, "Activate Flows and Actions"). */
export const ACTIVATE_FLOWS_PATH = 'api/now/wfa_fluent/activate_flows';

/** Child tables keyed by `flow=<flow sys_id>`. */
export const CHILD_TABLES_BY_FLOW = [
  'sys_hub_trigger_instance_v2',
  'sys_hub_action_instance_v2',
  'sys_hub_sub_flow_instance_v2',
  'sys_hub_flow_logic_instance_v2',
  'sys_hub_flow_stage',
] as const;

/** Variable-style child tables keyed by `model=<flow sys_id>`. */
export const CHILD_TABLES_BY_MODEL = ['sys_hub_flow_variable', 'sys_hub_flow_input', 'sys_hub_flow_output'] as const;

const INSTANCE_TABLES = ['sys_hub_action_instance_v2', 'sys_hub_sub_flow_instance_v2', 'sys_hub_flow_logic_instance_v2'] as const;

/** sys_idIN chunk size: 33 chars per id keeps the encoded query well under the client's 4096 limit. */
const ID_CHUNK = 100;

const UPDATE_SET_FIELDS = 'sys_id,name,state,is_default,application';
const READ_BACK_FIELDS = 'active,status,latest_snapshot,master_snapshot,sys_updated_on';

// ─── extended result shapes (additive over spec/types.ts) ─────────────────────

export interface ResolvedUpdateSet { sys_id: string; name: string; state: string; is_default: boolean; application: string }
export interface ResolvedUser { sys_id: string; user_name: string }
export interface ResolvedScope { sys_id: string; scope: string; name: string }
export interface PreferenceWrite { name: string; sys_id: string; value: string; action: 'inserted' | 'updated' | 'kept' }

export interface FlowCaptureVerification extends CaptureVerification {
  /** The single parent row when the parent_row form was found. */
  parentRow?: { sys_id: string; name: string; type: string; update_guid: string; payload_hash: string };
  /** Update sets (other than the target) that hold a sys_hub_flow_<id> row — the preference did not take. */
  otherUpdateSets: string[];
  /** Planned rows found inside the parent sys_hub_flow_<id> payload. */
  coveredByParent: number;
  /** Planned rows found as their own sys_update_xml row (`<table>_<sys_id>`), e.g. sys_complex_object. */
  coveredPerRow: number;
  ok: boolean;
}

export interface FlowActivationResult extends ActivationResult {
  scope?: string;
  /** Capture verification re-run after activation (activation mutates sys_hub_flow server-side). */
  capture_after?: FlowCaptureVerification;
}

export interface FlowWriteResult extends WriteResult {
  scope: ResolvedScope;
  mode: WriteOptions['mode'];
  preferences: PreferenceWrite[];
  capture: FlowCaptureVerification;
  activation: FlowActivationResult;
  /** Every {table, sys_id} the plan carried, in write order. */
  planned: { table: string; sys_id: string }[];
  /** sys_hub_flow.active/status/latest_snapshot BEFORE this update (only when the flow already existed). */
  previousFlowState?: { active: string; status: string; latest_snapshot: string };
}

export interface FlowVerifyResult extends VerifyResult {
  variables: Record<string, unknown>[];
  stages: Record<string, unknown>[];
  recordTrigger?: Record<string, unknown>;
  labelCacheEntries: number;
  updateXml: { sys_id: string; update_set: string; sys_updated_on: string }[];
}

// ─── small helpers ────────────────────────────────────────────────────────────

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v !== null && 'value' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>).value ?? '');
  return String(v);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function assertSysId(value: string, what: string): string {
  if (!SYS_ID_RE.test(value)) throw new ServiceNowError(`${what} is not a 32-char lowercase hex sys_id: ${JSON.stringify(value)}`, 'INVALID_REQUEST');
  return value;
}

/** Every planned row in write order (flow → variables → documentation → stages → trigger → instances). */
export function plannedRows(plan: RecordPlan): RecordRow[] {
  return [plan.flow, ...plan.variables, ...plan.documentation, ...plan.stages, ...(plan.trigger ? [plan.trigger] : []), ...plan.instances];
}

/** Field values as the Table API takes them: everything as a string ('true'/'false', '3'). */
function toApiFields(row: RecordRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.fields)) out[k] = typeof v === 'string' ? v : String(v);
  return out;
}

/** Canonical JSON (sorted keys) for blob comparison. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function tryDecode(value: unknown): unknown {
  if (typeof value === 'string' && looksLikeGzipB64(value)) {
    try { return decodeValues(value); } catch { return value; }
  }
  return value;
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (!(t.startsWith('[') || t.startsWith('{'))) return value;
  try { return JSON.parse(t); } catch { return value; }
}

/** Collect every {{...}} token (without braces) inside any string of a decoded structure. */
export function pillTokensIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    const re = /\{\{([^{}]*)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value))) out.add(m[1].trim());
  } else if (Array.isArray(value)) {
    for (const v of value) pillTokensIn(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) pillTokensIn(v, out);
  }
  return out;
}

async function queryAll(client: ServiceNowClient, table: string, query: string, fields: string, limit = 1000): Promise<ServiceNowRecord[]> {
  const r = await client.queryRecords({ table, query, fields, limit });
  return r.records;
}

/** sys_ids (of the given set) that exist in `table`, found with chunked sys_idIN queries. */
export async function existingIds(client: ServiceNowClient, table: string, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunk(ids, ID_CHUNK)) {
    const rows = await queryAll(client, table, `sys_idIN${part.join(',')}`, 'sys_id', part.length);
    for (const r of rows) found.add(str(r.sys_id));
  }
  return found;
}

export function requireClientCapabilities(client: ServiceNowClient, fns = ['queryRecords', 'getRecord', 'createRecord', 'updateRecord', 'deleteRecord', 'requestJson', 'getConfiguredUsername']): void {
  const c = client as unknown as Record<string, unknown>;
  for (const fn of fns) {
    if (typeof c[fn] !== 'function') throw new ServiceNowError(`ServiceNowClient lacks ${fn}() — the flow builder needs the extended client`, 'FLOW_BUILDER_CLIENT_UNSUPPORTED');
  }
}

// ─── §2.2 pre-writes ──────────────────────────────────────────────────────────

/** Resolve the target update set and enforce state='in progress' AND is_default=false. */
export async function resolveUpdateSet(client: ServiceNowClient, ref: WriteOptions['updateSet']): Promise<ResolvedUpdateSet> {
  let rec: ServiceNowRecord | undefined;
  if (ref.sys_id) {
    assertSysId(ref.sys_id, 'update_set.sys_id');
    try {
      rec = await client.getRecord('sys_update_set', ref.sys_id, UPDATE_SET_FIELDS);
    } catch (e) {
      if (e instanceof ServiceNowError && e.code === 'NOT_FOUND') throw new ServiceNowError(`update set ${ref.sys_id} not found`, 'FLOW_BUILDER_UPDATE_SET_NOT_FOUND');
      throw e;
    }
  } else if (ref.name) {
    if (/[\^]/.test(ref.name)) throw new ServiceNowError('update_set.name must not contain "^"', 'INVALID_REQUEST');
    const rows = await queryAll(client, 'sys_update_set', `name=${ref.name}`, UPDATE_SET_FIELDS, 5);
    if (rows.length === 0) throw new ServiceNowError(`update set named "${ref.name}" not found`, 'FLOW_BUILDER_UPDATE_SET_NOT_FOUND');
    if (rows.length > 1) {
      throw new ServiceNowError(`update set name "${ref.name}" matches ${rows.length} rows — pass update_set.sys_id`, 'FLOW_BUILDER_UPDATE_SET_AMBIGUOUS', {
        candidates: rows.map(r => ({ sys_id: str(r.sys_id), state: str(r.state), is_default: str(r.is_default) })),
      });
    }
    rec = rows[0];
  } else {
    throw new ServiceNowError('update_set needs a sys_id or a name', 'INVALID_REQUEST');
  }
  const us: ResolvedUpdateSet = {
    sys_id: str(rec.sys_id),
    name: str(rec.name),
    state: str(rec.state),
    is_default: str(rec.is_default) === 'true',
    application: str(rec.application),
  };
  if (us.state !== 'in progress') {
    throw new ServiceNowError(`update set "${us.name}" (${us.sys_id}) is "${us.state}", not "in progress" — refusing to write`, 'FLOW_BUILDER_UPDATE_SET_NOT_IN_PROGRESS', us);
  }
  if (us.is_default) {
    throw new ServiceNowError(
      `update set "${us.name}" (${us.sys_id}) has is_default=true — REST writes would leak to the Default set; clear is_default (do not use snow_us_update_set_switch/_ensure) and retry`,
      'FLOW_BUILDER_UPDATE_SET_IS_DEFAULT',
      us
    );
  }
  return us;
}

/** The authenticated user, derived from the client's own configuration (never a tool argument). */
export async function resolveSessionUser(client: ServiceNowClient): Promise<ResolvedUser> {
  const username = client.getConfiguredUsername();
  if (!username) {
    throw new ServiceNowError('cannot derive the authenticated user from the client configuration (impersonation / per-user mode or no username) — the §2.2 preference owner is unknown', 'FLOW_BUILDER_USER_UNRESOLVED');
  }
  if (/[\^]/.test(username)) throw new ServiceNowError('configured username contains "^"', 'FLOW_BUILDER_USER_UNRESOLVED');
  const rows = await queryAll(client, 'sys_user', `user_name=${username}`, 'sys_id,user_name', 2);
  if (rows.length !== 1) {
    throw new ServiceNowError(`sys_user user_name=${username} matched ${rows.length} rows (expected exactly 1)`, 'FLOW_BUILDER_USER_UNRESOLVED');
  }
  return { sys_id: str(rows[0].sys_id), user_name: str(rows[0].user_name) };
}

/** Resolve the flow's scope: 'global', a sys_scope sys_id, or a scope name (x_...). */
export async function resolveScope(client: ServiceNowClient, scopeField: string): Promise<ResolvedScope> {
  const s = (scopeField ?? '').trim() || 'global';
  if (s === 'global') return { sys_id: 'global', scope: 'global', name: 'Global' };
  if (SYS_ID_RE.test(s)) {
    const rec = await client.getRecord('sys_scope', s, 'sys_id,scope,name');
    return { sys_id: str(rec.sys_id), scope: str(rec.scope), name: str(rec.name) };
  }
  if (!/^[a-z][a-z0-9_]*$/.test(s)) throw new ServiceNowError(`flow sys_scope "${s}" is neither "global", a sys_id nor a scope name`, 'INVALID_REQUEST');
  const rows = await queryAll(client, 'sys_scope', `scope=${s}`, 'sys_id,scope,name', 2);
  if (rows.length !== 1) throw new ServiceNowError(`sys_scope scope=${s} matched ${rows.length} rows (expected exactly 1)`, 'FLOW_BUILDER_SCOPE_UNRESOLVED');
  return { sys_id: str(rows[0].sys_id), scope: str(rows[0].scope), name: str(rows[0].name) };
}

/** Upsert one sys_user_preference row for the user. */
export async function upsertUserPreference(client: ServiceNowClient, userSysId: string, name: string, value: string): Promise<PreferenceWrite> {
  const rows = await queryAll(client, 'sys_user_preference', `user=${userSysId}^name=${name}`, 'sys_id,value', 2);
  if (rows.length > 1) logger.warn(`sys_user_preference ${name}: ${rows.length} rows for user ${userSysId}; using the first`);
  if (rows.length > 0) {
    const sysId = str(rows[0].sys_id);
    if (str(rows[0].value) === value) return { name, sys_id: sysId, value, action: 'kept' };
    await client.updateRecord('sys_user_preference', sysId, { value });
    return { name, sys_id: sysId, value, action: 'updated' };
  }
  const created = await client.createRecord('sys_user_preference', { user: userSysId, name, value, type: 'string' });
  return { name, sys_id: str(created.sys_id), value, action: 'inserted' };
}

/**
 * REFUSE when the update set's application is not the flow's application (scoped flow: application
 * must equal the scope sys_id; global flow: application must be global/empty) — the known path by
 * which the platform redirects captures to another set. Pure; call before any write.
 */
export function assertUpdateSetMatchesScope(updateSet: ResolvedUpdateSet, scope: ResolvedScope): void {
  const usApp = updateSet.application || '';
  const appMismatch = scope.scope !== 'global' ? usApp !== scope.sys_id : (usApp !== '' && usApp !== 'global');
  if (appMismatch) {
    throw new ServiceNowError(
      `update set "${updateSet.name}" (${updateSet.sys_id}) belongs to application ${usApp || '<empty>'}, but the flow is in scope ${scope.scope} (${scope.sys_id}) — captures would be redirected to another update set; use an update set of the flow's application`,
      'FLOW_BUILDER_UPDATE_SET_SCOPE_MISMATCH',
      { updateSet, scope }
    );
  }
}

/** Every planned row, validated: a sys_hub_flow flow row, 32-hex sys_ids, no duplicates. */
export function checkedPlanRows(plan: RecordPlan): RecordRow[] {
  assertSysId(plan.flow.sys_id, 'plan.flow.sys_id');
  if (plan.flow.table !== 'sys_hub_flow') throw new ServiceNowError(`plan.flow.table must be sys_hub_flow (got ${plan.flow.table})`, 'INVALID_REQUEST');
  const rows = plannedRows(plan);
  for (const r of rows) assertSysId(r.sys_id, `${r.table} row sys_id`);
  const dupes = rows.map(r => r.sys_id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupes.length) throw new ServiceNowError(`plan carries duplicate sys_ids: ${[...new Set(dupes)].join(', ')}`, 'INVALID_REQUEST');
  return rows;
}

/**
 * An existing flow that is ACTIVE: the planned row carries active='false' / status='draft', so
 * rewriting it silently deactivates a live flow. Refused (FLOW_BUILDER_FLOW_ACTIVE) unless
 * allowDeactivate; otherwise a warning is pushed. Returns the state read before the rewrite.
 */
export async function checkActiveFlow(
  client: ServiceNowClient,
  flowSysId: string,
  opts: { allowDeactivate?: boolean; activate: boolean },
  warnings: string[]
): Promise<{ active: string; status: string; latest_snapshot: string }> {
  const cur = await client.getRecord('sys_hub_flow', flowSysId, READ_BACK_FIELDS);
  const previous = { active: str(cur.active), status: str(cur.status), latest_snapshot: str(cur.latest_snapshot) };
  if (previous.active === 'true') {
    if (!opts.allowDeactivate) {
      throw new ServiceNowError(
        `flow ${flowSysId} is ACTIVE on the instance (status=${previous.status || '<empty>'}) — an update would PATCH active=false / status=draft and deactivate the live flow; pass allow_deactivate:true to accept that (and activate:true to re-activate after writing)`,
        'FLOW_BUILDER_FLOW_ACTIVE',
        { flowSysId, current: previous }
      );
    }
    warnings.push(`flow ${flowSysId} was ACTIVE (status=${previous.status}); allow_deactivate:true — this update sets it to draft/inactive${opts.activate ? ' and then re-activates it' : ' (it stays inactive: activate:true was not requested)'}`);
  }
  return previous;
}

/** Child rows of the flow on the instance: flow=<id> / model=<id> tables and its variable documentation. */
export async function childRowsOnInstance(client: ServiceNowClient, flowSysId: string): Promise<{ table: string; sys_id: string }[]> {
  const onInstance: { table: string; sys_id: string }[] = [];
  for (const t of CHILD_TABLES_BY_FLOW) for (const rec of await queryAll(client, t, `flow=${flowSysId}`, 'sys_id')) onInstance.push({ table: t, sys_id: str(rec.sys_id) });
  for (const t of CHILD_TABLES_BY_MODEL) for (const rec of await queryAll(client, t, `model=${flowSysId}`, 'sys_id')) onInstance.push({ table: t, sys_id: str(rec.sys_id) });
  const docQuery = ['variable', 'input', 'output'].map(k => `name=var__m_sys_hub_flow_${k}_${flowSysId}`).join('^OR');
  for (const rec of await queryAll(client, 'sys_documentation', docQuery, 'sys_id')) onInstance.push({ table: 'sys_documentation', sys_id: str(rec.sys_id) });
  return onInstance;
}

// ─── capture verification ─────────────────────────────────────────────────────

/**
 * Verify update-set capture. Primary form: ONE sys_update_xml row `sys_hub_flow_<id>` whose payload
 * contains every planned child sys_id (PDI-FACTS §2). Fallback: one row per planned record.
 */
export async function verifyCapture(client: ServiceNowClient, updateSetSysId: string, flowSysId: string, rows: { table: string; sys_id: string }[]): Promise<FlowCaptureVerification> {
  const parentName = `sys_hub_flow_${flowSysId}`;
  const parent = await queryAll(client, 'sys_update_xml', `update_set=${updateSetSysId}^name=${parentName}`, 'sys_id,name,type,payload,payload_hash,update_guid', 1);
  const result: FlowCaptureVerification = { mode: 'unverified', expected: rows.length, found: 0, missing: [], otherUpdateSets: [], coveredByParent: 0, coveredPerRow: 0, ok: false };

  // Primary form: the parent row's payload accounts for every planned row.
  const inPayload = new Set<string>();
  if (parent.length > 0) {
    const p = parent[0];
    const payload = str(p.payload);
    result.parentRow = { sys_id: str(p.sys_id), name: str(p.name), type: str(p.type), update_guid: str(p.update_guid), payload_hash: str(p.payload_hash) };
    for (const r of rows) if (payload.includes(`<sys_id>${r.sys_id}</sys_id>`)) inPayload.add(r.sys_id);
  }
  // Fallback form: one sys_update_xml per record, looked up only for what the payload did not cover
  // (a per-row capture also names the flow's own record sys_hub_flow_<id>, so a hit above is not proof of the parent form).
  const remaining = rows.filter(r => !inPayload.has(r.sys_id));
  const perRow = new Set<string>();
  if (remaining.length > 0) {
    for (const part of chunk(remaining.map(r => `${r.table}_${r.sys_id}`), ID_CHUNK)) {
      const found = await queryAll(client, 'sys_update_xml', `update_set=${updateSetSysId}^nameIN${part.join(',')}`, 'name', part.length);
      for (const f of found) perRow.add(str(f.name));
    }
  }
  for (const r of rows) {
    if (inPayload.has(r.sys_id)) { result.found++; result.coveredByParent++; }
    else if (perRow.has(`${r.table}_${r.sys_id}`)) { result.found++; result.coveredPerRow++; }
    else result.missing.push({ table: r.table, sys_id: r.sys_id });
  }
  // 'parent_row' whenever the parent payload carries at least one CHILD of the flow (rows of unkeyed tables
  // such as sys_complex_object may still be captured per row). A per-row capture also has a
  // sys_hub_flow_<id> row, but its payload holds only the flow record — that stays 'per_row'.
  const childrenInParent = result.coveredByParent - (inPayload.has(flowSysId) ? 1 : 0);
  result.mode = result.found === 0 ? 'unverified' : (childrenInParent > 0 || rows.length === 1) && result.coveredByParent > 0 ? 'parent_row' : 'per_row';

  if (result.missing.length > 0 || result.mode === 'unverified') {
    const elsewhere = await queryAll(client, 'sys_update_xml', `name=${parentName}^update_set!=${updateSetSysId}`, 'update_set', 5);
    result.otherUpdateSets = [...new Set(elsewhere.map(e => str(e.update_set)).filter(Boolean))];
  }
  result.ok = result.mode !== 'unverified' && result.missing.length === 0;
  return result;
}

// ─── activation ───────────────────────────────────────────────────────────────

/** `result.summary` of an activate_flows response (200 and 422 both carry it), when present. */
function activationSummary(response: unknown): { total?: number; succeeded?: number; failed?: number } | undefined {
  const r = (response && typeof response === 'object' ? (response as Record<string, unknown>).result ?? response : undefined) as Record<string, unknown> | undefined;
  const s = r && typeof r === 'object' ? r.summary : undefined;
  return s && typeof s === 'object' ? (s as { total?: number; succeeded?: number; failed?: number }) : undefined;
}

/**
 * POST activate_flows then the mandatory read-back. Never throws for an activation failure — reports it.
 * `scopeSysId` is the sys_scope sys_id ('global' for global) — sysparm_transaction_scope takes the
 * application's sys_id, not the scope name (live runs: 'global'; a scoped activation is not yet proven).
 */
export async function activateFlow(client: ServiceNowClient, flowSysId: string, scopeSysId: string): Promise<FlowActivationResult> {
  const out: FlowActivationResult = { requested: true, attempted: false, ok: false, scope: scopeSysId };
  const body = { flows: [{ sys_id: flowSysId, active: '', state: '' }], actions: [] as unknown[] };
  const path = `${ACTIVATE_FLOWS_PATH}?sysparm_transaction_scope=${encodeURIComponent(scopeSysId)}`;
  try {
    out.attempted = true;
    out.response = await client.requestJson('POST', path, body);
    out.http_status = 200;
    const s = activationSummary(out.response);
    if (s && (s.failed ?? 0) > 0) out.message = `activate_flows reported ${s.failed}/${s.total} failed`;
  } catch (e) {
    const details = (e instanceof ServiceNowError && e.details && typeof e.details === 'object') ? (e.details as { status?: number; body?: string; detail?: string }) : {};
    const text = `${e instanceof Error ? e.message : String(e)} ${details.detail ?? ''} ${details.body ?? ''}`;
    out.http_status = details.status;
    if (details.status === 422) {
      // 422 = every flow failed; the body still carries result.summary + results[]
      out.response = tryParseJson(details.body) ?? details.body;
      out.message = `activate_flows returned 422 (activation failed): ${e instanceof Error ? e.message : String(e)}`;
    } else if (details.status === 404 || (details.status === 400 && /does not represent any resource/i.test(text))) {
      out.message = `activate_flows endpoint not available (HTTP ${details.status}) — the ServiceNow IDE store app (sn_glider) is required; activate the flow in Workflow Studio`;
    } else {
      out.response = tryParseJson(details.body) ?? details.body;
      out.message = `activate_flows failed (HTTP ${details.status ?? '?'}): ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  // Mandatory read-back — a 200 does not prove the flow is active; we never trust the POST alone.
  const rb = await client.getRecord('sys_hub_flow', flowSysId, READ_BACK_FIELDS);
  out.read_back = { active: str(rb.active), status: str(rb.status), latest_snapshot: str(rb.latest_snapshot) };
  out.ok = out.read_back.active === 'true';
  if (out.ok) {
    out.message = `flow active (status=${out.read_back.status}, latest_snapshot=${out.read_back.latest_snapshot || '<empty>'})${out.message ? `; note: ${out.message}` : ''}`;
  } else if (!out.message) {
    out.message = `activate_flows returned HTTP ${out.http_status} but the read-back shows active=${out.read_back.active} status=${out.read_back.status}`;
  }
  return out;
}

// ─── writePlan ────────────────────────────────────────────────────────────────

export async function writePlan(client: ServiceNowClient, plan: RecordPlan, opts: WriteOptions): Promise<FlowWriteResult> {
  requireClientCapabilities(client);
  if (opts.deleteStale && (!Array.isArray(opts.confirmDelete) || opts.confirmDelete.length === 0)) {
    throw new ServiceNowError('deleteStale requires confirmDelete to list every sys_id that may be deleted', 'INVALID_REQUEST');
  }
  const rows = checkedPlanRows(plan);
  const flowSysId = plan.flow.sys_id;
  const warnings: string[] = [...(plan.warnings ?? [])];

  // 1. update set
  const updateSet = await resolveUpdateSet(client, opts.updateSet);

  // 2. user (from the session)
  const user = await resolveSessionUser(client);

  // 3. scope — the update set must belong to the flow's application (refused BEFORE any write:
  //    a mismatch is the known path by which the platform redirects captures to another set).
  const scopeField = str(plan.flow.fields.sys_scope) || 'global';
  const scope = await resolveScope(client, scopeField);
  assertUpdateSetMatchesScope(updateSet, scope);

  // Rewrite a scope NAME on any row to the resolved sys_id (the Table API wants the reference value).
  const rewriteScope = scopeField !== scope.sys_id;
  const apiRows = rows.map(r => {
    const fields = toApiFields(r);
    if (rewriteScope && fields.sys_scope === scopeField) fields.sys_scope = scope.sys_id;
    return { table: r.table, sys_id: r.sys_id, fields };
  });

  // 4. existence pre-check (read-only; runs BEFORE the preference upsert so a refused build mutates nothing)
  const byTable = new Map<string, string[]>();
  for (const r of apiRows) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.sys_id]);
  const exists = new Set<string>();
  for (const [table, ids] of byTable) for (const id of await existingIds(client, table, ids)) exists.add(id);
  if (opts.mode === 'create' && exists.size > 0) {
    throw new ServiceNowError(
      `mode:'create' but ${exists.size} planned row(s) already exist on the instance (flow ${flowSysId}${exists.has(flowSysId) ? ' included' : ''}) — use mode:'update'`,
      'FLOW_BUILDER_ROWS_EXIST',
      { existing: apiRows.filter(r => exists.has(r.sys_id)).map(r => ({ table: r.table, sys_id: r.sys_id })) }
    );
  }
  // 4b. an existing ACTIVE flow: the planned row carries active='false' / status='draft', so a PATCH would
  //     silently deactivate a live flow. Refused unless the caller explicitly allows it.
  const previousFlowState = exists.has(flowSysId) ? await checkActiveFlow(client, flowSysId, opts, warnings) : undefined;

  // 5. §2.2 preferences
  const preferences: PreferenceWrite[] = [];
  preferences.push(await upsertUserPreference(client, user.sys_id, 'sys_update_set', updateSet.sys_id));
  if (scope.scope !== 'global') preferences.push(await upsertUserPreference(client, user.sys_id, 'apps.current_app', scope.sys_id));

  // write in dependency order
  const written: WrittenRow[] = [];
  for (const r of apiRows) {
    if (exists.has(r.sys_id)) {
      await client.updateRecord(r.table, r.sys_id, r.fields);
      written.push({ table: r.table, sys_id: r.sys_id, action: 'updated' });
    } else {
      const created = await client.createRecord(r.table, { sys_id: r.sys_id, ...r.fields });
      const got = str(created?.sys_id);
      if (got !== r.sys_id) {
        throw new ServiceNowError(
          `the platform did not honour the client-supplied sys_id on POST ${r.table} (asked ${r.sys_id}, got ${got || '<none>'}) — aborting; ${written.length} row(s) already written`,
          'FLOW_BUILDER_SYS_ID_NOT_HONOURED',
          { written, unexpected: { table: r.table, sys_id: got } }
        );
      }
      written.push({ table: r.table, sys_id: r.sys_id, action: 'inserted' });
    }
  }

  // stale detection (after the writes)
  const planned = new Set(apiRows.map(r => r.sys_id));
  const stale: { table: string; sys_id: string }[] = [];
  const onInstance = await childRowsOnInstance(client, flowSysId);
  for (const row of onInstance) if (!planned.has(row.sys_id)) stale.push(row);

  // `deleted` = removed now; `stale` = still on the instance after this call (never deleted implicitly)
  const deleted: { table: string; sys_id: string }[] = [];
  if (stale.length > 0) {
    if (opts.deleteStale) {
      const confirmed = new Set(opts.confirmDelete);
      for (const s of stale) {
        if (confirmed.has(s.sys_id)) { await client.deleteRecord(s.table, s.sys_id); deleted.push(s); }
      }
      const unconfirmed = stale.filter(s => !confirmed.has(s.sys_id));
      if (unconfirmed.length) warnings.push(`${unconfirmed.length} STALE row(s) not listed in confirm_delete were kept: ${unconfirmed.map(s => `${s.table}/${s.sys_id}`).join(', ')}`);
    } else {
      warnings.push(`${stale.length} STALE row(s) exist on the instance but not in the plan (kept; pass delete_stale:true + confirm_delete to remove): ${stale.map(s => `${s.table}/${s.sys_id}`).join(', ')}`);
    }
  }
  const deletedIds = new Set(deleted.map(d => d.sys_id));
  const staleKept = stale.filter(s => !deletedIds.has(s.sys_id));

  // 6. capture verification — an uncaptured write cannot be captured retroactively (§2.2): hard error
  const plannedRefs = apiRows.map(r => ({ table: r.table, sys_id: r.sys_id }));
  const capture = await verifyCapture(client, updateSet.sys_id, flowSysId, plannedRefs);
  const captureText = (c: FlowCaptureVerification) => `mode=${c.mode}, found ${c.found}/${c.expected}${c.otherUpdateSets.length ? `; a sys_hub_flow_${flowSysId} row exists in other update set(s): ${c.otherUpdateSets.join(', ')}` : ''}`;
  if (!capture.ok) warnings.push(`update-set capture NOT verified (${captureText(capture)})`);

  const inserted = written.filter(w => w.action === 'inserted').length;
  const updated = written.filter(w => w.action === 'updated').length;
  let activation: FlowActivationResult = { requested: false, attempted: false, ok: false };
  const activationText = () => !opts.activate ? 'not requested (flow is draft/inactive)' : !activation.attempted ? 'NOT attempted (capture not verified)' : activation.ok ? 'OK' : 'FAILED';
  const assemble = (): FlowWriteResult => ({
    flowSysId,
    updateSet: { sys_id: updateSet.sys_id, name: updateSet.name },
    user,
    scope,
    mode: opts.mode,
    preferences,
    planned: plannedRefs,
    written,
    stale: staleKept,
    deleted,
    capture,
    activation,
    ...(previousFlowState ? { previousFlowState } : {}),
    summary: `flow ${str(plan.flow.fields.name) || flowSysId} (${flowSysId}) written on scope ${scope.scope}: ${inserted} inserted, ${updated} updated, ${deleted.length} deleted, ${staleKept.length} stale kept; capture ${capture.ok ? 'verified' : 'NOT verified'} (${capture.mode}, ${capture.found}/${capture.expected}) in update set "${updateSet.name}"; activation ${activationText()}`,
    warnings,
  });

  if (!capture.ok) {
    // Never activate an uncaptured flow. The error carries the whole write result so the rows written are known.
    if (opts.activate) activation = { requested: true, attempted: false, ok: false, message: 'not attempted: update-set capture was not verified' };
    throw new ServiceNowError(
      `rows written but update-set capture NOT verified in "${updateSet.name}" (${captureText(capture)}) — the rows are on the instance but not (all) in the target update set; move the sys_update_xml rows or rebuild into a correct set before promoting`,
      'FLOW_BUILDER_CAPTURE_NOT_VERIFIED',
      assemble()
    );
  }

  // 7. activation
  if (opts.activate) {
    activation = await activateFlow(client, flowSysId, scope.sys_id);
    activation.capture_after = await verifyCapture(client, updateSet.sys_id, flowSysId, plannedRefs);
    if (!activation.ok) warnings.push(`activation FAILED: ${activation.message}`);
    if (!activation.capture_after.ok) {
      warnings.push(`update-set capture NOT verified after activation (${captureText(activation.capture_after)})`);
      throw new ServiceNowError(
        `flow written${activation.ok ? ' and activated' : ''}, but the update-set capture is NOT verified after activation (${captureText(activation.capture_after)}) — activation mutates sys_hub_flow server-side and that change did not land in "${updateSet.name}"`,
        'FLOW_BUILDER_CAPTURE_NOT_VERIFIED',
        assemble()
      );
    }
  }

  return assemble();
}

// ─── verifyFlow ───────────────────────────────────────────────────────────────

function decodeRecord(rec: ServiceNowRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    const s = str(v);
    if (k === 'values' || k === 'trigger_inputs' || k === 'subflow_inputs') out[k] = tryDecode(s);
    else if (k === 'label_cache' || k === 'states') out[k] = tryParseJson(s);
    else out[k] = s;
  }
  return out;
}

function orderKey(order: string): number {
  // '2➛3' (parallel composite) sorts by its last component; plain '7' → 7
  const parts = order.split('➛');
  const n = Number(parts[parts.length - 1]);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

async function namesOf(client: ServiceNowClient, table: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const clean = [...new Set(ids.filter(id => SYS_ID_RE.test(id)))];
  for (const part of chunk(clean, ID_CHUNK)) {
    for (const r of await queryAll(client, table, `sys_idIN${part.join(',')}`, 'sys_id,name', part.length)) out.set(str(r.sys_id), str(r.name));
  }
  return out;
}

/**
 * Field-level comparison of every planned row with the instance (read-only): a missing row, or any
 * planned field whose stored value differs (gzip blobs compared as canonical JSON, label_cache as a
 * name-keyed set, 'global' scope accepted as is). Used by verifyFlow and by the loader's update-mode check.
 */
export async function planFieldDiffs(client: ServiceNowClient, plan: RecordPlan, absentColumns?: string[]): Promise<VerifyResult['diffs']> {
  const diffs: VerifyResult['diffs'] = [];
  const byTable = new Map<string, RecordRow[]>();
  for (const r of plannedRows(plan)) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r]);
  for (const [table, prow] of byTable) {
    const fields = [...new Set(['sys_id', ...prow.flatMap(r => Object.keys(r.fields))])].join(',');
    const actual = new Map<string, ServiceNowRecord>();
    for (const part of chunk(prow.map(r => r.sys_id), ID_CHUNK)) {
      for (const rec of await queryAll(client, table, `sys_idIN${part.join(',')}`, fields, part.length)) actual.set(str(rec.sys_id), rec);
    }
    for (const r of prow) {
      const a = actual.get(r.sys_id);
      if (!a) { diffs.push({ table, sys_id: r.sys_id, field: '<row>', expected: 'present', actual: 'missing' }); continue; }
      for (const [field, expectedRaw] of Object.entries(r.fields)) {
        // The Table API omits a requested column that does not exist on the table (e.g. `active` on
        // sys_hub_action_instance_v2 in Australia; the loader ignores it as well). Not a mismatch: report it.
        if (!(field in a)) {
          const key = `${table}.${field}`;
          if (absentColumns && !absentColumns.includes(key)) absentColumns.push(key);
          continue;
        }
        const expected = typeof expectedRaw === 'string' ? expectedRaw : String(expectedRaw);
        const actualStr = str(a[field]);
        if (field === 'sys_scope' && expected === 'global' && actualStr === 'global') continue;
        if (looksLikeGzipB64(expected)) {
          if (canonical(tryDecode(expected)) !== canonical(tryDecode(actualStr))) diffs.push({ table, sys_id: r.sys_id, field, expected: tryDecode(expected), actual: tryDecode(actualStr) });
          continue;
        }
        if (field === 'label_cache') {
          const e = tryParseJson(expected); const g = tryParseJson(actualStr);
          const key = (x: unknown) => Array.isArray(x) ? canonical([...x].sort((p, q) => str((p as Record<string, unknown>).name).localeCompare(str((q as Record<string, unknown>).name)))) : canonical(x);
          if (key(e) !== key(g)) diffs.push({ table, sys_id: r.sys_id, field, expected: e, actual: g });
          continue;
        }
        if (expected !== actualStr) diffs.push({ table, sys_id: r.sys_id, field, expected, actual: actualStr });
      }
    }
  }
  return diffs;
}

export async function verifyFlow(client: ServiceNowClient, flowSysId: string, plan?: RecordPlan): Promise<FlowVerifyResult> {
  requireClientCapabilities(client, ['queryRecords', 'getRecord']);
  assertSysId(flowSysId, 'flowSysId');
  const warnings: string[] = [];
  const result: FlowVerifyResult = {
    flowSysId, found: false, instances: [], diffs: [], unresolvedPills: [], missingUpdateXml: [], recentContexts: [],
    variables: [], stages: [], labelCacheEntries: 0, updateXml: [], ok: false, warnings,
  };

  let flowRec: ServiceNowRecord;
  try {
    flowRec = await client.getRecord('sys_hub_flow', flowSysId);
  } catch (e) {
    if (e instanceof ServiceNowError && e.code === 'NOT_FOUND') { warnings.push(`sys_hub_flow ${flowSysId} does not exist`); return result; }
    throw e;
  }
  result.found = true;
  const flow = decodeRecord(flowRec);
  result.flow = flow;
  const labelCache = Array.isArray(flow.label_cache) ? (flow.label_cache as Record<string, unknown>[]) : [];
  result.labelCacheEntries = labelCache.length;
  if (!['flow', 'subflow'].includes(str(flow.type))) warnings.push(`sys_hub_flow.type is "${str(flow.type)}" (expected flow or subflow)`);

  // trigger
  const triggers = await queryAll(client, 'sys_hub_trigger_instance_v2', `flow=${flowSysId}`, '', 5);
  if (triggers.length > 1) warnings.push(`${triggers.length} trigger rows for the flow (expected 1)`);
  if (triggers.length > 0) result.trigger = decodeRecord(triggers[0]);
  else if (str(flow.type) === 'flow') warnings.push('no sys_hub_trigger_instance_v2 row (a flow needs a trigger)');

  // instances (draft rows only: filtered by the draft flow sys_id, not a snapshot id)
  const raw: { table: string; rec: ServiceNowRecord }[] = [];
  for (const t of INSTANCE_TABLES) for (const rec of await queryAll(client, t, `flow=${flowSysId}`, '')) raw.push({ table: t, rec });
  const actionNames = await namesOf(client, 'sys_hub_action_type_definition', raw.filter(r => r.table === 'sys_hub_action_instance_v2').map(r => str(r.rec.action_type_parent)));
  const logicNames = await namesOf(client, 'sys_hub_flow_logic_definition', raw.filter(r => r.table === 'sys_hub_flow_logic_instance_v2').map(r => str(r.rec.logic_definition)));
  const subflowNames = await namesOf(client, 'sys_hub_flow', raw.filter(r => r.table === 'sys_hub_sub_flow_instance_v2').map(r => str(r.rec.subflow)));
  result.instances = raw
    .map(({ table, rec }) => {
      const decoded = decodeRecord(rec);
      const name = table === 'sys_hub_action_instance_v2' ? actionNames.get(str(rec.action_type_parent)) ?? `action ${str(rec.action_type)}`
        : table === 'sys_hub_flow_logic_instance_v2' ? logicNames.get(str(rec.logic_definition)) ?? `logic ${str(rec.logic_definition)}`
        : subflowNames.get(str(rec.subflow)) ?? `subflow ${str(rec.subflow)}`;
      const order = str(rec.order);
      return { table, sys_id: str(rec.sys_id), order: /^\d+$/.test(order) ? Number(order) : order, name, decoded };
    })
    .sort((a, b) => orderKey(String(a.order)) - orderKey(String(b.order)));
  if (result.instances.length === 0) warnings.push('no action / subflow / logic instance rows for the flow');

  // variables / inputs / outputs / stages
  for (const t of CHILD_TABLES_BY_MODEL) for (const rec of await queryAll(client, t, `model=${flowSysId}`, 'sys_id,element,label,internal_type,order,default_value,reference')) result.variables.push({ table: t, ...decodeRecord(rec) });
  for (const rec of await queryAll(client, 'sys_hub_flow_stage', `flow=${flowSysId}`, 'sys_id,order,value,label,type,component_indexes,stage_id,states,duration')) result.stages.push(decodeRecord(rec));

  // pills: every {{...}} in the decoded blobs must be in label_cache, static., flow_variable.<existing>, or empty
  const tokens = new Set<string>();
  if (result.trigger) pillTokensIn(result.trigger.trigger_inputs, tokens);
  for (const i of result.instances) { const d = i.decoded as Record<string, unknown>; pillTokensIn(d.values, tokens); pillTokensIn(d.subflow_inputs, tokens); }
  const known = new Set<string>();
  for (const e of labelCache) { const n = str(e.name); known.add(n); known.add(n.replace(/^\{\{|\}\}$/g, '')); }
  const varNames = new Set(result.variables.map(v => str(v.element)));
  for (const t of tokens) {
    if (t === '' || t.startsWith('static.') || known.has(t)) continue;
    const m = /^flow_variable\.([^.]+)/.exec(t);
    if (m && varNames.has(m[1])) continue;
    result.unresolvedPills.push(t);
  }
  result.unresolvedPills.sort();

  // plan diff
  if (plan) {
    if (plan.flow.sys_id !== flowSysId) warnings.push(`plan.flow.sys_id ${plan.flow.sys_id} differs from the flow read back (${flowSysId})`);
    const planned = plannedRows(plan);
    const absentColumns: string[] = [];
    result.diffs.push(...await planFieldDiffs(client, plan, absentColumns));
    if (absentColumns.length) warnings.push(`planned column(s) that do not exist on this instance: ${absentColumns.join(', ')}`);
    // rows on the instance that the plan does not know
    const plannedIds = new Set(planned.map(r => r.sys_id));
    for (const i of result.instances) if (!plannedIds.has(i.sys_id)) result.diffs.push({ table: i.table, sys_id: i.sys_id, field: '<row>', expected: 'absent', actual: 'present (not in plan)' });
  }

  // update-set capture rows (any update set)
  const xml = await queryAll(client, 'sys_update_xml', `name=sys_hub_flow_${flowSysId}`, 'sys_id,update_set,sys_updated_on,payload', 5);
  result.updateXml = xml.map(x => ({ sys_id: str(x.sys_id), update_set: str(x.update_set), sys_updated_on: str(x.sys_updated_on) }));
  if (xml.length === 0) {
    result.missingUpdateXml.push({ table: 'sys_hub_flow', sys_id: flowSysId });
    warnings.push(`no sys_update_xml row named sys_hub_flow_${flowSysId} — the flow is not captured in any update set`);
  } else if (plan) {
    const payload = xml.map(x => str(x.payload)).join('\n');
    for (const r of plannedRows(plan)) if (!payload.includes(`<sys_id>${r.sys_id}</sys_id>`)) result.missingUpdateXml.push({ table: r.table, sys_id: r.sys_id });
    if (result.missingUpdateXml.length) warnings.push(`${result.missingUpdateXml.length} planned row(s) are not inside the captured sys_hub_flow payload`);
  }

  // record-trigger runtime row
  const rt = str(flow.remote_trigger_id);
  if (SYS_ID_RE.test(rt)) {
    try { result.recordTrigger = decodeRecord(await client.getRecord('sys_flow_record_trigger', rt)); }
    catch (e) { warnings.push(`remote_trigger_id ${rt} could not be read: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // recent executions
  try {
    const ctx = await client.queryRecords({ table: 'sys_flow_context', query: `flow=${flowSysId}`, fields: 'sys_id,state,started,ended,sys_created_on,source_table,source_record', orderBy: '-sys_created_on', limit: 5 });
    result.recentContexts = ctx.records.map(decodeRecord);
  } catch (e) {
    warnings.push(`sys_flow_context could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (str(flow.active) === 'true' && !str(flow.latest_snapshot)) warnings.push('flow is active but has no latest_snapshot');
  result.ok = result.found && result.diffs.length === 0 && result.unresolvedPills.length === 0;
  return result;
}

// ─── protocol description (shown by snow_flow_plan) ──────────────────────────

/**
 * The exact §2.2 pre-write steps the writer executes, in order — returned by snow_flow_plan
 * so the Chief Architect can review them before any 'write approved'.
 */
export function describeCaptureProtocol(plan: RecordPlan, updateSet: { sys_id?: string; name?: string }): string[] {
  const target = updateSet.sys_id ? `sys_id=${updateSet.sys_id}` : updateSet.name ? `name="${updateSet.name}"` : '<update set to be named at build time>';
  const scope = String(plan.flow.fields.sys_scope ?? 'global');
  const steps = [
    `1. Resolve target update set (${target}); refuse unless state='in progress' AND is_default=false.`,
    '2. Resolve the authenticated user from the session (client configured username → sys_user.sys_id).',
    '3. Upsert sys_user_preference name=sys_update_set value=<update set sys_id> for that user (only after the read-only checks of step 4 have passed).',
  ];
  if (scope !== 'global') steps.push(`3b. Upsert sys_user_preference name=apps.current_app value=<sys_scope sys_id of "${scope}"> (scoped flow).`);
  const rowCount = plannedRows(plan).length;
  steps.push(`4. Pre-check that none of the ${rowCount} planned sys_ids exist (mode create) or PATCH the ones that do (mode update; an ACTIVE existing flow is refused unless allow_deactivate:true); write in dependency order (flow → variables → documentation → stages → trigger → ${plan.instances.length} instances) with client-supplied sys_ids. The update set must belong to the flow's application.`);
  steps.push('5. Verify sys_update_xml capture: one sys_hub_flow_<id> row whose payload contains every planned row (the PDI form), or one row per record (fallback). Unverified capture is an ERROR (FLOW_BUILDER_CAPTURE_NOT_VERIFIED), never only a warning.');
  steps.push('6. Report STALE rows (never delete without delete_stale + confirm_delete).');
  steps.push('7. activate:true only: POST api/now/wfa_fluent/activate_flows?sysparm_transaction_scope=<sys_scope sys_id> (body {flows:[{sys_id,active:"",state:""}],actions:[]}), then read back sys_hub_flow.active/status/latest_snapshot (error unless active) and re-verify capture.');
  return steps;
}
