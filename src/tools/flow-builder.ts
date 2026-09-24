/**
 * Flow Builder tools — spec-driven Flow Designer flow construction (src/flow-builder).
 *
 *   snow_flow_catalog_read  offline: triggers / actions / logic with input types  (FLOW_BUILDER_ENABLED)
 *   snow_flow_plan          dry run: parse + generate, decoded plan, §2.2 steps       (FLOW_BUILDER_ENABLED; instance optional for live checks)
 *   snow_flow_build         loader (default) or Table-API writer, verified capture   (FLOW_BUILDER_ENABLED + WRITE_ENABLED; activate:true also FLOW_BUILDER_ACTIVATE_ENABLED)
 *   snow_flow_verify        read-only read-back of a written flow                     (FLOW_BUILDER_ENABLED)
 *   snow_flow_export_xml    offline XML file under FLOW_BUILDER_EXPORT_ROOT           (FLOW_BUILDER_ENABLED)
 *
 * Every instance-bound tool REQUIRES an explicit `instance` and re-resolves the client through
 * guards.resolveInstanceOrThrow (allow list + deny pattern, deny wins). The router-passed client
 * is never used for instance work.
 *
 * Owner: SCAFFOLD (manifest, dispatcher, argument validation, decode-for-review) → WRITER (fills the
 * writer/verify/unload stubs the handlers call) / GENERATOR (generatePlan, readCatalog).
 */
import { writeFileSync } from 'node:fs';
import type { ServiceNowClient } from '../servicenow/client.js';
import { ServiceNowError } from '../utils/errors.js';
import { requireWrite } from '../utils/permissions.js';
import { requireFlowBuilder, requireFlowBuilderActivate, requireDirectMcpInvocation, resolveInstanceOrThrow, resolveExportPath } from '../flow-builder/guards.js';
import { parseSpec } from '../flow-builder/spec/schema.js';
import type { FlowSpec, GenerateOptions, RecordPlan, RecordRow, Step, WriteOptions } from '../flow-builder/spec/types.js';
import { generatePlan, readCatalog, type GeneratorExtras } from '../flow-builder/generator/index.js';
import { instanceResolvers } from '../flow-builder/resolvers.js';
import { planToRecordUpdateXml } from '../flow-builder/xml/record-update.js';
import { planToUnloadXml, listDeleteMultiples } from '../flow-builder/xml/unload.js';
import { writePlan, verifyFlow, describeCaptureProtocol } from '../flow-builder/writer/index.js';
import { loadPlan, describeLoadProtocol, isRecordTriggeredFlow, PLATFORM_MANAGED_INPUT_ELEMENTS } from '../flow-builder/writer/loader.js';
import { decodeValues, looksLikeGzipB64 } from '../flow-builder/encode.js';
import { sysIdFor, ELEMENT_KEYS } from '../flow-builder/ids.js';

export const FLOW_BUILDER_TOOL_NAMES = [
  'snow_flow_catalog_read',
  'snow_flow_plan',
  'snow_flow_build',
  'snow_flow_verify',
  'snow_flow_export_xml',
] as const;

export type FlowBuildTransport = 'loader' | 'table_api';

/** Carried in the description and in every table_api result (PDI findings, 24 Sep 2026). */
export const TABLE_API_TRANSPORT_WARNING =
  "transport 'table_api': sys_hub_flow.version cannot be set over the Table API (write ACL sys_hub_flow_base.version drops it), so a flow written this way stays version 1 — Flow Designer ignores its *_v2 rows and the update set captures only the flow row. It is NOT a usable Flow Designer flow; keep this transport for non-flow experiments / diagnostics and build real flows with transport 'loader' (the default).";

const SPEC_PROPERTY = {
  spec: {
    type: ['object', 'string'],
    description: 'FlowSpec v1 (JSON object or JSON string): { spec_version:"1", flow:{key,name,...}, trigger, variables?, stages?, steps:[...], error_handler? }. Symbolic pills only ({{trigger.current.number}}, {{steps.<key>.<Output>}}, {{loop.<key>.item}}, {{vars.<name>}}, {{static.<sys_id>}}). See src/flow-builder/README.md.',
  },
};

