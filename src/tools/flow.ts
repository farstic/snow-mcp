/**
 * Flow Designer tools — list, inspect and monitor flows and subflows.
 * Read tools: Tier 0. snow_flow_flow_action_add: Tier 3 (SCRIPTING_ENABLED=true).
 *
 * DEPRECATED (names kept for catalogue parity, bodies replaced by a DEPRECATED_TOOL error):
 *   snow_flow_flow_add, snow_flow_subflow_add → snow_flow_plan / snow_flow_build (src/tools/flow-builder.ts)
 *   snow_flow_flow_publish                    → snow_flow_build activate:true (with FLOW_BUILDER_ACTIVATE_ENABLED) or Activate in Workflow Studio
 *   snow_flow_flow_test, snow_flow_flow_trigger → snow_flow_verify + a real record/ATF trigger
 * The old bodies wrote a bare sys_hub_flow / sys_hub_subflow row (no children, white screen in
 * Workflow Studio), PATCHed active=true (not an activation) and posted to a non-existent
 * sys_hub_flow_trigger table.
 *
 * Re-pointed reads: there is no sys_hub_subflow table — subflows are sys_hub_flow rows with
 * type=subflow; the legacy sys_hub_action_instance table is empty on recent releases — action
 * definitions live in sys_hub_action_type_definition.
 */
import type { ServiceNowClient } from '../servicenow/client.js';
import { ServiceNowError } from '../utils/errors.js';
import { requireScripting } from '../utils/permissions.js';

/** Legacy flow write tools and the replacement each one points to. */
export const DEPRECATED_FLOW_TOOLS: Record<string, string> = {
  snow_flow_flow_add: 'snow_flow_plan (dry run) then snow_flow_build with a FlowSpec (type "flow")',
  snow_flow_subflow_add: 'snow_flow_plan (dry run) then snow_flow_build with a FlowSpec (flow.type "subflow")',
  snow_flow_flow_publish: 'snow_flow_build with activate:true (requires FLOW_BUILDER_ACTIVATE_ENABLED=true and a separate approval), or Activate in Workflow Studio, then snow_flow_verify',
  snow_flow_flow_test: 'snow_flow_verify for the read-back, then trigger the flow with a real record (or an ATF test) under its own approval',
  snow_flow_flow_trigger: 'snow_flow_verify for the read-back, then trigger the flow with a real record (or an ATF test) under its own approval',
};

function deprecated(name: string): never {
  throw new ServiceNowError(
    `${name} is deprecated and no longer performs any write. Use: ${DEPRECATED_FLOW_TOOLS[name]}.`,
    'DEPRECATED_TOOL',
    { replacement: DEPRECATED_FLOW_TOOLS[name] }
  );
}

