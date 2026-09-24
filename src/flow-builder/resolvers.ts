/**
 * Instance resolvers for the generator (GeneratorExtras) — read-only Table-API queries through the
 * existing ServiceNowClient. Wired by the tool layer (src/tools/flow-builder.ts) for snow_flow_plan
 * with a live instance and for snow_flow_build / snow_flow_verify; offline plan / export never call them.
 *
 *   resolveSubflow(ref)       sys_hub_flow type=subflow by sys_id, or by name / internal_name (+ optional
 *                             scope) → sys_id + declared inputs / outputs (sys_hub_flow_input / _output:
 *                             internal_type, mandatory, order, default_value, reference). Missing,
 *                             ambiguous or not a subflow → {error} (a spec error, never a silent guess).
 *   resolveCustomAction(ref)  the same over sys_hub_action_type_definition + sys_hub_action_input / _output.
 *                             Inputs / outputs carry `hidden` when their attributes say visible=false or
 *                             visible_in_fd=false, and the definition carries its application scope.
 *   resolveActionType(action) the snapshot / definition ids a catalogue action gets on THIS instance:
 *                             1. the catalogue snapshot exists as a sys_hub_action_type_snapshot row → keep it
 *                                (PDI-FACTS §3: UI-built instances use it even where the definition's
 *                                latest_snapshot is newer — Get Catalog Variables' latest_snapshot does not even
 *                                exist) and take the definition from its parent_action;
 *                             2. otherwise the definition — by the catalogue definition id, or else by name, but
 *                                only a GLOBAL-scope definition whose name AND internal_name match the core
 *                                action and whose sys_hub_action_input elements cover every catalogue input (a
 *                                same-named scoped / custom action is never taken) — and its latest_snapshot,
 *                                when that snapshot row exists (+ a warning that says how it was found);
 *                             3. otherwise the catalogue values + a warning.
 *                             Cached per instance (client object) per process; a failed read is not cached.
 *   resolveInstanceTimeZone() the zone a glide_date_time trigger input (run_in) is read in: the authenticated user's
 *                             sys_user.time_zone when set, else sys_properties glide.sys.default.tz; unknown → {error}.
 *                             Both are always read; the user-over-system precedence is UNVERIFIED on a PDI, so
 *                             differing zones (and an unreadable user row) are warnings.
 *   resolveCatalogVariables(item)  Get Catalog Variables outputs: item_option_new (active) of the catalog item and of
 *                             its variable sets (io_set_item), or of the variable set itself, typed by question type
 *                             (catalogVariableType); neither an item nor a set → {error}.
 *
 * Owner: WRITER (tool wiring).
 */
import type { ServiceNowClient } from '../servicenow/client.js';
import type { DefinitionRef } from './spec/types.js';
import { findAction, storedInputName } from './catalog/actions.js';
import type { ActionTypeResolution, CatalogVariable, CatalogVariablesInfo, DefinitionError, DefinitionInfo, DefinitionVariable, GeneratorExtras, InstanceTimeZone } from './generator/index.js';
import { isKnownTimeZone } from './generator/values.js';
import { SYS_ID_RE } from './spec/schema.js';

type Rec = Record<string, unknown>;

/** A string from a Table-API field (plain value or a {value, display_value} / {link, value} object). */
export function fieldValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'value' in (v as Rec)) return String((v as Rec).value ?? '');
  return String(v);
}

/** Rows read per definition query: a name can legitimately match a few rows (then it is ambiguous). */
const NAME_MATCH_LIMIT = 10;
/** Upper bound for declared inputs / outputs of one definition. */
const VARIABLE_LIMIT = 1000;

const VARIABLE_FIELDS = 'sys_id,element,label,internal_type,mandatory,order,default_value,reference,attributes';

/**
 * The comma list `key=value,key=value` of a sys_hub_*_input attributes column (a plain object is accepted
 * too). Hidden in Flow Designer = visible=false or visible_in_fd=false (the catalogue's isHiddenInput rule).
 */
