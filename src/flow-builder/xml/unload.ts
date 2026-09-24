/**
 * RecordPlan → Retrieved Update Set `<unload>` XML (the offline, manual / no-REST channel:
 * System Update Sets → Retrieved Update Sets → Import Update Set from XML → Preview → Commit).
 *
 * Shape (mirrored from two genuine artefacts):
 *   - the <unload> envelope and the sys_remote_update_set / sys_update_xml field lists come from a
 *     real Retrieved Update Set export (state=loaded, one sys_update_xml per update record with
 *     action, application, category, comments, name, payload, payload_hash, remote_update_set,
 *     replace_on_upgrade, sys_* audit fields, sys_recorded_at, table, target_name, type,
 *     update_domain, update_guid, update_guid_history, update_set, view). No .split/.end_split
 *     batch markers, no apply_defaults anywhere.
 *   - the flow is ONE update record, exactly as the platform captures a UI-built flow
 *     (tests/flow-builder/fixtures/pdi/flows/leaver-flow): sys_update_xml name=sys_hub_flow_<id>,
 *     type=Flow, table='' (empty), target_name=<flow name>, payload = a <record_update
 *     sys_domain="global" table="sys_hub_flow"> holding the sys_hub_flow row followed, per child
 *     table, by a delete_multiple element (`flow=<id>^sys_idNOT IN…` / `model=<id>^sys_idNOT IN…`)
 *     and that table's INSERT_OR_UPDATE rows; fields alphabetical; reference values plain sys_ids.
 *
 * Generated values: payload_hash = Java String.hashCode of the payload (a signed 32-bit decimal —
 * the FORM seen in exports; the genuine Leaver-flow hash 524013495 is NOT the hashCode of its stored
 * payload, so the platform derives it from something else and whether the importer re-checks it is
 * unproven until the P6 rehearsal); update_guid = first 32 hex of sha256(payload) (changes when the
 * content changes, so a re-import of a modified flow is a new update); sys_recorded_at =
 * hex(epoch ms) + '0000001' (verified against the genuine row's format); sys_ids of the envelope rows
 * are deterministic (sha256 of flowKey + role) so a re-export of the same spec reproduces the file.
 *
 * Payload rows also carry what every genuine captured row carries and the plan does not: the audit
 * fields (sys_created_by/on, sys_mod_count=0, sys_updated_by/on), sys_class_name on sys_hub_flow /
 * var-dictionary / sys_documentation rows, and sys_update_name + sys_name on the sys_hub_flow row.
 * Rows of tables that are not keyed to the flow (e.g. the generator's sys_complex_object rows for
 * array.object variables) are emitted WITHOUT a delete_multiple (the capture cleans only flow/model-keyed tables and
 * its own housekeeping tables) — a
 * `flow=<id>` delete_multiple on a table without a `flow` column would have its invalid term ignored
 * by the platform and wipe the whole table.
 *
 * Owner: WRITER.
 */
import { createHash } from 'node:crypto';
import { ServiceNowError } from '../../utils/errors.js';
import { sysIdFor, SYS_ID_RE } from '../ids.js';
import type { RecordPlan, RecordRow } from '../spec/types.js';
import { escapeXmlAttr, escapeXmlText } from './record-update.js';

export interface UnloadOptions {
  updateSetName: string;
  description?: string;
  /** Fixed clock for reproducible files (default: now). */
  now?: Date;
  /** Value for the sys_created_by / sys_updated_by audit fields (default 'snow_mcp_flow_builder'). */
  author?: string;
}

/** Default value for the sys_created_by / sys_updated_by audit fields. */
export const DEFAULT_AUTHOR = 'snow_mcp_flow_builder';

/** sys_update_xml.type label the platform uses for a sys_hub_flow update record (PDI-FACTS §2). */
export const FLOW_UPDATE_TYPE = 'Flow';

/** Child tables in the order the platform emits them inside a captured flow payload. */
export const PAYLOAD_TABLE_ORDER = [
  'sys_hub_flow_stage',
  'sys_flow_cat_variable_model',
  'sys_hub_flow_input',
  'sys_hub_flow_output',
  'sys_hub_trigger_instance_v2',
  'sys_hub_action_instance_v2',
  'sys_hub_sub_flow_instance_v2',
  'sys_hub_flow_logic_instance_v2',
  'sys_hub_flow_variable',
  'sys_documentation',
] as const;