export function flowToolManifest() {
  return [
    {
      name: 'snow_flow_flows_index',
      description: 'List Flow Designer flows with optional filter by name, category, or active status',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search flows by name or description' },
          active: { type: 'boolean', description: 'Filter to active flows only (default true)' },
          category: { type: 'string', description: 'Filter by category (e.g., "ITSM", "HR", "Security")' },
          limit: { type: 'number', description: 'Max records to return (default 50)' },
        },
        required: [],
      },
    },
    {
      name: 'snow_flow_flow_read',
      description: 'Get full details of a Flow Designer flow including its actions and trigger',
      inputSchema: {
        type: 'object',
        properties: {
          name_or_sysid: { type: 'string', description: 'Flow name or sys_id' },
        },
        required: ['name_or_sysid'],
      },
    },
    {
      name: 'snow_flow_flow_trigger',
      description: 'DEPRECATED - performs no write; use snow_flow_verify and trigger the flow with a real record/ATF test. (Kept for catalogue parity.)',
      inputSchema: {
        type: 'object',
        properties: {
          flow_sys_id: { type: 'string', description: 'sys_id of the flow to trigger' },
          inputs: { type: 'object', description: 'Key-value pairs for flow input variables' },
        },
        required: ['flow_sys_id'],
      },
    },
    {
      name: 'snow_flow_flow_execution_read',
      description: 'Get the status and details of a specific flow execution',
      inputSchema: {
        type: 'object',
        properties: {
          execution_sysid: { type: 'string', description: 'sys_id of the flow execution to inspect' },
        },
        required: ['execution_sysid'],
      },
    },
    {
      name: 'snow_flow_flow_executions_index',
      description: 'List recent executions of a flow with status (completed, error, running)',
      inputSchema: {
        type: 'object',
        properties: {
          flow_sys_id: { type: 'string', description: 'sys_id of the parent flow' },
          status: { type: 'string', description: 'Filter by status: running, complete, error, cancelled' },
          limit: { type: 'number', description: 'Max records to return (default 25)' },
        },
        required: ['flow_sys_id'],
      },
    },
    {
      name: 'snow_flow_subflows_index',
      description: 'List available subflows (sys_hub_flow rows with type=subflow) that can be reused across flows',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search subflows by name' },
          active: { type: 'boolean', description: 'Filter to active subflows only (default true)' },
          limit: { type: 'number', description: 'Max records to return (default 50)' },
        },
        required: [],
      },
    },
    {
      name: 'snow_flow_subflow_read',
      description: 'Get full details of a subflow (sys_hub_flow, type=subflow) including its inputs, outputs, and actions',
      inputSchema: {
        type: 'object',
        properties: {
          name_or_sysid: { type: 'string', description: 'Subflow name or sys_id' },
        },
        required: ['name_or_sysid'],
      },
    },
    {
      name: 'snow_flow_action_instances_index',
      description: 'List Flow Designer action definitions (sys_hub_action_type_definition) available in the environment',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search actions by name or category' },
          category: { type: 'string', description: 'Filter by action category (e.g., "ServiceNow Core", "Integrations")' },
          limit: { type: 'number', description: 'Max records to return (default 50)' },
        },
        required: [],
      },
    },
    {
      name: 'snow_flow_process_automation_read',
      description: 'Get details of a Process Automation Designer playbook or process',
      inputSchema: {
        type: 'object',
        properties: {
          name_or_sysid: { type: 'string', description: 'Playbook or process name or sys_id' },
        },
        required: ['name_or_sysid'],
      },
    },
    {
      name: 'snow_flow_process_automations_index',
      description: 'List Process Automation Designer playbooks and processes',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search by name or description' },
          active: { type: 'boolean', description: 'Filter to active processes only (default true)' },
          limit: { type: 'number', description: 'Max records to return (default 50)' },
        },
        required: [],
      },
    },
    // ─── Flow Authoring ───────────────────────────────────────────────
    {
      name: 'snow_flow_flow_add',
      description: 'DEPRECATED - performs no write; use snow_flow_plan then snow_flow_build with a FlowSpec. (Kept for catalogue parity.)',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Flow name' },
          description: { type: 'string', description: 'Flow description' },
          trigger_type: { type: 'string', description: 'Trigger type: record, schedule, inbound_email, rest (default record)' },
          trigger_table: { type: 'string', description: 'Trigger table (for record triggers)' },
          scope: { type: 'string', description: 'Application scope' },
        },
        required: ['name'],
      },
    },
    {
      name: 'snow_flow_subflow_add',
      description: 'DEPRECATED - performs no write; use snow_flow_plan then snow_flow_build with a FlowSpec of type subflow. (Kept for catalogue parity.)',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Subflow name' },
          description: { type: 'string', description: 'Subflow description' },
          inputs: { type: 'array', items: { type: 'object' }, description: 'Input variable definitions [{name, type, mandatory}]' },
          scope: { type: 'string', description: 'Application scope' },
        },
        required: ['name'],
      },
    },
    {
      name: 'snow_flow_flow_action_add',
      description: 'Create a custom Flow Designer action. **[Scripting]**',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Action name' },
          description: { type: 'string', description: 'Action description' },
          inputs: { type: 'array', items: { type: 'object' }, description: 'Input definitions [{name, type, mandatory}]' },
          outputs: { type: 'array', items: { type: 'object' }, description: 'Output definitions [{name, type}]' },
          script: { type: 'string', description: 'Action script body' },
        },
        required: ['name'],
      },
    },
    {
      name: 'snow_flow_flow_publish',
      description: 'DEPRECATED - performs no write; PATCHing active=true is not an activation. Use snow_flow_build activate:true or Activate in Workflow Studio. (Kept for catalogue parity.)',
      inputSchema: {
        type: 'object',
        properties: {
          flow_sys_id: { type: 'string', description: 'Flow or subflow sys_id to publish' },
          type: { type: 'string', description: 'Type: flow or subflow (default flow)' },
        },
        required: ['flow_sys_id'],
      },
    },
    {
      name: 'snow_flow_flow_test',
      description: 'DEPRECATED - performs no write; use snow_flow_verify and a real record/ATF trigger. (Kept for catalogue parity.)',
      inputSchema: {
        type: 'object',
        properties: {
          flow_sys_id: { type: 'string', description: 'Flow sys_id to test' },
          test_inputs: { type: 'object', description: 'Test input values' },
        },
        required: ['flow_sys_id'],
      },
    },
    {
      name: 'snow_flow_flow_error_log_read',
      description: 'Get detailed error logs for failed flow executions',
      inputSchema: {
        type: 'object',
        properties: {
          flow_sys_id: { type: 'string', description: 'Flow sys_id' },
          days: { type: 'number', description: 'Look-back period in days (default 7)' },
          limit: { type: 'number', description: 'Max records (default 25)' },
        },
        required: ['flow_sys_id'],
      },
    },
  ];
}

