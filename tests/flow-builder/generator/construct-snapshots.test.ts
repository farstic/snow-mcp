/**
 * Snapshot tests of the generator's own output for every construct spec in tests/flow-builder/specs:
 * the decoded record plan and the <record_update> document are committed under
 * __snapshots__/constructs/ and any change to them fails the test (update deliberately with `vitest -u`
 * after reviewing the diff). They catch regressions only — the evidence that the format is the one
 * Flow Designer stores comes from pdi-conformance.test.ts (UI-built rows read on the PDI) and from the
 * live loader runs recorded in src/flow-builder/FORMAT-DECISIONS.md.
 *
 * The same specs are also generated through the REAL instance resolvers (src/flow-builder/resolvers.ts)
 * on an in-memory fake instance that holds the _context.json definitions: the plan must equal the offline
 * plan row for row, carry no warning, and the resolvers must only read.
 *
 * Owner: GENERATOR.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { planToRecordUpdateXml } from '../../../src/flow-builder/xml/record-update.js';
import { instanceResolvers, clearActionTypeCache } from '../../../src/flow-builder/resolvers.js';
import { generatePlan, type DefinitionVariable } from '../../../src/flow-builder/generator/index.js';
import { allActions, actionTypeIds } from '../../../src/flow-builder/catalog/actions.js';
import type { ServiceNowClient } from '../../../src/servicenow/client.js';
import { makeFakeClient, specInstanceTables, TEST_NOW, type Row } from '../writer/fake-client.js';
import { planRows, specNames } from './plans.js';
import { CTX, loadParsedSpec, planFor } from './context.js';

const SPECS = specNames();

beforeEach(() => { clearActionTypeCache(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(TEST_NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('construct specs: snapshots of the generated plan and <record_update>', () => {
  it('covers every trigger family, the core action groups, all flow logic, subflows and the error handler', () => {
    expect(SPECS.length).toBe(24);
  });

  for (const name of SPECS) {
    it(name, async () => {
      const plan = await planFor(name);
      expect(plan.warnings).toEqual([]);
      const decoded = { flowKey: plan.flowKey, rows: planRows(plan), pills: plan.pills };
      await expect(`${JSON.stringify(decoded, null, 2)}\n`).toMatchFileSnapshot(`__snapshots__/constructs/${name}.plan.json`);
      await expect(`${planToRecordUpdateXml(plan)}\n`).toMatchFileSnapshot(`__snapshots__/constructs/${name}.record_update.xml`);
    });
  }
});

// ─── the same specs through the instance resolvers ────────────────────────────

let seq = 0;
const rowId = () => (++seq).toString(16).padStart(32, '0');

function variableRows(model: string, vars: DefinitionVariable[]): Row[] {
  return vars.map((v, i) => ({
    sys_id: rowId(), model, element: v.name, label: v.label ?? v.name, internal_type: v.type,
    mandatory: v.mandatory ? 'true' : 'false', order: String(i + 1), default_value: v.default ?? '', reference: v.reference ?? '', attributes: '',
  }));
}

/** The fake instance: the _context.json definitions, one snapshot row per catalogue action, time zone and catalog item rows. */
function contextInstanceTables(): Record<string, Row[]> {
  const t: Record<string, Row[]> = {
    sys_hub_flow: [], sys_hub_flow_input: [], sys_hub_flow_output: [],
    sys_hub_action_type_definition: [], sys_hub_action_input: [], sys_hub_action_output: [], sys_hub_action_type_snapshot: [],
  };
  for (const [sysId, d] of Object.entries(CTX.subflows)) {
    t.sys_hub_flow.push({ sys_id: sysId, name: `Example Subflow ${sysId.slice(0, 6)}`, internal_name: `example_subflow_${sysId.slice(0, 6)}`, type: 'subflow', 'sys_scope.scope': 'global' });
    t.sys_hub_flow_input.push(...variableRows(sysId, d.inputs));
    t.sys_hub_flow_output.push(...variableRows(sysId, d.outputs));
  }
  for (const [sysId, d] of Object.entries(CTX.customActions)) {
    t.sys_hub_action_type_definition.push({ sys_id: sysId, name: `Example Action ${sysId.slice(0, 6)}`, internal_name: `example_action_${sysId.slice(0, 6)}`, 'sys_scope.scope': 'global' });
    t.sys_hub_action_input.push(...variableRows(sysId, d.inputs));
    t.sys_hub_action_output.push(...variableRows(sysId, d.outputs));
  }
  for (const a of allActions()) {
    const ids = actionTypeIds(a);
    t.sys_hub_action_type_snapshot.push({ sys_id: ids.snapshot, name: a.name, parent_action: ids.definition });
  }
  return { ...t, sys_user: [{ sys_id: 'u'.repeat(32), user_name: 'mcp.user' }], ...specInstanceTables() };
}

function livePlan(name: string) {
  const fake = makeFakeClient({ username: 'mcp.user', tables: contextInstanceTables() });
  const plan = generatePlan(loadParsedSpec(name), {
    ...instanceResolvers(fake.client as unknown as ServiceNowClient),
    resolvePillType: async (table, path) => CTX.dictionary[`${table}.${path}`],
  });
  return { fake, plan };
}

describe('construct specs through the instance resolvers (fake instance) equal the offline plan', () => {
  for (const name of SPECS) {
    it(name, async () => {
      const { fake, plan } = livePlan(name);
      const live = await plan;
      const offline = await planFor(name);
      expect(live.warnings).toEqual([]);
      expect(planRows(live)).toEqual(planRows(offline));
      // read-only: the resolvers never write
      expect(fake.state.calls.filter(c => c.method !== 'queryRecords' && c.method !== 'getRecord')).toEqual([]);
    });
  }

  it('the subflow / custom-action specs really resolved through the instance tables (not a fallback)', async () => {
    for (const [name, tables] of [['flow_options', ['sys_hub_flow_input', 'sys_hub_action_input']], ['incident_triage', ['sys_hub_flow_input']]] as const) {
      const { fake, plan } = livePlan(name);
      await plan;
      for (const t of tables) expect(fake.state.calls.some(c => c.table === t), `${name}: ${t}`).toBe(true);
      expect(fake.state.calls.some(c => c.table === 'sys_hub_action_type_snapshot'), name).toBe(true);
    }
  });
});
