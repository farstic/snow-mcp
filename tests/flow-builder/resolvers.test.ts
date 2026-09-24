/**
 * Instance resolvers (src/flow-builder/resolvers.ts) on the in-memory fake client, and their effect on
 * generatePlan: subflow / custom-action definitions (hit, miss, ambiguity, not-a-subflow, memo, typed
 * inputs / outputs, mandatory inputs) and the per-instance action-type snapshot (hit, definition
 * latest_snapshot, catalogue fallback, cache per instance per process, failed reads not cached).
 * Read-only by construction: every test asserts that no write method was called.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeClient, type Row } from './writer/fake-client.js';
import {
  makeSubflowResolver, makeCustomActionResolver, makeActionTypeResolver, clearActionTypeCache, instanceResolvers, fieldValue,
  isHiddenByAttributes, coreInternalName, makeInstanceTimeZoneResolver, makeCatalogVariablesResolver, DEFAULT_TZ_PROPERTY,
} from '../../src/flow-builder/resolvers.js';
import { generatePlan, type DefinitionInfo, type DefinitionError } from '../../src/flow-builder/generator/index.js';
import { parseSpec } from '../../src/flow-builder/spec/schema.js';
import { actionTypeIds, findAction, storedInputName } from '../../src/flow-builder/catalog/actions.js';
import { decodeValues } from '../../src/flow-builder/encode.js';
import { ServiceNowError } from '../../src/utils/errors.js';
import type { FlowSpec, RecordPlan } from '../../src/flow-builder/spec/types.js';
import type { ServiceNowClient } from '../../src/servicenow/client.js';

const SUB = '5ab0000000000000000000000000000a';
const SUB_OTHER = '5ab0000000000000000000000000000b';
const SUB_SCOPED = '5ab0000000000000000000000000000c';
const FLOW = 'f10000000000000000000000000000aa';
const ACT = 'ac70000000000000000000000000000a';
const ACT_DUP = 'ac70000000000000000000000000000b';

/** A subflow "Notify Owner" (inputs out of order on purpose), a flow, a same-named pair, a scoped twin, a custom action. */
function tables(): Record<string, Row[]> {
  return {
    sys_hub_flow: [
      { sys_id: SUB, name: 'Notify Owner', internal_name: 'notify_owner', type: 'subflow', 'sys_scope.scope': 'global' },
      { sys_id: FLOW, name: 'Some Flow', internal_name: 'some_flow', type: 'flow', 'sys_scope.scope': 'global' },
      { sys_id: SUB_OTHER, name: 'Escalate', internal_name: 'escalate', type: 'subflow', 'sys_scope.scope': 'global' },
      { sys_id: SUB_SCOPED, name: 'Escalate', internal_name: 'escalate', type: 'subflow', 'sys_scope.scope': 'x_example_app' },
    ],
    sys_hub_flow_input: [
      { sys_id: '1'.repeat(32), model: SUB, element: 'severity', label: 'Severity', internal_type: 'integer', mandatory: 'false', order: '3', default_value: '3', reference: '' },
      { sys_id: '2'.repeat(32), model: SUB, element: 'owner', label: 'Owner', internal_type: 'reference', mandatory: 'true', order: '1', default_value: '', reference: 'sys_user' },
      { sys_id: '3'.repeat(32), model: SUB, element: 'message', label: 'Message', internal_type: 'string', mandatory: 'false', order: '2', default_value: '', reference: '' },
      { sys_id: '4'.repeat(32), model: SUB_OTHER, element: 'note', label: 'Note', internal_type: '', mandatory: 'false', order: '1', default_value: '', reference: '' },
    ],
    sys_hub_flow_output: [
      { sys_id: '5'.repeat(32), model: SUB, element: 'ok', label: 'Ok', internal_type: 'boolean', mandatory: 'false', order: '1', default_value: '', reference: '' },
      { sys_id: '6'.repeat(32), model: SUB, element: 'ticket', label: 'Ticket', internal_type: 'reference', mandatory: 'false', order: '2', default_value: '', reference: 'incident' },
    ],
    sys_hub_action_type_definition: [
      { sys_id: ACT, name: 'Example Escalate', internal_name: 'example_escalate', 'sys_scope.scope': 'x_example_app' },
      { sys_id: ACT_DUP, name: 'Example Dup', internal_name: 'example_dup_a', 'sys_scope.scope': 'x_example_app' },
      { sys_id: 'ac70000000000000000000000000000c', name: 'Example Dup', internal_name: 'example_dup_b', 'sys_scope.scope': 'x_example_app' },
    ],
    sys_hub_action_input: [
      { sys_id: '7'.repeat(32), model: ACT, element: 'record', label: 'Record', internal_type: 'reference', mandatory: 'true', order: '1', default_value: '', reference: 'incident' },
      { sys_id: '8'.repeat(32), model: ACT, element: 'notify', label: 'Notify', internal_type: 'boolean', mandatory: 'false', order: '2', default_value: '', reference: '' },
    ],
    sys_hub_action_output: [
      { sys_id: '9'.repeat(32), model: ACT, element: 'escalated', label: 'Escalated', internal_type: 'boolean', mandatory: 'false', order: '1', default_value: '', reference: '' },
    ],
  };
}

function fake(extra: Record<string, Row[]> = {}) {
  return makeFakeClient({ username: 'flow.builder.test', tables: { ...tables(), ...extra } });
}
type Fake = ReturnType<typeof fake>;
/** sys_hub_action_input rows (only the element names matter) for a definition. */
function inputRowsFor(model: string, elements: string[], extra: Partial<Row> = {}): Row[] {
  return elements.map((element, i) => ({ sys_id: `${model.slice(0, 24)}${String(i).padStart(8, '0')}`, model, element, label: element, internal_type: 'string', mandatory: 'false', order: String(i + 1), default_value: '', reference: '', ...extra }));
}
const asClient = (f: Fake) => f.client as unknown as ServiceNowClient;
const writes = (f: Fake) => f.state.calls.filter(c => c.method !== 'queryRecords' && c.method !== 'getRecord');
const isError = (r: DefinitionInfo | DefinitionError): r is DefinitionError => 'error' in r;

beforeEach(() => clearActionTypeCache());