export function flowBuilderToolManifest() {
  return [
    {
      name: 'snow_flow_catalog_read',
      description: 'Read the offline Flow Builder catalogue — trigger, action and flow-logic definitions with their input types, defaults and outputs — so a build spec can be authored without guessing. Requires FLOW_BUILDER_ENABLED=true. Never contacts an instance.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional: a single catalogue name (e.g. "askForApproval", "record.created", "if"). Omit for the whole catalogue.' },
        },
        required: [],
      },
    },
    {
      name: 'snow_flow_plan',
      description: 'Dry run of a FlowSpec: validate, generate the record plan (sys_hub_flow, trigger, variables, stages, instances) with values/trigger_inputs DECODED for review, the label_cache, the pill table, the exact steps a build would execute (captureProtocol — by default the ServiceNow IDE loader path: POST api/fluent/load/<scope>?targetUpdateSetId=<set>, capture by targetUpdateSetId, no sys_user_preference writes for the load; with activate the preferences are set only around activate_flows and restored) and, when an instance is named, live checks. Never writes. A spec that parses but does not generate (e.g. a subflow / custom action missing or ambiguous on the instance, a missing mandatory input) returns ok:false, stage:"generate" with errors and warnings. ok:false with an unverified_approvers list when an approver pill has no verified type (build and export refuse such a spec until it is typed via flow.pill_types or a live dictionary read). Requires FLOW_BUILDER_ENABLED=true.',
      inputSchema: {
        type: 'object',
        properties: {
          ...SPEC_PROPERTY,
          instance: { type: 'string', description: 'Optional instance alias for live checks: dictionary-based pill typing, subflow / custom-action definitions resolved by sys_id or name with their typed inputs / outputs (missing or ambiguous = spec error), the action-type snapshot each catalogue action gets on that instance, the variables (typed outputs) of a Get Catalog Variables step, the instance time zone for a run_in (ISO-8601 run_in converted; a run_in that is not in the future is warned about), referenced sys_ids. Read-only. Subject to the allow list / deny pattern. Without it the plan uses the catalogue ids and says so in warnings.' },
          live: { type: 'boolean', description: 'Run the live checks (default true when instance is given).' },
          transport: { type: 'string', enum: ['loader', 'table_api'], description: 'Which build path captureProtocol describes: "loader" (default) or "table_api" (diagnostics only — flows stay version 1).' },
        },
        required: ['spec'],
      },
    },
    {
      name: 'snow_flow_build',
      description: 'Build the flow on the named instance from a FlowSpec. Default transport "loader" (PDI-proven 24 Sep 2026: accepts snow-mcp\'s Basic auth, yields a version-2 flow — only this path can set version 2 — captured as ONE sys_update_xml sys_hub_flow_<id>; activated flows run): POSTs the <record_update> XML document (multipart part "files") to the ServiceNow IDE loader api/fluent/load/<scope>?targetUpdateSetId=<update set> — the load is captured by targetUpdateSetId with NO sys_user_preference write — then verifies by read-back: every planned row exists, sys_hub_flow.version="2", ONE sys_update_xml sys_hub_flow_<id> in the target set holding every planned row and CHANGED by this load, in mode "update" every planned field equal to the instance, and no unplanned child row left attached — the platform-managed sys_hub_flow_input rows current / table_name of a record-triggered flow (and their documentation) are reported as platform_managed, never stale and never confirmation-gated (any failure is an ERROR; a non-JSON 2xx or a targetUpdateSetId other than the target set is FLOW_BUILDER_LOADER_FAILED). Scoped flows are refused on the loader path until proven on a PDI. activate:true: activate_flows follows the user\'s global update-set preference, not targetUpdateSetId, so the user\'s sys_update_set / apps.current_app preferences are set to the target set / flow scope ONLY around the activate_flows call and restored to their previous state right after (before/after in activationPreferences; FLOW_BUILDER_PREFERENCE_NOT_RESTORED if that fails); rows of this flow the user\'s activation still wrote into another update set are moved into the target set (only rows created during the activation by that user, at or after an instance-side watermark taken just before activate_flows — a pre-existing, older or foreign row is never moved and fails with FLOW_BUILDER_CAPTURE_NOT_VERIFIED; a full safety-net query page fails closed: the activation is refused beforehand, or nothing is moved afterwards), a superseded older duplicate in the target set is deleted only after the kept row is read and shown to hold every planned row and the active flag (otherwise both rows stay and the build fails with FLOW_BUILDER_CAPTURE_NOT_VERIFIED), and the target set\'s row must show the flow active. The loader applies the XML\'s delete_multiple itself, so existing child rows the spec no longer carries must be confirmed (delete_stale:true + confirm_delete) or the build is refused before sending. Transport "table_api" (diagnostics only): sets the sys_update_set preference and writes rows over the Table API — WARNING: a flow written that way stays version 1 (ACL sys_hub_flow_base.version) and is NOT usable by Flow Designer. The flow is written as draft/inactive (an existing ACTIVE flow is refused unless allow_deactivate:true); the update set must belong to the application of the flow; activate:true additionally requires FLOW_BUILDER_ACTIVATE_ENABLED=true and a separate approval. A scheduled.run_once run_in is read by the platform in the instance time zone (glide.sys.default.tz; the builder uses the authenticated user sys_user.time_zone when set — that precedence is unverified on a PDI and a differing user zone is a plan warning): an ISO-8601 run_in is converted to that local wall time, and a run_in that is not in the future is REFUSED (FLOW_BUILDER_RUN_IN_PAST — activation would fire the flow immediately) unless allow_past_run:true. Only callable directly by an MCP client over stdio — refused when nested in another tool (playbooks), over REST /api/tool or A2A. **[Write]** Requires FLOW_BUILDER_ENABLED=true and WRITE_ENABLED=true; `instance` is mandatory and must be allow-listed.',
      inputSchema: {
        type: 'object',
        properties: {
          ...SPEC_PROPERTY,
          instance: { type: 'string', description: 'Target instance alias (REQUIRED; never the current instance; must be in FLOW_BUILDER_ALLOWED_INSTANCES and not match any locally configured FLOW_BUILDER_DENY_PATTERN entry).' },
          update_set: {
            type: 'object',
            description: 'Target update set — { sys_id } or { name }. Must be "in progress" and NOT is_default.',
            properties: { sys_id: { type: 'string' }, name: { type: 'string' } },
          },
          transport: { type: 'string', enum: ['loader', 'table_api'], description: '"loader" (default): ServiceNow IDE loader, the only path that yields a usable (version 2) flow. "table_api": Table-API rows + preference capture — diagnostics only, the flow stays version 1 and Flow Designer does not use it.' },
          mode: { type: 'string', enum: ['create', 'update'], description: '"create" (default) refuses when any planned row already exists; "update" rewrites rows that already exist with the same deterministic sys_ids.' },
          activate: { type: 'boolean', description: 'Activate the flow after writing (default false). Needs FLOW_BUILDER_ACTIVATE_ENABLED=true; read-back of sys_hub_flow.active is mandatory. Loader transport: the only step that touches the user\'s sys_user_preference (sys_update_set / apps.current_app set around activate_flows, then restored).' },
          delete_stale: { type: 'boolean', description: 'Allow deleting child rows that exist on the instance but not in the plan (default false). Each sys_id must also be listed in confirm_delete. With the loader these are the rows its delete_multiple removes — an unconfirmed one refuses the build.' },
          confirm_delete: { type: 'array', items: { type: 'string' }, description: 'Explicit sys_ids that may be deleted when delete_stale is true.' },
          allow_deactivate: { type: 'boolean', description: 'mode "update" on a flow that is currently ACTIVE: the rewrite sets it to draft/inactive, so it is refused unless this is true (default false). Combine with activate:true to re-activate after writing.' },
          allow_past_run: { type: 'boolean', description: 'scheduled.run_once only: build even though run_in is not in the future in the instance time zone (default false — refused with FLOW_BUILDER_RUN_IN_PAST, because activating such a flow runs it immediately).' },
        },
        required: ['spec', 'instance', 'update_set'],
      },
    },
    {
      name: 'snow_flow_verify',
      description: 'Read-only read-back of a flow on the named instance: sys_hub_flow, trigger and *_instance_v2 rows, decoded values, diff against the plan (when a spec is given; if that spec no longer generates on the instance — e.g. its subflow was deleted — the flow is still read back without a diff, ok:false, with spec_errors), unresolved pills, missing sys_update_xml rows, recent sys_flow_context rows. Requires FLOW_BUILDER_ENABLED=true; `instance` is mandatory.',
      inputSchema: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: 'Target instance alias (REQUIRED).' },
          flow_sys_id: { type: 'string', description: 'sys_id of the flow to read back (or give spec).' },
          ...SPEC_PROPERTY,
        },
        required: ['instance'],
      },
    },
    {
      name: 'snow_flow_export_xml',
      description: 'Generate the flow offline and write it as XML under FLOW_BUILDER_EXPORT_ROOT: format "record_update" (the <record_update> document the loader applies) or "update_set" (Retrieved Update Set <unload> for Import Update Set from XML — the manual / no-REST channel). Never contacts an instance. The file carries platform-shaped delete_multiple elements (per child table flow=<id>^sys_idNOT IN<planned ids>, plus housekeeping deletes) that DELETE matching rows on import and are not shown by Preview: the result lists every one (delete_multiple). A spec that adopts an existing flow (flow.sys_id) is refused unless replace_existing:true. Approver pills must be typed (flow.pill_types) because export is offline. Requires FLOW_BUILDER_ENABLED=true.',
      inputSchema: {
        type: 'object',
        properties: {
          ...SPEC_PROPERTY,
          format: { type: 'string', enum: ['record_update', 'update_set'], description: 'Output format.' },
          update_set_name: { type: 'string', description: 'Name of the remote update set (required for format "update_set").' },
          description: { type: 'string', description: 'Optional description written on the remote update set (format "update_set").' },
          out_path: { type: 'string', description: 'Destination .xml file — relative to FLOW_BUILDER_EXPORT_ROOT, or absolute but inside it.' },
          replace_existing: { type: 'boolean', description: 'Required (true) when the spec sets flow.sys_id (adopts an existing flow): importing the file deletes every child row of that flow that the spec does not carry. Default false.' },
        },
        required: ['spec', 'format', 'out_path'],
      },
    },
  ];
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function parseSpecOrThrow(raw: unknown): FlowSpec {
  if (raw === undefined || raw === null) throw new ServiceNowError('spec is required', 'INVALID_REQUEST');
  const parsed = parseSpec(raw);
  if ('errors' in parsed) {
    throw new ServiceNowError(`spec is invalid (${parsed.errors.length} error${parsed.errors.length === 1 ? '' : 's'})`, 'FLOW_BUILDER_INVALID_SPEC', { errors: parsed.errors });
  }
  return parsed.spec;
}

