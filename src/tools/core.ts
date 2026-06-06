/**
 * Core platform tools – the original 15 tools migrated from tools/index.ts.
 * These are always available (Tier 0).
 */
import type { ServiceNowClient } from '../servicenow/client.js';
import type {
  QueryRecordsParams,
  GetRecordParams,
  SearchCmdbCiParams,
  GetCmdbCiParams,
  ListRelationshipsParams,
  ListDiscoverySchedulesParams,
  ListMidServersParams,
  ListActiveEventsParams,
  ServiceMappingSummaryParams,
} from '../servicenow/types.js';
import { ServiceNowError } from '../utils/errors.js';
import { requireWrite } from '../utils/permissions.js';
import { instanceManager } from '../servicenow/instances.js';

export function coreToolManifest() {
  return [
    {
      name: 'snow_core_records_query',
      description: 'Query ServiceNow records with filtering, field selection, pagination, and sorting',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name (e.g., "incident", "change_request")' },
          query: { type: 'string', description: 'Encoded query string (e.g., "active=true^priority=1")' },
          fields: { type: 'string', description: 'Comma-separated fields to return' },
          limit: { type: 'number', description: 'Max records (default: 10, max: 1000)' },
          orderBy: { type: 'string', description: 'Field to sort by. Prefix with "-" for descending' },
        },
        required: ['table'],
      },
    },
    {
      name: 'snow_core_table_schema_read',
      description: 'Get the structure and field information for a ServiceNow table',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name to inspect' },
        },
        required: ['table'],
      },
    },
    {
      name: 'snow_core_record_read',
      description: 'Retrieve complete details of a specific record by sys_id',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name' },
          sys_id: { type: 'string', description: '32-character system ID' },
          fields: { type: 'string', description: 'Optional comma-separated fields' },
        },
        required: ['table', 'sys_id'],
      },
    },
    {
      name: 'snow_core_record_add',
      description: 'Create a new record in any ServiceNow table (requires WRITE_ENABLED=true)',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name (e.g., "incident", "sys_user_preference")' },
          fields: { type: 'object', description: 'Key-value pairs for the new record fields' },
        },
        required: ['table', 'fields'],
      },
    },
    {
      name: 'snow_core_record_modify',
      description: 'Update an existing record in any ServiceNow table (requires WRITE_ENABLED=true)',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name (e.g., "incident", "sys_user_preference")' },
          sys_id: { type: 'string', description: '32-character system ID of the record to update' },
          fields: { type: 'object', description: 'Key-value pairs of fields to update' },
        },
        required: ['table', 'sys_id', 'fields'],
      },
    },
    {
      name: 'snow_core_record_remove',
      description: 'Delete a record from any ServiceNow table (requires WRITE_ENABLED=true)',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name' },
          sys_id: { type: 'string', description: '32-character system ID of the record to delete' },
        },
        required: ['table', 'sys_id'],
      },
    },
    {
      name: 'snow_core_user_read',
      description: 'Look up user details by email or username',
      inputSchema: {
        type: 'object',
        properties: {
          user_identifier: { type: 'string', description: 'Email address or username' },
        },
        required: ['user_identifier'],
      },
    },
    {
      name: 'snow_core_group_read',
      description: 'Find assignment group details by name or sys_id',
      inputSchema: {
        type: 'object',
        properties: {
          group_identifier: { type: 'string', description: 'Group name or sys_id' },
        },
        required: ['group_identifier'],
      },
    },
    {
      name: 'snow_core_cmdb_ci_query',
      description: 'Search for configuration items (CIs) in the CMDB',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Encoded query (e.g., "sys_class_name=cmdb_ci_server")' },
          limit: { type: 'number', description: 'Max CIs (default: 10, max: 100)' },
        },
        required: [],
      },
    },
    {
      name: 'snow_core_cmdb_ci_read',
      description: 'Get complete information about a specific configuration item',
      inputSchema: {
        type: 'object',
        properties: {
          ci_sys_id: { type: 'string', description: 'System ID of the CI' },
          fields: { type: 'string', description: 'Optional comma-separated fields' },
        },
        required: ['ci_sys_id'],
      },
    },
    {
      name: 'snow_core_relationships_index',
      description: 'Show parent and child relationships for a CI',
      inputSchema: {
        type: 'object',
        properties: {
          ci_sys_id: { type: 'string', description: 'System ID of the CI' },
        },
        required: ['ci_sys_id'],
      },
    },
    {
      name: 'snow_core_discovery_schedules_index',
      description: 'List discovery schedules and their run status',
      inputSchema: {
        type: 'object',
        properties: {
          active_only: { type: 'boolean', description: 'Only show active schedules' },
        },
        required: [],
      },
    },
    {
      name: 'snow_core_mid_servers_index',
      description: 'List MID servers and verify they are healthy',
      inputSchema: {
        type: 'object',
        properties: {
          active_only: { type: 'boolean', description: 'Only show servers with status "Up"' },
        },
        required: [],
      },
    },
    {
      name: 'snow_core_active_events_index',
      description: 'Monitor critical infrastructure events',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Filter events (e.g., "severity=1")' },
          limit: { type: 'number', description: 'Max events (default: 10)' },
        },
        required: [],
      },
    },
    {
      name: 'snow_core_health_dashboard_read',
      description: 'Get CMDB data quality metrics (completeness of server and network CI data)',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'snow_core_service_mapping_summary_read',
      description: 'View service dependencies and related CIs for impact analysis',
      inputSchema: {
        type: 'object',
        properties: {
          service_sys_id: { type: 'string', description: 'System ID of the business service' },
        },
        required: ['service_sys_id'],
      },
    },
    {
      name: 'snow_core_natural_language_query',
      description: 'Search ServiceNow using plain English (experimental)',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Plain English query' },
          limit: { type: 'number', description: 'Max results (default: 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'snow_core_natural_language_modify',
      description: 'Update a record using natural language (experimental, requires WRITE_ENABLED=true)',
      inputSchema: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'Natural language update instruction' },
          table: { type: 'string', description: 'Table name' },
        },
        required: ['instruction', 'table'],
      },
    },
    {
      name: 'snow_core_instances_index',
      description: 'List all configured ServiceNow instances (multi-instance / multi-customer support)',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'snow_core_instance_switch',
      description: 'Switch the active ServiceNow instance for this session',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Instance name as configured (e.g. "prod", "dev", "customer_a")' },
        },
        required: ['name'],
      },
    },
    {
      name: 'snow_core_current_instance_read',
      description: 'Get the currently active ServiceNow instance name and URL',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'snow_core_ci_relationship_add',
      description: '[Write] Create a relationship between two CMDB Configuration Items',
      inputSchema: {
        type: 'object',
        properties: {
          parent: { type: 'string', description: 'Parent CI sys_id' },
          child: { type: 'string', description: 'Child CI sys_id' },
          type: { type: 'string', description: 'Relationship type (e.g. "Runs on::Runs")' },
        },
        required: ['parent', 'child', 'type'],
      },
    },
    {
      name: 'snow_core_analysis_impact',
      description: 'Analyze the downstream impact of a Configuration Item change or outage',
      inputSchema: {
        type: 'object',
        properties: {
          ci_sys_id: { type: 'string', description: 'CI sys_id to analyze' },
          depth: { type: 'number', description: 'Relationship depth to traverse (default: 2)' },
        },
        required: ['ci_sys_id'],
      },
    },
    {
      name: 'snow_core_discovery_scan_exec',
      description: '[Write] Trigger a ServiceNow Discovery scan for network/infrastructure',
      inputSchema: {
        type: 'object',
        properties: {
          schedule_id: { type: 'string', description: 'Discovery schedule sys_id to run' },
          mid_server: { type: 'string', description: 'Optional MID server name' },
        },
        required: ['schedule_id'],
      },
    },
  ];
}