export async function dispatchFlowAction(
  client: ServiceNowClient,
  name: string,
  args: Record<string, any>
): Promise<any> {
  switch (name) {
    case 'snow_flow_flows_index': {
      const parts: string[] = [];
      if (args.active !== false) parts.push('active=true');
      if (args.category) parts.push(`category=${args.category}`);
      if (args.query) parts.push(`nameCONTAINS${args.query}^ORdescriptionCONTAINS${args.query}`);
      return await client.queryRecords({ table: 'sys_hub_flow', query: parts.join('^') || '', limit: args.limit ?? 50 });
    }
    case 'snow_flow_flow_read': {
      if (!args.name_or_sysid) throw new ServiceNowError('name_or_sysid is required', 'INVALID_REQUEST');
      if (/^[0-9a-f]{32}$/i.test(args.name_or_sysid)) {
        return await client.getRecord('sys_hub_flow', args.name_or_sysid);
      }
      const resp = await client.queryRecords({ table: 'sys_hub_flow', query: `nameCONTAINS${args.name_or_sysid}`, limit: 1 });
      if (resp.count === 0) throw new ServiceNowError(`Flow not found: ${args.name_or_sysid}`, 'NOT_FOUND');
      return resp.records[0];
    }
    case 'snow_flow_flow_trigger':
      return deprecated(name);
    case 'snow_flow_flow_execution_read': {
      if (!args.execution_sysid) throw new ServiceNowError('execution_sysid is required', 'INVALID_REQUEST');
      return await client.getRecord('sys_flow_context', args.execution_sysid);
    }
    case 'snow_flow_flow_executions_index': {
      if (!args.flow_sys_id) throw new ServiceNowError('flow_sys_id is required', 'INVALID_REQUEST');
      const parts = [`flow=${args.flow_sys_id}`];
      if (args.status) parts.push(`status=${args.status}`);
      return await client.queryRecords({ table: 'sys_flow_context', query: parts.join('^'), limit: args.limit ?? 25 });
    }
    case 'snow_flow_subflows_index': {
      const parts: string[] = [];
      if (args.active !== false) parts.push('active=true');
      if (args.query) parts.push(`nameCONTAINS${args.query}`);
      parts.push('type=subflow');
      return await client.queryRecords({ table: 'sys_hub_flow', query: parts.join('^'), limit: args.limit ?? 50 });
    }
    case 'snow_flow_subflow_read': {
      if (!args.name_or_sysid) throw new ServiceNowError('name_or_sysid is required', 'INVALID_REQUEST');
      if (/^[0-9a-f]{32}$/i.test(args.name_or_sysid)) {
        return await client.getRecord('sys_hub_flow', args.name_or_sysid);
      }
      const resp = await client.queryRecords({ table: 'sys_hub_flow', query: `type=subflow^nameCONTAINS${args.name_or_sysid}`, limit: 1 });
      if (resp.count === 0) throw new ServiceNowError(`Subflow not found: ${args.name_or_sysid}`, 'NOT_FOUND');
      return resp.records[0];
    }
    case 'snow_flow_action_instances_index': {
      const parts: string[] = [];
      if (args.category) parts.push(`category=${args.category}`);
      if (args.query) parts.push(`nameCONTAINS${args.query}`);
      return await client.queryRecords({ table: 'sys_hub_action_type_definition', query: parts.join('^') || '', limit: args.limit ?? 50 });
    }
    case 'snow_flow_process_automation_read': {
      if (!args.name_or_sysid) throw new ServiceNowError('name_or_sysid is required', 'INVALID_REQUEST');
      if (/^[0-9a-f]{32}$/i.test(args.name_or_sysid)) {
        return await client.getRecord('pa_process', args.name_or_sysid);
      }
      const resp = await client.queryRecords({ table: 'pa_process', query: `nameCONTAINS${args.name_or_sysid}`, limit: 1 });
      if (resp.count === 0) throw new ServiceNowError(`Process automation not found: ${args.name_or_sysid}`, 'NOT_FOUND');
      return resp.records[0];
    }
    case 'snow_flow_process_automations_index': {
      const parts: string[] = [];
      if (args.active !== false) parts.push('active=true');
      if (args.query) parts.push(`nameCONTAINS${args.query}^ORdescriptionCONTAINS${args.query}`);
      return await client.queryRecords({ table: 'pa_process', query: parts.join('^') || '', limit: args.limit ?? 50 });
    }
    case 'snow_flow_flow_add':
    case 'snow_flow_subflow_add':
      return deprecated(name);
    case 'snow_flow_flow_action_add': {
      requireScripting();
      if (!args.name) throw new ServiceNowError('name is required', 'INVALID_REQUEST');
      const result = await client.createRecord('sys_hub_action_type_definition', { name: args.name, ...(args.description ? { description: args.description } : {}), ...(args.script ? { script: args.script } : {}) });
      return { action: 'created', ...result };
    }
    case 'snow_flow_flow_publish':
    case 'snow_flow_flow_test':
      return deprecated(name);
    case 'snow_flow_flow_error_log_read': {
      if (!args.flow_sys_id) throw new ServiceNowError('flow_sys_id is required', 'INVALID_REQUEST');
      const days = args.days || 7;
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
      return await client.queryRecords({ table: 'sys_flow_context', query: `flow=${args.flow_sys_id}^status=error^sys_created_on>=${since}`, limit: args.limit ?? 25 });
    }
    default:
      return null;
  }
}