/** The errors / warnings of a generator FLOW_BUILDER_INVALID_SPEC; undefined for any other failure. */
function specErrorsOf(e: unknown): { errors: string[]; warnings: string[] } | undefined {
  if (!(e instanceof ServiceNowError) || e.code !== 'FLOW_BUILDER_INVALID_SPEC') return undefined;
  const d = (e.details && typeof e.details === 'object' ? e.details : {}) as { errors?: unknown; warnings?: unknown };
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);
  const errors = list(d.errors);
  return { errors: errors.length ? errors : [e.message], warnings: list(d.warnings) };
}

function fieldStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v !== null && 'value' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>).value ?? '');
  return String(v);
}

/**
 * Live pill typing: walk `table` + dotted `path` through sys_dictionary (following super_class
 * for inherited fields and `reference` for dotted walks) and return the final internal type.
 * Read-only. Returns undefined when any segment cannot be resolved.
 */
export function makeDictionaryPillTypeResolver(client: ServiceNowClient): (table: string, path: string) => Promise<string | undefined> {
  const cache = new Map<string, { type: string; reference: string } | undefined>();

  async function fieldOf(table: string, field: string): Promise<{ type: string; reference: string } | undefined> {
    const key = `${table}.${field}`;
    if (cache.has(key)) return cache.get(key);
    let t = table;
    let found: { type: string; reference: string } | undefined;
    for (let hop = 0; hop < 16 && t; hop++) {
      const r = await client.queryRecords({ table: 'sys_dictionary', query: `name=${t}^element=${field}`, fields: 'internal_type,reference', limit: 1 });
      if (r.count > 0) {
        const rec = r.records[0] as Record<string, unknown>;
        found = { type: fieldStr(rec.internal_type), reference: fieldStr(rec.reference) };
        break;
      }
      const p = await client.queryRecords({ table: 'sys_db_object', query: `name=${t}`, fields: 'super_class.name', limit: 1 });
      t = p.count > 0 ? fieldStr((p.records[0] as Record<string, unknown>)['super_class.name']) : '';
    }
    cache.set(key, found);
    return found;
  }

  return async (table: string, path: string) => {
    const segs = path.split('.').filter(Boolean);
    let t = table;
    let last: { type: string; reference: string } | undefined;
    for (const seg of segs) {
      last = await fieldOf(t, seg);
      if (!last) return undefined;
      t = last.reference;
    }
    return last?.type;
  };
}