describe('fieldValue', () => {
  it('reads plain values and {value, display_value} objects', () => {
    expect(fieldValue('x')).toBe('x');
    expect(fieldValue({ value: 'abc', display_value: 'Abc' })).toBe('abc');
    expect(fieldValue(null)).toBe('');
    expect(fieldValue(undefined)).toBe('');
  });
});

// ─── subflows ─────────────────────────────────────────────────────────────────

describe('resolveSubflow', () => {
  it('hit by sys_id: sys_id, name and declared inputs / outputs in definition order with internal types, mandatory, default and reference', async () => {
    const f = fake();
    const r = await makeSubflowResolver(asClient(f))({ sys_id: SUB });
    if (isError(r)) throw new Error(r.error);
    expect(r.sys_id).toBe(SUB);
    expect(r.name).toBe('Notify Owner');
    expect(r.inputs).toEqual([
      { name: 'owner', type: 'reference', sys_id: '2'.repeat(32), label: 'Owner', reference: 'sys_user', mandatory: true, order: 1 },
      { name: 'message', type: 'string', sys_id: '3'.repeat(32), label: 'Message', order: 2 },
      { name: 'severity', type: 'integer', sys_id: '1'.repeat(32), label: 'Severity', order: 3, default: '3' },
    ]);
    expect(r.outputs.map(o => [o.name, o.type, o.reference])).toEqual([['ok', 'boolean', undefined], ['ticket', 'reference', 'incident']]);
    expect(r.warnings).toBeUndefined();
    expect(f.state.calls.map(c => `${c.table}?${c.query}`)).toEqual([
      `sys_hub_flow?sys_id=${SUB}`, `sys_hub_flow_input?model=${SUB}`, `sys_hub_flow_output?model=${SUB}`,
    ]);
    expect(writes(f)).toEqual([]);
  });

  it('hit by name and by internal_name (type=subflow on both queries)', async () => {
    const f = fake();
    const byName = await makeSubflowResolver(asClient(f))({ name: 'Notify Owner' });
    const byInternal = await makeSubflowResolver(asClient(f))({ name: 'notify_owner' });
    expect(isError(byName) ? byName.error : byName.sys_id).toBe(SUB);
    expect(isError(byInternal) ? byInternal.error : byInternal.sys_id).toBe(SUB);
    const defQueries = f.state.calls.filter(c => c.table === 'sys_hub_flow').map(c => c.query);
    expect(defQueries).toContain('type=subflow^name=Notify Owner');
    expect(defQueries).toContain('type=subflow^internal_name=notify_owner');
    expect(defQueries.every(q => q?.startsWith('type=subflow^'))).toBe(true);
  });

  it('miss by sys_id and by name → a clear error naming the table', async () => {
    const f = fake();
    const r1 = await makeSubflowResolver(asClient(f))({ sys_id: 'e'.repeat(32) });
    const r2 = await makeSubflowResolver(asClient(f))({ name: 'No Such Subflow' });
    expect(isError(r1) && r1.error).toMatch(/subflow e{32} was not found on the instance \(sys_hub_flow\)/);
    expect(isError(r2) && r2.error).toMatch(/subflow "No Such Subflow" was not found on the instance \(sys_hub_flow type=subflow, by name or internal_name\)/);
  });

  it('a flow (not a subflow) referenced by sys_id is an error', async () => {
    const r = await makeSubflowResolver(asClient(fake()))({ sys_id: FLOW });
    expect(isError(r) && r.error).toMatch(/is a flow, not a subflow/);
  });

  it('ambiguous name → an error listing every match; a scope narrows it to one', async () => {
    const f = fake();
    const amb = await makeSubflowResolver(asClient(f))({ name: 'Escalate' });
    expect(isError(amb)).toBe(true);
    const msg = (amb as DefinitionError).error;
    expect(msg).toMatch(/is ambiguous — 2 match/);
    expect(msg).toContain(SUB_OTHER);
    expect(msg).toContain(SUB_SCOPED);
    expect(msg).toMatch(/reference it by \{sys_id\} or add scope/);

    const scoped = await makeSubflowResolver(asClient(f))({ name: 'Escalate', scope: 'x_example_app' });
    expect(isError(scoped) ? scoped.error : scoped.sys_id).toBe(SUB_SCOPED);
    expect(f.state.calls.some(c => c.query === 'type=subflow^name=Escalate^sys_scope.scope=x_example_app')).toBe(true);
  });

  it('an input row without internal_type is typed string with a warning', async () => {
    const r = await makeSubflowResolver(asClient(fake()))({ sys_id: SUB_OTHER });
    if (isError(r)) throw new Error(r.error);
    expect(r.inputs[0]).toMatchObject({ name: 'note', type: 'string' });
    expect(r.warnings?.[0]).toMatch(/subflow input "note" .* has no internal_type — typed as string/);
  });

  it('a name that would change the encoded query is refused without any read', async () => {
    const f = fake();
    for (const name of ['a^ORname=b', 'line\nbreak', 'javascript:gs.getUserID()']) {
      const r = await makeSubflowResolver(asClient(f))({ name });
      expect(isError(r) && r.error).toMatch(/cannot be looked up/);
    }
    const r = await makeSubflowResolver(asClient(f))({ name: 'Escalate', scope: 'x^y' });
    expect(isError(r)).toBe(true);
    expect(f.state.calls).toEqual([]);
  });

  it('one resolver instance memoises per reference (one read set per generation)', async () => {
    const f = fake();
    const resolve = makeSubflowResolver(asClient(f));
    await resolve({ sys_id: SUB });
    await resolve({ sys_id: SUB });
    expect(f.state.calls).toHaveLength(3);
  });
});

// ─── custom actions ───────────────────────────────────────────────────────────

