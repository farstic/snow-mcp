/**
 * Shared test context for the construct specs (tests/flow-builder/specs/_context.json): a dictionary
 * double for pill typing and the subflow / custom-action definitions an instance would resolve.
 * Every construct spec is used exactly as written.
 *
 * Owner: GENERATOR.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSpec } from '../../../src/flow-builder/spec/schema.js';
import { generatePlan, type DefinitionInfo, type DefinitionVariable, type GeneratorExtras } from '../../../src/flow-builder/generator/index.js';
import { sysIdFor } from '../../../src/flow-builder/ids.js';
import type { DefinitionRef, FlowSpec, GenerateOptions, RecordPlan } from '../../../src/flow-builder/spec/types.js';
import { SPECS_DIR, loadSpec } from './plans.js';

interface Ctx {
  dictionary: Record<string, string>;
  subflows: Record<string, Omit<DefinitionInfo, 'sys_id'>>;
  customActions: Record<string, Omit<DefinitionInfo, 'sys_id'>>;
}

export const CTX: Ctx = JSON.parse(readFileSync(join(SPECS_DIR, '_context.json'), 'utf8')) as Ctx;

/** The name the fake instance gives a context definition ('Example Subflow 606a47'): the same offline, so labels match row for row. */
export function contextDefinitionName(kind: 'subflow' | 'action', sysId: string): string {
  return `Example ${kind === 'subflow' ? 'Subflow' : 'Action'} ${sysId.slice(0, 6)}`;
}

/** The sys_id the fake instance gives a declared input / output of a context definition (deterministic: the offline doubles carry the same). */
export function contextVariableSysId(model: string, kind: 'input' | 'output', name: string): string {
  return sysIdFor(model, `${kind}:${name}`);
}

const withIds = (model: string, kind: 'input' | 'output', vars: DefinitionVariable[]): DefinitionVariable[] =>
  vars.map((v, i) => ({ ...v, sys_id: contextVariableSysId(model, kind, v.name), order: i + 1 }));

const byId = (m: Ctx['subflows'], kind: 'subflow' | 'action') => async (ref: DefinitionRef): Promise<DefinitionInfo | undefined> =>
  'sys_id' in ref && m[ref.sys_id]
    ? { sys_id: ref.sys_id, name: contextDefinitionName(kind, ref.sys_id), ...m[ref.sys_id], inputs: withIds(ref.sys_id, 'input', m[ref.sys_id].inputs), outputs: withIds(ref.sys_id, 'output', m[ref.sys_id].outputs) }
    : undefined;

/** Generator options backed by the context doubles. */
export function contextOptions(): GenerateOptions & GeneratorExtras {
  return {
    resolvePillType: async (table, path) => CTX.dictionary[`${table}.${path}`],
    resolveSubflow: byId(CTX.subflows, 'subflow'),
    resolveCustomAction: byId(CTX.customActions, 'action'),
  };
}

/** Parse a construct spec exactly as written. */
export function loadParsedSpec(name: string): FlowSpec {
  const parsed = parseSpec(loadSpec(name));
  if ('errors' in parsed) throw new Error(`spec ${name}: ${JSON.stringify(parsed.errors)}`);
  return parsed.spec;
}

export async function planFor(name: string, opts: GenerateOptions & GeneratorExtras = contextOptions()): Promise<RecordPlan> {
  return generatePlan(loadParsedSpec(name), opts);
}