/**
 * Generator options for a LIVE instance (plan with an instance, build, verify): dictionary pill typing plus
 * the read-only definition resolvers — subflows / custom actions by sys_id or name with their declared,
 * typed inputs / outputs (missing or ambiguous = spec error), the per-instance action-type snapshot
 * (cached per instance per process), the instance time zone for a run_in (FORMAT-DECISIONS D17) and the
 * variables of a Get Catalog Variables step (D18). See src/flow-builder/resolvers.ts.
 */
export function liveGeneratorOptions(client: ServiceNowClient): GenerateOptions & GeneratorExtras {
  return { resolvePillType: makeDictionaryPillTypeResolver(client), ...instanceResolvers(client) };
}

/** Every step of a spec, depth-first (blocks, branches and the error handler included). */
function allSpecSteps(spec: FlowSpec): Step[] {
  const out: Step[] = [];
  const walk = (steps: Step[]): void => {
    for (const s of steps) {
      out.push(s);
      switch (s.kind) {
        case 'if': walk(s.then); for (const b of s.else_if ?? []) walk(b.steps); if (s.else) walk(s.else.steps); break;
        case 'for_each': case 'do_until': walk(s.steps); break;
        case 'try_catch': walk(s.try); walk(s.catch.steps); break;
        case 'do_in_parallel': for (const b of s.branches) walk(b.steps); break;
        default: break;
      }
    }
  };
  walk(spec.steps);
  if (spec.error_handler) walk(spec.error_handler.steps);
  return out;
}

/** Warning on an OFFLINE plan / export whose spec uses catalogue actions: their ids were not checked on an instance. */
export function offlineActionTypeWarning(what: 'plan' | 'export'): string {
  return `offline ${what}: action_type / action_type_parent of the catalogue actions are the catalogue ids (snapshot + definition read from the instance metadata the catalogue was built from) — not checked against an instance; ${what === 'plan' ? 'plan with an instance or build' : 'a snow_flow_plan with an instance shows'} the ids the instance resolves (sys_hub_action_type_snapshot)`;
}

/** Offline plan / export: keep the catalogue values and say so (only when the spec has catalogue action steps). */
function addOfflineWarnings(spec: FlowSpec, plan: RecordPlan, what: 'plan' | 'export'): void {
  if (!allSpecSteps(spec).some(s => s.kind === 'action')) return;
  const w = offlineActionTypeWarning(what);
  if (!plan.warnings.includes(w)) plan.warnings.push(w);
}

/** Decode gzip+base64 blobs and JSON strings on a row's fields for human review (never mutates the plan). */
export function decodeRowForReview(row: RecordRow): { table: string; sys_id: string; fields: Record<string, unknown> } {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row.fields)) {
    if (typeof v === 'string' && looksLikeGzipB64(v)) {
      try { fields[k] = { decoded: decodeValues(v) }; continue; } catch { /* fall through: keep raw */ }
    }
    if (k === 'label_cache' && typeof v === 'string' && v.startsWith('[')) {
      try { fields[k] = JSON.parse(v); continue; } catch { /* keep raw */ }
    }
    fields[k] = v;
  }
  return { table: row.table, sys_id: row.sys_id, fields };
}

export function decodePlanForReview(plan: RecordPlan) {
  return {
    flowKey: plan.flowKey,
    flow: decodeRowForReview(plan.flow),
    trigger: plan.trigger ? decodeRowForReview(plan.trigger) : undefined,
    variables: plan.variables.map(decodeRowForReview),
    documentation: plan.documentation.map(decodeRowForReview),
    stages: plan.stages.map(decodeRowForReview),
    instances: plan.instances.map(decodeRowForReview),
    labelCache: plan.labelCache,
    pills: plan.pills,
    warnings: plan.warnings,
    ...(plan.dateTimeInputs ? { dateTimeInputs: plan.dateTimeInputs } : {}),
  };
}

function countRows(plan: RecordPlan): number {
  return 1 + (plan.trigger ? 1 : 0) + plan.variables.length + plan.documentation.length + plan.stages.length + plan.instances.length;
}

// ─── live checks for snow_flow_plan (read-only) ──────────────────────────────

export interface LiveCheckResult {
  tables: { table: string; where: string; exists: boolean }[];
  references: { table: string; sys_id: string; where: string; exists: boolean | 'unknown_table' }[];
  flow: { sys_id: string; exists: boolean; name?: string; active?: string; status?: string };
  stale: { table: string; sys_id: string }[];
  sameName: { sys_id: string; name: string }[];
  problems: string[];
}

