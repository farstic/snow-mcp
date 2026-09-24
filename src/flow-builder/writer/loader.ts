/**
 * Loader transport — writes a RecordPlan through the instance-side ServiceNow IDE loader
 * (`POST api/fluent/load/<scopeId>?targetUpdateSetId=<update set sys_id>`), the endpoint the ServiceNow IDE
 * store app (sn_glider) exposes for installing application metadata. The request, the document and every check
 * are our own; the endpoint's behaviour below was established by live runs on the PDI.
 *
 * WHY (PDI findings, 24 Sep 2026, Australia P5, ServiceNow IDE 4.4.4):
 *   - Table-API writes honour our client-supplied sys_ids, but sys_hub_flow.version cannot be set over
 *     REST: the write ACL sys_hub_flow_base.version (admin_overrides=false) silently drops it. The flow
 *     stays version=1 (a PATCH to 2 returns 200, sys_mod_count unchanged); Flow Designer then ignores
 *     the *_v2 children and the update-set serializer captures only the flow row plus delete_multiple
 *     for the LEGACY tables. The Table-API transport therefore cannot create a working flow.
 *   - PDI-PROVEN (24 Sep 2026, alias 'product'): the loader ACCEPTS snow-mcp's HTTP Basic auth; the flow
 *     row comes out version=2 (only this path can set it); the target set gets ONE sys_update_xml
 *     sys_hub_flow_<id> whose payload holds the flow + every _v2 child; activate:true published the flow
 *     (status=published, active=true, snapshots set) and a real P1 incident ran it (sys_flow_context
 *     COMPLETE, the Update Record step resolved its pill).
 *   - The LOAD captures via targetUpdateSetId and reads / writes NO sys_user_preference. Activation
 *     (activate_flows) has no targetUpdateSetId. PDI finding 1: it runs in the user's session and follows
 *     the user's update-set preference for the GLOBAL scope; on the PDI it re-pointed that preference to
 *     another global in-progress set and captured there (a second sys_hub_flow_<id> row plus
 *     sys_documentation_var__m_sys_hub_flow_input_<id>_<element>_en rows). This path therefore touches the
 *     preferences ONLY around the activate_flows call: set to the target, then restored (step 7).
 *   - PDI finding 2: for a record-triggered flow the platform itself creates sys_hub_flow_input rows
 *     `current` and `table_name` (+ their sys_documentation), with random sys_ids, re-created on
 *     activation. They are PLATFORM-MANAGED: never stale, never confirmation-gated, and the document emits
 *     no sys_hub_flow_input delete_multiple on their account (FORMAT-DECISIONS D16).
 *
 * loadPlan(client, plan, opts), in order:
 *   1. Validate the plan (sys_hub_flow row, 32-hex ids, no duplicates). Resolve the target update set
 *      (in progress, is_default=false) and the flow's scope; the update set's application must be the
 *      flow's application. scopeId = the sys_scope sys_id ('global' for a global flow). A SCOPED flow
 *      is refused (FLOW_BUILDER_LOADER_SCOPED_REFUSED) until the scoped <sys_scope> form is proven on a PDI.
 *      activate:true only: the authenticated user is resolved here (client configured username → sys_user,
 *      read-only) so a build whose activation preferences could not be managed is refused before sending.
 *   2. Read-only pre-checks: existence of every planned sys_id (mode 'create' refuses existing rows);
 *      an existing ACTIVE flow is refused unless allowDeactivate; the flow's child rows on the instance.
 *      Record-triggered flows (type flow + a Created / Updated / Created or Updated trigger): the
 *      platform-managed sys_hub_flow_input rows `current` / `table_name` and their sys_documentation are
 *      set aside as `platformManaged` (not stale, not confirmation-gated).
 *   3. xml = planToRecordUpdateXml(plan, {scope, cleanTables}) — sys_scope written as a reference
 *      element (display_value = scope NAME, text = sys_scope sys_id). Its delete_multiple
 *      elements (`flow=<id>^sys_idNOT IN<planned>` per populated child table, and `flow=<id>` /
 *      `model=<id>` for a child table the plan leaves EMPTY but that has non-platform-managed rows on the
 *      instance) are applied BY THE LOADER: every existing child row they would remove must be listed in
 *      confirmDelete with deleteStale=true, otherwise FLOW_BUILDER_LOADER_WOULD_DELETE before anything is
 *      sent (never an implicit delete). A platform-managed row such a cleanup also removes is reported
 *      (fate 'deleted_by_load' — the platform re-creates it on activation), never gated. The per-instance
 *      `sys_hub_alias_mapping source_id=<planned instance>` deletes are the housekeeping the platform's own capture of a flow
 *      carries (flows/leaver-flow payload: one per action instance) — they touch only our instances' alias rows: counted before the load and reported as `housekeepingDeletes`.
 *      The target set's parent capture row (sys_update_xml sys_hub_flow_<id>) is recorded before sending.
 *   4. POST multipart/form-data, one part 'files' = sys_hub_flow_<id>.xml (application/xml).
 *      404, or 400 "does not represent any resource" → FLOW_BUILDER_LOADER_UNAVAILABLE;
 *      401/403 → FLOW_BUILDER_LOADER_AUTH_REFUSED; anything else non-2xx, a 2xx carrying result.error,
 *      a 2xx WITHOUT a JSON body (e.g. a login / SSO HTML page), a missing result.targetUpdateSetId or a
 *      targetUpdateSetId other than the target set → FLOW_BUILDER_LOADER_FAILED.
 *   5. VERIFY by read-back (all checks run, then the first failure throws with the full result):
 *      every planned row exists (FLOW_BUILDER_LOADER_ROWS_MISSING); sys_hub_flow.version === '2'
 *      (FLOW_BUILDER_LOADER_VERSION_MISMATCH); capture = ONE sys_update_xml sys_hub_flow_<id> in the
 *      target set whose payload holds every planned sys_id (FLOW_BUILDER_CAPTURE_NOT_VERIFIED); that
 *      parent row CHANGED during this load (new, or sys_updated_on / payload_hash / sys_mod_count
 *      differ — FLOW_BUILDER_LOADER_NOT_APPLIED, so an earlier load into the same set cannot pass for
 *      this one); mode 'update': every planned field equals the instance (FLOW_BUILDER_LOADER_READBACK_MISMATCH);
 *      no unplanned, non-platform-managed row left in a flow=/model= child table (FLOW_BUILDER_LOADER_STALE_ROWS).
 *      Never warn-only. Child rows that existed before and are gone now are reported as `deleted`.
 *   6. (sys_documentation rows of dropped variables are not flow=/model= keyed: reported as a warning.)
 *   7. activate:true → the ACTIVATION, bracketed by the user's preferences:
 *      a. record the target set's parent row, and every sys_update_xml row OUTSIDE the target set that can
 *         belong to this flow (sys_hub_flow_<id>; its snapshot sys_hub_flow_snapshot_<snap> /
 *         sys_hub_flow_<snap>; the flow's var__m_sys_hub_flow_<variable|input|output>_<id>* and
 *         sys_documentation_var__m_sys_hub_flow_<…>_<id>* rows; the per-row names <table>_<sys_id> of the
 *         planned rows);
 *      b. read the user's sys_user_preference 'sys_update_set' and 'apps.current_app', then set them to the
 *         target update set and the flow's scope sys_id ('global' for a global flow);
 *      c. activateFlow() (activate_flows + mandatory read-back);
 *      d. ALWAYS (finally) restore both preferences to exactly their previous state (value written back, or
 *         the row deleted when there was none) and read them back — `activationPreferences` (before / set /
 *         restore / after). A failed restore is FLOW_BUILDER_PREFERENCE_NOT_RESTORED (after the capture checks);
 *         Each safety-net query reads one page of SAFETY_NET_PAGE rows; a FULL page in (a) refuses the activation
 *         before any preference write (FLOW_BUILDER_CAPTURE_NOT_VERIFIED, activation not attempted), because an
 *         unordered full page may differ between the two snapshots and an old row could then look new;
 *      e. safety net: rows of those families (plus the new snapshot's names) in ANY other set that are NEW
 *         since (a), were created by the authenticated user AND have sys_created_on at/after the activation
 *         watermark (an instance-side time: the load's capture-row sys_updated_on, raised to the preference
 *         writes' sys_updated_on) are MOVED into the target set (PATCH sys_update_xml.update_set; every move
 *         reported). A row that pre-existed in another set (and changed), was created by someone else, or was
 *         created before the watermark is NEVER moved: it is an unmovable leak → FLOW_BUILDER_CAPTURE_NOT_VERIFIED.
 *         A full page after activation moves NOTHING (fail closed, FLOW_BUILDER_CAPTURE_NOT_VERIFIED);
 *      f. a name held twice in the TARGET set (load row + activation row) keeps the newer row and deletes the
 *         superseded older one — in the target set only (reported; a refused delete is a warning). For the
 *         parent row sys_hub_flow_<id> the kept row's payload is read BEFORE any delete: it must hold every
 *         planned sys_id and (activation OK) <active>true</active> on sys_hub_flow; otherwise nothing is deleted,
 *         both rows stay (duplicatesRefused) and the build fails with FLOW_BUILDER_CAPTURE_NOT_VERIFIED;
 *      g. the target set's parent row must have changed during activation, show <active>true</active> on the
 *         sys_hub_flow element (when the read-back says active) and still hold every planned row —
 *         otherwise FLOW_BUILDER_CAPTURE_NOT_VERIFIED.
 *
 * Owner: WRITER.
 */
