/**
 * Flow Builder — shared TypeScript types.
 *
 * FlowSpec v1 types are inferred from the zod schemas in `schema.ts`; the plan /
 * writer / verify contracts below are the fixed interfaces every module implements
 * (see src/flow-builder/README.md for ownership).
 */
import type { z } from 'zod';
import type {
  FlowSpecSchema,
  TriggerSchema,
  StepSchema,
  ValueSchema,
  PillValueSchema,
  ReferenceValueSchema,
  TextValueSchema,
  TemplateValueSchema,
  ConditionsValueSchema,
  ApprovalRulesValueSchema,
  ApprovalRulesSchema,
  DurationValueSchema,
  DurationSpecSchema,
  ListValueSchema,
  ScriptValueSchema,
  VariableDefSchema,
  StageDefSchema,
  FlowMetaSchema,
  ErrorHandlerSchema,
} from './schema.js';

// ─── Spec (inferred from zod) ─────────────────────────────────────────────────

/** Author-side (input) shapes — what a spec JSON may contain before defaults are applied. */
export type { StepInput, StepOutput, ValueInput, DefinitionRef, WaitDurationType } from './schema.js';

export type FlowSpec = z.infer<typeof FlowSpecSchema>;
export type FlowMeta = z.infer<typeof FlowMetaSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type TriggerType = Trigger['type'];
export type Step = z.infer<typeof StepSchema>;
export type StepKind = Step['kind'];
export type Value = z.infer<typeof ValueSchema>;
export type PillValue = z.infer<typeof PillValueSchema>;
export type ReferenceValue = z.infer<typeof ReferenceValueSchema>;
export type TextValue = z.infer<typeof TextValueSchema>;
export type TemplateValue = z.infer<typeof TemplateValueSchema>;
export type ConditionsValue = z.infer<typeof ConditionsValueSchema>;
export type ApprovalRulesValue = z.infer<typeof ApprovalRulesValueSchema>;
export type ApprovalRules = z.infer<typeof ApprovalRulesSchema>;
export type DurationValue = z.infer<typeof DurationValueSchema>;
export type DurationSpec = z.infer<typeof DurationSpecSchema>;
export type ListValue = z.infer<typeof ListValueSchema>;
export type ScriptValue = z.infer<typeof ScriptValueSchema>;
export type VariableDef = z.infer<typeof VariableDefSchema>;
export type StageDef = z.infer<typeof StageDefSchema>;
export type ErrorHandler = z.infer<typeof ErrorHandlerSchema>;

/** Narrowed step types, by `kind`. */
export type StepOfKind<K extends StepKind> = Extract<Step, { kind: K }>;
export type ActionStep = StepOfKind<'action'>;
export type CustomActionStep = StepOfKind<'custom_action'>;
export type SubflowStep = StepOfKind<'subflow'>;
export type IfStep = StepOfKind<'if'>;
export type ForEachStep = StepOfKind<'for_each'>;
export type DoUntilStep = StepOfKind<'do_until'>;
export type TryCatchStep = StepOfKind<'try_catch'>;
export type DoInParallelStep = StepOfKind<'do_in_parallel'>;
export type WaitStep = StepOfKind<'wait'>;
export type SetVariablesStep = StepOfKind<'set_variables'>;
export type AppendVariablesStep = StepOfKind<'append_variables'>;
export type AssignSubflowOutputsStep = StepOfKind<'assign_subflow_outputs'>;

/** parseSpec() result — exactly the brief's interface. */
export interface SpecError { path: string; message: string }
export type ParseSpecResult = { spec: FlowSpec } | { errors: SpecError[] };

// ─── Symbolic pills ───────────────────────────────────────────────────────────

/**
 * A parsed symbolic pill (spec side). `path` is the dotted field walk after the
 * root/segment, e.g. `trigger.current.caller_id.email` → root=trigger, name=current,
 * path=['caller_id','email'].
 */
export type ParsedPill =
  | { root: 'trigger'; name: string; path: string[] }
  | { root: 'steps'; key: string; output: string; path: string[] }
  | { root: 'loop'; key: string; path: string[] }
  | { root: 'vars'; name: string; path: string[] }
  | { root: 'inputs'; name: string; path: string[] }
  | { root: 'error'; name: string; path: string[] }
  | { root: 'static'; sys_id: string };

/** One row of the plan's pill table: symbolic → platform string. */
export interface PillEntry { symbolic: string; platform: string; type: string }

/**
 * A `label_cache` entry as stored on `sys_hub_flow.label_cache` (JSON array).
 * The generator's entry shape (UI entries carry more keys — PDI-FACTS §6): records pills carry `column_name`,
 * flow-variable / subflow-input pills carry `reference_table` / `reference_display`.
 */
export interface LabelCacheEntry {
  name: string;
  label: string;
  type: string;
  base_type: string;
  usedInstances: Record<string, string[]>;
  attributes: Record<string, unknown>;
  column_name?: string;
  reference_table?: string | null;
  reference_display?: string | null;
}

// ─── Plan (fixed interface from the brief) ────────────────────────────────────

