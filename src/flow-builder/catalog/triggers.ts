/**
 * Trigger catalogue — the 13 platform trigger definitions (sys_hub_trigger_definition: sys_id, name, type;
 * inputs from sys_hub_trigger_input, outputs from sys_hub_trigger_output; catalog/load.ts). The catalogue
 * key IS the FlowSpec trigger type:
 *
 *   record.created / record.updated / record.created_or_updated   Created / Updated / Created or Updated
 *   scheduled.daily / weekly / monthly / repeat / run_once         Daily / Weekly / Monthly / Repeat / Run Once
 *   email.inbound                                                  Inbound Email
 *   catalog.service_catalog                                        Service Catalog
 *   sla.task                                                       SLA Task
 *   knowledge.management                                           Knowledge Management
 *   remote_table.query                                             Remote Table Query (spec field `table` → input `u_table`)
 *
 * `trigger_inputs` descriptors: Service Catalog, Daily, Repeat and Inbound Email use the entries captured from
 * UI-built trigger rows (catalog/ui-descriptors.ts). Every other trigger gets a descriptor built generically from
 * its input definitions (descriptorTemplate below): one entry per active input in catalogue order (definition order,
 * or for the record triggers the entry order UI-built rows store — manifest `input_order`), the definition's
 * label / type / mandatory / order / default, its choices as the choice list, and a parameter object carrying
 * type, name, label, the referenced table and its label, attributes and the dependent field.
 *
 * Owner: GENERATOR.
 */
import { catalogData, type CatalogInputRaw, type TriggerDef, type TriggerDescriptorEntry } from './load.js';

export type { TriggerDef, TriggerDescriptorEntry };

export function allTriggers(): TriggerDef[] {
  return catalogData().triggers;
}

/** Find a trigger by spec type (= key), definition name, trigger type or sys_id (case-insensitive on key/name). */
export function findTrigger(nameOrKey: string): TriggerDef | undefined {
  const n = nameOrKey.trim();
  const lc = n.toLowerCase();
  return allTriggers().find(t => t.key.toLowerCase() === lc || t.name.toLowerCase() === lc || t.sys_id === n || t.trigger_type === n);
}

/** Is this trigger one of the three record triggers (outputs `current`, primary input `table`)? */
export function isRecordTrigger(t: TriggerDef): boolean {
  return t.key.startsWith('record.');
}

/** One `trigger_inputs` entry built from an input definition (value = the definition default). */
function descriptorEntry(i: CatalogInputRaw): TriggerDescriptorEntry {
  const value = i.default === undefined ? '' : String(i.default);
  const parameter: Record<string, unknown> = { type: i.type, name: i.name, label: i.label };
  if (i.reference) {
    parameter.reference = i.reference;
    if (i.reference_display !== undefined) parameter.reference_display = i.reference_display;
  }
  if (i.attributes && Object.keys(i.attributes).length) parameter.attributes = { ...i.attributes };
  if (i.dependent) {
    parameter.dependent_on = i.dependent;
    parameter.use_dependent = Boolean(i.use_dependent);
  }
  const entry: TriggerDescriptorEntry = {
    triggerInstanceSysId: '',
    label: i.label,
    internalType: i.type,
    dependent: '',
    choiceList: (i.choices ?? []).map(c => ({ fValue: c.value, fLabel: c.label, fImage: '', fSelected: false, fUsed: false, fMissing: false })),
    mandatory: Boolean(i.mandatory),
    order: i.order ?? 100,
    name: i.name,
    value,
    displayValue: value,
    displayField: '',
    scriptActive: false,
    children: [],
    parameter,
  };
  if (i.type === 'glide_list' || i.type === 'reference') {
    // list / reference inputs also carry the selected record's sys_id; keep children and parameter last
    const { children, parameter: p, ...head } = entry;
    return { ...head, valueSysId: '', children, parameter: p };
  }
  return entry;
}

/** A fresh descriptor for the trigger: one entry per input definition, values reset to the definition defaults. */
export function descriptorTemplate(t: TriggerDef): TriggerDescriptorEntry[] {
  return t.inputs.map(descriptorEntry);
}

/** Output definition of a trigger by name. */
export function triggerOutput(t: TriggerDef, name: string) {
  return t.outputs.find(o => o.name === name);
}

/** Weekday names in the platform's day_of_week order (1 = Monday). */
export const DAY_OF_WEEK_LABELS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
