/**
 * Generator — FlowSpec → RecordPlan.
 *
 * Writes the Flow Designer platform record format — the rows Workflow Studio stores for a flow, verified against
 * UI-built flows on a PDI (tests/flow-builder/fixtures/pdi/PDI-FACTS.md) and live loader runs; every format choice is
 * listed in src/flow-builder/FORMAT-DECISIONS.md:
 *   - flat 1-based `order` assigned depth-first (children right after their block; stages consume
 *     none; the first child of a Do-In-Parallel block carries '<blockOrder>➛<n>'), parent_ui_id
 *   - default / hidden input merge from the catalogue (entry order = definition order)
 *   - value encoders (generator/values.ts), pill typing + labels (generator/typing.ts)
 *   - extra logic columns flow_variables_assigned / outputs_assigned / connected_to
 *   - stages: component_indexes / stage_id / states / duration
 *   - Flow Error Handler: TOP_LEVEL_TRY (order 0, body nested) + TOP_LEVEL_CATCH (__status__/enabled) + handler steps
 *   - label_cache via labels.ts; pill table; warnings
 *
 * Two passes: the walk assigns ids / orders / parents and registers every step's outputs, then the
 * deferred builders compute `values` in flat order (so pills may point at steps declared later
 * inside the same block — the Do-Until condition — and label_cache keeps first-use order).
 *
 * Row order in `plan.instances` IS the write order. Owner: GENERATOR.
 */
import { ServiceNowError } from '../../utils/errors.js';
import type {
  FlowSpec, GenerateOptions, RecordPlan, RecordRow, CatalogEntry, Step, VariableDef, ValueInput, Trigger, StageDef, DefinitionRef, PillEntry, ApprovalRules, DateTimeInputCheck,
} from '../spec/types.js';
import { isLocalDateTime, parseIsoInstant, SYS_ID_RE } from '../spec/schema.js';
import { sysIdFor, sysIdToUuid, ELEMENT_KEYS } from '../ids.js';
import { encodeValues } from '../encode.js';
import { toPlatformPill, rewritePills, platformPillsInText, PLATFORM_PILL_RE, type PillContext } from '../pills.js';
import { buildLabelCache, labelCase, type PillUsage, type PillTypeInfo } from '../labels.js';
import { findTrigger, descriptorTemplate, isRecordTrigger, DAY_OF_WEEK_LABELS, type TriggerDef, type TriggerDescriptorEntry } from '../catalog/triggers.js';
import { findAction, findActionInput, actionTypeIds, storedInputName, specInputNames, isHiddenInput, isAlwaysStored, type ActionDef, type CatalogInputRaw } from '../catalog/actions.js';
import { findLogic, LOGIC_KEY_BY_KIND, valuesKeyOrder, TIMER_INPUTS, TIMER_DURATION_TYPES, TIMER_OUTPUTS, TOP_LEVEL_TRY, TOP_LEVEL_CATCH } from '../catalog/logic.js';
import { topLevelCatchInputs } from '../catalog/error-handler.js';
import { uiDescriptorTemplate } from '../catalog/ui-descriptors.js';
import { buildCatalogEntries, filterCatalogEntries } from '../catalog/index.js';
import * as V from './values.js';
import { resolvePillInfo, labelTypeFor, type TypingContext, type StepOutputsInfo } from './typing.js';

export type { FlowSpec, GenerateOptions, RecordPlan, CatalogEntry };

/** Marker written to `sys_hub_flow.generation_source` so our flows are recognisable on the instance. */
export const GENERATION_SOURCE = 'snow_mcp_flow_builder';

/** UI-built stage `states` JSON (PDI-FACTS §5; see FORMAT-DECISIONS.md). */
export const STAGE_STATES_JSON = '{"pending":"Pending - has not started","inprogress":"In progress","skipped":"Skipped","complete":"Completed","error":"Error"}';

/** Inputs the generator fills when the spec omits them (the UI always stores them). */
const GENERATOR_INPUT_DEFAULTS: Record<string, Record<string, ValueInput>> = {
  askForApproval: { due_date: V.DUE_DATE_DEFAULT },
};

/**
 * max_length of a flow variable / subflow input / subflow output by type: the value the instance's own rows carry
 * (read-only tallies of sys_hub_flow_variable / sys_hub_flow_input / sys_hub_flow_output by internal_type, kept in
 * tests/flow-builder/fixtures/pdi/samples/max-length-by-type.json). A type the tally does not cover gets 40; array
 * types and `object` 65000. The value differs per table for three types (MAX_LENGTH_BY_TABLE): a boolean flow
 * variable is 32 on the rows the current release writes (all 34 boolean variables created since March 2026; older
 * rows mostly carry 40), while boolean subflow inputs / outputs are 40 (also on every row created since March 2026);
 * subflow outputs store table_name 80 and document_id 32.
 */
const MAX_LENGTH_BY_TYPE: Record<string, string> = {
  string: '8000', boolean: '40', integer: '40', decimal: '15', float: '40', choice: '32', reference: '32', json: '4000',
  table_name: '200', document_id: '200', glide_list: '1024', records: '1024', url: '1024', password2: '255', object: '65000',
};
const MAX_LENGTH_BY_TABLE: Record<string, Record<string, string>> = {
  sys_hub_flow_variable: { boolean: '32' },
  sys_hub_flow_output: { table_name: '80', document_id: '32' },
};

/** max_length a variable / input / output row of this type gets on this table (see MAX_LENGTH_BY_TYPE). */
export function maxLengthFor(table: string, type: string): string {
  if (type.startsWith('array.')) return '65000';
  return MAX_LENGTH_BY_TABLE[table]?.[type] ?? MAX_LENGTH_BY_TYPE[type] ?? '40';
}

// ─── Extra options (additive to the fixed GenerateOptions) ────────────────────

/** A declared input / output of a resolved subflow or custom action. */
export interface DefinitionVariable {
  name: string;
  /** internal_type of the sys_hub_flow_input/output or sys_hub_action_input/output row. */
  type: string;
  sys_id?: string;
  label?: string;
  reference?: string;
  mandatory?: boolean;
  order?: number;
  /** default_value of the row ('' / absent = none). */
  default?: string;
  /** Hidden in Flow Designer (attributes visible=false / visible_in_fd=false): never set by a spec, never "missing". */
  hidden?: boolean;
}

/** A subflow or custom-action definition as resolved on an instance (or supplied by a test double). */
export interface DefinitionInfo {
  sys_id: string;
  name?: string;
  inputs: DefinitionVariable[];
  outputs: DefinitionVariable[];
  /** Application scope of the definition on the instance (sys_scope.scope); a scope other than the flow's is warned about. */
  scope?: string;
  /** Notes from the resolver (e.g. an input row without internal_type); emitted as plan warnings. */
  warnings?: string[];
}

/** A resolver's verdict that the reference is wrong (not found, ambiguous, not a subflow …): a spec error. */
export interface DefinitionError { error: string }

/** What resolveActionType returns: ids to use (absent = keep the catalogue id) + notes emitted as plan warnings. */
export interface ActionTypeResolution { snapshot?: string; definition?: string; warnings?: string[] }

/** The instance time zone a glide_date_time trigger input is read in (resolvers.ts makeInstanceTimeZoneResolver). */
export interface InstanceTimeZone {
  /** IANA zone name, known to Intl. */
  zone: string;
  /**
   * sys_user.time_zone of the authenticated user (used when set) or the system property glide.sys.default.tz. The
   * user-over-system precedence is UNVERIFIED on a PDI (FORMAT-DECISIONS D17): the resolver warns when the zones differ.
   */
  source: 'sys_user.time_zone' | 'glide.sys.default.tz';
  warnings?: string[];
}

/** A variable of a catalog item / variable set, typed for Flow Designer (resolvers.ts catalogVariableType). */
export interface CatalogVariable {
  name: string;
  sys_id: string;
  /** Flow type of the Get Catalog Variables output (string, choice, boolean, reference, glide_date, glide_date_time, glide_list). */
  type: string;
  /** item_option_new.type (the question type code). */
  type_code?: string;
  label?: string;
  /** Reference table of a reference variable (type 8). */
  reference?: string;
  /** The variable set it belongs to (io_set_item / item_option_new_set), when not the item itself. */
  variable_set?: string;
}

/** The variables Get Catalog Variables can output for one template_catalog_item. */
export interface CatalogVariablesInfo {
  /** The template_catalog_item sys_id. */
  item: string;
  kind: 'catalog_item' | 'variable_set';
  name?: string;
  variables: CatalogVariable[];
  warnings?: string[];
}

export interface GeneratorExtras {
  /**
   * The instance time zone for glide_date_time trigger inputs (scheduled.run_once `run_in`): the authenticated user's
   * sys_user.time_zone when set (precedence unverified on a PDI — D17), else glide.sys.default.tz. Given → an ISO-8601 run_in is converted to the instance-local
   * wall time and every run_in is checked to lie in the future. Absent (offline) → an ISO run_in is a spec error.
   * `{error}` = the zone could not be determined (an ISO run_in is then a spec error; a local one is only warned about).
   */
  resolveInstanceTimeZone?: () => Promise<InstanceTimeZone | DefinitionError | undefined>;
  /**
   * The variables of a Get Catalog Variables step's template_catalog_item (item_option_new, incl. its variable sets):
   * they are the step's outputs, typed from the question type. Absent (offline) → outputs untyped (string + warning).
   * `{error}` = the item is neither a catalog item nor a variable set on the instance → spec error.
   */
  resolveCatalogVariables?: (item: string) => Promise<CatalogVariablesInfo | DefinitionError | undefined>;
  /** Clock for the run_in future check (default: new Date()). */
  now?: () => Date;
  /** Override action_type (snapshot) / action_type_parent (definition) per instance, e.g. from sys_hub_action_type_snapshot. */
  resolveActionType?: (action: { key: string; name: string; snapshot: string; definition: string }) => Promise<ActionTypeResolution | undefined>;
  /**
   * Resolve a subflow reference to its sys_id + typed inputs/outputs (sys_hub_flow + sys_hub_flow_input/output).
   * `{error}` = the reference is wrong on this instance (missing / ambiguous / not a subflow) → spec error;
   * undefined = no answer (warning; a {sys_id} reference then falls back to inferred types).
   */
  resolveSubflow?: (ref: DefinitionRef) => Promise<DefinitionInfo | DefinitionError | undefined>;
  /** Resolve a custom action reference (sys_hub_action_type_definition + sys_hub_action_input/output); same contract as resolveSubflow. */
  resolveCustomAction?: (ref: DefinitionRef) => Promise<DefinitionInfo | DefinitionError | undefined>;
  /**
   * What to do with an approver pill whose type cannot be verified (no dictionary read, no flow.pill_types):
   * 'error' (default — build and export: a string/unknown pill in a user/group slot yields ZERO approvers
   * at runtime, so it must never be written) or 'report' (snow_flow_plan: listed in plan.unverifiedApprovers).
   */
  approverPillPolicy?: 'error' | 'report';
}

type Fields = Record<string, string | number | boolean>;
type Entry = Record<string, unknown>;

interface Deferred { row: RecordRow; build: () => Promise<void> }

interface VarInfo { def: VariableDef; sys_id: string; index: number; objectFields?: Record<string, string> }

// ─── Generator ────────────────────────────────────────────────────────────────

