# Flow Builder — record format and decisions (generator)

The generator writes the **Flow Designer platform format**: the `sys_hub_*` rows Workflow Studio stores for
a flow or subflow (`sys_hub_flow`, `sys_hub_trigger_instance_v2`, `sys_hub_action_instance_v2`,
`sys_hub_flow_logic_instance_v2`, `sys_hub_sub_flow_instance_v2`, `sys_hub_flow_stage`, the variable /
input / output rows and their `sys_documentation`), serialised as the `<record_update>` document the
ServiceNow IDE loader applies. This file records, for every part of that format, what the generator writes
and the evidence for it. Owner: GENERATOR.

**Evidence** (cited in every row below):

| Tag | Source |
|---|---|
| **PDI** | UI-built rows read with read-only queries on the PDI (Australia Patch 5, ServiceNow IDE 4.4.4), decoded and kept in `tests/flow-builder/fixtures/pdi` — facts in `PDI-FACTS.md` (§ numbers below). |
| **Capture** | The platform's own update-set capture of a UI-built flow: `fixtures/pdi/flows/leaver-flow/sys_update_xml_payload.xml`. |
| **Metadata** | The Flow Designer definitions exported read-only from the instance (`catalog/source/*.json`, README → *Catalogue*). |
| **Live** | Loader runs on the PDI, 24 Sep 2026: flows built by this generator were loaded through `api/fluent/load`, activated through `activate_flows` and run on real records — a record-triggered flow with Update Record (work note with a resolved pill); a flow with error handler, stages, flow variables, If / Else If / Else, Look Up Record(s), For Each, Try/Catch around Create Record, Ask For Approval on a group from a lookup pill and a final If on `approval_state` (approval requested, flow waited, approved branch ran); subflows with inputs / outputs called with `wait_for_completion`; Do In Parallel; For Each with Skip Iteration / Exit Loop; Do Until with an inline-script counter; a 5-second explicit Wait; a scheduled Run Once; catalog steps on a real RITM (Get Catalog Variables outputs as pills, Create Catalog Task with an assignment group, Send Email, Wait For Condition with a timeout); an error handler catching a failed Look Up Record. **Activation rewrites every step's `values` into the full Flow Designer form** (every input with its complete `parameter` metadata), sets `compiled_snapshot` and completes `label_cache` — a minimal but correct loaded definition is therefore enough. |
| **Own** | A generator convention not observed on a UI-built row. Where it is marked *accepted*, the loader applied it and the flow ran in the live runs; *unverified* means no UI row and no live run covers it yet. |

**Tests.** `tests/flow-builder/generator/pdi-conformance.test.ts` compares the generated rows with the UI-built
rows for every construct the PDI fixtures cover; `generator/record-update.test.ts` compares the document with
the Capture; `generator/construct-snapshots.test.ts` pins the generator's own output for every construct spec in
`tests/flow-builder/specs` (regression only — update deliberately with `vitest -u`); `behaviour.test.ts`,
`values.test.ts`, `pills-labels.test.ts` and `run-in-and-catalog-vars.test.ts` cover the rules below.

## 1. The `<record_update>` document (`xml/record-update.ts`)

