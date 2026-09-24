/**
 * glide_date_time trigger inputs (scheduled.run_once run_in, FORMAT-DECISIONS D17) and Get Catalog Variables
 * outputs (D18) at the generator level, with resolver doubles — no client, no instance.
 *
 *   run_in: 'YYYY-MM-DD HH:MM:SS' = instance-local (stored as given); an ISO-8601 instant is converted to the wall
 *           time of the instance zone (DST-correct); offline an ISO value is a spec error; with a zone the value
 *           is checked to lie in the future.
 *   gcv:    outputs = the template item's variables typed from their question type; an unknown / unselected name
 *           is a spec error; offline the pill stays string + warning.
 */
import { describe, it, expect } from 'vitest';
import { generatePlan, type CatalogVariablesInfo, type GeneratorExtras, type InstanceTimeZone } from '../../../src/flow-builder/generator/index.js';
import { parseSpec, isLocalDateTime, parseIsoInstant } from '../../../src/flow-builder/spec/schema.js';
import { wallTimeIn, instantsForWallTime } from '../../../src/flow-builder/generator/values.js';
import { catalogVariableType } from '../../../src/flow-builder/resolvers.js';
import { decodeValues } from '../../../src/flow-builder/encode.js';
import type { FlowSpec, RecordPlan } from '../../../src/flow-builder/spec/types.js';