class Generator {
  readonly flowKey: string;
  readonly flowSysId: string;
  readonly scope: string;
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  private readonly unverifiedApprovers: { step: string; pill: string }[] = [];
  private readonly usages: PillUsage[] = [];
  private readonly pillTable = new Map<string, { platform: string; info?: PillTypeInfo }>();
  private readonly platformInfo = new Map<string, PillTypeInfo>();
  private counter = 0;
  private pendingPrefix?: number;
  private readonly deferred: Deferred[] = [];
  private readonly instances: RecordRow[] = [];
  private readonly stagePositions = new Map<string, number[]>();
  private readonly stepInfo = new Map<string, StepOutputsInfo>();
  private readonly stepParent = new Map<string, string | undefined>();
  private readonly stepOrder = new Map<string, number>();
  private readonly variables = new Map<string, VarInfo>();
  private readonly inputs = new Map<string, VarInfo>();
  private readonly outputs = new Map<string, VarInfo>();
  private triggerDef?: TriggerDef;
  private triggerTable?: string;
  private triggerPrefix = '';
  private errorHandlerUuid?: string;
  /** glide_date_time trigger inputs by input name (run_in): the stored local value + the future check. */
  private readonly dateTimeInputs = new Map<string, DateTimeInputCheck>();
  private timeZonePromise?: Promise<InstanceTimeZone | DefinitionError | undefined>;
  /**
   * Get Catalog Variables selections by step key: each `catalog_variables` entry (sys_id / name / set sys_id, suffix
   * stripped) → its platform slushbucket token ('<variable sys_id>:item_option_new' / '<set sys_id>:item_option_new_set').
   * Present only when the selection was checked against the item (unknown entries are then already reported).
   */
  private readonly catalogSelections = new Map<string, Map<string, string>>();
  private readonly pillCtx: PillContext;
  private readonly typing: TypingContext;

  constructor(readonly spec: FlowSpec, readonly opts: GenerateOptions & GeneratorExtras) {
    this.flowKey = spec.flow.key;
    this.flowSysId = spec.flow.sys_id ?? sysIdFor(this.flowKey, ELEMENT_KEYS.flow);
    this.scope = spec.flow.scope;
    this.pillCtx = {
      triggerPrefix: '',
      stepUuid: key => this.stepInfo.get(key)?.uuid,
      loopUuid: key => { const s = this.stepInfo.get(key); return s?.loop ? s.uuid : undefined; },
    };
    this.typing = {
      triggerPrefix: '',
      variables: new Map(),
      inputs: new Map(),
      steps: this.stepInfo,
      resolvePillType: opts.resolvePillType,
      declaredPillTypes: spec.flow.pill_types,
      warn: m => this.warn(m),
      error: m => this.error(m),
    };
  }

  warn(msg: string): void { if (!this.warnings.includes(msg)) this.warnings.push(msg); }
  error(msg: string): void { if (!this.errors.includes(msg)) this.errors.push(msg); }

  // ── ids ──
  stepSysId(key: string): string { return sysIdFor(this.flowKey, ELEMENT_KEYS.step(key)); }
  branchSysId(key: string): string { return sysIdFor(this.flowKey, ELEMENT_KEYS.branch(key)); }

  // ── main ──
  async run(): Promise<RecordPlan> {
    const spec = this.spec;
    this.indexVariables();
    this.setupTrigger();
    await this.resolveDateTimeInputs();

    // error handler frame
    let bodyParentUuid = '';
    let tryRow: RecordRow | undefined;
    if (spec.error_handler) {
      const trySysId = sysIdFor(this.flowKey, ELEMENT_KEYS.errorHandler('try'));
      const catchSysId = sysIdFor(this.flowKey, ELEMENT_KEYS.errorHandler(spec.error_handler.key));
      this.errorHandlerUuid = sysIdToUuid(catchSysId);
      this.pillCtx.errorHandlerUuid = this.errorHandlerUuid;
      this.typing.errorHandlerUuid = this.errorHandlerUuid;
      tryRow = this.logicRowRaw(trySysId, TOP_LEVEL_TRY, '0', '', this.emptyValues('error_handler.try'), { comment: '' });
      this.instances.push(tryRow);
      bodyParentUuid = sysIdToUuid(trySysId);
    }

    await this.walk(spec.steps, bodyParentUuid, undefined, undefined);

    if (spec.error_handler) {
      const catchSysId = sysIdFor(this.flowKey, ELEMENT_KEYS.errorHandler(spec.error_handler.key));
      const { orderStr } = this.nextOrder();
      const values = this.orderedValues('error_handler.catch', { inputs: topLevelCatchInputs() });
      const row = this.logicRowRaw(catchSysId, TOP_LEVEL_CATCH, orderStr, '', values, {});
      this.instances.push(row);
      await this.walk(spec.error_handler.steps, this.errorHandlerUuid!, spec.error_handler.key, undefined);
    }

    // deferred: object schemas first (typing of loop items over array variables needs them), then values in flat order
    await this.deriveObjectFields();
    for (const d of this.deferred) { await d.build(); await this.flushTyping(); }

    const variableRows = await this.variableRows();
    const documentation = this.documentationRows();
    const stages = this.stageRows();
    const trigger = this.triggerRow();
    await this.flushTyping();
    const labelCache = buildLabelCache(this.usages, platform => this.platformInfo.get(platform) ?? { type: 'string', base_type: 'string', label: platform });
    const flow = this.flowRow(labelCache);

    if (this.errors.length) {
      throw new ServiceNowError(`spec has ${this.errors.length} semantic error${this.errors.length === 1 ? '' : 's'}`, 'FLOW_BUILDER_INVALID_SPEC', { errors: this.errors, warnings: this.warnings });
    }

    const pills: PillEntry[] = [...this.pillTable.entries()].map(([symbolic, e]) => ({ symbolic, platform: e.platform, type: e.info?.type ?? 'string' }));
    return {
      flowKey: this.flowKey,
      flow: canonicalRow(flow),
      trigger: trigger && canonicalRow(trigger),
      variables: variableRows.map(canonicalRow),
      documentation: documentation.map(canonicalRow),
      stages: stages.map(canonicalRow),
      instances: this.instances.map(canonicalRow),
      labelCache,
      pills,
      warnings: this.warnings,
      ...(this.unverifiedApprovers.length ? { unverifiedApprovers: this.unverifiedApprovers } : {}),
      ...(this.dateTimeInputs.size ? { dateTimeInputs: [...this.dateTimeInputs.values()] } : {}),
    };
  }

  // ── variables / inputs / outputs ──
  private indexVariables(): void {
    (this.spec.variables ?? []).forEach((v, i) => {
      const info: VarInfo = { def: v, sys_id: sysIdFor(this.flowKey, ELEMENT_KEYS.variable(v.name)), index: i };
      this.variables.set(v.name, info);
      this.typing.variables.set(v.name, v);
    });
    (this.spec.inputs ?? []).forEach((v, i) => {
      this.inputs.set(v.name, { def: v, sys_id: sysIdFor(this.flowKey, ELEMENT_KEYS.input(v.name)), index: i });
      this.typing.inputs.set(v.name, v);
    });
    (this.spec.outputs ?? []).forEach((v, i) => {
      this.outputs.set(v.name, { def: v, sys_id: sysIdFor(this.flowKey, ELEMENT_KEYS.output(v.name)), index: i });
    });
  }

  /** array.object variables get their field schema from the append_variables steps that target them. */
  private async deriveObjectFields(): Promise<void> {
    const collect = (steps: Step[]): void => {
      for (const s of steps) {
        if (s.kind === 'append_variables') {
          for (const [name, v] of Object.entries(s.assign)) {
            const vi = this.variables.get(name);
            if (!vi || vi.def.type !== 'array.object') continue;
            for (const obj of objectLiterals(v)) {
              vi.objectFields ??= {};
              for (const [f, fv] of Object.entries(obj)) {
                if (!(f in vi.objectFields)) vi.objectFields[f] = '__pending__';
                (vi as VarInfo & { pending?: Record<string, ValueInput> }).pending ??= {};
                const p = (vi as VarInfo & { pending?: Record<string, ValueInput> }).pending!;
                if (!(f in p)) p[f] = fv;
              }
            }
          }
        }
        for (const child of childSteps(s)) collect(child);
      }
    };
    collect(this.spec.steps);
    if (this.spec.error_handler) collect(this.spec.error_handler.steps);
    for (const vi of this.variables.values()) {
      const pending = (vi as VarInfo & { pending?: Record<string, ValueInput> }).pending;
      if (!vi.objectFields || !pending) continue;
      for (const [f, fv] of Object.entries(pending)) vi.objectFields[f] = await this.inferValueType(fv, `object field "${f}" of variable "${vi.def.name}"`);
      (this.typing.variables.get(vi.def.name) as VariableDef & { objectFields?: Record<string, string> }).objectFields = vi.objectFields;
    }
  }

  private async variableRows(): Promise<RecordRow[]> {
    const rows: RecordRow[] = [];
    const emit = async (table: 'sys_hub_flow_variable' | 'sys_hub_flow_input' | 'sys_hub_flow_output', vi: VarInfo) => {
      const v = vi.def;
      const internal = this.variableInternalType(v.type);
      const fields: Fields = {
        sys_id: vi.sys_id,
        sys_scope: this.scope,
        active: 'true',
        attributes: '',
        default_value: v.default === undefined ? '' : String(v.default),
        element: v.name,
        hint: v.hint ?? '',
        internal_type: internal,
        label: v.label ?? labelCase(v.name),
        mandatory: v.mandatory ? 'true' : 'false',
        max_length: String(v.max_length ?? maxLengthFor(table, v.type)),
        model: this.flowSysId,
        model_id: this.flowSysId,
        model_table: 'sys_hub_flow',
        name: `var__m_${table}_${this.flowSysId}`,
        order: String(vi.index + 1),
      };
      if (v.reference_table && (v.type === 'reference' || v.type === 'array.reference' || v.type === 'glide_list' || v.type === 'records')) fields.reference = v.reference_table;
      if (v.type.startsWith('array.')) {
        const coId = `FD${vi.sys_id}`;
        const elementType = v.type.slice('array.'.length);
        const childTypeLabel = uiTypeLabel(elementType);
        fields.attributes = [
          `co_type_name=${coId}`,
          'element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper',
          `uiType=${v.type}`,
          `uiTypeLabel=Array.${childTypeLabel}`,
          `uiUniqueId=${this.flowSysId}-${v.name}`,
          'child_maxsize=0', 'child_hint=', 'child_label=Item', 'child_name=item',
          `child_type=${elementType}`, `child_type_label=${childTypeLabel}`,
          `child_uiUniqueId=${this.flowSysId}-${v.name}-child`, 'max_rows=', 'child_defaultValue=',
        ].join(',');
        if (v.type === 'array.object') {
          rows.push({
            table: 'sys_complex_object',
            sys_id: sysIdFor(this.flowKey, `complex_object:${v.name}`),
            fields: {
              sys_id: sysIdFor(this.flowKey, `complex_object:${v.name}`),
              sys_scope: this.scope,
              name: coId,
              namespace: 'FlowDesigner',
              serialized_content: JSON.stringify(this.complexObjectSchema(vi)),
              type: 'complex_object_collection',
            },
          });
          if (!vi.objectFields) this.warn(`variable "${v.name}" (array.object) has no append_variables step assigning an object: its field schema is empty (spec v1 cannot declare object fields)`);
        } else {
          this.warn(`variable "${v.name}" (${v.type}): array variables of scalar elements were not observed on a UI-built flow or a live run — row shape INFERRED, verify on the PDI`);
        }
      } else if (v.type === 'object') {
        this.warn(`variable "${v.name}" (object): FlowObject variables need a field schema the spec cannot express — verify on the PDI`);
      }
      rows.push({ table, sys_id: vi.sys_id, fields });
    };
    for (const vi of this.variables.values()) await emit('sys_hub_flow_variable', vi);
    for (const vi of this.inputs.values()) await emit('sys_hub_flow_input', vi);
    for (const vi of this.outputs.values()) await emit('sys_hub_flow_output', vi);
    return rows;
  }

  private variableInternalType(t: string): string {
    if (t === 'time') return 'glide_time';
    if (t === 'object' || t.startsWith('array.')) return 'string';
    return t;
  }

