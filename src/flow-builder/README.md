# Flow Builder (`src/flow-builder`)

Spec-driven construction of Flow Designer flows and subflows, written directly in the Flow Designer
platform format (the `sys_hub_*` records Workflow Studio stores). A `FlowSpec` (JSON, symbolic pills) is parsed, turned into a `RecordPlan`
(the exact `sys_hub_*` rows Flow Designer stores) and then either loaded straight into the instance
through the ServiceNow IDE loader (the default — no manual import), written over the Table API
(diagnostics only, see **Transports**), or serialised to XML for manual import.

```
spec (JSON) ──parseSpec──▶ FlowSpec ──generatePlan──▶ RecordPlan ──┬─ loadPlan ───▶ instance (POST api/fluent/load, capture by targetUpdateSetId)   ← default
                                                                  ├─ writePlan ──▶ instance (Table API + §2.2 preference capture)            ← diagnostics only
                                                                  ├─ planToRecordUpdateXml ──▶ <record_update> file
                                                                  └─ planToUnloadXml ─────────▶ Retrieved Update Set <unload> file
```

## Transports (`snow_flow_build transport`)

**PDI findings, 24 Sep 2026 (Australia Patch 5, ServiceNow IDE 4.4.4)** — why the default changed:

1. Table-API writes land every row with our client-supplied sys_ids, **but `sys_hub_flow.version` cannot be set over REST**:
   the write ACL `sys_hub_flow_base.version` (admin_overrides=false) silently drops it. The flow stays `version=1`; a PATCH to `2`
   returns 200 with `sys_mod_count` unchanged. With version 1 Flow Designer ignores the `*_v2` children, and the update-set
   serializer captures only the flow row plus `delete_multiple` for the LEGACY tables (`sys_hub_trigger_instance`,
   `sys_hub_action_instance`, `sys_hub_flow_logic`). **The Table-API transport cannot create a working flow.**
2. The flow row insert auto-creates a `sys_flow_cat_variable_model` row and a version record (after-insert business rules).
3. A UI session logged in as the same user rewrote the `sys_update_set` user preference a minute after the REST write (race) —
   preference-based capture is fragile whenever the owner also works in the UI.

**PDI-proven, 24 Sep 2026 (alias `product`) — the loader path works end to end through MCP:**

4. `POST api/fluent/load/global?targetUpdateSetId=<set>` with our own `planToRecordUpdateXml(plan)` as part `files` **accepts
   snow-mcp's HTTP Basic auth**. The flow row comes out `version=2` — **only the loader can set it** (the Table API never can: ACL
   `sys_hub_flow_base.version`, admin_overrides=false) — and the target set gets ONE `sys_update_xml` `sys_hub_flow_<id>` whose payload
   holds the flow + every `_v2` child.
5. `activate:true` (`activate_flows?sysparm_transaction_scope=global`) published the flow (status=published, active=true,
   latest/master snapshot set); a real P1 incident then ran it (`sys_flow_context` COMPLETE in 1.9 s, the Update Record step wrote the
   work note with its pill resolved).
6. **Finding 1 — activation capture leak.** `activate_flows` runs in the user's session and follows the user's update-set preference
   **for the global scope**, not `targetUpdateSetId`. On the PDI it re-pointed the preference to a colleague's global in-progress set and
   captured there: a second `sys_hub_flow_<id>` row (the published state, payload now with `sys_hub_flow_input` rows) and two
   `sys_documentation_var__m_sys_hub_flow_input_<flow id>_<element>_en` rows — moved by hand. **Fixed:** the loader path now sets
   `sys_update_set` / `apps.current_app` to the target set / flow scope **only around the activation** and restores them, moves the
   user's own new rows that still leak, and refuses what cannot be moved safely (see the contract below).
7. **Finding 2 — platform-managed flow inputs.** For a record-triggered flow the platform creates `sys_hub_flow_input` `current` and
   `table_name` (+ `sys_documentation`) with random sys_ids and re-creates them on activation. A second load was blocked by
   `FLOW_BUILDER_LOADER_WOULD_DELETE` (2 rows) because the loader turned them into a `sys_hub_flow_input model=<id>` cleanup. **Fixed:**
   they are `platformManaged` — never stale, never gated, never cleaned on their own account (FORMAT-DECISIONS **D16**).
8. The Table API omits a requested column that does not exist (e.g. `active` on `sys_hub_action_instance_v2`) — handled: an absent
   planned column is a warning, not a read-back mismatch.

| transport | how | capture | result |
|---|---|---|---|
| `loader` (**default**) — `writer/loader.ts` `loadPlan` | `POST api/fluent/load/<scopeId>?targetUpdateSetId=<update set sys_id>`, `multipart/form-data`, one part `files` = `sys_hub_flow_<id>.xml` (`application/xml`) whose content is exactly `planToRecordUpdateXml(plan)`. `scopeId` = `global` or the `sys_scope` sys_id. Same auth as every other call (`ServiceNowClient.postMultipart`, Basic/OAuth headers, no `sysparm_ck`). | load: by `targetUpdateSetId` — **no `sys_user_preference` read or write** (immune to the UI race); `activate:true`: `sys_update_set` / `apps.current_app` set **only around** `activate_flows` and restored (finding 1) | a version-2 flow Flow Designer uses (PDI-proven) |
| `table_api` — `writer/index.ts` `writePlan` | preference upsert + ordered Table-API POST/PATCH | `sys_user_preference sys_update_set` | **version 1, NOT usable by Flow Designer** — kept for non-flow experiments / diagnostics; its result and description carry `transport_warning` |

**Loader contract** (`loadPlan`; every error carries the full result or the call details):

