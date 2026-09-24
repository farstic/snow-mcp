/**
 * Flow-logic catalogue — the platform logic definitions (sys_hub_flow_logic_definition, with their inputs from
 * sys_hub_flow_logic_input and static outputs from sys_hub_flow_logic_variable; catalog/load.ts). The catalogue key
 * IS the FlowSpec step kind ('if', 'else_if', 'for_each', 'wait', 'parallel_block', …); the two top-level Flow Error
 * Handler definitions are 'error_handler.try' / 'error_handler.catch' (catalog/error-handler.ts).
 *
 * Every UI-built logic row stores its values object in one key order (logicValuesKeyOrder):
 *   outputsToAssign, inputs, variables, decisionTableInputs, dynamicInputs, workflowInputs
 *
 * Owner: GENERATOR.
 */
import { catalogData, type LogicDef } from './load.js';
import { TOP_LEVEL_TRY_SYS_ID, TOP_LEVEL_CATCH_SYS_ID } from './error-handler.js';

export type { LogicDef };

/** Spec step kind (or branch role) → catalogue logic key (identical). */
export const LOGIC_KEY_BY_KIND: Record<string, string> = Object.fromEntries(
  ['if', 'else_if', 'else', 'for_each', 'end_flow', 'exit_loop', 'skip_iteration', 'set_variables', 'append_variables',
    'assign_subflow_outputs', 'wait', 'try', 'catch', 'do_in_parallel', 'parallel_block', 'do_until'].map(k => [k, k]),
);

export function allLogic(): LogicDef[] {
  return catalogData().logic;
}

export function findLogic(nameOrKey: string): LogicDef | undefined {
  const n = nameOrKey.trim();
  const lc = n.toLowerCase();
  return allLogic().find(l => l.key.toLowerCase() === lc || l.name.toLowerCase() === lc || l.sys_id === n || l.type.toLowerCase() === lc);
}

export function logicSysId(kindOrKey: string): string {
  const def = findLogic(kindOrKey);
  if (!def) throw new Error(`flow-builder catalogue: unknown logic "${kindOrKey}"`);
  return def.sys_id;
}

export const TOP_LEVEL_TRY = TOP_LEVEL_TRY_SYS_ID;
export const TOP_LEVEL_CATCH = TOP_LEVEL_CATCH_SYS_ID;

/** Key order for the values object of a logic row (the same for every logic type). */
export function valuesKeyOrder(_logicKey?: string): readonly string[] {
  return catalogData().logicValuesKeyOrder;
}

function logicDef(key: string): LogicDef {
  const def = findLogic(key);
  if (!def) throw new Error(`flow-builder catalogue: unknown logic "${key}"`);
  return def;
}

/** Wait for a duration of time — its input definitions (sys_hub_flow_logic_input ids), in stored order. */
export const TIMER_INPUTS: { id: string; name: string; glideDuration?: boolean }[] = logicDef('wait').inputs.map(i => ({
  id: i.id,
  name: i.name,
  ...(i.type === 'glide_duration' ? { glideDuration: true } : {}),
}));

/** Spec duration_type → the platform choice (value + its label, stored as the display value). */
export const TIMER_DURATION_TYPES: Record<string, { value: string; display: string }> = Object.fromEntries(
  (logicDef('wait').inputs.find(i => i.name === 'duration_type')?.choices ?? [])
    .map(c => [c.value.replace(/_duration$/, ''), { value: c.value, display: c.label }]),
);

/** Outputs a Wait for a duration of time row exposes as pills (sys_hub_flow_logic_variable). */
export const TIMER_OUTPUTS: Record<string, string> = Object.fromEntries(logicDef('wait').outputs.map(o => [o.name, o.type]));
