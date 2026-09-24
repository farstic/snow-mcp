/**
 * label_cache builder — the JSON array stored on `sys_hub_flow.label_cache`.
 *
 * One entry per distinct platform pill used anywhere in the flow, in first-use order
 * (flat instance order, then the order of the values entries inside the instance):
 *   { name, label, type, base_type, usedInstances: { <instance uuid>: [inputName, ...] }, attributes: {},
 *     column_name?  (records pills and array flow variables, e.g. 'Records'),
 *     reference_table? / reference_display?  (flow_variable and subflow-input pills; null) }
 *
 * Label text rules (the generator's own; label_cache is a cache Workflow Studio rewrites on save and the platform
 * completes on activation — PDI-FACTS §6 lists the UI labels; the generator supplies them through `resolve`):
 *   trigger record pill   'Trigger - Record Created➛incident Record➛Number'
 *   flow variable         'Flow Variables➛<label>'
 *   subflow input         'Input➛<label>'
 *   step output           '<uuid>➛<Output>[➛field]'
 *   for_each item         '<n> - For Each - ➛item[➛<Field label>]'
 *   error handler         '1 - Error Handler➛Error Status➛Message' (PDI)
 *   dotted reference walk each segment label-cased ('Caller Id➛Email')
 *
 * UI-built keys (FORMAT-DECISIONS D4): Workflow Studio entries also carry reference / reference_display /
 * parent_table_name / column_name. The generator adds the ones it can derive without a dictionary label
 * read (PillTypeInfo.ui) AFTER the base keys above, so the base part of every entry keeps its layout.
 *
 * Owner: SCAFFOLD (contract) → GENERATOR (implementation).
 */
import type { LabelCacheEntry } from './spec/types.js';

/** One usage of a platform pill by one instance input, collected while the generator walks the steps. */
export interface PillUsage {
  /** platform pill without the braces, e.g. 'Created_1.current.number' */
  platform: string;
  /** symbolic form it came from, for warnings */
  symbolic: string;
  /** instance uuid (sysIdToUuid of the instance sys_id) that uses it */
  instanceUuid: string;
  /** the input name on that instance ('condition', 'log_message', 'record', ...) */
  inputName: string;
}

/** Type information resolved for a platform pill. */
export interface PillTypeInfo {
  type: string;
  base_type: string;
  label: string;
  column_name?: string;
  reference_table?: string | null;
  reference_display?: string | null;
  /** UI-built label_cache keys the generator can derive (reference table of a record pill, parent table + column of a single-hop field pill). */
  ui?: { reference?: string; reference_display?: string; parent_table_name?: string; column_name?: string };
}

/**
 * Build the label_cache array from the collected usages: one entry per distinct platform
 * pill in first-use order; `usedInstances` keyed by instance uuid in first-use order with
 * each input name listed once.
 */
export function buildLabelCache(usages: PillUsage[], resolve: (platform: string) => PillTypeInfo): LabelCacheEntry[] {
  const byName = new Map<string, LabelCacheEntry>();
  for (const u of usages) {
    if (u.platform.startsWith('static.')) continue; // static references get no label_cache entry from the generator (the UI labels them with the record's display value)
    let entry = byName.get(u.platform);
    if (!entry) {
      const info = resolve(u.platform);
      entry = {
        name: u.platform,
        label: info.label,
        type: info.type,
        base_type: info.base_type,
        usedInstances: {},
        attributes: {},
      };
      if (info.column_name !== undefined) entry.column_name = info.column_name;
      if (info.reference_table !== undefined) entry.reference_table = info.reference_table;
      if (info.reference_display !== undefined) entry.reference_display = info.reference_display;
      const extra = entry as LabelCacheEntry & Record<string, unknown>;
      for (const [k, v] of Object.entries(info.ui ?? {})) if (v !== undefined && !(k in extra)) extra[k] = v;
      byName.set(u.platform, entry);
    }
    const list = entry.usedInstances[u.instanceUuid] ?? (entry.usedInstances[u.instanceUuid] = []);
    if (!list.includes(u.inputName)) list.push(u.inputName);
  }
  return [...byName.values()];
}

/** 'caller_id' → 'Caller Id'; 'assignment_group' → 'Assignment Group' (label-casing rule for dotted walks). */
export function labelCase(fieldName: string): string {
  return fieldName
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