export async function dispatchCoreAction(
  client: ServiceNowClient,
  name: string,
  args: Record<string, any>
): Promise<any> {
  switch (name) {
    case 'snow_core_records_query': {
      const params = args as QueryRecordsParams;
      if (!params.table) throw new ServiceNowError('Table name is required', 'INVALID_REQUEST');
      const response = await client.queryRecords(params);
      return { count: response.count, records: response.records, summary: `Found ${response.count} record(s) in "${params.table}"` };
    }
    case 'snow_core_table_schema_read':
      if (!args.table) throw new ServiceNowError('Table name is required', 'INVALID_REQUEST');
      return await client.getTableSchema(args.table);

    case 'snow_core_record_read': {
      const p = args as GetRecordParams;
      if (!p.table || !p.sys_id) throw new ServiceNowError('table and sys_id are required', 'INVALID_REQUEST');
      return await client.getRecord(p.table, p.sys_id, p.fields);
    }
    case 'snow_core_record_add': {
      requireWrite();
      if (!args.table || !args.fields) throw new ServiceNowError('table and fields are required', 'INVALID_REQUEST');
      const created = await client.createRecord(args.table, args.fields);
      return { action: 'created', table: args.table, ...created };
    }

    case 'snow_core_record_modify': {
      requireWrite();
      if (!args.table || !args.sys_id || !args.fields) throw new ServiceNowError('table, sys_id, and fields are required', 'INVALID_REQUEST');
      const updated = await client.updateRecord(args.table, args.sys_id, args.fields);
      return { action: 'updated', table: args.table, sys_id: args.sys_id, ...updated };
    }

    case 'snow_core_record_remove': {
      requireWrite();
      if (!args.table || !args.sys_id) throw new ServiceNowError('table and sys_id are required', 'INVALID_REQUEST');
      await client.deleteRecord(args.table, args.sys_id);
      return { action: 'deleted', table: args.table, sys_id: args.sys_id };
    }

    case 'snow_core_user_read':
      if (!args.user_identifier) throw new ServiceNowError('user_identifier is required', 'INVALID_REQUEST');
      return await client.getUser(args.user_identifier);

    case 'snow_core_group_read':
      if (!args.group_identifier) throw new ServiceNowError('group_identifier is required', 'INVALID_REQUEST');
      return await client.getGroup(args.group_identifier);

    case 'snow_core_cmdb_ci_query':
      return await client.searchCmdbCi((args as SearchCmdbCiParams).query, (args as SearchCmdbCiParams).limit);

    case 'snow_core_cmdb_ci_read': {
      const p = args as GetCmdbCiParams;
      if (!p.ci_sys_id) throw new ServiceNowError('ci_sys_id is required', 'INVALID_REQUEST');
      return await client.getCmdbCi(p.ci_sys_id, p.fields);
    }
    case 'snow_core_relationships_index': {
      const p = args as ListRelationshipsParams;
      if (!p.ci_sys_id) throw new ServiceNowError('ci_sys_id is required', 'INVALID_REQUEST');
      return await client.listRelationships(p.ci_sys_id);
    }
    case 'snow_core_discovery_schedules_index':
      return await client.listDiscoverySchedules((args as ListDiscoverySchedulesParams).active_only);

    case 'snow_core_mid_servers_index':
      return await client.listMidServers((args as ListMidServersParams).active_only);

    case 'snow_core_active_events_index':
      return await client.listActiveEvents((args as ListActiveEventsParams).query, (args as ListActiveEventsParams).limit);

    case 'snow_core_health_dashboard_read':
      return await client.cmdbHealthDashboard();

    case 'snow_core_service_mapping_summary_read': {
      const p = args as ServiceMappingSummaryParams;
      if (!p.service_sys_id) throw new ServiceNowError('service_sys_id is required', 'INVALID_REQUEST');
      return await client.serviceMappingSummary(p.service_sys_id);
    }
    case 'snow_core_natural_language_query':
      return await client.naturalLanguageSearch(args.query, args.limit);

    case 'snow_core_natural_language_modify':
      requireWrite();
      return await client.naturalLanguageUpdate(args.instruction, args.table);

    case 'snow_core_instances_index':
      return {
        current: instanceManager.getCurrentName(),
        instances: instanceManager.listAll(),
        total: instanceManager.listNames().length,
      };

    case 'snow_core_instance_switch':
      if (!args.name) throw new ServiceNowError('name is required', 'INVALID_REQUEST');
      instanceManager.switch(args.name);
      return {
        action: 'switched',
        active_instance: instanceManager.getCurrentName(),
        url: instanceManager.getCurrentUrl(),
      };

    case 'snow_core_current_instance_read':
      return {
        name: instanceManager.getCurrentName(),
        url: instanceManager.getCurrentUrl(),
        all_instances: instanceManager.listNames(),
      };

    case 'snow_core_ci_relationship_add': {
      requireWrite();
      if (!args.parent || !args.child || !args.type)
        throw new ServiceNowError('parent, child, and type are required', 'INVALID_REQUEST');
      const result = await client.createRecord('cmdb_rel_ci', {
        parent: args.parent,
        child: args.child,
        type: args.type,
      });
      return { ...result, summary: `Created CI relationship: ${args.parent} -> ${args.child} (${args.type})` };
    }

    case 'snow_core_analysis_impact': {
      if (!args.ci_sys_id) throw new ServiceNowError('ci_sys_id is required', 'INVALID_REQUEST');
      const maxDepth = args.depth || 2;
      const visited = new Set<string>();
      const impactTree: any[] = [];

      async function traverse(ciSysId: string, currentDepth: number): Promise<any[]> {
        if (currentDepth > maxDepth || visited.has(ciSysId)) return [];
        visited.add(ciSysId);
        const resp = await client.queryRecords({
          table: 'cmdb_rel_ci',
          query: `parent=${ciSysId}`,
          fields: 'sys_id,child,type,parent',
          limit: 100,
        });
        const children: any[] = [];
        for (const rel of resp.records) {
          const childId = typeof rel.child === 'object' ? (rel.child as any).value : rel.child;
          const downstream = await traverse(childId, currentDepth + 1);
          children.push({ relationship: rel, downstream });
        }
        return children;
      }

      const downstream = await traverse(args.ci_sys_id, 1);
      impactTree.push({ ci_sys_id: args.ci_sys_id, depth: maxDepth, downstream });
      return { impact_analysis: impactTree, total_impacted: visited.size - 1 };
    }

    case 'snow_core_discovery_scan_exec': {
      requireWrite();
      if (!args.schedule_id) throw new ServiceNowError('schedule_id is required', 'INVALID_REQUEST');
      const data: Record<string, any> = {
        dsc_schedule: args.schedule_id,
        state: 'active',
      };
      if (args.mid_server) data.mid_server = args.mid_server;
      const result = await client.createRecord('discovery_status', data);
      return { ...result, summary: `Triggered discovery scan for schedule ${args.schedule_id}` };
    }

    default:
      return null; // not handled here
  }
}
