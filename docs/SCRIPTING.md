# Scripting Management Guide (Latest Release)

This guide covers the 27 scripting tools available when `SCRIPTING_ENABLED=true`. These tools provide direct access to business rules, script includes, client scripts, UI policies, UI actions, ACLs, and changeset management.

## Prerequisites

```env
WRITE_ENABLED=true
SCRIPTING_ENABLED=true
```

## Tool Overview

| Domain | Tools | Table |
|--------|-------|-------|
| Business Rules | list, get, create, update | `sys_script` |
| Script Includes | list, get, create, update | `sys_script_include` |
| Client Scripts | list, get, create, update | `sys_script_client` |
| UI Policies | list, get, create | `sys_ui_policy` |
| UI Actions | list, get, create, update | `sys_ui_action` |
| ACLs | list, get, create, update | `sys_security_acl` |
| Changesets | list, get, commit, publish | `sys_update_set` |

## Latest Release Scripting Notes

### ES2021 Support
ServiceNow fully supports ES2021 (ES12) features in server-side scripts:
- `async`/`await` in business rules and script includes
- Optional chaining (`?.`)
- Nullish coalescing (`??`)
- Promise-based patterns

### GlideEncrypter Deprecation
`GlideEncrypter` is deprecated in recent releases. Use `GlideEncryptionUtils` instead:
```javascript
// Deprecated (recent releases)
var enc = new GlideEncrypter();

// Recommended
var enc = new GlideEncryptionUtils();
```

### ML API
Scripts can now call Predictive Intelligence directly:
```javascript
var result = new sn_ml.Predictor(solutionId).predict(inputData);
```

## Common Workflows

### Review and Update a Business Rule

```
1. List business rules for a table
   → snow_scr_business_rules_index table="incident"

2. Get full script body
   → snow_scr_business_rule_read sys_id="<sys_id>"

3. Update the script
   → snow_scr_business_rule_modify sys_id="<sys_id>" fields={script: "...updated..."}
```

### Manage Changesets

```
1. List in-progress changesets
   → snow_scr_changesets_index state="in progress"

2. Review changeset contents
   → snow_scr_changeset_read identifier="<sys_id>"

3. Commit the changeset
   → snow_scr_changeset_commit sys_id="<sys_id>"

4. Publish to target
   → snow_scr_changeset_publish sys_id="<sys_id>"
```

## UI Policy Workflow

```
1. List UI policies for a table
   → snow_scr_ui_policies_index table="incident"

2. Get policy details
   → snow_scr_ui_policy_read sys_id="<sys_id>"

3. Create a new UI policy
   → snow_scr_ui_policy_add short_description="Hide field on resolve" table="incident" active=true
```

## UI Action Workflow

```
1. List UI actions for a table
   → snow_scr_ui_actions_index table="incident"

2. Inspect an action's script
   → snow_scr_ui_action_read sys_id="<sys_id>"

3. Create a button action
   → snow_scr_ui_action_add name="Escalate" table="incident" action_name="escalate" script="..."
```

## ACL Management Workflow

```
1. List ACLs for a table
   → snow_scr_acls_index table="incident" operation="write"

2. Get ACL rule details
   → snow_scr_acl_read sys_id="<sys_id>"

3. Create a new ACL
   → snow_scr_acl_add name="incident.write" operation="write" condition="current.state != 6"

4. Update existing ACL
   → snow_scr_acl_modify sys_id="<sys_id>" fields={script: "...updated condition..."}
```

## Configuration Example

```env
WRITE_ENABLED=true
SCRIPTING_ENABLED=true
MCP_TOOL_PACKAGE=platform_developer
```
