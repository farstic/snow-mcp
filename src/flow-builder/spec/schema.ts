/**
 * FlowSpec v1 — zod schema + parseSpec().
 *
 * The spec is what the Flow Designer Specialist emits: symbolic pills, no UUIDs,
 * no platform sys_ids except in `{reference}` / `static.<sys_id>` / catalogue
 * identifiers. Everything platform-shaped (descriptors, label_cache, gzip values)
 * is the generator's job.
 *
 * parseSpec() performs the STRUCTURAL validation only:
 *   - shape (zod), spec_version, strict objects (unknown keys are errors)
 *   - pill syntax (every `{{...}}` token and every {pill} value)
 *   - key uniqueness across the whole tree, variable/input/output/stage existence,
 *     loop-only constructs inside loops, subflow-only constructs inside subflows
 * Catalogue validation (unknown action / missing mandatory input / pill typing /
 * forward references) belongs to the generator's validator.
 */
import { z } from 'zod';
import type { ParseSpecResult, SpecError } from './types.js';

// ─── Lexical rules ────────────────────────────────────────────────────────────

export const SYS_ID_RE = /^[0-9a-f]{32}$/;
/** Step / flow / variable / stage keys: snake_case identifiers. */
export const KEY_RE = /^[a-z][a-z0-9_]*$/;
/** ServiceNow table names. */
export const TABLE_RE = /^[a-z][a-z0-9_]*$/;
/** Dotted field walk segment (a dictionary element name). */
const FIELD_SEG = '[A-Za-z_][A-Za-z0-9_]*';
/** Action output names may carry spaces and capitals ('Catalog Task', 'Record', 'approval_state'). */
const OUTPUT_SEG = '[A-Za-z_][A-Za-z0-9_ ]*';

/**
 * Symbolic pill grammar (spec side):
 *   trigger.<output>[.<field>...]        e.g. trigger.current.number, trigger.request_item
 *   steps.<key>.<Output>[.<field>...]    e.g. steps.lookup.Record.assignment_group
 *   loop.<key>.item[.<field>...]         e.g. loop.each_ci.item.name
 *   vars.<name>[.<field>...]             flow variable
 *   inputs.<name>[.<field>...]           subflow input (type=subflow only)
 *   error.<name>                         error-handler / catch data (platform form settled by the PDI decode)
 *   static.<sys_id>                      a literal record reference
 */
export const PILL_RE = new RegExp(
  '^(?:' +
    `trigger\\.${FIELD_SEG}(?:\\.${FIELD_SEG})*` +
    `|steps\\.[a-z][a-z0-9_]*\\.${OUTPUT_SEG}(?:\\.${FIELD_SEG})*` +
    `|loop\\.[a-z][a-z0-9_]*\\.item(?:\\.${FIELD_SEG})*` +
    `|vars\\.[a-z][a-z0-9_]*(?:\\.${FIELD_SEG})*` +
    `|inputs\\.[a-z][a-z0-9_]*(?:\\.${FIELD_SEG})*` +
    `|error\\.[a-z][a-z0-9_]*` +
    '|static\\.[0-9a-f]{32}' +
  ')$'
);

const PILL_TOKEN_RE = /\{\{([^{}]*)\}\}/g;

/** Every `{{...}}` token body found in a string (untrimmed). */
export function pillTokensOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PILL_TOKEN_RE)) out.push(m[1]);
  return out;
}

function invalidTokens(text: string): string[] {
  return pillTokensOf(text).filter(t => !PILL_RE.test(t.trim()));
}

