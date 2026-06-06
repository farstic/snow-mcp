# Reporting & Analytics Guide (Latest Release)

This guide covers the 13 reporting and analytics tools. Read tools require no special flags. Scheduled job write tools require `WRITE_ENABLED=true`.

## Tool Overview

| Tool | Description | API Used | Permission |
|------|-------------|----------|------------|
| `snow_rpt_reports_index` | List saved reports | Table API (`sys_report`) | Read |
| `snow_rpt_report_read` | Get report definition | Table API | Read |
| `snow_rpt_aggregate_query_exec` | GROUP BY query with COUNT/SUM | Stats API (`/api/now/stats/{table}`) | Read |
| `snow_rpt_query_trend` | Monthly trend data | Stats API (date bucketing) | Read |
| `snow_rpt_performance_analytics_read` | PA widget data | PA API (`/api/now/pa/widget/{sys_id}`) | Read |
| `snow_rpt_report_data_export` | Structured data export | Table API | Read |
| `snow_rpt_sys_log_read` | System log entries | Table API (`sys_log`) | Read |
| `snow_rpt_scheduled_jobs_index` | Scheduled jobs list | Table API (`sys_trigger`) | Read |
| `snow_rpt_scheduled_job_read` | Get a scheduled job record | Table API (`sysauto`) | Read |
| `snow_rpt_scheduled_job_add` | Create a new scheduled script | Table API (`sysauto_script`) | Write |
| `snow_rpt_scheduled_job_modify` | Update schedule or script | Table API (`sysauto`) | Write |
| `snow_rpt_scheduled_job_trigger` | Force immediate execution | Table API (`sysauto`) PATCH | Write |
| `snow_rpt_job_run_history_index` | Execution history log | Table API (`sysauto_trigger_log`) | Read |

## Common Use Cases

### Incident Trend by Priority (Last 6 Months)

```
run snow_rpt_query_trend:
  table: incident
  date_field: opened_at
  group_by: priority
  periods: 6
```

Returns monthly counts grouped by priority level.

### SLA Compliance Rate

```
snow_rpt_aggregate_query_exec:
  table: task_sla
  group_by: has_breached
  aggregate: COUNT
```

Returns count of breached vs. compliant SLAs.

### Top Teams by Open Incidents

```
snow_rpt_aggregate_query_exec:
  table: incident
  group_by: assignment_group
  query: state!=6
  aggregate: COUNT
```

### Performance Analytics Widget

```
snow_rpt_performance_analytics_read:
  widget_sys_id: <PA widget sys_id>
  time_range: last_30_days
```

Uses the ServiceNow Performance Analytics API: `GET /api/now/pa/widget/{sys_id}`

## Scheduled Job Workflows

### Create and Schedule a Script

```
1. Create a new daily script job
   → snow_rpt_scheduled_job_add name="Nightly Cleanup" script="gs.info('running');" run_type="daily" run_time="02:00:00"

2. Verify the job was created
   → snow_rpt_scheduled_job_read sys_id="<sys_id>"

3. Trigger immediately to test
   → snow_rpt_scheduled_job_trigger sys_id="<sys_id>"

4. Check execution history
   → snow_rpt_job_run_history_index job_sys_id="<sys_id>"
```

### Update a Scheduled Job

```
1. List all active scheduled jobs
   → snow_rpt_scheduled_jobs_index active=true

2. Update the script or schedule
   → snow_rpt_scheduled_job_modify sys_id="<sys_id>" fields={script: "// updated script", run_type: "weekly"}
```

## Latest Reporting APIs

| API | Endpoint | Notes |
|-----|----------|-------|
| Stats (Aggregate) | `GET /api/now/stats/{table}` | GROUP BY, SUM, COUNT, AVG |
| Performance Analytics | `GET /api/now/pa/widget/{sys_id}` | PA scorecard data |
| Reporting | `GET /api/now/reporting` | Saved report search (latest release) |
| Table (for sys_report) | `GET /api/now/table/sys_report` | Report definitions |
