/**
 * `parameter` mirrors — the input-definition object Workflow Studio stores on every values entry
 * (sys_hub_action_instance_v2.values, sys_hub_flow_logic_instance_v2.values, sys_hub_sub_flow_instance_v2.subflow_inputs,
 * sys_hub_trigger_instance_v2.trigger_inputs), built from the catalogue definitions (catalog/data, exported from the
 * instance) — never from a UI row.
 *
 * Two forms, both read from UI-built rows on the PDI (tests/flow-builder/fixtures/pdi; FORMAT-DECISIONS.md):
 *   action form (29 keys, the newest rows):
 *     children, id, label, name, type, typeLabel, order, extended, mandatory, readOnly, hint, maxsize, reference,
 *     reference_display, fDataStructure, choices, defaultChoices, choiceOption, table, columnName, defaultValue,
 *     [defaultDisplayValue — only with a non-empty defaultValue], use_dependent, fShowReferenceFinder, local,
 *     [fSearchField — reference inputs only, the display field of the referenced table], attributes, sysClassName,
 *     ref_qual, dependent_on
 *   logic form (24 keys, every logic row read): children, type_label, id, label, name, type, order, extended, mandatory,
 *     readOnly, hint, maxsize, reference, reference_display, choiceOption, table, columnName, defaultValue, use_dependent,
 *     fShowReferenceFinder, local, attributes, ref_qual, dependent_on (+ choices / defaultChoices on a choice input).
 * `table` / `columnName` (a dictionary-backed choice source, e.g. Send Notification `notification`) are not derivable
 * from the definitions and stay ''. Choice lists carry the definition's choices in sequence order with the UI's
 * '-- None --' entry first for a "dropdown with none" input (choiceOption 1).
 *
 * Owner: GENERATOR.
 */
import type { CatalogInputRaw } from '../catalog/load.js';
import { knownTableDisplayField } from '../catalog/load.js';

/** Flow Designer type → the label Workflow Studio shows (parameter.typeLabel / type_label, attributes uiTypeLabel). */
const TYPE_LABELS: Record<string, string> = {
  string: 'String', string_full_utf8: 'String', boolean: 'True/False', integer: 'Integer', decimal: 'Decimal', float: 'Float',
  reference: 'Reference', document_id: 'Document ID', table_name: 'Table Name', field_name: 'Field Name', template_value: 'Template Value',
  slushbucket: 'Slush Bucket', choice: 'Choice', approval_rules: 'Approval Rules', schedule_date_time: 'Schedule Date/Time',
  conditions: 'Conditions', glide_duration: 'Duration', glide_date_time: 'Date/Time', glide_date: 'Date', glide_time: 'Time',
  glide_list: 'List', records: 'Records', json: 'JSON', object: 'Object', html: 'HTML', url: 'URL', email: 'Email',
  password2: 'Password (2 Way)', translated_text: 'Translated Text',
};

/** The type label of a Flow Designer type ('boolean' → 'True/False'); unknown types are title-cased. */
export function typeLabelFor(internalType: string): string {
  if (internalType.startsWith('array.')) return `Array.${typeLabelFor(internalType.slice('array.'.length))}`;
  return TYPE_LABELS[internalType] ?? (internalType.charAt(0).toUpperCase() + internalType.slice(1));
}

export interface ChoiceEntry { label: string; value: string; order: number }

/** UI choice lists of a definition: '-- None --' first unless the input is a "dropdown without none" (choice 3). */
export function choiceLists(i: Pick<CatalogInputRaw, 'choices' | 'choice_option' | 'type'>): { choices: ChoiceEntry[]; defaultChoices: ChoiceEntry[] } {
  const items = i.choices ?? [];
  if (!items.length) return { choices: [], defaultChoices: [] };
  const withNone = i.choice_option !== '3';
  const list = (start: number): ChoiceEntry[] => {
    const out: ChoiceEntry[] = [];
    if (withNone) out.push({ label: '-- None --', value: '', order: start });
    items.forEach((c, k) => out.push({ label: c.label, value: c.value, order: start + (withNone ? 1 : 0) + k }));
    return out;
  };
  return { choices: list(0), defaultChoices: list(1) };
}

/** The stored default of a definition ('' when none) and its display form (boolean 'true'/'false', a choice's label). */
export function definitionDefault(i: Pick<CatalogInputRaw, 'default' | 'type' | 'choices'>): { value: string; display: string } {
  if (i.default === undefined || i.default === '') return { value: '', display: '' };
  const value = String(i.default);
  if (i.type === 'choice') return { value, display: i.choices?.find(c => c.value === value)?.label ?? value };
  return { value, display: value };
}