| Part | Generator writes | Evidence |
|---|---|---|
| Envelope | `<?xml version="1.0"?>` + `<record_update table="sys_hub_flow">`, one `INSERT_OR_UPDATE` element per row, 2-space indent, no trailing newline | **Capture** (same root element and row elements; the capture has `sys_domain="global"` on the root and no line breaks). **Live** accepted. |
| Child-table cleanup | per populated child table, before its rows: `delete_multiple` `flow=<flow>^sys_idNOT IN<the rows written>` (stages, trigger, actions, logic, subflow calls) or `model=<flow>^sys_idNOT IN…` (variables, inputs, outputs); a table the plan leaves empty gets none unless the loader asks for it (`cleanTables`) | **Capture**: identical keys and NOT IN lists (`record-update.test.ts` checks both). Leaving untouched tables alone is **Own** (a load must not remove rows the spec does not describe). |
| Alias-mapping cleanup | `sys_hub_alias_mapping` `delete_multiple` `source_id=<instance>` for every action instance and every subflow call | **Capture**: one per action instance (+ one for the flow). Subflow calls: **Own**, accepted — it only touches alias rows of our own instances (the PDI has 0 alias rows for UI-built instances, PDI-FACTS §1). |
| `sys_documentation` | no `delete_multiple` | **Capture**. |
| Group order | flow → variables / inputs / outputs (+ documentation + complex objects after the first populated group) → stages → trigger → actions (+ alias cleanups) → logic → subflow calls (+ alias cleanups) | **Own**, accepted. The Capture orders stage → input → output → trigger → action → subflow → logic → variable → documentation. |
| Row fields | `sys_id`, `sys_scope`, `sys_update_name` first, then alphabetical (`localeCompare`); empty value → `<field/>`; text entity-escaped (`\r` → `&#13;`) | **Capture**: alphabetical fields, `sys_update_name` on the flow row. `sys_update_name` on child rows is **Own**, accepted. Entity escaping is equivalent to the Capture's CDATA. |
| `apply_defaults="true"` on every data row | dictionary defaults for the columns a row omits | **Own**, accepted. The Capture carries every column and no such attribute. |
| `sys_scope` | reference element `<sys_scope display_value="<scope name>"><sys_scope sys_id></sys_scope>` (`global` / `global` for a global flow) | **Capture** writes `display_value="Global"` + `global`. **Live** accepted for global; scoped flows are refused by the loader until proven. |
| `sys_update_name` | `<table>_<sys_id>`; `sys_documentation_<name>_<element>_<language>` | **Capture** (`sys_hub_flow_<id>`); the activation leak rows on the PDI were named `sys_documentation_var__m_sys_hub_flow_input_<flow>_<element>_en` (README, finding 1). |
| Non-columns | `active` on `sys_hub_action_instance_v2`, `category` on `sys_hub_trigger_instance_v2` | Neither is a column of that table (PDI dictionary, `fixtures/pdi/dictionary`; the Table API omits `active` on read — README finding 8). **Own**, accepted (the loader ignores them); candidates for removal with the next live re-run. |

## 2. Identity, order and nesting

| Rule | Evidence |
|---|---|
| Deterministic sys_ids: first 32 hex of sha256(`<flow key>:<element key>`) (`ids.ts`), or `flow.sys_id` when the spec adopts a flow. | **Own**, accepted (the Table API and the loader both honour client-supplied sys_ids — README findings). |
| `ui_id` = the row's sys_id hex in 8-4-4-4-12 layout; `stage_id` the same for stage rows. | **PDI**: UI rows carry random UUIDs. **Own**, accepted: any UUID-shaped id works, and deriving it keeps pills stable across re-runs. |
| `order` = one flat 1-based counter over action, logic and subflow rows in body order, depth-first (children right after their block); stages, variables and the trigger take none. | **PDI** §5 (`component_indexes` = flat order − 1), `pdi-conformance.test.ts`. |
| Do In Parallel: parallel row, then each branch row with a plain order; the first child of a branch carries `"<branch order>➛<order>"`, later children plain. | **PDI** §10 (`2➛3`, `7➛8`), `pdi-conformance.test.ts`. |
| `parent_ui_id` = enclosing block's `ui_id`; present as `''` on top-level action / subflow rows, absent on top-level logic rows. | Nesting: **PDI** (`parent_ui_id` of every nested row). The absent column on top-level logic rows is **Own**, accepted (UI rows store `''`). |
| Try / Catch (in the body): Try row owns the try steps; Catch is a separate top-level row with `connected_to` = Try `ui_id`, owning the catch steps. | **Live** (Try/Catch ran). The UI values of a non-top-level Try/Catch were not decoded (PDI-FACTS §10) — the values are the empty object of §6. |
| `comment` = the step `annotation`; `sys_class_name` = the row's own table; `display_text`, `generation_source`, `updation_source`, `attributes` empty on action / subflow rows. | **PDI** §5 (UI rows carry these columns, empty). |

## 3. `sys_hub_flow`

