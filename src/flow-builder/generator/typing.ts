/**
 * Pill typing and label_cache labels.
 *
 * The generator types every pill it writes into label_cache from four sources, in this order:
 *   1. catalogue types (trigger outputs, action outputs, wait outputs, error-status fields)
 *   2. types declared in the spec (flow variables, subflow inputs, resolved subflow / custom action definitions)
 *      and, with an instance, the variables of a Get Catalog Variables step (question type → flow type; strict)
 *   3. types declared in the spec's flow.pill_types (symbolic pill → type) — authoritative, no dictionary read
 *   4. `GenerateOptions.resolvePillType(table, dottedPath)` — a sys_dictionary walk for record fields
 * When none applies the pill is typed 'string' and a warning is recorded.
 *
 * Labels follow the label_cache entries of UI-built flows on the PDI (PDI-FACTS §6); every choice is listed in
 * FORMAT-DECISIONS.md.
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

export type PillTypeResolver = (table: string, path: string) => Promise<string | undefined>;

/** What the generator knows about a step that can be the target of a `steps.<key>` pill. */
export interface StepOutputsInfo {
  /** ui_id (uuid) of the instance */
  uuid: string;
  /** flat order (for For Each labels) */
  order: number;
  outputs: { name: string; type: string; label?: string; reference?: string }[];
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

export interface TypingContext {
  trigger?: TriggerDef;
  triggerTable?: string;
  triggerPrefix: string;
  variables: Map<string, VariableDef & { objectFields?: Record<string, string> }>;
  inputs: Map<string, VariableDef>;
  steps: Map<string, StepOutputsInfo>;
  errorHandlerUuid?: string;
  resolvePillType?: PillTypeResolver;
  /** flow.pill_types from the spec: symbolic pill (no braces) → internal type; consulted BEFORE the resolver. */
  declaredPillTypes?: Record<string, string>;
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

async function resolveWalk(ctx: TypingContext, table: string | undefined, path: string[], symbolic: string): Promise<string | undefined> {
  if (!path.length) return undefined;
  const what = `pill ${symbolic}`;
  // A type declared in the spec (flow.pill_types) is authoritative: no dictionary read, no fallback.
  const declared = ctx.declaredPillTypes?.[symbolic];
  if (declared) return declared;
  if (!table) { ctx.warn(`${what}: the record table is not statically known; pill type falls back to "string"`); return undefined; }
  if (!ctx.resolvePillType) { ctx.warn(`${what}: no dictionary resolver (run with an instance or supply resolvePillType); pill type falls back to "string"`); return undefined; }
  const t = await ctx.resolvePillType(table, path.join('.'));
  if (!t) ctx.warn(`${what}: ${table}.${path.join('.')} not found in the dictionary; pill type falls back to "string"`);
  return t;
}

/** Resolve type + label for one symbolic pill. */
export async function resolvePillInfo(ctx: TypingContext, symbolic: string): Promise<PillTypeInfo> {
  const p: ParsedPill = parsePill(symbolic);
  const segLabels = (path: string[]) => path.map(labelCase).join(ARROW);
  switch (p.root) {
    case 'trigger': {
      const t = ctx.trigger;
      if (!t) return fallback(ctx, symbolic, `Trigger${ARROW}${p.name}`);
      const out = triggerOutput(t, p.name);
      const record = isRecordTrigger(t);
      if (record && p.name === 'current') {
        const base = `${t.label_prefix}${ARROW}${ctx.triggerTable} Record`;
        if (!p.path.length) return { type: 'reference', base_type: 'reference', label: base, ui: { reference: ctx.triggerTable } };
        const type = (await resolveWalk(ctx, ctx.triggerTable, p.path, symbolic)) ?? 'string';
        return { type, base_type: type, label: `${base}${ARROW}${segLabels(p.path)}`, ui: fieldUi(ctx.triggerTable, p.path) };
      }
      if (record && p.name === 'table_name' && !p.path.length) {
        return { type: 'table_name', base_type: 'table_name', label: `${t.label_prefix}${ARROW}${ctx.triggerTable} Table` };
      }
      if (!out) {
        ctx.warn(`pill ${symbolic}: trigger "${t.name}" has no output "${p.name}"; typed as string`);
        return { type: 'string', base_type: 'string', label: `${t.label_prefix}${ARROW}${p.name}` };
      }
      const base = `${t.label_prefix}${ARROW}${out.pill_label ?? out.label}`;
      if (!p.path.length) {
        const type = labelTypeFor(out.type);
        return withColumn({ type, base_type: type, label: base }, out.type, out.name);
      }
      if (out.reference) {
        const type = (await resolveWalk(ctx, out.reference, p.path, symbolic)) ?? 'string';
        return { type, base_type: type, label: `${base}${ARROW}${segLabels(p.path)}` };
      }
      // object / records outputs: the output label and type are kept for dot-walks
      const type = labelTypeFor(out.type);
      return { type, base_type: type, label: base };
    }
    case 'steps': {
      const s = ctx.steps.get(p.key);
      if (!s) return fallback(ctx, symbolic, `${p.key}${ARROW}${p.output}`);
      const out = s.outputs.find(o => o.name === p.output);
      const label = `${s.uuid}${ARROW}${p.output}${p.path.length ? ARROW + p.path.join(ARROW) : ''}`;
      if (!out) {
        if (s.strictOutputs && ctx.error) {
          ctx.error(`pill ${symbolic}: "${p.output}" is not ${s.strictOutputs} — valid outputs of step "${p.key}": ${s.outputs.map(o => o.name).join(', ') || 'none'}`);
          return { type: 'string', base_type: 'string', label };
        }
        ctx.warn(`pill ${symbolic}: step "${p.key}" has no output "${p.output}"; typed as string`);
        return { type: 'string', base_type: 'string', label };
      }
      const table = out.reference ?? ((out.type === 'document_id' || out.type === 'reference') ? s.table : undefined);
      if (!p.path.length) {
        const type = labelTypeFor(out.type);
        const info = withColumn({ type, base_type: type, label }, out.type, out.name);
        if (type === 'reference' && table) info.ui = { reference: table };
        return info;
      }
      const type = (await resolveWalk(ctx, table, p.path, symbolic)) ?? 'string';
      return { type, base_type: type, label, ui: fieldUi(table, p.path) };
    }
    case 'loop': {
      const s = ctx.steps.get(p.key);
      if (!s?.loop) return fallback(ctx, symbolic, `For Each${ARROW}item`);
      const itemWord = s.loop.fromVariable ? 'item Record' : 'item';
      const base = `${s.order} - For Each - ${ARROW}${itemWord}`;
      if (!p.path.length) return { type: 'reference', base_type: 'reference', label: base };
      let type: string | undefined;
      if (s.loop.objectFields) {
        type = s.loop.objectFields[p.path[0]];
        if (!type) ctx.warn(`pill ${symbolic}: object field "${p.path[0]}" is not assigned anywhere in the spec; typed as string`);
      } else {
        type = await resolveWalk(ctx, s.loop.table, p.path, symbolic);
      }
      type = type ?? 'string';
      return { type, base_type: type, label: `${base}${ARROW}${segLabels(p.path)}`, ui: s.loop.objectFields ? undefined : fieldUi(s.loop.table, p.path) };
    }
    case 'vars': {
      const v = ctx.variables.get(p.name);
      const label = `Flow Variables${ARROW}${v?.label ?? labelCase(p.name)}`;
      if (!v) return fallback(ctx, symbolic, label, true);
      let type = v.type as string;
      if (p.path.length) type = (await resolveWalk(ctx, v.reference_table, p.path, symbolic)) ?? 'string';
      const info: PillTypeInfo = { type, base_type: type, label, reference_table: null, reference_display: null };
      if (!p.path.length && v.type.startsWith('array.')) info.column_name = v.name;
      return info;
    }
    case 'inputs': {
      const v = ctx.inputs.get(p.name);
      const label = `Input${ARROW}${v?.label ?? labelCase(p.name)}`;
      if (!v) return fallback(ctx, symbolic, label, true);
      let type = v.type as string;
      if (p.path.length) type = (await resolveWalk(ctx, v.reference_table, p.path, symbolic)) ?? 'string';
      return { type, base_type: type, label, reference_table: null, reference_display: null };
    }
    case 'error': {
      const f = ERROR_STATUS_FIELDS[p.name];
      const type = f?.type ?? 'string';
      if (!f) ctx.warn(`pill ${symbolic}: unknown error status field "${p.name}" (known: ${Object.keys(ERROR_STATUS_FIELDS).join(', ')}); typed as string`);
      // UI entry (PDI error-handler snapshot): reference "" and reference_display = the status field label
      return { type, base_type: type, label: `1 - Error Handler${ARROW}Error Status${ARROW}${f?.label ?? labelCase(p.name)}`, ui: { reference: '', reference_display: f?.label ?? labelCase(p.name) } };
    }
    case 'static':
      return { type: 'reference', base_type: 'reference', label: `static${ARROW}${p.sys_id}` };
  }
}

/** UI keys of a single-hop field pill: the table the field lives on and the column; multi-hop walks need a dictionary read, so nothing is added. */
function fieldUi(table: string | undefined, path: string[]): PillTypeInfo['ui'] {
  return table && path.length === 1 ? { parent_table_name: table, column_name: path[0] } : undefined;
}

function withColumn(info: PillTypeInfo, internalType: string, name: string): PillTypeInfo {
  if (internalType === 'records') info.column_name = name;
  return info;
}

function fallback(ctx: TypingContext, symbolic: string, label: string, nulls = false): PillTypeInfo {
  ctx.warn(`pill ${symbolic}: target not found; typed as string`);
  const info: PillTypeInfo = { type: 'string', base_type: 'string', label };
  if (nulls) { info.reference_table = null; info.reference_display = null; }
  return info;
}
