// Builds tests/flow-builder/fixtures/pdi/** from raw read-only PDI query results saved as local files.
// Read-only with respect to the instance: every input is a local file.
// Usage: node build-fixtures.cjs <directory holding the saved query results>
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SCRATCH_DIR = () => TOOL_RESULTS;
const TOOL_RESULTS = process.argv[2] || process.env.PDI_RAW_DIR;
if (!TOOL_RESULTS) throw new Error('usage: node build-fixtures.cjs <raw query results directory> (or set PDI_RAW_DIR)');
const OUT = path.resolve(__dirname, '..');

function loadToolResult(file) {
  let t = fs.readFileSync(path.join(TOOL_RESULTS, file), 'utf8');
  if (t.trim().startsWith('[')) { const a = JSON.parse(t); t = a[0].text; }
  const i = t.indexOf('{');
  return JSON.parse(t.slice(i));
}
function ref(v) { return v && typeof v === 'object' && 'value' in v ? v.value : v; }
function flat(rec) { const o = {}; for (const [k, v] of Object.entries(rec)) o[k] = ref(v); return o; }
let decode = function (b64) {
  if (!b64) return null;
  const json = zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
  try { return JSON.parse(json); } catch { return json; }
};
function write(rel, data) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', 'utf8');
  return p;
}
function withDecoded(rows, fields) {
  return rows.map(r => {
    const o = { ...r };
    for (const f of fields) if (r[f] !== undefined) o[f + '_decoded'] = decode(r[f]);
    if (o.label_cache) { try { o.label_cache_parsed = JSON.parse(o.label_cache); } catch {} }
    return o;
  });
}

const leaver = JSON.parse(fs.readFileSync(path.join(SCRATCH_DIR(), 'raw-leaver.json'), 'utf8'));
const other = JSON.parse(fs.readFileSync(path.join(SCRATCH_DIR(), 'raw-other-flows.json'), 'utf8'));
const samples = JSON.parse(fs.readFileSync(path.join(SCRATCH_DIR(), 'raw-samples.json'), 'utf8'));
const defs = JSON.parse(fs.readFileSync(path.join(SCRATCH_DIR(), 'raw-definitions.json'), 'utf8'));

// ---- verbatim blob overrides from persisted tool results (preferred over hand-transcribed blobs)
const OVERRIDE = {};
for (const f of ['mcp-snow-mcp-snow_core_records_query-1790193384537.txt', 'mcp-snow-mcp-snow_core_records_query-1790193387686.txt']) {
  for (const r of loadToolResult(f).records) OVERRIDE[r.sys_id] = flat(r);
}
{ const t = JSON.parse(fs.readFileSync(path.join(SCRATCH_DIR(), 'raw-trigger-updated.json'), 'utf8')); OVERRIDE[t.sys_id] = t; }
let overridden = 0;
function applyOverrides(o) {
  if (Array.isArray(o)) return o.forEach(applyOverrides);
  if (!o || typeof o !== 'object') return;
  if (o.sys_id && OVERRIDE[o.sys_id]) {
    for (const f of ['values', 'trigger_inputs', 'subflow_inputs']) if (OVERRIDE[o.sys_id][f] !== undefined && o[f] !== undefined) { if (o[f] !== OVERRIDE[o.sys_id][f]) overridden++; o[f] = OVERRIDE[o.sys_id][f]; }
  }
  for (const v of Object.values(o)) applyOverrides(v);
}
for (const x of [leaver, other, samples]) applyOverrides(x);
console.error('blobs replaced from persisted results:', overridden);
let decodeErrors = [];
const _decode = decode;
decode = function (b64) { try { return _decode(b64); } catch (e) { decodeErrors.push(e.message); return { DECODE_ERROR: e.message }; } };

// ---- flows/leaver-flow (catalog trigger, draft, UI-built from template)
const L = 'flows/leaver-flow/';
write(L + 'sys_hub_flow.json', withDecoded([leaver.flow], [])[0]);
write(L + 'sys_hub_trigger_instance_v2.json', withDecoded([leaver.trigger], ['trigger_inputs'])[0]);
write(L + 'sys_hub_action_instance_v2.json', withDecoded(leaver.actions, ['values']));
write(L + 'sys_hub_flow_logic_instance_v2.json', withDecoded(leaver.logic, ['values']));
write(L + 'sys_hub_sub_flow_instance_v2.json', withDecoded(leaver.subflows, ['subflow_inputs']));
write(L + 'sys_hub_flow_stage.json', leaver.stages);
write(L + 'sys_hub_flow_variable.json', leaver.flow_variables);
write(L + 'sys_update_xml_meta.json', leaver.update_xml_meta);
const upd = loadToolResult('mcp-snow-mcp-snow_core_record_read-1790190688614.txt');
write(L + 'sys_update_xml_payload.xml', upd.payload);

// ---- other UI-built flows
const E = 'flows/error-handler-subflow-snapshot/';
write(E + 'README.json', { note: other.error_handler_subflow_snapshot.note, parent_flow: other.error_handler_subflow_snapshot.parent_flow });
write(E + 'sys_hub_flow_base.json', withDecoded([other.error_handler_subflow_snapshot.flow_base], [])[0]);
write(E + 'sys_hub_flow_logic_instance_v2.json', withDecoded(other.error_handler_subflow_snapshot.logic, ['values']));
write(E + 'sys_hub_action_instance_v2.json', withDecoded(other.error_handler_subflow_snapshot.actions, ['values']));

