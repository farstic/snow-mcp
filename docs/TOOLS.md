# Tool Reference — ServiceNow MCP Toolkit v2.6.0 (Latest Release)

Complete reference for all 400+ tools across all ServiceNow modules. All tools accept a `table` parameter override where applicable.

## Permission Tiers

| Tier | Requirement | Applies To |
|------|-------------|------------|
| Read | None (default) | All query/get/list tools |
| Write | `WRITE_ENABLED=true` | snow_core_record_add, snow_core_record_modify, snow_core_record_remove, resolve, order, approve |
| CMDB Write | `WRITE_ENABLED=true` + `CMDB_WRITE_ENABLED=true` | CI create/update/relate |
| Scripting | `WRITE_ENABLED=true` + `SCRIPTING_ENABLED=true` | Business rules, script includes, changesets |
| Now Assist | `NOW_ASSIST_ENABLED=true` | AI summaries, NLQ, agentic playbooks |
| ATF | `ATF_ENABLED=true` | Run test suites and individual tests |

---

## Core & CMDB (19 tools)

### snow_core_records_query
Query records from any ServiceNow table with filtering, sorting and pagination.

**Parameters**:
- `table` (required) — Table name (e.g. `incident`, `sys_user`)
- `query` — Encoded query string (e.g. `state=1^priority=1`)
- `fields` — Comma-separated list of fields to return
- `limit` — Max records to return (default: 100)
- `offset` — Pagination offset

### snow_core_record_read
Retrieve a single record by sys_id.

**Parameters**:
- `table` (required) — Table name
- `sys_id` (required) — Record sys_id

### snow_core_record_add
Create a new record in any ServiceNow table. Requires `WRITE_ENABLED=true`.

**Parameters**:
- `table` (required) — Table name (e.g. `incident`, `sys_user_preference`)
- `fields` (required) — Key-value pairs for the new record fields

### snow_core_record_modify
Update an existing record in any ServiceNow table. Requires `WRITE_ENABLED=true`.

**Parameters**:
- `table` (required) — Table name
- `sys_id` (required) — 32-character system ID of the record
- `fields` (required) — Key-value pairs of fields to update

### snow_core_record_remove
Delete a record from any ServiceNow table. Requires `WRITE_ENABLED=true`.

**Parameters**:
- `table` (required) — Table name
- `sys_id` (required) — 32-character system ID of the record

### snow_core_table_schema_read
Get field definitions and metadata for a table.

**Parameters**:
- `table` (required) — Table name

### snow_core_user_read
Look up a ServiceNow user by username, email, or sys_id.

**Parameters**:
- `identifier` (required) — Username, email, or sys_id

### snow_core_group_read
Look up a ServiceNow group by name or sys_id.

**Parameters**:
- `identifier` (required) — Group name or sys_id

### snow_core_cmdb_ci_query
Search CMDB configuration items by name or class.

**Parameters**:
- `query` (required) — CI name or search query
- `ci_class` — Filter by CI class (e.g. `cmdb_ci_server`)
- `limit` — Max records (default: 25)

### snow_core_cmdb_ci_read
Get full details of a CMDB configuration item.

**Parameters**:
- `sys_id` (required) — CI sys_id

### snow_core_relationships_index
List relationships for a CMDB CI.

**Parameters**:
- `ci_sys_id` (required) — CI sys_id
- `relationship_type` — Filter by relationship type

### snow_core_discovery_schedules_index
List active Discovery schedules and their status.

**Parameters**:
- `active` — Filter by active status (default: true)
- `limit` — Max records

### snow_core_mid_servers_index
List MID server status and version information.

**Parameters**:
- `status` — Filter by status (`up`, `down`)

### snow_core_active_events_index
List active Event Management events and alerts.

**Parameters**:
- `severity` — Filter by severity level
- `limit` — Max records

### snow_core_health_dashboard_read
Get CMDB health metrics and stale CI counts.

**Parameters**: None

### snow_core_service_mapping_summary_read
Get Service Mapping application service summaries.

**Parameters**:
- `limit` — Max services to return

### snow_chg_change_request_add
Create a new change request record. **[Write]**

**Parameters**:
- `short_description` (required)
- `description`
- `type` — `normal`, `standard`, `emergency`
- `assignment_group`
- `risk` — `1` (High) to `4` (Low)

### snow_core_natural_language_query
Search records using a plain English question.

**Parameters**:
- `query` (required) — Natural language question

### snow_core_natural_language_modify
Update a record using natural language instructions. **[Write]**

**Parameters**:
- `table` (required)
- `sys_id` (required)
- `instruction` (required) — Plain English update instruction

---

## Incident Management (7 tools)

### snow_inc_incident_add
Create a new incident. **[Write]**

**Parameters**:
- `short_description` (required)
- `urgency` — `1` (High), `2` (Medium), `3` (Low)
- `impact` — `1`, `2`, `3`
- `description`
- `assignment_group`
- `caller_id`

### snow_inc_incident_read
Get incident details by number or sys_id.

**Parameters**:
- `identifier` (required) — Incident number (INC0001234) or sys_id

### snow_inc_incident_modify
Update an existing incident. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required) — Object with fields to update

### snow_inc_incident_resolve
Resolve an incident with resolution code and notes. **[Write]**

**Parameters**:
- `sys_id` (required)
- `close_code` (required) — Resolution code
- `close_notes` (required) — Resolution notes

### snow_inc_incident_close
Close a resolved incident. **[Write]**