function spec(input: unknown): FlowSpec {
  const r = parseSpec(input);
  if ('errors' in r) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

const runOnce = (run_in: string, extra: Record<string, unknown> = {}) => spec({
  spec_version: '1', flow: { key: 'ro', name: 'Run Once Test' },
  trigger: { key: 't', type: 'scheduled.run_once', run_in, ...extra },
  steps: [{ kind: 'action', key: 'l', action: 'log', inputs: { log_message: 'x' } }],
});

const BRUSSELS: InstanceTimeZone = { zone: 'Europe/Brussels', source: 'glide.sys.default.tz' };
/** 2026-09-24 12:00:00 UTC = 14:00:00 in Brussels (CEST). */
const NOW = new Date('2026-09-24T12:00:00Z');
const live = (zone: InstanceTimeZone | { error: string } = BRUSSELS, now = NOW): GeneratorExtras => ({ resolveInstanceTimeZone: async () => zone, now: () => now });

function storedRunIn(plan: RecordPlan): { value: unknown; displayValue: unknown } {
  const entries = decodeValues(String(plan.trigger!.fields.trigger_inputs)) as { name: string; value: unknown; displayValue: unknown }[];
  const e = entries.find(x => x.name === 'run_in')!;
  return { value: e.value, displayValue: e.displayValue };
}

async function errorsOf(p: Promise<unknown>): Promise<string[]> {
  try { await p; return []; } catch (e) { return ((e as { details?: { errors?: string[] } }).details?.errors) ?? [String((e as Error).message)]; }
}

describe('run_in value forms (schema)', () => {
  it('accepts the instance-local form and ISO-8601 instants with Z or an offset; rejects everything else', () => {
    for (const ok of ['2026-12-31 23:59:00', '2026-09-24T14:48:00Z', '2026-09-24T16:48+02:00', '2026-01-10T08:00:00-05:00']) {
      expect(parseSpec({ spec_version: '1', flow: { key: 'f', name: 'F' }, trigger: { key: 't', type: 'scheduled.run_once', run_in: ok }, steps: [] }), ok).not.toHaveProperty('errors');
    }
    for (const bad of ['tomorrow', '2026-13-01 00:00:00', '2026-02-30 10:00:00', '2026-09-24T14:48:00', '2026-09-24T14:48:00.123Z', '2026-09-24 14:48:00Z', '2026-09-24T25:00:00Z']) {
      const r = parseSpec({ spec_version: '1', flow: { key: 'f', name: 'F' }, trigger: { key: 't', type: 'scheduled.run_once', run_in: bad }, steps: [] });
      expect('errors' in r ? r.errors.map(e => e.message).join('\n') : 'no error', bad).toMatch(/run_in must be "YYYY-MM-DD HH:MM:SS" \(instance-local wall time\) or an ISO-8601 instant/);
    }
    expect(isLocalDateTime('2026-09-24 14:48:00')).toBe(true);
    expect(parseIsoInstant('2026-09-24T16:48:00+02:00')?.toISOString()).toBe('2026-09-24T14:48:00.000Z');
  });

  it('years 0-99 are not moved into the 1900s (Date.UTC quirk)', () => {
    expect(parseIsoInstant('0050-01-01T00:00Z')?.getUTCFullYear()).toBe(50);
    expect(parseIsoInstant('0050-01-01T00:00Z')?.toISOString()).toBe('0050-01-01T00:00:00.000Z');
    expect(parseIsoInstant('0099-12-31T23:30-01:00')?.toISOString()).toBe('0100-01-01T00:30:00.000Z');
    // the year 0 is a leap year (1900 is not): the calendar check uses the real year
    expect(isLocalDateTime('0000-02-29 00:00:00')).toBe(true);
    expect(isLocalDateTime('1900-02-29 00:00:00')).toBe(false);
    expect(instantsForWallTime('UTC', '0050-06-01 12:00:00').map(d => d.getUTCFullYear())).toEqual([50]);
  });
});

describe('wall time in a zone (Intl, DST per date)', () => {
  it('Europe/Brussels: +02:00 in summer, +01:00 in winter, the repeated / skipped hour at the changes', () => {
    expect(wallTimeIn('Europe/Brussels', new Date('2026-07-15T12:00:00Z'))).toBe('2026-07-15 14:00:00');
    expect(wallTimeIn('Europe/Brussels', new Date('2026-12-15T12:00:00Z'))).toBe('2026-12-15 13:00:00');
    expect(wallTimeIn('Europe/Brussels', new Date('2026-10-25T00:30:00Z'))).toBe('2026-10-25 02:30:00'); // CEST
    expect(wallTimeIn('Europe/Brussels', new Date('2026-10-25T01:30:00Z'))).toBe('2026-10-25 02:30:00'); // CET, same wall time
    expect(wallTimeIn('Europe/Brussels', new Date('2026-03-29T00:59:59Z'))).toBe('2026-03-29 01:59:59');
    expect(wallTimeIn('Europe/Brussels', new Date('2026-03-29T01:00:00Z'))).toBe('2026-03-29 03:00:00');
    expect(instantsForWallTime('Europe/Brussels', '2026-03-29 02:30:00')).toEqual([]); // gap
    expect(instantsForWallTime('Europe/Brussels', '2026-10-25 02:30:00').map(d => d.toISOString())).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']); // overlap
    expect(instantsForWallTime('Europe/Brussels', '2026-07-15 14:00:00').map(d => d.toISOString())).toEqual(['2026-07-15T12:00:00.000Z']);
  });
});

describe('scheduled.run_once run_in (D17)', () => {
  it('offline, the local form is stored as given (value == displayValue), no zone, no future check, no warning', async () => {
    const plan = await generatePlan(runOnce('2027-01-15 14:30:00'));
    expect(storedRunIn(plan)).toEqual({ value: '2027-01-15 14:30:00', displayValue: '2027-01-15 14:30:00' });
    expect(plan.dateTimeInputs).toEqual([{ input: 'run_in', given: '2027-01-15 14:30:00', form: 'local', local: '2027-01-15 14:30:00' }]);
    expect(plan.warnings).toEqual([]);
  });

  it('offline, an ISO-8601 run_in is a spec error asking for an instance or the local form', async () => {
    const errors = await errorsOf(generatePlan(runOnce('2026-12-15T12:00:00Z')));
    expect(errors.join('\n')).toMatch(/trigger input "run_in": "2026-12-15T12:00:00Z" is an ISO-8601 instant — converting it .* needs the instance time zone: plan \/ build with an instance, or give the instance-local form "YYYY-MM-DD HH:MM:SS"/);
  });

  it('Brussels SUMMER: 2026-10-01T12:00:00Z → 2026-10-01 14:00:00 (CEST, +02:00)', async () => {
    const plan = await generatePlan(runOnce('2026-10-01T12:00:00Z'), live());
    expect(storedRunIn(plan)).toEqual({ value: '2026-10-01 14:00:00', displayValue: '2026-10-01 14:00:00' });
    expect(plan.dateTimeInputs![0]).toEqual({
      input: 'run_in', given: '2026-10-01T12:00:00Z', form: 'iso', local: '2026-10-01 14:00:00',
      zone: 'Europe/Brussels', zone_source: 'glide.sys.default.tz', instance_now: '2026-09-24 14:00:00', in_future: true,
    });
    expect(plan.warnings).toEqual(['trigger input "run_in": "2026-10-01T12:00:00Z" converted to "2026-10-01 14:00:00" — the wall time in the instance time zone Europe/Brussels (glide.sys.default.tz), which is how the platform reads it']);
  });

  it('Brussels WINTER: 2026-12-15T12:00:00Z → 2026-12-15 13:00:00 (CET, +01:00); an offset form converts the same way', async () => {
    expect(storedRunIn(await generatePlan(runOnce('2026-12-15T12:00:00Z'), live())).value).toBe('2026-12-15 13:00:00');
    expect(storedRunIn(await generatePlan(runOnce('2026-12-15T07:00:00-05:00'), live())).value).toBe('2026-12-15 13:00:00');
    // across the October change: both UTC instants land on 02:30 local, one hour apart — and both are warned about as ambiguous
    for (const iso of ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']) {
      const plan = await generatePlan(runOnce(iso), live());
      expect(storedRunIn(plan).value).toBe('2026-10-25 02:30:00');
      expect(plan.warnings.join('\n'), iso).toMatch(new RegExp(`"${iso}" converts to "2026-10-25 02:30:00", a wall time that occurs twice in Europe/Brussels \\(the hour repeats at the daylight-saving change\\).*the platform may read it as the earlier one \\(2026-10-25T00:30:00\\.000Z\\); the future check uses the earlier one`));
    }
    // outside the overlap: no ambiguity warning
    expect((await generatePlan(runOnce('2026-12-15T12:00:00Z'), live())).warnings.join('\n')).not.toMatch(/occurs twice/);
  });

  it('an ISO instant in the DST overlap: in_future is judged by the earliest reading of the stored wall time, never local <= instance_now', async () => {
    // the review case: the second (CET) 02:30, now = 02:45 CEST (the first pass through the hour)
    const nowCest = new Date('2026-10-25T00:45:00Z');
    const plan = await generatePlan(runOnce('2026-10-25T01:30:00Z'), live(BRUSSELS, nowCest));
    expect(plan.dateTimeInputs![0]).toMatchObject({ local: '2026-10-25 02:30:00', instance_now: '2026-10-25 02:45:00', in_future: false });
    expect(plan.warnings.join('\n')).toMatch(/occurs twice in Europe\/Brussels/);
    expect(plan.warnings.join('\n')).toMatch(/"2026-10-25 02:30:00" \(instance time zone Europe\/Brussels\) is NOT in the future — the instance time is now 2026-10-25 02:45:00/);
    // now = 02:10 CET (the second pass): the wall time is later, but its earlier reading (00:30Z) is already past
    const nowCet = new Date('2026-10-25T01:10:00Z');
    const second = await generatePlan(runOnce('2026-10-25T01:30:00Z'), live(BRUSSELS, nowCet));
    expect(second.dateTimeInputs![0]).toMatchObject({ local: '2026-10-25 02:30:00', instance_now: '2026-10-25 02:10:00', in_future: false });
    // both readings still ahead: future
    const early = await generatePlan(runOnce('2026-10-25T01:30:00Z'), live(BRUSSELS, new Date('2026-10-25T00:15:00Z')));
    expect(early.dateTimeInputs![0]).toMatchObject({ local: '2026-10-25 02:30:00', instance_now: '2026-10-25 02:15:00', in_future: true });
    // the invariant, over a sweep of instants and clocks around the change
    for (let run = Date.parse('2026-10-24T23:00:00Z'); run <= Date.parse('2026-10-25T03:00:00Z'); run += 15 * 60000) {
      for (let now = Date.parse('2026-10-24T23:00:00Z'); now <= Date.parse('2026-10-25T03:00:00Z'); now += 20 * 60000) {
        const c = (await generatePlan(runOnce(new Date(run).toISOString().replace('.000Z', 'Z')), live(BRUSSELS, new Date(now)))).dateTimeInputs![0];
        if (c.in_future) expect(c.local > c.instance_now!, `${c.given} @ ${new Date(now).toISOString()}`).toBe(true);
      }
    }
  });

  it('the user zone overrides the system zone (resolver source sys_user.time_zone)', async () => {
    const plan = await generatePlan(runOnce('2026-12-15T12:00:00Z'), live({ zone: 'America/New_York', source: 'sys_user.time_zone' }));
    expect(plan.dateTimeInputs![0]).toMatchObject({ local: '2026-12-15 07:00:00', zone: 'America/New_York', zone_source: 'sys_user.time_zone', instance_now: '2026-09-24 08:00:00', in_future: true });
  });

  it('a run_in that is not in the future is warned about (activation would fire immediately); strictly later is fine', async () => {
    const past = await generatePlan(runOnce('2026-09-24 13:59:00'), live());
    expect(past.dateTimeInputs![0]).toMatchObject({ local: '2026-09-24 13:59:00', instance_now: '2026-09-24 14:00:00', in_future: false });
    expect(past.warnings.join('\n')).toMatch(/"2026-09-24 13:59:00" \(instance time zone Europe\/Brussels\) is NOT in the future — the instance time is now 2026-09-24 14:00:00; on activation the flow would fire IMMEDIATELY\. snow_flow_build refuses this unless allow_past_run:true/);
    // the PDI finding: a UTC-looking wall time already past in Brussels
    expect((await generatePlan(runOnce('2026-09-24 13:00:00'), live())).dateTimeInputs![0].in_future).toBe(false);
    expect((await generatePlan(runOnce('2026-09-24 14:00:00'), live())).dateTimeInputs![0].in_future).toBe(false);
    const future = await generatePlan(runOnce('2026-09-24 14:00:01'), live());
    expect(future.dateTimeInputs![0].in_future).toBe(true);
    expect(future.warnings).toEqual([]);
    // an ISO instant compares as an instant
    expect((await generatePlan(runOnce('2026-09-24T11:59:59Z'), live())).dateTimeInputs![0].in_future).toBe(false);
    expect((await generatePlan(runOnce('2026-09-24T12:00:01Z'), live())).dateTimeInputs![0].in_future).toBe(true);
  });

  it('a local run_in in the DST gap / overlap of the instance zone is warned about', async () => {
    expect((await generatePlan(runOnce('2027-03-28 02:30:00'), live())).warnings.join('\n')).toMatch(/does not exist in Europe\/Brussels \(the clock skips it/);
    expect((await generatePlan(runOnce('2026-10-25 02:30:00'), live())).warnings.join('\n')).toMatch(/occurs twice in Europe\/Brussels \(the hour repeats/);
  });

  it('zone unknown on the instance: an ISO run_in is a spec error, a local one is stored but reported as unchecked', async () => {
    const unknown = { error: 'the instance time zone is unknown (glide.sys.default.tz is not set and the user has no time_zone)' };
    expect((await errorsOf(generatePlan(runOnce('2026-12-15T12:00:00Z'), live(unknown)))).join('\n')).toMatch(/is an ISO-8601 instant, but the instance time zone is unknown/);
    const plan = await generatePlan(runOnce('2026-12-15 12:00:00'), live(unknown));
    expect(plan.dateTimeInputs![0]).toEqual({ input: 'run_in', given: '2026-12-15 12:00:00', form: 'local', local: '2026-12-15 12:00:00' });
    expect(plan.warnings.join('\n')).toMatch(/stored as given \(instance-local\) but NOT checked to lie in the future/);
    // a resolver that throws counts as unknown
    const thrown = await generatePlan(runOnce('2026-12-15 12:00:00'), { resolveInstanceTimeZone: async () => { throw new Error('boom'); } });
    expect(thrown.warnings.join('\n')).toMatch(/the instance time zone could not be read \(boom\)/);
  });

  it('timezone on a run_once trigger is ignored, and says so', async () => {
    const plan = await generatePlan(runOnce('2027-01-15 14:30:00', { timezone: 'Europe/Sofia' }));
    expect(storedRunIn(plan).value).toBe('2027-01-15 14:30:00');
    expect(plan.warnings.join('\n')).toMatch(/timezone "Europe\/Sofia" is ignored on scheduled\.run_once/);
  });

  it('other triggers never ask for the zone', async () => {
    let asked = 0;
    await generatePlan(spec({ spec_version: '1', flow: { key: 'd', name: 'D' }, trigger: { key: 't', type: 'scheduled.daily', time: '08:00:00', timezone: 'Europe/Brussels' }, steps: [] }),
      { resolveInstanceTimeZone: async () => { asked++; return BRUSSELS; } });
    expect(asked).toBe(0);
  });
});

// ─── Get Catalog Variables (D18) ─────────────────────────────────────────────

const ITEM = 'c'.repeat(32);
const VARS: CatalogVariablesInfo = {
  item: ITEM, kind: 'catalog_item', name: 'Example Laptop',
  variables: [
    { name: 'laptop_type', sys_id: '1'.repeat(32), type: 'choice', type_code: '5' },
    { name: 'requested_for', sys_id: '2'.repeat(32), type: 'reference', type_code: '8', reference: 'sys_user' },
    { name: 'needed_by', sys_id: '3'.repeat(32), type: 'glide_date', type_code: '9' },
    { name: 'address_line', sys_id: '4'.repeat(32), type: 'string', type_code: '6', variable_set: '5'.repeat(32) },
  ],
};

const gcvFlow = (text: string, gcvInputs: Record<string, unknown> = {}) => spec({
  spec_version: '1', flow: { key: 'gcv', name: 'GCV Test' },
  trigger: { key: 't', type: 'catalog.service_catalog' },
  steps: [
    { kind: 'action', key: 'vars', action: 'getCatalogVariables', inputs: { requested_item: { pill: 'trigger.request_item' }, template_catalog_item: { reference: ITEM, display: 'Example Laptop' }, ...gcvInputs } },
    { kind: 'action', key: 'l', action: 'log', inputs: { log_message: { text } } },
  ],
});

/** The stored catalog_variables entry of the Get Catalog Variables step (decoded from sys_hub_action_instance_v2.values). */
function storedSelection(plan: RecordPlan): { value: unknown; displayValue: unknown } {
  for (const row of plan.instances.filter(r => r.table === 'sys_hub_action_instance_v2')) {
    const e = (decodeValues(String(row.fields.values)) as { name: string; value: unknown; displayValue: unknown }[]).find(x => x.name === 'catalog_variables');
    if (e) return { value: e.value, displayValue: e.displayValue };
  }
  throw new Error('no catalog_variables entry');
}
/** The slushbucket tokens of the stored selection, split into sys_id + table. */
function storedTokens(plan: RecordPlan): { sys_id: string; table: string }[] {
  return String(storedSelection(plan).value).split(',').map(t => { const [sys_id, table] = t.split(':'); return { sys_id, table }; });
}

describe('Get Catalog Variables outputs (D18)', () => {
  it('question type codes map to flow types', () => {
    expect(Object.fromEntries(['6', '2', '5', '3', '7', '8', '9', '10', '16', '21', '11', '99', ''].map(c => [c, catalogVariableType(c)]))).toEqual({
      6: 'string', 2: 'string', 5: 'choice', 3: 'choice', 7: 'boolean', 8: 'reference', 9: 'glide_date', 10: 'glide_date_time', 16: 'string', 21: 'glide_list', 11: 'string', 99: 'string', '': 'string',
    });
  });

  it('live: pills on the variables are typed from the resolved definition (reference walks through its table)', async () => {
    const plan = await generatePlan(gcvFlow('{{steps.vars.laptop_type}} {{steps.vars.requested_for}} {{steps.vars.requested_for.email}} {{steps.vars.needed_by}} {{steps.vars.address_line}}'), {
      resolveCatalogVariables: async item => (item === ITEM ? VARS : { error: 'unexpected' }),
      resolvePillType: async (t, p) => (t === 'sys_user' && p === 'email' ? 'email' : undefined),
    });
    expect(Object.fromEntries(plan.pills.filter(p => p.symbolic.startsWith('steps.vars.')).map(p => [p.symbolic, p.type]))).toEqual({
      'steps.vars.laptop_type': 'choice', 'steps.vars.requested_for': 'reference', 'steps.vars.requested_for.email': 'email',
      'steps.vars.needed_by': 'glide_date', 'steps.vars.address_line': 'string',
    });
    expect(plan.warnings).toEqual([]);
    const lc = plan.labelCache as { name: string; reference?: string }[];
    expect(lc.find(e => e.name.endsWith('.requested_for'))?.reference).toBe('sys_user');
  });

  it('live: a name that is not a variable of the item is a spec error listing the valid names', async () => {
    const errors = await errorsOf(generatePlan(gcvFlow('{{steps.vars.laptop_typ}}'), { resolveCatalogVariables: async () => VARS }));
    expect(errors).toEqual([`pill steps.vars.laptop_typ: "laptop_typ" is not a variable of catalog item "Example Laptop" (${ITEM}) — valid outputs of step "vars": laptop_type, requested_for, needed_by, address_line`]);
  });

  it('live: catalog_variables restricts the outputs (a variable, or a whole variable set); an item outside the variables is an error', async () => {
    const restricted = { catalog_variables: { list: ['1'.repeat(32), `${'5'.repeat(32)}:item_option_new_set`] } };
    const ok = await generatePlan(gcvFlow('{{steps.vars.laptop_type}} {{steps.vars.address_line}}', restricted), { resolveCatalogVariables: async () => VARS });
    expect(ok.pills.filter(p => p.symbolic.startsWith('steps.vars.')).map(p => p.type)).toEqual(['choice', 'string']);
    const errors = await errorsOf(generatePlan(gcvFlow('{{steps.vars.needed_by}}', restricted), { resolveCatalogVariables: async () => VARS }));
    expect(errors).toEqual([`pill steps.vars.needed_by: "needed_by" is not selected in catalog_variables of catalog item "Example Laptop" (${ITEM}) — valid outputs of step "vars": laptop_type, address_line`]);
    const foreign = await errorsOf(generatePlan(gcvFlow('x', { catalog_variables: { list: ['9'.repeat(32)] } }), { resolveCatalogVariables: async () => VARS }));
    expect(foreign.join('\n')).toMatch(new RegExp(`catalog_variables "${'9'.repeat(32)}" is not a variable \\(or variable set\\) of catalog item "Example Laptop"`));
  });

  it('live: the stored catalog_variables slushbucket is the platform form — a NAME entry becomes "<variable sys_id>:item_option_new"', async () => {
    const plan = await generatePlan(gcvFlow('{{steps.vars.laptop_type}} {{steps.vars.requested_for}}', { catalog_variables: { list: ['laptop_type', 'requested_for'] } }), { resolveCatalogVariables: async () => VARS });
    expect(storedSelection(plan)).toEqual({ value: `${'1'.repeat(32)}:item_option_new,${'2'.repeat(32)}:item_option_new`, displayValue: `${'1'.repeat(32)}:item_option_new,${'2'.repeat(32)}:item_option_new` });
    expect(storedTokens(plan)).toEqual([{ sys_id: '1'.repeat(32), table: 'item_option_new' }, { sys_id: '2'.repeat(32), table: 'item_option_new' }]);
    expect(plan.pills.filter(p => p.symbolic.startsWith('steps.vars.')).map(p => p.type)).toEqual(['choice', 'reference']);
    expect(plan.warnings).toEqual([]);
  });

  it('live: a variable-set entry (bare sys_id, {reference}, suffixed, or a multi-row set by name) becomes "<set sys_id>:item_option_new_set"; variables keep ":item_option_new"', async () => {
    const MRVS = '6'.repeat(32);
    const withMrvs: CatalogVariablesInfo = { ...VARS, variables: [...VARS.variables, { name: 'devices', sys_id: MRVS, type: 'string', type_code: 'one_to_many', variable_set: MRVS }] };
    const SET = '5'.repeat(32);
    const cases: [unknown, string][] = [
      [SET, `${SET}:item_option_new_set`],
      [{ reference: SET }, `${SET}:item_option_new_set`],
      [`${SET}:item_option_new_set`, `${SET}:item_option_new_set`],
      [`${SET}:item_option_new`, `${SET}:item_option_new_set`], // a wrong suffix is corrected
      ['devices', `${MRVS}:item_option_new_set`],
      [MRVS, `${MRVS}:item_option_new_set`],
      ['1'.repeat(32), `${'1'.repeat(32)}:item_option_new`],
      [{ reference: '1'.repeat(32) }, `${'1'.repeat(32)}:item_option_new`],
      [`${'1'.repeat(32)}:item_option_new`, `${'1'.repeat(32)}:item_option_new`],
      ['address_line', `${'4'.repeat(32)}:item_option_new`], // a variable inside a set, by name: the variable itself
    ];
    for (const [entry, token] of cases) {
      const plan = await generatePlan(gcvFlow('x', { catalog_variables: { list: [entry] } }), { resolveCatalogVariables: async () => withMrvs });
      expect(storedSelection(plan).value, JSON.stringify(entry)).toBe(token);
    }
    const all = await generatePlan(gcvFlow('{{steps.vars.address_line}} {{steps.vars.laptop_type}}', { catalog_variables: { list: [SET, 'laptop_type'] } }), { resolveCatalogVariables: async () => withMrvs });
    expect(storedTokens(all)).toEqual([{ sys_id: SET, table: 'item_option_new_set' }, { sys_id: '1'.repeat(32), table: 'item_option_new' }]);
  });

  it('offline (or when the selection cannot be checked): a non-sys_id catalog_variables string is a spec error; sys_ids and tokens are encoded', async () => {
    const offline = await errorsOf(generatePlan(gcvFlow('x', { catalog_variables: { list: ['1'.repeat(32), 'laptop_type'] } })));
    expect(offline).toEqual([`step "vars": "catalog_variables" {list}[1] "laptop_type" is not a sys_id — the slushbucket stores "<sys_id>:item_option_new" / "<set sys_id>:item_option_new_set" and a bare name would select nothing at runtime; give the variable sys_id ("<sys_id>" or "<sys_id>:item_option_new") or a variable set as "<set sys_id>:item_option_new_set" (a Get Catalog Variables step resolves variable names against its static template_catalog_item only on a live plan / build)`]);
    const ok = await generatePlan(gcvFlow('x', { catalog_variables: { list: ['1'.repeat(32), { reference: '2'.repeat(32) }, `${'5'.repeat(32)}:item_option_new_set`] } }));
    expect(storedSelection(ok).value).toBe(`${'1'.repeat(32)}:item_option_new,${'2'.repeat(32)}:item_option_new,${'5'.repeat(32)}:item_option_new_set`);
    // live, but the read failed: the name cannot be resolved either
    const thrown = await errorsOf(generatePlan(gcvFlow('x', { catalog_variables: { list: ['laptop_type'] } }), { resolveCatalogVariables: async () => { throw new Error('read refused'); } }));
    expect(thrown.join('\n')).toMatch(/"catalog_variables" \{list\}\[0\] "laptop_type" is not a sys_id/);
    // live and checked: an unknown name is reported once (as not a variable of the item), not twice
    const unknown = await errorsOf(generatePlan(gcvFlow('x', { catalog_variables: { list: ['laptop_typ'] } }), { resolveCatalogVariables: async () => VARS }));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatch(/catalog_variables "laptop_typ" is not a variable \(or variable set\) of catalog item "Example Laptop"/);
  });

  it('live: an item the resolver does not find is a spec error; a pill item or a failed read falls back with a warning', async () => {
    expect((await errorsOf(generatePlan(gcvFlow('x'), { resolveCatalogVariables: async () => ({ error: `template_catalog_item ${ITEM} is neither a catalog item (sc_cat_item) nor a variable set (item_option_new_set) on the instance` }) }))).join('\n'))
      .toMatch(/step "vars" \(getCatalogVariables\): template_catalog_item c{32} is neither a catalog item/);
    const thrown = await generatePlan(gcvFlow('{{steps.vars.laptop_type}}'), { resolveCatalogVariables: async () => { throw new Error('read refused'); } });
    expect(thrown.warnings.join('\n')).toMatch(/could not be read \(read refused\)/);
    expect(thrown.pills.find(p => p.symbolic === 'steps.vars.laptop_type')?.type).toBe('string');
  });

  it('offline: unchanged — the pill is typed string with a warning', async () => {
    const plan = await generatePlan(gcvFlow('{{steps.vars.laptop_type}}'));
    expect(plan.pills.find(p => p.symbolic === 'steps.vars.laptop_type')?.type).toBe('string');
    expect(plan.warnings).toContain('pill steps.vars.laptop_type: step "vars" has no output "laptop_type"; typed as string');
  });
});
