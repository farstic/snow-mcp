/**
 * RecordPlan → `<record_update table="sys_hub_flow">` XML: the document the ServiceNow IDE loader
 * (`api/fluent/load`, writer/loader.ts) applies and `snow_flow_export_xml` writes. Its vocabulary is the
 * platform's own update-set payload of a flow (PDI capture flows/leaver-flow/sys_update_xml_payload.xml):
 * one INSERT_OR_UPDATE element per row, a delete_multiple cleanup per child table (`flow=<id>^sys_idNOT IN…`,
 * `model=<id>^sys_idNOT IN…` for variables / inputs / outputs), one `sys_hub_alias_mapping` delete_multiple
 * (`source_id=<instance>`) per action instance, no cleanup for sys_documentation. The loader accepted this
 * layout in every live run on the PDI (24 Sep 2026; FORMAT-DECISIONS.md). 2-space indent,
 * `apply_defaults="true"` on every data row (dictionary defaults for the columns a row omits; the UI capture
 * has no such attribute because it serialises every column):
 *
 *   <?xml version="1.0"?>
 *   <record_update table="sys_hub_flow">
 *     <sys_hub_flow action="INSERT_OR_UPDATE" apply_defaults="true"> …
 *     [per variable group, in the order variables → inputs → outputs, only when it has rows]
 *       <group action="delete_multiple" query="model=<flow>^sys_idNOT IN…"/> + its rows;
 *       after the FIRST populated group: every sys_documentation row, then sys_complex_object rows
 *     [stages]   delete_multiple flow=… + rows
 *     [trigger]  delete_multiple flow=… + row
 *     [actions]  delete_multiple flow=… + rows, then one sys_hub_alias_mapping delete_multiple
 *                (query source_id=<instance>) per action
 *     [logic]    delete_multiple flow=… + rows
 *     [subflows] delete_multiple flow=… + rows, then one alias-mapping delete per subflow call
 *   </record_update>
 *
 * A child table is only given its delete_multiple when the plan has rows for it (a load must not remove
 * rows of a table the spec does not describe; the platform capture of a UI save — xml/unload.ts, WRITER —
 * always writes them).
 * Exception (loader transport, WRITER): `opts.cleanTables` names child tables the plan leaves EMPTY but
 * that hold rows of this flow on the instance; each gets `<table action="delete_multiple"
 * query="flow=<id>">` (`model=<id>` for variable tables) at its usual position, so an update that drops
 * every row of a table does not leave the old rows attached. The loader confirms those deletes first.
 * sys_scope: with `opts.scope` ({sys_id, scope name}) a row whose sys_scope is that scope (by name or
 * sys_id) is written as a reference element — `<sys_scope display_value="<scope NAME>"><sys_id>` (the platform
 * capture writes `<sys_scope display_value="Global">global</sys_scope>`);
 * without it the field value is used for both (correct for 'global').
 * Every data row: sys_id, sys_scope (display_value attribute), sys_update_name first, then the other
 * fields in localeCompare order; empty values as `<field/>`; text entity-escaped with '\r' as '&#13;'
 * (the platform capture uses CDATA for some long text; entity escaping is equivalent XML). No trailing newline.
 *
 * Owner: SCAFFOLD (stub, escape helpers) → GENERATOR (implementation).
 */
import { ServiceNowError } from '../../utils/errors.js';
import type { RecordPlan, RecordRow } from '../spec/types.js';

const INDENT = '  ';

/** Tables whose rows key to the flow through `model` instead of `flow`. */
const MODEL_KEYED = new Set(['sys_hub_flow_variable', 'sys_hub_flow_input', 'sys_hub_flow_output']);
const VARIABLE_GROUPS = ['sys_hub_flow_variable', 'sys_hub_flow_input', 'sys_hub_flow_output'] as const;
const INSTANCE_TABLES = ['sys_hub_action_instance_v2', 'sys_hub_flow_logic_instance_v2', 'sys_hub_sub_flow_instance_v2'] as const;
/** Instance tables whose rows get a per-row sys_hub_alias_mapping cleanup. */
const ALIASED = new Set(['sys_hub_action_instance_v2', 'sys_hub_sub_flow_instance_v2']);

/** `sys_update_name`: <table>_<sys_id>; sys_documentation is keyed by name + element + language (as the platform names those update records). */
export function sysUpdateName(row: RecordRow): string {
  if (row.table === 'sys_documentation') {
    const f = row.fields;
    return `sys_documentation_${String(f.name ?? '')}_${String(f.element ?? '')}_${String(f.language ?? 'en')}`;
  }
  return `${row.table}_${row.sys_id}`;
}

/** Field names after sys_id / sys_scope / sys_update_name: alphabetical (localeCompare), as the platform capture orders them. */
function compareFieldNames(a: string, b: string): number {
  return a.localeCompare(b);
}

function field(name: string, value: unknown, attrs = ''): string {
  const text = value === undefined || value === null ? '' : String(value);
  return text === '' ? `${INDENT}${INDENT}<${name}${attrs}/>` : `${INDENT}${INDENT}<${name}${attrs}>${escapeXmlText(text)}</${name}>`;
}

/** The resolved scope of a flow: sys_scope sys_id ('global' for global) and scope NAME ('global', 'x_…'). */
export interface ScopeRef { sys_id: string; scope: string }

export interface RecordUpdateOptions {
  /** Write sys_scope as display_value=<scope name>, text=<sys_scope sys_id> (reference element form). */
  scope?: ScopeRef;
  /** Child tables the plan has no rows for that must still be cleaned (`flow=<id>` / `model=<id>`). */
  cleanTables?: readonly string[];
}