export function isHiddenByAttributes(raw: unknown): boolean {
  const attrs: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !('value' in (raw as Rec))) {
    for (const [k, v] of Object.entries(raw as Rec)) attrs[k.trim()] = String(v).trim();
  } else {
    for (const part of fieldValue(raw).split(',')) {
      const i = part.indexOf('=');
      if (i > 0) attrs[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return attrs.visible === 'false' || attrs.visible_in_fd === 'false';
}

interface DefinitionTables {
  /** What the definition is called in messages. */
  what: 'subflow' | 'custom action';
  table: 'sys_hub_flow' | 'sys_hub_action_type_definition';
  /** Extra encoded-query terms every lookup carries (type=subflow). */
  filter: string;
  inputs: 'sys_hub_flow_input' | 'sys_hub_action_input';
  outputs: 'sys_hub_flow_output' | 'sys_hub_action_output';
}

const SUBFLOW: DefinitionTables = { what: 'subflow', table: 'sys_hub_flow', filter: 'type=subflow', inputs: 'sys_hub_flow_input', outputs: 'sys_hub_flow_output' };
const CUSTOM_ACTION: DefinitionTables = { what: 'custom action', table: 'sys_hub_action_type_definition', filter: '', inputs: 'sys_hub_action_input', outputs: 'sys_hub_action_output' };

const DEF_FIELDS = 'sys_id,name,internal_name,type,sys_scope.scope';

function describeRow(r: Rec): string {
  const scope = fieldValue(r['sys_scope.scope']);
  return `${fieldValue(r.sys_id)} "${fieldValue(r.name)}"${scope ? ` (scope ${scope})` : ''}`;
}

/** A name that cannot be put into an encoded query without changing its meaning. */
function unsafeQueryValue(v: string): boolean {
  return /[\^\r\n]/.test(v) || /javascript:/i.test(v);
}

async function readVariables(client: ServiceNowClient, table: string, model: string, notes: string[], what: string): Promise<DefinitionVariable[]> {
  const r = await client.queryRecords({ table, query: `model=${model}`, fields: VARIABLE_FIELDS, limit: VARIABLE_LIMIT });
  const rows = r.records.map(x => x as Rec).map((row): DefinitionVariable => {
    const name = fieldValue(row.element);
    let type = fieldValue(row.internal_type);
    if (!type) { notes.push(`${what} "${name}" (${table} ${fieldValue(row.sys_id)}) has no internal_type — typed as string`); type = 'string'; }
    const order = Number(fieldValue(row.order));
    const v: DefinitionVariable = { name, type, sys_id: fieldValue(row.sys_id) };
    const label = fieldValue(row.label); if (label) v.label = label;
    const reference = fieldValue(row.reference); if (reference) v.reference = reference;
    if (fieldValue(row.mandatory) === 'true') v.mandatory = true;
    if (Number.isFinite(order) && fieldValue(row.order) !== '') v.order = order;
    const def = fieldValue(row.default_value); if (def) v.default = def;
    if (isHiddenByAttributes(row.attributes)) v.hidden = true;
    return v;
  }).filter(v => v.name);
  // definition order (the order column), then element name — the Table API order is not guaranteed
  return rows.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
}

async function resolveDefinitionRef(client: ServiceNowClient, t: DefinitionTables, ref: DefinitionRef): Promise<DefinitionInfo | DefinitionError> {
  let row: Rec | undefined;
  if ('sys_id' in ref) {
    const r = await client.queryRecords({ table: t.table, query: `sys_id=${ref.sys_id}`, fields: DEF_FIELDS, limit: 1 });
    row = r.records[0] as Rec | undefined;
    if (!row) return { error: `${t.what} ${ref.sys_id} was not found on the instance (${t.table})` };
    if (t === SUBFLOW && fieldValue(row.type) !== 'subflow') {
      return { error: `${t.table} ${describeRow(row)} is a ${fieldValue(row.type) || 'flow'}, not a subflow` };
    }
  } else {
    const name = ref.name;
    if (unsafeQueryValue(name) || (ref.scope !== undefined && unsafeQueryValue(ref.scope))) {
      return { error: `${t.what} name ${JSON.stringify(name)} cannot be looked up (it contains "^", a line break or "javascript:") — reference it by {sys_id}` };
    }
    const scopeTerm = ref.scope ? `^sys_scope.scope=${ref.scope}` : '';
    const byId = new Map<string, Rec>();
    // two plain queries instead of ^OR (whose binding differs between parsers): name, then internal_name
    for (const field of ['name', 'internal_name']) {
      const query = [t.filter, `${field}=${name}`].filter(Boolean).join('^') + scopeTerm;
      const r = await client.queryRecords({ table: t.table, query, fields: DEF_FIELDS, limit: NAME_MATCH_LIMIT });
      for (const x of r.records as Rec[]) byId.set(fieldValue(x.sys_id), x);
    }
    const matches = [...byId.values()];
    const where = `${ref.scope ? ` in scope ${ref.scope}` : ''}`;
    if (matches.length === 0) return { error: `${t.what} "${name}"${where} was not found on the instance (${t.table}${t.filter ? ` ${t.filter}` : ''}, by name or internal_name)` };
    if (matches.length > 1) {
      return { error: `${t.what} "${name}"${where} is ambiguous — ${matches.length} match on the instance: ${matches.map(describeRow).join(', ')}; reference it by {sys_id}${ref.scope ? '' : ' or add scope'}` };
    }
    row = matches[0];
  }
  const sysId = fieldValue(row.sys_id);
  const notes: string[] = [];
  const inputs = await readVariables(client, t.inputs, sysId, notes, `${t.what} input`);
  const outputs = await readVariables(client, t.outputs, sysId, notes, `${t.what} output`);
  const info: DefinitionInfo = { sys_id: sysId, name: fieldValue(row.name) || undefined, inputs, outputs };
  const scope = fieldValue(row['sys_scope.scope']);
  if (scope) info.scope = scope;
  if (notes.length) info.warnings = notes;
  return info;
}

/** resolveSubflow for the generator: sys_hub_flow type=subflow (+ sys_hub_flow_input / _output). */
export function makeSubflowResolver(client: ServiceNowClient): (ref: DefinitionRef) => Promise<DefinitionInfo | DefinitionError> {
  const memo = new Map<string, Promise<DefinitionInfo | DefinitionError>>();
  return ref => {
    const k = JSON.stringify(ref);
    if (!memo.has(k)) memo.set(k, resolveDefinitionRef(client, SUBFLOW, ref));
    return memo.get(k)!;
  };
}

/** resolveCustomAction for the generator: sys_hub_action_type_definition (+ sys_hub_action_input / _output). */
export function makeCustomActionResolver(client: ServiceNowClient): (ref: DefinitionRef) => Promise<DefinitionInfo | DefinitionError> {
  const memo = new Map<string, Promise<DefinitionInfo | DefinitionError>>();
  return ref => {
    const k = JSON.stringify(ref);
    if (!memo.has(k)) memo.set(k, resolveDefinitionRef(client, CUSTOM_ACTION, ref));
    return memo.get(k)!;
  };
}

// ─── catalogue action types ───────────────────────────────────────────────────

export interface CatalogActionRef { key: string; name: string; snapshot: string; definition: string }

/** Resolution + where it came from (source is informational; the generator reads snapshot/definition/warnings). */
export interface ActionTypeResult extends ActionTypeResolution { source: 'instance' | 'definition_latest_snapshot' | 'catalogue' }

let actionTypeCache = new WeakMap<object, Map<string, Promise<ActionTypeResult>>>();

/** Drop every cached action-type resolution (tests; or after instance definitions changed). */
export function clearActionTypeCache(): void {
  actionTypeCache = new WeakMap();
}

async function snapshotRow(client: ServiceNowClient, sysId: string): Promise<Rec | undefined> {
  const r = await client.queryRecords({ table: 'sys_hub_action_type_snapshot', query: `sys_id=${sysId}`, fields: 'sys_id,name,internal_name,parent_action', limit: 1 });
  return r.records[0] as Rec | undefined;
}

async function lookUpActionType(client: ServiceNowClient, a: CatalogActionRef): Promise<ActionTypeResult> {
  const warnings: string[] = [];
  // 1. the catalogue snapshot (what UI-built instances use on the PDI) exists → keep it
  const snap = await snapshotRow(client, a.snapshot);
  if (snap) {
    const rowName = fieldValue(snap.name);
    if (rowName && rowName !== a.name) warnings.push(`catalogue snapshot ${a.snapshot} is named "${rowName}" on the instance, not "${a.name}" — verify the catalogue entry`);
    const parent = fieldValue(snap.parent_action);
    let definition = a.definition;
    if (parent && parent !== a.definition) {
      // a reference without a known definition carries the snapshot id in both columns — the instance knows it
      if (a.definition !== a.snapshot) warnings.push(`snapshot ${a.snapshot} belongs to definition ${parent} on the instance, not the catalogue's ${a.definition} — using the instance value`);
      definition = parent;
    }
    return { snapshot: a.snapshot, definition, source: 'instance', ...(warnings.length ? { warnings } : {}) };
  }
  // 2. the definition and its latest_snapshot
  let def: Rec | undefined;
  let byName = '';
  if (a.definition !== a.snapshot) {
    const r = await client.queryRecords({ table: 'sys_hub_action_type_definition', query: `sys_id=${a.definition}`, fields: 'sys_id,name,latest_snapshot', limit: 1 });
    def = r.records[0] as Rec | undefined;
  }
  if (!def) {
    const found = await coreDefinitionByName(client, a, warnings);
    if (found) { def = found.row; byName = found.how; }
  }
  const latest = def ? fieldValue(def.latest_snapshot) : '';
  if (def && latest && await snapshotRow(client, latest)) {
    warnings.push(byName
      ? `catalogue snapshot ${a.snapshot} does not exist on the instance — using definition ${fieldValue(def.sys_id)} MATCHED BY NAME (${byName}; not the catalogue definition id) and its latest_snapshot ${latest}; verify it is the core action`
      : `catalogue snapshot ${a.snapshot} does not exist on the instance — using definition ${fieldValue(def.sys_id)}'s latest_snapshot ${latest}`);
    return { snapshot: latest, definition: fieldValue(def.sys_id), source: 'definition_latest_snapshot', warnings };
  }
  // 3. nothing usable on the instance → catalogue values
  warnings.push(`no sys_hub_action_type_snapshot row for catalogue snapshot ${a.snapshot}${def ? ` and definition ${fieldValue(def.sys_id)} has no existing latest_snapshot` : ' and no unique core definition found'} — the catalogue ids are kept; verify the action on the instance`);
  return { snapshot: a.snapshot, definition: a.definition, source: 'catalogue', warnings };
}

/** The internal_name a core action definition carries: its display name in snake case ("Send SMS" → send_sms). */
export function coreInternalName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Step 2's name fallback, restricted to the CORE definition: sys_scope=global AND name AND internal_name
 * (snake case of the name) must match, exactly one row, and its sys_hub_action_input elements must cover
 * every catalogue input (the step's values are encoded from the catalogue input list). Anything else →
 * undefined (the caller keeps the catalogue ids); a rejected candidate is explained in `warnings`.
 * A same-named scoped or custom action is never taken.
 */
async function coreDefinitionByName(client: ServiceNowClient, a: CatalogActionRef, warnings: string[]): Promise<{ row: Rec; how: string } | undefined> {
  const internal = coreInternalName(a.name);
  if (!internal || unsafeQueryValue(a.name)) return undefined;
  const catalogue = findAction(a.key);
  if (!catalogue) return undefined; // not a catalogue action: nothing to compare the inputs with — never guess
  const r = await client.queryRecords({
    table: 'sys_hub_action_type_definition', query: `sys_scope=global^name=${a.name}^internal_name=${internal}`,
    fields: 'sys_id,name,internal_name,latest_snapshot', limit: 2,
  });
  if (r.records.length !== 1) {
    if (r.records.length > 1) warnings.push(`more than one global definition is named "${a.name}" (internal_name ${internal}) — none is used`);
    return undefined;
  }
  const row = r.records[0] as Rec;
  const sysId = fieldValue(row.sys_id);
  const expected = catalogue.inputs.map(i => storedInputName(i.name));
  if (expected.length) {
    const inputs = await client.queryRecords({ table: 'sys_hub_action_input', query: `model=${sysId}`, fields: 'element', limit: VARIABLE_LIMIT });
    const declared = new Set(inputs.records.map(x => fieldValue((x as Rec).element)));
    const missing = expected.filter(n => !declared.has(n));
    if (missing.length) {
      warnings.push(`global definition ${sysId} "${a.name}" (internal_name ${internal}) matched by name but does not declare the catalogue input(s) ${missing.join(', ')} — not used`);
      return undefined;
    }
  }
  return { row, how: `global scope, name "${a.name}", internal_name ${internal}, inputs cover the catalogue's` };
}

/**
 * resolveActionType for the generator, cached per instance (the client object — instanceManager keeps
 * one per instance) per process. A read that throws is reported as a warning (catalogue values kept)
 * and is NOT cached, so the next plan / build asks again.
 */
export function makeActionTypeResolver(client: ServiceNowClient): (a: CatalogActionRef) => Promise<ActionTypeResult> {
  return async a => {
    let perInstance = actionTypeCache.get(client);
    if (!perInstance) { perInstance = new Map(); actionTypeCache.set(client, perInstance); }
    const key = `${a.key}|${a.snapshot}|${a.definition}`;
    let p = perInstance.get(key);
    if (!p) {
      p = lookUpActionType(client, a);
      perInstance.set(key, p);
    }
    try {
      return await p;
    } catch (e) {
      if (perInstance.get(key) === p) perInstance.delete(key);
      return {
        snapshot: a.snapshot, definition: a.definition, source: 'catalogue',
        warnings: [`the action type could not be read on the instance (${(e as Error).message}) — the catalogue ids are kept`],
      };
    }
  };
}

// ─── instance time zone (glide_date_time trigger inputs) ─────────────────────

/** The system property holding the instance's default time zone (used for users without a time_zone). */
export const DEFAULT_TZ_PROPERTY = 'glide.sys.default.tz';

/**
 * resolveInstanceTimeZone for the generator: the zone the platform reads a glide_date_time trigger input (run_in) in.
 * The authenticated user's sys_user.time_zone is used when set (and known to Intl); otherwise sys_properties
 * glide.sys.default.tz. Neither usable → {error} (never a guess: an ISO run_in then fails, a local one is not checked).
 * Both zones are always read: the user-over-system precedence is UNVERIFIED on a PDI (only "a user without a time_zone
 * gets the system zone" is proven — FORMAT-DECISIONS D17), so a user zone that differs from the system zone is a
 * warning naming both, and a user row that cannot be read (not found / ACL) is a warning too.
 * Read-only, once per resolver (one per plan / build / verify).
 */
export function makeInstanceTimeZoneResolver(client: ServiceNowClient): () => Promise<InstanceTimeZone | DefinitionError> {
  let memo: Promise<InstanceTimeZone | DefinitionError> | undefined;
  const run = async (): Promise<InstanceTimeZone | DefinitionError> => {
    const warnings: string[] = [];
    const username = client.getConfiguredUsername();
    let userZone = '';
    if (username && !unsafeQueryValue(username)) {
      const u = await client.queryRecords({ table: 'sys_user', query: `user_name=${username}`, fields: 'sys_id,user_name,time_zone', limit: 1 });
      const userRow = u.records[0] as Rec | undefined;
      if (!userRow) {
        warnings.push(`the sys_user row of ${username} was not found (missing, or not readable by this account) — its time_zone could not be read; ${DEFAULT_TZ_PROPERTY} is used`);
      }
      userZone = fieldValue(userRow?.time_zone).trim();
      if (userZone && !isKnownTimeZone(userZone)) {
        warnings.push(`sys_user.time_zone "${userZone}" of ${username} is not a known IANA zone — ${DEFAULT_TZ_PROPERTY} is used`);
        userZone = '';
      }
    } else {
      warnings.push(`the authenticated user is not known to the client (impersonation / per-user auth) — its sys_user.time_zone was not read; ${DEFAULT_TZ_PROPERTY} is used`);
    }
    let systemZone = '';
    try {
      const p = await client.queryRecords({ table: 'sys_properties', query: `name=${DEFAULT_TZ_PROPERTY}`, fields: 'name,value', limit: 1 });
      systemZone = fieldValue((p.records[0] as Rec | undefined)?.value).trim();
    } catch (e) {
      if (!userZone) throw e;
      warnings.push(`${DEFAULT_TZ_PROPERTY} could not be read (${(e as Error).message}) — the user zone "${userZone}" is used; UNVERIFIED on a PDI whether the platform reads run_in in the user zone or in the system zone`);
      return { zone: userZone, source: 'sys_user.time_zone', warnings };
    }
    if (userZone) {
      if (userZone !== systemZone) {
        const system = systemZone ? `${DEFAULT_TZ_PROPERTY} "${systemZone}"` : `${DEFAULT_TZ_PROPERTY} (not set)`;
        warnings.push(`the user zone sys_user.time_zone "${userZone}" of ${username} differs from the system zone ${system} — "${userZone}" (sys_user.time_zone) is used. UNVERIFIED: that the user zone wins over the system zone is not yet proven on a PDI, nor which zone applies when a different user activates the flow later in Workflow Studio; if the platform reads run_in in the other zone, the stored wall time and the future check are off by the offset between them — give the instance-local form "YYYY-MM-DD HH:MM:SS" to avoid the conversion`);
      }
      return { zone: userZone, source: 'sys_user.time_zone', ...(warnings.length ? { warnings } : {}) };
    }
    if (!systemZone) return { error: `the instance time zone is unknown (${DEFAULT_TZ_PROPERTY} is not set and the user has no time_zone)` };
    if (!isKnownTimeZone(systemZone)) return { error: `the instance time zone is unknown (${DEFAULT_TZ_PROPERTY} = "${systemZone}" is not a known IANA zone)` };
    return { zone: systemZone, source: 'glide.sys.default.tz', ...(warnings.length ? { warnings } : {}) };
  };
  return () => (memo ??= run());
}

// ─── catalog variables (Get Catalog Variables outputs) ───────────────────────

/**
 * Flow type of a catalog variable from its question type code (item_option_new.type):
 * 6 Single Line Text / 2 Multi Line Text / 16 Wide Single Line Text → string; 5 Select Box / 3 Multiple Choice → choice;
 * 7 CheckBox → boolean; 8 Reference → reference; 9 Date → glide_date; 10 Date/Time → glide_date_time;
 * 21 List Collector → glide_list; anything else → string.
 */
export function catalogVariableType(code: string): string {
  switch (code.trim()) {
    case '6': case '2': case '16': return 'string';
    case '5': case '3': return 'choice';
    case '7': return 'boolean';
    case '8': return 'reference';
    case '9': return 'glide_date';
    case '10': return 'glide_date_time';
    case '21': return 'glide_list';
    default: return 'string';
  }
}

const CATALOG_VARIABLE_FIELDS = 'sys_id,name,question_text,type,reference,order,variable_set,cat_item';
/** Upper bound for variables per item / set and for an item's variable sets. */
const CATALOG_LIMIT = 1000;
const SET_FIELDS = 'sys_id,name,internal_name,title,type';

function toCatalogVariable(row: Rec, variableSet?: string): CatalogVariable | undefined {
  const name = fieldValue(row.name).trim();
  if (!name) return undefined;
  const code = fieldValue(row.type);
  const v: CatalogVariable = { name, sys_id: fieldValue(row.sys_id), type: catalogVariableType(code), type_code: code };
  const label = fieldValue(row.question_text); if (label) v.label = label;
  const reference = fieldValue(row.reference); if (v.type === 'reference' && reference) v.reference = reference;
  if (variableSet) v.variable_set = variableSet;
  return v;
}

const byOrder = (a: Rec, b: Rec) => (Number(fieldValue(a.order)) || 0) - (Number(fieldValue(b.order)) || 0);

async function readCatalogVariables(client: ServiceNowClient, item: string): Promise<CatalogVariablesInfo | DefinitionError> {
  if (!SYS_ID_RE.test(item)) return { error: `template_catalog_item "${item}" is not a sys_id` };
  const warnings: string[] = [];
  const vars: CatalogVariable[] = [];
  const add = (v: CatalogVariable | undefined) => {
    if (!v) return;
    if (vars.some(x => x.name === v.name)) { warnings.push(`variable name "${v.name}" occurs twice (${v.sys_id}) — the first one is used`); return; }
    vars.push(v);
  };
  const cat = await client.queryRecords({ table: 'sc_cat_item', query: `sys_id=${item}`, fields: 'sys_id,name', limit: 1 });
  const catRow = cat.records[0] as Rec | undefined;
  if (catRow) {
    const own = await client.queryRecords({ table: 'item_option_new', query: `cat_item=${item}^active=true`, fields: CATALOG_VARIABLE_FIELDS, limit: CATALOG_LIMIT });
    for (const r of (own.records as Rec[]).sort(byOrder)) add(toCatalogVariable(r));
    const links = await client.queryRecords({ table: 'io_set_item', query: `sc_cat_item=${item}`, fields: 'variable_set,order', limit: CATALOG_LIMIT });
    const setIds = [...new Set((links.records as Rec[]).sort(byOrder).map(r => fieldValue(r.variable_set)).filter(id => SYS_ID_RE.test(id)))];
    if (setIds.length) {
      const sets = await client.queryRecords({ table: 'item_option_new_set', query: `sys_idIN${setIds.join(',')}`, fields: SET_FIELDS, limit: CATALOG_LIMIT });
      const setById = new Map((sets.records as Rec[]).map(r => [fieldValue(r.sys_id), r]));
      const isMultiRow = (id: string) => fieldValue(setById.get(id)?.type) === 'one_to_many';
      const singleRow = setIds.filter(id => setById.has(id) && !isMultiRow(id));
      const setRows = singleRow.length
        ? (await client.queryRecords({ table: 'item_option_new', query: `variable_setIN${singleRow.join(',')}^active=true`, fields: CATALOG_VARIABLE_FIELDS, limit: CATALOG_LIMIT })).records as Rec[]
        : [];
      // in the item's set order (io_set_item.order)
      for (const id of setIds) {
        const set = setById.get(id);
        if (!set) { warnings.push(`variable set ${id} (io_set_item) was not found — its variables are not outputs`); continue; }
        if (isMultiRow(id)) {
          // a multi-row variable set is ONE output (its rows), not its column variables
          const internal = fieldValue(set.internal_name) || fieldValue(set.name);
          add({ name: internal, sys_id: id, type: 'string', type_code: 'one_to_many', label: fieldValue(set.title) || fieldValue(set.name), variable_set: id });
          warnings.push(`multi-row variable set "${internal}" is one output (its rows) — typed "string"`);
          continue;
        }
        for (const r of setRows.filter(x => fieldValue(x.variable_set) === id).sort(byOrder)) add(toCatalogVariable(r, id));
      }
    }
    return { item, kind: 'catalog_item', name: fieldValue(catRow.name) || undefined, variables: vars, ...(warnings.length ? { warnings } : {}) };
  }
  const set = await client.queryRecords({ table: 'item_option_new_set', query: `sys_id=${item}`, fields: SET_FIELDS, limit: 1 });
  const setRow = set.records[0] as Rec | undefined;
  if (!setRow) return { error: `template_catalog_item ${item} is neither a catalog item (sc_cat_item) nor a variable set (item_option_new_set) on the instance` };
  const rows = await client.queryRecords({ table: 'item_option_new', query: `variable_set=${item}^active=true`, fields: CATALOG_VARIABLE_FIELDS, limit: CATALOG_LIMIT });
  for (const r of (rows.records as Rec[]).sort(byOrder)) add(toCatalogVariable(r, item));
  return { item, kind: 'variable_set', name: fieldValue(setRow.title) || fieldValue(setRow.name) || undefined, variables: vars, ...(warnings.length ? { warnings } : {}) };
}

/** resolveCatalogVariables for the generator (read-only; memoised per resolver, i.e. per plan / build / verify). */
export function makeCatalogVariablesResolver(client: ServiceNowClient): (item: string) => Promise<CatalogVariablesInfo | DefinitionError> {
  const memo = new Map<string, Promise<CatalogVariablesInfo | DefinitionError>>();
  return item => {
    if (!memo.has(item)) memo.set(item, readCatalogVariables(client, item));
    return memo.get(item)!;
  };
}

/** Every instance resolver the generator takes (pill typing is supplied by the caller). */
export function instanceResolvers(client: ServiceNowClient): Required<Pick<GeneratorExtras, 'resolveSubflow' | 'resolveCustomAction' | 'resolveActionType' | 'resolveInstanceTimeZone' | 'resolveCatalogVariables'>> {
  return {
    resolveSubflow: makeSubflowResolver(client),
    resolveCustomAction: makeCustomActionResolver(client),
    resolveActionType: makeActionTypeResolver(client),
    resolveInstanceTimeZone: makeInstanceTimeZoneResolver(client),
    resolveCatalogVariables: makeCatalogVariablesResolver(client),
  };
}