const SYS_ID_RE = /^[0-9a-f]{32}$/;

/** Walk a spec value tree collecting table names (from `table`/`table_name` inputs and {reference,table}) and referenced sys_ids. */
function collectSpecReferences(spec: FlowSpec): { tables: Map<string, string>; refs: { table?: string; sys_id: string; where: string }[] } {
  const tables = new Map<string, string>();
  const refs: { table?: string; sys_id: string; where: string }[] = [];
  const trig = spec.trigger as unknown as Record<string, unknown> | undefined;
  if (trig && typeof trig.table === 'string' && trig.table) tables.set(trig.table, 'trigger.table');

  const visitValue = (v: unknown, where: string): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{\{\s*static\.([0-9a-f]{32})\s*\}\}/g)) refs.push({ sys_id: m[1], where });
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => visitValue(x, `${where}[${i}]`)); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    for (const k of ['text', 'conditions', 'script']) if (typeof o[k] === 'string') visitValue(o[k], `${where}.${k}`);
    if (typeof o.reference === 'string' && SYS_ID_RE.test(o.reference)) refs.push({ table: typeof o.table === 'string' ? o.table : undefined, sys_id: o.reference, where });
    if (typeof o.pill === 'string') { const m = /^static\.([0-9a-f]{32})$/.exec(o.pill); if (m) refs.push({ sys_id: m[1], where }); }
    if (o.template && typeof o.template === 'object') for (const [k, x] of Object.entries(o.template as Record<string, unknown>)) visitValue(x, `${where}.template.${k}`);
    if (Array.isArray(o.list)) visitValue(o.list, `${where}.list`);
  };

  const visitSteps = (steps: unknown, where: string): void => {
    if (!Array.isArray(steps)) return;
    steps.forEach((s, i) => {
      const step = s as Record<string, unknown>;
      const here = `${where}[${i}]${typeof step.key === 'string' ? `(${step.key})` : ''}`;
      const inputs = step.inputs as Record<string, unknown> | undefined;
      if (inputs && typeof inputs === 'object') {
        for (const [name, val] of Object.entries(inputs)) {
          if ((name === 'table' || name === 'table_name' || name === 'ah_table_name') && typeof val === 'string' && /^[a-z][a-z0-9_]*$/.test(val)) tables.set(val, `${here}.inputs.${name}`);
          visitValue(val, `${here}.inputs.${name}`);
        }
      }
      // DefinitionRef = {sys_id} | {name, scope?}: only a sys_id can be checked live
      for (const [k, table] of [['subflow', 'sys_hub_flow'], ['definition', 'sys_hub_action_type_definition']] as const) {
        const ref = step[k] as Record<string, unknown> | undefined;
        if (ref && typeof ref === 'object' && typeof ref.sys_id === 'string' && SYS_ID_RE.test(ref.sys_id)) refs.push({ table, sys_id: ref.sys_id, where: `${here}.${k}` });
      }
      // nested step arrays per the FlowSpec v1 step shapes
      for (const k of ['steps', 'then', 'try']) if (Array.isArray(step[k])) visitSteps(step[k], `${here}.${k}`);
      for (const k of ['else', 'catch']) { const b = step[k] as Record<string, unknown> | undefined; if (b && Array.isArray(b.steps)) visitSteps(b.steps, `${here}.${k}.steps`); }
      for (const k of ['else_if', 'branches']) {
        if (Array.isArray(step[k])) (step[k] as unknown[]).forEach((b, j) => { const br = b as Record<string, unknown>; if (Array.isArray(br.steps)) visitSteps(br.steps, `${here}.${k}[${j}].steps`); });
      }
    });
  };
  visitSteps((spec as unknown as Record<string, unknown>).steps, 'steps');
  const eh = (spec as unknown as Record<string, unknown>).error_handler as Record<string, unknown> | undefined;
  if (eh && Array.isArray(eh.steps)) visitSteps(eh.steps, 'error_handler.steps');
  return { tables, refs };
}

/**
 * Read-only live checks for snow_flow_plan: table existence (sys_db_object), referenced sys_ids,
 * whether the planned flow already exists (and its STALE child rows), and same-name flows.
 */