**Parameters**:
- `sys_id` (required)

### snow_inc_work_note_annotate
Add a work note (internal) to any task record. **[Write]**

**Parameters**:
- `table` (required) — e.g. `incident`
- `sys_id` (required)
- `note` (required)

### snow_inc_comment_annotate
Add a customer-visible comment to a task record. **[Write]**

**Parameters**:
- `table` (required)
- `sys_id` (required)
- `comment` (required)

---

## Problem Management (4 tools)

### snow_prb_problem_add
Create a new problem record. **[Write]**

**Parameters**:
- `short_description` (required)
- `description`
- `assignment_group`

### snow_prb_problem_read
Get problem details by number or sys_id.

**Parameters**:
- `identifier` (required)

### snow_prb_problem_modify
Update an existing problem. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_prb_problem_resolve
Mark a problem as resolved with fix notes. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fix_notes` (required)

---

## Change Management (5 tools)

### snow_chg_change_request_read
Get change request details by number or sys_id.

**Parameters**:
- `identifier` (required)

### snow_chg_change_requests_index
List change requests with optional filters.

**Parameters**:
- `state` — Change state filter
- `type` — `normal`, `standard`, `emergency`
- `limit`

### snow_chg_change_request_modify
Update an existing change request. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_chg_change_for_approval_submit
Move a change request to the approval state. **[Write]**

**Parameters**:
- `sys_id` (required)

### snow_chg_change_request_close
Close a change request after implementation. **[Write]**

**Parameters**:
- `sys_id` (required)
- `close_code`
- `close_notes`

---

## Task Management (4 tools)

### snow_tsk_task_read
Get task details by number or sys_id.

**Parameters**:
- `identifier` (required)

### snow_tsk_my_tasks_index
List tasks assigned to the current user.

**Parameters**:
- `state` — Filter by state
- `limit`

### snow_tsk_task_modify
Update a task record. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_tsk_task_complete
Mark a task as complete. **[Write]**

**Parameters**:
- `sys_id` (required)
- `close_notes`

---

## Knowledge Base (6 tools)

### snow_kb_knowledge_bases_index
List available knowledge bases.

**Parameters**:
- `active` — Filter by active (default: true)

### snow_kb_knowledge_query
Search knowledge articles across all bases.

**Parameters**:
- `query` (required) — Search text
- `kb_sys_id` — Limit to specific knowledge base
- `limit`

### snow_kb_knowledge_article_read
Get full knowledge article content.

**Parameters**:
- `sys_id` (required)

### snow_kb_knowledge_article_add
Create a new knowledge article. **[Write]**

**Parameters**:
- `short_description` (required) — Article title
- `text` (required) — Article body (HTML)
- `kb_knowledge_base` — Knowledge base sys_id
- `category`

### snow_kb_knowledge_article_modify
Update an existing knowledge article. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_kb_knowledge_article_publish
Publish a draft knowledge article. **[Write]**

**Parameters**:
- `sys_id` (required)

---

## Service Catalog, Approvals & SLA (10 tools)

### snow_cat_catalog_items_index
List service catalog items.

**Parameters**:
- `category` — Filter by category
- `limit`

### snow_cat_catalog_query
Search for catalog items by name or description.

**Parameters**:
- `query` (required)
- `limit`

### snow_cat_catalog_item_read
Get full details of a catalog item including variables.

**Parameters**:
- `sys_id` (required)

### snow_cat_catalog_item_order
Place an order for a catalog item. **[Write]**

**Parameters**:
- `sys_id` (required) — Catalog item sys_id
- `quantity` — Default: 1
- `variables` — Key/value pairs for item variables

### snow_cat_my_approvals_read
List pending approval requests for the current user.

**Parameters**:
- `limit`

### snow_cat_approvals_index
List all approval requests with optional filters.

**Parameters**:
- `state` — `requested`, `approved`, `rejected`
- `limit`

### snow_cat_request_approve
Approve a pending approval request. **[Write]**

**Parameters**:
- `sys_id` (required) — Approval record sys_id
- `comments`

### snow_cat_request_reject
Reject a pending approval request. **[Write]**

**Parameters**:
- `sys_id` (required)
- `comments`

### snow_cat_sla_details_read
Get SLA information for a task record.

**Parameters**:
- `task_sys_id` (required)

### snow_cat_active_slas_index
List active SLA records approaching breach.

**Parameters**:
- `table` — Task table (default: `incident`)
- `limit`

---

## User & Group Management (8 tools)

### snow_usr_users_index
List ServiceNow users with optional filters.

**Parameters**:
- `query` — Encoded query
- `active` — Filter by active (default: true)
- `limit`

### snow_usr_user_add
Create a new user. **[Write]**

**Parameters**:
- `user_name` (required)
- `first_name`, `last_name`, `email`, `title`, `department`

### snow_usr_user_modify
Update user record fields. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_usr_groups_index
List user groups.

**Parameters**:
- `query`
- `limit`

### snow_usr_group_add
Create a new user group. **[Write]**

**Parameters**:
- `name` (required)
- `description`
- `manager`

### snow_usr_group_modify
Update a user group. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_usr_user_group_assign
Add a user to a group. **[Write]**

**Parameters**:
- `user_sys_id` (required)
- `group_sys_id` (required)

### snow_usr_user_group_unassign
Remove a user from a group. **[Write]**

**Parameters**:
- `user_sys_id` (required)
- `group_sys_id` (required)

---

## Reporting & Analytics (13 tools)

### snow_rpt_reports_index
List saved reports in ServiceNow.

**Parameters**:
- `query` — Filter by name or category
- `limit`

### snow_rpt_report_read
Get a report definition by sys_id or name.

**Parameters**:
- `identifier` (required)

### snow_rpt_aggregate_query_exec
Run an aggregate (GROUP BY + COUNT/SUM) query.

**Parameters**:
- `table` (required)
- `group_by` (required) — Field to group by
- `query` — Filter query
- `aggregate` — `COUNT`, `SUM`, `AVG` (default: `COUNT`)

### snow_rpt_query_trend
Query record counts over time periods (monthly buckets).

**Parameters**:
- `table` (required)
- `date_field` (required) — Date field to bucket by
- `group_by` — Secondary grouping field
- `query` — Base filter
- `periods` — Number of months to include (default: 6)

### snow_rpt_performance_analytics_read
Get Performance Analytics widget data (ServiceNow PA API).

**Parameters**:
- `widget_sys_id` (required) — PA widget sys_id
- `time_range` — e.g. `last_30_days`

### snow_rpt_report_data_export
Export records as structured data for a given query.

**Parameters**:
- `table` (required)
- `query`
- `fields` — Comma-separated list
- `format` — `json` (default)

### snow_rpt_sys_log_read
Retrieve system log entries.

**Parameters**:
- `level` — `error`, `warning`, `info`
- `source`
- `limit`

### snow_rpt_scheduled_jobs_index
List scheduled jobs (sys_trigger records).

**Parameters**:
- `active` — Filter by active
- `limit`

### snow_rpt_scheduled_job_read
Get details of a specific scheduled job. **[Read]**

**Parameters**:
- `sys_id` (required)

### snow_rpt_scheduled_job_add
Create a new scheduled script job. **[Write]**

**Parameters**:
- `name` (required)
- `script` (required) — JavaScript to execute
- `run_type` — `daily`, `weekly`, `monthly`, `periodically`, `once`
- `run_time` — Time to run (HH:MM:SS)
- `active`

### snow_rpt_scheduled_job_modify
Update a scheduled job's script or schedule. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_rpt_scheduled_job_trigger
Trigger a scheduled job to run immediately. **[Write]**

**Parameters**:
- `sys_id` (required) — Scheduled job sys_id

### snow_rpt_job_run_history_index
List execution history for a scheduled job.

**Parameters**:
- `job_sys_id` — Filter by job sys_id
- `limit`

---

## ATF Testing (9 tools) — Requires `ATF_ENABLED=true`

### snow_atf_atf_suites_index
List Automated Test Framework test suites.

**Parameters**:
- `active` — Filter by active
- `query`
- `limit`

### snow_atf_atf_suite_read
Get ATF test suite details.

**Parameters**:
- `identifier` (required) — sys_id or name

### snow_atf_atf_suite_exec
Execute a test suite and return the result sys_id. **[ATF_ENABLED]**

**Parameters**:
- `sys_id` (required) — Suite sys_id

### snow_atf_atf_tests_index
List ATF test cases.

**Parameters**:
- `suite_sys_id` — Filter by suite
- `active`
- `limit`

### snow_atf_atf_test_read
Get ATF test case details.

**Parameters**:
- `sys_id` (required)

### snow_atf_atf_test_exec
Execute a single ATF test. **[ATF_ENABLED]**

**Parameters**:
- `sys_id` (required)

### snow_atf_atf_suite_result_read
Get results of an ATF suite run.

**Parameters**:
- `result_sys_id` (required)

### snow_atf_atf_test_results_index
List individual test results within a suite run.

**Parameters**:
- `suite_result_sys_id`
- `limit`

### snow_atf_atf_failure_insight_read
**Latest release**: Get Failure Insight report showing metadata changes between the last successful and failed run — surfaces role changes and field value changes that caused test failures.

**Parameters**:
- `result_sys_id` (required)

---

## Now Assist / AI (10 tools) — Requires `NOW_ASSIST_ENABLED=true`

### snow_na_nlq_query
Send a natural language question and get structured query results.

**Parameters**:
- `question` (required) — Plain English question
- `table` — Scope to a specific table

### snow_na_ai_query
Semantic AI search across knowledge, catalog, and records (ServiceNow AI Search API).

**Parameters**:
- `query` (required)
- `sources` — Array: `kb`, `catalog`, `incident`, etc.
- `limit`

### snow_na_summary_generate
Generate an AI summary of any record using Now Assist. **[NOW_ASSIST_ENABLED]**

**Parameters**:
- `table` (required)
- `sys_id` (required)

### snow_na_resolution_suggest
Get AI-powered resolution suggestions based on similar past incidents. **[NOW_ASSIST_ENABLED]**

**Parameters**:
- `incident_sys_id` (required)

### snow_na_incident_categorize
Predict incident category, assignment group, and priority using Predictive Intelligence. **[NOW_ASSIST_ENABLED]**

**Parameters**:
- `short_description` (required)
- `description`

### snow_na_pi_models_read
List available Predictive Intelligence models.

**Parameters**: None

### snow_na_virtual_agent_topics_read
List Virtual Agent topics.

**Parameters**:
- `active`
- `category`
- `limit`

### snow_na_agentic_playbook_trigger
**Latest release**: Invoke a Now Assist Agentic Playbook. **[NOW_ASSIST_ENABLED]**

**Parameters**:
- `playbook_sys_id` (required)
- `context` — Key/value context object

### snow_na_ms_copilot_topics_read
**Latest release**: List topics exposed to Microsoft Copilot 365.

**Parameters**: None

### snow_na_work_notes_generate
Generate AI-drafted work notes for a record based on its current context. **[NOW_ASSIST_ENABLED]**

**Parameters**:
- `table` (required) — Table name
- `sys_id` (required) — Record sys_id
- `context` — Additional context to include in the draft

---

## Scripting (27 tools) — Requires `SCRIPTING_ENABLED=true`

All scripting tools require `WRITE_ENABLED=true` + `SCRIPTING_ENABLED=true`.

### snow_scr_business_rules_index
List business rule definitions.

**Parameters**:
- `table` — Filter by target table
- `active`
- `limit`

### snow_scr_business_rule_read
Get full business rule record including script body.

**Parameters**:
- `sys_id` (required)

### snow_scr_business_rule_add
Create a new business rule. **[Scripting]**

**Parameters**:
- `name` (required)
- `table` (required)
- `when` (required) — `before`, `after`, `async`, `display`
- `script` (required)
- `condition`
- `active`

### snow_scr_business_rule_modify
Update a business rule. **[Scripting]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_scr_script_includes_index
List script includes.

**Parameters**:
- `query`
- `active`
- `limit`

### snow_scr_script_include_read
Get full script include record with script body.

**Parameters**:
- `identifier` (required) — sys_id or API name

### snow_scr_script_include_add
Create a new script include. **[Scripting]**

**Parameters**:
- `name` (required)
- `script` (required)
- `api_name`
- `access` — `public` or `package_private`

### snow_scr_script_include_modify
Update a script include. **[Scripting]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_scr_client_scripts_index
List client scripts.

**Parameters**:
- `table`
- `type` — `onLoad`, `onChange`, `onSubmit`, `onCellEdit`
- `active`
- `limit`

### snow_scr_client_script_read
Get client script details and body.

**Parameters**:
- `sys_id` (required)

### snow_scr_client_script_add
Create a new client script. **[Scripting]**

**Parameters**:
- `name` (required)
- `table` (required)
- `type` (required)
- `script` (required)
- `condition`

### snow_scr_client_script_modify
Update a client script. **[Scripting]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_scr_changesets_index
List update sets (changesets).

**Parameters**:
- `state` — `in progress`, `complete`, `ignore`
- `limit`

### snow_scr_changeset_read
Get changeset details.

**Parameters**:
- `identifier` (required) — sys_id or name

### snow_scr_changeset_commit
Commit a changeset. **[Scripting]**

**Parameters**:
- `sys_id` (required)

### snow_scr_changeset_publish
Publish a changeset to the target instance. **[Scripting]**

**Parameters**:
- `sys_id` (required)

### snow_scr_ui_policies_index
List UI policies. **[Scripting]**

**Parameters**:
- `table` — Filter by target table
- `active`
- `limit`

### snow_scr_ui_policy_read
Get UI policy details and actions. **[Scripting]**

**Parameters**:
- `sys_id` (required)

### snow_scr_ui_policy_add
Create a new UI policy. **[Scripting]**

**Parameters**:
- `short_description` (required)
- `table` (required)
- `conditions` — JSON condition string
- `active`

### snow_scr_ui_actions_index
List UI actions (buttons, context menu items). **[Scripting]**

**Parameters**:
- `table` — Filter by target table
- `active`
- `limit`

### snow_scr_ui_action_read
Get UI action details and script. **[Scripting]**

**Parameters**:
- `sys_id` (required)

### snow_scr_ui_action_add
Create a new UI action. **[Scripting]**

**Parameters**:
- `name` (required)
- `table` (required)
- `script` (required)
- `action_name`
- `active`

### snow_scr_ui_action_modify
Update a UI action script or properties. **[Scripting]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_scr_acls_index
List Access Control List rules. **[Scripting]**

**Parameters**:
- `table` — Filter by target table
- `operation` — `read`, `write`, `create`, `delete`
- `active`
- `limit`

### snow_scr_acl_read
Get ACL rule details and condition scripts. **[Scripting]**

**Parameters**:
- `sys_id` (required)

### snow_scr_acl_add
Create a new ACL rule. **[Scripting]**

**Parameters**:
- `name` (required) — `table.operation` format (e.g. `incident.write`)
- `operation` (required) — `read`, `write`, `create`, `delete`
- `active`
- `condition` — Condition script
- `script` — Advanced condition script

### snow_scr_acl_modify
Update an existing ACL rule. **[Scripting]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

---

## Agile / Scrum (9 tools)

Table names use the `AGILE_TABLE_PREFIX` env var (default: `rm_`).

### snow_agile_story_add
Create an agile user story. **[Write]**

**Parameters**:
- `short_description` (required)
- `description`
- `story_points`
- `sprint`
- `epic`

### snow_agile_story_modify
Update a user story. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_agile_stories_index
List user stories with optional filters.

**Parameters**:
- `sprint`
- `epic`
- `state`
- `limit`

### snow_agile_epic_add
Create an epic. **[Write]**

**Parameters**:
- `short_description` (required)
- `description`

### snow_agile_epic_modify
Update an epic. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_agile_epics_index
List epics.

**Parameters**:
- `state`
- `limit`

### snow_agile_scrum_task_add
Create a scrum task. **[Write]**

**Parameters**:
- `short_description` (required)
- `story_sys_id`
- `assigned_to`
- `hours_remaining`

### snow_agile_scrum_task_modify
Update a scrum task. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_agile_scrum_tasks_index
List scrum tasks.

**Parameters**:
- `story_sys_id`
- `assigned_to`
- `limit`

---

## HR Service Delivery (12 tools)

### snow_hr_hr_case_add
Create a new HR case. **[Write]**

**Parameters**:
- `short_description` (required)
- `hr_service` — HR service sys_id
- `opened_for` — Subject person sys_id
- `description`

### snow_hr_hr_case_read
Get HR case details by number or sys_id.

**Parameters**:
- `identifier` (required)

### snow_hr_hr_case_modify
Update an HR case. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_hr_hr_cases_index
List HR cases with optional filters.

**Parameters**:
- `state` — Case state filter
- `hr_service`
- `limit`

### snow_hr_hr_case_close
Close an HR case. **[Write]**

**Parameters**:
- `sys_id` (required)
- `close_notes`

### snow_hr_hr_services_index
List available HR services.

**Parameters**:
- `active` — Filter by active (default: true)
- `limit`

### snow_hr_hr_service_read
Get HR service details.

**Parameters**:
- `sys_id` (required)

### snow_hr_hr_profile_read
Get HR profile for a user.

**Parameters**:
- `user_sys_id` (required)

### snow_hr_hr_profile_modify
Update an HR profile record. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_hr_hr_tasks_index
List HR tasks associated with a case.

**Parameters**:
- `case_sys_id` — Filter by parent case
- `limit`

### snow_hr_hr_task_add
Create an HR task. **[Write]**

**Parameters**:
- `short_description` (required)
- `case_sys_id` — Parent HR case
- `assigned_to`

### snow_hr_hr_case_activity_read
Get the activity log for an HR case.

**Parameters**:
- `case_sys_id` (required)

---

## Customer Service Management (11 tools)

### snow_csm_csm_case_add
Create a new CSM case. **[Write]**

**Parameters**:
- `short_description` (required)
- `account` — Account sys_id
- `contact` — Contact sys_id
- `description`
- `priority`

### snow_csm_csm_case_read
Get CSM case details by number or sys_id.

**Parameters**:
- `identifier` (required)

### snow_csm_csm_case_modify
Update a CSM case. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_csm_csm_cases_index
List CSM cases with optional filters.

**Parameters**:
- `account` — Filter by account
- `state`
- `limit`

### snow_csm_csm_case_close
Close a CSM case. **[Write]**

**Parameters**:
- `sys_id` (required)
- `close_notes`

### snow_csm_csm_account_read
Get CSM account details.

**Parameters**:
- `sys_id` (required)

### snow_csm_csm_accounts_index
List CSM accounts.

**Parameters**:
- `query`
- `limit`

### snow_csm_csm_contact_read
Get CSM contact details.

**Parameters**:
- `sys_id` (required)

### snow_csm_csm_contacts_index
List CSM contacts.

**Parameters**:
- `account_sys_id` — Filter by account
- `limit`

### snow_csm_csm_case_sla_read
Get SLA details for a CSM case.

**Parameters**:
- `case_sys_id` (required)

### snow_csm_csm_products_index
List products associated with CSM cases.

**Parameters**:
- `limit`

---

## Security Operations & GRC (11 tools)

### snow_sec_security_incident_add
Create a security incident. **[Write]**

**Parameters**:
- `short_description` (required)
- `severity` — `1` (Critical) to `4` (Low)
- `category`
- `description`

### snow_sec_security_incident_read
Get security incident details.

**Parameters**:
- `identifier` (required)

### snow_sec_security_incident_modify
Update a security incident. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_sec_security_incidents_index
List security incidents.

**Parameters**:
- `state`
- `severity`
- `limit`

### snow_sec_vulnerabilities_index
List vulnerability entries.

**Parameters**:
- `state` — `open`, `in_progress`, `resolved`
- `risk_rating`
- `limit`

### snow_sec_vulnerability_read
Get vulnerability details.

**Parameters**:
- `sys_id` (required)

### snow_sec_vulnerability_modify
Update a vulnerability record. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_sec_grc_risks_index
List GRC risk records.

**Parameters**:
- `state`
- `limit`

### snow_sec_grc_risk_read
Get GRC risk details.

**Parameters**:
- `sys_id` (required)

### snow_sec_grc_controls_index
List GRC control records.

**Parameters**:
- `risk_sys_id` — Filter by related risk
- `limit`

### snow_sec_threat_intelligence_read
Get threat intelligence entries from the ServiceNow threat feed.

**Parameters**:
- `type` — Indicator type (e.g. `IP`, `URL`)
- `limit`

---

## Flow Designer & Process Automation (10 tools)

### snow_flow_flows_index
List Flow Designer flows.

**Parameters**:
- `active`
- `category`
- `limit`

### snow_flow_flow_read
Get flow details and trigger configuration.

**Parameters**:
- `sys_id` (required)

### snow_flow_flow_trigger
Trigger a flow execution. **[Write]**

**Parameters**:
- `sys_id` (required) — Flow sys_id
- `inputs` — Key/value input object

### snow_flow_flow_execution_read
Get the status and results of a flow execution.

**Parameters**:
- `execution_id` (required)

### snow_flow_flow_executions_index
List flow execution history.

**Parameters**:
- `flow_sys_id` — Filter by flow
- `status` — `running`, `completed`, `failed`
- `limit`

### snow_flow_subflows_index
List subflows.

**Parameters**:
- `active`
- `limit`

### snow_flow_subflow_read
Get subflow details.

**Parameters**:
- `sys_id` (required)

### snow_flow_action_instances_index
List action instances in a flow execution.

**Parameters**:
- `execution_id` (required)

### snow_flow_process_automation_read
Get a Process Automation Designer process.

**Parameters**:
- `sys_id` (required)

### snow_flow_process_automations_index
List Process Automation Designer processes.

**Parameters**:
- `active`
- `limit`

---

## Service Portal & UI Builder (14 tools)

### snow_portal_portals_index
List Service Portal configurations.

**Parameters**:
- `active` — Filter by active (default: true)
- `limit`

### snow_portal_portal_read
Get portal configuration and settings.

**Parameters**:
- `sys_id` (required)

### snow_portal_portal_pages_index
List pages in a Service Portal.

**Parameters**:
- `portal_sys_id` — Filter by portal
- `limit`

### snow_portal_portal_page_read
Get portal page details and layout.

**Parameters**:
- `sys_id` (required)

### snow_portal_portal_widgets_index
List Service Portal widgets.

**Parameters**:
- `query`
- `limit`

### snow_portal_portal_widget_read
Get widget template, CSS, client/server scripts.

**Parameters**:
- `sys_id` (required)

### snow_portal_portal_widget_add
Create a new Service Portal widget. **[Write]**

**Parameters**:
- `name` (required)
- `id` (required) — Widget ID (unique slug)
- `template` — HTML template
- `client_script` — Angular client controller script
- `server_script` — Server-side data script
- `css` — Widget CSS

### snow_portal_portal_widget_modify
Update an existing widget's code. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_portal_widget_instances_index
List widget instances placed on portal pages.

**Parameters**:
- `widget_sys_id` — Filter by widget
- `page_sys_id` — Filter by page
- `limit`

### snow_portal_ux_apps_index
List Next Experience (UI Builder) app configurations.

**Parameters**:
- `active`
- `limit`

### snow_portal_ux_app_read
Get UX app details and routing.

**Parameters**:
- `sys_id` (required)

### snow_portal_ux_pages_index
List pages in a Next Experience app.

**Parameters**:
- `app_sys_id` — Filter by UX app
- `limit`

### snow_portal_portal_themes_index
List Service Portal themes.

**Parameters**:
- `limit`

### snow_portal_portal_theme_read
Get portal theme CSS variables and settings.

**Parameters**:
- `sys_id` (required)

---

## Integration & Middleware (19 tools)

### snow_intg_rest_messages_index
List REST Message configurations.

**Parameters**:
- `query`
- `limit`

### snow_intg_rest_message_read
Get REST Message details, headers, and authentication.

**Parameters**:
- `sys_id` (required)

### snow_intg_rest_message_functions_index
List HTTP methods (functions) for a REST Message.

**Parameters**:
- `rest_message_sys_id` (required)

### snow_intg_rest_message_add
Create a new REST Message configuration. **[Write]**

**Parameters**:
- `name` (required)
- `rest_endpoint` (required) — Base URL
- `description`

### snow_intg_transform_maps_index
List Transform Maps.

**Parameters**:
- `query`
- `limit`

### snow_intg_transform_map_read
Get Transform Map details and field mappings.

**Parameters**:
- `sys_id` (required)

### snow_intg_transform_map_exec
Execute a Transform Map on an import set. **[Write]**

**Parameters**:
- `transform_map_sys_id` (required)
- `import_set_sys_id` (required)

### snow_intg_transform_field_maps_index
List field mappings for a Transform Map.

**Parameters**:
- `transform_map_sys_id` (required)

### snow_intg_import_sets_index
List import set records.

**Parameters**:
- `query`
- `limit`

### snow_intg_import_set_read
Get import set details and processing status.

**Parameters**:
- `sys_id` (required)

### snow_intg_import_set_row_add
Create a row in a staging import set table. **[Write]**

**Parameters**:
- `staging_table` (required) — Import set staging table name
- `data` (required) — Key/value field data

### snow_intg_data_sources_index
List configured data sources for imports.

**Parameters**:
- `limit`

### snow_intg_event_registry_index
List registered events in the event registry.

**Parameters**:
- `query`
- `limit`

### snow_intg_event_registry_entry_read
Get event registry entry details.

**Parameters**:
- `sys_id` (required)

### snow_intg_event_register
Register a new event in the event registry. **[Scripting]**

**Parameters**:
- `name` (required) — Fully qualified event name (e.g. `myapp.record.created`)
- `table` (required) — Target table
- `description`

### snow_intg_event_fire
Fire a ServiceNow event. **[Write]**

**Parameters**:
- `name` (required) — Event name
- `table` (required)
- `sys_id` (required) — Record sys_id
- `param1` — Optional first parameter
- `param2` — Optional second parameter

### snow_intg_event_log_index
List recent event log entries.

**Parameters**:
- `name` — Filter by event name
- `limit`

### snow_intg_oauth_applications_index
List OAuth provider applications.

**Parameters**:
- `limit`

### snow_intg_credential_aliases_index
List credential alias configurations.

**Parameters**:
- `limit`

---

## Notifications & Attachments (12 tools)

### snow_ntf_notifications_index
List email notification configurations.

**Parameters**:
- `table` — Filter by target table
- `active`
- `limit`

### snow_ntf_notification_read
Get notification details, subject, and message body.

**Parameters**:
- `sys_id` (required)

### snow_ntf_notification_add
Create a new email notification. **[Write]**

**Parameters**:
- `name` (required)
- `table` (required)
- `subject` (required)
- `message_html` — HTML email body
- `active`

### snow_ntf_notification_modify
Update an existing notification. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_ntf_email_logs_index
List email delivery log entries.

**Parameters**:
- `state` — `sent`, `failed`, `skipped`
- `limit`

### snow_ntf_email_log_read
Get email log entry details.

**Parameters**:
- `sys_id` (required)

### snow_ntf_attachments_index
List attachments for a record.

**Parameters**:
- `table` (required)
- `record_sys_id` (required)

### snow_ntf_attachment_metadata_read
Get attachment metadata (name, size, content type).

**Parameters**:
- `sys_id` (required)

### snow_ntf_attachment_remove
Delete an attachment by sys_id. **[Write]**

**Parameters**:
- `sys_id` (required)

### snow_ntf_attachment_upload
Upload a file attachment to a record. **[Write]**

**Parameters**:
- `table` (required)
- `record_sys_id` (required)
- `file_name` (required)
- `content_type` (required) — MIME type (e.g. `application/pdf`)
- `content_base64` (required) — Base64-encoded file content

### snow_ntf_email_templates_index
List email notification templates.

**Parameters**:
- `query`
- `limit`

### snow_ntf_notification_subscriptions_index
List notification subscription records.

**Parameters**:
- `user_sys_id` — Filter by user
- `limit`

---

## Performance Analytics & Data Quality (13 tools)

### snow_perf_pa_indicators_index
List Performance Analytics indicators.

**Parameters**:
- `active` — Filter by active (default: true)
- `limit`

### snow_perf_pa_indicator_read
Get PA indicator details and definition.

**Parameters**:
- `sys_id` (required)

### snow_perf_pa_scorecard_read
Get current PA scorecard scores for an indicator.

**Parameters**:
- `indicator_sys_id` (required)
- `limit`

### snow_perf_pa_time_series_read
Get time-series data for a PA indicator.

**Parameters**:
- `indicator_sys_id` (required)
- `periods` — Number of periods (default: 12)

### snow_perf_pa_breakdowns_index
List PA breakdown definitions for an indicator.

**Parameters**:
- `indicator_sys_id` (required)

### snow_perf_pa_dashboards_index
List Performance Analytics dashboards.

**Parameters**:
- `limit`

### snow_perf_pa_dashboard_read
Get PA dashboard details and widget layout.

**Parameters**:
- `sys_id` (required)

### snow_perf_homepages_index
List ServiceNow homepage layouts.

**Parameters**:
- `limit`

### snow_perf_pa_jobs_index
List Performance Analytics collection jobs.

**Parameters**:
- `active`
- `limit`

### snow_perf_pa_job_read
Get PA job details and run schedule.

**Parameters**:
- `sys_id` (required)

### snow_perf_table_completeness_check
Check field completeness for a table (samples up to 500 records and computes per-field fill rate).

**Parameters**:
- `table` (required)
- `fields` — Comma-separated fields to check (default: all)
- `query` — Optional filter query

### snow_perf_table_record_count_read
Get the total record count for a table.

**Parameters**:
- `table` (required)
- `query` — Optional filter

### snow_perf_record_counts_compare
Compare record counts across two tables or two filtered views.

**Parameters**:
- `table1` (required)
- `table2` (required)
- `query1` — Optional filter for table1
- `query2` — Optional filter for table2

---

## System Properties (12 tools)

### snow_cfg_system_property_read
Get a single system property value by name.

**Parameters**:
- `name` (required) — Property name (e.g. `glide.system.name`)

### snow_cfg_system_property_set
Create or update a system property value. **[Write]**

**Parameters**:
- `name` (required)
- `value` (required)
- `description`
- `type` — `string`, `integer`, `boolean`

### snow_cfg_system_properties_index
List system properties with optional category or name filter.

**Parameters**:
- `category`
- `name_like` — Partial name match
- `limit`

### snow_cfg_system_property_remove
Delete a system property by name. **[Write]**

**Parameters**:
- `name` (required)

### snow_cfg_system_properties_query
Search system properties by partial name or value.

**Parameters**:
- `query` (required) — Partial name or value
- `limit`

### snow_cfg_get_properties_bulk
Get multiple system property values in one call.

**Parameters**:
- `names` (required) — Array of property names

### snow_cfg_set_properties_bulk
Set multiple system property values in one call. **[Write]**

**Parameters**:
- `properties` (required) — Object mapping name → value

### snow_cfg_properties_export
Export system properties to a JSON snapshot for backup/comparison.

**Parameters**:
- `category`
- `name_like`
- `limit`

### snow_cfg_properties_import
Import system properties from a JSON snapshot. **[Write]**

**Parameters**:
- `properties` (required) — Array of `{name, value}` objects
- `dry_run` — Validate without saving (default false)

### snow_cfg_property_validate
Validate a property value against its declared type without saving.

**Parameters**:
- `name` (required)
- `value` (required)

### snow_cfg_property_categories_index
List all distinct system property categories.

**Parameters**:
- `limit`

### snow_cfg_property_history_read
Get audit history for a system property (changes over time).

**Parameters**:
- `name` (required)
- `limit`

---

## Update Set Management (8 tools)

### snow_us_current_update_set_read
Get all currently active (in-progress) Update Sets.

### snow_us_update_sets_index
List Update Sets filtered by state.

**Parameters**:
- `state` — `in progress`, `complete`, `ignore`
- `query`
- `limit`

### snow_us_update_set_add
Create a new Update Set and optionally switch to it. **[Scripting]**

**Parameters**:
- `name` (required)
- `description`
- `release`
- `switch_to` — Switch after creation (default true)

### snow_us_update_set_switch
Switch the active Update Set context. **[Scripting]**

**Parameters**:
- `sys_id` (required)

### snow_us_update_set_complete
Mark an Update Set as complete. **[Scripting]**

**Parameters**:
- `sys_id` (required)

### snow_us_update_set_preview
Preview all changes (sys_update_xml records) contained in an Update Set.

**Parameters**:
- `sys_id` (required)
- `limit`

### snow_us_update_set_export
Get the XML export summary for an Update Set. **[Scripting]**

**Parameters**:
- `sys_id` (required)

### snow_us_active_update_set_ensure
Ensure an active Update Set exists; auto-creates one if none is in progress. **[Scripting]**

**Parameters**:
- `default_name` — Name for auto-created set (default: `AI Session Update Set YYYY-MM-DD`)

---

## Virtual Agent (7 tools)

### snow_va_va_topic_add
Create a new Virtual Agent conversation topic. **[Write]**

**Parameters**:
- `name` (required)
- `description`
- `category` — Category sys_id
- `active` — Default true
- `fulfillment_type` — `itsm_integration`, `custom`, `web_service`

### snow_va_va_topic_modify
Update Virtual Agent topic properties. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required) — Fields to update

### snow_va_va_topic_read
Get Virtual Agent topic details including intent and trigger phrases.

**Parameters**:
- `sys_id` (required)

### snow_va_va_topics_full_index
List all Virtual Agent topics with category and status details.

**Parameters**:
- `active` — Default true
- `category` — Filter by category name
- `query`
- `limit`

### snow_va_va_conversation_read
Get conversation history for a Virtual Agent session.

**Parameters**:
- `conversation_id` (required)
- `limit`

### snow_va_va_conversations_index
List recent Virtual Agent conversations.

**Parameters**:
- `topic_sys_id`
- `user_sys_id`
- `limit`

### snow_va_va_categories_index
List Virtual Agent topic categories.

**Parameters**:
- `limit`

---

## IT Asset Management / ITAM (8 tools)

### snow_itam_assets_index
List IT assets with optional type/status filter.

**Parameters**:
- `asset_class` — `hardware`, `software`, `consumable`
- `status` — `in use`, `in stock`, `retired`
- `assigned_to`
- `query`
- `limit`

### snow_itam_asset_read
Get full asset record details.

**Parameters**:
- `sys_id` (required)

### snow_itam_asset_add
Create a new asset record. **[Write]**

**Parameters**:
- `asset_tag` (required)
- `model` — Model sys_id or name
- `serial_number`
- `assigned_to`
- `location`
- `status`

### snow_itam_asset_modify
Update asset fields. **[Write]**

**Parameters**:
- `sys_id` (required)
- `fields` (required)

### snow_itam_asset_retire
Mark an asset as retired (sets install_status to retired). **[Write]**

**Parameters**:
- `sys_id` (required)
- `reason`

### snow_itam_software_licenses_index
List software license records.

**Parameters**:
- `vendor`
- `product`
- `limit`

### snow_itam_license_compliance_read
Get license compliance report showing purchased vs. in-use counts.

**Parameters**:
- `license_sys_id` — Specific license; all licenses if omitted
- `limit`

### snow_itam_asset_contracts_index
List asset contracts (maintenance, support).

**Parameters**:
- `active` — Default true
- `limit`

---

## DevOps & Pipeline Tracking (7 tools)

### snow_devops_devops_pipelines_index
List DevOps pipeline configurations registered in ServiceNow.

**Parameters**:
- `active` — Default true
- `limit`

### snow_devops_devops_pipeline_read
Get details of a specific DevOps pipeline.

**Parameters**:
- `sys_id` (required)

### snow_devops_deployments_index
List recent application deployments tracked in ServiceNow.

**Parameters**:
- `pipeline_sys_id`
- `environment` — e.g. `prod`, `staging`
- `state` — `success`, `failed`, `in_progress`
- `limit`

### snow_devops_deployment_read
Get details and status of a specific deployment.

**Parameters**:
- `sys_id` (required)

### snow_devops_devops_change_add
Create a change request linked to a DevOps deployment. **[Write]**

**Parameters**:
- `short_description` (required)
- `environment` (required)
- `pipeline`
- `artifact`
- `type` — `normal`, `standard`, `emergency`
- `assigned_to`
- `assignment_group`

### snow_devops_deployment_track
Record a deployment event for audit and velocity tracking. **[Write]**

**Parameters**:
- `environment` (required)
- `artifact_name` (required)
- `status` (required) — `success`, `failed`, `rolled_back`
- `pipeline`
- `artifact_version`
- `notes`

### snow_devops_devops_insights_read
Get deployment frequency, failure rate, and lead time metrics.

**Parameters**:
- `pipeline_sys_id` — All pipelines if omitted
- `days` — Look-back window (default 30)

---

## See Also

- [TOOL_PACKAGES.md](TOOL_PACKAGES.md) — Role-based packages
- [NOW_ASSIST.md](NOW_ASSIST.md) — Now Assist integration guide
- [ATF.md](ATF.md) — ATF testing guide
- [SCRIPTING.md](SCRIPTING.md) — Scripting management guide
- [REPORTING.md](REPORTING.md) — Reporting and analytics guide
