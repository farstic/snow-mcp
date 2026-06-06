# ATF Testing Guide (Latest Release)

This guide covers the 9 Automated Test Framework (ATF) tools available when `ATF_ENABLED=true`.

## Prerequisites

```env
ATF_ENABLED=true
WRITE_ENABLED=true  # Required for running tests (write operations)
```

## Tool Overview

| Tool | Permission | Description |
|------|-----------|-------------|
| `snow_atf_atf_suites_index` | Read | List test suites |
| `snow_atf_atf_suite_read` | Read | Get suite details |
| `snow_atf_atf_suite_exec` | ATF_ENABLED | Execute a test suite |
| `snow_atf_atf_tests_index` | Read | List test cases |
| `snow_atf_atf_test_read` | Read | Get test details |
| `snow_atf_atf_test_exec` | ATF_ENABLED | Execute a single test |
| `snow_atf_atf_suite_result_read` | Read | Get suite run results |
| `snow_atf_atf_test_results_index` | Read | List test results |
| `snow_atf_atf_failure_insight_read` | Read | **Latest**: Failure Insight analysis |

## Common Workflows

### Run Regression Suite After Deployment

```
1. List available test suites
   → snow_atf_atf_suites_index

2. Run the regression suite
   → snow_atf_atf_suite_exec sys_id="<suite_sys_id>"
   → Returns: {result_sys_id: "abc123", status: "running"}

3. Get results
   → snow_atf_atf_suite_result_read result_sys_id="abc123"
   → Returns: {status: "complete", passed: 47, failed: 2}

4. Investigate failures (ATF Failure Insight)
   → snow_atf_atf_failure_insight_read result_sys_id="abc123"
   → Returns: changes between last pass and this failure
```

### ATF Failure Insight

`snow_atf_atf_failure_insight_read` is a latest release tool that compares metadata between the last successful ATF run and the current failed run. It surfaces:

- User role changes (a role was added/removed from the ATF user)
- Field value changes on records referenced by tests
- Configuration changes that may have broken test assertions

**Example output**:
```json
{
  "changes_since_last_pass": [
    {
      "type": "role_change",
      "user": "atf_test_user",
      "removed_role": "itil",
      "changed_at": "2025-03-15T10:23:00Z"
    },
    {
      "type": "field_change",
      "table": "sys_properties",
      "field": "glide.authenticate.multifactor",
      "old_value": "false",
      "new_value": "true"
    }
  ]
}
```

API: `GET /api/now/table/sys_atf_failure_insight`

## ServiceNow ATF APIs

| API | Endpoint |
|-----|----------|
| Run Suite | `POST /api/now/atf/runner/run_suite` |
| List Suites | `GET /api/now/table/sys_atf_test_suite` |
| Get Results | `GET /api/now/table/sys_atf_result` |
| Failure Insight | `GET /api/now/table/sys_atf_failure_insight` |

## Configuration Example

```env
ATF_ENABLED=true
WRITE_ENABLED=true
MCP_TOOL_PACKAGE=platform_developer
```