import type { ServiceNowClient } from '../../servicenow/client.js';
import { ServiceNowError } from '../../utils/errors.js';
import { SYS_ID_RE } from '../ids.js';
import { findTrigger, isRecordTrigger } from '../catalog/triggers.js';
import type { RecordPlan, RecordRow, VerifyDiff, WriteOptions, WrittenRow } from '../spec/types.js';
import { planToRecordUpdateXml } from '../xml/record-update.js';
import { listDeleteMultiples, type DeleteMultiple } from '../xml/unload.js';
import {
  CHILD_TABLES_BY_FLOW,
  CHILD_TABLES_BY_MODEL,
  activateFlow,
  assertUpdateSetMatchesScope,
  checkActiveFlow,
  checkedPlanRows,
  childRowsOnInstance,
  existingIds,
  planFieldDiffs,
  requireClientCapabilities,
  resolveScope,
  resolveSessionUser,
  resolveUpdateSet,
  verifyCapture,
  type FlowActivationResult,
  type FlowCaptureVerification,
  type ResolvedScope,
  type ResolvedUser,
} from './index.js';

// ─── constants ────────────────────────────────────────────────────────────────

/** ServiceNow IDE loader endpoint (instance side): `<path>/<scopeId>?targetUpdateSetId=<sys_id>`. */
export const LOADER_LOAD_PATH = 'api/fluent/load';
/** Multipart part name the loader reads. */
export const LOADER_PART_NAME = 'files';
/** A flow load compiles server-side; our timeout for the loader POST (response body included). */
export const LOADER_TIMEOUT_MS = 300000;

/** Stated in every result without activation: the load never touches sys_user_preference. */
export const LOADER_PREFERENCE_NOTE = 'none — the loader captures into the target update set named by targetUpdateSetId; no sys_user_preference (sys_update_set / apps.current_app) was read or written on this path';

/** Stated in every result with activate:true: preferences are touched only around activate_flows. */
export const ACTIVATION_PREFERENCE_NOTE = 'load: none (capture by targetUpdateSetId). Activation only: sys_user_preference sys_update_set / apps.current_app were set to the target update set / the flow scope immediately before activate_flows (which follows the user preference, not targetUpdateSetId) and restored to their previous state right after — see activationPreferences';

/** sys_hub_flow_input elements the platform creates for a record-triggered flow (PDI finding 2). */
export const PLATFORM_MANAGED_INPUT_ELEMENTS = ['current', 'table_name'] as const;

/** The preferences activate_flows' capture follows, set only around the activation. */
export const ACTIVATION_PREFERENCES = ['sys_update_set', 'apps.current_app'] as const;

const FLOW_STATE_FIELDS = 'sys_id,name,version,status,active,latest_snapshot';
const CHILD_TABLES: readonly string[] = [...CHILD_TABLES_BY_FLOW, ...CHILD_TABLES_BY_MODEL];
const ALIAS_TABLE = 'sys_hub_alias_mapping';
const ID_CHUNK = 100;
const XML_ROW_FIELDS = 'sys_id,name,update_set,sys_updated_on,sys_mod_count,sys_created_by,sys_created_on';
/**
 * Page size of each safety-net query outside the target set. A page that comes back FULL means the snapshot may be
 * incomplete (before and after could return different pages), so the safety net fails closed instead of moving.
 */
export const SAFETY_NET_PAGE = 200;

// ─── types ────────────────────────────────────────────────────────────────────

export type LoadOptions = WriteOptions & {
  /** Loader request timeout (default LOADER_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * Scoped flows are refused until the scoped <sys_scope> form is proven on a PDI. Unit tests set this to
   * exercise the scoped document; the tool never does.
   */
  allowScopedUnverified?: boolean;
};

export interface LoaderCall {
  path: string;
  scopeId: string;
  targetUpdateSetId: string;
  file: { field: string; filename: string; contentType: string; bytes: number };
  /** delete_multiple elements the loader applies (from the XML). */
  deleteMultiple: DeleteMultiple[];
  http_status?: number;
  response?: unknown;
  /** result.targetUpdateSetId as returned by the loader. */
  returnedUpdateSetId?: string;
}

/** The target set's sys_update_xml sys_hub_flow_<id> row, as far as change detection needs it. */
export interface CaptureRowState { sys_id: string; sys_updated_on: string; payload_hash: string; sys_mod_count: string }

/** A platform-managed trigger input of a record-triggered flow (PDI finding 2). */
export interface PlatformManagedRow {
  table: 'sys_hub_flow_input' | 'sys_documentation';
  sys_id: string;
  element: string;
  classification: 'platform_managed';
  /** kept: untouched by the load; deleted_by_load: removed by a cleanup of OTHER stale input rows (re-created by the platform on activation); created_by_load: appeared during the load. */
  fate: 'kept' | 'deleted_by_load' | 'created_by_load';
}

/** One sys_user_preference row as far as the activation bracket needs it. */
export interface PreferenceState { exists: boolean; sys_id?: string; value?: string }

export interface ActivationPreference {
  name: string;
  before: PreferenceState;
  /** What was set before activate_flows (absent when setting failed before this preference). */
  set?: { value: string; action: 'inserted' | 'updated' | 'kept'; sys_id: string };
  restore: { action: 'updated' | 'recreated' | 'deleted' | 'kept' | 'failed'; message?: string };
  after: PreferenceState;
  /** after equals before (existence and value). */
  restored: boolean;
}

export interface ActivationPreferences {
  user: ResolvedUser;
  entries: ActivationPreference[];
  /** Every entry restored. */
  restored: boolean;
  note: string;
}

export interface MovedCaptureRow { sys_id: string; name: string; from_update_set: string; to_update_set: string }
export interface RemovedDuplicate { name: string; kept: string; deleted: string; deleted_updated_on: string; ok: boolean; message?: string }
/**
 * A duplicate name in the TARGET set whose superseded row was NOT deleted, because the newer (kept) row fails the
 * checks the superseded row already passed: it must hold every planned sys_id and, when the activation read-back
 * says active, <active>true</active> on the sys_hub_flow element. Both rows are left in place (fail closed).
 */
export interface RefusedDuplicate { name: string; kept: string; superseded: string[]; missing: string[]; activeInPayload: boolean; reason: string }
export interface CaptureLeak {
  sys_id: string; name: string; update_set: string;
  /**
   * pre_existing: in the before-snapshot and re-written; created_by_other_user: not the session user's;
   * created_before_activation: the session user's, but sys_created_on is older than the activation watermark (or
   * absent) — not provably written by this activation; move_failed: the instance refused the PATCH.
   */
  reason: 'pre_existing' | 'created_by_other_user' | 'created_before_activation' | 'move_failed';
  message?: string;
}

export interface ActivationCaptureCheck {
  /** The target set's parent row changed during activation. */
  parentChanged: boolean;
  /** The parent payload's sys_hub_flow element carries <active>true</active>. */
  activeInPayload: boolean;
  /** UNMOVABLE rows of this flow that appeared or changed in OTHER update sets during activation. */
  leaks: CaptureLeak[];
  /** Rows created by the authenticated user in another set during activation, moved into the target set. */
  moved: MovedCaptureRow[];
  /** Superseded older duplicates (same name) deleted from the TARGET set. */
  duplicatesRemoved: RemovedDuplicate[];
  /** Duplicates NOT removed because the newer row fails the capture checks (both rows left; fails closed). */
  duplicatesRefused: RefusedDuplicate[];
  /** The sys_update_xml queries (each also `^update_set!=<target>`) watched outside the target set. */
  watched: string[];
  /** Watched queries whose page came back full (SAFETY_NET_PAGE rows): the snapshot may be incomplete, so nothing is moved (fails closed). */
  truncated: string[];
  /**
   * Instance timestamp (sys_updated_on of the load's capture row, raised to the preference writes' sys_updated_on
   * when the instance returns one) that a row outside the target set must have been created at or after to be movable.
   */
  watermark: string;
  ok: boolean;
}

