/**
 * label_cache builder — the JSON array stored on `sys_hub_flow.label_cache`.
 *
 * One entry per distinct platform pill used anywhere in the flow, in first-use order (flat instance order, then the
 * order of the values entries inside the instance), in the key order Workflow Studio writes (PDI-FACTS §6,
 * FORMAT-DECISIONS §8 — every key after `label` is present only for the pill kinds the UI writes it for):
 *   { name, label, reference?, reference_display?, type, base_type, parent_table_name?, column_name?, choices?,
 *     usedInstances: { <instance uuid>: [inputName, ...] }, attributes? }
 *
 * Label text per pill kind (UI-built flows on the PDI; the generator supplies them through `resolve`, generator/typing.ts):
 *   trigger record output   'Trigger - Service Catalog➛Requested Item Record' / 'Trigger - Record Updated➛Incident Record'
 *   trigger dot-walk        '…➛Incident Record➛Number'   (reference '', reference_display = the field label, parent_table_name, column_name)
 *   trigger table_name      '…➛Incident Table'           (reference = the table, attributes test_input_hidden)
 *   step whole output       '<n> - <Action name>➛<Output label>'   ('1 - Get Catalog Variables➛request_type')
 *   step dot-walk           '<n>➛<Output label>➛<Field label>'    ('1➛department➛Sys ID')
 *   for_each item           '<n> - For Each - ➛item[➛<Field label>]'
 *   flow variable           'Flow Variables➛<label>'     subflow input  'Input➛<label>'
 *   error handler           '1 - Error Handler➛Error Status➛Message'
 *   static reference        name '{{static.<sys_id>}}' (with braces), label = the record's display value
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

/** Type information resolved for a platform pill — the label_cache keys of its entry (key order applied by buildLabelCache). */
export interface PillTypeInfo {
  type: string;
  base_type: string;
  label: string;
  reference?: string;
  reference_display?: string;
  parent_table_name?: string;
  column_name?: string;
  choices?: unknown[];
  /** Present → written (an empty object is written as {}); absent → no attributes key (dot-walks, static references). */
  attributes?: Record<string, unknown>;
}

/** The label_cache name of a pill: static references keep their braces (`{{static.<sys_id>}}`), everything else is the bare pill. */
export function labelCacheName(platform: string): string {
  return platform.startsWith('static.') ? `{{${platform}}}` : platform;
}

/**
 * Build the label_cache array from the collected usages: one entry per distinct platform pill in first-use order;
 * `usedInstances` keyed by instance uuid in first-use order with each input name listed once.
 */
export function buildLabelCache(usages: PillUsage[], resolve: (platform: string) => PillTypeInfo): LabelCacheEntry[] {
  const byName = new Map<string, LabelCacheEntry>();
  for (const u of usages) {
    let entry = byName.get(u.platform);
    if (!entry) {
      const info = resolve(u.platform);
      entry = { name: labelCacheName(u.platform), label: info.label } as LabelCacheEntry;
      if (info.reference !== undefined) entry.reference = info.reference;
      if (info.reference_display !== undefined) entry.reference_display = info.reference_display;
      entry.type = info.type;
      entry.base_type = info.base_type;
      if (info.parent_table_name !== undefined) entry.parent_table_name = info.parent_table_name;
      if (info.column_name !== undefined) entry.column_name = info.column_name;
      if (info.choices !== undefined) entry.choices = info.choices;
      entry.usedInstances = {};
      if (info.attributes !== undefined) entry.attributes = info.attributes;
      byName.set(u.platform, entry);
    }
    const list = entry.usedInstances[u.instanceUuid] ?? (entry.usedInstances[u.instanceUuid] = []);
    if (!list.includes(u.inputName)) list.push(u.inputName);
  }
  return [...byName.values()];
}

/** 'caller_id' → 'Caller Id'; 'assignment_group' → 'Assignment Group' (label-casing rule for dotted walks without a dictionary label). */
export function labelCase(fieldName: string): string {
  return fieldName
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
