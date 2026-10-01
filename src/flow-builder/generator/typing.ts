/**
 * Pill typing and label_cache entries.
 *
 * The generator types every pill it writes into label_cache from four sources, in this order:
 *   1. catalogue types (trigger outputs, action outputs, wait outputs, error-status fields)
 *   2. types declared in the spec (flow variables, subflow inputs, resolved subflow / custom action definitions)
 *      and, with an instance, the variables of a Get Catalog Variables step (question type → flow type; strict)
 *   3. types declared in the spec's flow.pill_types (symbolic pill → type) — authoritative, no dictionary read
 *   4. `GeneratorExtras.resolvePillField(table, dottedPath)` (a sys_dictionary walk: type, field labels, owning table,
 *      referenced table, the dictionary `choice` attribute) or, without it, `GenerateOptions.resolvePillType` (type only;
 *      labels title-cased). A walk that ends on a choice-list field (sys_dictionary choice 1 / 3) is typed `choice` with
 *      the field's choice list from `GeneratorExtras.resolveFieldChoices(table, element)` (sys_choice, walked child →
 *      parent), in the UI's entry shape (`uiChoiceEntries`) — the dictionary internal_type (integer / string) is kept, with
 *      a warning, when there is no choice resolver (offline) or no rows.
 * When none applies the pill is typed 'string' and a warning is recorded.
 *
 * Every entry key beyond type / label (reference, reference_display, parent_table_name, column_name, choices,
 * attributes) follows the label_cache entries of UI-built flows on the PDI (PDI-FACTS §6, FORMAT-DECISIONS §8). Table
 * labels come from `TypingContext.tableLabel` (a live sys_db_object read, else the catalogue's tables.json, else the
 * title-cased table name).
 *
 * Owner: GENERATOR.
 */
import type { PillTypeInfo } from '../labels.js';
import { labelCase } from '../labels.js';
import type { ParsedPill, VariableDef } from '../spec/types.js';
import { parsePill } from '../pills.js';
import type { TriggerDef } from '../catalog/triggers.js';
import { isRecordTrigger, triggerOutput } from '../catalog/triggers.js';
import { ERROR_STATUS_FIELDS } from '../catalog/error-handler.js';
import { typeLabelFor } from './parameter.js';

export type PillTypeResolver = (table: string, path: string) => Promise<string | undefined>;

/** What a dictionary walk knows about the field a dotted path ends on (resolvers.ts makeDictionaryPillFieldResolver). */
export interface PillFieldInfo {
  /** internal_type of the last field ('GUID' for sys_id). */
  type: string;
  /** Column label of every segment of the path, in order ('Assigned to', 'Sys ID'). */
  labels?: string[];
  /** The table the last field lives on (the parent_table_name of the entry). */
  table?: string;
  /** Referenced table of the last field when it is a reference. */
  reference?: string;
  /** sys_db_object label of that referenced table. */
  reference_label?: string;
  /** Choice list of the last field already in the UI's label_cache form (takes precedence over resolveFieldChoices). */
  choices?: unknown[];
  /** sys_dictionary `choice` of the last field as read ('1' dropdown with -- None --, '3' dropdown without, '2' suggestion; '' / '0' none). */
  choice?: string;
  /** Notes of the walk (a failed read), emitted as plan warnings with the pill name. */
  warnings?: string[];
}
export type PillFieldResolver = (table: string, path: string) => Promise<PillFieldInfo | undefined>;

/** One sys_choice row of a field's choice list (language en, active, no dependent value). */
export interface FieldChoice { label: string; value: string; sequence?: number }
/** The choice list of a field: the table whose sys_choice rows hold it (the walked table or a parent) and the rows in sequence order. */
export interface FieldChoicesInfo { table: string; choices: FieldChoice[]; warnings?: string[] }
/** resolveFieldChoices(table, element): undefined = no rows on the table or any parent (resolvers.ts makeFieldChoicesResolver). */
export type FieldChoicesResolver = (table: string, element: string) => Promise<FieldChoicesInfo | undefined>;

/** A dictionary `choice` attribute that makes the field a dropdown (1 with -- None --, 3 without); 2 = suggestion (a free string), 0 / '' none. */
export function isChoiceList(choice: string | undefined): boolean {
  return choice === '1' || choice === '3';
}

/**
 * A field's choice list in the shape UI-built label_cache entries store it (PDI-FACTS §6, FORMAT-DECISIONS D22): one
 * object per sys_choice row in that key order, `parameters.name` = the table whose sys_choice rows hold the list.
 */