export interface FlowLoadResult {
  transport: 'loader';
  flowSysId: string;
  instanceName?: string;
  updateSet: { sys_id: string; name: string };
  scope: ResolvedScope;
  mode: WriteOptions['mode'];
  /** Always empty: the LOAD writes no preference (activation: see activationPreferences). */
  preferences: never[];
  preferencesNote: string;
  /** activate:true only — the preferences set around activate_flows and restored. */
  activationPreferences?: ActivationPreferences;
  loader: LoaderCall;
  /** Every {table, sys_id} the plan carried, in plan order. */
  planned: { table: string; sys_id: string }[];
  /** Planned rows confirmed present after the load; 'inserted' / 'updated' from the pre-check. */
  written: WrittenRow[];
  /** Planned rows NOT found after the load (non-empty ⇒ the call threw). */
  missing: { table: string; sys_id: string }[];
  /** sys_hub_flow read back after the load. */
  flowState?: { version: string; status: string; active: string; latest_snapshot: string };
  /** Child rows of the flow that existed before the load. */
  existedBefore: { table: string; sys_id: string }[];
  /** Child rows still on the instance after the load that the plan does not carry (platform-managed excluded). */
  stale: { table: string; sys_id: string }[];
  /** Child rows that existed before and are gone now (applied by the loader's delete_multiple). */
  deleted: { table: string; sys_id: string }[];
  /** Platform-managed trigger inputs of a record-triggered flow (never stale, never gated). */
  platformManaged: PlatformManagedRow[];
  /** Child tables the plan leaves empty that the document cleans (delete_multiple flow=/model=<id>). */
  cleanedTables: string[];
  /** sys_hub_alias_mapping rows of the planned instances the loader's housekeeping delete_multiple removes. */
  housekeepingDeletes: { table: string; sys_id: string; source_id: string }[];
  /** The target set's parent capture row before and after the load. */
  captureRow: { before?: CaptureRowState; after?: CaptureRowState; changed: boolean };
  /** mode 'update': planned fields that differ from the instance after the load (non-empty ⇒ threw). */
  fieldDiffs: VerifyDiff[];
  capture: FlowCaptureVerification;
  activation: FlowActivationResult;
  /** activate:true only — the activation's own capture check. */
  activationCapture?: ActivationCaptureCheck;
  previousFlowState?: { active: string; status: string; latest_snapshot: string };
  summary: string;
  warnings: string[];
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>).value ?? '');
  return String(v);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A copy of the plan with a scope NAME on any row rewritten to the resolved sys_scope sys_id. */
function withScopeSysId(plan: RecordPlan, scopeField: string, scope: ResolvedScope): RecordPlan {
  if (scopeField === scope.sys_id) return plan;
  const fix = (r: RecordRow): RecordRow => (r.fields.sys_scope === scopeField ? { ...r, fields: { ...r.fields, sys_scope: scope.sys_id } } : r);
  return {
    ...plan,
    flow: fix(plan.flow),
    ...(plan.trigger ? { trigger: fix(plan.trigger) } : {}),
    variables: plan.variables.map(fix),
    documentation: plan.documentation.map(fix),
    stages: plan.stages.map(fix),
    instances: plan.instances.map(fix),
  };
}

type MultipartResponse = { status: number; ok: boolean; statusText: string; json?: unknown; text?: string };

/** The loader's error text: result.error, error.message / error.detail, the raw text, or the status text. */
function loaderErrorText(r: MultipartResponse): string {
  const j = (r.json && typeof r.json === 'object' ? r.json : undefined) as Record<string, unknown> | undefined;
  const result = j?.result as Record<string, unknown> | undefined;
  const err = (result && result.error !== undefined ? result.error : undefined) ?? j?.error;
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const msg = [e.message, e.detail].filter(x => typeof x === 'string' && x).join(' — ');
    return msg || JSON.stringify(err);
  }
  return r.text || r.statusText || `HTTP ${r.status}`;
}

function returnedUpdateSetId(r: MultipartResponse): string | undefined {
  const j = r.json as { result?: { targetUpdateSetId?: unknown } } | undefined;
  const id = j && typeof j === 'object' ? j.result?.targetUpdateSetId : undefined;
  return typeof id === 'string' && id ? id : undefined;
}

function hasResultError(r: MultipartResponse): boolean {
  const j = r.json as { result?: { error?: unknown } } | undefined;
  const e = j && typeof j === 'object' ? j.result?.error : undefined;
  return e !== undefined && e !== null && e !== '';
}

/** Newest first: sys_updated_on, then sys_mod_count, then sys_created_on. */
function newestFirst<T extends Record<string, unknown>>(rows: T[]): T[] {
  const n = (v: unknown) => Number(str(v)) || 0;
  return [...rows].sort((a, b) =>
    str(b.sys_updated_on).localeCompare(str(a.sys_updated_on)) || n(b.sys_mod_count) - n(a.sys_mod_count) || str(b.sys_created_on).localeCompare(str(a.sys_created_on)));
}

/** The target set's parent capture row (sys_update_xml sys_hub_flow_<id>) — the newest one — optionally with its payload. */
async function captureRowState(client: ServiceNowClient, updateSetSysId: string, flowSysId: string, withPayload = false): Promise<(CaptureRowState & { payload?: string }) | undefined> {
  const fields = `sys_id,sys_updated_on,payload_hash,sys_mod_count,sys_created_on${withPayload ? ',payload' : ''}`;
  const r = await client.queryRecords({ table: 'sys_update_xml', query: `update_set=${updateSetSysId}^name=sys_hub_flow_${flowSysId}`, fields, limit: 10 });
  const rec = newestFirst(r.records as Record<string, unknown>[])[0];
  if (!rec) return undefined;
  const state: CaptureRowState & { payload?: string } = { sys_id: str(rec.sys_id), sys_updated_on: str(rec.sys_updated_on), payload_hash: str(rec.payload_hash), sys_mod_count: str(rec.sys_mod_count) };
  if (withPayload) state.payload = str(rec.payload);
  return state;
}

/** A capture row counts as changed when it is new, or any of sys_id / sys_updated_on / payload_hash / sys_mod_count differs. */
function captureRowChanged(before: CaptureRowState | undefined, after: CaptureRowState | undefined): boolean {
  if (!after) return false;
  if (!before) return true;
  return after.sys_id !== before.sys_id || after.sys_updated_on !== before.sys_updated_on || after.payload_hash !== before.payload_hash || after.sys_mod_count !== before.sys_mod_count;
}

const stripPayload = (s: (CaptureRowState & { payload?: string }) | undefined): CaptureRowState | undefined =>
  s ? { sys_id: s.sys_id, sys_updated_on: s.sys_updated_on, payload_hash: s.payload_hash, sys_mod_count: s.sys_mod_count } : undefined;

/** `<active>true</active>` on the sys_hub_flow element of a captured payload (children may carry their own `active`). */
function flowElementActive(payload: string | undefined): boolean {
  const m = /<sys_hub_flow(?:\s[^>]*)?>([\s\S]*?)<\/sys_hub_flow>/.exec(payload ?? '');
  return !!m && /<active>true<\/active>/.test(m[1]);
}

/** Is a delete_multiple one of the flow's child cleanups (flow=<id>[^…] / model=<id>[^…])? */
function isChildCleanup(d: DeleteMultiple, flowSysId: string): boolean {
  return [`flow=${flowSysId}`, `model=${flowSysId}`].some(p => d.query === p || d.query.startsWith(`${p}^`));
}

// ─── platform-managed trigger inputs (PDI finding 2) ──────────────────────────

/** A flow (type flow) with one of the three record triggers (Created / Updated / Created or Updated). */
export function isRecordTriggeredFlow(plan: RecordPlan): boolean {
  if ((str(plan.flow.fields.type) || 'flow') !== 'flow' || !plan.trigger) return false;
  const t = findTrigger(str(plan.trigger.fields.trigger_type)) ?? findTrigger(str(plan.trigger.fields.trigger_definition));
  return !!t && isRecordTrigger(t);
}

/** The platform-managed sys_hub_flow_input rows (current / table_name) of the flow and their sys_documentation. */
async function platformManagedInputs(client: ServiceNowClient, flowSysId: string, plannedIds: Set<string>): Promise<{ table: PlatformManagedRow['table']; sys_id: string; element: string }[]> {
  const els = PLATFORM_MANAGED_INPUT_ELEMENTS.join(',');
  const out: { table: PlatformManagedRow['table']; sys_id: string; element: string }[] = [];
  const inputs = await client.queryRecords({ table: 'sys_hub_flow_input', query: `model=${flowSysId}^elementIN${els}`, fields: 'sys_id,element', limit: 20 });
  for (const r of inputs.records) if (!plannedIds.has(str(r.sys_id))) out.push({ table: 'sys_hub_flow_input', sys_id: str(r.sys_id), element: str(r.element) });
  const docs = await client.queryRecords({ table: 'sys_documentation', query: `name=var__m_sys_hub_flow_input_${flowSysId}^elementIN${els}`, fields: 'sys_id,element', limit: 20 });
  for (const r of docs.records) if (!plannedIds.has(str(r.sys_id))) out.push({ table: 'sys_documentation', sys_id: str(r.sys_id), element: str(r.element) });
  return out;
}

// ─── activation preferences (PDI finding 1) ───────────────────────────────────

async function readPreference(client: ServiceNowClient, userSysId: string, name: string): Promise<{ state: PreferenceState; ids: string[] }> {
  const r = await client.queryRecords({ table: 'sys_user_preference', query: `user=${userSysId}^name=${name}`, fields: 'sys_id,value', limit: 5 });
  const rows = r.records;
  if (!rows.length) return { state: { exists: false }, ids: [] };
  return { state: { exists: true, sys_id: str(rows[0].sys_id), value: str(rows[0].value) }, ids: rows.map(x => str(x.sys_id)) };
}

/**
 * Point the preference at `value`. `stamp` is the written row's sys_updated_on as the instance returned it (absent
 * when nothing was written or the response carries none) — an instance-side time taken just before activate_flows.
 */