/** Which parent column keys each child table to the flow (for the delete_multiple query). */
const PARENT_KEY: Record<string, string> = {
  sys_hub_flow_stage: 'flow',
  sys_flow_cat_variable_model: 'id',
  sys_hub_flow_input: 'model',
  sys_hub_flow_output: 'model',
  sys_hub_trigger_instance_v2: 'flow',
  sys_hub_action_instance_v2: 'flow',
  sys_hub_sub_flow_instance_v2: 'flow',
  sys_hub_flow_logic_instance_v2: 'flow',
  sys_hub_flow_variable: 'model',
};

// ─── generic XML helpers ──────────────────────────────────────────────────────

function pad(n: number): string { return String(n).padStart(2, '0'); }

/** ServiceNow's 'YYYY-MM-DD HH:MM:SS' (UTC). */
export function snDateTime(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** sys_recorded_at as seen in exports: hex(epoch_ms << 4) + '000001'. */
export function snRecordedAt(d: Date): string {
  return `${(BigInt(d.getTime()) << 4n).toString(16)}000001`;
}

/** Java String.hashCode (signed 32-bit) — the form of payload_hash in genuine exports. */
export function javaStringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Wrap text in CDATA, splitting on ']]>' so the content can never terminate the section early. */
export function cdata(text: string): string {
  return `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function textOrCdata(value: string): string {
  return /[<>&\n]/.test(value) ? cdata(value) : escapeXmlText(value);
}

function assertXmlName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new ServiceNowError(`not a valid XML element name: ${JSON.stringify(name)}`, 'INVALID_REQUEST');
  return name;
}

/** `<name>value</name>` or `<name/>`; optional display_value attribute. */
function el(name: string, value: string | number | boolean, attrs: Record<string, string> = {}): string {
  assertXmlName(name);
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`).join('');
  const s = typeof value === 'string' ? value : String(value);
  return s === '' ? `<${name}${a}/>` : `<${name}${a}>${textOrCdata(s)}</${name}>`;
}

// ─── record_update payload (platform capture shape) ───────────────────────────

/** Strip attributes / markers the importer has never been seen to accept (defensive, for foreign record_update text). */
export function sanitizeRecordUpdate(xml: string): string {
  return xml
    .replace(/\s+apply_defaults="[^"]*"/g, '')
    .replace(/<\/?\.?(split|end_split)[^>]*>/g, '');
}

/** Tables whose captured rows carry sys_class_name (var_dictionary-style rows and sys_documentation). */
const CLASS_NAMED_TABLES = new Set(['sys_hub_flow', 'sys_hub_flow_input', 'sys_hub_flow_output', 'sys_hub_flow_variable', 'sys_documentation']);

export interface PayloadOptions {
  /** Fixed clock for the audit fields (default: now). */
  now?: Date;
  /** Value for sys_created_by / sys_updated_by (default 'snow_mcp_flow_builder'). */
  author?: string;
}

interface Audit { ts: string; author: string }

/** Fill the fields every genuine captured row carries and the plan leaves out (never overrides a planned value). */
function withCaptureFields(row: RecordRow, audit: Audit): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = { ...row.fields, sys_id: row.sys_id };
  const fill = (k: string, v: string) => { if (fields[k] === undefined) fields[k] = v; };
  fill('sys_created_by', audit.author);
  fill('sys_created_on', audit.ts);
  fill('sys_mod_count', '0');
  fill('sys_updated_by', audit.author);
  fill('sys_updated_on', audit.ts);
  if (CLASS_NAMED_TABLES.has(row.table)) fill('sys_class_name', row.table);
  if (row.table === 'sys_hub_flow') {
    fill('sys_update_name', `sys_hub_flow_${row.sys_id}`);
    fill('sys_name', String(row.fields.name ?? ''));
  }
  return fields;
}

function rowXml(row: RecordRow, flowName: string, flowSysId: string, audit: Audit): string {
  assertXmlName(row.table);
  const fields = withCaptureFields(row, audit);
  const keys = Object.keys(fields).sort();
  const parts = keys.map(k => {
    const v = fields[k];
    const s = typeof v === 'string' ? v : String(v);
    const attrs: Record<string, string> = {};
    if ((k === 'flow' || k === 'model') && s === flowSysId) attrs.display_value = flowName;
    if (k === 'sys_scope' && s === 'global') attrs.display_value = 'Global';
    return el(k, s, attrs);
  });
  return `<${row.table} action="INSERT_OR_UPDATE">${parts.join('')}</${row.table}>`;
}