export async function runLiveChecks(client: ServiceNowClient, spec: FlowSpec, plan: RecordPlan): Promise<LiveCheckResult> {
  const { tables, refs } = collectSpecReferences(spec);
  const out: LiveCheckResult = { tables: [], references: [], flow: { sys_id: plan.flow.sys_id, exists: false }, stale: [], sameName: [], problems: [] };

  for (const [table, where] of tables) {
    const r = await client.queryRecords({ table: 'sys_db_object', query: `name=${table}`, fields: 'name', limit: 1 });
    const exists = r.count > 0;
    out.tables.push({ table, where, exists });
    if (!exists) out.problems.push(`table "${table}" (${where}) does not exist on the instance`);
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.table ?? '?'}:${ref.sys_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!ref.table) { out.references.push({ table: '', sys_id: ref.sys_id, where: ref.where, exists: 'unknown_table' }); continue; }
    let exists = false;
    try { await client.getRecord(ref.table, ref.sys_id, 'sys_id'); exists = true; } catch (e) { if (!(e instanceof ServiceNowError && e.code === 'NOT_FOUND')) throw e; }
    out.references.push({ table: ref.table, sys_id: ref.sys_id, where: ref.where, exists });
    if (!exists) out.problems.push(`${ref.table} ${ref.sys_id} (${ref.where}) does not exist on the instance`);
  }

  const flowRows = await client.queryRecords({ table: 'sys_hub_flow', query: `sys_id=${plan.flow.sys_id}`, fields: 'sys_id,name,active,status', limit: 1 });
  if (flowRows.count > 0) {
    const f = flowRows.records[0] as Record<string, unknown>;
    out.flow = { sys_id: plan.flow.sys_id, exists: true, name: fieldStr(f.name), active: fieldStr(f.active), status: fieldStr(f.status) };
    const planned = new Set([plan.flow, ...plan.variables, ...plan.documentation, ...plan.stages, ...(plan.trigger ? [plan.trigger] : []), ...plan.instances].map(r => r.sys_id));
    for (const t of ['sys_hub_trigger_instance_v2', 'sys_hub_action_instance_v2', 'sys_hub_sub_flow_instance_v2', 'sys_hub_flow_logic_instance_v2', 'sys_hub_flow_stage']) {
      const rows = await client.queryRecords({ table: t, query: `flow=${plan.flow.sys_id}`, fields: 'sys_id', limit: 1000 });
      for (const r of rows.records) { const id = fieldStr((r as Record<string, unknown>).sys_id); if (!planned.has(id)) out.stale.push({ table: t, sys_id: id }); }
    }
    // Record-triggered flows: the platform owns the sys_hub_flow_input rows current / table_name
    // (same exemption as the loader build path) — they are not stale.
    const platformManaged = isRecordTriggeredFlow(plan) ? new Set<string>(PLATFORM_MANAGED_INPUT_ELEMENTS) : new Set<string>();
    for (const t of ['sys_hub_flow_variable', 'sys_hub_flow_input', 'sys_hub_flow_output']) {
      const rows = await client.queryRecords({ table: t, query: `model=${plan.flow.sys_id}`, fields: 'sys_id,element', limit: 1000 });
      for (const r of rows.records) {
        const rec = r as Record<string, unknown>;
        const id = fieldStr(rec.sys_id);
        if (t === 'sys_hub_flow_input' && platformManaged.has(fieldStr(rec.element))) continue;
        if (!planned.has(id)) out.stale.push({ table: t, sys_id: id });
      }
    }
    out.problems.push(`flow ${plan.flow.sys_id} already exists ("${out.flow.name}", active=${out.flow.active}, status=${out.flow.status}) — a build needs mode:'update'${out.stale.length ? `; ${out.stale.length} STALE row(s) would be reported` : ''}`);
  }
  const name = fieldStr(plan.flow.fields.name);
  if (name && !/[\^]/.test(name)) {
    const same = await client.queryRecords({ table: 'sys_hub_flow', query: `name=${name}^sys_id!=${plan.flow.sys_id}`, fields: 'sys_id,name', limit: 5 });
    out.sameName = same.records.map(r => ({ sys_id: fieldStr((r as Record<string, unknown>).sys_id), name: fieldStr((r as Record<string, unknown>).name) }));
    if (out.sameName.length) out.problems.push(`${out.sameName.length} other flow(s) already carry the name "${name}"`);
  }
  return out;
}

/** glide_date_time trigger inputs (run_in) that are not in the future in the instance time zone. */
function pastRunInputs(plan: RecordPlan): NonNullable<RecordPlan['dateTimeInputs']> {
  return (plan.dateTimeInputs ?? []).filter(d => d.in_future === false);
}

export const PAST_RUN_NOTE = 'run_in is not in the future in the instance time zone: activating this flow would run it IMMEDIATELY. snow_flow_build refuses it (FLOW_BUILDER_RUN_IN_PAST) unless allow_past_run:true — pick a later run_in, or pass an ISO-8601 instant to have it converted.';

/** snow_flow_build: refuse (before anything is written) a run_in that is not in the future, unless allow_past_run. */
function refusePastRun(plan: RecordPlan, allowPastRun: boolean): void {
  const past = pastRunInputs(plan);
  if (!past.length || allowPastRun) return;
  const d = past[0];
  throw new ServiceNowError(
    `trigger input "${d.input}" = "${d.local}" is not in the future in the instance time zone ${d.zone} (instance time now ${d.instance_now}) — activating the flow would run it immediately. Nothing was written. Pick a later time, or pass allow_past_run:true to build it anyway.`,
    'FLOW_BUILDER_RUN_IN_PAST',
    { dateTimeInputs: past, warnings: plan.warnings }
  );
}

function parseTransport(value: unknown): FlowBuildTransport {
  if (value === undefined || value === null) return 'loader';
  if (value !== 'loader' && value !== 'table_api') throw new ServiceNowError('transport must be "loader" or "table_api"', 'INVALID_REQUEST');
  return value;
}

function parseWriteOptions(args: Record<string, unknown>): WriteOptions {
  const us = args.update_set;
  if (!us || typeof us !== 'object' || Array.isArray(us)) throw new ServiceNowError('update_set is required: { sys_id } or { name }', 'INVALID_REQUEST');
  const { sys_id, name } = us as { sys_id?: unknown; name?: unknown };
  if ((typeof sys_id !== 'string' || !sys_id) && (typeof name !== 'string' || !name)) {
    throw new ServiceNowError('update_set needs a sys_id or a name', 'INVALID_REQUEST');
  }
  const mode = args.mode === undefined ? 'create' : args.mode;
  if (mode !== 'create' && mode !== 'update') throw new ServiceNowError('mode must be "create" or "update"', 'INVALID_REQUEST');
  const activate = args.activate === true;
  const deleteStale = args.delete_stale === true;
  const confirmDelete = Array.isArray(args.confirm_delete) ? (args.confirm_delete as unknown[]).map(String) : [];
  const allowDeactivate = args.allow_deactivate === true;
  if (deleteStale && confirmDelete.length === 0) {
    throw new ServiceNowError('delete_stale:true requires confirm_delete to list every sys_id that may be deleted', 'INVALID_REQUEST');
  }
  return {
    updateSet: { ...(typeof sys_id === 'string' && sys_id ? { sys_id } : {}), ...(typeof name === 'string' && name ? { name } : {}) },
    mode,
    activate,
    deleteStale,
    confirmDelete,
    ...(allowDeactivate ? { allowDeactivate } : {}),
  };
}