export interface RecordRow { table: string; sys_id: string; fields: Record<string, string | number | boolean>; }

export interface RecordPlan {
  flowKey: string;
  flow: RecordRow;
  trigger?: RecordRow;
  variables: RecordRow[];
  documentation: RecordRow[];
  stages: RecordRow[];
  instances: RecordRow[]; // ordered: write order == array order
  labelCache: unknown;
  pills: PillEntry[];
  warnings: string[];
  /**
   * Approver pills (user/group slots of approval rules) whose type could not be verified — no dictionary
   * read and no flow.pill_types entry. Only populated with approverPillPolicy 'report' (snow_flow_plan);
   * with the default 'error' policy (build / export) they are semantic errors instead.
   */
  unverifiedApprovers?: { step: string; pill: string }[];
  /**
   * glide_date_time trigger inputs (the catalogue has one: scheduled.run_once `run_in`): what the spec gave, the
   * instance-local wall time stored, and — with an instance — the zone used and whether it lies in the future.
   * `in_future:false` means activation would fire the flow immediately (snow_flow_build refuses it unless allow_past_run).
   */
  dateTimeInputs?: DateTimeInputCheck[];
}

/** One glide_date_time trigger input as generated (FORMAT-DECISIONS D17). */
export interface DateTimeInputCheck {
  input: string;
  /** The spec value as written ('YYYY-MM-DD HH:MM:SS' or an ISO-8601 instant). */
  given: string;
  form: 'local' | 'iso';
  /** The value stored in trigger_inputs (value == displayValue): the instance-local wall time. */
  local: string;
  /** The instance time zone used (sys_user.time_zone of the authenticated user, else glide.sys.default.tz; precedence unverified — D17). */
  zone?: string;
  zone_source?: 'sys_user.time_zone' | 'glide.sys.default.tz';
  /** The instance's current wall time in `zone` (computed from this machine's clock). */
  instance_now?: string;
  /** Strictly later than instance_now; absent when the zone is unknown (offline, or unresolved). */
  in_future?: boolean;
}

export interface GenerateOptions {
  /** Live dictionary lookup for record-field pill typing (table, dotted path) → internal type. */
  resolvePillType?: (table: string, path: string) => Promise<string | undefined>;
}

// ─── Catalogue read (offline) ─────────────────────────────────────────────────

export interface CatalogInputDef {
  name: string;
  type: string;
  label?: string;
  mandatory?: boolean;
  default?: string | number | boolean;
  reference?: string;
  hidden?: boolean;
  choices?: string[];
}

export interface CatalogEntry {
  kind: 'trigger' | 'action' | 'logic';
  name: string;
  sys_id: string;
  label?: string;
  /** For triggers: the `trigger_type` value; for logic: the FlowSpec construct it stands for (`if.else`, `try_catch`, …). */
  type?: string;
  inputs: CatalogInputDef[];
  outputs: { name: string; type: string; label?: string }[];
}

// ─── Writer / verify (fixed signatures from the brief; result shapes are the scaffold's contract) ──

export interface WriteOptions {
  updateSet: { sys_id?: string; name?: string };
  mode: 'create' | 'update';
  activate: boolean;
  deleteStale: boolean;
  confirmDelete: string[];
  /**
   * mode:'update' on an existing ACTIVE flow: the planned sys_hub_flow row carries active='false' /
   * status='draft', so the PATCH deactivates the live flow. Refused unless this is true.
   */
  allowDeactivate?: boolean;
}

export interface WrittenRow { table: string; sys_id: string; action: 'inserted' | 'updated' | 'skipped'; }

export interface CaptureVerification {
  /** 'per_row' = one sys_update_xml per planned row; 'parent_row' = one sys_hub_flow_<id> row containing the children. */
  mode: 'per_row' | 'parent_row' | 'unverified';
  expected: number;
  found: number;
  missing: { table: string; sys_id: string }[];
}

export interface ActivationResult {
  requested: boolean;
  attempted: boolean;
  http_status?: number;
  response?: unknown;
  read_back?: { active?: string; status?: string; latest_snapshot?: string };
  ok: boolean;
  message?: string;
}

export interface WriteResult {
  flowSysId: string;
  instanceName?: string;
  updateSet: { sys_id: string; name: string };
  user: { sys_id: string; user_name: string };
  preferences: { name: string; sys_id: string; value: string }[];
  written: WrittenRow[];
  stale: { table: string; sys_id: string }[];
  deleted: { table: string; sys_id: string }[];
  capture: CaptureVerification;
  activation: ActivationResult;
  summary: string;
  warnings: string[];
}

export interface VerifyDiff { table: string; sys_id: string; field: string; expected: unknown; actual: unknown; }

export interface VerifyResult {
  flowSysId: string;
  found: boolean;
  flow?: Record<string, unknown>;
  trigger?: Record<string, unknown>;
  instances: { table: string; sys_id: string; order: number | string; name: string; decoded: unknown }[];
  diffs: VerifyDiff[];
  unresolvedPills: string[];
  missingUpdateXml: { table: string; sys_id: string }[];
  recentContexts: Record<string, unknown>[];
  ok: boolean;
  warnings: string[];
}