  /** The sys_complex_object schema of an array.object variable (FORMAT-DECISIONS D15). */
  private complexObjectSchema(vi: VarInfo): Record<string, unknown> {
    const coId = `FD${vi.sys_id}`;
    const facet = (o: Record<string, unknown>) => ({ SimpleMapFacet: JSON.stringify(o) });
    const item: Record<string, unknown> = {};
    let i = 0;
    for (const [f, t] of Object.entries(vi.objectFields ?? {})) {
      i++;
      item[f] = coTypeName(t);
      item[`${f}.$field_facets`] = facet({ uiTypeLabel: uiTypeLabel(t), read_only: 'false', uiType: t, choiceOption: '', default_value: '', hint: '', label: labelCase(f), mandatory: 'false', order: String(i), max_length: '0' });
    }
    const typeFacets = facet(this.arrayTypeFacets(vi));
    const schema: Record<string, unknown> = {};
    schema[`FlowDesigner:${coId}`] = {
      $COCollectionField: [{ item }],
      '$COCollectionField.$field_facets': facet({ 'up-shift-collection-level': 'true' }),
      '$COCollectionField.$type_facets': typeFacets,
    };
    schema[`FlowDesigner:${coId}.$type_facets`] = typeFacets;
    return schema;
  }

  /** Type facets of an array.object variable, in a fixed key order (FORMAT-DECISIONS D15). */
  private arrayTypeFacets(vi: VarInfo): Record<string, string> {
    return {
      sourceId: '', max_rows: '', choiceOption: '', default_value: '', label: vi.def.label ?? labelCase(vi.def.name), child_hint: '', child_maxsize: '0', mandatory: 'false',
      child_name: 'item', uiUniqueId: `${this.flowSysId}-${vi.def.name}`, uiTypeLabel: 'Array.Object', co_type_name: `FD${vi.sys_id}`, child_label: 'Item', child_type_label: 'Object',
      read_only: 'false', sourceUiUniqueId: '', sourceType: '', hint: '', uiType: 'array.object', child_defaultValue: '', child_type: 'object', order: String(vi.index), max_length: '65000',
      child_uiUniqueId: `${this.flowSysId}-${vi.def.name}-child`,
    };
  }