const P = 'flows/parallel-change-implement-snapshot/';
write(P + 'README.json', { note: other.parallel_flow_snapshot.note, parent_flow: other.parallel_flow_snapshot.parent_flow });
write(P + 'sys_hub_flow_base.json', withDecoded([other.parallel_flow_snapshot.flow_base], [])[0]);
write(P + 'sys_hub_trigger_instance_v2.json', withDecoded([other.parallel_flow_snapshot.trigger], ['trigger_inputs'])[0]);
write(P + 'sys_hub_flow_logic_instance_v2.json', withDecoded(other.parallel_flow_snapshot.logic, ['values']));
write(P + 'sys_hub_action_instance_v2.json', withDecoded(other.parallel_flow_snapshot.actions, ['values']));
write(P + 'sys_hub_sub_flow_instance_v2.json', withDecoded(other.parallel_flow_snapshot.subflows, ['subflow_inputs']));

const D = 'flows/dountil-timer-subflow/';
write(D + 'README.json', { note: other.dountil_timer_subflow.note });
write(D + 'sys_hub_flow.json', withDecoded([other.dountil_timer_subflow.flow], [])[0]);
write(D + 'sys_hub_flow_logic_instance_v2.json', withDecoded(other.dountil_timer_subflow.logic, ['values']));

const R = 'flows/record-trigger-published-flow/';
write(R + 'README.json', { note: other.record_trigger_flow.note });
write(R + 'sys_hub_flow.json', withDecoded([other.record_trigger_flow.flow], [])[0]);
write(R + 'sys_hub_trigger_instance_v2.json', withDecoded([other.record_trigger_flow.trigger], ['trigger_inputs'])[0]);
write(R + 'sys_flow_record_trigger.json', other.record_trigger_flow.record_trigger);

// ---- samples
const S = 'samples/';
write(S + 'ask-for-approval-instances.json', withDecoded(samples.ask_for_approval_instances, ['values']));
write(S + 'get-catalog-variables-instances.json', withDecoded(samples.get_catalog_variables_instances, ['values']));
write(S + 'set-flow-variables-instances.json', withDecoded(samples.set_flow_variables_instances, ['values']));
write(S + 'for-each-instances.json', withDecoded(samples.for_each_instances, ['values']));
write(S + 'break-continue-instances.json', withDecoded(samples.break_continue_instances, ['values']));
write(S + 'assign-subflow-outputs-instances.json', withDecoded(samples.assign_subflow_outputs_instances, ['values']));
write(S + 'trigger-instances-other-types.json', withDecoded(samples.trigger_instances_other, ['trigger_inputs']));
write(S + 'sys_hub_flow_variable.json', samples.flow_variables);
write(S + 'sys_hub_flow_input.json', samples.flow_inputs);
write(S + 'sys_hub_flow_output.json', samples.flow_outputs);
write(S + 'sys_documentation-for-variables.json', samples.sys_documentation_for_variables);
write(S + 'sys_hub_input_scripts.json', samples.input_scripts.map(r => ({ ...r, script_parsed: JSON.parse(r.script) })));
write(S + 'sys_flow_record_trigger-sample.json', samples.record_triggers_sample);
write(S + 'sys_hub_action_type_snapshot-rows-for-catalogue-ids.json', samples.action_type_snapshot_rows_for_catalogue_ids);

// ---- definitions
const F = 'definitions/';
write(F + 'platform.json', defs.platform);
write(F + 'sys_hub_trigger_definition.json', defs.trigger_definitions);
write(F + 'sys_hub_trigger_input.json', { note: defs.trigger_inputs_note, rows: defs.trigger_inputs });
write(F + 'sys_hub_trigger_output.json', defs.trigger_outputs);
write(F + 'sys_hub_flow_logic_definition.json', defs.logic_definitions);
write(F + 'sys_hub_action_type_definition.json', defs.action_type_definitions);
write(F + 'sys_hub_action_input-by-snapshot.json', defs.action_inputs_by_snapshot);
write(F + 'sys_hub_action_output-by-definition.json', defs.action_outputs_by_definition);
const ai = loadToolResult('mcp-snow-mcp-snow_core_records_query-1790190553758.txt');
write(F + 'sys_hub_action_input-by-definition.json', ai.records.map(flat));
const dict = loadToolResult('mcp-snow-mcp-snow_core_records_query-1790190428058.txt');
const byTable = {};
for (const r of dict.records.map(flat)) (byTable[r.name] = byTable[r.name] || []).push(r);
for (const k of Object.keys(byTable)) byTable[k].sort((a, b) => a.element.localeCompare(b.element));
write('dictionary/sys_dictionary-by-table.json', byTable);

// ---- catalogue of flows seen
const flows = loadToolResult('mcp-snow-mcp-snow_core_records_query-1790190266116.txt');
write('catalogue/sys_hub_flow-recent-non-system.json', flows.records.map(flat).map(r => ({
  sys_id: r.sys_id, name: r.name, internal_name: r.internal_name, type: r.type, status: r.status, active: r.active,
  generation_source: r.generation_source, run_as: r.run_as, sys_scope: r.sys_scope, sys_created_by: r.sys_created_by, sys_created_on: r.sys_created_on,
  latest_snapshot: r.latest_snapshot, master_snapshot: r.master_snapshot })));

console.log('written under', OUT, 'decodeErrors=', decodeErrors.length, decodeErrors);