- Before anything is sent (read-only): update set `in progress`, not `is_default`, application = flow's application; a **scoped** flow is
  refused (`FLOW_BUILDER_LOADER_SCOPED_REFUSED`) until the scoped path is proven on a PDI (global flows only for now); `mode:'create'`
  refuses existing rows (`FLOW_BUILDER_ROWS_EXIST`); an ACTIVE existing flow is refused unless `allow_deactivate`
  (`FLOW_BUILDER_FLOW_ACTIVE`); `activate:true` resolves the preference owner (configured username → `sys_user`, read-only) here, so
  `FLOW_BUILDER_USER_UNRESOLVED` refuses before sending. The loader applies the document's `delete_multiple` elements **itself**
  (`flow=<id>^sys_idNOT IN<planned>` per populated child table, plus `flow=<id>` / `model=<id>` for a child table the spec now leaves
  EMPTY but that still holds rows of the flow — `cleanedTables`), so every existing child row they would remove must be listed in
  `confirm_delete` with `delete_stale:true` — otherwise `FLOW_BUILDER_LOADER_WOULD_DELETE` and nothing is sent (never an implicit delete).
  **Platform-managed rows (finding 2, D16):** for a record-triggered flow the `sys_hub_flow_input` rows `current` / `table_name` and their
  `sys_documentation` are set aside first — never stale, never confirmation-gated, and they never make `sys_hub_flow_input` a cleaned
  table; reported in `platformManaged` (`classification:'platform_managed'`, fate `kept`, `created_by_load`, or `deleted_by_load` when a
  confirmed cleanup of OTHER unplanned input rows also removes them — the platform re-creates them on activation).
  The housekeeping delete `sys_hub_alias_mapping source_id=<planned action/subflow instance>` (the platform's own capture of a flow carries one per action instance — PDI `flows/leaver-flow`) is **not** confirmation-gated
  (it only touches alias rows of our own planned instances); the rows it will remove are counted before the load and reported as
  `housekeepingDeletes` (+ a warning).
  `sys_scope` is written as a reference element: `display_value="<scope NAME>"`, text = the `sys_scope` sys_id (the platform capture writes `display_value="Global"` / `global`).
- Response mapping: 404, or 400 "does not represent any resource" → `FLOW_BUILDER_LOADER_UNAVAILABLE`; 401/403 →
  `FLOW_BUILDER_LOADER_AUTH_REFUSED` (the endpoint refused Basic/OAuth or the role); any other non-2xx, a 2xx carrying
  `result.error`, a 2xx **without a JSON body** (an SSO / login page), a missing `result.targetUpdateSetId` or one that is not the target
  set → `FLOW_BUILDER_LOADER_FAILED` with the body; a transport failure/timeout (300 s, our timeout for a load that compiles server-side; the timer covers the
  response body too) → `FLOW_BUILDER_LOADER_FAILED` ("may or may not have been applied — run snow_flow_verify"). No retry.
- Verification by read-back — **errors, never warnings**: every planned row exists by sys_id (`FLOW_BUILDER_LOADER_ROWS_MISSING`);
  `sys_hub_flow.version === '2'` (`FLOW_BUILDER_LOADER_VERSION_MISMATCH`); ONE `sys_update_xml` `sys_hub_flow_<id>` in the target set
  whose payload holds every planned sys_id (`FLOW_BUILDER_CAPTURE_NOT_VERIFIED`, same checker as the Table-API writer); that row
  **changed during this load** — new, or `sys_updated_on` / `payload_hash` / `sys_mod_count` differ from the value recorded before the POST
  (`FLOW_BUILDER_LOADER_NOT_APPLIED`; without it an earlier load into the same set passes for this one); `mode:'update'`: every planned
  field equals the instance (`planFieldDiffs`, the verifier's comparison — `FLOW_BUILDER_LOADER_READBACK_MISMATCH`); no unplanned row left in
  a `flow=`/`model=` child table (`FLOW_BUILDER_LOADER_STALE_ROWS`; platform-managed rows excluded). Stale `sys_documentation` rows
  (not flow-keyed) stay a warning.
  Reported: `existedBefore` / `deleted` / `stale` / `platformManaged`, `cleanedTables`, `housekeepingDeletes`, `captureRow {before, after, changed}`,
  `fieldDiffs`, `flowState`, `loader` (path, scopeId, file, delete_multiple list, HTTP status, response), `preferences: []` + `preferencesNote`
  (+ `activationPreferences` with `activate:true`).
  Open question for the PDI: whether the loader re-serialises the capture row when the spec is **identical** to the last load — if not,
  an identical re-load reports `FLOW_BUILDER_LOADER_NOT_APPLIED` (fail-closed; nothing needed loading).
- `activate:true` (needs `FLOW_BUILDER_ACTIVATE_ENABLED`) runs only after a verified load. **This is the only place the loader path touches
  `sys_user_preference`** (finding 1 — `activate_flows` has no `targetUpdateSetId` and captures where the user's global update-set preference
  points):
  1. record the target set's `sys_hub_flow_<id>` row and every `sys_update_xml` row OUTSIDE the target set that can belong to the flow
     (`sys_hub_flow_<id>`, `sys_hub_flow_snapshot_<snap>` / `sys_hub_flow_<snap>`, `var__m_sys_hub_flow_<variable|input|output>_<id>*`,
     `sys_documentation_var__m_sys_hub_flow_<…>_<id>*`, the planned rows' per-row names);
  2. read the user's `sys_update_set` and `apps.current_app`, set them to the target set and the flow scope (`global` for a global flow);
  3. `activateFlow` (activate_flows + mandatory read-back);
  4. **always** restore both preferences to exactly their previous state (value written back / row re-created / the row created for the
     activation deleted) and read them back — `activationPreferences` `{user, entries:[{name, before, set, restore, after, restored}], restored}`;
     a preference that cannot be restored → `FLOW_BUILDER_PREFERENCE_NOT_RESTORED` (after the capture checks); a preference that cannot be
     SET → `FLOW_BUILDER_ACTIVATION_PREFERENCE_FAILED` and activate_flows is never called;
  5. safety net: rows of those families in ANY other set that are **new since step 1, created by the authenticated user and created at or
     after the activation watermark** (`activationCapture.watermark`: an instance-side time — the load's capture-row `sys_updated_on`, raised
     to the preference writes' `sys_updated_on`) are moved into the target set (`PATCH sys_update_xml.update_set`, each move in
     `activationCapture.moved` + a warning). A row that pre-existed in another set (and was re-written), was created by someone else, was
     created before the watermark, or whose move is refused is **never** moved: `activationCapture.leaks` (`reason` `pre_existing` /
     `created_by_other_user` / `created_before_activation` / `move_failed`) → `FLOW_BUILDER_CAPTURE_NOT_VERIFIED` listing it. Each safety-net
     query reads one page of `SAFETY_NET_PAGE` (200) rows; a **full** page (`activationCapture.truncated`) fails closed — before activation
     it refuses the activation with no preference write, after activation it moves nothing (`FLOW_BUILDER_CAPTURE_NOT_VERIFIED`);
  6. a name held twice in the TARGET set (load row + activation row) keeps the newer row and deletes the superseded older one — in the target
     set only (`activationCapture.duplicatesRemoved`; a refused delete is a warning). For the parent row `sys_hub_flow_<id>` the kept row's
     payload is read **before** any delete: it must hold every planned sys_id and, when the read-back says active, `<active>true</active>` on
     `sys_hub_flow`; otherwise nothing is deleted, both rows stay (`activationCapture.duplicatesRefused`) → `FLOW_BUILDER_CAPTURE_NOT_VERIFIED`;
  7. the target set's `sys_hub_flow_<id>` row must have changed during activation, show `<active>true</active>` on the `sys_hub_flow` element
     (when the read-back says active) and still hold every planned row — otherwise `FLOW_BUILDER_CAPTURE_NOT_VERIFIED`.
- **PDI-proven (24 Sep 2026):** the loader round trip with Basic auth (`FLOW_BUILDER_LOADER_AUTH_REFUSED` stays the mapping for a 401/403 on
  other instances), version 2, the single capture row, activation + a real run, and the two findings above (the fixes are unit-tested on the fake
  client; their first PDI re-run is pending). Still open: whether the loader re-serialises the capture row when the spec is **identical** to the
  last load (fail-closed: `FLOW_BUILDER_LOADER_NOT_APPLIED`), and scoped flows (refused until proven). Unit tests assert that neither the errors
  (message, details, stack) nor the log ever carry `Basic `, the password, its base64 form or a bearer token.

## Module map and ownership

| Path | Role | Owner | State |
|---|---|---|---|
| `spec/schema.ts` | zod FlowSpec v1 (every trigger / step / value form), `parseSpec()` | SCAFFOLD | **done** |
| `spec/types.ts` | TS types: spec (inferred), `RecordRow` / `RecordPlan` / `GenerateOptions`, writer & verify results, catalogue types | SCAFFOLD | **done** |
| `ids.ts` | `sysIdFor(flowKey, elementKey)` (sha256-derived, 32 hex), `sysIdToUuid`, `uuidToSysId`, `ELEMENT_KEYS` | SCAFFOLD | **done** |
| `encode.ts` | `gzipB64` / `unB64Gzip` / `encodeValues` / `decodeValues` (node:zlib, normalised gzip header) | SCAFFOLD | **done** |
| `pills.ts` | `parsePill`, `pillsInText`, `toPlatformPill`, `rewritePills` | SCAFFOLD → **GENERATOR** | **done** |
| `labels.ts` | `buildLabelCache` (label_cache entries), `labelCase` | SCAFFOLD → **GENERATOR** | **done** |
| `catalog/{triggers,actions,logic}.ts`, `catalog/data/*.json`, `catalog/source/*.json` | platform sys_ids and input/output definitions (generated by `scripts/build-flow-catalog.mjs` from instance metadata exports — see [Catalogue](#catalogue)), generic trigger descriptors, UI-captured descriptors | **GENERATOR** | **done** |
| `generator/**` | `generatePlan(spec, opts)`, `readCatalog(name?)`, validator, value encoders, stages, error handler | **GENERATOR** | **done** — record format and decisions D1-D18 in [`FORMAT-DECISIONS.md`](FORMAT-DECISIONS.md) |
| `xml/record-update.ts` | `planToRecordUpdateXml(plan, opts?)` (`opts.scope` = reference-element `sys_scope`, `opts.cleanTables` = cleanup of emptied child tables — both used by the loader only); `escapeXmlText` / `escapeXmlAttr` | **GENERATOR** (options: WRITER) | **done** |
| `xml/unload.ts` | `planToUnloadXml(plan, { updateSetName, description? })` | **WRITER** | **done** |
| `writer/index.ts` | `writePlan` (Table API, diagnostics), `verifyFlow`, `planFieldDiffs`, `describeCaptureProtocol`, shared checks (`resolveUpdateSet`, `resolveScope`, `assertUpdateSetMatchesScope`, `checkActiveFlow`, `childRowsOnInstance`, `verifyCapture`, `activateFlow`) | **WRITER** | **done** |
| `writer/loader.ts` | `loadPlan` (ServiceNow IDE loader — the default transport), `describeLoadProtocol`, `isRecordTriggeredFlow` | **WRITER** | **done** — PDI round trip proven 24 Sep 2026 (Basic auth, version 2, capture, activation, real run); findings 1-2 fixed and unit-tested on the fake client |
| `resolvers.ts` | read-only instance resolvers for the generator: `makeSubflowResolver` / `makeCustomActionResolver` (by sys_id or name / internal_name + scope → sys_id + typed inputs / outputs; missing, ambiguous or not-a-subflow = spec error), `makeActionTypeResolver` (catalogue snapshot if it exists + `parent_action`, else the definition's existing `latest_snapshot` — the definition by the catalogue id, or by name only when it is the core one: `sys_scope=global`, name AND internal_name match, and its `sys_hub_action_input` elements cover the catalogue inputs; a same-named scoped/custom action is never taken, and a name match is said in the warning — else catalogue ids; cached per instance per process, failed reads not cached), `makeInstanceTimeZoneResolver` (the zone a glide_date_time trigger input is read in: the authenticated user's `sys_user.time_zone`, else `glide.sys.default.tz`; unknown = `{error}`), `makeCatalogVariablesResolver` + `catalogVariableType` (Get Catalog Variables outputs from `item_option_new` / `io_set_item`, typed by question type), `instanceResolvers`, `clearActionTypeCache` | WRITER (tool wiring) | **done** — unit-tested on the fake client |
| `guards.ts` | instance policy (allow list + deny pattern, deny wins), client re-resolution, export-root confinement | SCAFFOLD | **done** |
| `src/utils/permissions.ts` | `requireFlowBuilder`, `requireFlowBuilderActivate`, `isFlowBuilder*Enabled` | SCAFFOLD | **done** |
| `src/tools/flow-builder.ts` | the five tools (manifest + dispatcher), argument validation, decode-for-review, dictionary pill typing | SCAFFOLD → WRITER | **done** |
| `src/tools/flow.ts` | legacy write tools deprecated; subflow reads → `sys_hub_flow type=subflow`; action index → `sys_hub_action_type_definition` | SCAFFOLD | **done** |
| `tests/flow-builder/**` | each owner tests its own modules; fixtures under `tests/flow-builder/fixtures/pdi` (read-only PDI captures), construct specs under `tests/flow-builder/specs` | all | **done**; `tests/flow-builder/e2e/dry-run.test.ts` runs every tool end to end through `routeToolInvocation` on a fake client |

All modules are implemented. What still needs the PDI write experiments (P4-P6) is listed in
`FORMAT-DECISIONS.md` and in the build reports. The 24 Sep PDI write experiment proved the Table-API transport cannot
produce a usable flow and that the loader transport can (see **Transports**).

## Fixed interfaces (implement exactly — from the build brief)

```ts
// spec → plan
export function parseSpec(input: unknown): { spec: FlowSpec } | { errors: {path: string; message: string}[] };
export interface RecordRow { table: string; sys_id: string; fields: Record<string, string | number | boolean>; }
export interface RecordPlan {
  flowKey: string; flow: RecordRow; trigger?: RecordRow; variables: RecordRow[]; documentation: RecordRow[];
  stages: RecordRow[]; instances: RecordRow[]; // ordered: write order == array order
  labelCache: unknown; pills: { symbolic: string; platform: string; type: string }[];
  warnings: string[];
}
export interface GenerateOptions { resolvePillType?: (table: string, path: string) => Promise<string | undefined>; }
export function generatePlan(spec: FlowSpec, opts?: GenerateOptions): Promise<RecordPlan>;
export function decodeValues(b64gz: string): unknown; export function encodeValues(v: unknown): string;
export function planToRecordUpdateXml(plan: RecordPlan): string;          // the <record_update> document the loader applies
export function planToUnloadXml(plan: RecordPlan, opts: { updateSetName: string; description?: string }): string; // Retrieved Update Set
// writer
export interface WriteOptions { updateSet: { sys_id?: string; name?: string }; mode: 'create'|'update'; activate: boolean; deleteStale: boolean; confirmDelete: string[]; }
export function writePlan(client: ServiceNowClient, plan: RecordPlan, opts: WriteOptions): Promise<WriteResult>;
export function verifyFlow(client: ServiceNowClient, flowSysId: string, plan?: RecordPlan): Promise<VerifyResult>;
```

`WriteResult` / `VerifyResult` / `CatalogEntry` / `LabelCacheEntry` / `PillEntry` are defined in `spec/types.ts`;
extend them additively (never remove a field the tool file already returns).

## Module contracts

### `parseSpec` (done)
Structural validation only: shape (strict objects — unknown keys are errors), `spec_version: "1"`,
pill syntax in every `{{...}}` token and `{pill}` value, key uniqueness across the whole tree
(flow / trigger / steps / branches / error handler), variable / subflow-input / output / stage
existence, `exit_loop` / `skip_iteration` only inside `for_each` / `do_until`,
`assign_subflow_outputs` only in a subflow, wait-step cross-field rules, subflow ⇔ no trigger,
flow ⇔ no inputs/outputs, error handler only on flows. Defaults applied: `flow.scope='global'`,
`flow.type='flow'`, `flow.run_as='user'` (the `sys_hub_flow_base.run_as` dictionary default),
`inputs={}` on action/custom_action/subflow steps, `wait_for_completion=true`, `wait.duration_type='explicit'`,
`error_handler.key='error_handler'`. Catalogue semantics (unknown action, mandatory inputs, pill
typing, forward references, else/else_if adjacency, end_flow placement, caps) are GENERATOR's validator.

### Symbolic pill grammar (spec side)
`trigger.<output>[.f…]` · `steps.<key>.<Output>[.f…]` (Output case-sensitive: `Record`, `Records`, `approval_state`, `Catalog Task`) ·
`loop.<key>.item[.f…]` · `vars.<name>[.f…]` · `inputs.<name>[.f…]` (subflows) · `error.<name>` · `static.<sys_id>`.
`parsePill()` returns the `ParsedPill` union. Platform forms are documented in `pills.ts`.

### Value grammar (`ValueSchema`)
`string | number | boolean | {pill} | {text} | {template:{field:Value}} | {conditions} | {reference, display?, table?} |
{approval_rules:{rule_sets:[{action, rules:[[{rule, users?, groups?, manual?}]]}]}} | {duration} | {list:[…]} | {script}`.
Encoders (GENERATOR): `{text}` → pill rewrite; `{template}` → `'a=1^b={{pill}}^EQ'`; `{approval_rules}` →
`'ApprovesAnyG[{{…}}]'` grammar (rule_sets `Or`, rules `&`, conditions `|`, Any|All|Res|n#|n% [+M] U[..] G[..]; plain sys_id → `{{static.<id>}}`);
`{duration}` → glide_duration; `{list}` → glide_list / slushbucket (a `{list}` of `{template}` object literals appends several objects to an
array.object variable — the only place a `{template}` list item is valid); `{reference}` inside `{template}` → `{"display","value"}` JSON, as UI-built flows store it (PDI-FACTS §8).
**Template injection guard:** a `"^"` in any literal part of a `{template}` value (scalar, `{text}`, `{conditions}`, `{reference}` display, `{list}` item)
is rejected by the schema (`FLOW_BUILDER_INVALID_SPEC`) and again by `encodeTemplate` — otherwise `work_notes:'x^priority=1'` would also set `priority`.
Use a `{script}` sub-value when a literal `^` is really needed.

### `generatePlan` (GENERATOR)
Pure apart from `opts.resolvePillType` and the `GeneratorExtras` resolvers `resolveSubflow` / `resolveCustomAction` / `resolveActionType` / `resolveInstanceTimeZone` / `resolveCatalogVariables` (+ the `now` clock)
(reads; `resolvers.ts` supplies them for a live instance — a resolver `{error}` becomes a spec error, a resolved definition is authoritative:
unknown inputs and missing mandatory inputs without a default are errors; inputs hidden in Flow Designer (`attributes` visible=false / visible_in_fd=false) are never "missing" and cannot be set; a definition in another application scope than the flow is a warning). Deterministic ids via `ids.ts` (`ELEMENT_KEYS`), or `flow.sys_id` when the spec adopts an existing flow.
Flat 1-based `order` assigned depth-first (children right after their block; stages consume none; do_in_parallel children `'<parent>➛<n>'`);
`parent_ui_id` = enclosing block's `ui_id` (`''` present on action/subflow rows, absent on top-level logic rows). Default/hidden inputs merged
from the catalogue in definition order. Extra logic columns: `flow_variables_assigned` (set/append) and `outputs_assigned` (assign_subflow_outputs).
Stages: `component_indexes` / `stage_id` / `states` / `duration` (`'1970-01-01 00:00:00'` + duration) / `ancestor_*`. Trigger descriptors carry the full
entry shape incl. `valueSysId:''` on glide_list entries. `label_cache` via `labels.ts` (records pills carry `column_name`, flow-variable pills
`reference_table` / `reference_display`, loop items `'<n> - For Each - ➛item➛<Field>'`). `sys_hub_flow.generation_source = GENERATION_SOURCE`.
Pill types: catalogue outputs, spec variable types, **`flow.pill_types`** (`{"trigger.current.assignment_group": "reference"}` — symbolic pill → type,
authoritative, consulted before the resolver) or `resolvePillType(table, dottedPath)`; when none, warn and fall back to `string`.
**Approver slots fail closed:** a pill in a user/group slot of `{approval_rules}` whose type cannot be verified (offline, failed dictionary walk,
unknown target) is a semantic error under the default `approverPillPolicy:'error'` (build and export — export is always offline, so declare
`flow.pill_types`). `snow_flow_plan` uses `'report'`: the pills are listed in `plan.unverifiedApprovers` / `unverified_approvers` and `ok:false`.
`plan.instances` order **is** the write order.

### `readCatalog(name?)` (GENERATOR)
Offline; returns `CatalogEntry[]` (kind, name, sys_id, type, inputs `{name,type,label?,mandatory?,default?,reference?,hidden?,choices?}`, outputs).

### `writePlan` (WRITER, transport `table_api` — diagnostics only) — see the header of `writer/index.ts`
Refuse a target update set that is not `in progress` or has `is_default=true`, or whose `application` is not the flow's application
(`FLOW_BUILDER_UPDATE_SET_SCOPE_MISMATCH`, before any write); run the read-only existence pre-check BEFORE the preference upsert; in
`mode:'update'` refuse an existing ACTIVE flow (`FLOW_BUILDER_FLOW_ACTIVE`) unless `allowDeactivate` (`allow_deactivate:true`) — the planned
row is draft/inactive; derive the user from the **authenticated session**
(never a tool argument); upsert `sys_user_preference` `sys_update_set` (+ `apps.current_app` when scope ≠ global); write in dependency
order; capture gate accepts N rows **or** one parent `sys_hub_flow_<id>` row containing the children; STALE rows reported, deleted only with
`deleteStale && confirmDelete.includes(sys_id)`; `activate:true` → POST `api/now/wfa_fluent/activate_flows?sysparm_transaction_scope=<scope>`
then mandatory read-back of `sys_hub_flow.active/status/latest_snapshot` (+ re-verify `sys_update_xml`). Needs a public `requestJson()` on
`ServiceNowClient` (WRITER adds it; `request()` is private) and a way to read the configured username (e.g. `getConfiguredUsername()`).

### `verifyFlow` (WRITER)
Read-only. `describeCaptureProtocol(plan, updateSet)` (done) is what `snow_flow_plan` shows as "the exact §2.2 steps".

### `planToUnloadXml` (WRITER — done)
Envelope mirrored from a genuine Retrieved Update Set export: `sys_remote_update_set` (state=loaded, application/application_scope, remote_sys_id…)
+ **one** `sys_update_xml` for the whole flow, exactly as the platform captures a UI-built flow (PDI fixture `flows/leaver-flow`):
`name=sys_hub_flow_<id>`, `type=Flow`, `table` empty, `target_name=<flow name>`, `payload` = `<record_update sys_domain="global" table="sys_hub_flow">`
holding the flow row then, per child table in the platform's order, a `delete_multiple` (`flow=<id>^sys_idNOT IN…` / `model=<id>^sys_idNOT IN…`) and the rows;
fields alphabetical, CDATA where the text carries markup/newlines. `apply_defaults` never emitted (and stripped from foreign payloads); no `.split/.end_split`.
Generated values: `payload_hash` = Java `String.hashCode` of the payload (signed 32-bit, the form in exports); `update_guid` = first 32 hex of sha256(payload)
(a modified flow re-imports as a new update); `sys_recorded_at` = hex(epoch_ms << 4) + `000001`; envelope sys_ids deterministic from `flowKey`.
Scoped flows carry the plan's `sys_scope` as the application — keep flows for the manual / no-REST channel global.

### `writePlan` / `verifyFlow` (WRITER — done)
Capture gate: the PDI form is ONE `sys_update_xml` row `sys_hub_flow_<id>` whose payload lists every planned `<sys_id>`; rows the payload does not cover are
looked up in the per-row form (`<table>_<sys_id>`), and a `sys_hub_flow_<id>` row in another update set is reported as a preference leak. `mode:'create'`
refuses when any planned sys_id already exists; a POST whose returned sys_id differs from the client-supplied one aborts. `stale` = rows still on the instance
after the call; `deleted` = rows removed (only with `deleteStale` + `confirmDelete`). Activation: `POST api/now/wfa_fluent/activate_flows?sysparm_transaction_scope=<scope>`
with `{flows:[{sys_id,active:'',state:''}],actions:[]}`; 200/422 keep the result body, 400/404 = endpoint absent; the read-back of `sys_hub_flow.active` decides,
and `snow_flow_build` throws `FLOW_BUILDER_ACTIVATION_FAILED` (details = the full write result) unless `active='true'`. An unverified capture
(before or after activation) throws `FLOW_BUILDER_CAPTURE_NOT_VERIFIED` from `writePlan` (details = the full write result); activation is never
attempted on an uncaptured flow. Client additions: `requestJson()`, `postMultipart()` (the loader's multipart POST — same auth
headers, no Content-Type so fetch sets the boundary, no retry, returns `{status, ok, statusText, json|text}` instead of throwing on a
non-2xx) and `getConfiguredUsername()` on `ServiceNowClient` (the §2.2 user is derived from the session, never from an argument).

## Scheduled triggers and time zones (PDI finding, 24 Sep 2026 — FORMAT-DECISIONS D17)

Two different date/time types sit in the scheduled trigger descriptors, and the platform treats them differently:

| trigger input | type | stored | read by the platform in |
|---|---|---|---|
| Daily / Weekly / Monthly `time` | `glide_time` | `1970-01-01 HH:MM:SS` **converted to UTC** (glide_time values are stored in UTC; the spec `timezone` names the zone of `time`, default UTC — `08:00:00` Europe/Sofia → `06:00:00`) | UTC (the zone was applied when the value was written) |
| Run Once `run_in` | `glide_date_time` | `YYYY-MM-DD HH:MM:SS` **as given**, value == displayValue — no conversion | the **instance time zone**: the system property `glide.sys.default.tz` (PDI-proven for a user without `time_zone`); the builder uses the authenticated user's `sys_user.time_zone` when set — that precedence is **unverified** (see below) |

Live PDI (`glide.sys.default.tz` = Europe/Brussels): a `run_in` written as a UTC wall time was already past in Brussels, and the
flow **fired immediately on activation**. `run_in` is the only `glide_date_time` input in the trigger catalogue (`triggers.json`); every
catalogue trigger input of that type goes through the same logic (custom triggers are untyped and are not converted).

- `run_in: "YYYY-MM-DD HH:MM:SS"` — instance-local, stored as given (unchanged behaviour).
- `run_in: "<ISO-8601 instant>"` with `Z` or an offset (`2026-09-24T14:48:00Z`, `2026-09-24T16:48+02:00`; seconds optional, no fractions) —
  a live `snow_flow_plan` / `snow_flow_build` / `snow_flow_verify` reads the zone (`sys_user.time_zone` of the authenticated user when set,
  else `sys_properties` `glide.sys.default.tz`; both are always read, read-only, once per call) and stores the wall time of that instant in the zone (`Intl`, DST-correct:
  Brussels +02:00 in summer, +01:00 in winter). Offline (plan without an instance, export) an ISO value is a **spec error** asking for an
  instance or the local form; so is an ISO value when the zone cannot be determined (no property, no user zone, or an unknown IANA name).
- With the zone known, the instance's current wall time is computed (this machine's clock, in that zone) and a `run_in` that is **not strictly
  later** is a plan **warning** (`date_time_inputs[].in_future:false`, `past_run_note`) and a build **refusal** (`FLOW_BUILDER_RUN_IN_PAST`,
  nothing written) unless `allow_past_run:true`. A local value in a DST gap (does not exist) or overlap (occurs twice) is warned about;
  when the zone is unknown a local value is stored but reported as unchecked. `timezone` on a run_once trigger is ignored (warning).
- An ISO instant that converts to a wall time in a DST **overlap** (the repeated hour) is warned about: the stored wall time cannot say which
  occurrence is meant. The future check judges the stored wall time — strictly later than the instance's wall time now AND its **earliest**
  reading in the future — so `in_future:true` never appears with `local <= instance_now`.
- **Unverified — user zone vs system zone.** Only "a user without `time_zone` gets `glide.sys.default.tz`" is PDI-proven. Whether the
  platform reads `run_in` in the activating user's session zone or in the system zone — and whose zone applies when a different person
  activates the flow later in Workflow Studio — is not. When the authenticated user's `sys_user.time_zone` is set and differs from
  `glide.sys.default.tz`, the plan warns, naming both zones and the one used; a `sys_user` row that is not found (missing / ACL) is a warning too
  (the system zone is then used). Give the instance-local form to avoid the conversion when in doubt.

**PDI re-run checklist (open items):**
1. `run_in` with a user whose `sys_user.time_zone` differs from `glide.sys.default.tz`: an ISO value converted in the user zone — does the
   flow fire at that instant, or offset by the difference between the zones?
2. The same flow activated later in Workflow Studio by a different user (another `time_zone`, or none): whose zone does the schedule use?
3. `catalog_variables` given as names / a variable-set sys_id on a live build: the stored slushbucket holds `<sys_id>:item_option_new` /
   `<set sys_id>:item_option_new_set` and the step outputs exactly the selection at runtime.

## Get Catalog Variables outputs (PDI finding — FORMAT-DECISIONS D18)

The catalogue lists no outputs for `getCatalogVariables`: they are the variables of its `template_catalog_item`, addressed as
`{{steps.<key>.<variable_name>}}`. Offline such a pill stays `string` with a warning (unchanged). With an instance (live plan, build,
verify) `resolveCatalogVariables` reads the item (`sc_cat_item`) and its active variables (`item_option_new cat_item=<id>^active=true`), the
single-row variable sets attached through `io_set_item` (their variables, in set order), a multi-row set as ONE output (typed `string`, warning),
or — when the template is a variable set (`item_option_new_set`) — the set's own variables. Each output is typed from the question type:

| code | question type | flow type |
|---|---|---|
| 6 / 2 / 16 | Single Line Text / Multi Line Text / Wide Single Line Text | `string` |
| 5 / 3 | Select Box / Multiple Choice | `choice` |
| 7 | CheckBox | `boolean` |
| 8 | Reference | `reference` (+ the variable's `reference` table: `steps.<key>.<var>.<field>` walks the dictionary) |
| 9 / 10 | Date / Date/Time | `glide_date` / `glide_date_time` |
| 21 | List Collector | `glide_list` |
| other | — | `string` |

A name that is not a variable of the item — or, when the step sets `catalog_variables` (`{list}` of variable / variable-set sys_ids or
names), not in that selection — is a **spec error listing the valid names**. Live, every `catalog_variables` entry is written in the platform
slushbucket form (PDI-FACTS §8): a variable (by sys_id or **name**) → `<variable sys_id>:item_option_new`, a variable set (by its sys_id,
incl. a multi-row set) → `<set sys_id>:item_option_new_set`. Offline (or when the item is a pill / cannot be read) names cannot be
resolved: a `catalog_variables` string that is neither a sys_id nor `<sys_id>:item_option_new[_set]` is a **spec error** (stored as-is it
would select nothing at runtime); a `catalog_variables` entry that is not a variable (or set) of the
item is an error too; an item that is neither a catalog item nor a variable set is an error (like a missing subflow). A `template_catalog_item`
given as a pill, or a failed read, keeps the offline behaviour with a warning. `createCatalogTask` needs nothing: its only output is
`Catalog Task` (document_id, catalogue-typed).

## Catalogue

`catalog/data/{triggers,actions,logic}.json` are generated — never hand-edited — by
`node scripts/build-flow-catalog.mjs [sourceDir] [outDir]` (defaults `src/flow-builder/catalog/source` →
`src/flow-builder/catalog/data`) from the platform's own Flow Designer definitions, exported read-only from a
ServiceNow instance. `catalog/source/manifest.json` lists what the catalogue covers (13 trigger definitions, 33 core
action snapshots, 18 logic definitions) under their FlowSpec keys, the label prefixes observed in the
`label_cache` of UI-built flows, and (`input_order`, record triggers only) the entry order UI-built trigger rows store in
`trigger_inputs` — each with the UI-built rows as evidence. Every other value comes from these exports
(REST Table API `result` arrays; empty fields may be omitted, reference fields may be values or `{value, link}`):

| Export file | Table | Query | Fields |
|---|---|---|---|
| `sys_hub_trigger_definition.json` | `sys_hub_trigger_definition` | `sys_idIN<manifest trigger sys_ids>` | sys_id, name, type, active |
| `sys_hub_trigger_input.json` | `sys_hub_trigger_input` | `nameINvar__m_sys_hub_trigger_input_<definition>,…` (by `name`, not `model`: the main inputs have no model) | sys_id, name, element, label, internal_type, mandatory, default_value, order, reference, attributes, choice, max_length, dependent_on_field, use_dependent_field, active |
| `sys_hub_trigger_output.json` | `sys_hub_trigger_output` | `modelIN<definitions>^active=true` | model, element, label, internal_type, mandatory, order, reference, attributes, max_length, dependent_on_field, use_dependent_field |
| `sys_choice-trigger-input.json` | `sys_choice` | `nameINvar__m_sys_hub_trigger_input_<definition>,…^language=en^inactive=false` | name, element, value, label, sequence |
| `sys_db_object-trigger-references.json` | `sys_db_object` | `nameIN<every table a trigger input references>` | name, label |
| `sys_hub_action_type_snapshot.json` | `sys_hub_action_type_snapshot` | `sys_idIN<manifest action snapshots>` | sys_id, name, internal_name, parent_action |
| `sys_hub_action_input.json` | `sys_hub_action_input` | `modelIN<snapshots>^active=true` | model, element, label, internal_type, mandatory, default_value, order, reference, attributes, choice, max_length, dependent_on_field, use_dependent_field |
| `sys_hub_action_output.json` | `sys_hub_action_output` | `modelIN<snapshots>^active=true` | model, element, label, internal_type, mandatory, order, reference, attributes, max_length, dependent_on_field, use_dependent_field, choice |
| `sys_choice-action-input.json` | `sys_choice` | `nameINvar__m_sys_hub_action_input_<snapshot>,…^language=en^inactive=false` | name, element, value, label, sequence |
| `sys_hub_action_instance_v2-hidden-values.json` | `sys_hub_action_instance_v2` | one UI-built row per action with a hidden input that has no default (today: SLA Percentage Timer), `values` decoded (gzip + base64) | sys_id, action_type, name, value |
| `sys_hub_flow_logic_definition.json` | `sys_hub_flow_logic_definition` | `sys_idIN<manifest logic sys_ids>` | sys_id, name, type, attributes |
| `sys_hub_flow_logic_input.json` | `sys_hub_flow_logic_input` | `modelIN<logic definitions>` | sys_id, model, element, label, internal_type, mandatory, order, default_value |
| `sys_hub_flow_logic_variable.json` | `sys_hub_flow_logic_variable` | `modelIN<logic definitions>` (static logic outputs) | sys_id, model, element, label, internal_type, order, reference, attributes |
| `sys_choice-logic-input.json` | `sys_choice` | `nameINvar__m_sys_hub_flow_logic_input_<definition>,…^language=en^inactive=false` | name, element, value, label, sequence |

Rules the script applies (header of `scripts/build-flow-catalog.mjs`): the Flow Designer type is `internal_type`, or
`attributes.uiType` for a complex object (`co_type_name`); inputs and outputs are kept in definition order (then by
name), except the trigger inputs a manifest `input_order` lists, which come first in that order; a trigger input's
`reference_display` is the referenced table's `sys_db_object` label; defaults are typed by the input type; an input is hidden when `visible` / `visible_in_fd` / `visible_in_ui` is
false; choices are ordered by sequence, then label. The pill prefix is `<definition name>_1`; the label prefix is the
observed one, else `Trigger - <definition name>` with `label_prefix_verified: false` (today Weekly, Monthly, Repeat,
Run Once and Remote Table Query — no UI-built flow on the PDI uses their pills). No description or help text is kept.

What the generator derives from the definitions (no copied strings): the `trigger_inputs` descriptor of every trigger
without a UI-captured one (`catalog/triggers.ts` `descriptorTemplate`: one entry per input, the definition's label,
type, mandatory, order, default and choices, parameter `{type, name, label, reference?, reference_display?, attributes?, dependent_on?,
use_dependent?}`);
the inputs every action row carries even when the spec omits them (`isAlwaysStored`: a non-empty default, or hidden);
the key order of every logic `values` object (the one order UI-built rows use).

Re-sourcing (read-only): run the queries above against the instance (the snow-mcp read tools `snow_core_records_query` /
`snow_core_record_read`, or the REST Table API with `sysparm_exclude_reference_link=true`), save each `result` under the
file name in the table, re-run the script, then `npm run type-check` and the flow-builder tests (`tests/flow-builder/catalog-build.test.ts`
fails when `catalog/data` is not exactly what the script builds from `catalog/source`); review the data diff
before committing.

## Guards (done — `guards.ts`)

| Control | Env | Behaviour |
|---|---|---|
| Feature flag | `FLOW_BUILDER_ENABLED=true` | every tool; otherwise `FLOW_BUILDER_NOT_ENABLED` |
| Write | `WRITE_ENABLED=true` | `snow_flow_build` (`requireWrite`) |
| Activation | `FLOW_BUILDER_ACTIVATE_ENABLED=true` | `activate:true` only; otherwise `FLOW_BUILDER_ACTIVATE_NOT_ENABLED` |
| Instance | `instance` argument | REQUIRED on build/verify; never the session's current instance (`FLOW_BUILDER_INSTANCE_REQUIRED`) |
| Deny (wins) | optional `FLOW_BUILDER_DENY_PATTERN=p1,p2` | comma-separated, case-insensitive regular expressions supplied only by local configuration (no built-in default); matched on alias, URL host, group, environment and evaluated BEFORE the allow list, so a match refuses even an allow-listed instance (`FLOW_BUILDER_INSTANCE_DENIED`); an invalid pattern fails closed — every instance is refused (`FLOW_BUILDER_BAD_DENY_PATTERN`) |
| Allow (primary) | `FLOW_BUILDER_ALLOWED_INSTANCES=a,b` | default-deny: unset/blank ⇒ refuse all (`FLOW_BUILDER_ALLOW_LIST_UNSET`); not listed ⇒ `FLOW_BUILDER_INSTANCE_NOT_ALLOWED` |
| Client | — | re-resolved via `instanceManager.getClient(alias)`; a router-passed client that is a different object aborts (`FLOW_BUILDER_CLIENT_MISMATCH`) |
| Export | `FLOW_BUILDER_EXPORT_ROOT` | realpath confinement, `.xml` only, parent must exist, symlink/directory targets refused |
| Transport | — | `snow_flow_build` runs only as a DIRECT MCP stdio call (`src/server.ts` sets the invocation context, `src/utils/invocation-context.ts`): refused nested in another tool (`FLOW_BUILDER_NESTED_REFUSED`; `snow_orch_playbook_exec` also refuses it up front, `NESTED_TOOL_REFUSED`), over REST `/api/tool`, A2A, this package's `./sdk` export or a non-stdio MCP transport (`FLOW_BUILDER_TRANSPORT_REFUSED`) |
| Implicit deletes | `replace_existing` | `snow_flow_export_xml` refuses a spec with `flow.sys_id` (adopting an existing flow) unless `replace_existing:true` (`FLOW_BUILDER_EXPORT_REPLACES_EXISTING`), and always returns the file's `delete_multiple` list |

These flags are **not** mapped by the setup wizard — set them in `.mcp.json` env. Keep `snow_flow_build` out of any
Claude Code auto-allow list (the §2.1 write gate must stay a discrete approval).

## Tool surface (`src/tools/flow-builder.ts`, done)

`snow_flow_catalog_read {name?}` · `snow_flow_plan {spec, instance?, live?, transport:'loader'|'table_api'}` (captureProtocol describes the chosen path; loader by default; with a live instance the resolvers of `resolvers.ts` run, offline the catalogue ids are kept and a warning says so; a spec that does not generate returns `ok:false, stage:'generate', errors, warnings` like a parse error) · `snow_flow_build {spec, instance, update_set:{sys_id|name}, transport:'loader'|'table_api' (default 'loader'), mode, activate:false, delete_stale:false, confirm_delete:[], allow_deactivate:false, allow_past_run:false}` (a scheduled.run_once `run_in` that is not in the future in the instance time zone is refused with `FLOW_BUILDER_RUN_IN_PAST` before anything is written, unless `allow_past_run:true`; the plan result carries `date_time_inputs` and, when one is past, `past_run_note`) ·
`snow_flow_verify {instance, flow_sys_id|spec}` (a spec that no longer generates on the instance still reads the flow back, without a diff: `ok:false`, `planned:false`, `spec_errors`) · `snow_flow_export_xml {spec, format:'record_update'|'update_set', update_set_name, out_path, replace_existing:false}`.
Registered in `src/tools/index.ts` (ALL_TOOLS, dispatcher chain, `platform_developer` bundle), `tool-rename-map.json` (5 rows), EXPECTED 399 in
`scripts/extract-tools.mjs`, `tests/tools/parity.test.ts` and `tests/api/rest-routes.test.ts`.

## Known considerations

Review items graded *consider* (not blocking), left open deliberately:

1. **Preference not restored** (`writer/index.ts`). The read-only existence / active-flow pre-checks now run BEFORE the
   `sys_user_preference` upsert, so a refused build no longer mutates the preference. On a successful build the previous
   `sys_update_set` (and `apps.current_app`) value is still neither reported nor restored — the owner's own UI session (same
   account) keeps capturing into the flow's update set afterwards. Possible fix: return the previous value and add `restore_preference:true`.
2. **Mid-write failures do not list the rows already written** (`writer/index.ts` write loop). Only the sys_id-not-honoured case carries
   `written`; any other POST/PATCH error (e.g. an ACL refusal on a `*_v2` table) propagates without it. Deterministic sys_ids make
   recovery possible from the plan. Possible fix: wrap the loop and rethrow with `{written, failedAt:{table,sys_id}, preferences}`.
3. **JSON import attributes need Node >= 20.10** (`catalog/load.ts`). `import … with { type: 'json' }` is emitted verbatim; `package.json`
   `engines` says `>=20.0.0`, and `src/tools/index.ts` imports the flow builder statically, so on Node 20.0–20.9 the whole MCP server fails
   to start. Verified on Node 24.16. Possible fix: bump `engines` to `>=20.10.0`, or `readFileSync` + `new URL('./data/x.json', import.meta.url)`.
4. **Export write window** (`tools/flow-builder.ts`, `snow_flow_export_xml`). `resolveExportPath` runs before generation and
   `writeFileSync` writes later (a symlink could be planted in between) and silently overwrites an existing `.xml`;
   `FLOW_BUILDER_EXPORT_ROOT` is not checked against the snow-mcp / engine repo roots. Possible fix: generate first, re-validate right
   before writing, write with flag `'wx'` (or `overwrite:true`), refuse a root inside either working tree.
5. ~~FlowSpec schema gaps~~ **closed**: `trigger_strategy` `always` / `every` (with `once` / `unique_changes`) on the Updated and Created or
   Updated triggers, an optional `label` on `if` / `else_if` / `do_until`, the `float` variable type and `{template}` items inside `{list}` (valid
   only in an array.object `append_variables` value; elsewhere a spec error). The `spec_patches` in `tests/flow-builder/specs/_context.json`
   and the e2e append filter are gone.
6. **Instance resolvers** (`resolvers.ts`, wired for `snow_flow_plan` with a live instance, `snow_flow_build` and `snow_flow_verify`; tests
   `tests/flow-builder/resolvers.test.ts`, `tests/flow-builder/tools/resolver-wiring.test.ts`). Still open, by design:
   - the column that links a snapshot to its definition is read as `sys_hub_action_type_snapshot.parent_action` — not yet read on a PDI
     (a missing column only means the catalogue definition is kept);
   - a custom action instance still writes the **definition** sys_id into `action_type` and `action_type_parent`; whether the UI
     writes a snapshot id there for custom actions is unverified (PDI-FACTS §3 covers core actions only);
   - subflow / custom-action definitions are not cached across calls (they change while being authored); action types are cached per
     instance per process — `clearActionTypeCache()` or a server restart picks up a platform upgrade;
   - array / object inputs of a resolved subflow are typed by `internal_type` (`string` for the var_dictionary row), not by `uiType`;
   - the run_in future check uses this machine's clock in the instance zone, not the instance clock (a skewed clock shifts it); a
     run_in only seconds ahead can still be past by the time `activate:true` runs;
   - catalog variable outputs: `catalog_variables` items are matched by sys_id, name or variable-set sys_id and written live as
     `<sys_id>:item_option_new` / `<set sys_id>:item_option_new_set`; offline a bare variable-set sys_id cannot be told from a variable sys_id
     and is written `:item_option_new` — give `<set sys_id>:item_option_new_set` explicitly (names are a spec error offline);
   - run_in: the user-zone-over-system-zone precedence is unverified on a PDI (warned about when the zones differ — see the PDI re-run
     checklist under *Scheduled triggers and time zones*).

## Conventions
ESM, strict TS, `.js` import suffixes, logger to stderr only, zod ^3.22, no new npm deps, vitest 4. Do not commit or push from an agent run.