// ─── dispatcher ───────────────────────────────────────────────────────────────

export async function dispatchFlowBuilderAction(
  client: ServiceNowClient,
  name: string,
  args: Record<string, any>
): Promise<any> {
  switch (name) {
    case 'snow_flow_catalog_read': {
      requireFlowBuilder();
      const filter = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
      const entries = readCatalog(filter);
      if (filter && entries.length === 0) throw new ServiceNowError(`No catalogue entry named "${filter}"`, 'NOT_FOUND');
      return { count: entries.length, entries };
    }

    case 'snow_flow_plan': {
      requireFlowBuilder();
      const parsed = parseSpec(args.spec ?? null);
      if ('errors' in parsed) return { ok: false, stage: 'parse', errors: parsed.errors };
      const spec = parsed.spec;

      let resolved: ReturnType<typeof resolveInstanceOrThrow> | undefined;
      const live = args.instance !== undefined && args.instance !== null && args.live !== false;
      if (args.instance !== undefined && args.instance !== null) resolved = resolveInstanceOrThrow(args, client);

      // 'report': an untyped approver pill is listed (and makes ok:false) instead of aborting the dry run;
      // build and export use the default 'error' policy and refuse it.
      let plan: RecordPlan;
      try {
        plan = await generatePlan(spec, { ...(live && resolved ? liveGeneratorOptions(resolved.client) : {}), approverPillPolicy: 'report' });
      } catch (e) {
        // A dry run REPORTS semantic errors (a missing / ambiguous subflow or custom action on the instance, a
        // missing mandatory input …) in the same shape as parse errors instead of throwing them away.
        const spec_errors = specErrorsOf(e);
        if (!spec_errors) throw e;
        return {
          ok: false, stage: 'generate', errors: spec_errors.errors, warnings: spec_errors.warnings,
          instance: resolved?.name, live, writes: 'none — this is a dry run',
        };
      }
      if (!(live && resolved)) addOfflineWarnings(spec, plan, 'plan');
      const liveChecks = live && resolved ? await runLiveChecks(resolved.client, spec, plan) : undefined;
      const unverifiedApprovers = plan.unverifiedApprovers ?? [];
      const transport = parseTransport(args.transport);
      const usRef = { sys_id: args.update_set?.sys_id, name: args.update_set?.name };
      return {
        ok: (liveChecks ? liveChecks.problems.length === 0 : true) && unverifiedApprovers.length === 0,
        ...(unverifiedApprovers.length ? {
          unverified_approvers: unverifiedApprovers,
          unverified_approvers_note: 'These approver pills have no verified type (no dictionary read and no flow.pill_types entry). A string pill in a user/group slot yields ZERO approvers at runtime, so snow_flow_build and snow_flow_export_xml REFUSE this spec until each pill is typed (declare flow.pill_types or plan/build with a live instance).',
        } : {}),
        instance: resolved?.name,
        live,
        rowCount: countRows(plan),
        plan: decodePlanForReview(plan),
        transport,
        captureProtocol: transport === 'loader' ? describeLoadProtocol(plan, usRef) : describeCaptureProtocol(plan, usRef),
        ...(transport === 'table_api' ? { transport_warning: TABLE_API_TRANSPORT_WARNING } : {}),
        ...(liveChecks ? { liveChecks } : {}),
        ...(plan.dateTimeInputs ? { date_time_inputs: plan.dateTimeInputs } : {}),
        ...(pastRunInputs(plan).length ? { past_run_note: PAST_RUN_NOTE } : {}),
        writes: 'none — this is a dry run',
      };
    }

    case 'snow_flow_build': {
      requireFlowBuilder();
      // Only a direct MCP (stdio) call: never nested in another tool (playbooks), REST /api/tool or A2A.
      requireDirectMcpInvocation('snow_flow_build');
      requireWrite();
      const transport = parseTransport(args.transport);
      const opts = parseWriteOptions(args);
      if (opts.activate) requireFlowBuilderActivate();
      const resolved = resolveInstanceOrThrow(args, client);
      const spec = parseSpecOrThrow(args.spec);
      const plan = await generatePlan(spec, liveGeneratorOptions(resolved.client));
      refusePastRun(plan, args.allow_past_run === true);
      let full: Record<string, unknown> & { activation: { ok: boolean; message?: string } };
      if (transport === 'loader') {
        const result = await loadPlan(resolved.client, plan, opts);
        full = { ...result, instanceName: resolved.name, rowCount: countRows(plan) };
      } else {
        let result: Awaited<ReturnType<typeof writePlan>>;
        try {
          result = await writePlan(resolved.client, plan, opts);
        } catch (e) {
          // keep the transport warning on the error path too (details = the write result when present)
          if (e instanceof ServiceNowError && e.details && typeof e.details === 'object' && !Array.isArray(e.details)) {
            throw new ServiceNowError(e.message, e.code, { ...(e.details as Record<string, unknown>), transport: 'table_api', transport_warning: TABLE_API_TRANSPORT_WARNING });
          }
          throw e;
        }
        full = {
          ...result,
          transport: 'table_api',
          transport_warning: TABLE_API_TRANSPORT_WARNING,
          warnings: [TABLE_API_TRANSPORT_WARNING, ...result.warnings],
          summary: `[table_api — diagnostics only, flow stays version 1 and is not usable by Flow Designer] ${result.summary}`,
          instanceName: resolved.name,
          rowCount: countRows(plan),
        };
      }
      if (opts.activate && !full.activation.ok) {
        // Activation was requested and the mandatory read-back did not show active=true → error,
        // but carry the whole write result so nothing about the rows written is lost.
        throw new ServiceNowError(
          `flow written but NOT active after activate:true — ${full.activation.message ?? 'read-back shows active!=true'}; activate it in Workflow Studio or inspect activation.response`,
          'FLOW_BUILDER_ACTIVATION_FAILED',
          full
        );
      }
      return full;
    }

    case 'snow_flow_verify': {
      requireFlowBuilder();
      const resolved = resolveInstanceOrThrow(args, client);
      if (typeof args.flow_sys_id === 'string' && args.flow_sys_id) {
        if (!/^[0-9a-f]{32}$/.test(args.flow_sys_id)) throw new ServiceNowError('flow_sys_id must be a 32-char lowercase hex sys_id', 'INVALID_REQUEST');
        const result = await verifyFlow(resolved.client, args.flow_sys_id);
        return { ...result, instanceName: resolved.name };
      }
      if (args.spec !== undefined && args.spec !== null) {
        const spec = parseSpecOrThrow(args.spec);
        let plan: RecordPlan;
        try {
          plan = await generatePlan(spec, { ...liveGeneratorOptions(resolved.client), approverPillPolicy: 'report' });
        } catch (e) {
          // The spec no longer generates on this instance (e.g. its subflow was deleted since the build): still
          // read the deployed flow back — without a plan diff — and report the generation errors with it.
          const spec_errors = specErrorsOf(e);
          if (!spec_errors) throw e;
          const flowSysId = spec.flow.sys_id ?? sysIdFor(spec.flow.key, ELEMENT_KEYS.flow);
          const result = await verifyFlow(resolved.client, flowSysId);
          return {
            ...result, ok: false, instanceName: resolved.name, planned: false,
            spec_errors: spec_errors.errors, spec_warnings: spec_errors.warnings,
            spec_note: 'the spec could not be generated on this instance (see spec_errors) — the flow was read back WITHOUT a plan diff',
          };
        }
        const result = await verifyFlow(resolved.client, plan.flow.sys_id, plan);
        return { ...result, instanceName: resolved.name };
      }
      throw new ServiceNowError('flow_sys_id or spec is required', 'INVALID_REQUEST');
    }

    case 'snow_flow_export_xml': {
      requireFlowBuilder();
      const format = args.format;
      if (format !== 'record_update' && format !== 'update_set') throw new ServiceNowError('format must be "record_update" or "update_set"', 'INVALID_REQUEST');
      if (format === 'update_set' && (typeof args.update_set_name !== 'string' || !args.update_set_name.trim())) {
        throw new ServiceNowError('update_set_name is required for format "update_set"', 'INVALID_REQUEST');
      }
      const outPath = resolveExportPath(args.out_path);
      const spec = parseSpecOrThrow(args.spec);
      // Adopting an existing flow (flow.sys_id) makes the file's delete_multiple elements
      // (`flow=<id>^sys_idNOT IN<planned>`) delete, on import, every child row of THAT flow the plan does
      // not carry — an implicit delete that Preview does not show. Explicit opt-in only.
      if (spec.flow.sys_id && args.replace_existing !== true) {
        throw new ServiceNowError(
          `spec.flow.sys_id adopts the existing flow ${spec.flow.sys_id}: importing this file would DELETE every child row of that flow (actions, logic, variables, stages, trigger …) that the spec does not carry. Pass replace_existing:true to export it anyway, and review the returned delete_multiple list before importing.`,
          'FLOW_BUILDER_EXPORT_REPLACES_EXISTING',
          { flowSysId: spec.flow.sys_id }
        );
      }
      // default approver policy 'error': export is offline, so an approver pill must be typed via flow.pill_types
      const plan = await generatePlan(spec);
      addOfflineWarnings(spec, plan, 'export');
      const xml = format === 'record_update'
        ? planToRecordUpdateXml(plan)
        : planToUnloadXml(plan, { updateSetName: String(args.update_set_name).trim(), description: typeof args.description === 'string' ? args.description : undefined });
      const deleteMultiple = listDeleteMultiples(xml);
      writeFileSync(outPath, xml, 'utf8');
      return {
        ok: true, format, path: outPath, bytes: Buffer.byteLength(xml, 'utf8'), flowSysId: plan.flow.sys_id, rowCount: countRows(plan),
        adoptsExistingFlow: Boolean(spec.flow.sys_id),
        delete_multiple: deleteMultiple,
        delete_multiple_note: `On import, each of these ${deleteMultiple.length} delete_multiple element(s) deletes every row of its table matching its query (e.g. flow=<id>^sys_idNOT IN<planned ids> removes that flow's child rows the plan does not carry). Import Preview does not list them — review before committing.`,
        warnings: plan.warnings,
      };
    }

    default:
      return null;
  }
}