export function uiChoiceEntries(table: string, choices: FieldChoice[]): Record<string, unknown>[] {
  return choices.map(c => ({
    used: false, label: c.label, image: '', reference: false, rawLabel: c.label, selected: false, missing: false, value: c.value,
    parameters: { name: table, dependent_values: [''] },
  }));
}

/** A Get Catalog Variables output: the catalog variable behind it (label_cache attributes catalogType / catalogTypeLabel, choices). */
export interface CatalogOutputInfo { type_code: string; type_label?: string; choices?: unknown[] }

/** What the generator knows about a step that can be the target of a `steps.<key>` pill. */
export interface StepOutputsInfo {
  /** ui_id (uuid) of the instance */
  uuid: string;
  /** flat order (for labels: '<n> - <name>➛…') */
  order: number;
  /** Display name of the action / subflow / logic ('Get Catalog Variables', 'For Each') for the label. */
  name?: string;
  outputs: { name: string; type: string; label?: string; reference?: string; attributes?: Record<string, string>; catalog?: CatalogOutputInfo }[];
  /** the record table the step works on when statically known (its table / table_name / task_table input) */
  table?: string;
  /** for_each only: how to type `item` */
  loop?: { table?: string; objectFields?: Record<string, string>; fromVariable: boolean };
  /** subflow / custom action whose definition could not be resolved: outputs inferred */
  inferred?: boolean;
  /**
   * The outputs are authoritative and dynamic (Get Catalog Variables resolved on an instance): a pill naming another
   * output is a spec ERROR, not a string fallback. The text completes "<output> is not …" (e.g. "a variable of catalog item …").
   */
  strictOutputs?: string;
}

/** A static reference (`{{static.<sys_id>}}`) as the spec described it: the record's display value and table, when given. */
export interface StaticRefInfo { display?: string; table?: string }

export interface TypingContext {
  trigger?: TriggerDef;
  triggerTable?: string;
  triggerPrefix: string;
  variables: Map<string, VariableDef & { objectFields?: Record<string, string> }>;
  inputs: Map<string, VariableDef>;
  steps: Map<string, StepOutputsInfo>;
  errorHandlerUuid?: string;
  resolvePillType?: PillTypeResolver;
  resolvePillField?: PillFieldResolver;
  /** Choice list of a choice-list field a walk ends on (live sys_choice read); absent → the dictionary type is kept + warning. */
  resolveFieldChoices?: FieldChoicesResolver;
  /** flow.pill_types from the spec: symbolic pill (no braces) → internal type; consulted BEFORE the resolver. */
  declaredPillTypes?: Record<string, string>;
  /** The sys_db_object label of a table (live read, catalogue, else title-cased name). */
  tableLabel: (table: string) => Promise<string>;
  /** uiUniqueId of a flow variable / subflow input (label_cache attributes). */
  variableUiId: (kind: 'variable' | 'input', name: string) => string;
  /** Display value / table of the static references the spec carries (approvers, list items). */
  staticRefs: Map<string, StaticRefInfo>;
  warn: (msg: string) => void;
  /** Semantic error sink (strict dynamic outputs); without it such a pill is only warned about. */
  error?: (msg: string) => void;
}

/** Output types as label_cache records them: a document_id output is a record ('reference'); full-UTF8 strings are 'string'. */
export function labelTypeFor(internalType: string): string {
  if (internalType === 'document_id') return 'reference';
  if (internalType === 'string_full_utf8') return 'string';
  return internalType;
}

const ARROW = '➛';
const MAPPER = 'com.glide.flow_design.action.data.FlowDesignVariableMapper';

interface Walk {
  type: string;
  labels: string[];
  table?: string;
  column?: string;
  reference?: string;
  reference_label?: string;
  choices?: unknown[];
}