function base(i: CatalogInputRaw): Record<string, unknown> {
  const attributes: Record<string, string> = { ...(i.attributes ?? {}) };
  return {
    id: i.sys_id ?? '',
    label: i.label,
    name: i.name,
    type: i.type,
    order: i.order ?? 0,
    extended: false,
    mandatory: !!i.mandatory,
    readOnly: !!i.read_only,
    hint: i.hint ?? '',
    maxsize: i.maxLength ?? 0,
    reference: i.reference ?? '',
    reference_display: i.reference_display ?? '',
    choiceOption: i.choice_option ?? '',
    table: '',
    columnName: '',
    defaultValue: definitionDefault(i).value,
    use_dependent: !!i.dependent,
    fShowReferenceFinder: false,
    local: false,
    attributes,
    ref_qual: '',
    dependent_on: i.dependent ?? '',
  };
}

/** The 29-key action form (sys_hub_action_instance_v2 values, subflow_inputs, generic trigger descriptors). */
export function actionParameter(i: CatalogInputRaw): Record<string, unknown> {
  const b = base(i);
  const { choices, defaultChoices } = choiceLists(i);
  const def = definitionDefault(i);
  const out: Record<string, unknown> = {
    children: [], id: b.id, label: b.label, name: b.name, type: b.type, typeLabel: typeLabelFor(i.type), order: b.order, extended: false,
    mandatory: b.mandatory, readOnly: b.readOnly, hint: b.hint, maxsize: b.maxsize, reference: b.reference, reference_display: b.reference_display,
    fDataStructure: '', choices, defaultChoices, choiceOption: b.choiceOption, table: '', columnName: '', defaultValue: def.value,
  };
  if (def.value !== '') out.defaultDisplayValue = def.display;
  out.use_dependent = b.use_dependent;
  out.fShowReferenceFinder = false;
  out.local = false;
  if (i.type === 'reference' && i.reference) {
    const display = knownTableDisplayField(i.reference);
    if (display) out.fSearchField = display;
  }
  out.attributes = b.attributes;
  out.sysClassName = '';
  out.ref_qual = '';
  out.dependent_on = b.dependent_on;
  return out;
}

/** The 24-key logic form (sys_hub_flow_logic_instance_v2 values); a choice input also carries its choice lists. */
export function logicParameter(i: CatalogInputRaw): Record<string, unknown> {
  const b = base(i);
  const out: Record<string, unknown> = {
    children: [], type_label: typeLabelFor(i.type), id: b.id, label: b.label, name: b.name, type: b.type, order: b.order, extended: false,
    mandatory: b.mandatory, readOnly: b.readOnly, hint: b.hint, maxsize: b.maxsize, reference: b.reference, reference_display: b.reference_display,
  };
  if (i.type === 'choice' && i.choices?.length) Object.assign(out, choiceLists(i));
  out.choiceOption = b.choiceOption;
  out.table = '';
  out.columnName = '';
  out.defaultValue = b.defaultValue;
  out.use_dependent = b.use_dependent;
  out.fShowReferenceFinder = false;
  out.local = false;
  out.attributes = b.attributes;
  out.ref_qual = '';
  out.dependent_on = b.dependent_on;
  return out;
}

/**
 * The trigger-descriptor form (sys_hub_trigger_instance_v2 trigger_inputs, 25–26 keys on UI-built record-trigger rows):
 * children, id, label, name, type, order, extended, mandatory, readOnly, hint, maxsize, reference, reference_display,
 * [choices, defaultChoices — choice inputs], choiceOption, table, columnName, defaultValue, [defaultDisplayValue — with a
 * default], use_dependent, fShowReferenceFinder, local, attributes, ref_qual, dependent_on.
 */
export function triggerParameter(i: CatalogInputRaw): Record<string, unknown> {
  const b = base(i);
  const def = definitionDefault(i);
  const out: Record<string, unknown> = {
    children: [], id: b.id, label: b.label, name: b.name, type: b.type, order: b.order, extended: false,
    mandatory: b.mandatory, readOnly: b.readOnly, hint: b.hint, maxsize: b.maxsize, reference: b.reference, reference_display: b.reference_display,
  };
  if (i.type === 'choice' && i.choices?.length) Object.assign(out, choiceLists(i));
  out.choiceOption = b.choiceOption;
  out.table = '';
  out.columnName = '';
  out.defaultValue = def.value;
  if (def.value !== '') out.defaultDisplayValue = def.display;
  out.use_dependent = b.use_dependent;
  out.fShowReferenceFinder = false;
  out.local = false;
  out.attributes = b.attributes;
  out.ref_qual = '';
  out.dependent_on = b.dependent_on;
  return out;
}

/** A flow variable / subflow output as a Set Flow Variables / Assign Subflow Outputs entry mirrors it (logic form + the variable's uiType attributes). */
export function variableParameter(v: { sys_id: string; name: string; label: string; type: string; order: number; maxLength: number; reference?: string; uiUniqueId: string }): Record<string, unknown> {
  return logicParameter({
    sys_id: v.sys_id, name: v.name, label: v.label, type: v.type, order: v.order, maxLength: v.maxLength, reference: v.reference,
    attributes: { uiType: v.type, uiTypeLabel: typeLabelFor(v.type), element_mapping_provider: 'com.glide.flow_design.action.data.FlowDesignVariableMapper', uiUniqueId: v.uiUniqueId },
  });
}