| Id | Field | Generator writes | Evidence |
|---|---|---|---|
| — | fixed | `access` `public`, `active` `false`, `status` `draft`, `version` `2`, `show_draft_actions` `false`, `allow_high_security_roles`, `annotation`, `category`, `description`, `label_cache`, `name`, `run_as` (default `user`), `run_with_roles` (comma list), `sys_policy` `''`, `type` | **PDI** §4 (draft UI rows: `active=false`, `status=draft`, `version=2`; `run_as` default `user` = the `sys_hub_flow_base.run_as` dictionary default, §11). `version=2` can only be set through the loader (**Live**). |
| D1 | `generation_source` | `snow_mcp_flow_builder` | **PDI** §4: free text — `''` for the UI, `text2flow` for Now Assist, `agentic_ai` for AI agents; flows built here must be recognisable. **Live** accepted. |
| D2 | `internal_name` | always: `flow.internal_name`, else derived (lowercase, spaces → `_`, ` - ` → `__`, other punctuation dropped) | **PDI** §4 (every UI row carries it; the UI derivation keeps some punctuation and appends a numeric suffix on collision — supply it explicitly). |
| D10 | `flow_priority` | `''` unless the spec sets it | **PDI** §4 (user flows store it empty; `MEDIUM` only on OOB rows). |
| — | platform-owned | `compiled_snapshot`, `version_record`, `latest_snapshot`, `master_snapshot`, `remote_trigger_id`, `authored_on_release_version`, `compiler_build`, `attributes` are not written | **PDI** §4 (written by the platform on save / compile / publish; empty on drafts). |

## 4. Trigger row (`sys_hub_trigger_instance_v2`)

Fields: `flow`, `name` (definition name), `trigger_definition`, `trigger_type`, `trigger_inputs` (gzip + base64 JSON array),
`trigger_outputs` `''`, `comment`, `sys_scope` (the flow scope; UI rows store `''` — **Own**, accepted). Name, type and
definition equal the UI rows for Daily, Repeat, Inbound Email, Service Catalog and Created or Updated (**PDI**, `pdi-conformance.test.ts`).

