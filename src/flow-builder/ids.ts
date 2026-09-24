/**
 * Deterministic sys_ids for flow-builder records.
 *
 * Every row the generator plans gets a sys_id derived from the flow key and the
 * element key, so a re-run of the same spec produces the same ids (idempotent
 * PATCH on mode:'update') and pills / ui_id / parent_ui_id / label_cache can
 * reference instance ids before any row exists on the instance.
 *
 * sysIdFor(flowKey, elementKey) = first 32 hex chars of sha256(`${flowKey}:${elementKey}`)
 * sysIdToUuid(sysId)            = the same hex in 8-4-4-4-12 layout (our ui_id; UI-built rows carry random
 *                                 UUIDs — any UUID-shaped string is accepted, see FORMAT-DECISIONS.md)
 *
 * Owner: SCAFFOLD (full implementation). Consumers: GENERATOR, WRITER.
 */
import { createHash } from 'node:crypto';

export const SYS_ID_RE = /^[0-9a-f]{32}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Well-known element keys for the rows every flow carries (kept here so GENERATOR and WRITER agree). */
export const ELEMENT_KEYS = {
  flow: 'flow',
  trigger: 'trigger',
  variable: (name: string) => `variable:${name}`,
  variableDoc: (name: string) => `variable_doc:${name}`,
  input: (name: string) => `input:${name}`,
  output: (name: string) => `output:${name}`,
  stage: (value: string) => `stage:${value}`,
  step: (key: string) => `step:${key}`,
  /** A branch that is itself a logic row (else / else_if / catch / parallel branch). */
  branch: (key: string) => `branch:${key}`,
  errorHandler: (key: string) => `error_handler:${key}`,
  aliasMapping: (stepKey: string) => `alias:${stepKey}`,
} as const;

export function isSysId(value: unknown): value is string {
  return typeof value === 'string' && SYS_ID_RE.test(value);
}

/**
 * Deterministic 32-hex sys_id for an element of a flow.
 * Both keys must be non-empty; the pair (flowKey, elementKey) must be unique inside a plan.
 */
export function sysIdFor(flowKey: string, elementKey: string): string {
  if (!flowKey) throw new Error('sysIdFor: flowKey is required');
  if (!elementKey) throw new Error('sysIdFor: elementKey is required');
  return createHash('sha256').update(`${flowKey}:${elementKey}`, 'utf8').digest('hex').slice(0, 32);
}

/** 32-hex sys_id → 8-4-4-4-12 uuid (the generator's `ui_id` derivation: deterministic, no version bits changed). */
export function sysIdToUuid(sysId: string): string {
  if (!isSysId(sysId)) throw new Error(`sysIdToUuid: not a 32-char lowercase hex sys_id: ${JSON.stringify(sysId)}`);
  return `${sysId.slice(0, 8)}-${sysId.slice(8, 12)}-${sysId.slice(12, 16)}-${sysId.slice(16, 20)}-${sysId.slice(20)}`;
}

/** uuid (8-4-4-4-12) → 32-hex sys_id. Inverse of sysIdToUuid. */
export function uuidToSysId(uuid: string): string {
  const lower = uuid.toLowerCase();
  if (!UUID_RE.test(lower)) throw new Error(`uuidToSysId: not a uuid: ${JSON.stringify(uuid)}`);
  return lower.replace(/-/g, '');
}