  /** Parameter mirror of an array.object variable on a single-object Append entry (FORMAT-DECISIONS D15). */
  private arrayVariableParameter(vi: VarInfo): Record<string, unknown> {
    const generic = new Set(['choiceOption', 'default_value', 'label', 'mandatory', 'read_only', 'hint', 'order', 'max_length']);
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.arrayTypeFacets(vi))) if (!generic.has(k)) attributes[k] = v;
    return {
      children: [], type_label: 'Array.Object', id: '', label: vi.def.label ?? labelCase(vi.def.name), name: vi.def.name, type: 'array.object',
      order: vi.index, extended: false, mandatory: false, readOnly: false, hint: '', maxsize: 65000, reference: '', reference_display: '',
      choiceOption: '', table: '', columnName: '', defaultValue: '', use_dependent: false, fShowReferenceFinder: false, local: false,
      attributes, ref_qual: '', dependent_on: '',
    };
  }

  private documentationRows(): RecordRow[] {
    const rows: RecordRow[] = [];
    const emit = (table: string, vi: VarInfo, docKey: string) => {
      const label = vi.def.label ?? labelCase(vi.def.name);
      const sysId = sysIdFor(this.flowKey, ELEMENT_KEYS.variableDoc(docKey));
      rows.push({ table: 'sys_documentation', sys_id: sysId, fields: { sys_id: sysId, sys_scope: this.scope, element: vi.def.name, hint: vi.def.hint ?? '', label, language: 'en', name: `var__m_${table}_${this.flowSysId}`, plural: '' } });
    };
    for (const vi of this.variables.values()) emit('sys_hub_flow_variable', vi, vi.def.name);
    for (const vi of this.inputs.values()) emit('sys_hub_flow_input', vi, `input:${vi.def.name}`);
    for (const vi of this.outputs.values()) emit('sys_hub_flow_output', vi, `output:${vi.def.name}`);
    return rows;
  }

  // ── stages ──
  private stageRows(): RecordRow[] {
    return (this.spec.stages ?? []).map((st: StageDef, i) => {
      const sysId = sysIdFor(this.flowKey, ELEMENT_KEYS.stage(st.value));
      const positions = this.stagePositions.get(st.value) ?? [];
      return {
        table: 'sys_hub_flow_stage', sys_id: sysId, fields: {
          sys_id: sysId, sys_scope: this.scope,
          always_show: st.always_show ? 'true' : 'false',
          ancestor_array_position: '-1', ancestor_component_id: '', ancestor_stage_id: '', ancestral_if_else_logic: '',
          component_indexes: positions.join(','),
          duration: V.durationToGlide(st.duration),
          flow: this.flowSysId, label: st.label, order: String(i), stage_id: sysIdToUuid(sysId),
          states: STAGE_STATES_JSON, type: 'standard', value: st.value,
        },
      };
    });
  }

  // ── trigger ──
  private setupTrigger(): void {
    const t = this.spec.trigger;
    if (!t) return;
    if (t.type === 'custom') {
      this.triggerPrefix = `${t.name}_1`;
      this.warn(`custom trigger "${t.name}": descriptor entries are built with a minimal parameter object (no catalogue definition) — verify on the instance`);
    } else {
      const def = findTrigger(t.type);
      if (!def) { this.error(`unknown trigger type "${t.type}"`); return; }
      this.triggerDef = def;
      this.triggerPrefix = def.pill_prefix;
      if ('table' in t && isRecordTrigger(def)) this.triggerTable = t.table;
      this.typing.trigger = def;
      this.typing.triggerTable = this.triggerTable;
    }
    this.pillCtx.triggerPrefix = this.triggerPrefix;
    this.typing.triggerPrefix = this.triggerPrefix;
  }

  /** The instance time zone, read once per plan (only when a glide_date_time trigger input needs it). */
  private instanceTimeZone(): Promise<InstanceTimeZone | DefinitionError | undefined> {
    const resolver = this.opts.resolveInstanceTimeZone;
    if (!resolver) return Promise.resolve(undefined);
    this.timeZonePromise ??= resolver().catch((e: unknown) => ({ error: `the instance time zone could not be read (${(e as Error).message})` }));
    return this.timeZonePromise;
  }

  /**
   * glide_date_time trigger inputs (FORMAT-DECISIONS D17). The platform stores them as given (value == displayValue)
   * and reads them in the INSTANCE time zone (the user's sys_user.time_zone, else glide.sys.default.tz) — unlike the
   * glide_time of Daily / Weekly / Monthly, which is converted to UTC. The catalogue has one: scheduled.run_once
   * `run_in`; every catalogue trigger input typed glide_date_time goes through here (custom triggers are untyped).
   *   - 'YYYY-MM-DD HH:MM:SS' → stored as given (instance-local);
   *   - ISO-8601 instant ('…Z' / '…+02:00') → converted to the instance-local wall time (Intl, DST-correct); needs the
   *     instance zone — offline it is a spec error;
   *   - with the zone known: the instance's current wall time is computed and a value that is not strictly later is
   *     warned about (activation would fire the flow immediately; snow_flow_build refuses it unless allow_past_run).
   */
  private async resolveDateTimeInputs(): Promise<void> {
    const t = this.spec.trigger;
    const def = this.triggerDef;
    if (!t || t.type === 'custom' || !def) return;
    if (t.type === 'scheduled.run_once' && t.timezone) {
      this.warn(`trigger "${t.key}": timezone "${t.timezone}" is ignored on scheduled.run_once — run_in is read in the instance time zone; give an ISO-8601 instant ("…Z" or "…+02:00") to have it converted`);
    }
    for (const input of def.inputs) {
      if (input.type !== 'glide_date_time') continue;
      const raw = (t as unknown as Record<string, unknown>)[input.name];
      if (typeof raw !== 'string') continue;
      this.dateTimeInputs.set(input.name, await this.localDateTime(input.name, raw));
    }
  }

  private async localDateTime(name: string, given: string): Promise<DateTimeInputCheck> {
    const what = `trigger input "${name}"`;
    const instant = isLocalDateTime(given) ? undefined : parseIsoInstant(given);
    const check: DateTimeInputCheck = { input: name, given, form: instant ? 'iso' : 'local', local: given };
    const tz = await this.instanceTimeZone();
    const known = tz && !('error' in tz) ? tz : undefined;
    if (known) for (const w of known.warnings ?? []) this.warn(`${what}: ${w}`);
    if (instant) {
      if (!known) {
        this.error(tz && 'error' in tz
          ? `${what}: "${given}" is an ISO-8601 instant, but ${tz.error} — give the instance-local form "YYYY-MM-DD HH:MM:SS"`
          : `${what}: "${given}" is an ISO-8601 instant — converting it to the instance-local wall time the platform stores needs the instance time zone: plan / build with an instance, or give the instance-local form "YYYY-MM-DD HH:MM:SS"`);
        return check;
      }
      check.local = V.wallTimeIn(known.zone, instant);
      this.warn(`${what}: "${given}" converted to "${check.local}" — the wall time in the instance time zone ${known.zone} (${known.source}), which is how the platform reads it`);
    }
    // the instants the platform may read the stored wall time as (two in a DST overlap, none in a gap)
    const candidates = known ? V.instantsForWallTime(known.zone, check.local) : [];
    if (known && instant) {
      if (candidates.length > 1) {
        this.warn(`${what}: "${given}" converts to "${check.local}", a wall time that occurs twice in ${known.zone} (the hour repeats at the daylight-saving change) — the stored value cannot say which one is meant and the platform may read it as the earlier one (${candidates[0].toISOString()}); the future check uses the earlier one. Give an instant outside the repeated hour to be unambiguous`);
      }
    } else if (known) {
      if (candidates.length === 0) this.warn(`${what}: "${given}" does not exist in ${known.zone} (the clock skips it at the daylight-saving change) — give another time or an ISO-8601 instant`);
      if (candidates.length > 1) this.warn(`${what}: "${given}" occurs twice in ${known.zone} (the hour repeats at the daylight-saving change) — the stored wall time cannot pin one of them (an ISO-8601 instant converts to the same wall time); the future check uses the earlier one`);
    }
    if (!known) {
      // live but the zone is unknown: the value is kept as given and cannot be checked
      if (tz && 'error' in tz) this.warn(`${what}: "${given}" is stored as given (instance-local) but NOT checked to lie in the future: ${tz.error}`);
      return check;
    }
    check.zone = known.zone;
    check.zone_source = known.source;
    const now = (this.opts.now ?? (() => new Date()))();
    check.instance_now = V.wallTimeIn(known.zone, now);
    // What is stored is the wall time, so both forms are judged by it: strictly later than the instance's wall time now
    // (lexicographic == chronological for this form) AND, when the wall time is ambiguous (DST overlap), its EARLIEST
    // reading still lies in the future — so in_future:true never appears with local <= instance_now, and an instant in
    // the repeated hour is not reported as future when the platform may read it as the already-past first occurrence.
    const earliest = candidates.length ? Math.min(...candidates.map(d => d.getTime())) : undefined;
    check.in_future = check.local > check.instance_now && (earliest === undefined || earliest > now.getTime());
    if (!check.in_future) {
      this.warn(`${what}: "${check.local}" (instance time zone ${known.zone}) is NOT in the future — the instance time is now ${check.instance_now}; on activation the flow would fire IMMEDIATELY. snow_flow_build refuses this unless allow_past_run:true`);
    }
    return check;
  }

  private triggerRow(): RecordRow | undefined {
    const t = this.spec.trigger;
    if (!t) return undefined;
    const sysId = sysIdFor(this.flowKey, ELEMENT_KEYS.trigger);
    const uuid = sysIdToUuid(sysId);
    let name: string; let definition: string; let triggerType: string; let entries: TriggerDescriptorEntry[];
    if (t.type === 'custom') {
      name = t.name; definition = t.definition; triggerType = t.trigger_type;
      entries = Object.entries(t.inputs).map(([n, v]) => {
        const val = this.renderScalarOrPill(v, uuid, n);
        return { triggerInstanceSysId: '', label: labelCase(n), internalType: 'string', dependent: '', choiceList: [], mandatory: false, order: 100, name: n, value: val, displayValue: String(val), displayField: '', scriptActive: false, children: [], parameter: { type: 'string', name: n, label: labelCase(n) } };
      });
    } else {
      const def = this.triggerDef;
      if (!def) return undefined;
      name = def.name; definition = def.sys_id; triggerType = def.trigger_type;
      const values = this.triggerInputValues(t, uuid);
      const ui = uiDescriptorTemplate(def.name);
      if (ui) {
        // UI-built form (FORMAT-DECISIONS D5): the captured entry shape, values in the UI's storage form
        entries = ui;
        for (const e of entries) if (e.name in values) setUiDescriptorValue(e, values[e.name].value);
      } else {
        entries = descriptorTemplate(def);
        for (const e of entries) {
          if (!(e.name in values)) continue;
          const { value, displayValue } = values[e.name];
          e.value = value;
          e.displayValue = displayValue ?? String(value);
        }
      }
      for (const k of Object.keys(values)) if (!entries.some(e => e.name === k)) this.warn(`trigger input "${k}" is not part of the ${def.name} descriptor and was dropped`);
    }
    return {
      table: 'sys_hub_trigger_instance_v2', sys_id: sysId, fields: {
        sys_id: sysId, sys_scope: this.scope, category: '', comment: t.annotation ?? '', flow: this.flowSysId, name,
        trigger_definition: definition, trigger_inputs: encodeValues(entries), trigger_outputs: '', trigger_type: triggerType,
      },
    };
  }

  /** Spec trigger fields → descriptor input values (by input name). */
  private triggerInputValues(t: Exclude<Trigger, { type: 'custom' }>, uuid: string): Record<string, { value: unknown; displayValue?: string }> {
    const out: Record<string, { value: unknown; displayValue?: string }> = {};
    const set = (name: string, value: unknown, displayValue?: string) => { out[name] = { value, displayValue }; };
    switch (t.type) {
      case 'record.created':
      case 'record.updated':
      case 'record.created_or_updated': {
        set('table', t.table);
        if (t.condition !== undefined) set('condition', this.renderText(t.condition, uuid, 'condition'));
        if (t.run_flow_in) set('run_flow_in', t.run_flow_in);
        if (t.run_on_extended !== undefined) set('run_on_extended', String(t.run_on_extended));
        if (t.run_when_setting) set('run_when_setting', t.run_when_setting);
        if (t.run_when_user_setting) set('run_when_user_setting', t.run_when_user_setting);
        if (t.run_when_user_list) set('run_when_user_list', V.encodeList(t.run_when_user_list as V.ListItem[], 'glide_list', s => this.renderPill(s, uuid, 'run_when_user_list')));
        if (t.type !== 'record.created' && t.trigger_strategy) set('trigger_strategy', t.trigger_strategy);
        break;
      }
      case 'scheduled.daily': set('time', V.timeToGlide(t.time, t.timezone)); break;
      case 'scheduled.weekly': {
        const dow = typeof t.day_of_week === 'number' ? t.day_of_week : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].indexOf(t.day_of_week) + 1;
        set('day_of_week', String(dow), DAY_OF_WEEK_LABELS[dow]);
        set('time', V.timeToGlide(t.time, t.timezone));
        break;
      }
      case 'scheduled.monthly': set('day_of_month', t.day_of_month, String(t.day_of_month)); set('time', V.timeToGlide(t.time, t.timezone)); break;
      case 'scheduled.repeat': set('repeat', V.durationToGlide(t.repeat)); break;
      case 'scheduled.run_once': set('run_in', this.dateTimeInputs.get('run_in')?.local ?? t.run_in); break;
      case 'email.inbound':
        if (t.email_conditions !== undefined) set('email_conditions', this.renderText(t.email_conditions, uuid, 'email_conditions'));
        if (t.order !== undefined) set('order', t.order, String(t.order));
        if (t.stop_condition_evaluation !== undefined) set('stop_condition_evaluation', t.stop_condition_evaluation, String(t.stop_condition_evaluation));
        if (t.target_table) set('target_table', t.target_table);
        break;
      case 'catalog.service_catalog': if (t.run_flow_in) set('run_flow_in', t.run_flow_in); break;
      case 'remote_table.query': set('u_table', t.table); break;
      case 'sla.task':
      case 'knowledge.management':
        break;
    }
    return out;
  }

  // ── flow row ──
  private flowRow(labelCache: unknown): RecordRow {
    const f = this.spec.flow;
    const fields: Fields = {
      sys_id: this.flowSysId,
      sys_scope: this.scope,
      access: f.access ?? 'public',
      active: 'false',
      allow_high_security_roles: f.allow_high_security_roles ? 'true' : 'false',
      annotation: f.annotation ?? '',
      category: f.category ?? '',
      description: f.description ?? '',
      flow_priority: f.flow_priority ?? '', // UI-built user flows store '' (PDI-FACTS §4) — FORMAT-DECISIONS D10
      generation_source: GENERATION_SOURCE,
      internal_name: f.internal_name ?? V.internalNameFor(f.name),
      label_cache: JSON.stringify(labelCache),
      name: f.name,
      run_as: f.run_as,
      run_with_roles: [...new Set(f.run_with_roles ?? [])].join(','),
      show_draft_actions: f.show_draft_actions ? 'true' : 'false',
      status: 'draft',
      sys_policy: '',
      type: f.type,
      version: '2',
    };
    if (f.callable_by_client_api !== undefined) fields.callable_by_client_api = f.callable_by_client_api ? 'true' : 'false';
    if (f.allow_high_security_roles && f.run_as !== 'user') this.warn('allow_high_security_roles is only honoured with run_as "user"');
    return { table: 'sys_hub_flow', sys_id: this.flowSysId, fields };
  }

  // ── walk ──
  private nextOrder(): { n: number; orderStr: string } {
    const n = ++this.counter;
    const orderStr = this.pendingPrefix !== undefined ? `${this.pendingPrefix}➛${n}` : String(n);
    this.pendingPrefix = undefined;
    return { n, orderStr };
  }

  private markStage(step: Step, n: number): void {
    if (step.stage === undefined) return;
    const list = this.stagePositions.get(step.stage) ?? [];
    list.push(n - 1);
    this.stagePositions.set(step.stage, list);
  }

  private async walk(steps: Step[], parentUuid: string, parentKey: string | undefined, _blockOrder: number | undefined): Promise<void> {
    for (const step of steps) {
      this.stepParent.set(step.key, parentKey);
      switch (step.kind) {
        case 'action': await this.emitAction(step, parentUuid); break;
        case 'custom_action': await this.emitCustomAction(step, parentUuid); break;
        case 'subflow': await this.emitSubflow(step, parentUuid); break;
        case 'if': {
          const { uuid } = this.emitLogic(step.key, this.stepSysId(step.key), 'if', parentUuid, step, () => this.conditionValues('if', step.condition, step.key, false, labelOf(step)));
          await this.walk(step.then, uuid, step.key, undefined);
          for (const b of step.else_if ?? []) {
            this.stepParent.set(b.key, parentKey);
            const r = this.emitLogic(b.key, this.branchSysId(b.key), 'else_if', parentUuid, undefined, () => this.conditionValues('else_if', b.condition, b.key, false, labelOf(b)));
            await this.walk(b.steps, r.uuid, b.key, undefined);
          }
          if (step.else) {
            this.stepParent.set(step.else.key, parentKey);
            const r = this.emitLogic(step.else.key, this.branchSysId(step.else.key), 'else', parentUuid, undefined, async () => this.emptyValues('else'));
            await this.walk(step.else.steps, r.uuid, step.else.key, undefined);
          }
          break;
        }
        case 'for_each': {
          const r = this.emitLogic(step.key, this.stepSysId(step.key), 'for_each', parentUuid, step, async () => this.forEachValues(step));
          this.registerLoop(step, r.uuid, r.n);
          await this.walk(step.steps, r.uuid, step.key, undefined);
          break;
        }
        case 'do_until': {
          const r = this.emitLogic(step.key, this.stepSysId(step.key), 'do_until', parentUuid, step, () => this.conditionValues('do_until', step.condition, step.key, true, labelOf(step)));
          await this.walk(step.steps, r.uuid, step.key, undefined);
          break;
        }
        case 'try_catch': {
          const tryRow = this.emitLogic(step.key, this.stepSysId(step.key), 'try', parentUuid, step, async () => this.emptyValues('try'));
          await this.walk(step.try, tryRow.uuid, step.key, undefined);
          this.stepParent.set(step.catch.key, parentKey);
          const catchRow = this.emitLogic(step.catch.key, this.branchSysId(step.catch.key), 'catch', parentUuid, undefined, async () => this.emptyValues('catch'), { connected_to: tryRow.uuid });
          await this.walk(step.catch.steps, catchRow.uuid, step.catch.key, undefined);
          break;
        }
        case 'do_in_parallel': {
          const par = this.emitLogic(step.key, this.stepSysId(step.key), 'do_in_parallel', parentUuid, step, async () => this.emptyValues('do_in_parallel'));
          for (const b of step.branches) {
            this.stepParent.set(b.key, step.key);
            const block = this.emitLogic(b.key, this.branchSysId(b.key), 'parallel_block', par.uuid, undefined, async () => this.emptyValues('parallel_block'));
            this.pendingPrefix = block.n;
            await this.walk(b.steps, block.uuid, b.key, block.n);
            this.pendingPrefix = undefined;
          }
          break;
        }
        case 'end_flow':
          if (!parentKey && !this.spec.error_handler) this.warn(`end_flow "${step.key}" at the top level of the flow (not verified on a UI-built flow — End is normally placed inside a block)`);
          this.emitLogic(step.key, this.stepSysId(step.key), 'end_flow', parentUuid, step, async () => this.emptyValues('end_flow'));
          break;
        case 'exit_loop': this.emitLogic(step.key, this.stepSysId(step.key), 'exit_loop', parentUuid, step, async () => this.emptyValues('exit_loop')); break;
        case 'skip_iteration': this.emitLogic(step.key, this.stepSysId(step.key), 'skip_iteration', parentUuid, step, async () => this.emptyValues('skip_iteration')); break;
        case 'wait': {
          const r = this.emitLogic(step.key, this.stepSysId(step.key), 'wait', parentUuid, step, () => this.waitValues(step));
          this.stepInfo.set(step.key, { uuid: r.uuid, order: r.n, outputs: Object.entries(TIMER_OUTPUTS).map(([name, type]) => ({ name, type })) });
          break;
        }
        case 'set_variables':
          this.emitLogic(step.key, this.stepSysId(step.key), 'set_variables', parentUuid, step, () => this.setVariablesValues(step), { flow_variables_assigned: Object.keys(step.assign).join(',') });
          break;
        case 'append_variables':
          this.emitLogic(step.key, this.stepSysId(step.key), 'append_variables', parentUuid, step, () => this.appendVariablesValues(step), { flow_variables_assigned: Object.keys(step.assign).join(',') });
          break;
        case 'assign_subflow_outputs':
          this.emitLogic(step.key, this.stepSysId(step.key), 'assign_subflow_outputs', parentUuid, step, () => this.assignOutputsValues(step), { outputs_assigned: Object.keys(step.assign).join(',') });
          break;
      }
    }
  }

  // ── logic rows ──
  private logicRowRaw(sysId: string, definition: string, orderStr: string, parentUuid: string, values: Record<string, unknown>, extra: Fields): RecordRow {
    const fields: Fields = { sys_id: sysId, sys_scope: this.scope, flow: this.flowSysId, logic_definition: definition, order: orderStr, ui_id: sysIdToUuid(sysId), values: encodeValues(values), ...extra };
    if (parentUuid) fields.parent_ui_id = parentUuid;
    return { table: 'sys_hub_flow_logic_instance_v2', sys_id: sysId, fields };
  }

  private emitLogic(
    key: string, sysId: string, logicKey: string, parentUuid: string, step: Step | undefined,
    build: () => Promise<Record<string, unknown>>, extra: Fields = {},
  ): { uuid: string; n: number } {
    const def = findLogic(logicKey);
    if (!def) throw new ServiceNowError(`flow-builder catalogue: unknown logic "${logicKey}"`, 'FLOW_BUILDER_CATALOG');
    const { n, orderStr } = this.nextOrder();
    if (step) this.markStage(step, n);
    this.stepOrder.set(key, n);
    const uuid = sysIdToUuid(sysId);
    const fields: Fields = { sys_id: sysId, sys_scope: this.scope, flow: this.flowSysId, logic_definition: def.sys_id, order: orderStr, ui_id: uuid, values: '', ...extra };
    if (logicKey !== 'catch' && logicKey !== 'parallel_block') fields.comment = step?.annotation ?? '';
    if (parentUuid) fields.parent_ui_id = parentUuid;
    const row: RecordRow = { table: 'sys_hub_flow_logic_instance_v2', sys_id: sysId, fields };
    this.instances.push(row);
    if (!this.stepInfo.has(key)) this.stepInfo.set(key, { uuid, order: n, outputs: [] });
    this.deferred.push({ row, build: async () => { row.fields.values = encodeValues(await build()); } });
    return { uuid, n };
  }

  private emptyValues(logicKey: string): Record<string, unknown> {
    return this.orderedValues(logicKey, {});
  }

  private orderedValues(logicKey: string, filled: Record<string, unknown[]>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of valuesKeyOrder(logicKey)) out[k] = filled[k] ?? [];
    return out;
  }

  private logicEntry(name: string, value: unknown, displayValue: unknown, id = ''): Entry {
    return { id, name, value, displayValue, children: [], parameter: {}, scriptActive: false };
  }

  /** If / Else If / Do-Until values: [condition_name (only when the step / branch has a `label`), condition]. */
  private async conditionValues(logicKey: string, condition: string, ownerKey: string, allowForward = false, label?: string): Promise<Record<string, unknown>> {
    const uuid = this.stepInfo.get(ownerKey)!.uuid;
    const value = this.renderText(condition, uuid, 'condition', ownerKey, allowForward);
    const inputs: Entry[] = [];
    if (label) inputs.push(this.logicEntry('condition_name', label, label));
    inputs.push(this.logicEntry('condition', value, value));
    return this.orderedValues(logicKey, { inputs });
  }

  private registerLoop(step: Extract<Step, { kind: 'for_each' }>, uuid: string, order: number): void {
    const items = step.items.pill;
    const loop: NonNullable<StepOutputsInfo['loop']> = { fromVariable: false };
    const seg = items.split('.');
    if (seg[0] === 'steps') {
      const src = this.stepInfo.get(seg[1]);
      loop.table = src?.table;
      const out = src?.outputs.find(o => o.name === seg[2]);
      if (out?.reference) loop.table = out.reference;
      if (out && out.type !== 'records' && out.type !== 'array.object') this.warn(`for_each "${step.key}": "${items}" is not a records output (${out.type})`);
    } else if (seg[0] === 'vars') {
      const vi = this.variables.get(seg[1]);
      loop.fromVariable = true;
      if (vi?.def.type === 'array.object') loop.objectFields = vi.objectFields ?? {};
      else if (vi?.def.type === 'array.reference') loop.table = vi.def.reference_table;
      else if (vi && !vi.def.type.startsWith('array.')) this.warn(`for_each "${step.key}": variable "${seg[1]}" is not an array (${vi.def.type})`);
    } else if (seg[0] === 'trigger') {
      loop.table = this.triggerTable;
    } else if (seg[0] === 'inputs') {
      const vi = this.inputs.get(seg[1]);
      loop.fromVariable = true;
      if (vi?.def.type === 'array.reference') loop.table = vi.def.reference_table;
    }
    this.stepInfo.set(step.key, { uuid, order, outputs: [{ name: 'item', type: 'reference' }], loop });
  }

  private async forEachValues(step: Extract<Step, { kind: 'for_each' }>): Promise<Record<string, unknown>> {
    const uuid = this.stepInfo.get(step.key)!.uuid;
    // late binding: an array.object variable's fields are known only after deriveObjectFields
    const info = this.stepInfo.get(step.key)!;
    if (info.loop?.fromVariable) {
      const seg = step.items.pill.split('.');
      const vi = this.variables.get(seg[1]);
      if (vi?.def.type === 'array.object') info.loop.objectFields = vi.objectFields ?? {};
    }
    const value = await this.renderPillTyped(step.items.pill, uuid, 'items', step.key);
    return this.orderedValues('for_each', { inputs: [{ id: '', name: 'items', value, displayValue: value }] });
  }

  private async waitValues(step: Extract<Step, { kind: 'wait' }>): Promise<Record<string, unknown>> {
    const uuid = this.stepInfo.get(step.key)!.uuid;
    const dt = TIMER_DURATION_TYPES[step.duration_type];
    const vals: Record<string, { value: unknown; displayValue: unknown }> = {
      duration_type: { value: dt.value, displayValue: dt.display },
      percentage_timer_input_datetime: { value: '', displayValue: '' },
      timer_percentage: { value: '', displayValue: '' },
      timer_duration: { value: '', displayValue: '' },
      timer_relative_duration_operator: { value: '', displayValue: '' },
      timer_relative_duration_datetime: { value: '', displayValue: '' },
      timer_schedule: { value: '', displayValue: '' },
    };
    if (step.duration_type === 'explicit' || step.duration_type === 'relative') {
      const d = V.durationToGlide(step.duration);
      vals.timer_duration = { value: d, displayValue: d };
    }
    if (step.duration_type === 'relative') {
      vals.timer_relative_duration_operator = { value: step.relative_operator ?? 'after', displayValue: step.relative_operator ?? 'after' };
      const v = await this.renderValueAsString(step.relative_datetime!, uuid, 'timer_relative_duration_datetime', step.key);
      vals.timer_relative_duration_datetime = { value: v, displayValue: v };
    }
    if (step.duration_type === 'percentage') {
      vals.timer_percentage = { value: String(step.percentage), displayValue: String(step.percentage) };
      const v = await this.renderValueAsString(step.percentage_datetime!, uuid, 'percentage_timer_input_datetime', step.key);
      vals.percentage_timer_input_datetime = { value: v, displayValue: v };
    }
    if (step.schedule !== undefined) {
      const s = typeof step.schedule === 'string' ? step.schedule : 'pill' in step.schedule ? this.renderPill(step.schedule.pill, uuid, 'timer_schedule', step.key) : step.schedule.reference;
      vals.timer_schedule = { value: s, displayValue: s };
    }
    const inputs = TIMER_INPUTS.map(ti => {
      const e: Entry = { id: ti.id, name: ti.name, value: vals[ti.name].value, displayValue: vals[ti.name].displayValue, children: [], scriptActive: false };
      if (ti.glideDuration) e.parameter = { type: 'glide_duration' };
      return e;
    });
    return this.orderedValues('wait', { inputs });
  }

  private async assignmentEntry(name: string, v: ValueInput, uuid: string, ownerKey: string, id: string, displayValueForInputs: 'same' | 'empty'): Promise<{ variables: Entry; inputs: Entry }> {
    if (V.valueKind(v) === 'script') {
      const script = (v as { script: string }).script;
      const e: Entry = { id, name, value: '', displayValue: '', children: [], scriptActive: true, script: { [name]: { scriptActive: true, script } } };
      return { variables: e, inputs: { ...e, script: { [name]: { scriptActive: true, script } } } };
    }
    const value = await this.renderValueAsString(v, uuid, name, ownerKey);
    return {
      variables: this.logicEntry(name, value, value, id),
      inputs: this.logicEntry(name, value, displayValueForInputs === 'same' ? value : '', id),
    };
  }

  private async setVariablesValues(step: Extract<Step, { kind: 'set_variables' }>): Promise<Record<string, unknown>> {
    const uuid = this.stepInfo.get(step.key)!.uuid;
    const variables: Entry[] = []; const inputs: Entry[] = [];
    for (const [name, v] of Object.entries(step.assign)) {
      const vi = this.variables.get(name);
      if (!vi) { this.error(`set_variables "${step.key}": unknown flow variable "${name}"`); continue; }
      if (vi.def.type.startsWith('array.') || V.valueKind(v) === 'template') { this.error(`set_variables "${step.key}": variable "${name}" is an array/object — use append_variables`); continue; }
      const e = await this.assignmentEntry(name, v, uuid, step.key, vi.sys_id, 'empty');
      variables.push(e.variables); inputs.push(e.inputs);
    }
    return this.orderedValues('set_variables', { variables, inputs });
  }

  private async appendVariablesValues(step: Extract<Step, { kind: 'append_variables' }>): Promise<Record<string, unknown>> {
    const uuid = this.stepInfo.get(step.key)!.uuid;
    const variables: Entry[] = []; const inputs: Entry[] = [];
    for (const [name, v] of Object.entries(step.assign)) {
      const vi = this.variables.get(name);
      if (!vi) { this.error(`append_variables "${step.key}": unknown flow variable "${name}"`); continue; }
      if (!vi.def.type.startsWith('array.')) { this.error(`append_variables "${step.key}": variable "${name}" is not an array (${vi.def.type})`); continue; }
      if (vi.def.type === 'array.object') {
        const literals = objectLiterals(v);
        const isArray = V.valueKind(v) === 'list';
        if (!literals.length || (!isArray && V.valueKind(v) !== 'template')) {
          this.error(`append_variables "${step.key}": "${name}" (array.object) needs a {template:{field: value}} object literal or {list:[{template:…}, …]}`);
          continue;
        }
        if (isArray && literals.length !== (v as { list: unknown[] }).list.length) {
          this.error(`append_variables "${step.key}": "${name}" (array.object) — every {list} item must be a {template:{field: value}} object literal`);
          continue;
        }
        const rendered: Record<string, unknown>[] = [];
        for (const lit of literals) {
          const obj: Record<string, unknown> = {};
          for (const [f, fv] of Object.entries(lit)) obj[f] = await this.renderObjectField(fv, uuid, name, step.key);
          rendered.push(obj);
        }
        const collection = isArray ? rendered : rendered[0];
        const value = JSON.stringify({ version: '1.0', complexObjectSchema: this.complexObjectSchema(vi), complexObject: { name$: `FD${vi.sys_id}`, $COCollectionField: collection }, serializationFormat: 'JSON' });
        const e = this.logicEntry(name, value, value, vi.sys_id);
        // an array literal adds one "item" descriptor per element (FORMAT-DECISIONS D15)
        if (isArray) e.children = rendered.map(() => ({ name: 'item', value: '', displayValue: '', children: Object.entries(vi.objectFields ?? {}).map(([f, t]) => objectFieldDescriptor(f, t)) }));
        // a single object carries a parameter mirror of the array variable; an array literal keeps {} (FORMAT-DECISIONS D15)
        else e.parameter = this.arrayVariableParameter(vi);
        variables.push(e); inputs.push(JSON.parse(JSON.stringify(e)) as Entry);
      } else {
        this.warn(`append_variables "${step.key}": appending to a scalar array ("${name}", ${vi.def.type}) was not observed on a UI-built flow or a live run — value stored as a plain string, verify on the PDI`);
        const e = await this.assignmentEntry(name, v, uuid, step.key, vi.sys_id, 'same');
        variables.push(e.variables); inputs.push(e.inputs);
      }
    }
    return this.orderedValues('append_variables', { variables, inputs });
  }

  /** A field of an object literal keeps JSON types for numbers/booleans; pills and texts become strings. */
  private async renderObjectField(v: ValueInput, uuid: string, inputName: string, ownerKey: string): Promise<unknown> {
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    return this.renderValueAsString(v, uuid, inputName, ownerKey);
  }

  private async assignOutputsValues(step: Extract<Step, { kind: 'assign_subflow_outputs' }>): Promise<Record<string, unknown>> {
    const uuid = this.stepInfo.get(step.key)!.uuid;
    const outputsToAssign: Entry[] = [];
    for (const [name, v] of Object.entries(step.assign)) {
      if (!this.outputs.has(name)) { this.error(`assign_subflow_outputs "${step.key}": unknown subflow output "${name}"`); continue; }
      const e = await this.assignmentEntry(name, v, uuid, step.key, '', 'same');
      outputsToAssign.push(e.variables);
    }
    return this.orderedValues('assign_subflow_outputs', { outputsToAssign });
  }

  // ── action rows ──
  private actionRowFields(sysId: string, actionType: string, actionParent: string, orderStr: string, parentUuid: string, comment: string): Fields {
    return {
      sys_id: sysId, sys_scope: this.scope, action_type: actionType, action_type_parent: actionParent, active: 'true', comment, display_text: '',
      flow: this.flowSysId, generation_source: '', order: orderStr, parent_ui_id: parentUuid, sys_class_name: 'sys_hub_action_instance_v2',
      ui_id: sysIdToUuid(sysId), updation_source: '', values: '',
    };
  }

  /**
   * The record table of a document_id / reference / records output. A document_id output holds a record of the
   * table the step works on (the step's static table input — lookUpRecord.Record → 'table', createTask.Record →
   * 'task_table'), else the base table its definition references (createTask.Record → task, Submit Catalog Item
   * Request requested_item → sc_req_item). A reference or records output uses the table its definition references
   * (getAttachmentsOnRecord.parameter → sys_attachment); a records output without one (lookUpRecords.Records) uses
   * the step's static table input.
   */
  private outputTable(o: { type: string; reference?: string }, inputs: Record<string, ValueInput>): string | undefined {
    if (o.type === 'document_id') return this.staticTableOf(inputs) ?? o.reference;
    if (o.type === 'records') return o.reference ?? this.staticTableOf(inputs);
    return o.reference;
  }

  private staticTableOf(inputs: Record<string, ValueInput>): string | undefined {
    for (const n of ['table_name', 'table', 'task_table', 'ah_table_name']) {
      const v = inputs[n];
      if (typeof v === 'string' && !v.includes('{{')) return v;
    }
    return undefined;
  }

  private async emitAction(step: Extract<Step, { kind: 'action' }>, parentUuid: string): Promise<void> {
    const def = findAction(step.action);
    const sysId = this.stepSysId(step.key);
    const { n, orderStr } = this.nextOrder();
    this.markStage(step, n);
    this.stepOrder.set(step.key, n);
    if (!def) {
      this.error(`step "${step.key}": unknown action "${step.action}" (use snow_flow_catalog_read, or kind "custom_action" with a definition sys_id)`);
      this.stepInfo.set(step.key, { uuid: sysIdToUuid(sysId), order: n, outputs: [] });
      return;
    }
    let ids = actionTypeIds(def);
    if (this.opts.resolveActionType) {
      const o = await this.opts.resolveActionType({ key: def.key, name: def.name, ...ids });
      if (o) {
        ids = { snapshot: o.snapshot ?? ids.snapshot, definition: o.definition ?? ids.definition };
        for (const w of o.warnings ?? []) this.warn(`step "${step.key}" (${def.key}): ${w}`);
      }
    }
    let table = this.staticTableOf(step.inputs);
    if (def.key === 'createCatalogTask') table = table ?? 'sc_task';
    const info: StepOutputsInfo = { uuid: sysIdToUuid(sysId), order: n, outputs: def.outputs.map(o => ({ name: o.name, type: o.type, label: o.label, reference: this.outputTable(o, step.inputs) })), table };
    if (def.key === 'getCatalogVariables') {
      // dynamic outputs: the variables of the template catalog item (live only; offline they stay untyped)
      const dyn = await this.catalogVariableOutputs(step, def.key);
      if (dyn) { info.outputs = dyn.outputs; info.strictOutputs = dyn.strict; }
    } else if (def.key === 'createCatalogTask' && step.inputs.catalog_variables !== undefined) {
      // same slushbucket: resolve the selection (names / set sys_ids) against template_catalog_item; outputs stay the task's
      await this.catalogVariableOutputs(step, def.key);
    }
    this.stepInfo.set(step.key, info);
    const row: RecordRow = { table: 'sys_hub_action_instance_v2', sys_id: sysId, fields: this.actionRowFields(sysId, ids.snapshot, ids.definition, orderStr, parentUuid, step.annotation ?? '') };
    this.instances.push(row);
    this.deferred.push({ row, build: async () => { row.fields.values = encodeValues(await this.actionValues(step, def)); } });
  }

  /**
   * Get Catalog Variables: its outputs are the variables of `template_catalog_item` (the catalogue lists none). With
   * resolveCatalogVariables (live plan / build / verify) they are read from item_option_new (+ the item's variable sets)
   * and typed from the question type; a `catalog_variables` {list} restricts them to the selected variables (or
   * variable sets). A pill naming anything else is then a spec error listing the valid names (typing.ts strictOutputs).
   * Offline, or when the item is not a static sys_id / cannot be read, undefined → today's untyped string + warning.
   */
  private async catalogVariableOutputs(step: Extract<Step, { kind: 'action' }>, actionKey: 'getCatalogVariables' | 'createCatalogTask'): Promise<{ outputs: StepOutputsInfo['outputs']; strict: string } | undefined> {
    const resolver = this.opts.resolveCatalogVariables;
    if (!resolver) return undefined;
    const what = `step "${step.key}" (${actionKey})`;
    const consequence = actionKey === 'getCatalogVariables' ? 'pills on them are typed "string"' : 'catalog_variables must be given as sys_ids';
    const itemValue = step.inputs.template_catalog_item;
    const item = typeof itemValue === 'string' ? itemValue
      : itemValue && typeof itemValue === 'object' && 'reference' in itemValue ? (itemValue as { reference: string }).reference : undefined;
    if (!item || !SYS_ID_RE.test(item)) {
      this.warn(`${what}: template_catalog_item is not a static sys_id — its variables cannot be read; ${consequence}`);
      return undefined;
    }
    let res: CatalogVariablesInfo | DefinitionError | undefined;
    try { res = await resolver(item); } catch (e) {
      this.warn(`${what}: the variables of catalog item ${item} could not be read (${(e as Error).message}) — ${consequence}`);
      return undefined;
    }
    if (!res) return undefined;
    if ('error' in res) { this.error(`${what}: ${res.error}`); return undefined; }
    for (const w of res.warnings ?? []) this.warn(`${what}: ${w}`);
    const itemName = `${res.kind === 'variable_set' ? 'variable set' : 'catalog item'} ${res.name ? `"${res.name}" ` : ''}(${item})`;
    let vars = res.variables;
    let strict = `a variable of ${itemName}`;
    const selection = step.inputs.catalog_variables;
    if (selection && typeof selection === 'object' && 'list' in selection) {
      const items = (selection as { list: unknown[] }).list;
      if (items.some(i => typeof i === 'object' && i !== null && 'pill' in i)) {
        this.warn(`${what}: catalog_variables holds a pill — the outputs are not restricted to the selection`);
      } else {
        const wanted = items.map(i => (typeof i === 'string' ? i : typeof i === 'object' && i !== null && 'reference' in i ? String((i as { reference: string }).reference) : ''))
          .map(s => s.replace(/:item_option_new(?:_set)?$/, '')).filter(Boolean);
        const matches = (v: CatalogVariable, w: string) => v.sys_id === w || v.name === w || v.variable_set === w;
        const unknown = wanted.filter(w => !vars.some(v => matches(v, w)));
        if (unknown.length) {
          this.error(`${what}: catalog_variables ${unknown.map(u => `"${u}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a variable (or variable set) of ${itemName} — its variables: ${vars.map(v => `${v.name} (${v.sys_id})`).join(', ') || 'none'}`);
        }
        this.catalogSelections.set(step.key, catalogSelectionTokens(wanted, vars));
        vars = vars.filter(v => wanted.some(w => matches(v, w)));
        strict = `selected in catalog_variables of ${itemName}`;
      }
    }
    return { outputs: vars.map(v => ({ name: v.name, type: v.type, ...(v.label ? { label: v.label } : {}), ...(v.reference ? { reference: v.reference } : {}) })), strict };
  }

  private async actionValues(step: Extract<Step, { kind: 'action' }>, def: ActionDef): Promise<Entry[]> {
    const uuid = sysIdToUuid(this.stepSysId(step.key));
    const supplied = step.inputs;
    for (const name of Object.keys(supplied)) {
      const input = findActionInput(def, name);
      if (!input) this.error(`step "${step.key}" (${def.key}): unknown input "${name}" (inputs: ${def.inputs.map(i => i.name).join(', ')})`);
      else if (isHiddenInput(input)) this.error(`step "${step.key}" (${def.key}): input "${name}" is hidden in Flow Designer and cannot be set`);
    }
    const entries: Entry[] = [];
    const defaults = GENERATOR_INPUT_DEFAULTS[def.key] ?? {};
    for (const input of def.inputs) {
      const stored = storedInputName(input.name);
      const given = specInputNames(input).filter(n => supplied[n] !== undefined);
      if (given.length > 1) this.error(`step "${step.key}" (${def.key}): input "${input.name}" is set more than once (${given.join(', ')})`);
      let v = specInputNames(input).map(n => supplied[n]).find(x => x !== undefined) ?? defaults[input.name];
      if (v !== undefined) {
        entries.push(await this.actionInputEntry(input, stored, v, uuid, step.key));
        continue;
      }
      if (isAlwaysStored(input)) {
        // a default value is stored as defined; a hidden input without one carries the value UI-built rows store (or '')
        const hidden = isHiddenInput(input);
        const value = (input.default !== undefined && input.default !== '' ? input.default : hidden ? def.hidden_values?.[input.name] ?? '' : '') as string | number | boolean;
        const parameter: Record<string, unknown> = { type: input.type };
        if (hidden) {
          if (input.attributes && Object.keys(input.attributes).length) parameter.attributes = { ...input.attributes };
          if (input.reference) parameter.reference = input.reference;
        }
        entries.push({ name: stored, value, displayValue: value, scriptActive: false, parameter });
        continue;
      }
      if (input.mandatory && !isHiddenInput(input)) this.error(`step "${step.key}" (${def.key}): mandatory input "${input.name}" is missing`);
    }
    return entries;
  }

  private async actionInputEntry(input: CatalogInputRaw, stored: string, v: ValueInput, uuid: string, ownerKey: string): Promise<Entry> {
    const kind = V.valueKind(v);
    if (kind === 'script') {
      const script = (v as { script: string }).script;
      return { id: '', name: stored, value: '', displayValue: '', children: [], scriptActive: true, script: { [stored]: { scriptActive: true, script } } };
    }
    const renderPill = (s: string) => this.renderPill(s, uuid, stored, ownerKey);
    const renderText = (s: string) => this.renderText(s, uuid, stored, ownerKey);
    let value: unknown; let displayValue: unknown; let scripts: Record<string, string> | undefined;
    switch (kind) {
      case 'scalar': {
        const c = V.coerceScalar(v as string | number | boolean, input.type);
        value = typeof c === 'string' ? renderText(c) : c;
        displayValue = value;
        break;
      }
      case 'pill': value = displayValue = renderPill((v as { pill: string }).pill); break;
      case 'text': value = displayValue = renderText((v as { text: string }).text); break;
      case 'conditions': value = displayValue = renderText((v as { conditions: string }).conditions); break;
      case 'reference': {
        const r = v as { reference: string; display?: string };
        value = r.reference; displayValue = r.display ?? r.reference;
        break;
      }
      case 'template': {
        if (input.type !== 'template_value') this.warn(`input "${stored}" is ${input.type}, not template_value — the {template} value is stored as a template string anyway`);
        const enc = V.encodeTemplate((v as { template: Record<string, ValueInput> }).template, renderPill, renderText);
        value = displayValue = enc.value;
        if (Object.keys(enc.scripts).length) scripts = enc.scripts;
        break;
      }
      case 'approval_rules': {
        const rules = (v as { approval_rules: ApprovalRules }).approval_rules;
        await this.checkApprovers(rules, ownerKey);
        value = displayValue = V.encodeApprovalRules(rules, renderPill);
        break;
      }
      case 'duration': value = displayValue = V.durationToGlide((v as { duration: never }).duration); break;
      case 'list': {
        const list = (v as { list: V.ListItem[] }).list;
        if (V.templateItemIndex(list) >= 0) { this.error(listTemplateError(ownerKey, stored)); value = displayValue = ''; break; }
        value = displayValue = V.encodeList(input.type === 'slushbucket' ? this.slushbucketItems(list, ownerKey, stored) : list, input.type, renderPill);
        break;
      }
    }
    const entry: Entry = { name: stored, value, displayValue, scriptActive: false, parameter: { type: input.type } };
    if (scripts) {
      const script: Record<string, unknown> = {};
      for (const [f, s] of Object.entries(scripts)) script[f] = { scriptActive: true, script: s };
      entry.script = script;
    }
    return entry;
  }

  /**
   * A slushbucket {list} (Get Catalog Variables `catalog_variables`) in the platform form. With the selection checked
   * against the item (live), every matched entry — sys_id, name or variable-set sys_id — becomes its canonical token
   * ('<sys_id>:item_option_new' / '<set sys_id>:item_option_new_set'). Unchecked (offline, a pill item, a failed read),
   * only sys_ids and tokens can be encoded: any other string would be stored as-is and select nothing at runtime, so it
   * is a spec error.
   */
  private slushbucketItems(list: V.ListItem[], ownerKey: string, stored: string): V.ListItem[] {
    const tokens = this.catalogSelections.get(ownerKey);
    return list.map((item, i) => {
      if (typeof item === 'object' && item !== null && 'pill' in item) return item;
      const raw = typeof item === 'string' ? item : 'reference' in item ? item.reference : '';
      const token = tokens?.get(raw.replace(/:item_option_new(?:_set)?$/, ''));
      if (token) return token;
      if (SYS_ID_RE.test(raw) || SLUSHBUCKET_TOKEN_RE.test(raw)) return item;
      // checked selections already reported this entry as not a variable (or set) of the item
      if (!tokens) {
        this.error(`step "${ownerKey}": "${stored}" {list}[${i}] "${raw}" is not a sys_id — the slushbucket stores "<sys_id>:item_option_new" / "<set sys_id>:item_option_new_set" and a bare name would select nothing at runtime; give the variable sys_id ("<sys_id>" or "<sys_id>:item_option_new") or a variable set as "<set sys_id>:item_option_new_set" (Get Catalog Variables / Create Catalog Task resolve variable names against a static template_catalog_item only on a live plan / build)`);
      }
      return item;
    });
  }

  /** The zero-approver trap: a string-typed pill in a user/group slot yields no approvers at runtime. */
  private async checkApprovers(rules: ApprovalRules, ownerKey: string): Promise<void> {
    for (const set of rules.rule_sets) for (const group of set.rules) for (const cond of group) {
      for (const a of [...(cond.users ?? []), ...(cond.groups ?? [])]) {
        if (typeof a !== 'object' || !('pill' in a)) continue;
        const info = await this.typeOf(a.pill);
        if (info.unresolved) {
          // Fail closed: an untyped pill in an approver slot is exactly the zero-approver trap.
          if ((this.opts.approverPillPolicy ?? 'error') === 'error') {
            this.error(`step "${ownerKey}": approver pill "${a.pill}" could not be typed (no dictionary read or the walk failed) — a string pill in a user/group slot yields zero approvers at runtime; declare it in flow.pill_types (e.g. {"${a.pill}": "reference"}) or build with a live instance`);
          } else if (!this.unverifiedApprovers.some(u => u.step === ownerKey && u.pill === a.pill)) {
            this.unverifiedApprovers.push({ step: ownerKey, pill: a.pill });
            this.warn(`step "${ownerKey}": approver pill "${a.pill}" is UNVERIFIED (untyped) — a build or export refuses it until it is typed via flow.pill_types or a live dictionary read`);
          }
          continue;
        }
        if (!['reference', 'document_id', 'glide_list', 'records', 'array.reference'].includes(info.type)) {
          this.error(`step "${ownerKey}": approver pill "${a.pill}" is ${info.type}-typed — an approver slot needs a reference pill (user/group record) or a {reference}/sys_id; a string pill yields zero approvers at runtime`);
        }
      }
    }
  }

  // ── custom actions ──
  private async emitCustomAction(step: Extract<Step, { kind: 'custom_action' }>, parentUuid: string): Promise<void> {
    const sysId = this.stepSysId(step.key);
    const { n, orderStr } = this.nextOrder();
    this.markStage(step, n);
    this.stepOrder.set(step.key, n);
    const def = await this.resolveDefinition(step.definition, 'custom action', step.key, this.opts.resolveCustomAction);
    this.stepInfo.set(step.key, { uuid: sysIdToUuid(sysId), order: n, outputs: def?.outputs ?? [], table: this.staticTableOf(step.inputs), inferred: !def || def.inferred });
    if (!def) return;
    const row: RecordRow = { table: 'sys_hub_action_instance_v2', sys_id: sysId, fields: this.actionRowFields(sysId, def.sys_id, def.sys_id, orderStr, parentUuid, step.annotation ?? '') };
    this.instances.push(row);
    this.deferred.push({ row, build: async () => {
      const uuid = sysIdToUuid(sysId);
      const entries: Entry[] = [];
      for (const [name, type] of await this.typedInputList(def, step.inputs, step.key)) {
        const v = step.inputs[name];
        entries.push(await this.actionInputEntry({ name, label: name, type }, name, v, uuid, step.key));
      }
      row.fields.values = encodeValues(entries);
    } });
  }

  private async resolveDefinition(ref: DefinitionRef, what: string, ownerKey: string, resolver?: (ref: DefinitionRef) => Promise<DefinitionInfo | DefinitionError | undefined>): Promise<(DefinitionInfo & { inferred?: boolean }) | undefined> {
    if (resolver) {
      const d = await resolver(ref);
      if (d && 'error' in d) { this.error(`step "${ownerKey}": ${d.error}`); return undefined; }
      if (d) {
        for (const w of d.warnings ?? []) this.warn(`step "${ownerKey}": ${w}`);
        if (d.scope && d.scope !== this.scope) {
          this.warn(`step "${ownerKey}": ${what} ${d.name ? `"${d.name}" ` : ''}(${d.sys_id}) is in application scope ${d.scope}, the flow is in scope ${this.scope} — calling it across scopes can need cross-scope access, which the build does not check${'name' in ref && !ref.scope ? '; add scope to the reference to pin it' : ''}`);
        }
        return d;
      }
      this.warn(`step "${ownerKey}": ${what} ${JSON.stringify(ref)} could not be resolved on the instance`);
    }
    if ('sys_id' in ref) {
      this.warn(`step "${ownerKey}": ${what} ${ref.sys_id} not resolved — input types are inferred from the spec values (verify with an instance)`);
      return { sys_id: ref.sys_id, inputs: [], outputs: [], inferred: true };
    }
    this.error(`step "${ownerKey}": ${what} by name (${JSON.stringify(ref)}) needs an instance to resolve the sys_id — give {sys_id} or run with an instance`);
    return undefined;
  }

  /** [name, type] for every supplied input: definition order + types when known, else spec order + inferred types. */
  private async typedInputList(def: DefinitionInfo & { inferred?: boolean }, supplied: Record<string, ValueInput>, ownerKey: string): Promise<[string, string][]> {
    const out: [string, string][] = [];
    if (!def.inferred) {
      // a resolved definition is authoritative: its declared inputs, in definition order, with their types
      const known = new Set(def.inputs.map(i => i.name));
      const visible = def.inputs.filter(i => !i.hidden).map(i => i.name);
      for (const n of Object.keys(supplied)) if (!known.has(n)) this.error(`step "${ownerKey}": unknown input "${n}" (definition inputs: ${visible.join(', ') || 'none'})`);
      for (const i of def.inputs) {
        if (i.hidden) {
          // like a hidden catalogue input (actionValues): Flow Designer cannot set it, so neither can a spec — and it is never "missing"
          if (supplied[i.name] !== undefined) this.error(`step "${ownerKey}": input "${i.name}" of ${def.name ? `"${def.name}"` : def.sys_id} is hidden in Flow Designer and cannot be set`);
          continue;
        }
        if (supplied[i.name] !== undefined) out.push([i.name, i.type]);
        else if (i.mandatory && !i.default) this.error(`step "${ownerKey}": mandatory input "${i.name}" of ${def.name ? `"${def.name}"` : def.sys_id} is missing`);
      }
    } else {
      for (const [n, v] of Object.entries(supplied)) out.push([n, await this.inferValueType(v, `step "${ownerKey}" input "${n}"`)]);
    }
    return out;
  }

  /** Type of a value from its form (used for inferred definitions and object fields). */
  private async inferValueType(v: ValueInput, what: string): Promise<string> {
    switch (V.valueKind(v)) {
      case 'scalar': return typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'decimal') : typeof v === 'boolean' ? 'boolean' : 'string';
      case 'pill': { const info = await this.typeOf((v as { pill: string }).pill); if (info.unresolved) this.warn(`${what}: type inferred as string (pill unresolved)`); return labelTypeFor(info.type); }
      case 'reference': return 'reference';
      case 'duration': return 'glide_duration';
      case 'approval_rules': return 'approval_rules';
      case 'template': return 'template_value';
      case 'list': return 'glide_list';
      case 'conditions': return 'conditions';
      default: return 'string';
    }
  }

  // ── subflow calls ──
  private async emitSubflow(step: Extract<Step, { kind: 'subflow' }>, parentUuid: string): Promise<void> {
    const sysId = this.stepSysId(step.key);
    const { n, orderStr } = this.nextOrder();
    this.markStage(step, n);
    this.stepOrder.set(step.key, n);
    const def = await this.resolveDefinition(step.subflow, 'subflow', step.key, this.opts.resolveSubflow);
    this.stepInfo.set(step.key, { uuid: sysIdToUuid(sysId), order: n, outputs: def?.outputs ?? [], inferred: !def || def.inferred });
    if (!def) return;
    const fields: Fields = {
      sys_id: sysId, sys_scope: this.scope, attributes: '', comment: step.annotation ?? '', display_text: '', flow: this.flowSysId, generation_source: '',
      order: orderStr, parent_ui_id: parentUuid, show_stages: step.show_stages ? 'true' : 'false', subflow: def.sys_id, subflow_inputs: '',
      sys_class_name: 'sys_hub_sub_flow_instance_v2', ui_id: sysIdToUuid(sysId), wait_for_completion: step.wait_for_completion ? 'true' : 'false',
    };
    const row: RecordRow = { table: 'sys_hub_sub_flow_instance_v2', sys_id: sysId, fields };
    this.instances.push(row);
    this.deferred.push({ row, build: async () => {
      const uuid = sysIdToUuid(sysId);
      const entries: Entry[] = [];
      for (const [name, type] of await this.typedInputList(def, step.inputs, step.key)) {
        const v = step.inputs[name];
        if (V.valueKind(v) === 'script') {
          const script = (v as { script: string }).script;
          entries.push({ id: '', name, value: '', displayValue: '', children: [], scriptActive: true, script: { [name]: { scriptActive: true, script } } });
          continue;
        }
        const e = await this.actionInputEntry({ name, label: name, type }, name, v, uuid, step.key);
        entries.push({ name, value: e.value, displayValue: e.displayValue, parameter: { type } });
      }
      row.fields.subflow_inputs = encodeValues(entries);
    } });
  }

  // ── pills ──
  private recordUsage(platformText: string, uuid: string, inputName: string): void {
    for (const p of platformPillsInText(platformText)) this.usages.push({ platform: p, symbolic: '', instanceUuid: uuid, inputName });
  }

  private checkForward(symbolic: string, ownerKey: string | undefined, allowForward: boolean): void {
    if (!ownerKey) return;
    const seg = symbolic.split('.');
    const target = seg[0] === 'steps' || seg[0] === 'loop' ? seg[1] : undefined;
    if (!target) return;
    const to = this.stepOrder.get(target); const from = this.stepOrder.get(ownerKey);
    if (to === undefined || from === undefined || to <= from) return;
    // allowed when the target is nested inside the referencing block (Do-Until condition)
    if (allowForward) {
      for (let k: string | undefined = target; k; k = this.stepParent.get(k)) if (k === ownerKey) return;
    }
    this.error(`step "${ownerKey}": pill "${symbolic}" refers to step "${target}" which runs later (order ${to} > ${from})`);
  }

  /** Resolve (and cache) the type info of a symbolic pill; records the pill table entry. */
  private async typeOf(symbolic: string): Promise<PillTypeInfo & { unresolved?: boolean }> {
    const entry = this.pillTable.get(symbolic);
    if (entry?.info) return entry.info;
    const before = this.warnings.length;
    const info = await resolvePillInfo(this.typing, symbolic);
    const unresolved = this.warnings.length > before && this.warnings.slice(before).some(w => w.includes(`pill ${symbolic}`));
    const platform = toPlatformPill(symbolic, this.pillCtx).slice(2, -2);
    this.pillTable.set(symbolic, { platform, info: { ...info, unresolved } as PillTypeInfo });
    this.platformInfo.set(platform, info);
    return { ...info, unresolved };
  }

  private renderPill(symbolic: string, uuid: string, inputName: string, ownerKey?: string, allowForward = false): string {
    this.checkForward(symbolic, ownerKey, allowForward);
    const platform = toPlatformPill(symbolic, this.pillCtx);
    if (!this.pillTable.has(symbolic)) this.pillTable.set(symbolic, { platform: platform.slice(2, -2) });
    this.deferTyping(symbolic);
    this.recordUsage(platform, uuid, inputName);
    return platform;
  }

  private async renderPillTyped(symbolic: string, uuid: string, inputName: string, ownerKey?: string): Promise<string> {
    const platform = this.renderPill(symbolic, uuid, inputName, ownerKey);
    await this.typeOf(symbolic);
    return platform;
  }

  private renderText(text: string, uuid: string, inputName: string, ownerKey?: string, allowForward = false): string {
    const out = rewritePills(text, { ...this.pillCtx, stepUuid: k => this.pillCtx.stepUuid(k), loopUuid: k => this.pillCtx.loopUuid(k) });
    for (const m of text.matchAll(PLATFORM_PILL_RE)) {
      const sym = m[1].trim();
      this.checkForward(sym, ownerKey, allowForward);
      if (!this.pillTable.has(sym)) this.pillTable.set(sym, { platform: toPlatformPill(sym, this.pillCtx).slice(2, -2) });
      this.deferTyping(sym);
    }
    this.recordUsage(out, uuid, inputName);
    return out;
  }

  private readonly typingQueue: string[] = [];
  private deferTyping(symbolic: string): void { this.typingQueue.push(symbolic); }

  private renderScalarOrPill(v: ValueInput, uuid: string, inputName: string): unknown {
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return this.renderText(v, uuid, inputName);
    if (V.valueKind(v) === 'pill') return this.renderPill((v as { pill: string }).pill, uuid, inputName);
    if (V.valueKind(v) === 'text') return this.renderText((v as { text: string }).text, uuid, inputName);
    if (V.valueKind(v) === 'reference') return (v as { reference: string }).reference;
    this.error(`trigger input "${inputName}": unsupported value form`);
    return '';
  }

  /** Render any value form to its stored string (assignments, wait inputs). */
  private async renderValueAsString(v: ValueInput, uuid: string, inputName: string, ownerKey: string): Promise<string> {
    switch (V.valueKind(v)) {
      case 'scalar': return this.renderText(V.stringifyScalar(v as string | number | boolean), uuid, inputName, ownerKey);
      case 'pill': return this.renderPillTyped((v as { pill: string }).pill, uuid, inputName, ownerKey);
      case 'text': return this.renderText((v as { text: string }).text, uuid, inputName, ownerKey);
      case 'conditions': return this.renderText((v as { conditions: string }).conditions, uuid, inputName, ownerKey);
      case 'reference': return (v as { reference: string }).reference;
      case 'duration': return V.durationToGlide((v as { duration: never }).duration);
      case 'list': {
        const list = (v as { list: V.ListItem[] }).list;
        if (V.templateItemIndex(list) >= 0) { this.error(listTemplateError(ownerKey, inputName)); return ''; }
        return V.encodeList(list, 'glide_list', s => this.renderPill(s, uuid, inputName, ownerKey));
      }
      case 'template': return V.encodeTemplate((v as { template: Record<string, ValueInput> }).template, s => this.renderPill(s, uuid, inputName, ownerKey), s => this.renderText(s, uuid, inputName, ownerKey)).value;
      case 'approval_rules': return V.encodeApprovalRules((v as { approval_rules: ApprovalRules }).approval_rules, s => this.renderPill(s, uuid, inputName, ownerKey));
      case 'script': this.error(`"${inputName}" in step "${ownerKey}": a {script} value is not valid here`); return '';
    }
  }

  /** Type every pill seen so far (called by run() after each deferred builder through flushTyping). */
  async flushTyping(): Promise<void> {
    while (this.typingQueue.length) {
      const s = this.typingQueue.shift()!;
      await this.typeOf(s);
    }
  }
}