export interface DeleteMultiple { table: string; query: string }

/**
 * Every `<table action="delete_multiple" query="…"/>` element carried by an emitted file (either format;
 * CDATA payloads are scanned too), in document order, with the attribute unescaped. On import these
 * delete every row of `table` matching `query` — e.g. `flow=<id>^sys_idNOT IN<planned>` removes every
 * child row of that flow the plan does not carry. snow_flow_export_xml returns this list so the owner
 * sees the implicit deletes before importing (Preview does not show them).
 */
export function listDeleteMultiples(xml: string): DeleteMultiple[] {
  const out: DeleteMultiple[] = [];
  const re = /<([A-Za-z_][A-Za-z0-9_.:-]*)\s+action="delete_multiple"\s+query="([^"]*)"\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const query = m[2].replace(/&quot;/g, '"').replace(/&#13;/g, '\r').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    out.push({ table: m[1], query });
  }
  return out;
}

function deleteMultiple(table: string, query: string): string {
  return `<${assertXmlName(table)} action="delete_multiple" query="${escapeXmlAttr(query)}"/>`;
}

/**
 * The `<record_update table="sys_hub_flow">` payload for one flow, in the platform's captured form:
 * sys_hub_flow row, then per child table a delete_multiple (`<parent>=<flow>^sys_idNOT IN<planned ids>`)
 * followed by the planned rows; sys_documentation rows without a delete_multiple; the platform's
 * housekeeping delete_multiples (sys_translated_text, sys_variable_value, catalog variables, alias
 * mapping, pill compound, sys_choice, trigger/subflow plan) reproduced so a re-import cleans up exactly
 * like a UI save. Rows of tables with no flow/model key (sys_complex_object, …) follow the
 * sys_documentation rows with NO delete_multiple (as the capture writes sys_documentation, flows/leaver-flow).
 */
