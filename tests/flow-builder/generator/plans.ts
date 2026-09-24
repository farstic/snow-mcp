/**
 * Shared helpers for the generator tests: the construct specs under tests/flow-builder/specs and a
 * decoded view of a RecordPlan (values / trigger_inputs / subflow_inputs gunzipped, label_cache /
 * states JSON-parsed) for snapshots and field comparisons.
 *
 * Owner: GENERATOR.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeValues } from '../../../src/flow-builder/encode.js';
import type { RecordPlan, RecordRow } from '../../../src/flow-builder/spec/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SPECS_DIR = join(HERE, '..', 'specs');
export const PDI_DIR = join(HERE, '..', 'fixtures', 'pdi');

/** Every construct spec in tests/flow-builder/specs (file name without .json; `_context.json` excluded). */
export function specNames(): string[] {
  return readdirSync(SPECS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_')).map(f => f.slice(0, -5)).sort();
}

export function loadSpec(name: string): unknown {
  return JSON.parse(readFileSync(join(SPECS_DIR, `${name}.json`), 'utf8'));
}

/** A PDI fixture file (tests/flow-builder/fixtures/pdi/<path>), parsed. */
export function readPdi(path: string): unknown {
  return JSON.parse(readFileSync(join(PDI_DIR, path), 'utf8'));
}

/** The rows of a PDI fixture file, whether it is a bare array, `{rows:[…]}` or a single row. */
export function pdiRows(path: string): Record<string, unknown>[] {
  const v = readPdi(path);
  return (Array.isArray(v) ? v : Array.isArray((v as { rows?: unknown[] }).rows) ? (v as { rows: unknown[] }).rows : [v]) as Record<string, unknown>[];
}

export interface DRow { table: string; sys_id: string; fields: Record<string, unknown> }

const GZIP_FIELDS = new Set(['values', 'trigger_inputs', 'subflow_inputs']);
const JSON_FIELDS = new Set(['label_cache', 'states']);

export function decodeRow(r: RecordRow): DRow {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r.fields)) {
    if (GZIP_FIELDS.has(k) && typeof v === 'string' && v !== '') fields[k] = decodeValues(v);
    else if (JSON_FIELDS.has(k) && typeof v === 'string' && v !== '') fields[k] = JSON.parse(v);
    else fields[k] = v;
  }
  return { table: r.table, sys_id: r.sys_id, fields };
}

/** Every data row of a plan, decoded, in plan order (flow, variables, documentation, stages, trigger, instances). */
export function planRows(plan: RecordPlan): DRow[] {
  const rows: RecordRow[] = [plan.flow, ...plan.variables, ...plan.documentation, ...plan.stages];
  if (plan.trigger) rows.push(plan.trigger);
  rows.push(...plan.instances);
  return rows.map(decodeRow);
}
