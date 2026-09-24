/**
 * Offline catalogue read for `snow_flow_catalog_read` — every trigger / action / logic definition with the
 * instance's own labels, input types, defaults and outputs, in the `CatalogEntry` shape. No description or help
 * text is carried offline.
 *
 * Owner: GENERATOR.
 */
import type { CatalogEntry, CatalogInputDef } from '../spec/types.js';
import { allTriggers } from './triggers.js';
import { allActions, actionTypeIds, isHiddenInput } from './actions.js';
import { allLogic } from './logic.js';
import { ERROR_STATUS_FIELDS } from './error-handler.js';
import type { CatalogInputRaw, CatalogOutputRaw } from './load.js';

function toInputDef(i: CatalogInputRaw): CatalogInputDef {
  const out: CatalogInputDef = { name: i.name, type: i.type };
  if (i.label) out.label = i.label;
  if (i.mandatory) out.mandatory = true;
  if (i.default !== undefined && i.default !== '') out.default = i.default;
  if (i.reference) out.reference = i.reference;
  if (isHiddenInput(i)) out.hidden = true;
  if (i.choices?.length) out.choices = i.choices.map(c => c.value);
  return out;
}

const toOutputDef = (o: CatalogOutputRaw) => ({ name: o.name, type: o.type, label: o.label });

/** The spec construct a logic definition stands for (catalog_read `type`). */
const SPEC_PATH_BY_LOGIC_KEY: Record<string, string> = {
  else_if: 'if.else_if', else: 'if.else', catch: 'try_catch.catch', try: 'try_catch', parallel_block: 'do_in_parallel.branches[]',
  set_variables: 'set_variables', append_variables: 'append_variables', 'error_handler.try': 'error_handler', 'error_handler.catch': 'error_handler',
};

export function buildCatalogEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const t of allTriggers()) {
    entries.push({
      kind: 'trigger',
      name: t.key,
      sys_id: t.sys_id,
      label: t.name,
      type: t.trigger_type,
      inputs: t.inputs.map(toInputDef),
      outputs: t.outputs.map(toOutputDef),
    });
  }
  for (const a of allActions()) {
    const ids = actionTypeIds(a);
    const entry: CatalogEntry & { action_type?: string; action_type_parent?: string; internal_name?: string } = {
      kind: 'action',
      name: a.key,
      sys_id: ids.snapshot,
      label: a.name,
      inputs: a.inputs.map(toInputDef),
      outputs: a.outputs.map(toOutputDef),
    };
    entry.action_type = ids.snapshot;
    entry.action_type_parent = ids.definition;
    entry.internal_name = a.internal_name;
    entries.push(entry);
  }
  for (const l of allLogic()) {
    const outputs = l.key === 'error_handler.catch'
      ? Object.entries(ERROR_STATUS_FIELDS).map(([name, f]) => ({ name, type: f.type, label: f.label }))
      : l.outputs.map(toOutputDef);
    entries.push({ kind: 'logic', name: l.key, sys_id: l.sys_id, label: l.name, type: SPEC_PATH_BY_LOGIC_KEY[l.key] ?? l.key, inputs: l.inputs.map(toInputDef), outputs });
  }
  return entries;
}

/** Entries whose name / label / type / sys_id / spec kind match (case-insensitive). */
export function filterCatalogEntries(entries: CatalogEntry[], name: string): CatalogEntry[] {
  const lc = name.trim().toLowerCase();
  const compact = lc.replace(/[\s_.-]+/g, '');
  return entries.filter(e =>
    e.name.toLowerCase() === lc || e.sys_id === name || (e.label ?? '').toLowerCase() === lc || (e.type ?? '').toLowerCase() === lc ||
    e.name.toLowerCase().replace(/[\s_.-]+/g, '') === compact || (e.label ?? '').toLowerCase().replace(/[\s_.-]+/g, '') === compact
  );
}