export function planToCapturePayloadXml(plan: RecordPlan, opts: PayloadOptions = {}): string {
  if (plan.flow.table !== 'sys_hub_flow') throw new ServiceNowError(`plan.flow.table must be sys_hub_flow (got ${plan.flow.table})`, 'INVALID_REQUEST');
  if (!SYS_ID_RE.test(plan.flow.sys_id)) throw new ServiceNowError(`plan.flow.sys_id is not a sys_id: ${plan.flow.sys_id}`, 'INVALID_REQUEST');
  const flowSysId = plan.flow.sys_id;
  const flowName = String(plan.flow.fields.name ?? '');
  const domain = 'global';
  const audit: Audit = { ts: snDateTime(opts.now ?? new Date()), author: opts.author ?? DEFAULT_AUTHOR };

  const children = [...plan.variables, ...plan.documentation, ...plan.stages, ...(plan.trigger ? [plan.trigger] : []), ...plan.instances];
  const byTable = new Map<string, RecordRow[]>();
  for (const r of children) {
    if (r.table === 'sys_hub_flow') throw new ServiceNowError(`plan carries a second sys_hub_flow row (${r.sys_id}) among the children`, 'INVALID_REQUEST');
    byTable.set(r.table, [...(byTable.get(r.table) ?? []), r]);
  }
  const keyedTables = PAYLOAD_TABLE_ORDER.filter(t => t !== 'sys_documentation');
  // Tables the platform does not key to the flow: rows only, never a delete_multiple.
  const unkeyedTables = [...byTable.keys()].filter(t => !(PAYLOAD_TABLE_ORDER as readonly string[]).includes(t));

  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?><record_update sys_domain="${domain}" table="sys_hub_flow">`);
  out.push(rowXml(plan.flow, flowName, flowSysId, audit));
  out.push(deleteMultiple('sys_translated_text', `documentkey=${flowSysId}`));
  out.push(deleteMultiple('sys_variable_value', `document_key=${flowSysId}`));

  for (const table of keyedTables) {
    const rows = byTable.get(table) ?? [];
    const parentKey = PARENT_KEY[table];
    const notIn = rows.length ? `^sys_idNOT IN${rows.map(r => r.sys_id).join(',')}` : '';
    if (table === 'sys_flow_cat_variable_model' && rows.length === 0) continue; // catalog flows only
    out.push(deleteMultiple(table, `${parentKey}=${flowSysId}${notIn}`));
    for (const r of rows) {
      out.push(rowXml(r, flowName, flowSysId, audit));
      if (table === 'sys_flow_cat_variable_model') out.push(deleteMultiple('sys_flow_cat_variable', `flow_catalog_model=${r.sys_id}`));
      if (table === 'sys_hub_flow_input') out.push(deleteMultiple('sys_hub_action_input_action_instance', `action_input=${r.sys_id}`));
      if (table === 'sys_hub_action_instance_v2' || table === 'sys_hub_sub_flow_instance_v2') out.push(deleteMultiple('sys_hub_alias_mapping', `source_id=${r.sys_id}`));
    }
    if (table === 'sys_hub_flow_output') out.push(deleteMultiple('sys_hub_alias_mapping', `source_id=${flowSysId}`));
    if (table === 'sys_hub_flow_logic_instance_v2') out.push(deleteMultiple('sys_hub_pill_compound', `attached_to=${flowSysId}`));
    if (table === 'sys_hub_flow_variable') out.push(deleteMultiple('sys_choice', `name=var__m_sys_hub_flow_variable_${flowSysId}`));
  }

  for (const r of byTable.get('sys_documentation') ?? []) out.push(rowXml(r, flowName, flowSysId, audit));
  for (const table of unkeyedTables) for (const r of byTable.get(table) ?? []) out.push(rowXml(r, flowName, flowSysId, audit));
  out.push(deleteMultiple('sys_choice', `name=var__m_sys_hub_flow_input_${flowSysId}`));
  out.push(deleteMultiple('sys_choice', `name=var__m_sys_hub_flow_output_${flowSysId}`));
  out.push(deleteMultiple('sys_flow_trigger_plan', `plan_id=${flowSysId}`));
  out.push(deleteMultiple('sys_flow_subflow_plan', `plan_id=${flowSysId}`));
  out.push('</record_update>');
  return sanitizeRecordUpdate(out.join(''));
}

// ─── unload envelope ─────────────────────────────────────────────────────────

export interface UnloadRecord {
  /** sys_update_xml.name, e.g. sys_hub_flow_<id>. */
  name: string;
  type: string;
  /** sys_update_xml.table — '' for a Flow record (PDI-FACTS §2). */
  table: string;
  targetName: string;
  payload: string;
  /** Deterministic sys_id for the sys_update_xml row. */
  sysId: string;
}

export interface UnloadEnvelope {
  updateSetName: string;
  description?: string;
  /** 'global' or the application sys_id. */
  applicationSysId: string;
  applicationName: string;
  applicationScope: string;
  remoteUpdateSetSysId: string;
  remoteSysId: string;
  now: Date;
  author: string;
}

/** Wrap already-built update records in the Retrieved Update Set envelope. */
export function recordsToUnloadXml(records: UnloadRecord[], env: UnloadEnvelope): string {
  if (!env.updateSetName.trim()) throw new ServiceNowError('updateSetName is required', 'INVALID_REQUEST');
  const ts = snDateTime(env.now);
  const recordedAt = snRecordedAt(env.now);
  const appAttr = { display_value: env.applicationName };
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?><unload unload_date="${ts}">`);
  out.push('<sys_remote_update_set action="INSERT_OR_UPDATE">');
  out.push(el('application', env.applicationSysId, appAttr));
  out.push(el('application_name', env.applicationName));
  out.push(el('application_scope', env.applicationScope));
  out.push(el('application_version', ''));
  out.push(el('collisions', ''));
  out.push(el('commit_date', ''));
  out.push(el('deleted', ''));
  out.push(el('description', env.description ?? ''));
  out.push(el('inserted', ''));
  out.push(el('name', env.updateSetName));
  out.push(el('origin_sys_id', ''));
  out.push(el('parent', '', { display_value: '' }));
  out.push(el('release_date', ''));
  out.push(el('remote_base_update_set', '', { display_value: '' }));
  out.push(el('remote_parent_id', ''));
  out.push(el('remote_sys_id', env.remoteSysId));
  out.push(el('state', 'loaded'));
  out.push(el('summary', ''));
  out.push(el('sys_class_name', 'sys_remote_update_set'));
  out.push(el('sys_created_by', env.author));
  out.push(el('sys_created_on', ts));
  out.push(el('sys_id', env.remoteUpdateSetSysId));
  out.push(el('sys_mod_count', '0'));
  out.push(el('sys_updated_by', env.author));
  out.push(el('sys_updated_on', ts));
  out.push(el('update_set', '', { display_value: '' }));
  out.push(el('update_source', '', { display_value: '' }));
  out.push(el('updated', ''));
  out.push('</sys_remote_update_set>');

  for (const rec of records) {
    const payload = sanitizeRecordUpdate(rec.payload);
    const hash = javaStringHash(payload);
    const guid = createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
    out.push('<sys_update_xml action="INSERT_OR_UPDATE">');
    out.push(el('action', 'INSERT_OR_UPDATE'));
    out.push(el('application', env.applicationSysId, appAttr));
    out.push(el('category', 'customer'));
    out.push(el('comments', ''));
    out.push(el('name', rec.name));
    out.push(`<payload>${cdata(payload)}</payload>`);
    out.push(el('payload_hash', String(hash)));
    out.push(el('remote_update_set', env.remoteUpdateSetSysId, { display_value: env.updateSetName }));
    out.push(el('replace_on_upgrade', 'false'));
    out.push(el('sys_created_by', env.author));
    out.push(el('sys_created_on', ts));
    out.push(el('sys_id', rec.sysId));
    out.push(el('sys_mod_count', '0'));
    out.push(el('sys_recorded_at', recordedAt));
    out.push(el('sys_updated_by', env.author));
    out.push(el('sys_updated_on', ts));
    out.push(el('table', rec.table));
    out.push(el('target_name', rec.targetName));
    out.push(el('type', rec.type));
    out.push(el('update_domain', 'global'));
    out.push(el('update_guid', guid));
    out.push(el('update_guid_history', `${guid}:${hash}`));
    out.push(el('update_set', '', { display_value: '' }));
    out.push(el('view', ''));
    out.push('</sys_update_xml>');
  }
  out.push('</unload>');
  return out.join('\n') + '\n';
}