/** Resolve the field a dotted path ends on: type (sources 3 → 4), labels and the entry keys of a field pill. */
async function resolveWalk(ctx: TypingContext, table: string | undefined, path: string[], symbolic: string): Promise<Walk> {
  const what = `pill ${symbolic}`;
  const single = path.length === 1 && table ? table : undefined;
  const fallback = (type: string): Walk => ({ type, labels: path.map(labelCase), table: single, column: single ? path[0] : undefined });
  // A type declared in the spec (flow.pill_types) is authoritative: no dictionary read, no fallback.
  const declared = ctx.declaredPillTypes?.[symbolic];
  if (declared) return fallback(declared);
  if (!table) { ctx.warn(`${what}: the record table is not statically known; pill type falls back to "string"`); return fallback('string'); }
  if (ctx.resolvePillField) {
    const f = await ctx.resolvePillField(table, path.join('.'));
    if (!f) { ctx.warn(`${what}: ${table}.${path.join('.')} not found in the dictionary; pill type falls back to "string"`); return fallback('string'); }
    for (const w of f.warnings ?? []) ctx.warn(`${what}: ${w}`);
    const labels = f.labels && f.labels.length === path.length ? f.labels : path.map(labelCase);
    const owner = f.table ?? single;
    const column = owner ? path[path.length - 1] : undefined;
    const walk: Walk = { type: f.type, labels, table: owner, column, reference: f.reference, reference_label: f.reference_label, choices: f.choices };
    if (!walk.choices?.length && isChoiceList(f.choice) && owner && column) await applyFieldChoices(ctx, walk, owner, column, f.choice!, what);
    return walk;
  }
  if (!ctx.resolvePillType) { ctx.warn(`${what}: no dictionary resolver (run with an instance or supply resolvePillType); pill type falls back to "string"`); return fallback('string'); }
  const t = await ctx.resolvePillType(table, path.join('.'));
  if (!t) ctx.warn(`${what}: ${table}.${path.join('.')} not found in the dictionary; pill type falls back to "string"`);
  return fallback(t ?? 'string');
}

/**
 * A walk that ends on a choice-list field: type it `choice` (UI-built entries type a choice field `choice`, not by its
 * dictionary internal_type — integer / string) and attach the field's sys_choice list in the UI shape. Without a choice
 * resolver (offline) or without rows the dictionary type is kept and a warning says Workflow Studio will show the raw value.
 */
async function applyFieldChoices(ctx: TypingContext, walk: Walk, table: string, element: string, choice: string, what: string): Promise<void> {
  const field = `${table}.${element}`;
  const kept = `typed "${walk.type}" without its choice list — Workflow Studio shows the raw value instead of the choice label`;
  if (!ctx.resolveFieldChoices) {
    ctx.warn(`${what}: ${field} is a choice field (sys_dictionary choice=${choice}) but there is no choice resolver (offline plan / export); ${kept}`);
    return;
  }
  const r = await ctx.resolveFieldChoices(table, element);
  for (const w of r?.warnings ?? []) ctx.warn(`${what}: ${w}`);
  if (!r?.choices.length) {
    if (!r?.warnings?.length) ctx.warn(`${what}: ${field} is a choice field (sys_dictionary choice=${choice}) but no active sys_choice rows (language en, no dependent value) exist on ${table} or its parent tables; ${kept}`);
    return;
  }
  walk.type = 'choice';
  walk.choices = uiChoiceEntries(r.table, r.choices);
}

/** The entry of a field pill (a dot-walk): reference / reference_display / parent_table_name / column_name / choices, no attributes. */
async function fieldEntry(ctx: TypingContext, w: Walk, label: string): Promise<PillTypeInfo> {
  const info: PillTypeInfo = { type: w.type, base_type: w.type, label };
  if (w.reference) {
    info.reference = w.reference;
    info.reference_display = w.reference_label ?? await ctx.tableLabel(w.reference);
  } else {
    info.reference = '';
    info.reference_display = w.labels[w.labels.length - 1];
  }
  if (w.table) info.parent_table_name = w.table;
  if (w.column) info.column_name = w.column;
  if (w.choices?.length) info.choices = w.choices;
  return info;
}

/** attributes of a flow variable / subflow input entry (PDI-FACTS §6). */
function variableAttributes(type: string, uiUniqueId: string): Record<string, unknown> {
  return { uiType: type, uiTypeLabel: typeLabelFor(type), element_mapping_provider: MAPPER, uiUniqueId, sourceUiUniqueId: '', sourceType: '', sourceId: '' };
}