/** Child tables `cleanTables` may name (flow= / model= keyed, the tables the emitter knows). */
export const CLEANABLE_TABLES: readonly string[] = [...VARIABLE_GROUPS, 'sys_hub_flow_stage', 'sys_hub_trigger_instance_v2', ...INSTANCE_TABLES];

/** One `<table action="INSERT_OR_UPDATE" apply_defaults="true">` element. */
export function recordElement(row: RecordRow, scope: string, scopeRef?: ScopeRef): string {
  const f = row.fields;
  const sysId = String(f.sys_id ?? row.sys_id);
  const rowScope = String(f.sys_scope ?? scope);
  // reference element: display_value = the scope NAME, text = the sys_scope sys_id
  const ofFlowScope = scopeRef && rowScope !== '' && (rowScope === scopeRef.sys_id || rowScope === scopeRef.scope);
  const scopeText = ofFlowScope ? scopeRef.sys_id : rowScope;
  const scopeDisplay = ofFlowScope ? scopeRef.scope : rowScope;
  const lines = [
    `${INDENT}<${row.table} action="INSERT_OR_UPDATE" apply_defaults="true">`,
    field('sys_id', sysId),
    field('sys_scope', scopeText, ` display_value="${escapeXmlAttr(scopeDisplay)}"`),
    field('sys_update_name', sysUpdateName({ ...row, sys_id: sysId })),
  ];
  const rest = Object.keys(f).filter(k => k !== 'sys_id' && k !== 'sys_scope' && k !== 'sys_update_name').sort(compareFieldNames);
  for (const k of rest) lines.push(field(k, f[k]));
  lines.push(`${INDENT}</${row.table}>`);
  return lines.join('\n');
}

function deleteMultiple(table: string, query: string): string {
  return `${INDENT}<${table} action="delete_multiple" query="${escapeXmlAttr(query)}"/>`;
}

function childCleanup(table: string, flowSysId: string, rows: RecordRow[]): string {
  const key = MODEL_KEYED.has(table) ? 'model' : 'flow';
  return deleteMultiple(table, `${key}=${flowSysId}^sys_idNOT IN${rows.map(r => r.sys_id).join(',')}`);
}

/**
 * Serialise a plan to the `<record_update>` document. Pure; the plan is not modified.
 * Throws FLOW_BUILDER_INVALID_PLAN when the plan has no sys_hub_flow row.
 */
export function planToRecordUpdateXml(plan: RecordPlan, opts: RecordUpdateOptions = {}): string {
  if (!plan?.flow || plan.flow.table !== 'sys_hub_flow') {
    throw new ServiceNowError('planToRecordUpdateXml: the plan has no sys_hub_flow row', 'FLOW_BUILDER_INVALID_PLAN');
  }
  const flowSysId = plan.flow.sys_id;
  const scope = String(plan.flow.fields.sys_scope ?? 'global');
  const clean = new Set(opts.cleanTables ?? []);
  for (const t of clean) {
    if (!CLEANABLE_TABLES.includes(t)) throw new ServiceNowError(`planToRecordUpdateXml: cleanTables names ${t}, which is not a flow child table`, 'FLOW_BUILDER_INVALID_PLAN');
  }
  /** delete_multiple for a child table the plan leaves empty (only when asked to clean it). */
  const cleanEmpty = (table: string) => {
    if (clean.has(table)) out.push(deleteMultiple(table, `${MODEL_KEYED.has(table) ? 'model' : 'flow'}=${flowSysId}`));
  };
  const out: string[] = ['<?xml version="1.0"?>', '<record_update table="sys_hub_flow">', recordElement(plan.flow, scope, opts.scope)];
  const emit = (rows: RecordRow[]) => { for (const r of rows) out.push(recordElement(r, scope, opts.scope)); };

  // variables / inputs / outputs, then (after the first populated group) documentation + complex objects
  const variableRows = plan.variables ?? [];
  const complexObjects = variableRows.filter(r => r.table === 'sys_complex_object');
  let docsEmitted = false;
  for (const table of VARIABLE_GROUPS) {
    const rows = variableRows.filter(r => r.table === table);
    if (!rows.length) { cleanEmpty(table); continue; }
    out.push(childCleanup(table, flowSysId, rows));
    emit(rows);
    if (!docsEmitted) { emit(plan.documentation ?? []); emit(complexObjects); docsEmitted = true; }
  }
  if (!docsEmitted) { emit(plan.documentation ?? []); emit(complexObjects); }
  emit(variableRows.filter(r => r.table !== 'sys_complex_object' && !(VARIABLE_GROUPS as readonly string[]).includes(r.table)));

  if (plan.stages?.length) { out.push(childCleanup('sys_hub_flow_stage', flowSysId, plan.stages)); emit(plan.stages); } else cleanEmpty('sys_hub_flow_stage');
  if (plan.trigger) { out.push(childCleanup(plan.trigger.table, flowSysId, [plan.trigger])); emit([plan.trigger]); } else cleanEmpty('sys_hub_trigger_instance_v2');

  for (const table of INSTANCE_TABLES) {
    const rows = (plan.instances ?? []).filter(r => r.table === table);
    if (!rows.length) { cleanEmpty(table); continue; }
    out.push(childCleanup(table, flowSysId, rows));
    emit(rows);
    if (ALIASED.has(table)) for (const r of rows) out.push(deleteMultiple('sys_hub_alias_mapping', `source_id=${r.sys_id}`));
  }
  emit((plan.instances ?? []).filter(r => !(INSTANCE_TABLES as readonly string[]).includes(r.table)));

  out.push('</record_update>');
  return out.join('\n');
}

/** XML text escaping shared by both emitters (element text, not attributes). */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

/** XML attribute escaping. */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}