describe('resolveCustomAction', () => {
  it('hit by sys_id and by name: real input internal types from sys_hub_action_input', async () => {
    const f = fake();
    for (const ref of [{ sys_id: ACT }, { name: 'Example Escalate' }, { name: 'example_escalate', scope: 'x_example_app' }]) {
      const r = await makeCustomActionResolver(asClient(f))(ref);
      if (isError(r)) throw new Error(r.error);
      expect(r.sys_id).toBe(ACT);
      expect(r.inputs.map(i => [i.name, i.type, i.mandatory ?? false])).toEqual([['record', 'reference', true], ['notify', 'boolean', false]]);
      expect(r.outputs.map(o => [o.name, o.type])).toEqual([['escalated', 'boolean']]);
    }
    expect(f.state.calls.some(c => c.table === 'sys_hub_action_input' && c.query === `model=${ACT}`)).toBe(true);
    expect(f.state.calls.some(c => c.table === 'sys_hub_action_type_definition' && c.query === 'name=Example Escalate')).toBe(true);
    expect(writes(f)).toEqual([]);
  });

  it('miss and ambiguity are errors', async () => {
    const f = fake();
    const miss = await makeCustomActionResolver(asClient(f))({ sys_id: 'd'.repeat(32) });
    expect(isError(miss) && miss.error).toMatch(/custom action d{32} was not found on the instance \(sys_hub_action_type_definition\)/);
    const amb = await makeCustomActionResolver(asClient(f))({ name: 'Example Dup' });
    expect(isError(amb) && amb.error).toMatch(/custom action "Example Dup" is ambiguous — 2 match/);
  });
});

// ─── action types ─────────────────────────────────────────────────────────────

const LOG = findAction('log')!;
const LOG_IDS = actionTypeIds(LOG);
const logRef = { key: LOG.key, name: LOG.name, ...LOG_IDS };
/**
 * A reference that carries no known definition — the same id in both columns (what a caller passes when it only
 * knows the snapshot). Every catalogue action has its definition today; the resolver still handles this form.
 */
const UNLINKED = findAction('sendEmail')!;
const unlinkedRef = { key: UNLINKED.key, name: UNLINKED.name, snapshot: actionTypeIds(UNLINKED).snapshot, definition: actionTypeIds(UNLINKED).snapshot };