/** Resolve type + label_cache entry for one symbolic pill. */
export async function resolvePillInfo(ctx: TypingContext, symbolic: string): Promise<PillTypeInfo> {
  const p: ParsedPill = parsePill(symbolic);
  const joined = (labels: string[]) => labels.join(ARROW);
  switch (p.root) {
    case 'trigger': {
      const t = ctx.trigger;
      if (!t) return fallback(ctx, symbolic, `Trigger${ARROW}${p.name}`);
      const out = triggerOutput(t, p.name);
      const record = isRecordTrigger(t);
      const recordTable = record && p.name === 'current' ? ctx.triggerTable : out?.reference ?? (p.name === 'table_name' ? ctx.triggerTable : undefined);
      if (recordTable && (p.name === 'current' || out?.type === 'reference' || out?.type === 'document_id')) {
        const tableLabel = await ctx.tableLabel(recordTable);
        const base = `${t.label_prefix}${ARROW}${tableLabel} Record`;
        if (!p.path.length) return { type: 'reference', base_type: 'reference', label: base, reference: recordTable, reference_display: tableLabel, attributes: { ...(out?.attributes ?? {}) } };
        const w = await resolveWalk(ctx, recordTable, p.path, symbolic);
        return fieldEntry(ctx, w, `${base}${ARROW}${joined(w.labels)}`);
      }
      if (p.name === 'table_name' && !p.path.length && recordTable) {
        const tableLabel = await ctx.tableLabel(recordTable);
        return { type: 'table_name', base_type: 'table_name', label: `${t.label_prefix}${ARROW}${tableLabel} Table`, reference: recordTable, reference_display: tableLabel, attributes: { ...(out?.attributes ?? {}) } };
      }
      if (!out) {
        ctx.warn(`pill ${symbolic}: trigger "${t.name}" has no output "${p.name}"; typed as string`);
        return { type: 'string', base_type: 'string', label: `${t.label_prefix}${ARROW}${p.name}` };
      }
      const outLabel = out.pill_label ?? out.label;
      const base = `${t.label_prefix}${ARROW}${outLabel}`;
      if (!p.path.length) {
        const type = labelTypeFor(out.type);
        return withColumn({ type, base_type: type, label: base, reference_display: outLabel, attributes: { ...(out.attributes ?? {}) } }, out.type, out.name);
      }
      // object / records outputs: the output label and type are kept for dot-walks
      const type = labelTypeFor(out.type);
      return { type, base_type: type, label: base, reference_display: outLabel };
    }
    case 'steps': {
      const s = ctx.steps.get(p.key);
      if (!s) return fallback(ctx, symbolic, `${p.key}${ARROW}${p.output}`);
      const out = s.outputs.find(o => o.name === p.output);
      const stepName = s.name ?? p.key;
      if (!out) {
        const label = `${s.order} - ${stepName}${ARROW}${p.output}${p.path.length ? ARROW + p.path.map(labelCase).join(ARROW) : ''}`;
        if (s.strictOutputs && ctx.error) {
          ctx.error(`pill ${symbolic}: "${p.output}" is not ${s.strictOutputs} — valid outputs of step "${p.key}": ${s.outputs.map(o => o.name).join(', ') || 'none'}`);
          return { type: 'string', base_type: 'string', label };
        }
        ctx.warn(`pill ${symbolic}: step "${p.key}" has no output "${p.output}"; typed as string`);
        return { type: 'string', base_type: 'string', label };
      }
      const table = out.reference ?? ((out.type === 'document_id' || out.type === 'reference') ? s.table : undefined);
      const recordLike = out.type === 'document_id' || out.type === 'reference';
      const tableLabel = table ? await ctx.tableLabel(table) : undefined;
      // 'Record' / 'Table' outputs are labelled by the record's table ('Requested Item Record'); catalog variables by their name
      const outLabel = out.catalog ? out.name
        : recordLike && tableLabel && (out.label ?? out.name) === 'Record' ? `${tableLabel} Record`
        : out.type === 'table_name' && tableLabel ? `${tableLabel} Table`
        : out.label ?? out.name;
      if (!p.path.length) {
        const type = labelTypeFor(out.type);
        const info: PillTypeInfo = { type, base_type: type, label: `${s.order} - ${stepName}${ARROW}${outLabel}` };
        if (out.catalog) {
          info.reference = out.reference ?? '';
          info.reference_display = out.name;
          if (out.catalog.choices?.length) info.choices = out.catalog.choices;
          info.attributes = { catalogType: out.catalog.type_code, ...(out.catalog.type_label ? { catalogTypeLabel: out.catalog.type_label } : {}) };
          return info;
        }
        if ((recordLike || out.type === 'table_name' || out.type === 'records') && table) {
          info.reference = table;
          info.reference_display = tableLabel;
        } else {
          info.reference_display = outLabel;
        }
        withColumn(info, out.type, out.name);
        info.attributes = { ...(out.attributes ?? {}) };
        return info;
      }
      const w = await resolveWalk(ctx, table, p.path, symbolic);
      return fieldEntry(ctx, w, `${s.order}${ARROW}${outLabel}${ARROW}${joined(w.labels)}`);
    }
    case 'loop': {
      const s = ctx.steps.get(p.key);
      if (!s?.loop) return fallback(ctx, symbolic, `For Each${ARROW}item`);
      const itemWord = s.loop.fromVariable ? 'item Record' : 'item';
      const base = `${s.order} - For Each - ${ARROW}${itemWord}`;
      if (!p.path.length) {
        const info: PillTypeInfo = { type: 'reference', base_type: 'reference', label: base };
        if (s.loop.table) { info.reference = s.loop.table; info.reference_display = await ctx.tableLabel(s.loop.table); }
        info.attributes = {};
        return info;
      }
      if (s.loop.objectFields) {
        const type = s.loop.objectFields[p.path[0]];
        if (!type) ctx.warn(`pill ${symbolic}: object field "${p.path[0]}" is not assigned anywhere in the spec; typed as string`);
        const t = type ?? 'string';
        return { type: t, base_type: t, label: `${base}${ARROW}${p.path.map(labelCase).join(ARROW)}`, reference: '', reference_display: labelCase(p.path[p.path.length - 1]) };
      }
      const w = await resolveWalk(ctx, s.loop.table, p.path, symbolic);
      return fieldEntry(ctx, w, `${base}${ARROW}${joined(w.labels)}`);
    }
    case 'vars': {
      const v = ctx.variables.get(p.name);
      const label = `Flow Variables${ARROW}${v?.label ?? labelCase(p.name)}`;
      if (!v) return fallback(ctx, symbolic, label, true);
      if (p.path.length) {
        const w = await resolveWalk(ctx, v.reference_table, p.path, symbolic);
        return fieldEntry(ctx, w, `${label}${ARROW}${joined(w.labels)}`);
      }
      const type = v.type as string;
      const info: PillTypeInfo = { type, base_type: type, label, reference: v.reference_table ?? '', reference_display: v.reference_table ? await ctx.tableLabel(v.reference_table) : '' };
      info.column_name = v.type.startsWith('array.') ? v.name : '';
      info.attributes = variableAttributes(type, ctx.variableUiId('variable', v.name));
      return info;
    }
    case 'inputs': {
      const v = ctx.inputs.get(p.name);
      const label = `Input${ARROW}${v?.label ?? labelCase(p.name)}`;
      if (!v) return fallback(ctx, symbolic, label, true);
      if (p.path.length) {
        const w = await resolveWalk(ctx, v.reference_table, p.path, symbolic);
        return fieldEntry(ctx, w, `${label}${ARROW}${joined(w.labels)}`);
      }
      const type = v.type as string;
      return { type, base_type: type, label, reference: '', reference_display: '', column_name: '', attributes: variableAttributes(type, ctx.variableUiId('input', v.name)) };
    }
    case 'error': {
      const f = ERROR_STATUS_FIELDS[p.name];
      const type = f?.type ?? 'string';
      if (!f) ctx.warn(`pill ${symbolic}: unknown error status field "${p.name}" (known: ${Object.keys(ERROR_STATUS_FIELDS).join(', ')}); typed as string`);
      // UI entry (PDI error-handler snapshot): reference "", reference_display = the status field label, attributes {}
      const fieldLabel = f?.label ?? labelCase(p.name);
      return { type, base_type: type, label: `1 - Error Handler${ARROW}Error Status${ARROW}${fieldLabel}`, reference: '', reference_display: fieldLabel, attributes: {} };
    }
    case 'static': {
      const ref = ctx.staticRefs.get(p.sys_id);
      const info: PillTypeInfo = { type: 'reference', base_type: 'reference', label: ref?.display ?? p.sys_id, reference: ref?.table ?? '', reference_display: ref?.table ? await ctx.tableLabel(ref.table) : '' };
      if (!ref?.display) ctx.warn(`pill ${symbolic}: the static reference has no display value in the spec (give {reference, display, table}); label_cache labels it by its sys_id`);
      return info;
    }
  }
}

function withColumn(info: PillTypeInfo, internalType: string, name: string): PillTypeInfo {
  if (internalType === 'records') info.column_name = name;
  return info;
}

function fallback(ctx: TypingContext, symbolic: string, label: string, variable = false): PillTypeInfo {
  ctx.warn(`pill ${symbolic}: target not found; typed as string`);
  const info: PillTypeInfo = { type: 'string', base_type: 'string', label };
  if (variable) { info.reference = ''; info.reference_display = ''; }
  return info;
}