/** Refinement: every {{token}} in the string is a valid symbolic pill. */
const withValidTokens = (s: z.ZodString) =>
  s.superRefine((val, ctx) => {
    for (const bad of invalidTokens(val)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid pill token "{{${bad}}}"` });
    }
  });

// ─── Value grammar ────────────────────────────────────────────────────────────

export const PillSchema = z.string().regex(PILL_RE, 'invalid symbolic pill');
export const SysIdSchema = z.string().regex(SYS_ID_RE, 'must be a 32-char lowercase hex sys_id');

export const PillValueSchema = z.object({ pill: PillSchema }).strict();
export const TextValueSchema = z.object({ text: withValidTokens(z.string()) }).strict();
export const ConditionsValueSchema = z.object({ conditions: withValidTokens(z.string()) }).strict();
export const ReferenceValueSchema = z.object({
  reference: SysIdSchema,
  display: z.string().optional(),
  table: z.string().regex(TABLE_RE).optional(),
}).strict();
export const ScriptValueSchema = z.object({ script: z.string().min(1) }).strict();

/** glide_duration: an object of parts, or 'D HH:MM:SS' / 'HH:MM:SS'. */
export const DurationSpecSchema = z.union([
  z.object({
    days: z.number().int().min(0).optional(),
    hours: z.number().int().min(0).optional(),
    minutes: z.number().int().min(0).optional(),
    seconds: z.number().int().min(0).optional(),
  }).strict().refine(d => Object.keys(d).length > 0, 'duration needs at least one part'),
  z.string().regex(/^(?:\d+ )?\d{1,2}:\d{2}:\d{2}$/, 'duration string must be "D HH:MM:SS" or "HH:MM:SS"'),
]);
export const DurationValueSchema = z.object({ duration: DurationSpecSchema }).strict();

/** An approver / list member: a literal sys_id, a reference pill, or a {reference}. */
export const RefOrPillSchema = z.union([SysIdSchema, PillValueSchema, ReferenceValueSchema]);

/** One item of a {list}: a string (choice value / sys_id), a pill, a {reference} or a {template} object literal. */
export type ListItemInput =
  | string
  | { pill: string }
  | { reference: string; display?: string; table?: string }
  | { template: Record<string, ValueInput> };

/**
 * glide_list / slushbucket: strings (choice values or sys_ids), pills or references. A {template}
 * item is an object literal — valid only in an append_variables value for an array.object variable
 * (several objects appended at once); anywhere else the generator reports it as a spec error.
 */
export const ListValueSchema: z.ZodType<{ list: ListItemInput[] }> = z.object({
  list: z.array(z.union([z.string().min(1), PillValueSchema, ReferenceValueSchema, z.lazy(() => TemplateValueSchema)])),
}).strict();

export const ApprovalRuleSchema = z.object({
  rule: z.union([
    z.enum(['Any', 'All', 'Res']),
    z.object({ count: z.number().int().positive() }).strict(),
    z.object({ percent: z.number().int().min(1).max(100) }).strict(),
  ]),
  users: z.array(RefOrPillSchema).optional(),
  groups: z.array(RefOrPillSchema).optional(),
  manual: z.boolean().optional(),
}).strict().refine(
  r => (r.users?.length ?? 0) > 0 || (r.groups?.length ?? 0) > 0 || r.manual === true,
  'an approval rule needs users, groups or manual:true'
);

export const ApprovalRuleSetSchema = z.object({
  action: z.enum(['Approves', 'Rejects', 'ApprovesRejects']),
  /** rules[i] = a group of conditions; groups are AND-ed, conditions inside a group are OR-ed. */
  rules: z.array(z.array(ApprovalRuleSchema).min(1)).min(1),
}).strict();

export const ApprovalRulesSchema = z.object({ rule_sets: z.array(ApprovalRuleSetSchema).min(1) }).strict();
export const ApprovalRulesValueSchema = z.object({ approval_rules: ApprovalRulesSchema }).strict();

export type ValueInput =
  | string | number | boolean
  | { pill: string }
  | { text: string }
  | { template: Record<string, ValueInput> }
  | { conditions: string }
  | { reference: string; display?: string; table?: string }
  | { approval_rules: z.input<typeof ApprovalRulesSchema> }
  | { duration: z.input<typeof DurationSpecSchema> }
  | { list: ListItemInput[] }
  | { script: string };

/**
 * Template values are stored as 'f1=v1^f2=v2^EQ': a '^' inside a value would silently inject extra
 * field assignments (e.g. work_notes:'x^priority=1' also sets priority). Every literal part of a
 * template value — scalar, {text}, {conditions}, {reference} display, {list} string items — must
 * therefore be free of '^'. Pills and {script} are safe ({{...}} tokens carry no '^'; scripts are
 * stored outside the template string). Returns the offending location, or undefined.
 */
export function templateCaretIssue(v: unknown): string | undefined {
  if (typeof v === 'string') return v.includes('^') ? 'value' : undefined;
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  for (const k of ['text', 'conditions', 'display'] as const) {
    if (typeof o[k] === 'string' && (o[k] as string).includes('^')) return `{${k}}`;
  }
  if (Array.isArray(o.list)) {
    const i = o.list.findIndex(x => typeof x === 'string' ? x.includes('^') : !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).display === 'string' && ((x as Record<string, unknown>).display as string).includes('^'));
    if (i >= 0) return `{list}[${i}]`;
  }
  return undefined;
}

export const TemplateValueSchema: z.ZodType<{ template: Record<string, ValueInput> }> = z.lazy(() =>
  z.object({ template: z.record(z.string().regex(/^[a-z][a-z0-9_.]*$/), ValueSchema) }).strict().superRefine((val, ctx) => {
    for (const [field, v] of Object.entries(val.template)) {
      const where = templateCaretIssue(v);
      if (where) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['template', field],
          message: `template field "${field}": the ${where} contains "^" — template values are encoded as "field=value^field=value^EQ", so a "^" would inject extra field assignments; remove it or set the field with a {script}`,
        });
      }
    }
  })
);

export const ValueSchema: z.ZodType<ValueInput> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    PillValueSchema,
    TextValueSchema,
    TemplateValueSchema,
    ConditionsValueSchema,
    ReferenceValueSchema,
    ApprovalRulesValueSchema,
    DurationValueSchema,
    ListValueSchema,
    ScriptValueSchema,
  ])
);

const InputsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/, 'input names are snake_case'), ValueSchema);

// ─── Flow metadata ────────────────────────────────────────────────────────────

export const FlowMetaSchema = z.object({
  key: z.string().regex(KEY_RE),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  /** Application scope name; 'global' by default. */
  scope: z.string().regex(/^[a-z][a-z0-9_]*$/).default('global'),
  type: z.enum(['flow', 'subflow']).default('flow'),
  /** Default 'user' — the sys_hub_flow_base.run_as dictionary default (PDI-FACTS §11). */
  run_as: z.enum(['user', 'system']).default('user'),
  run_with_roles: z.array(z.string().min(1)).optional(),
  /** Adopt an existing flow instead of deriving a deterministic sys_id from `key`. */
  sys_id: SysIdSchema.optional(),
  /**
   * Declared pill types (symbolic pill without braces → internal type), e.g.
   * { "trigger.current.assignment_group": "reference" }. Authoritative for record-field walks: consulted
   * BEFORE the dictionary resolver, so an offline plan / export can type a pill (and pass the
   * approver-slot check) without an instance.
   */
  pill_types: z.record(PillSchema, z.string().regex(/^[a-z][a-z0-9_.]*$/, 'a pill type is an internal type name, e.g. "reference"')).optional(),
  category: z.string().optional(),
  access: z.enum(['public', 'package_private']).optional(),
  annotation: z.string().optional(),
  flow_priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  show_draft_actions: z.boolean().optional(),
  allow_high_security_roles: z.boolean().optional(),
  callable_by_client_api: z.boolean().optional(),
  internal_name: z.string().optional(),
}).strict();

// ─── Variables / subflow inputs & outputs / stages ────────────────────────────

export const VARIABLE_TYPES = [
  'string', 'integer', 'decimal', 'float', 'boolean', 'choice',
  'glide_date', 'glide_date_time', 'glide_duration', 'time',
  'reference', 'glide_list', 'document_id', 'table_name', 'field_name',
  'html', 'url', 'json', 'password2', 'translated_text', 'script',
  'records', 'object',
  'array.string', 'array.integer', 'array.decimal', 'array.boolean',
  'array.reference', 'array.glide_date', 'array.glide_date_time', 'array.object',
] as const;

export const VariableDefSchema = z.object({
  name: z.string().regex(KEY_RE),
  label: z.string().min(1).optional(),
  type: z.enum(VARIABLE_TYPES),
  reference_table: z.string().regex(TABLE_RE).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  mandatory: z.boolean().optional(),
  hint: z.string().optional(),
  max_length: z.number().int().positive().optional(),
  choices: z.array(z.object({ value: z.string(), label: z.string() }).strict()).optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.type === 'reference' || v.type === 'array.reference' || v.type === 'glide_list' || v.type === 'records') && !v.reference_table) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reference_table'], message: `reference_table is required for type ${v.type}` });
  }
  if (v.type === 'choice' && !v.choices?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['choices'], message: 'choices are required for type choice' });
  }
});

export const StageDefSchema = z.object({
  value: z.string().regex(KEY_RE),
  label: z.string().min(1),
  duration: DurationSpecSchema.optional(),
  always_show: z.boolean().optional(),
}).strict();

// ─── Triggers ─────────────────────────────────────────────────────────────────

const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;
/** Instance-local glide_date_time: 'YYYY-MM-DD HH:MM:SS' (stored as given; the platform reads it in the instance time zone). */
export const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
/** ISO-8601 instant with 'Z' or an offset: '2026-09-24T14:48:00Z', '2026-09-24T16:48+02:00' (seconds optional, no fractions). */
export const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Date.UTC without its two-digit-year quirk (years 0-99 map to 1900-1999 there): the year is set with setUTCFullYear,
 * so '0050-01-01' is the year 50, not 1950. `month0` is 0-based.
 */
export function utcMillis(y: number, month0: number, d: number, h = 0, mi = 0, s = 0): number {
  const date = new Date(Date.UTC(2000, month0, d, h, mi, s));
  date.setUTCFullYear(y, month0, d);
  return date.getTime();
}

function validCalendar(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  return new Date(utcMillis(y, mo - 1, d)).getUTCDate() === d;
}

/** A run_in value in the instance-local form (calendar-valid). */
export function isLocalDateTime(v: string): boolean {
  const m = LOCAL_DATETIME_RE.exec(v);
  return !!m && validCalendar(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
}

/** The instant of an ISO-8601 value with 'Z' / offset, or undefined when `v` is not one (or not a real date/time). */
export function parseIsoInstant(v: string): Date | undefined {
  const m = ISO_INSTANT_RE.exec(v);
  if (!m) return undefined;
  const s = m[6] === undefined ? 0 : +m[6];
  if (!validCalendar(+m[1], +m[2], +m[3], +m[4], +m[5], s)) return undefined;
  let off = 0;
  if (m[7] !== 'Z') {
    const [oh, om] = m[7].slice(1).split(':').map(Number);
    if (oh > 18 || om > 59) return undefined;
    off = (m[7][0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return new Date(utcMillis(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], s) - off * 60000);
}

const RUN_IN_MESSAGE = 'run_in must be "YYYY-MM-DD HH:MM:SS" (instance-local wall time) or an ISO-8601 instant with "Z" or an offset (e.g. "2026-09-24T14:48:00Z")';

const triggerBase = {
  key: z.string().regex(KEY_RE),
  annotation: z.string().optional(),
};

const recordTriggerFields = {
  ...triggerBase,
  table: z.string().regex(TABLE_RE),
  condition: withValidTokens(z.string()).optional(),
  run_flow_in: z.enum(['any', 'background', 'foreground']).optional(),
  run_on_extended: z.boolean().optional(),
  run_when_setting: z.enum(['both', 'non_interactive', 'interactive']).optional(),
  run_when_user_setting: z.enum(['any', 'one_of', 'not_one_of']).optional(),
  run_when_user_list: z.array(RefOrPillSchema).optional(),
};

const RecordCreatedTrigger = z.object({ type: z.literal('record.created'), ...recordTriggerFields }).strict();
/**
 * "Run Trigger" of the Updated / Created or Updated triggers (catalogue choice list, PDI-FACTS §6):
 * once (default) · always ("Only if not currently running") · every ("For every update") ·
 * unique_changes ("For each unique change").
 */
export const TRIGGER_STRATEGIES = ['once', 'always', 'every', 'unique_changes'] as const;
const RecordUpdatedTrigger = z.object({
  type: z.literal('record.updated'), ...recordTriggerFields,
  trigger_strategy: z.enum(TRIGGER_STRATEGIES).optional(),
}).strict();
const RecordCreatedOrUpdatedTrigger = z.object({
  type: z.literal('record.created_or_updated'), ...recordTriggerFields,
  trigger_strategy: z.enum(TRIGGER_STRATEGIES).optional(),
}).strict();

const scheduledCommon = { ...triggerBase, timezone: z.string().optional() };
const DAY_OF_WEEK = z.union([
  z.number().int().min(1).max(7),
  z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
]);

const DailyTrigger = z.object({ type: z.literal('scheduled.daily'), ...scheduledCommon, time: z.string().regex(TIME_RE) }).strict();
const WeeklyTrigger = z.object({ type: z.literal('scheduled.weekly'), ...scheduledCommon, day_of_week: DAY_OF_WEEK, time: z.string().regex(TIME_RE) }).strict();
const MonthlyTrigger = z.object({ type: z.literal('scheduled.monthly'), ...scheduledCommon, day_of_month: z.number().int().min(1).max(31), time: z.string().regex(TIME_RE) }).strict();
const RepeatTrigger = z.object({ type: z.literal('scheduled.repeat'), ...scheduledCommon, repeat: DurationSpecSchema }).strict();
const RunOnceTrigger = z.object({ type: z.literal('scheduled.run_once'), ...scheduledCommon, run_in: z.string().refine(v => isLocalDateTime(v) || parseIsoInstant(v) !== undefined, RUN_IN_MESSAGE) }).strict();

const InboundEmailTrigger = z.object({
  type: z.literal('email.inbound'), ...triggerBase,
  email_conditions: withValidTokens(z.string()).optional(),
  order: z.number().int().optional(),
  stop_condition_evaluation: z.boolean().optional(),
  target_table: z.string().regex(TABLE_RE).optional(),
}).strict();

const ServiceCatalogTrigger = z.object({
  type: z.literal('catalog.service_catalog'), ...triggerBase,
  run_flow_in: z.enum(['any', 'background', 'foreground']).optional(),
}).strict();

const SlaTaskTrigger = z.object({ type: z.literal('sla.task'), ...triggerBase }).strict();
const KnowledgeTrigger = z.object({ type: z.literal('knowledge.management'), ...triggerBase }).strict();
const RemoteTableQueryTrigger = z.object({ type: z.literal('remote_table.query'), ...triggerBase, table: z.string().regex(TABLE_RE) }).strict();

/** Escape hatch for a trigger definition not in the built-in catalogue (e.g. an application trigger). */
const CustomTrigger = z.object({
  type: z.literal('custom'), ...triggerBase,
  definition: SysIdSchema,
  trigger_type: z.string().min(1),
  name: z.string().min(1),
  inputs: InputsSchema.default({}),
}).strict();

export const TriggerSchema = z.discriminatedUnion('type', [
  RecordCreatedTrigger, RecordUpdatedTrigger, RecordCreatedOrUpdatedTrigger,
  DailyTrigger, WeeklyTrigger, MonthlyTrigger, RepeatTrigger, RunOnceTrigger,
  InboundEmailTrigger, ServiceCatalogTrigger, SlaTaskTrigger, KnowledgeTrigger, RemoteTableQueryTrigger,
  CustomTrigger,
]);

export const TRIGGER_TYPES = TriggerSchema.options.map(o => o.shape.type.value) as ReadonlyArray<z.infer<typeof TriggerSchema>['type']>;

// ─── Steps ────────────────────────────────────────────────────────────────────

const stepBase = {
  key: z.string().regex(KEY_RE),
  annotation: z.string().optional(),
  /** A stage value from `stages[]`; the stage is entered before this step. */
  stage: z.string().regex(KEY_RE).optional(),
};

const ConditionString = withValidTokens(z.string().min(1));
/** Optional condition label of an If / Else If / Do-Until block (stored as the `condition_name` input). */
const ConditionLabel = z.string().min(1).optional();

/** `{sys_id}` or `{name, scope?}` — how a subflow / custom action is identified. */
const DefinitionRefSchema = z.union([
  z.object({ sys_id: SysIdSchema }).strict(),
  z.object({ name: z.string().min(1), scope: z.string().regex(/^[a-z][a-z0-9_]*$/).optional() }).strict(),
]);

/** Common step fields (spec input side). */
interface StepBaseInput { key: string; annotation?: string; stage?: string }

export type DefinitionRef = { sys_id: string } | { name: string; scope?: string };
export type WaitDurationType = 'explicit' | 'relative' | 'percentage';

/** The step shape the spec AUTHOR writes (defaults optional). */
export type StepInput =
  | (StepBaseInput & { kind: 'action'; action: string; inputs?: Record<string, ValueInput> })
  | (StepBaseInput & { kind: 'custom_action'; definition: DefinitionRef; inputs?: Record<string, ValueInput> })
  | (StepBaseInput & { kind: 'subflow'; subflow: DefinitionRef; inputs?: Record<string, ValueInput>; wait_for_completion?: boolean; show_stages?: boolean })
  | (StepBaseInput & { kind: 'if'; condition: string; label?: string; then: StepInput[]; else_if?: { key: string; condition: string; label?: string; steps: StepInput[] }[]; else?: { key: string; steps: StepInput[] } })
  | (StepBaseInput & { kind: 'for_each'; items: { pill: string }; steps: StepInput[] })
  | (StepBaseInput & { kind: 'do_until'; condition: string; label?: string; steps: StepInput[] })
  | (StepBaseInput & { kind: 'try_catch'; try: StepInput[]; catch: { key: string; steps: StepInput[] } })
  | (StepBaseInput & { kind: 'do_in_parallel'; branches: { key: string; steps: StepInput[] }[] })
  | (StepBaseInput & { kind: 'end_flow' })
  | (StepBaseInput & { kind: 'exit_loop' })
  | (StepBaseInput & { kind: 'skip_iteration' })
  | (StepBaseInput & { kind: 'wait'; duration_type?: WaitDurationType; duration?: z.input<typeof DurationSpecSchema>; schedule?: z.input<typeof RefOrPillSchema>; relative_operator?: 'before' | 'after'; relative_datetime?: ValueInput; percentage?: number; percentage_datetime?: ValueInput })
  | (StepBaseInput & { kind: 'set_variables'; assign: Record<string, ValueInput> })
  | (StepBaseInput & { kind: 'append_variables'; assign: Record<string, ValueInput> })
  | (StepBaseInput & { kind: 'assign_subflow_outputs'; assign: Record<string, ValueInput> });

/** The step shape parseSpec() RETURNS (defaults applied: inputs, wait_for_completion, duration_type). */
export type StepOutput =
  | (StepBaseInput & { kind: 'action'; action: string; inputs: Record<string, ValueInput> })
  | (StepBaseInput & { kind: 'custom_action'; definition: DefinitionRef; inputs: Record<string, ValueInput> })
  | (StepBaseInput & { kind: 'subflow'; subflow: DefinitionRef; inputs: Record<string, ValueInput>; wait_for_completion: boolean; show_stages?: boolean })
  | (StepBaseInput & { kind: 'if'; condition: string; label?: string; then: StepOutput[]; else_if?: { key: string; condition: string; label?: string; steps: StepOutput[] }[]; else?: { key: string; steps: StepOutput[] } })
  | (StepBaseInput & { kind: 'for_each'; items: { pill: string }; steps: StepOutput[] })
  | (StepBaseInput & { kind: 'do_until'; condition: string; label?: string; steps: StepOutput[] })
  | (StepBaseInput & { kind: 'try_catch'; try: StepOutput[]; catch: { key: string; steps: StepOutput[] } })
  | (StepBaseInput & { kind: 'do_in_parallel'; branches: { key: string; steps: StepOutput[] }[] })
  | (StepBaseInput & { kind: 'end_flow' })
  | (StepBaseInput & { kind: 'exit_loop' })
  | (StepBaseInput & { kind: 'skip_iteration' })
  | (StepBaseInput & { kind: 'wait'; duration_type: WaitDurationType; duration?: z.output<typeof DurationSpecSchema>; schedule?: z.output<typeof RefOrPillSchema>; relative_operator?: 'before' | 'after'; relative_datetime?: ValueInput; percentage?: number; percentage_datetime?: ValueInput })
  | (StepBaseInput & { kind: 'set_variables'; assign: Record<string, ValueInput> })
  | (StepBaseInput & { kind: 'append_variables'; assign: Record<string, ValueInput> })
  | (StepBaseInput & { kind: 'assign_subflow_outputs'; assign: Record<string, ValueInput> });

const AssignSchema = z.record(z.string().regex(KEY_RE), ValueSchema).refine(a => Object.keys(a).length > 0, 'assign needs at least one entry');

const StepsArray: z.ZodType<StepOutput[], z.ZodTypeDef, StepInput[]> = z.lazy(() => z.array(StepSchema));
const Block = (keyName = 'key') => z.object({ [keyName]: z.string().regex(KEY_RE), steps: StepsArray }).strict();

const ActionStepSchema = z.object({ kind: z.literal('action'), ...stepBase, action: z.string().min(1), inputs: InputsSchema.default({}) }).strict();
const CustomActionStepSchema = z.object({ kind: z.literal('custom_action'), ...stepBase, definition: DefinitionRefSchema, inputs: InputsSchema.default({}) }).strict();
const SubflowStepSchema = z.object({
  kind: z.literal('subflow'), ...stepBase, subflow: DefinitionRefSchema, inputs: InputsSchema.default({}),
  wait_for_completion: z.boolean().default(true), show_stages: z.boolean().optional(),
}).strict();
const IfStepSchema = z.object({
  kind: z.literal('if'), ...stepBase, condition: ConditionString, label: ConditionLabel, then: StepsArray,
  else_if: z.array(z.object({ key: z.string().regex(KEY_RE), condition: ConditionString, label: ConditionLabel, steps: StepsArray }).strict()).optional(),
  else: Block().optional(),
}).strict();
const ForEachStepSchema = z.object({ kind: z.literal('for_each'), ...stepBase, items: PillValueSchema, steps: StepsArray }).strict();
const DoUntilStepSchema = z.object({ kind: z.literal('do_until'), ...stepBase, condition: ConditionString, label: ConditionLabel, steps: StepsArray }).strict();
const TryCatchStepSchema = z.object({ kind: z.literal('try_catch'), ...stepBase, try: StepsArray, catch: Block() }).strict();
const DoInParallelStepSchema = z.object({ kind: z.literal('do_in_parallel'), ...stepBase, branches: z.array(Block()).min(2) }).strict();
const EndFlowStepSchema = z.object({ kind: z.literal('end_flow'), ...stepBase }).strict();
const ExitLoopStepSchema = z.object({ kind: z.literal('exit_loop'), ...stepBase }).strict();
const SkipIterationStepSchema = z.object({ kind: z.literal('skip_iteration'), ...stepBase }).strict();
const WaitStepSchema = z.object({
  kind: z.literal('wait'), ...stepBase,
  duration_type: z.enum(['explicit', 'relative', 'percentage']).default('explicit'),
  duration: DurationSpecSchema.optional(),
  schedule: RefOrPillSchema.optional(),
  relative_operator: z.enum(['before', 'after']).optional(),
  relative_datetime: ValueSchema.optional(),
  percentage: z.number().int().min(1).max(100).optional(),
  percentage_datetime: ValueSchema.optional(),
}).strict();

/** Wait-step cross-field rules (kept out of the schema object so it stays usable in the discriminated union). */
function waitStepIssues(w: Extract<StepOutput, { kind: 'wait' }>): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if ((w.duration_type === 'explicit' || w.duration_type === 'relative') && w.duration === undefined) {
    out.push({ path: 'duration', message: `duration is required for duration_type ${w.duration_type}` });
  }
  if (w.duration_type === 'relative' && (w.relative_operator === undefined || w.relative_datetime === undefined)) {
    out.push({ path: 'relative_datetime', message: 'relative_operator and relative_datetime are required for duration_type relative' });
  }
  if (w.duration_type === 'percentage' && (w.percentage === undefined || w.percentage_datetime === undefined)) {
    out.push({ path: 'percentage', message: 'percentage and percentage_datetime are required for duration_type percentage' });
  }
  return out;
}
const SetVariablesStepSchema = z.object({ kind: z.literal('set_variables'), ...stepBase, assign: AssignSchema }).strict();
const AppendVariablesStepSchema = z.object({ kind: z.literal('append_variables'), ...stepBase, assign: AssignSchema }).strict();
const AssignSubflowOutputsStepSchema = z.object({ kind: z.literal('assign_subflow_outputs'), ...stepBase, assign: AssignSchema }).strict();

export const StepSchema: z.ZodType<StepOutput, z.ZodTypeDef, StepInput> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    ActionStepSchema, CustomActionStepSchema, SubflowStepSchema,
    IfStepSchema, ForEachStepSchema, DoUntilStepSchema, TryCatchStepSchema, DoInParallelStepSchema,
    EndFlowStepSchema, ExitLoopStepSchema, SkipIterationStepSchema, WaitStepSchema,
    SetVariablesStepSchema, AppendVariablesStepSchema, AssignSubflowOutputsStepSchema,
  ])
) as unknown as z.ZodType<StepOutput, z.ZodTypeDef, StepInput>;

export const STEP_KINDS = [
  'action', 'custom_action', 'subflow', 'if', 'for_each', 'do_until', 'try_catch', 'do_in_parallel',
  'end_flow', 'exit_loop', 'skip_iteration', 'wait', 'set_variables', 'append_variables', 'assign_subflow_outputs',
] as const;

export const ErrorHandlerSchema = z.object({
  key: z.string().regex(KEY_RE).default('error_handler'),
  steps: StepsArray,
}).strict();

// ─── Flow spec ────────────────────────────────────────────────────────────────

/** Shape only (no cross-field rules) — the type anchor for the structural refinement below. */
export const FlowSpecShapeSchema = z.object({
  spec_version: z.literal('1'),
  flow: FlowMetaSchema,
  trigger: TriggerSchema.optional(),
  /** Subflow definitions only. */
  inputs: z.array(VariableDefSchema).optional(),
  outputs: z.array(VariableDefSchema).optional(),
  variables: z.array(VariableDefSchema).optional(),
  stages: z.array(StageDefSchema).optional(),
  steps: StepsArray,
  /** Flow Error Handler section (flows only; steps run when any step errors). */
  error_handler: ErrorHandlerSchema.optional(),
}).strict();

type FlowSpecOut = z.output<typeof FlowSpecShapeSchema>;
type StepOut = StepOutput;

export const FlowSpecSchema = FlowSpecShapeSchema.superRefine(structuralChecks);

// ─── Structural refinements ───────────────────────────────────────────────────

interface Walk {
  keys: Map<string, (string | number)[]>;
  forEachKeys: Set<string>;
  stepKeys: Set<string>;
  issues: { path: (string | number)[]; message: string }[];
}

function addKey(w: Walk, key: string, path: (string | number)[]): void {
  const prev = w.keys.get(key);
  if (prev) w.issues.push({ path, message: `duplicate key "${key}" (first used at ${prev.join('.') || '<root>'})` });
  else w.keys.set(key, path);
}

function collectPills(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') { for (const t of pillTokensOf(value)) out.push(t.trim()); return; }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) collectPills(v, out); return; }
  const obj = value as Record<string, unknown>;
  if (typeof obj.pill === 'string' && Object.keys(obj).length === 1) { out.push(obj.pill); return; }
  for (const v of Object.values(obj)) collectPills(v, out);
}

function walkSteps(
  w: Walk, steps: StepOut[], path: (string | number)[], ctx: { inLoop: boolean; inCatch: boolean; inErrorHandler: boolean },
  visit: (step: StepOut, path: (string | number)[], ctx: { inLoop: boolean; inCatch: boolean; inErrorHandler: boolean }) => void
): void {
  steps.forEach((step, i) => {
    const p = [...path, i];
    addKey(w, step.key, [...p, 'key']);
    w.stepKeys.add(step.key);
    visit(step, p, ctx);
    switch (step.kind) {
      case 'if':
        walkSteps(w, step.then, [...p, 'then'], ctx, visit);
        step.else_if?.forEach((b, j) => { addKey(w, b.key, [...p, 'else_if', j, 'key']); walkSteps(w, b.steps, [...p, 'else_if', j, 'steps'], ctx, visit); });
        if (step.else) { addKey(w, step.else.key, [...p, 'else', 'key']); walkSteps(w, step.else.steps, [...p, 'else', 'steps'], ctx, visit); }
        break;
      case 'for_each':
        w.forEachKeys.add(step.key);
        walkSteps(w, step.steps, [...p, 'steps'], { ...ctx, inLoop: true }, visit);
        break;
      case 'do_until':
        walkSteps(w, step.steps, [...p, 'steps'], { ...ctx, inLoop: true }, visit);
        break;
      case 'try_catch':
        walkSteps(w, step.try, [...p, 'try'], ctx, visit);
        addKey(w, step.catch.key, [...p, 'catch', 'key']);
        walkSteps(w, step.catch.steps, [...p, 'catch', 'steps'], { ...ctx, inCatch: true }, visit);
        break;
      case 'do_in_parallel':
        step.branches.forEach((b, j) => { addKey(w, b.key, [...p, 'branches', j, 'key']); walkSteps(w, b.steps, [...p, 'branches', j, 'steps'], ctx, visit); });
        break;
      default:
        break;
    }
  });
}

function structuralChecks(spec: FlowSpecOut, ctx: z.RefinementCtx): void {
  const w: Walk = { keys: new Map(), forEachKeys: new Set(), stepKeys: new Set(), issues: [] };
  const isSubflow = spec.flow.type === 'subflow';

  // flow-level shape
  if (!isSubflow && !spec.trigger) w.issues.push({ path: ['trigger'], message: 'a flow requires a trigger' });
  if (isSubflow && spec.trigger) w.issues.push({ path: ['trigger'], message: 'a subflow cannot have a trigger' });
  if (!isSubflow && (spec.inputs || spec.outputs)) w.issues.push({ path: ['inputs'], message: 'inputs/outputs are only valid for type "subflow"' });
  if (isSubflow && spec.error_handler) w.issues.push({ path: ['error_handler'], message: 'error_handler is only valid for type "flow"' });

  addKey(w, spec.flow.key, ['flow', 'key']);
  if (spec.trigger) addKey(w, spec.trigger.key, ['trigger', 'key']);

  const uniqueNames = (items: { name?: string; value?: string }[] | undefined, field: 'name' | 'value', where: string) => {
    const seen = new Set<string>();
    items?.forEach((it, i) => {
      const n = it[field] as string;
      if (seen.has(n)) w.issues.push({ path: [where, i, field], message: `duplicate ${where} ${field} "${n}"` });
      seen.add(n);
    });
    return seen;
  };
  const varNames = uniqueNames(spec.variables, 'name', 'variables');
  const inputNames = uniqueNames(spec.inputs, 'name', 'inputs');
  const outputNames = uniqueNames(spec.outputs, 'name', 'outputs');
  const stageValues = uniqueNames(spec.stages, 'value', 'stages');

  const pillRefs: { pill: string; path: (string | number)[] }[] = [];

  const visit = (step: StepOut, p: (string | number)[], c: { inLoop: boolean; inCatch: boolean; inErrorHandler: boolean }) => {
    if (step.stage !== undefined && !stageValues.has(step.stage)) w.issues.push({ path: [...p, 'stage'], message: `unknown stage "${step.stage}"` });
    if ((step.kind === 'exit_loop' || step.kind === 'skip_iteration') && !c.inLoop) {
      w.issues.push({ path: [...p, 'kind'], message: `${step.kind} is only valid inside for_each / do_until` });
    }
    if (step.kind === 'assign_subflow_outputs') {
      if (!isSubflow) w.issues.push({ path: [...p, 'kind'], message: 'assign_subflow_outputs is only valid in a subflow' });
      for (const n of Object.keys(step.assign)) if (!outputNames.has(n)) w.issues.push({ path: [...p, 'assign', n], message: `unknown subflow output "${n}"` });
    }
    if (step.kind === 'set_variables' || step.kind === 'append_variables') {
      for (const n of Object.keys(step.assign)) if (!varNames.has(n)) w.issues.push({ path: [...p, 'assign', n], message: `unknown flow variable "${n}"` });
    }
    if (step.kind === 'wait') {
      for (const issue of waitStepIssues(step)) w.issues.push({ path: [...p, issue.path], message: issue.message });
    }
    const pills: string[] = [];
    collectPills(step, pills);
    for (const pill of pills) pillRefs.push({ pill, path: p });
  };

  walkSteps(w, spec.steps, ['steps'], { inLoop: false, inCatch: false, inErrorHandler: false }, visit);
  if (spec.error_handler) {
    addKey(w, spec.error_handler.key, ['error_handler', 'key']);
    walkSteps(w, spec.error_handler.steps, ['error_handler', 'steps'], { inLoop: false, inCatch: false, inErrorHandler: true }, visit);
  }
  if (spec.trigger) { const pills: string[] = []; collectPills(spec.trigger, pills); for (const pill of pills) pillRefs.push({ pill, path: ['trigger'] }); }

  // pill targets must exist (ordering / typing is the generator's job)
  for (const { pill, path } of pillRefs) {
    const seg = pill.split('.');
    switch (seg[0]) {
      case 'trigger':
        if (!spec.trigger) w.issues.push({ path, message: `pill "${pill}" needs a trigger` });
        break;
      case 'steps':
        if (!w.stepKeys.has(seg[1])) w.issues.push({ path, message: `pill "${pill}" refers to unknown step "${seg[1]}"` });
        break;
      case 'loop':
        if (!w.forEachKeys.has(seg[1])) w.issues.push({ path, message: `pill "${pill}" refers to unknown for_each "${seg[1]}"` });
        break;
      case 'vars':
        if (!varNames.has(seg[1])) w.issues.push({ path, message: `pill "${pill}" refers to unknown flow variable "${seg[1]}"` });
        break;
      case 'inputs':
        if (!inputNames.has(seg[1])) w.issues.push({ path, message: `pill "${pill}" refers to unknown subflow input "${seg[1]}"` });
        break;
      default:
        break; // error.* and static.* are validated lexically only
    }
  }

  for (const issue of w.issues) ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
}

// ─── parseSpec ────────────────────────────────────────────────────────────────

/**
 * A union failure ("Invalid input") hides which alternative the author meant. Take the
 * deepest-path issue across the union branches — the branch that got furthest into the
 * value is almost always the intended one — and report that instead.
 */
function unpackUnion(issue: z.ZodIssue): z.ZodIssue[] {
  if (issue.code !== z.ZodIssueCode.invalid_union) return [issue];
  const inner = issue.unionErrors.flatMap(e => e.issues.flatMap(unpackUnion));
  if (inner.length === 0) return [issue];
  const deepest = Math.max(...inner.map(i => i.path.length));
  const best = inner.filter(i => i.path.length === deepest && i.path.length > issue.path.length);
  return best.length ? best : [issue];
}

function formatIssues(issues: z.ZodIssue[]): SpecError[] {
  const seen = new Set<string>();
  const out: SpecError[] = [];
  for (const i of issues.flatMap(unpackUnion)) {
    const entry = { path: i.path.join('.'), message: i.message };
    const key = `${entry.path}\u0000${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Parse + structurally validate a FlowSpec v1.
 * Accepts a JSON string or an already-parsed object.
 */
export function parseSpec(input: unknown): ParseSpecResult {
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) {
      return { errors: [{ path: '', message: `spec is not valid JSON: ${(e as Error).message}` }] };
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: [{ path: '', message: 'spec must be a JSON object' }] };
  }
  const version = (raw as Record<string, unknown>).spec_version;
  if (version !== '1') {
    return { errors: [{ path: 'spec_version', message: `unsupported spec_version ${JSON.stringify(version)} (expected "1")` }] };
  }
  const result = FlowSpecSchema.safeParse(raw);
  if (!result.success) return { errors: formatIssues(result.error.issues) };
  return { spec: result.data };
}
