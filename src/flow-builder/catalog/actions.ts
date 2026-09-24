/**
 * Action catalogue — the 33 core actions (catalog/load.ts): the sys_hub_action_type_snapshot the UI writes into
 * `action_type`, its sys_hub_action_type_definition (`parent_action`) that the UI writes into `action_type_parent`,
 * and the inputs / outputs of the snapshot (sys_hub_action_input / sys_hub_action_output) with their types,
 * defaults, hidden flags and choices.
 *
 * Every UI-built action row read on the instance stores the definition in action_type_parent (Log 0e0ae8c2…,
 * Create Catalog Task f597c410…, Send Notification 7eda5d71…, Wait For Condition 8bb9a816…; FORMAT-DECISIONS D6),
 * so the catalogue carries both ids for every action. With an instance, `resolveActionType`
 * (src/flow-builder/resolvers.ts: sys_hub_action_type_snapshot.parent_action) re-reads them.
 * Get Catalog Variables: the definition's latest_snapshot a30ba3ab… does not exist on the PDI; UI instances use
 * snapshot 330ba3abc31013002841b63b12d3aee8 (the catalogue id).
 *
 * Owner: GENERATOR.
 */
import { catalogData, type ActionDef, type CatalogInputRaw } from './load.js';

export type { ActionDef, CatalogInputRaw };

export function allActions(): ActionDef[] {
  return catalogData().actions;
}

/** Catalogue key → { snapshot the UI writes into action_type, definition it writes into action_type_parent }. */
export const ACTION_DEFINITIONS: Readonly<Record<string, { snapshot: string; definition: string }>> = Object.freeze(
  Object.fromEntries(allActions().map(a => [a.key, { snapshot: a.sys_id, definition: a.definition }])),
);

/** Find an action by catalogue key ('lookUpRecord'), internal name ('look_up_record'), display name ('Look Up Record') or sys_id; case-insensitive. */
export function findAction(nameOrKey: string): ActionDef | undefined {
  const n = nameOrKey.trim();
  const lc = n.toLowerCase();
  const compact = lc.replace(/[\s_]+/g, '');
  const squash = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '');
  return allActions().find(a =>
    a.key.toLowerCase() === lc || a.name.toLowerCase() === lc || a.internal_name === lc || a.sys_id === n || a.definition === n ||
    squash(a.key) === compact || squash(a.name) === compact || squash(a.internal_name) === compact
  );
}

/** Snapshot / definition ids for an action (catalogue values; the generator may override them per instance). */
export function actionTypeIds(a: ActionDef): { snapshot: string; definition: string } {
  return { snapshot: a.sys_id, definition: a.definition || a.sys_id };
}

/** Spec input name → stored input name (the catalogue stores the platform element names, so this is the identity). */
export function storedInputName(name: string): string {
  return name;
}

/**
 * The spec name of the `__snc_dont_fail_on_error` / `_snc_dont_fail_on_error` inputs: the element without its `_snc_`
 * prefix (a leading underscore is not a valid spec input name).
 */
export const DONT_FAIL_SPEC_NAME = 'dont_fail_on_error';

/**
 * Earlier FlowSpec name of the same inputs, still accepted so that existing specs keep generating the same rows
 * (the canonical name is DONT_FAIL_SPEC_NAME; both map to the stored element).
 */
export const DONT_FAIL_SPEC_ALIAS = 'dont_fail_flow_on_error';

/**
 * Every name a spec may use for an input: the stored element name, plus `dont_fail_on_error` (and its earlier alias
 * `dont_fail_flow_on_error`) for the `__snc_dont_fail_on_error` / `_snc_dont_fail_on_error` inputs.
 */
export function specInputNames(i: CatalogInputRaw): string[] {
  const names = [i.name];
  if (/^_+snc_dont_fail_on_error$/.test(i.name)) names.push(DONT_FAIL_SPEC_NAME, DONT_FAIL_SPEC_ALIAS);
  return names;
}

/** Reverse: a spec / stored name back to the catalogue input definition of the action. */
export function findActionInput(a: ActionDef, name: string): CatalogInputRaw | undefined {
  return a.inputs.find(i => specInputNames(i).includes(name));
}

/** Is this input hidden in Flow Designer (visible / visible_in_fd / visible_in_ui = false)? */
export function isHiddenInput(i: CatalogInputRaw): boolean {
  if (i.hidden) return true;
  const attrs = i.attributes ?? {};
  return String(attrs.visible) === 'false' || String(attrs.visible_in_fd) === 'false' || String(attrs.visible_in_ui) === 'false';
}

/**
 * Inputs the generator writes on every row of the action even when the spec does not set them: the inputs with a
 * default value (stored with that value), and the hidden inputs (their value comes from the flow — from_flow_inputs —
 * so they are stored with the value UI-built rows carry, or empty). UI-built rows store every input; this is the
 * subset that carries a value.
 */
export function isAlwaysStored(i: CatalogInputRaw): boolean {
  return (i.default !== undefined && i.default !== '') || isHiddenInput(i);
}