| Id | Construct | Generator writes | Evidence |
|---|---|---|---|
| D5 | Service Catalog, Daily, Repeat, Inbound Email descriptors | the UI-captured entry verbatim (`catalog/ui-descriptors.ts`), with the value in UI storage form: glide_time value + `HH:MM:SS` display, booleans `"1"`/`"0"`, integers as strings, choice display = choice label | **PDI** (`samples/trigger-instances-other-types.json`, `flows/leaver-flow`); `behaviour.test.ts` compares the Service Catalog entry key for key. |
| D5 | every other trigger (Created, Updated, Created or Updated, Weekly, Monthly, Run Once, SLA Task, Knowledge, Remote Table) | the generic descriptor built from the trigger definition (`catalog/triggers.ts` `descriptorTemplate`): one entry per input in catalogue order with the definition label, type, mandatory flag, order, default, choices and a `parameter` `{type, name, label, reference?, reference_display?, attributes?, dependent_on?, use_dependent?}`; `valueSysId:''` on `glide_list` / `reference` entries. Catalogue order is definition order, except for the three record triggers, whose entries follow the order UI-built rows store (`table, condition, run_on_extended, run_flow_in, run_when_user_list, run_when_setting, run_when_user_setting[, trigger_strategy]` — manifest `input_order`) | **Metadata** (order values 1 / 100 / 101 / 200, attributes, references, choices, defaults). **PDI**: for Created, Updated and both Created or Updated rows the entry names and order, `order` values, `parameter.attributes`, referenced table and label, types, mandatory flags and choice sets equal the UI rows (`pdi-conformance.test.ts`); the UI rows also carry the input **name** as the label of the advanced inputs, `fromTemplate`, `valueSysId` on every entry and a full `parameter` mirror, and do not agree among themselves on the choice order (the Updated row lists `run_on_extended` true/false, the Created or Updated rows false/true). The Remote Table `u_table` entry carries `reference` `sys_script_vtable` / `reference_display` `Remote Table` (the definition's reference and the table's `sys_db_object` label). **Unverified** by a live run since the catalogue rebuild (see §12). |
| — | `glide_time` (Daily / Weekly / Monthly `time`) | `1970-01-01 HH:MM:SS` converted to UTC from the spec `timezone` (default UTC) | glide_time values are stored in UTC; UI form `1970-01-01 22:00:00` (**PDI** §6). The zone conversion is **unverified** by a live run. |
| D17 | `glide_date_time` (`run_in` of Run Once) | instance-local `YYYY-MM-DD HH:MM:SS`, value == displayValue; an ISO-8601 instant is converted live to the instance zone (the authenticated user's `sys_user.time_zone` when set — precedence **unverified**, warned when the zones differ — else `glide.sys.default.tz`, DST-correct via `Intl`); offline an ISO value is a spec error; a value not strictly in the future is a plan warning and a build refusal (`FLOW_BUILDER_RUN_IN_PAST`) unless `allow_past_run:true` | **Live**: the platform reads `run_in` in `glide.sys.default.tz` for a user without a zone; a value already past fired the flow immediately on activation. Reported in `plan.dateTimeInputs`. |
| — | hidden inputs | stored with their default or `''` | **Metadata** (`attributes` visible=false). |

## 5. Action rows (`sys_hub_action_instance_v2`)

| Id | Construct | Generator writes | Evidence |
|---|---|---|---|
| D6 | `action_type` / `action_type_parent` | the snapshot in `action_type`, its definition (`sys_hub_action_type_snapshot.parent_action`) in `action_type_parent` — for all 33 catalogue actions; with an instance `resolveActionType` (`resolvers.ts`) re-reads them (catalogue snapshot if it exists + its `parent_action`, else the definition's existing `latest_snapshot` with a warning, else the catalogue ids with a warning) | **PDI** §3: every UI row stores snapshot + definition (Log, Send Notification, Create Catalog Task, Wait For Condition, Ask For Approval, Get Catalog Variables, and the 13 actions of `samples/action-type-parent-pairs.json` — Send SMS, Get Attachments On Record, Look Up Email Attachments, Copy Attachment, Wait For Message, Associate Record To Email, Wait For Email Reply, SLA Percentage Timer, Create Or Update Record, Move Email Attachments To Record, Delete Attachment, Submit Catalog Item Request, Send Notification; no UI row stores the snapshot there — `pdi-conformance.test.ts`). **Metadata** for the actions without a UI row on the PDI. Get Catalog Variables uses snapshot `330ba3ab…` (the definition's `latest_snapshot` `a30ba3ab…` does not exist). |
| — | `values` entries | a minimal entry `{name, value, displayValue, scriptActive:false, parameter:{type}}` for every input the spec sets **plus** every input with a non-empty default or hidden in Flow Designer (`catalog/actions.ts` `isAlwaysStored`; hidden and defaulted entries also carry `parameter.attributes` / `parameter.reference`) | **Metadata** (defaults, visibility). UI rows store every input with its input `id` and a full `parameter` mirror (**PDI** §6); **Live**: the minimal entry set ran, and activation rewrites the values into the full form. |
| — | entry order | definition order (`sys_hub_action_input.order`, then name) | **PDI**: the UI order for Log, Create Catalog Task, Wait For Condition, Get Catalog Variables, Ask For Approval, and for Update Record, Look Up Record, Look Up Records, Send Email, Update Multiple Records, Wait For Email Reply, Move Email Attachments To Record (`samples/action-values-entry-order.json`; `pdi-conformance.test.ts`). Exceptions seen on UI rows: Send Notification stores `notification` (order 3) first; one Ask For Approval row stores `approval_reason` before `approval_field` (both order 2). |
| — | booleans / integers | JSON `true`/`false`, JSON numbers | **Own**, accepted. UI rows store `"1"`/`"0"` with display `true`/`false` (**PDI** §6); activation rewrites them. |
| — | pills | `{{<definition name>_1.<output>…}}` for trigger outputs, `{{<ui_id>.<output>…}}` for step outputs, `{{flow_variable.<name>}}`, `{{subflow.<input>}}`, `{{static.<sys_id>}}`; no type suffix; mixed text allowed | **PDI** §7, `pdi-conformance.test.ts`. |
| D9 | custom action by bare sys_id | input types from the instance definition (`resolveCustomAction` → `sys_hub_action_input.internal_type`); without a resolver inferred from the value form, with a warning | **Metadata** (the definition is authoritative). |
| D11 | `{reference}` inside a `{template}` value | `field={"display":"<display>","value":"<sys_id>"}` | **PDI** §8 (leaver-flow Create Catalog Task `ah_fields`), `pdi-conformance.test.ts`; **Live** (Create Catalog Task with an assignment group). |
| — | `{template}` values | `f1=v1^f2=v2^EQ`; pills allowed as values; scalars stringified | **Own**, accepted (**Live**: Update Record / Create Record / Create Catalog Task). The UI row read carries no trailing `^EQ`. |
| D12 | `askForApproval.due_date` omitted by the spec | the UI default `{"action":"none","date_type":"actual","date":"{{}}","duration":1,"duration_type":"days","schedule":"","schedule_label":""}` | **PDI** §8, `pdi-conformance.test.ts`. The empty `{{}}` is literal text, never a pill. |
| — | `approval_conditions` | `<Approves|Rejects|ApprovesRejects><Any|All|Res|n#|n%>[M][U[…]][G[…]]`, rule sets joined by `Or`, rules by `&`, conditions by `|`, several approvers comma-separated; a bare sys_id becomes `{{static.<sys_id>}}` | **PDI** §8 (`ApprovesAllU[{{a}}]G[{{b}}]OrRejectsAnyU[…]`), `pdi-conformance.test.ts`; **Live** (group approval from a lookup pill). |
| — | `catalog_variables` (slushbucket) | `<sys_id>:item_option_new` / `<set sys_id>:item_option_new_set`, comma list | **PDI** §8, `pdi-conformance.test.ts`. |
| D18 | outputs of Get Catalog Variables (`steps.<key>.<variable_name>`) | live: the variables of `template_catalog_item` (`item_option_new` active, + single-row sets via `io_set_item`, a multi-row set as one `string` output; or the set's own variables when the template is a variable set), restricted to `catalog_variables` when given, typed from the question type (6/2/16 string, 5/3 choice, 7 boolean, 8 reference + table, 9 glide_date, 10 glide_date_time, 21 glide_list, other string); an unknown name is a spec error listing the valid names. Offline: `string` + warning | **Live** (the outputs resolved to the submitted values on a real RITM). The catalogue has no outputs for this action — they are dynamic per item. |
| — | `glide_duration` | `1970-01-01 HH:MM:SS` + duration, days in the date part | **PDI** §8. |
| — | `schedule_date_time` (`due_date`) | JSON string, key order `action, date_type, date, duration, duration_type, schedule, schedule_label` | **PDI** §8. |
| — | inline `{script}` input | entry `{id:'', name, value:'', displayValue:'', children:[], scriptActive:true, script:{<name>:{scriptActive:true, script}}}` | **PDI** §10 (the values entry carries `scriptActive:true` + `script`); **Live** (inline-script counter). |
| — | `{script}` inside a `{template}` sub-field | the template carries `fd-scripted` for that field and the entry gains `script:{<field>:{scriptActive:true, script}}` | **Own**, **unverified** — no UI row and no live run covers a scripted template sub-field. |
| — | hidden object input (SLA Percentage Timer `sla_flow_inputs`) | the value a UI-built row stores | **PDI** (UI row `352bf003…`, `catalog/source/sys_hub_action_instance_v2-hidden-values.json`). |
| — | spec input name `dont_fail_on_error` (earlier name `dont_fail_flow_on_error`, still accepted; both on one step is a spec error) | written as `__snc_dont_fail_on_error` / `_snc_dont_fail_on_error` (a leading underscore is not a valid spec input name) | **Metadata** (element names); **PDI** (UI rows store `__snc_dont_fail_on_error`, `samples/action-values-entry-order.json`). |

## 6. Logic rows (`sys_hub_flow_logic_instance_v2`)

`values` is a gzip + base64 JSON **object** with the keys `outputsToAssign, inputs, variables, decisionTableInputs,
dynamicInputs, workflowInputs` in that order on every logic row (**PDI**: the order of every UI row read,
`pdi-conformance.test.ts`). An empty values object (End, Break, Continue, Try, Catch, Do In Parallel, Parallel
Branch, Else) has the byte-identical deflate stream of the UI blob — only the gzip OS header byte differs (`encode.ts`
writes `03`, UI rows `ff`). Logic input entries: `{id, name, value, displayValue, children:[], parameter:{}, scriptActive}`
(**Own** minimal form, accepted; UI entries carry the full `parameter`). Logic definition sys_ids: **Metadata**, equal to
the UI rows for Break, Continue, Do Until, Wait, Do In Parallel, Parallel Branch (**PDI**).

| Id | Logic | Generator writes | Evidence |
|---|---|---|---|
| — | If / Else If / Else / End | condition = encoded query with pills in `inputs` (`condition`) | **PDI** §6; **Live**. |
| D14 | condition label (`condition_name`) on If / Else If / Do Until | written first when the step carries `label` | **PDI** §6 (UI rows always carry it). FlowSpec `label` is optional. |
| — | For Each | `inputs:[{id:'', name:'items', value, displayValue}]`, value == displayValue (`{{<ui_id>.Records}}` or `{{flow_variable.<name>}}`) | **PDI** (`samples/for-each-instances.json`: same name and pill forms, `pdi-conformance.test.ts`); the UI entry also carries `children` / `parameter` / `scriptActive`. **Live**. |
| — | Exit Loop / Skip Iteration | empty values, nested under the loop | **PDI** (`samples/break-continue-instances.json`); **Live**. |
| — | Set Flow Variables | `variables[]` and `inputs[]` list the assigned variables in assignment order (`variables[].id` = the `sys_hub_flow_variable` sys_id; scalars stringified; `inputs[].displayValue` `''`); `flow_variables_assigned` = the names | **PDI** §6 (`samples/set-flow-variables-instances.json`, `pdi-conformance.test.ts`); **Live**. |
| D15 | Append To Flow Variables | `variables` + `inputs`; value = JSON string `{"version":"1.0","complexObjectSchema":<schema of the array variable>,"complexObject":{"name$":"FD<co sys_id>","$COCollectionField":<object or array>},"serializationFormat":"JSON"}`; several objects (`{list:[{template}…]}`) add one `item` descriptor per element in `children` | **Own**, **unverified** — the PDI has no Append To row (PDI-FACTS §10) and no live run used it. FlowSpec accepts `{template}` items inside `{list}` only here. |
| — | Assign Subflow Outputs | `outputsToAssign[]` entries, `inputs:[]`; `outputs_assigned` = the names | **PDI** (`samples/assign-subflow-outputs-instances.json`, `pdi-conformance.test.ts`); UI entries carry the `sys_hub_flow_output` sys_id as `id`, ours `''`. **Live** (subflow outputs used by the caller). |
| — | Wait for a duration | the seven timer inputs in the UI order with the UI input ids (`duration_type` `explicit_duration` / `relative_duration` / `percentage_duration`, `timer_duration` in glide_duration form, …) | **PDI** (`flows/dountil-timer-subflow`, `pdi-conformance.test.ts`); **Live** (5-second explicit wait). |
| — | Do Until | `condition_name` (label, optional) + `condition` | **PDI** §6; **Live**. |
| — | Do In Parallel / Parallel Branch | empty values; order rule of §2 | **PDI** §10; **Live**. |
| D13 | Flow Error Handler (`error_handler`) | `TOP_LEVEL_TRY` (`e9060aa2…`) at order `0`, no parent, empty values, the whole body nested under it (orders 1…n); `TOP_LEVEL_CATCH` (`35d60003…dd23`) at order n+1, no parent, values = the verbatim `__status__` (FDACTIONSTATUS complex object) and `enabled` inputs; handler steps under the catch (orders n+2…); `error.<field>` pills → `{{<catch ui_id>.__status__.<field>}}`, label `1 - Error Handler➛Error Status➛<Field>` | **PDI** §9 (`flows/error-handler-subflow-snapshot`, compared verbatim in `behaviour.test.ts`); **Live** (a failing Look Up Record ran the handler, `{{error.message}}` resolved). |
| — | `block` (reference to `sys_hub_flow_block`) | not written | UI rows carry it (**PDI** §5); **Live**: flows without it ran. |

## 7. Subflow calls (`sys_hub_sub_flow_instance_v2`)

`subflow`, `subflow_inputs` (gzip + base64 JSON array, one entry `{name, value, displayValue, parameter:{type}}` per input,
in the callee's input order, typed from its `sys_hub_flow_input.internal_type`), `wait_for_completion` (`true`/`false`),
`show_stages` `false`, `order`, `parent_ui_id`, `ui_id`, `comment`, empty `attributes` / `display_text` / `generation_source`.
**PDI** (`flows/parallel-change-implement-snapshot`: same fields and values; every key of our entries is a key of the UI
entry, which also carries `subFlowInstanceId` / `id` and the full `parameter`; `pdi-conformance.test.ts`). **Live**.

## 8. `label_cache` (`labels.ts`)

A JSON array on `sys_hub_flow`: one entry per distinct pill in first-use order, `{name, label, type, base_type, usedInstances, attributes}`
(+ `column_name` for records pills and array variables, `reference_table` / `reference_display` `null` for flow-variable and
subflow-input pills). It is a cache: Workflow Studio rewrites it on save and activation completes it (**Live**). UI entries carry
more keys (PDI-FACTS §6).

| Id | Rule | Evidence |
|---|---|---|
| — | labels: trigger pills `<label prefix>➛<table> Record➛<Field>…`; step outputs `<ui_id>➛<Output>[➛field]`; for-each items `<n> - For Each - ➛item[➛<Field>]`; flow variables `Flow Variables➛<Label>`; subflow inputs `Input➛<Label>` | **Own** text; the prefixes are **PDI** (`Trigger - Service Catalog`, `Trigger - Record Created or Updated`, … — the label prefixes observed on UI-built flows, `catalog/source/manifest.json`); `Flow Variables➛…` and `Input➛…` are **PDI** §6. The UI labels step outputs by step number (`4.1➛…`). |
| D4 | UI keys after the base keys: `reference` (table of a whole-record pill), `parent_table_name` + `column_name` (single-hop field pill), `reference:''` + `reference_display:'<field label>'` (error status pill) | **PDI** §6. Not derived (needs dictionary labels): `reference_display` of record fields, multi-hop `parent_table_name`, `choices`. |
| D7 | a dot-walk on a non-record trigger output (`Service Catalog_1.request_item.number`) appends the walk (`…➛Request Item➛Number`) with the dictionary type | **PDI** §6 (`Trigger➛Requested Item Record➛Number`, type `string`). |
| D8 | step-output pills take the catalogue output type (`waitForCondition.state` = `choice`, `recordProducer.table` = `table_name`) | **Metadata**; the UI types Wait For Condition `state` as `choice` (**PDI**, parallel-change-implement snapshot). |

## 9. Flow variables, subflow inputs / outputs, documentation (`sys_hub_flow_variable` / `_input` / `_output`)

`active`, `attributes`, `default_value`, `element`, `hint`, `internal_type`, `label`, `mandatory`, `max_length`, `model` / `model_id`
(the flow), `model_table` `sys_hub_flow`, `name` `var__m_<table>_<flow>`, `order` (1-based declaration order), `reference` (reference
type) — **PDI** §5. `max_length`: the value the instance's rows carry for the table and type (**PDI**, read-only tallies in
`samples/max-length-by-type.json`, `pdi-conformance.test.ts`): string 8000, integer 40, decimal 15, float 40, choice 32, reference 32,
json 4000, table_name 200 (80 on subflow outputs), document_id 200 (32 on subflow outputs), glide_list / records / url 1024,
password2 255, object / array 65000; boolean 32 on flow variables (every boolean variable the current release created — older rows
carry 40) and 40 on subflow inputs / outputs; 40 for any other type. `attributes` is `''`
for scalar variables (**Own**, accepted; UI rows carry `element_mapping_provider=…,uiType=…,uiTypeLabel=…,uiUniqueId=…`); an array /
object variable carries the complex-object attributes (`co_type_name=FD<sys_id>,…,uiType=array.object,…`), `internal_type` `string`,
`max_length` 65000 and one `sys_complex_object` row (`FD<sys_id>`, namespace `FlowDesigner`, type `complex_object_collection`,
the schema JSON) — **PDI** (`samples/sys_hub_flow_output.json`: `co_type_name`, 65000), the `sys_complex_object` row is **Own**, accepted.
Every row has a `sys_documentation` row: `name` = the same `var__m_…` name, `element`, `label`, `hint` `''`, `language` `en`,
`plural` `''` — **PDI** (`samples/sys_documentation-for-variables.json`, Capture).

## 10. Stages (`sys_hub_flow_stage`)

`value`, `label`, `order` (0-based), `type` `standard`, `always_show`, `duration` (`1970-01-01 00:00:00` + duration), `stage_id`
(uuid of the row), `component_indexes` (flat order − 1 of every instance the stage precedes, comma-separated when a stage is set
in several branches), `ancestor_*` empty, `ancestor_array_position` `-1`, `states` (D3)
`{"pending":"Pending - has not started","inprogress":"In progress","skipped":"Skipped","complete":"Completed","error":"Error"}` —
**PDI** §5 (leaver-flow stages, `pdi-conformance.test.ts`); **Live** (stages). A stage of `type=error` is not generated.

## 11. Loader-path decisions (writer, `tests/flow-builder/writer/loader.test.ts`)

| Id | Construct | Decision | Evidence |
|---|---|---|---|
| D16 | Platform-managed trigger inputs of a **record-triggered** flow (`current` and `table_name` in `sys_hub_flow_input` + their `sys_documentation`) | not generated; the loader never emits a `sys_hub_flow_input` `delete_multiple` on their account — they are set aside before the stale computation, never gated, reported in `platformManaged` (fate `kept` / `deleted_by_load` / `created_by_load`); only when OTHER unplanned input rows force a confirmed `model=<id>` cleanup are they removed with it (re-created by the platform on activation) | **Live**: the platform creates both rows itself for a record-triggered flow (`current` document_id, mandatory, `dependent_on_field=table_name`, order 100; `table_name` order 101, max_length 200, `test_input_hidden=true`) with random sys_ids and re-creates them on activation. Emitting them would race the platform's own creation of the same `name` + `element`. |

## 12. Open — needs a live loader re-run on the PDI

These parts of the output changed since the last live run, or were never covered by one:

1. Record-trigger descriptors built from the definitions (§4 — they now equal the UI rows in entry order, `order` values,
   attributes, references and choice sets, but keep the minimal entry form and the definition labels) and the other generic
   descriptors (Weekly, Monthly, Run Once, SLA Task, Knowledge, Remote Table); the Weekly / Monthly / Repeat / Run Once / Remote Table
   label prefixes (no flow on the PDI uses their pills — `label_cache` of every `sys_hub_flow` checked read-only; the observed Daily
   prefix is `Trigger - Run Daily `, so these five fall back to `Trigger - <definition name>`, `label_prefix_verified: false`).
2. Logic `values` in the UI key order, action inputs in definition order, `action_type_parent` = the definition for every
   catalogue action, the SLA Percentage Timer `sla_flow_inputs` value (catalogue rebuild from the instance metadata).
3. `max_length` per table and type (§9 — string 8000, boolean 32 on flow variables, decimal 15, float 40, choice 32, …) and
   `sys_documentation.plural` `''` (every one of the 998 variable / input / output documentation rows on the PDI) on flow variables,
   inputs and outputs.
4. Never live-tested: Append To Flow Variables (§6 D15), a `{script}` template sub-field (§5), the glide_time zone conversion
   (§4), a scoped flow through the loader, the user-zone-over-system-zone precedence for `run_in` (D17).
5. Candidates to align with the UI once a re-run is due: drop `active` / `category` (§1), write `parent_ui_id:''` on top-level logic
   rows, booleans as `"1"`/`"0"` in action values.

## Pill typing (label_cache `type` / `base_type`)

Sources, in order: (1) catalogue output types (trigger outputs, action outputs, wait outputs, error-status fields — **Metadata**);
(2) types declared in the spec (flow variables, subflow inputs, object fields of `array.object` variables derived from the append
steps, resolved subflow / custom-action definitions, and — with an instance — the variables of a Get Catalog Variables step, D18);
(3) `flow.pill_types` (symbolic pill → type, authoritative); (4) `GenerateOptions.resolvePillType(table, dottedPath)` for record-field
walks (the dictionary, live). When none applies the pill is typed `string` and a warning is recorded (`plan.warnings`). The construct
specs use a dictionary double (`tests/flow-builder/specs/_context.json`).

## FlowSpec schema notes (owner SCAFFOLD)

1. `trigger_strategy` on record.updated / record.created_or_updated accepts the four choices of the definition: `once`, `always`,
   `every`, `unique_changes`.
2. Input names must match `^[a-z]…`; the `_snc_dont_fail_on_error` / `__snc_dont_fail_on_error` inputs are written as
   `dont_fail_on_error` in a spec (the earlier `dont_fail_flow_on_error` is still accepted — §5).
3. Optional `label` (condition_name) on `if` / `else_if` / `do_until` (D14); `float` variable type; `{template}` object literals inside
   `{list}` (D15).
4. A due_date JSON with the literal `{{}}` must be passed as a plain string — a `{text}` value is pill-token-checked and rejects `{{}}`;
   the generator treats an empty `{{}}` as text.