async function setPreference(client: ServiceNowClient, userSysId: string, name: string, value: string, before: PreferenceState): Promise<{ set: NonNullable<ActivationPreference['set']>; stamp?: string }> {
  const stampOf = (rec: unknown) => str((rec as Record<string, unknown> | undefined)?.sys_updated_on) || undefined;
  if (before.exists && before.sys_id) {
    if (before.value === value) return { set: { value, action: 'kept', sys_id: before.sys_id } };
    const updated = await client.updateRecord('sys_user_preference', before.sys_id, { value });
    return { set: { value, action: 'updated', sys_id: before.sys_id }, stamp: stampOf(updated) };
  }
  const created = await client.createRecord('sys_user_preference', { user: userSysId, name, value, type: 'string' });
  return { set: { value, action: 'inserted', sys_id: str(created?.sys_id) }, stamp: stampOf(created) };
}

/** Put the preference back exactly as `entry.before` (value re-written / row re-created / row(s) deleted), then read it back. */
async function restorePreference(client: ServiceNowClient, userSysId: string, entry: ActivationPreference): Promise<void> {
  const { before } = entry;
  try {
    const cur = await readPreference(client, userSysId, entry.name);
    if (before.exists) {
      if (cur.state.exists && cur.state.sys_id === before.sys_id && cur.state.value === before.value) entry.restore = { action: 'kept' };
      else if (before.sys_id && cur.ids.includes(before.sys_id)) {
        await client.updateRecord('sys_user_preference', before.sys_id, { value: before.value ?? '' });
        entry.restore = { action: 'updated' };
      } else {
        await client.createRecord('sys_user_preference', { user: userSysId, name: entry.name, value: before.value ?? '', type: 'string' });
        entry.restore = { action: 'recreated' };
      }
    } else if (cur.ids.length) {
      for (const id of cur.ids) await client.deleteRecord('sys_user_preference', id);
      entry.restore = { action: 'deleted' };
    } else {
      entry.restore = { action: 'kept' };
    }
  } catch (e) {
    entry.restore = { action: 'failed', message: errText(e) };
  }
  try {
    entry.after = (await readPreference(client, userSysId, entry.name)).state;
  } catch (e) {
    entry.after = { exists: before.exists };
    entry.restore = { action: 'failed', message: `${entry.restore.message ? `${entry.restore.message}; ` : ''}read-back failed: ${errText(e)}` };
  }
  entry.restored = entry.restore.action !== 'failed' && entry.after.exists === before.exists && (!before.exists || entry.after.value === before.value);
}

// ─── activation capture safety net ────────────────────────────────────────────

interface XmlRow { sys_id: string; name: string; update_set: string; sys_updated_on: string; sys_mod_count: string; sys_created_by: string; sys_created_on: string }

/**
 * The sys_update_xml queries (each run with `^update_set!=<target>`) that find rows an activation may write
 * for this flow: its parent row, its snapshot(s), its var__m_ / documentation rows, the planned rows per row.
 */
function leakQueries(flowSysId: string, snapshots: string[], planned: { table: string; sys_id: string }[]): string[] {
  const q = [`name=sys_hub_flow_${flowSysId}`];
  const snaps = [...new Set(snapshots)].filter(s => SYS_ID_RE.test(s) && s !== flowSysId);
  if (snaps.length) q.push(`nameIN${snaps.flatMap(s => [`sys_hub_flow_snapshot_${s}`, `sys_hub_flow_${s}`]).join(',')}`);
  for (const kind of ['variable', 'input', 'output']) {
    q.push(`nameSTARTSWITHvar__m_sys_hub_flow_${kind}_${flowSysId}`, `nameSTARTSWITHsys_documentation_var__m_sys_hub_flow_${kind}_${flowSysId}`);
  }
  for (const part of chunk(planned.filter(r => r.sys_id !== flowSysId).map(r => `${r.table}_${r.sys_id}`), ID_CHUNK)) q.push(`nameIN${part.join(',')}`);
  return q;
}

/**
 * The rows outside the target set matched by `queries`. `truncated` lists every query whose page came back full
 * (SAFETY_NET_PAGE rows): the platform returns no stable order without one, so a full page may differ between the
 * before- and after-snapshot and a pre-existing row could look new. The caller fails closed on any truncation.
 */
async function rowsOutsideTarget(client: ServiceNowClient, updateSetSysId: string, queries: string[]): Promise<{ rows: XmlRow[]; truncated: string[] }> {
  const byId = new Map<string, XmlRow>();
  const truncated: string[] = [];
  for (const q of queries) {
    const r = await client.queryRecords({ table: 'sys_update_xml', query: `${q}^update_set!=${updateSetSysId}`, fields: XML_ROW_FIELDS, limit: SAFETY_NET_PAGE });
    if (r.records.length >= SAFETY_NET_PAGE) truncated.push(q);
    for (const x of r.records) {
      const row: XmlRow = { sys_id: str(x.sys_id), name: str(x.name), update_set: str(x.update_set), sys_updated_on: str(x.sys_updated_on), sys_mod_count: str(x.sys_mod_count), sys_created_by: str(x.sys_created_by), sys_created_on: str(x.sys_created_on) };
      if (row.sys_id && row.update_set !== updateSetSysId) byId.set(row.sys_id, row);
    }
  }
  return { rows: [...byId.values()], truncated };
}

/** The parent-row checks a kept duplicate must pass before the superseded row may be deleted. */
interface ParentDuplicateCheck { name: string; plannedIds: string[]; requireActive: boolean }

/**
 * Keep the newest row of each name in the TARGET set; delete the superseded older duplicates there (never elsewhere).
 * On a sys_updated_on tie a row that did not exist before the activation (`preexisting`) wins over one that did.
 * For the flow's parent row (`parent.name`) the kept row's payload is read FIRST: it must hold every planned sys_id
 * and, when `parent.requireActive`, show <active>true</active> on the sys_hub_flow element — the checks the
 * superseded load row already passed. Otherwise nothing is deleted for that name (reported in `refused`).
 */
async function removeTargetDuplicates(client: ServiceNowClient, updateSetSysId: string, names: string[], preexisting: Set<string>, parent: ParentDuplicateCheck): Promise<{ removed: RemovedDuplicate[]; refused: RefusedDuplicate[] }> {
  const removed: RemovedDuplicate[] = [];
  const refused: RefusedDuplicate[] = [];
  for (const name of [...new Set(names)]) {
    const r = await client.queryRecords({ table: 'sys_update_xml', query: `update_set=${updateSetSysId}^name=${name}`, fields: 'sys_id,update_set,sys_updated_on,sys_mod_count,sys_created_on', limit: 10 });
    const rows = newestFirst(r.records as Record<string, unknown>[])
      .sort((a, b) => str(b.sys_updated_on).localeCompare(str(a.sys_updated_on)) || Number(preexisting.has(str(a.sys_id))) - Number(preexisting.has(str(b.sys_id))));
    if (rows.length < 2) continue;
    const kept = str(rows[0].sys_id);
    const superseded = rows.slice(1).map(o => str(o.sys_id));
    if (name === parent.name) {
      let payload = '';
      let readError: string | undefined;
      try { payload = str((await client.getRecord('sys_update_xml', kept, 'sys_id,payload')).payload); } catch (e) { readError = errText(e); }
      const missing = parent.plannedIds.filter(id => !payload.includes(`<sys_id>${id}</sys_id>`));
      const activeInPayload = flowElementActive(payload);
      if (readError || missing.length || (parent.requireActive && !activeInPayload)) {
        const why = readError
          ? `the newer row's payload could not be read (${readError})`
          : [missing.length ? `the newer row lacks ${missing.length} planned row(s)` : '', parent.requireActive && !activeInPayload ? 'the newer row does not show <active>true</active> on sys_hub_flow' : ''].filter(Boolean).join('; ');
        refused.push({ name, kept, superseded, missing, activeInPayload, reason: `${why} — superseded row(s) NOT deleted; both left in "${updateSetSysId}"` });
        continue;
      }
    }
    for (const old of rows.slice(1)) {
      const entry: RemovedDuplicate = { name, kept, deleted: str(old.sys_id), deleted_updated_on: str(old.sys_updated_on), ok: true };
      try { await client.deleteRecord('sys_update_xml', entry.deleted); } catch (e) { entry.ok = false; entry.message = errText(e); }
      removed.push(entry);
    }
  }
  return { removed, refused };
}

// ─── loadPlan ─────────────────────────────────────────────────────────────────