describe('resolveActionType', () => {
  it('hit: the catalogue snapshot exists → the catalogue ids, no warning', async () => {
    const f = fake({ sys_hub_action_type_snapshot: [{ sys_id: LOG_IDS.snapshot, name: 'Log', parent_action: LOG_IDS.definition }] });
    const r = await makeActionTypeResolver(asClient(f))(logRef);
    expect(r).toEqual({ snapshot: LOG_IDS.snapshot, definition: LOG_IDS.definition, source: 'instance' });
    expect(f.state.calls.map(c => `${c.table}?${c.query}`)).toEqual([`sys_hub_action_type_snapshot?sys_id=${LOG_IDS.snapshot}`]);
    expect(writes(f)).toEqual([]);
  });

  it('hit on a reference without a definition: parent_action supplies it (no warning)', async () => {
    expect(unlinkedRef.snapshot).toBe(unlinkedRef.definition);
    const def = 'de0000000000000000000000000000ff';
    const f = fake({ sys_hub_action_type_snapshot: [{ sys_id: unlinkedRef.snapshot, name: UNLINKED.name, parent_action: def }] });
    const r = await makeActionTypeResolver(asClient(f))(unlinkedRef);
    expect(r).toEqual({ snapshot: unlinkedRef.snapshot, definition: def, source: 'instance' });
  });

  it('hit with a different parent / name than the PDI-verified catalogue → instance value + warnings', async () => {
    const other = 'de0000000000000000000000000000ee';
    const f = fake({ sys_hub_action_type_snapshot: [{ sys_id: LOG_IDS.snapshot, name: 'Log (renamed)', parent_action: other }] });
    const r = await makeActionTypeResolver(asClient(f))(logRef);
    expect(r.definition).toBe(other);
    expect(r.warnings?.join('\n')).toMatch(/is named "Log \(renamed\)" on the instance/);
    expect(r.warnings?.join('\n')).toMatch(new RegExp(`belongs to definition ${other} on the instance, not the catalogue's ${LOG_IDS.definition}`));
  });

  it('catalogue snapshot missing → the definition\'s existing latest_snapshot + warning', async () => {
    const latest = '1a70000000000000000000000000000f';
    const f = fake({
      sys_hub_action_type_snapshot: [{ sys_id: latest, name: 'Log', parent_action: LOG_IDS.definition }],
      sys_hub_action_type_definition: [{ sys_id: LOG_IDS.definition, name: 'Log', latest_snapshot: latest }],
    });
    const r = await makeActionTypeResolver(asClient(f))(logRef);
    expect(r).toMatchObject({ snapshot: latest, definition: LOG_IDS.definition, source: 'definition_latest_snapshot' });
    expect(r.warnings?.[0]).toMatch(new RegExp(`catalogue snapshot ${LOG_IDS.snapshot} does not exist on the instance — using definition ${LOG_IDS.definition}'s latest_snapshot ${latest}`));
  });

  it('reference without a definition whose snapshot is missing: the CORE definition is found by name (global scope + name + internal_name + inputs cover the catalogue) and the warning says so', async () => {
    const def = 'de0000000000000000000000000000dd';
    const latest = '1a7000000000000000000000000000dd';
    const f = fake({
      sys_hub_action_type_snapshot: [{ sys_id: latest, name: UNLINKED.name, parent_action: def }],
      sys_hub_action_type_definition: [{ sys_id: def, name: UNLINKED.name, internal_name: coreInternalName(UNLINKED.name), sys_scope: 'global', latest_snapshot: latest }],
      sys_hub_action_input: inputRowsFor(def, UNLINKED.inputs.map(i => storedInputName(i.name))),
    });
    const r = await makeActionTypeResolver(asClient(f))(unlinkedRef);
    expect(r).toMatchObject({ snapshot: latest, definition: def, source: 'definition_latest_snapshot' });
    expect(f.state.calls.some(c => c.table === 'sys_hub_action_type_definition'
      && c.query === `sys_scope=global^name=${UNLINKED.name}^internal_name=${coreInternalName(UNLINKED.name)}`)).toBe(true);
    expect(f.state.calls.some(c => c.table === 'sys_hub_action_input' && c.query === `model=${def}`)).toBe(true);
    expect(r.warnings?.join('\n')).toMatch(/MATCHED BY NAME \(global scope, name ".*", internal_name [a-z0-9_]+, inputs cover the catalogue's; not the catalogue definition id\)/);
    expect(writes(f)).toEqual([]);
  });

  it('coreInternalName: the snake case a core definition carries', () => {
    expect(coreInternalName('Send SMS')).toBe('send_sms');
    expect(coreInternalName('Create or Update Record')).toBe('create_or_update_record');
    expect(coreInternalName('Look Up Email Attachments')).toBe('look_up_email_attachments');
  });

  describe('name fallback never binds a non-core definition (catalogue snapshot missing)', () => {
    const SMS = findAction('sendSms')!;
    const smsRef = { key: SMS.key, name: SMS.name, ...actionTypeIds(SMS) };
    const SCOPED = 'de00000000000000000000000000005c';
    const scopedLatest = '1a70000000000000000000000000005c';
    /** A same-named action in x_example_app with the same inputs and an existing latest_snapshot: the trap. */
    const scopedTwin = (): Record<string, Row[]> => ({
      sys_hub_action_type_snapshot: [{ sys_id: scopedLatest, name: SMS.name, parent_action: SCOPED }],
      sys_hub_action_type_definition: [{ sys_id: SCOPED, name: SMS.name, internal_name: coreInternalName(SMS.name), sys_scope: 'b'.repeat(32), 'sys_scope.scope': 'x_example_app', latest_snapshot: scopedLatest }],
      sys_hub_action_input: inputRowsFor(SCOPED, ['recipients', 'message']),
    });
    const asGlobal = (t: Record<string, Row[]>): Record<string, Row[]> => ({
      ...t, sys_hub_action_type_definition: t.sys_hub_action_type_definition.map(d => ({ ...d, sys_scope: 'global', 'sys_scope.scope': 'global' })),
    });

    it('only a same-named scoped action (x_example_app) exists → it is NOT picked: catalogue ids kept', async () => {
      // the catalogue definition is not on this instance either (step 2 reads it by id), so the name lookup runs
      const f = fake(scopedTwin());
      const r = await makeActionTypeResolver(asClient(f))(smsRef);
      expect(r).toMatchObject({ snapshot: smsRef.snapshot, definition: smsRef.definition, source: 'catalogue' });
      expect(r.snapshot).not.toBe(scopedLatest);
      expect(r.definition).not.toBe(SCOPED);
      expect(r.warnings?.join('\n')).toMatch(/no unique core definition found — the catalogue ids are kept/);
      expect(f.state.calls.some(c => c.table === 'sys_hub_action_input')).toBe(false); // the scoped row is never considered
      expect(writes(f)).toEqual([]);
    });

    it('the same trap through generatePlan: action_type / action_type_parent stay the catalogue ids', async () => {
      const s = spec({
        spec_version: '1', flow: { key: 'sms_flow', name: 'SMS' }, trigger: { key: 't', type: 'record.created', table: 'incident' },
        steps: [{ kind: 'action', key: 'sms', action: 'sendSms', inputs: { recipients: '+10000000000', message: 'hi' } }],
      });
      const plan = await generatePlan(s, instanceResolvers(asClient(fake(scopedTwin()))));
      expect(plan.instances[0].fields).toMatchObject({ action_type: smsRef.snapshot, action_type_parent: smsRef.definition });
    });

    it('a global same-named definition with another internal_name (the PDI send_sms_notify case) is not picked', async () => {
      const t = asGlobal(scopedTwin());
      t.sys_hub_action_type_definition[0].internal_name = 'send_sms_notify';
      const r = await makeActionTypeResolver(asClient(fake(t)))(smsRef);
      expect(r.source).toBe('catalogue');
    });

    it('a global core-named definition whose inputs do not cover the catalogue inputs is not picked (the warning names them)', async () => {
      const t = asGlobal(scopedTwin());
      t.sys_hub_action_input = inputRowsFor(SCOPED, ['message', 'priority']);
      const r = await makeActionTypeResolver(asClient(fake(t)))(smsRef);
      expect(r.source).toBe('catalogue');
      expect(r.warnings?.join('\n')).toContain(`global definition ${SCOPED} "Send SMS" (internal_name send_sms) matched by name but does not declare the catalogue input(s) recipients — not used`);
    });

    it('two global core-named definitions → none is used', async () => {
      const t = asGlobal(scopedTwin());
      t.sys_hub_action_type_definition.push({ ...t.sys_hub_action_type_definition[0], sys_id: 'de00000000000000000000000000005d' });
      const r = await makeActionTypeResolver(asClient(fake(t)))(smsRef);
      expect(r.source).toBe('catalogue');
      expect(r.warnings?.join('\n')).toMatch(/more than one global definition is named "Send SMS"/);
    });

    it('control: the global CORE definition with covering inputs is used, and the warning says it was matched by name', async () => {
      const r = await makeActionTypeResolver(asClient(fake(asGlobal(scopedTwin()))))(smsRef);
      expect(r).toMatchObject({ snapshot: scopedLatest, definition: SCOPED, source: 'definition_latest_snapshot' });
      expect(r.warnings?.join('\n')).toMatch(/MATCHED BY NAME/);
    });
  });

  it('the latest_snapshot row does not exist (the PDI Get Catalog Variables case) → catalogue ids + warning', async () => {
    const f = fake({ sys_hub_action_type_definition: [{ sys_id: LOG_IDS.definition, name: 'Log', latest_snapshot: '1a7000000000000000000000000000ab' }] });
    const r = await makeActionTypeResolver(asClient(f))(logRef);
    expect(r).toMatchObject({ snapshot: LOG_IDS.snapshot, definition: LOG_IDS.definition, source: 'catalogue' });
    expect(r.warnings?.[0]).toMatch(/has no existing latest_snapshot — the catalogue ids are kept/);
  });

  it('nothing on the instance (offline-like) → catalogue ids + warning', async () => {
    const r = await makeActionTypeResolver(asClient(fake()))(logRef);
    expect(r).toMatchObject({ snapshot: LOG_IDS.snapshot, definition: LOG_IDS.definition, source: 'catalogue' });
    expect(r.warnings?.[0]).toMatch(/no sys_hub_action_type_snapshot row .* the catalogue ids are kept/);
  });

  it('cache: per instance (client) per process — a second resolver on the same client reads nothing; another client reads again; clearActionTypeCache resets', async () => {
    const rows = { sys_hub_action_type_snapshot: [{ sys_id: LOG_IDS.snapshot, name: 'Log', parent_action: LOG_IDS.definition }] };
    const a = fake(rows);
    const b = fake(rows);
    await makeActionTypeResolver(asClient(a))(logRef);
    const again = await makeActionTypeResolver(asClient(a))(logRef);
    expect(again.snapshot).toBe(LOG_IDS.snapshot);
    expect(a.state.calls).toHaveLength(1);
    await makeActionTypeResolver(asClient(b))(logRef);
    expect(b.state.calls).toHaveLength(1);
    clearActionTypeCache();
    await makeActionTypeResolver(asClient(a))(logRef);
    expect(a.state.calls).toHaveLength(2);
  });

  it('a failing read → catalogue ids + warning, and it is NOT cached', async () => {
    const f = fake({ sys_hub_action_type_snapshot: [{ sys_id: LOG_IDS.snapshot, name: 'Log', parent_action: LOG_IDS.definition }] });
    f.fns.queryRecords.mockImplementationOnce(async () => { throw new ServiceNowError('ACL refused', 'INSUFFICIENT_PRIVILEGES'); });
    const first = await makeActionTypeResolver(asClient(f))(logRef);
    expect(first).toMatchObject({ snapshot: LOG_IDS.snapshot, definition: LOG_IDS.definition, source: 'catalogue' });
    expect(first.warnings?.[0]).toMatch(/could not be read on the instance \(ACL refused\)/);
    // the next resolution reads again (the failure was not cached) and now finds the snapshot
    const second = await makeActionTypeResolver(asClient(f))(logRef);
    expect(second).toEqual({ snapshot: LOG_IDS.snapshot, definition: LOG_IDS.definition, source: 'instance' });
  });
});

// ─── generatePlan with the instance resolvers ────────────────────────────────

function spec(input: unknown): FlowSpec {
  const r = parseSpec(input);
  if ('errors' in r) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}
const SUBFLOW_CALLER = (subflow: object, inputs: Record<string, unknown>) => spec({
  spec_version: '1',
  flow: { key: 'caller', name: 'Caller' },
  trigger: { key: 't', type: 'record.created', table: 'incident' },
  steps: [
    { kind: 'subflow', key: 'notify', subflow, inputs },
    { kind: 'action', key: 'log', action: 'log', inputs: { log_level: 'info', log_message: { text: 'ok={{steps.notify.ok}}' } } },
  ],
});
const decoded = (plan: RecordPlan, table: string, field: string) => decodeValues(String(plan.instances.find(r => r.table === table)!.fields[field])) as Record<string, unknown>[];
async function semanticErrors(p: Promise<unknown>): Promise<string[]> {
  try { await p; } catch (e) {
    if (e instanceof ServiceNowError && e.code === 'FLOW_BUILDER_INVALID_SPEC') return (e.details as { errors: string[] }).errors;
    throw e;
  }
  throw new Error('expected FLOW_BUILDER_INVALID_SPEC');
}

describe('generatePlan with instanceResolvers', () => {
  it('a subflow called by name gets its sys_id, instance-typed inputs (definition order) and typed outputs', async () => {
    const f = fake();
    const plan = await generatePlan(SUBFLOW_CALLER({ name: 'Notify Owner' }, { message: 'hi', owner: { pill: 'trigger.current.caller_id' } }), { ...instanceResolvers(asClient(f)), resolvePillType: async () => 'reference' });
    const row = plan.instances.find(r => r.table === 'sys_hub_sub_flow_instance_v2')!;
    expect(row.fields.subflow).toBe(SUB);
    expect(decoded(plan, 'sys_hub_sub_flow_instance_v2', 'subflow_inputs').map(e => [e.name, (e.parameter as { type: string }).type])).toEqual([['owner', 'reference'], ['message', 'string']]);
    expect(plan.pills.find(p => p.symbolic === 'steps.notify.ok')?.type).toBe('boolean');
    expect(plan.warnings.filter(w => /subflow/.test(w))).toEqual([]);
    expect(writes(f)).toEqual([]);
  });

  it('a missing / ambiguous subflow and a flow passed as subflow are spec errors (FLOW_BUILDER_INVALID_SPEC)', async () => {
    const opts = instanceResolvers(asClient(fake()));
    expect((await semanticErrors(generatePlan(SUBFLOW_CALLER({ name: 'Nope' }, {}), opts))).join('\n')).toMatch(/step "notify": subflow "Nope" was not found/);
    expect((await semanticErrors(generatePlan(SUBFLOW_CALLER({ name: 'Escalate' }, {}), opts))).join('\n')).toMatch(/step "notify": subflow "Escalate" is ambiguous/);
    expect((await semanticErrors(generatePlan(SUBFLOW_CALLER({ sys_id: FLOW }, {}), opts))).join('\n')).toMatch(/is a flow, not a subflow/);
  });

  it('a resolved definition is authoritative: a missing mandatory input (no default) and an unknown input are errors', async () => {
    const opts = instanceResolvers(asClient(fake()));
    const errs = await semanticErrors(generatePlan(SUBFLOW_CALLER({ sys_id: SUB }, { message: 'x', colour: 'red' }), opts));
    expect(errs.join('\n')).toMatch(/unknown input "colour" \(definition inputs: owner, message, severity\)/);
    expect(errs.join('\n')).toMatch(/mandatory input "owner" of "Notify Owner" is missing/);
    expect(errs.join('\n')).not.toMatch(/"severity"/); // mandatory=false, and it has a default anyway
  });

  it('a resolved subflow with NO inputs refuses supplied inputs (no silent inference)', async () => {
    const f = fake({ sys_hub_flow_input: [] });
    const errs = await semanticErrors(generatePlan(SUBFLOW_CALLER({ sys_id: SUB }, { message: 'x' }), instanceResolvers(asClient(f))));
    expect(errs.join('\n')).toMatch(/unknown input "message" \(definition inputs: none\)/);
  });

  it('a custom action gets the instance input types instead of inferred strings', async () => {
    const s = spec({
      spec_version: '1', flow: { key: 'ca', name: 'CA' }, trigger: { key: 't', type: 'record.created', table: 'incident' },
      steps: [{ kind: 'custom_action', key: 'esc', definition: { name: 'Example Escalate' }, inputs: { record: { pill: 'trigger.current' }, notify: true } }],
    });
    const plan = await generatePlan(s, instanceResolvers(asClient(fake())));
    const entries = decoded(plan, 'sys_hub_action_instance_v2', 'values');
    expect(entries.map(e => [e.name, (e.parameter as { type: string }).type])).toEqual([['record', 'reference'], ['notify', 'boolean']]);
    expect(plan.instances[0].fields.action_type).toBe(ACT);
    // offline the same spec cannot resolve a name → spec error (today's behaviour)
    expect((await semanticErrors(generatePlan(s))).join('\n')).toMatch(/needs an instance to resolve the sys_id/);
  });

  it('resolveActionType: instance ids land in action_type / action_type_parent and its warnings in plan.warnings (with the step key)', async () => {
    const latest = '1a70000000000000000000000000000f';
    const f = fake({
      sys_hub_action_type_snapshot: [{ sys_id: latest, name: 'Log', parent_action: LOG_IDS.definition }],
      sys_hub_action_type_definition: [{ sys_id: LOG_IDS.definition, name: 'Log', latest_snapshot: latest }],
    });
    const s = spec({
      spec_version: '1', flow: { key: 'at', name: 'AT' }, trigger: { key: 't', type: 'record.created', table: 'incident' },
      steps: [{ kind: 'action', key: 'log', action: 'log', inputs: { log_level: 'info', log_message: 'x' } }],
    });
    const plan = await generatePlan(s, instanceResolvers(asClient(f)));
    expect(plan.instances[0].fields).toMatchObject({ action_type: latest, action_type_parent: LOG_IDS.definition });
    expect(plan.warnings.some(w => w.startsWith('step "log" (log): catalogue snapshot'))).toBe(true);
    const offline = await generatePlan(s);
    expect(offline.instances[0].fields).toMatchObject({ action_type: LOG_IDS.snapshot, action_type_parent: LOG_IDS.definition });
    expect(offline.warnings).toEqual([]);
  });
});

// ─── hidden inputs of a resolved definition ──────────────────────────────────

describe('hidden inputs (attributes visible=false / visible_in_fd=false)', () => {
  it('isHiddenByAttributes reads the comma list and a plain object', () => {
    expect(isHiddenByAttributes('element_mapping_provider=com.glide.X,visible_in_fd=false,uiType=string')).toBe(true);
    expect(isHiddenByAttributes('visible=false')).toBe(true);
    expect(isHiddenByAttributes({ visible_in_fd: 'false' })).toBe(true);
    expect(isHiddenByAttributes({ value: 'visible=false', display_value: 'visible=false' })).toBe(true);
    expect(isHiddenByAttributes('uiType=string,visible_in_fd=true')).toBe(false);
    expect(isHiddenByAttributes('')).toBe(false);
    expect(isHiddenByAttributes(undefined)).toBe(false);
  });

  /** Example Escalate + a hidden mandatory input without a default (a platform-managed input). */
  const withHidden = () => fake({
    sys_hub_action_input: [
      ...tables().sys_hub_action_input,
      { sys_id: 'a'.repeat(32), model: ACT, element: 'internal_token', label: 'Internal Token', internal_type: 'string', mandatory: 'true', order: '3', default_value: '', reference: '', attributes: 'uiType=string,visible_in_fd=false' },
    ],
  });
  const caSpec = (inputs: Record<string, unknown>) => spec({
    spec_version: '1', flow: { key: 'hid', name: 'Hidden' }, trigger: { key: 't', type: 'record.created', table: 'incident' },
    steps: [{ kind: 'custom_action', key: 'esc', definition: { sys_id: ACT }, inputs }],
  });

  it('the resolver marks the input hidden and requests the attributes column', async () => {
    const f = withHidden();
    const r = await makeCustomActionResolver(asClient(f))({ sys_id: ACT });
    if (isError(r)) throw new Error(r.error);
    expect(r.inputs.find(i => i.name === 'internal_token')).toMatchObject({ hidden: true, mandatory: true });
    expect(r.inputs.find(i => i.name === 'record')?.hidden).toBeUndefined();
    const inputQuery = f.fns.queryRecords.mock.calls.map(([p]) => p as { table: string; fields?: string }).find(p => p.table === 'sys_hub_action_input');
    expect(inputQuery?.fields?.split(',')).toContain('attributes');
  });

  it('a hidden mandatory input without a default is NOT reported missing (no false spec error)', async () => {
    const plan = await generatePlan(caSpec({ record: { pill: 'trigger.current' } }), instanceResolvers(asClient(withHidden())));
    const entries = decoded(plan, 'sys_hub_action_instance_v2', 'values');
    expect(entries.map(e => e.name)).toEqual(['record']);
  });

  it('a value supplied for a hidden input is refused (as for a hidden catalogue input)', async () => {
    const errs = await semanticErrors(generatePlan(caSpec({ record: { pill: 'trigger.current' }, internal_token: 'x' }), instanceResolvers(asClient(withHidden()))));
    expect(errs.join('\n')).toMatch(/input "internal_token" of "Example Escalate" is hidden in Flow Designer and cannot be set/);
    expect(errs.join('\n')).not.toMatch(/mandatory input "internal_token"/);
  });

  it('a visible mandatory input is still required (control)', async () => {
    const errs = await semanticErrors(generatePlan(caSpec({ notify: true }), instanceResolvers(asClient(withHidden()))));
    expect(errs.join('\n')).toMatch(/mandatory input "record" of "Example Escalate" is missing/);
    expect(errs.join('\n')).not.toMatch(/internal_token/);
  });
});

// ─── cross-scope definitions ──────────────────────────────────────────────────

describe('a definition in another application scope than the flow', () => {
  const caSpec = (definition: object, scope?: string) => spec({
    spec_version: '1', flow: { key: 'xs', name: 'Cross Scope', ...(scope ? { scope } : {}) }, trigger: { key: 't', type: 'record.created', table: 'incident' },
    steps: [{ kind: 'custom_action', key: 'esc', definition, inputs: { record: { pill: 'trigger.current' } } }],
  });
  const crossScope = (w: string) => /in application scope x_example_app, the flow is in scope global/.test(w);

  it('the resolver reports the definition scope', async () => {
    const r = await makeCustomActionResolver(asClient(fake()))({ name: 'Example Escalate' });
    expect(isError(r) ? r.error : r.scope).toBe('x_example_app');
  });

  it('a name lookup without scope that binds an x_example_app action to a global flow → a warning naming both scopes (and the scope hint)', async () => {
    const plan = await generatePlan(caSpec({ name: 'Example Escalate' }), instanceResolvers(asClient(fake())));
    const w = plan.warnings.filter(crossScope);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^step "esc": custom action "Example Escalate" \(ac7/);
    expect(w[0]).toMatch(/cross-scope access, which the build does not check; add scope to the reference to pin it/);
  });

  it('by sys_id: the warning without the scope hint; same scope as the flow: no warning', async () => {
    const byId = await generatePlan(caSpec({ sys_id: ACT }), instanceResolvers(asClient(fake())));
    expect(byId.warnings.filter(crossScope)).toHaveLength(1);
    expect(byId.warnings.join('\n')).not.toMatch(/add scope to the reference/);
    const same = await generatePlan(caSpec({ name: 'Example Escalate' }, 'x_example_app'), instanceResolvers(asClient(fake())));
    expect(same.warnings.filter(w => /application scope/.test(w))).toEqual([]);
  });

  it('a global subflow called from a global flow: no scope warning', async () => {
    const plan = await generatePlan(SUBFLOW_CALLER({ name: 'Notify Owner' }, { owner: { pill: 'trigger.current.caller_id' } }), { ...instanceResolvers(asClient(fake())), resolvePillType: async () => 'reference' });
    expect(plan.warnings.filter(w => /application scope/.test(w))).toEqual([]);
  });
});

describe('makeInstanceTimeZoneResolver (glide_date_time trigger inputs)', () => {
  const tzFake = (o: { username?: string; userZone?: string; systemZone?: string }) => makeFakeClient({
    username: o.username,
    tables: {
      sys_user: [{ sys_id: 'd'.repeat(32), user_name: 'svc.mcp', time_zone: o.userZone ?? '' }],
      sys_properties: o.systemZone === undefined ? [] : [{ sys_id: 'e'.repeat(32), name: DEFAULT_TZ_PROPERTY, value: o.systemZone }],
    },
  });

  it('user zone used when set; system zone otherwise; read once per resolver; read-only', async () => {
    const f = tzFake({ username: 'svc.mcp', systemZone: 'Europe/Brussels' });
    const resolve = makeInstanceTimeZoneResolver(f.client);
    expect(await resolve()).toEqual({ zone: 'Europe/Brussels', source: 'glide.sys.default.tz' });
    await resolve();
    expect(f.state.calls.map(c => `${c.table}:${c.query}`)).toEqual(['sys_user:user_name=svc.mcp', `sys_properties:name=${DEFAULT_TZ_PROPERTY}`]);
    // the same zone on both sides: no warning
    expect(await makeInstanceTimeZoneResolver(tzFake({ username: 'svc.mcp', userZone: 'Europe/Brussels', systemZone: 'Europe/Brussels' }).client)())
      .toEqual({ zone: 'Europe/Brussels', source: 'sys_user.time_zone' });
  });

  it('a user zone that differs from the system zone: both zones are read and the unverified precedence is warned about', async () => {
    const f = tzFake({ username: 'svc.mcp', userZone: 'Asia/Tokyo', systemZone: 'Europe/Brussels' });
    const r = await makeInstanceTimeZoneResolver(f.client)();
    expect(r).toMatchObject({ zone: 'Asia/Tokyo', source: 'sys_user.time_zone' });
    const w = (r as { warnings: string[] }).warnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/the user zone sys_user\.time_zone "Asia\/Tokyo" of svc\.mcp differs from the system zone glide\.sys\.default\.tz "Europe\/Brussels" — "Asia\/Tokyo" \(sys_user\.time_zone\) is used\. UNVERIFIED: .*not yet proven on a PDI.*a different user activates the flow later in Workflow Studio/);
    expect(f.state.calls.map(c => c.table)).toEqual(['sys_user', 'sys_properties']);
    expect(f.state.calls.every(c => c.method === 'queryRecords')).toBe(true);
    // a user zone with no system property: warned about too
    const noSys = await makeInstanceTimeZoneResolver(tzFake({ username: 'svc.mcp', userZone: 'Asia/Tokyo' }).client)();
    expect(noSys).toMatchObject({ zone: 'Asia/Tokyo', source: 'sys_user.time_zone' });
    expect((noSys as { warnings: string[] }).warnings[0]).toMatch(/differs from the system zone glide\.sys\.default\.tz \(not set\)/);
  });

  it('the system property cannot be read: a set user zone is still used, with a warning; without one the read error propagates', async () => {
    const failing = (userZone?: string) => {
      const f = tzFake({ username: 'svc.mcp', userZone, systemZone: 'Europe/Brussels' });
      const orig = f.client.queryRecords.getMockImplementation()!;
      f.client.queryRecords.mockImplementation(async p => { if (p.table === 'sys_properties') throw new Error('read refused'); return orig(p); });
      return f;
    };
    const r = await makeInstanceTimeZoneResolver(failing('Asia/Tokyo').client)();
    expect(r).toMatchObject({ zone: 'Asia/Tokyo', source: 'sys_user.time_zone' });
    expect((r as { warnings: string[] }).warnings[0]).toMatch(/glide\.sys\.default\.tz could not be read \(read refused\) — the user zone "Asia\/Tokyo" is used; UNVERIFIED/);
    await expect(makeInstanceTimeZoneResolver(failing().client)()).rejects.toThrow('read refused');
  });

  it('the user row is not found (missing / ACL): the system zone with a warning', async () => {
    const f = makeFakeClient({ username: 'svc.other', tables: { sys_user: [], sys_properties: [{ sys_id: 'e'.repeat(32), name: DEFAULT_TZ_PROPERTY, value: 'Europe/Brussels' }] } });
    const r = await makeInstanceTimeZoneResolver(f.client)();
    expect(r).toEqual({ zone: 'Europe/Brussels', source: 'glide.sys.default.tz', warnings: [
      `the sys_user row of svc.other was not found (missing, or not readable by this account) — its time_zone could not be read; ${DEFAULT_TZ_PROPERTY} is used`,
    ] });
    // no row and no property → {error}, never a guess
    const none = makeFakeClient({ username: 'svc.other', tables: { sys_user: [], sys_properties: [] } });
    expect(await makeInstanceTimeZoneResolver(none.client)()).toEqual({ error: `the instance time zone is unknown (${DEFAULT_TZ_PROPERTY} is not set and the user has no time_zone)` });
  });

  it('an invalid user zone falls back to the system zone with a warning (no precedence warning)', async () => {
    const r = await makeInstanceTimeZoneResolver(tzFake({ username: 'svc.mcp', userZone: 'Mars/Olympus', systemZone: 'Europe/Brussels' }).client)();
    expect(r).toEqual({ zone: 'Europe/Brussels', source: 'glide.sys.default.tz', warnings: [
      `sys_user.time_zone "Mars/Olympus" of svc.mcp is not a known IANA zone — ${DEFAULT_TZ_PROPERTY} is used`,
    ] });
  });

  it('object-shaped Table API values ({value, display_value}) are read by their value', async () => {
    const obj = (value: string) => ({ value, display_value: value }) as unknown as string;
    const f = makeFakeClient({ username: 'svc.mcp', tables: {
      sys_user: [{ sys_id: 'd'.repeat(32), user_name: 'svc.mcp', time_zone: obj('Asia/Tokyo') }],
      sys_properties: [{ sys_id: 'e'.repeat(32), name: DEFAULT_TZ_PROPERTY, value: obj('Asia/Tokyo') }],
    } });
    expect(await makeInstanceTimeZoneResolver(f.client)()).toEqual({ zone: 'Asia/Tokyo', source: 'sys_user.time_zone' });
    const sysOnly = makeFakeClient({ username: 'svc.mcp', tables: {
      sys_user: [{ sys_id: 'd'.repeat(32), user_name: 'svc.mcp', time_zone: obj('') }],
      sys_properties: [{ sys_id: 'e'.repeat(32), name: DEFAULT_TZ_PROPERTY, value: obj('Europe/Brussels') }],
    } });
    expect(await makeInstanceTimeZoneResolver(sysOnly.client)()).toEqual({ zone: 'Europe/Brussels', source: 'glide.sys.default.tz' });
  });

  it('no configured username (impersonation / per-user auth): the system zone with a warning', async () => {
    const r = await makeInstanceTimeZoneResolver(tzFake({ systemZone: 'Europe/Brussels' }).client)();
    expect(r).toMatchObject({ zone: 'Europe/Brussels', source: 'glide.sys.default.tz' });
    expect((r as { warnings: string[] }).warnings[0]).toMatch(/its sys_user\.time_zone was not read/);
  });

  it('no usable zone → {error} (never a guess)', async () => {
    expect(await makeInstanceTimeZoneResolver(tzFake({ username: 'svc.mcp' }).client)()).toEqual({ error: `the instance time zone is unknown (${DEFAULT_TZ_PROPERTY} is not set and the user has no time_zone)` });
    expect(await makeInstanceTimeZoneResolver(tzFake({ username: 'svc.mcp', systemZone: 'Nowhere/Land' }).client)()).toEqual({ error: `the instance time zone is unknown (${DEFAULT_TZ_PROPERTY} = "Nowhere/Land" is not a known IANA zone)` });
  });
});

describe('makeCatalogVariablesResolver (Get Catalog Variables outputs)', () => {
  const ITEM = 'c'.repeat(32);
  it('reads the item\'s active variables in order, typed; neither item nor set → {error}; memoised; read-only', async () => {
    const f = makeFakeClient({ tables: {
      sc_cat_item: [{ sys_id: ITEM, name: 'Example Item' }],
      item_option_new: [
        { sys_id: '2'.repeat(32), name: 'b_ref', question_text: 'B', type: '8', reference: 'cmn_location', order: '200', cat_item: ITEM, variable_set: '', active: 'true' },
        { sys_id: '1'.repeat(32), name: 'a_date', question_text: 'A', type: '10', reference: '', order: '100', cat_item: ITEM, variable_set: '', active: 'true' },
        { sys_id: '3'.repeat(32), name: 'c_off', question_text: 'C', type: '6', reference: '', order: '50', cat_item: ITEM, variable_set: '', active: 'false' },
      ],
    } });
    const resolve = makeCatalogVariablesResolver(f.client);
    expect(await resolve(ITEM)).toEqual({ item: ITEM, kind: 'catalog_item', name: 'Example Item', variables: [
      { name: 'a_date', sys_id: '1'.repeat(32), type: 'glide_date_time', type_code: '10', label: 'A' },
      { name: 'b_ref', sys_id: '2'.repeat(32), type: 'reference', type_code: '8', label: 'B', reference: 'cmn_location' },
    ] });
    const n = f.state.calls.length;
    await resolve(ITEM);
    expect(f.state.calls.length).toBe(n);
    expect(await resolve('9'.repeat(32))).toEqual({ error: `template_catalog_item ${'9'.repeat(32)} is neither a catalog item (sc_cat_item) nor a variable set (item_option_new_set) on the instance` });
    expect(f.state.calls.every(c => c.method === 'queryRecords')).toBe(true);
  });

  it('a multi-row variable set with an empty internal_name is one output named after the set name', async () => {
    const MRVS = 'a'.repeat(32);
    const f = makeFakeClient({ tables: {
      sc_cat_item: [{ sys_id: ITEM, name: 'Example Item' }],
      item_option_new: [],
      io_set_item: [{ sys_id: 'b'.repeat(32), sc_cat_item: ITEM, variable_set: MRVS, order: '1' }],
      item_option_new_set: [{ sys_id: MRVS, name: 'devices_list', internal_name: '', title: 'Devices', type: 'one_to_many' }],
    } });
    const r = await makeCatalogVariablesResolver(f.client)(ITEM);
    expect(r).toEqual({ item: ITEM, kind: 'catalog_item', name: 'Example Item',
      variables: [{ name: 'devices_list', sys_id: MRVS, type: 'string', type_code: 'one_to_many', label: 'Devices', variable_set: MRVS }],
      warnings: ['multi-row variable set "devices_list" is one output (its rows) — typed "string"'] });
  });
});