/**
 * Retrieved Update Set file for one flow: envelope + ONE sys_update_xml (`sys_hub_flow_<id>`, type Flow)
 * whose payload is the platform-shaped record_update of the whole flow.
 *
 * Scoped flows: the application fields carry the plan's sys_scope value (a sys_id when the generator
 * resolved one, otherwise the scope name) — the target instance must already have that application,
 * and non-global sets with an absent app fail at Preview. Keep flows for the manual / no-REST channel global.
 */
export function planToUnloadXml(plan: RecordPlan, opts: UnloadOptions): string {
  if (!opts || typeof opts.updateSetName !== 'string' || !opts.updateSetName.trim()) throw new ServiceNowError('updateSetName is required', 'INVALID_REQUEST');
  const flowSysId = plan.flow.sys_id;
  const flowName = String(plan.flow.fields.name ?? '');
  const scope = String(plan.flow.fields.sys_scope ?? 'global') || 'global';
  const isGlobal = scope === 'global';
  const now = opts.now ?? new Date();
  const payload = planToCapturePayloadXml(plan, { now, author: opts.author ?? DEFAULT_AUTHOR });
  const env: UnloadEnvelope = {
    updateSetName: opts.updateSetName.trim(),
    description: opts.description,
    applicationSysId: isGlobal ? 'global' : scope,
    applicationName: isGlobal ? 'Global' : scope,
    applicationScope: isGlobal ? 'global' : (SYS_ID_RE.test(scope) ? '' : scope),
    remoteUpdateSetSysId: sysIdFor(plan.flowKey, `unload:sys_remote_update_set:${opts.updateSetName.trim()}`),
    remoteSysId: sysIdFor(plan.flowKey, `unload:remote_sys_id:${opts.updateSetName.trim()}`),
    now,
    author: opts.author ?? DEFAULT_AUTHOR,
  };
  const record: UnloadRecord = {
    name: `sys_hub_flow_${flowSysId}`,
    type: FLOW_UPDATE_TYPE,
    table: '',
    targetName: flowName,
    payload,
    sysId: sysIdFor(plan.flowKey, 'unload:sys_update_xml:sys_hub_flow'),
  };
  return recordsToUnloadXml([record], env);
}