export async function loadPlan(client: ServiceNowClient, plan: RecordPlan, opts: LoadOptions): Promise<FlowLoadResult> {
  requireClientCapabilities(client, ['queryRecords', 'getRecord', 'postMultipart', 'requestJson', ...(opts.activate ? ['createRecord', 'updateRecord', 'deleteRecord', 'getConfiguredUsername'] : [])]);
  if (opts.deleteStale && (!Array.isArray(opts.confirmDelete) || opts.confirmDelete.length === 0)) {
    throw new ServiceNowError('deleteStale requires confirmDelete to list every sys_id that may be deleted', 'INVALID_REQUEST');
  }
  const rows = checkedPlanRows(plan);
  const flowSysId = plan.flow.sys_id;
  const warnings: string[] = [...(plan.warnings ?? [])];

  // 1. update set + scope (read-only; refused before anything is sent)
  const updateSet = await resolveUpdateSet(client, opts.updateSet);
  const scopeField = str(plan.flow.fields.sys_scope) || 'global';
  const scope = await resolveScope(client, scopeField);
  assertUpdateSetMatchesScope(updateSet, scope);
  if (scope.scope !== 'global' && !opts.allowScopedUnverified) {
    throw new ServiceNowError(
      `flow ${flowSysId} is in scope ${scope.scope} (${scope.sys_id}) — scoped flows are refused on the loader path until the scoped <sys_scope display_value="<scope>"><sys_id></sys_scope> form and the scoped loader call are proven on a PDI; build a global flow. Nothing was sent.`,
      'FLOW_BUILDER_LOADER_SCOPED_REFUSED',
      { flowSysId, scope }
    );
  }
  const scopeId = scope.scope === 'global' ? 'global' : scope.sys_id;
  // activate:true — the preference owner (read-only here; the preferences are touched only around activate_flows)
  const sessionUser = opts.activate ? await resolveSessionUser(client) : undefined;

  // 2. read-only pre-checks
  const byTable = new Map<string, string[]>();
  for (const r of rows) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.sys_id]);
  const exists = new Set<string>();
  for (const [table, ids] of byTable) for (const id of await existingIds(client, table, ids)) exists.add(id);
  if (opts.mode === 'create' && exists.size > 0) {
    throw new ServiceNowError(
      `mode:'create' but ${exists.size} planned row(s) already exist on the instance (flow ${flowSysId}${exists.has(flowSysId) ? ' included' : ''}) — use mode:'update'`,
      'FLOW_BUILDER_ROWS_EXIST',
      { existing: rows.filter(r => exists.has(r.sys_id)).map(r => ({ table: r.table, sys_id: r.sys_id })) }
    );
  }
  const previousFlowState = exists.has(flowSysId) ? await checkActiveFlow(client, flowSysId, opts, warnings) : undefined;
  const plannedIds = new Set(rows.map(r => r.sys_id));
  const existedBefore = await childRowsOnInstance(client, flowSysId);
  // platform-managed trigger inputs of a record-triggered flow: never stale, never confirmation-gated
  const recordTriggered = isRecordTriggeredFlow(plan);
  const managedBefore = recordTriggered ? await platformManagedInputs(client, flowSysId, plannedIds) : [];
  const managedIds = new Set(managedBefore.map(m => m.sys_id));
  const staleBefore = existedBefore.filter(r => !plannedIds.has(r.sys_id) && !managedIds.has(r.sys_id));

  // 3. the document, and the deletes the loader will apply. A child table the plan leaves EMPTY but that
  //    still holds (non-platform-managed) rows of this flow gets its own delete_multiple.
  const cleanedTables = CHILD_TABLES.filter(t => !byTable.has(t) && staleBefore.some(s => s.table === t));
  const loadable = withScopeSysId(plan, scopeField, scope);
  const xml = planToRecordUpdateXml(loadable, { scope: { sys_id: scope.sys_id, scope: scope.scope }, cleanTables: cleanedTables });
  const deleteMultiple = listDeleteMultiples(xml);
  const childDeletes = deleteMultiple.filter(d => isChildCleanup(d, flowSysId));
  const aliasDeletes = deleteMultiple.filter(d => d.table === ALIAS_TABLE && /^source_id=[0-9a-f]{32}$/.test(d.query));
  const unexpected = deleteMultiple.filter(d => !childDeletes.includes(d) && !aliasDeletes.includes(d));
  if (unexpected.length) {
    throw new ServiceNowError(`the document carries delete_multiple elements outside the flow's child tables: ${unexpected.map(d => `${d.table} ${d.query}`).join('; ')} — refusing; nothing was sent`, 'FLOW_BUILDER_INVALID_PLAN', { unexpected });
  }
  const childDeleteTables = new Set(childDeletes.map(d => d.table));
  const wouldDelete = staleBefore.filter(r => childDeleteTables.has(r.table));
  const confirmed = new Set(opts.deleteStale ? opts.confirmDelete : []);
  const unconfirmed = wouldDelete.filter(r => !confirmed.has(r.sys_id));
  if (unconfirmed.length > 0) {
    throw new ServiceNowError(
      `the loader would DELETE ${wouldDelete.length} existing child row(s) of flow ${flowSysId} that the plan does not carry (delete_multiple flow=/model=<id>[^sys_idNOT IN<planned>]); ${unconfirmed.length} of them are not confirmed — pass delete_stale:true and list every one in confirm_delete, or add them to the spec. Nothing was sent.`,
      'FLOW_BUILDER_LOADER_WOULD_DELETE',
      { wouldDelete, unconfirmed, cleanedTables, platformManaged: managedBefore }
    );
  }
  const survivors = staleBefore.filter(r => !childDeleteTables.has(r.table));
  if (survivors.length) warnings.push(`${survivors.length} STALE row(s) sit in tables the load does not clean (no delete_multiple for them; kept): ${survivors.map(s => `${s.table}/${s.sys_id}`).join(', ')}`);
  const notDeletable = [...confirmed].filter(id => !wouldDelete.some(w => w.sys_id === id));
  if (notDeletable.length) warnings.push(`confirm_delete lists ${notDeletable.length} sys_id(s) the load will not delete (not a stale child row in a cleaned table): ${notDeletable.join(', ')}`);

  // housekeeping: the alias-mapping cleanup of our own planned instances (as the platform capture of a flow carries it)
  const aliasSources = aliasDeletes.map(d => d.query.slice('source_id='.length));
  const housekeepingDeletes: FlowLoadResult['housekeepingDeletes'] = [];
  for (const part of chunk(aliasSources, ID_CHUNK)) {
    const found = await client.queryRecords({ table: ALIAS_TABLE, query: `source_idIN${part.join(',')}`, fields: 'sys_id,source_id', limit: 1000 });
    for (const rec of found.records) housekeepingDeletes.push({ table: ALIAS_TABLE, sys_id: str(rec.sys_id), source_id: str(rec.source_id) });
  }
  if (housekeepingDeletes.length) warnings.push(`the loader's housekeeping delete_multiple (sys_hub_alias_mapping source_id=<planned instance>, as the platform's capture of a flow carries it) removes ${housekeepingDeletes.length} alias-mapping row(s) of the planned instances: ${housekeepingDeletes.map(h => h.sys_id).join(', ')}`);

  // the target set's parent capture row BEFORE the load (change detection)
  const captureBefore = await captureRowState(client, updateSet.sys_id, flowSysId);

  // 4. POST to the loader
  const path = `${LOADER_LOAD_PATH}/${encodeURIComponent(scopeId)}`;
  const file = { field: LOADER_PART_NAME, filename: `sys_hub_flow_${flowSysId}.xml`, content: xml, contentType: 'application/xml' };
  const loader: LoaderCall = {
    path,
    scopeId,
    targetUpdateSetId: updateSet.sys_id,
    file: { field: file.field, filename: file.filename, contentType: file.contentType, bytes: Buffer.byteLength(xml, 'utf8') },
    deleteMultiple,
  };
  const failDetails = (extra: Record<string, unknown> = {}) => ({ flowSysId, updateSet: { sys_id: updateSet.sys_id, name: updateSet.name }, scope, loader, ...extra });
  let response: MultipartResponse;
  try {
    response = await client.postMultipart(path, [file], { targetUpdateSetId: updateSet.sys_id }, opts.timeoutMs ?? LOADER_TIMEOUT_MS);
  } catch (e) {
    throw new ServiceNowError(
      `the loader call failed before a response (${errText(e)}) — the load may or may not have been applied; run snow_flow_verify before retrying`,
      'FLOW_BUILDER_LOADER_FAILED',
      failDetails({ cause: e instanceof ServiceNowError ? e.code : undefined })
    );
  }
  loader.http_status = response.status;
  loader.response = response.json ?? response.text;
  loader.returnedUpdateSetId = returnedUpdateSetId(response);
  if (!response.ok || hasResultError(response)) {
    const text = loaderErrorText(response);
    const raw = `${text} ${response.text ?? ''} ${response.json ? JSON.stringify(response.json) : ''}`;
    if (response.status === 404 || (response.status === 400 && /does not represent any resource/i.test(raw))) {
      throw new ServiceNowError(
        `the ServiceNow IDE loader (${LOADER_LOAD_PATH}) is not available on this instance (HTTP ${response.status}: ${text}) — install / update the ServiceNow IDE (sn_glider) plugin; nothing was loaded`,
        'FLOW_BUILDER_LOADER_UNAVAILABLE',
        failDetails()
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ServiceNowError(
        `the loader refused the credentials (HTTP ${response.status}: ${text}) — the endpoint may not accept this auth method (Basic/OAuth) or the user lacks the role; nothing was loaded`,
        'FLOW_BUILDER_LOADER_AUTH_REFUSED',
        failDetails()
      );
    }
    throw new ServiceNowError(
      `the loader returned ${response.ok ? `HTTP ${response.status} with result.error` : `HTTP ${response.status}`}: ${text} — the load may be partially applied; run snow_flow_verify`,
      'FLOW_BUILDER_LOADER_FAILED',
      failDetails({ body: response.json ?? response.text })
    );
  }
  // A 2xx is only a loader answer when it is JSON naming the target set (an SSO / login page is a 200 too).
  if (response.json === undefined || response.json === null || typeof response.json !== 'object') {
    throw new ServiceNowError(
      `the loader answered HTTP ${response.status} without a JSON body (${(response.text ?? '').slice(0, 120).replace(/\s+/g, ' ') || '<empty>'}) — probably a login / SSO page, not the loader; the load may or may not have been applied; run snow_flow_verify`,
      'FLOW_BUILDER_LOADER_FAILED',
      failDetails({ body: response.text })
    );
  }
  if (!loader.returnedUpdateSetId) {
    throw new ServiceNowError(
      `the loader answered HTTP ${response.status} without result.targetUpdateSetId — not a recognised loader response; the load may or may not have been applied; run snow_flow_verify`,
      'FLOW_BUILDER_LOADER_FAILED',
      failDetails({ body: response.json })
    );
  }
  if (loader.returnedUpdateSetId !== updateSet.sys_id) {
    throw new ServiceNowError(
      `the loader answered targetUpdateSetId=${loader.returnedUpdateSetId}, not the target ${updateSet.sys_id} ("${updateSet.name}") — the load went to another update set; run snow_flow_verify and move the capture before promoting`,
      'FLOW_BUILDER_LOADER_FAILED',
      failDetails({ body: response.json })
    );
  }

  // 5. verify by read-back
  let flowState: FlowLoadResult['flowState'];
  try {
    const f = await client.getRecord('sys_hub_flow', flowSysId, FLOW_STATE_FIELDS);
    flowState = { version: str(f.version), status: str(f.status), active: str(f.active), latest_snapshot: str(f.latest_snapshot) };
  } catch (e) {
    if (!(e instanceof ServiceNowError && e.code === 'NOT_FOUND')) throw e;
  }
  const present = new Set<string>();
  for (const [table, ids] of byTable) for (const id of await existingIds(client, table, ids)) present.add(id);
  const planned = rows.map(r => ({ table: r.table, sys_id: r.sys_id }));
  const missing = planned.filter(r => !present.has(r.sys_id));
  const written: WrittenRow[] = planned.filter(r => present.has(r.sys_id)).map(r => ({ ...r, action: exists.has(r.sys_id) ? 'updated' : 'inserted' }));
  const after = await childRowsOnInstance(client, flowSysId);
  const afterIds = new Set(after.map(r => r.sys_id));
  const managedAfter = recordTriggered ? await platformManagedInputs(client, flowSysId, plannedIds) : [];
  const managedAfterIds = new Set(managedAfter.map(m => m.sys_id));
  const platformManaged: PlatformManagedRow[] = [
    ...managedBefore.map(m => ({ ...m, classification: 'platform_managed' as const, fate: (managedAfterIds.has(m.sys_id) ? 'kept' : 'deleted_by_load') as PlatformManagedRow['fate'] })),
    ...managedAfter.filter(m => !managedIds.has(m.sys_id)).map(m => ({ ...m, classification: 'platform_managed' as const, fate: 'created_by_load' as const })),
  ];
  const stale = after.filter(r => !plannedIds.has(r.sys_id) && !managedIds.has(r.sys_id) && !managedAfterIds.has(r.sys_id));
  const staleChildren = stale.filter(r => CHILD_TABLES.includes(r.table));
  const deleted = staleBefore.filter(r => !afterIds.has(r.sys_id));
  const absentColumns: string[] = [];
  const fieldDiffs = opts.mode === 'update' && missing.length === 0 ? await planFieldDiffs(client, loadable, absentColumns) : [];
  if (absentColumns.length) warnings.push(`planned column(s) that do not exist on this instance were not stored (loader ignores them; not a mismatch): ${absentColumns.join(', ')}`);
  const capture = await verifyCapture(client, updateSet.sys_id, flowSysId, planned);
  const captureAfterLoad = await captureRowState(client, updateSet.sys_id, flowSysId);
  const captureRow = { ...(captureBefore ? { before: captureBefore } : {}), ...(captureAfterLoad ? { after: captureAfterLoad } : {}), changed: captureRowChanged(captureBefore, captureAfterLoad) };
  const captureOk = (c: FlowCaptureVerification) => c.ok && c.mode === 'parent_row';
  const captureText = (c: FlowCaptureVerification) => `mode=${c.mode}, found ${c.found}/${c.expected}${c.missing.length ? `, missing ${c.missing.length}` : ''}${c.otherUpdateSets.length ? `; a sys_hub_flow_${flowSysId} row exists in other update set(s): ${c.otherUpdateSets.join(', ')}` : ''}`;
  const versionOk = flowState?.version === '2';
  const staleDocs = stale.filter(r => !CHILD_TABLES.includes(r.table));
  if (staleDocs.length) warnings.push(`${staleDocs.length} STALE sys_documentation row(s) remain (not flow=/model= keyed, so no delete_multiple cleans them): ${staleDocs.map(s => `${s.table}/${s.sys_id}`).join(', ')}`);
  if (deleted.length) warnings.push(`the loader deleted ${deleted.length} confirmed STALE row(s): ${deleted.map(s => `${s.table}/${s.sys_id}`).join(', ')}`);
  if (platformManaged.length) {
    warnings.push(`${platformManaged.length} platform-managed row(s) of the record trigger (sys_hub_flow_input current / table_name + documentation) left to the platform, not counted as stale: ${platformManaged.map(p => `${p.table}/${p.element}/${p.sys_id} (${p.fate})`).join(', ')}`);
  }

  let activation: FlowActivationResult = { requested: false, attempted: false, ok: false };
  let activationCapture: ActivationCaptureCheck | undefined;
  let activationPreferences: ActivationPreferences | undefined;
  const verified = missing.length === 0 && versionOk && captureOk(capture) && captureRow.changed && fieldDiffs.length === 0 && staleChildren.length === 0;
  const activationText = () => !opts.activate ? 'not requested (flow is draft/inactive)' : !activation.attempted ? 'NOT attempted' : activation.ok ? 'OK' : 'FAILED';
  const preferenceText = () => !activationPreferences
    ? 'no sys_user_preference writes'
    : `sys_user_preference ${ACTIVATION_PREFERENCES.join(' / ')} set only around activate_flows and ${activationPreferences.restored ? 'restored' : 'NOT restored'}`;
  const assemble = (): FlowLoadResult => ({
    transport: 'loader',
    flowSysId,
    updateSet: { sys_id: updateSet.sys_id, name: updateSet.name },
    scope,
    mode: opts.mode,
    preferences: [],
    preferencesNote: activationPreferences ? ACTIVATION_PREFERENCE_NOTE : LOADER_PREFERENCE_NOTE,
    ...(activationPreferences ? { activationPreferences } : {}),
    loader,
    planned,
    written,
    missing,
    ...(flowState ? { flowState } : {}),
    existedBefore,
    stale,
    deleted,
    platformManaged,
    cleanedTables,
    housekeepingDeletes,
    captureRow,
    fieldDiffs,
    capture,
    activation,
    ...(activationCapture ? { activationCapture } : {}),
    ...(previousFlowState ? { previousFlowState } : {}),
    summary: `flow ${str(plan.flow.fields.name) || flowSysId} (${flowSysId}) loaded via ${path} into update set "${updateSet.name}": ${written.filter(w => w.action === 'inserted').length} inserted, ${written.filter(w => w.action === 'updated').length} updated, ${missing.length} missing, ${deleted.length} deleted, ${stale.length} stale${platformManaged.length ? `, ${platformManaged.length} platform-managed` : ''}; version=${flowState?.version ?? '<no flow>'}; capture ${captureOk(capture) && captureRow.changed ? 'verified' : 'NOT verified'} (${capture.mode}, ${capture.found}/${capture.expected}${captureRow.changed ? '' : ', parent row unchanged'}); activation ${activationText()}${activationCapture ? ` (activation capture ${activationCapture.ok ? 'verified' : 'NOT verified'}${activationCapture.moved.length ? `, ${activationCapture.moved.length} row(s) moved into the target set` : ''}${activationCapture.duplicatesRemoved.length ? `, ${activationCapture.duplicatesRemoved.length} superseded duplicate(s) removed` : ''})` : ''}; ${preferenceText()}`,
    warnings,
  });

  if (!verified) {
    if (opts.activate) activation = { requested: true, attempted: false, ok: false, message: 'not attempted: the load was not verified' };
    if (missing.length > 0) {
      throw new ServiceNowError(
        `the loader answered HTTP ${response.status} but ${missing.length} planned row(s) are not on the instance${flowState ? '' : ' (sys_hub_flow itself is missing)'}: ${missing.slice(0, 10).map(m => `${m.table}/${m.sys_id}`).join(', ')}${missing.length > 10 ? ' …' : ''}`,
        'FLOW_BUILDER_LOADER_ROWS_MISSING',
        assemble()
      );
    }
    if (!versionOk) {
      throw new ServiceNowError(
        `flow ${flowSysId} was loaded but sys_hub_flow.version is "${flowState?.version ?? ''}", not "2" — Flow Designer would ignore the *_v2 rows; do not use this flow`,
        'FLOW_BUILDER_LOADER_VERSION_MISMATCH',
        assemble()
      );
    }
    if (!captureOk(capture)) {
      throw new ServiceNowError(
        `flow loaded but the update-set capture is NOT verified in "${updateSet.name}" (${captureText(capture)}) — expected ONE sys_update_xml sys_hub_flow_${flowSysId} whose payload holds every planned row`,
        'FLOW_BUILDER_CAPTURE_NOT_VERIFIED',
        assemble()
      );
    }
    if (!captureRow.changed) {
      throw new ServiceNowError(
        `the loader answered HTTP ${response.status}, but the target set's capture row sys_hub_flow_${flowSysId} did not change during this load (sys_updated_on / payload_hash / sys_mod_count as before) — the load applied nothing, or an earlier load is what the checks see. If the spec is unchanged since the last load there is nothing to load; otherwise run snow_flow_verify`,
        'FLOW_BUILDER_LOADER_NOT_APPLIED',
        assemble()
      );
    }
    if (fieldDiffs.length > 0) {
      throw new ServiceNowError(
        `flow loaded (mode:'update') but ${fieldDiffs.length} planned field(s) differ from the instance: ${fieldDiffs.slice(0, 8).map(d => `${d.table}/${d.sys_id}.${d.field}`).join(', ')}${fieldDiffs.length > 8 ? ' …' : ''} — the instance does not match the spec`,
        'FLOW_BUILDER_LOADER_READBACK_MISMATCH',
        assemble()
      );
    }
    throw new ServiceNowError(
      `flow loaded but ${staleChildren.length} unplanned child row(s) remain attached to it: ${staleChildren.map(s => `${s.table}/${s.sys_id}`).join(', ')} — the flow on the instance does not match the spec`,
      'FLOW_BUILDER_LOADER_STALE_ROWS',
      assemble()
    );
  }

  // 7. activation (the tool has already passed requireFlowBuilderActivate()). activate_flows has no
  //    targetUpdateSetId and captures where the user's GLOBAL update-set preference points (PDI finding 1):
  //    the preferences are set to the target only around the call and restored, then a safety net moves the
  //    user's own new rows that still landed elsewhere, and the target row must show the activation.
  if (opts.activate && sessionUser) {
    const user = sessionUser;
    // a. before-state
    const beforeActivation = await captureRowState(client, updateSet.sys_id, flowSysId);
    const prevSnapshot = flowState?.latest_snapshot ?? '';
    const beforeQueries = leakQueries(flowSysId, [prevSnapshot], planned);
    const othersBeforeSnap = await rowsOutsideTarget(client, updateSet.sys_id, beforeQueries);
    const othersBefore = othersBeforeSnap.rows;
    // Instance-side watermark: a row outside the target set is movable only if created at/after it. Start from the
    // load's capture row (server time, after the load); the preference writes below raise it to just before activation.
    let watermark = beforeActivation?.sys_updated_on ?? captureAfterLoad?.sys_updated_on ?? '';

    // a'. an incomplete before-snapshot cannot tell new rows from old ones: refuse the activation before any write
    if (othersBeforeSnap.truncated.length) {
      activation = { requested: true, attempted: false, ok: false, message: 'not attempted: the capture safety-net snapshot is incomplete (a query page came back full)' };
      activationCapture = { parentChanged: false, activeInPayload: false, leaks: [], moved: [], duplicatesRemoved: [], duplicatesRefused: [], watched: beforeQueries, truncated: othersBeforeSnap.truncated, watermark, ok: false };
      throw new ServiceNowError(
        `flow loaded, but activation was NOT attempted: ${othersBeforeSnap.truncated.length} safety-net quer${othersBeforeSnap.truncated.length === 1 ? 'y' : 'ies'} outside "${updateSet.name}" returned a full page of ${SAFETY_NET_PAGE} sys_update_xml rows (${othersBeforeSnap.truncated.join('; ')}) — rows the activation writes elsewhere could not be told apart from older ones. No preference was touched. Activate the flow in Workflow Studio with the target update set current, then check the capture by hand`,
        'FLOW_BUILDER_CAPTURE_NOT_VERIFIED',
        assemble()
      );
    }

    // b-d. preferences → activate_flows → restore (always)
    const prefTargets: Record<string, string> = { sys_update_set: updateSet.sys_id, 'apps.current_app': scope.sys_id };
    const entries: ActivationPreference[] = [];
    let phase: 'preferences' | 'activation' = 'preferences';
    let bracketError: string | undefined;
    try {
      for (const name of ACTIVATION_PREFERENCES) {
        const before = (await readPreference(client, user.sys_id, name)).state;
        const entry: ActivationPreference = { name, before, restore: { action: 'kept' }, after: before, restored: false };
        entries.push(entry);
        const s = await setPreference(client, user.sys_id, name, prefTargets[name], before);
        entry.set = s.set;
        if (s.stamp && s.stamp > watermark) watermark = s.stamp;
      }
      phase = 'activation';
      activation = await activateFlow(client, flowSysId, scope.sys_id);
    } catch (e) {
      bracketError = errText(e);
      activation = phase === 'preferences'
        ? { requested: true, attempted: false, ok: false, message: `not attempted: the activation preferences could not be set (${bracketError})` }
        : { requested: true, attempted: true, ok: false, message: `activate_flows / its read-back threw: ${bracketError}` };
    } finally {
      for (const entry of entries) await restorePreference(client, user.sys_id, entry);
    }
    activationPreferences = { user, entries, restored: entries.every(e => e.restored), note: ACTIVATION_PREFERENCE_NOTE };
    if (!activationPreferences.restored) {
      warnings.push(`activation preferences NOT restored: ${entries.filter(e => !e.restored).map(e => `${e.name} (before ${e.before.exists ? `"${e.before.value}"` : '<none>'}, now ${e.after.exists ? `"${e.after.value}"` : '<none>'}${e.restore.message ? `: ${e.restore.message}` : ''})`).join('; ')}`);
    }

    // e. safety net — rows that still landed OUTSIDE the target set during activation
    const newSnapshot = activation.read_back?.latest_snapshot ?? '';
    const watched = leakQueries(flowSysId, [prevSnapshot, newSnapshot], planned);
    const othersAfterSnap = phase === 'activation' ? await rowsOutsideTarget(client, updateSet.sys_id, watched) : { rows: [] as XmlRow[], truncated: [] as string[] };
    const othersAfter = othersAfterSnap.rows;
    const truncated = othersAfterSnap.truncated;
    const beforeById = new Map(othersBefore.map(b => [b.sys_id, b]));
    const leaks: CaptureLeak[] = [];
    const movable: XmlRow[] = [];
    for (const a of othersAfter) {
      const b = beforeById.get(a.sys_id);
      if (b) {
        // pre-existing in another set: never moved; a leak only when activation re-wrote it
        if (b.sys_updated_on !== a.sys_updated_on || b.sys_mod_count !== a.sys_mod_count || b.update_set !== a.update_set) leaks.push({ sys_id: a.sys_id, name: a.name, update_set: a.update_set, reason: 'pre_existing' });
        continue;
      }
      if (!a.sys_created_by || a.sys_created_by !== user.user_name) leaks.push({ sys_id: a.sys_id, name: a.name, update_set: a.update_set, reason: 'created_by_other_user' });
      // "absent from the before-snapshot" is not proof of "written by this activation": the row must also have been
      // created at/after the instance-side watermark taken just before activate_flows
      else if (!watermark || !a.sys_created_on || a.sys_created_on < watermark) leaks.push({ sys_id: a.sys_id, name: a.name, update_set: a.update_set, reason: 'created_before_activation', message: `sys_created_on ${a.sys_created_on || '<absent>'} is before the activation watermark ${watermark || '<unknown>'}` });
      else movable.push(a);
    }
    // an incomplete after-snapshot moves NOTHING: fail closed and leave every row where it is
    if (truncated.length) movable.length = 0;
    const moved: MovedCaptureRow[] = [];
    for (const m of movable) {
      try {
        await client.updateRecord('sys_update_xml', m.sys_id, { update_set: updateSet.sys_id });
        moved.push({ sys_id: m.sys_id, name: m.name, from_update_set: m.update_set, to_update_set: updateSet.sys_id });
      } catch (e) {
        leaks.push({ sys_id: m.sys_id, name: m.name, update_set: m.update_set, reason: 'move_failed', message: errText(e) });
      }
    }
    if (moved.length) warnings.push(`activation captured ${moved.length} row(s) outside "${updateSet.name}" (created by ${user.user_name} during activate_flows); moved into the target set: ${moved.map(m => `${m.name} from ${m.from_update_set}`).join(', ')}`);

    // f. one row per name in the TARGET set: keep the newer, delete the superseded older duplicate there only — and
    //    for the parent row only once the kept row is shown to hold every planned row (+ active when activated);
    //    otherwise nothing is deleted and the build fails closed below
    const dedup = phase === 'activation'
      ? await removeTargetDuplicates(client, updateSet.sys_id, [`sys_hub_flow_${flowSysId}`, ...moved.map(m => m.name)], new Set(beforeActivation ? [beforeActivation.sys_id] : []),
        { name: `sys_hub_flow_${flowSysId}`, plannedIds: planned.map(p => p.sys_id), requireActive: activation.ok })
      : { removed: [] as RemovedDuplicate[], refused: [] as RefusedDuplicate[] };
    const duplicatesRemoved = dedup.removed;
    const duplicatesRefused = dedup.refused;
    if (duplicatesRemoved.length) warnings.push(`superseded duplicate(s) in "${updateSet.name}": ${duplicatesRemoved.map(d => `${d.name} kept ${d.kept}, ${d.ok ? 'deleted' : `could NOT delete (${d.message})`} ${d.deleted}`).join('; ')}`);
    if (duplicatesRefused.length) warnings.push(`duplicate(s) in "${updateSet.name}" NOT removed: ${duplicatesRefused.map(d => `${d.name} newer ${d.kept} vs superseded ${d.superseded.join(', ')} — ${d.reason}`).join('; ')}`);

    // g. the target set must show the activation
    activation.capture_after = await verifyCapture(client, updateSet.sys_id, flowSysId, planned);
    const afterActivation = await captureRowState(client, updateSet.sys_id, flowSysId, true);
    const parentChanged = captureRowChanged(beforeActivation, stripPayload(afterActivation));
    const activeInPayload = flowElementActive(afterActivation?.payload);
    activationCapture = {
      parentChanged, activeInPayload, leaks, moved, duplicatesRemoved, duplicatesRefused, watched, truncated, watermark,
      ok: leaks.length === 0 && truncated.length === 0 && duplicatesRefused.length === 0 && (!activation.ok || (parentChanged && activeInPayload)) && captureOk(activation.capture_after),
    };
    if (!activation.ok) warnings.push(`activation FAILED: ${activation.message}`);

    if (phase === 'preferences') {
      throw new ServiceNowError(
        `flow loaded, but activation was NOT attempted: setting the activation preferences failed (${bracketError}); preferences ${activationPreferences.restored ? 'restored' : 'NOT restored'}`,
        'FLOW_BUILDER_ACTIVATION_PREFERENCE_FAILED',
        assemble()
      );
    }
    const problems: string[] = [];
    if (truncated.length) problems.push(`${truncated.length} safety-net quer${truncated.length === 1 ? 'y' : 'ies'} outside "${updateSet.name}" returned a full page of ${SAFETY_NET_PAGE} rows after activation (${truncated.join('; ')}) — new rows cannot be told from old ones, so NOTHING was moved; find this flow's rows outside the target set by hand`);
    if (duplicatesRefused.length) problems.push(`the target set holds two ${duplicatesRefused.map(d => d.name).join(', ')} rows and the newer one fails the capture check (${duplicatesRefused.map(d => `${d.kept}: ${d.reason}${d.missing.length ? ` — missing ${d.missing.slice(0, 5).join(', ')}${d.missing.length > 5 ? ' …' : ''}` : ''}`).join('; ')}); keep the complete row and remove the other by hand`);
    if (leaks.length) problems.push(`activation was captured OUTSIDE "${updateSet.name}" in row(s) that cannot be moved safely: ${leaks.map(l => `${l.name} (${l.sys_id}) in update set ${l.update_set} — ${l.reason}${l.message ? `: ${l.message}` : ''}`).join(', ')}`);
    if (activation.ok && !parentChanged) problems.push(`the target set's sys_hub_flow_${flowSysId} row did not change during activation`);
    if (activation.ok && parentChanged && !activeInPayload) problems.push(`the target set's sys_hub_flow_${flowSysId} payload does not show <active>true</active>`);
    if (!captureOk(activation.capture_after)) problems.push(`the planned rows are no longer all in the target set's parent row (${captureText(activation.capture_after)})`);
    if (problems.length) {
      warnings.push(`update-set capture NOT verified after activation: ${problems.join('; ')}`);
      throw new ServiceNowError(
        `flow loaded${activation.ok ? ' and ACTIVATED' : ''}, but the activation's update-set capture is NOT verified: ${problems.join('; ')} — move those sys_update_xml rows into "${updateSet.name}" by hand before promoting`,
        'FLOW_BUILDER_CAPTURE_NOT_VERIFIED',
        assemble()
      );
    }
    if (!activationPreferences.restored) {
      throw new ServiceNowError(
        `flow loaded${activation.ok ? ' and ACTIVATED' : ''} with a verified capture, but the user's sys_user_preference ${entries.filter(e => !e.restored).map(e => e.name).join(' / ')} could NOT be restored to the previous value — reset it by hand (see activationPreferences)`,
        'FLOW_BUILDER_PREFERENCE_NOT_RESTORED',
        assemble()
      );
    }
  }
  return assemble();
}