/**
 * Row fields in the canonical order the platform's XML uses: sys_id, sys_scope, then every other
 * field alphabetically. The Table API ignores order; this keeps plans and XML stable.
 */
export function canonicalRow(row: RecordRow): RecordRow {
  const fields: Fields = {};
  if ('sys_id' in row.fields) fields.sys_id = row.fields.sys_id;
  if ('sys_scope' in row.fields) fields.sys_scope = row.fields.sys_scope;
  for (const k of Object.keys(row.fields).filter(k => k !== 'sys_id' && k !== 'sys_scope').sort(compareFieldNames)) fields[k] = row.fields[k];
  row.fields = fields;
  return row;
}

/** Field names are sorted with String.prototype.localeCompare (stable plans and XML). */
export function compareFieldNames(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Store a value on a UI-built descriptor entry the way Workflow Studio does (PDI captures):
 * glide_time → value '1970-01-01 HH:MM:SS' + display 'HH:MM:SS'; boolean → '1' / '0' with an
 * empty display; integer → string; choice → display = the choice label; conditions / table_name →
 * empty display (as captured). Entries without a displayValue key (Repeat) only get the value.
 */
export function setUiDescriptorValue(e: TriggerDescriptorEntry, raw: unknown): void {
  const hasDisplay = 'displayValue' in e;
  let value: unknown = raw;
  let display = '';
  switch (e.internalType) {
    case 'glide_time': value = String(raw); display = String(raw).slice(11); break;
    case 'boolean': value = raw === true || raw === 'true' || raw === '1' ? '1' : '0'; break;
    case 'integer': value = String(raw); break;
    case 'choice': {
      value = String(raw);
      const choice = (e.choiceList ?? []).find(c => c.fValue === value);
      display = choice?.fLabel ?? String(raw);
      break;
    }
    case 'conditions': case 'table_name': value = String(raw); break;
    default: value = raw; display = String(raw);
  }
  e.value = value;
  if (hasDisplay) e.displayValue = display;
}

/** Optional condition label (condition_name) on an if / else_if / do_until. */
function labelOf(o: object): string | undefined {
  const l = (o as { label?: unknown }).label;
  return typeof l === 'string' && l !== '' ? l : undefined;
}

/** A slushbucket entry already in the platform form: '<sys_id>:item_option_new' / '<sys_id>:item_option_new_set'. */
const SLUSHBUCKET_TOKEN_RE = /^[0-9a-f]{32}:item_option_new(?:_set)?$/;

/**
 * The platform slushbucket token of each `catalog_variables` entry that matches a variable of the item (PDI-FACTS §8):
 * a variable (by sys_id or by name) → '<variable sys_id>:item_option_new'; a variable set (by its sys_id, incl. a
 * multi-row set, which is itself one output) → '<set sys_id>:item_option_new_set'. Unmatched entries are left out.
 */
function catalogSelectionTokens(wanted: readonly string[], variables: readonly CatalogVariable[]): Map<string, string> {
  const isSetRow = (v: CatalogVariable) => !!v.variable_set && v.variable_set === v.sys_id;
  const tokens = new Map<string, string>();
  for (const w of wanted) {
    const bySysId = variables.find(v => v.sys_id === w);
    if (bySysId) { tokens.set(w, `${w}:${isSetRow(bySysId) ? 'item_option_new_set' : 'item_option_new'}`); continue; }
    if (variables.some(v => v.variable_set === w)) { tokens.set(w, `${w}:item_option_new_set`); continue; }
    const byName = variables.find(v => v.name === w);
    if (byName) tokens.set(w, `${byName.sys_id}:${isSetRow(byName) ? 'item_option_new_set' : 'item_option_new'}`);
  }
  return tokens;
}

/** The spec error for a {template} item in a list that is not an array.object append. */
function listTemplateError(ownerKey: string | undefined, inputName: string): string {
  return `step "${ownerKey ?? '?'}": "${inputName}": a {template} item inside {list} is only valid in an append_variables value for an array.object variable`;
}

/** The object literals of an append value: {template} → [fields]; {list:[{template}…]} → [fields…]. */
function objectLiterals(v: ValueInput): Record<string, ValueInput>[] {
  const kind = V.valueKind(v);
  if (kind === 'template') return [(v as { template: Record<string, ValueInput> }).template];
  if (kind === 'list') {
    const items = (v as { list: unknown[] }).list;
    return items.filter((i): i is { template: Record<string, ValueInput> } => typeof i === 'object' && i !== null && 'template' in i).map(i => i.template);
  }
  return [];
}

/** Per-field descriptor of an appended array element (FORMAT-DECISIONS D15). */
function objectFieldDescriptor(name: string, type: string): Entry {
  return {
    id: '', name, value: '', displayValue: '', children: [],
    parameter: {
      children: [], uiDisplayType: type, type_label: uiTypeLabel(type), id: '', label: name, name, type, order: 0, extended: false,
      mandatory: false, readOnly: false, hint: '', maxsize: 0, reference: '', reference_display: '', choiceOption: '', table: '',
      columnName: '', defaultValue: '', defaultDisplayValue: '', use_dependent: false, fShowReferenceFinder: false, local: false,
      attributes: {}, ref_qual: '', dependent_on: '',
    },
    scriptActive: false, script: {},
  };
}

/** Child step lists of a step (for pre-scans). */
function childSteps(s: Step): Step[][] {
  switch (s.kind) {
    case 'if': return [s.then, ...(s.else_if ?? []).map(b => b.steps), ...(s.else ? [s.else.steps] : [])];
    case 'for_each': case 'do_until': return [s.steps];
    case 'try_catch': return [s.try, s.catch.steps];
    case 'do_in_parallel': return s.branches.map(b => b.steps);
    default: return [];
  }
}

/** FlowDesigner complex-object type names for object fields. */
function coTypeName(internalType: string): string {
  switch (internalType) {
    case 'integer': return 'Integer';
    case 'boolean': return 'Boolean';
    case 'decimal': return 'Decimal';
    case 'float': return 'Float';
    case 'glide_date_time': return 'DateTime';
    case 'reference': return 'Reference';
    case 'json': return 'Json';
    default: return 'String';
  }
}

function uiTypeLabel(internalType: string): string {
  switch (internalType) {
    case 'boolean': return 'True/False';
    case 'object': return 'Object';
    case 'glide_date_time': return 'Date/Time';
    default: return internalType.charAt(0).toUpperCase() + internalType.slice(1);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate the record plan for a parsed spec. Pure apart from the resolvers in `opts` (reads).
 * Throws ServiceNowError FLOW_BUILDER_INVALID_SPEC with `details.errors` on semantic errors.
 */
export async function generatePlan(spec: FlowSpec, opts?: GenerateOptions & GeneratorExtras): Promise<RecordPlan> {
  return new Generator(spec, opts ?? {}).run();
}

/**
 * Offline catalogue read for `snow_flow_catalog_read`: every trigger / action / logic
 * definition with input types and outputs, or the entries whose `name` matches.
 */
export function readCatalog(name?: string): CatalogEntry[] {
  const entries = buildCatalogEntries();
  return name ? filterCatalogEntries(entries, name) : entries;
}

export { LOGIC_KEY_BY_KIND };
