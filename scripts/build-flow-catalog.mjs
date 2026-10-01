#!/usr/bin/env node
/**
 * Builds the flow-builder catalogue (src/flow-builder/catalog/data/{triggers,actions,logic}.json) from
 * metadata exported from a ServiceNow instance — the platform's own Flow Designer definitions.
 *
 *   node scripts/build-flow-catalog.mjs [sourceDir] [outDir]
 *     sourceDir  default src/flow-builder/catalog/source
 *     outDir     default src/flow-builder/catalog/data
 *
 * sourceDir holds manifest.json (which definitions the catalogue covers and under which FlowSpec key) and
 * one export per table, each a JSON object with a `result` array exactly as the REST Table API returns it
 * (GET /api/now/table/<table>?sysparm_query=…&sysparm_fields=…; reference fields may be plain values or
 * {value, link}; empty fields may be omitted). The exports and their queries are listed in
 * src/flow-builder/README.md ("Catalogue").
 *
 * Rules applied (no value is invented):
 *   - input/output type: attributes.uiType when the variable is a complex object (attributes.co_type_name),
 *     else internal_type;
 *   - order: definition order, then element name — except for a trigger whose manifest entry lists `input_order`
 *     (the entry order UI-built trigger rows store, which no definition field gives): those inputs come first, in
 *     that order;
 *   - default: default_value typed by the input type (boolean / integer), omitted when empty;
 *   - hidden: attributes visible=false, visible_in_fd=false, visible_in_ui=false, or a property-driven
 *     visible=<property>:false;
 *   - choices: sys_choice (language en, active), by sequence then label;
 *   - trigger input reference_display: the label (sys_db_object) of the referenced table; an action input / output
 *     reference_display where sys_db_object-action-references.json lists the table (no error when it does not);
 *   - sys_id / read_only / hint of an action input from sys_hub_action_input-supplement.json (joined by model +
 *     element), max_length / attributes of a logic input from sys_hub_flow_logic_input-supplement.json (joined by
 *     sys_id) — read-only exports of the same tables with the columns the main exports lack;
 *   - choice_option: the input's `choice` column when set and not 0 (the parameter.choiceOption of UI-built rows);
 *   - tables.json: every sys_db_object export (name, label, display_field) — the table labels the generator writes
 *     into label_cache / displayValue / parameter.reference_display, and the display field of parameter.fSearchField;
 *   - trigger pill prefix: <definition name>_1; label prefix: the manifest's observed value, else
 *     "Trigger - <definition name>" (label_prefix_verified=false); an output's pill_label only where the
 *     manifest records the label Workflow Studio shows for it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sourceDir = resolve(process.argv[2] ?? 'src/flow-builder/catalog/source');
const outDir = resolve(process.argv[3] ?? 'src/flow-builder/catalog/data');

function readExport(file, { optional = false } = {}) {
  const path = join(sourceDir, file);
  if (!existsSync(path)) {
    if (optional) return [];
    throw new Error(`missing export ${path}`);
  }
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const rows = Array.isArray(json) ? json : json.result;
  if (!Array.isArray(rows)) throw new Error(`${file}: no result array`);
  return rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? String(v.value) : v == null ? '' : String(v)])));
}

const f = (row, name) => row[name] ?? '';
const bool = v => v === 'true' || v === '1';

function parseAttributes(s) {
  const out = {};
  for (const part of String(s ?? '').split(',')) {
    const i = part.indexOf('=');
    const k = (i < 0 ? part : part.slice(0, i)).trim();
    if (!k) continue;
    out[k] = i < 0 ? '' : part.slice(i + 1).trim();
  }
  return out;
}

function effectiveType(row, attrs) {
  return attrs.co_type_name && attrs.uiType ? attrs.uiType : f(row, 'internal_type');
}

function isHidden(attrs) {
  const v = attrs.visible;
  return v === 'false' || attrs.visible_in_fd === 'false' || attrs.visible_in_ui === 'false' || (typeof v === 'string' && /:false$/.test(v));
}

function typedDefault(raw, type) {
  if (raw === '') return undefined;
  if (type === 'boolean') return raw === 'true' || raw === '1';
  if (type === 'integer' && /^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function byOrder(a, b) {
  return (Number(f(a, 'order')) || 0) - (Number(f(b, 'order')) || 0) || f(a, 'element').localeCompare(f(b, 'element'));
}

function choicesFor(choiceRows, name, element) {
  return choiceRows
    .filter(c => f(c, 'name') === name && f(c, 'element') === element)
    .sort((a, b) => {
      const sa = f(a, 'sequence') === '' ? Infinity : Number(f(a, 'sequence'));
      const sb = f(b, 'sequence') === '' ? Infinity : Number(f(b, 'sequence'));
      return (sa === sb ? 0 : sa < sb ? -1 : 1) || f(a, 'label').localeCompare(f(b, 'label'));
    })
    .map(c => ({ value: f(c, 'value'), label: f(c, 'label') }));
}

function variable(row, choiceRows, choiceName, { withDefault = true } = {}) {
  const attrs = parseAttributes(f(row, 'attributes'));
  const type = effectiveType(row, attrs);
  const v = { name: f(row, 'element'), label: f(row, 'label'), type };
  if (bool(f(row, 'mandatory'))) v.mandatory = true;
  if (withDefault) {
    const d = typedDefault(f(row, 'default_value'), type);
    if (d !== undefined) v.default = d;
  }
  v.order = Number(f(row, 'order')) || 0;
  if (f(row, 'reference')) v.reference = f(row, 'reference');
  if (f(row, 'max_length')) v.maxLength = Number(f(row, 'max_length'));
  if (f(row, 'dependent_on_field')) {
    v.dependent = f(row, 'dependent_on_field');
    if (bool(f(row, 'use_dependent_field'))) v.use_dependent = true;
  }
  if (f(row, 'sys_id')) v.sys_id = f(row, 'sys_id');
  if (bool(f(row, 'read_only'))) v.read_only = true;
  if (f(row, 'hint')) v.hint = f(row, 'hint');
  if (f(row, 'choice') && f(row, 'choice') !== '0') v.choice_option = f(row, 'choice');
  if (Object.keys(attrs).length) v.attributes = attrs;
  if (isHidden(attrs)) v.hidden = true;
  if (choiceName && ((f(row, 'choice') && f(row, 'choice') !== '0') || type === 'choice')) {
    const choices = choicesFor(choiceRows, choiceName, v.name);
    if (choices.length) v.choices = choices;
  }
  return v;
}

function need(map, id, what) {
  const r = map.get(id);
  if (!r) throw new Error(`${what} ${id} is not in the exports`);
  return r;
}

const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'));

function inManifestOrder(inputs, order) {
  if (!order) return inputs;
  for (const n of order) if (!inputs.some(i => i.name === n)) throw new Error(`input_order names "${n}", which is not an input of the definition`);
  const pos = n => { const i = order.indexOf(n); return i < 0 ? order.length : i; };
  return inputs.map((v, i) => ({ v, i })).sort((a, b) => pos(a.v.name) - pos(b.v.name) || a.i - b.i).map(x => x.v);
}

// ── triggers ──
const trigDefs = new Map(readExport('sys_hub_trigger_definition.json').map(r => [f(r, 'sys_id'), r]));
const tableLabels = new Map(readExport('sys_db_object-trigger-references.json').map(r => [f(r, 'name'), f(r, 'label')]));
const tableRows = new Map();
for (const r of [...readExport('sys_db_object-trigger-references.json'), ...readExport('sys_db_object-action-references.json', { optional: true })]) {
  const t = { name: f(r, 'name'), label: f(r, 'label') };
  if (f(r, 'display_field')) t.display_field = f(r, 'display_field');
  const prev = tableRows.get(t.name);
  if (prev && prev.label !== t.label) throw new Error(`sys_db_object exports disagree on the label of ${t.name}`);
  tableRows.set(t.name, { ...prev, ...t });
}
const tables = [...tableRows.values()].sort((a, b) => a.name.localeCompare(b.name));
const withReferenceDisplay = v => {
  if (v.reference && tableRows.has(v.reference)) v.reference_display = tableRows.get(v.reference).label;
  return v;
};
const trigInputs = readExport('sys_hub_trigger_input.json').filter(r => f(r, 'active') !== 'false');
const trigOutputs = readExport('sys_hub_trigger_output.json');
const trigChoices = readExport('sys_choice-trigger-input.json');
const triggers = manifest.triggers.map(m => {
  const d = need(trigDefs, m.sys_id, 'trigger definition');
  const varName = `var__m_sys_hub_trigger_input_${m.sys_id}`;
  const name = f(d, 'name');
  return {
    key: m.key,
    sys_id: m.sys_id,
    name,
    trigger_type: f(d, 'type'),
    pill_prefix: `${name}_1`,
    label_prefix: m.label_prefix ?? `Trigger - ${name}`,
    label_prefix_verified: m.label_prefix !== undefined,
    inputs: inManifestOrder(trigInputs.filter(r => f(r, 'name') === varName).sort(byOrder).map(r => {
      const v = variable(r, trigChoices, varName);
      if (v.reference) {
        const label = tableLabels.get(v.reference);
        if (label === undefined) throw new Error(`trigger input ${name}.${v.name} references ${v.reference}, which sys_db_object-trigger-references.json does not list`);
        v.reference_display = label;
      }
      return v;
    }), m.input_order),
    outputs: trigOutputs.filter(r => f(r, 'model') === m.sys_id).sort(byOrder).map(r => {
      const o = variable(r, [], undefined, { withDefault: false });
      if (m.output_labels?.[o.name] !== undefined) o.pill_label = m.output_labels[o.name];
      return o;
    }),
  };
});

// ── actions ──
const snapshots = new Map(readExport('sys_hub_action_type_snapshot.json').map(r => [f(r, 'sys_id'), r]));
const actInputs = readExport('sys_hub_action_input.json');
const actSupplement = readExport('sys_hub_action_input-supplement.json', { optional: true });
for (const r of actInputs) {
  const s = actSupplement.find(x => f(x, 'model') === f(r, 'model') && f(x, 'element') === f(r, 'element'));
  if (!s) continue;
  for (const k of ['sys_id', 'read_only', 'hint']) if (f(s, k) && !f(r, k)) r[k] = f(s, k);
}
const actOutputs = readExport('sys_hub_action_output.json');
const actChoices = readExport('sys_choice-action-input.json');
const hiddenValues = readExport('sys_hub_action_instance_v2-hidden-values.json');
const actions = manifest.actions.map(m => {
  const s = need(snapshots, m.snapshot, 'action snapshot');
  const varName = `var__m_sys_hub_action_input_${m.snapshot}`;
  const inputs = actInputs.filter(r => f(r, 'model') === m.snapshot).sort(byOrder).map(r => withReferenceDisplay(variable(r, actChoices, varName)));
  const entry = {
    key: m.key,
    sys_id: m.snapshot,
    definition: f(s, 'parent_action'),
    internal_name: f(s, 'internal_name'),
    name: f(s, 'name'),
    inputs,
    outputs: actOutputs.filter(r => f(r, 'model') === m.snapshot).sort(byOrder).map(r => withReferenceDisplay(variable(r, [], undefined, { withDefault: false }))),
  };
  const hv = {};
  for (const r of hiddenValues) {
    if (f(r, 'action_type') !== m.snapshot) continue;
    const input = inputs.find(i => i.name === f(r, 'name'));
    if (input?.hidden && input.default === undefined && f(r, 'value') !== '') hv[input.name] = f(r, 'value');
  }
  if (Object.keys(hv).length) entry.hidden_values = hv;
  return entry;
});

// ── logic ──
const logicDefs = new Map(readExport('sys_hub_flow_logic_definition.json').map(r => [f(r, 'sys_id'), r]));
const logicInputs = readExport('sys_hub_flow_logic_input.json');
const logicSupplement = readExport('sys_hub_flow_logic_input-supplement.json', { optional: true });
for (const r of logicInputs) {
  const s = logicSupplement.find(x => f(x, 'sys_id') === f(r, 'sys_id'));
  if (!s) continue;
  for (const k of ['max_length', 'attributes']) if (f(s, k) && !f(r, k)) r[k] = f(s, k);
}
const logicVars = readExport('sys_hub_flow_logic_variable.json');
const logicChoices = readExport('sys_choice-logic-input.json');
const logic = manifest.logic.map(m => {
  const d = need(logicDefs, m.sys_id, 'logic definition');
  const varName = `var__m_sys_hub_flow_logic_input_${m.sys_id}`;
  return {
    key: m.key,
    sys_id: m.sys_id,
    name: f(d, 'name'),
    type: f(d, 'type'),
    inputs: logicInputs.filter(r => f(r, 'model') === m.sys_id).sort(byOrder).map(r => ({ id: f(r, 'sys_id'), ...variable(r, logicChoices, varName) })),
    outputs: logicVars.filter(r => f(r, 'model') === m.sys_id).sort(byOrder).map(r => variable(r, [], undefined, { withDefault: false })),
  };
});

const header = {
  generated_by: 'scripts/build-flow-catalog.mjs',
  source: 'src/flow-builder/catalog/source — Flow Designer definitions exported from a ServiceNow instance (see src/flow-builder/README.md, "Catalogue")',
};
const write = (file, body) => writeFileSync(join(outDir, file), JSON.stringify({ ...header, ...body }, null, 1) + '\n');
write('triggers.json', { triggers });
write('actions.json', { actions });
write('logic.json', { values_key_order: manifest.logic_values_key_order.order, logic });
write('tables.json', { tables });
console.log(`catalogue written to ${outDir}: ${triggers.length} triggers, ${actions.length} actions, ${logic.length} logic definitions, ${tables.length} tables`);