// ─── protocol description (shown by snow_flow_plan) ──────────────────────────

/** The exact steps loadPlan executes, in order — returned by snow_flow_plan (default transport). */
export function describeLoadProtocol(plan: RecordPlan, updateSet: { sys_id?: string; name?: string }): string[] {
  const target = updateSet.sys_id ? `sys_id=${updateSet.sys_id}` : updateSet.name ? `name="${updateSet.name}"` : '<update set to be named at build time>';
  const scope = String(plan.flow.fields.sys_scope ?? 'global') || 'global';
  const rowCount = 1 + (plan.trigger ? 1 : 0) + plan.variables.length + plan.documentation.length + plan.stages.length + plan.instances.length;
  return [
    `1. Resolve target update set (${target}); refuse unless state='in progress' AND is_default=false AND its application is the flow's application (scope "${scope}"). A scoped flow is refused (FLOW_BUILDER_LOADER_SCOPED_REFUSED) until the scoped loader path is proven on a PDI. activate:true only: resolve the authenticated user (configured username → sys_user, read-only).`,
    `2. Resolve scopeId: 'global' for a global flow, else the sys_scope sys_id of "${scope}".`,
    `3. Read-only pre-checks: the ${rowCount} planned sys_ids (mode create refuses existing rows); an ACTIVE existing flow is refused unless allow_deactivate:true; existing child rows the loader's delete_multiple would remove (including every row of a child table the spec now leaves empty) must each be confirmed (delete_stale:true + confirm_delete), else FLOW_BUILDER_LOADER_WOULD_DELETE before anything is sent. Record-triggered flows: the platform-managed sys_hub_flow_input rows current / table_name (+ documentation) are reported as platform_managed, never gated and never cleaned on their own account. Alias-mapping rows of the planned instances (the housekeeping delete the platform capture of a flow also carries) are counted and reported. The target set's sys_update_xml sys_hub_flow_<id> row is recorded.`,
    `4. POST ${LOADER_LOAD_PATH}/<scopeId>?targetUpdateSetId=<update set sys_id> as multipart/form-data (same Basic/OAuth auth as every call — Basic PDI-proven): one part "${LOADER_PART_NAME}" = sys_hub_flow_<flow sys_id>.xml (application/xml, the <record_update> document). No sys_user_preference is read or written for the load — capture goes by targetUpdateSetId. 404/400 "does not represent any resource" → FLOW_BUILDER_LOADER_UNAVAILABLE; 401/403 → FLOW_BUILDER_LOADER_AUTH_REFUSED; other non-2xx, a non-JSON 2xx, or a result.targetUpdateSetId missing / not the target → FLOW_BUILDER_LOADER_FAILED.`,
    '5. Verify by read-back (an ERROR, never a warning): every planned row exists by sys_id; sys_hub_flow.version = "2" (only the loader can set it); ONE sys_update_xml row sys_hub_flow_<id> in the target update set whose payload contains every planned sys_id (FLOW_BUILDER_CAPTURE_NOT_VERIFIED) and that row CHANGED during this load (FLOW_BUILDER_LOADER_NOT_APPLIED); mode update: every planned field equals the instance (FLOW_BUILDER_LOADER_READBACK_MISMATCH); no unplanned, non-platform-managed child row left attached (FLOW_BUILDER_LOADER_STALE_ROWS).',
    '6. Report child rows that existed before and are gone (deleted by the loader); stale sys_documentation rows are a warning.',
    '7. activate:true only: record the flow\'s sys_update_xml rows outside the target set; set the user\'s sys_user_preference sys_update_set = the target update set and apps.current_app = the flow scope (activate_flows follows the preference, not targetUpdateSetId); POST api/now/wfa_fluent/activate_flows?sysparm_transaction_scope=<sys_scope sys_id> (body {flows:[{sys_id,active:"",state:""}],actions:[]}) and read back sys_hub_flow.active/status/latest_snapshot; then ALWAYS restore both preferences to their previous state (reported before/after; FLOW_BUILDER_PREFERENCE_NOT_RESTORED otherwise). Rows of this flow created by the user in another update set during activation (absent from the before-snapshot AND sys_created_on at/after an instance-side watermark taken just before activate_flows) are moved into the target set; a pre-existing, foreign or older row is never moved (FLOW_BUILDER_CAPTURE_NOT_VERIFIED); a safety-net query page that comes back full refuses the activation beforehand, or moves nothing afterwards (FLOW_BUILDER_CAPTURE_NOT_VERIFIED); a superseded older duplicate in the target set is deleted only after the kept row is read and shown to hold every planned row (and <active>true</active>) — otherwise both rows stay and the build fails (FLOW_BUILDER_CAPTURE_NOT_VERIFIED); the target set\'s sys_hub_flow_<id> row must change and show <active>true</active>.',
  ];
}
