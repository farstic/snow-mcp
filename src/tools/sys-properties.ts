/**
 * System Properties tools — read and manage ServiceNow sys_properties records.
 *
 * Tier 0 (Read): list, get, search, bulk_get, categories
 * Tier 1 (Write): set, delete, bulk_set, import
 * Tier 0 (Audit): history (read-only)
 *
 * ServiceNow table: sys_properties, sys_audit_sys_properties
 */
import type { ServiceNowClient } from '../servicenow/client.js';
import { ServiceNowError } from '../utils/errors.js';
import { requireWrite } from '../utils/permissions.js';

export function sysPropertiesToolManifest() {
  return [
    {
      name: 'snow_cfg_system_property_read',
      description: 'Get a ServiceNow system property value and metadata by name',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Property name (e.g. "glide.smtp.host")' },
        },
        required: ['name'],
      },
    },
    {
      name: 'snow_cfg_system_property_set',
      description: 'Create or update a ServiceNow system property value. **[Write]**',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Property name' },
          value: { type: 'string', description: 'Property value' },
          description: { type: 'string', description: 'Optional description' },
          type: { type: 'string', description: 'Property type: string, integer, boolean, choice, password2, etc.' },
        },
        required: ['name', 'value'],
      },
    },
    {
      name: 'snow_cfg_system_properties_index',
      description: 'List system properties with optional filtering',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Encoded query to filter properties' },
          category: { type: 'string', description: 'Filter by category (e.g. "email", "security")' },
          type: { type: 'string', description: 'Filter by type (e.g. "boolean", "string")' },
          limit: { type: 'number', description: 'Max records (default 50)' },
        },
        required: [],
      },
    },
    {
      name: 'snow_cfg_system_property_remove',
      description: 'Delete a system property by name. **[Write]**',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Property name to delete' },
        },
        required: ['name'],
      },
    },
    {
      name: 'snow_cfg_system_properties_query',
      description: 'Search system properties by name, value, or description',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Search text matched against name, value, and description' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['search'],
      },
    },
    {
      name: 'snow_cfg_get_properties_bulk',
      description: 'Retrieve multiple system property values in a single call',
      inputSchema: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: 'Array of property names to retrieve' },
        },
        required: ['names'],
      },
    },
    {
      name: 'snow_cfg_set_properties_bulk',
      description: 'Create or update multiple system properties in a single operation. **[Write]**',
      inputSchema: {
        type: 'object',
        properties: {
          properties: {
            type: 'array',
            description: 'Array of {name, value, description?} objects',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['name', 'value'],
            },
          },
        },
        required: ['properties'],
      },
    },
    {
      name: 'snow_cfg_properties_export',
      description: 'Export system properties matching a query to a JSON object (useful for environment snapshots)',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category' },
          query: { type: 'string', description: 'Encoded query filter' },
        },
        required: [],
      },
    },
    {
      name: 'snow_cfg_properties_import',
      description: 'Import (create or update) system properties from a JSON object. **[Write]**',
      inputSchema: {
        type: 'object',
        properties: {
          properties: {
            type: 'object',
            description: 'Key-value map of property names to values (e.g. {"glide.smtp.host": "smtp.example.com"})',
          },
          dry_run: { type: 'boolean', description: 'If true, show what would be changed without writing (default false)' },
        },
        required: ['properties'],
      },
    },
    {
      name: 'snow_cfg_property_validate',
      description: 'Validate a property value against its declared type constraints without saving',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Property name' },
          value: { type: 'string', description: 'Value to validate' },
        },
        required: ['name', 'value'],
      },
    },
    {
      name: 'snow_cfg_property_categories_index',
      description: 'List all unique property categories with their record counts',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'snow_cfg_property_history_read',
      description: 'Get audit history of changes to a system property',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Property name' },
          limit: { type: 'number', description: 'Max audit records (default 20)' },
        },
        required: ['name'],
      },
    },
  ];
}

export async function dispatchSysPropertiesAction(
  client: ServiceNowClient,
  name: string,
  args: Record<string, any>
): Promise<any> {
  switch (name) {
    case 'snow_cfg_system_property_read': {
      if (!args.name) throw new ServiceNowError('name is required', 'INVALID_REQUEST');
      const resp = await client.queryRecords({
        table: 'sys_properties',
        query: `name=${args.name}`,
        limit: 1,
        fields: 'sys_id,name,value,description,type,category,private,read_roles,write_roles,sys_updated_on,sys_updated_by',
      });
      if (resp.count === 0) return { found: false, name: args.name };
      return { found: true, ...resp.records[0] };
    }

    case 'snow_cfg_system_property_set': {
      if (!args.name || args.value === undefined) throw new ServiceNowError('name and value are required', 'INVALID_REQUEST');
      requireWrite();
      // Check if exists
      const existing = await client.queryRecords({ table: 'sys_properties', query: `name=${args.name}`, limit: 1, fields: 'sys_id,value' });
      if (existing.count > 0) {
        const sysId = String(existing.records[0].sys_id);
        const payload: Record<string, any> = { value: args.value };
        if (args.description) payload.description = args.description;
        if (args.type) payload.type = args.type;
        const result = await client.updateRecord('sys_properties', sysId, payload);
        return { action: 'updated', name: args.name, previous_value: existing.records[0].value, new_value: args.value, ...result };
      } else {
        const payload: Record<string, any> = { name: args.name, value: args.value };
        if (args.description) payload.description = args.description;
        if (args.type) payload.type = args.type;
        const result = await client.createRecord('sys_properties', payload);
        return { action: 'created', name: args.name, value: args.value, ...result };
      }
    }

    case 'snow_cfg_system_properties_index': {
      let query = '';
      if (args.category) query = `category=${args.category}`;
      if (args.type) query = query ? `${query}^type=${args.type}` : `type=${args.type}`;
      if (args.query) query = query ? `${query}^${args.query}` : args.query;
      const resp = await client.queryRecords({
        table: 'sys_properties',
        query: query || undefined,
        limit: args.limit || 50,
        fields: 'sys_id,name,value,description,type,category,sys_updated_on',
      });
      return { count: resp.count, properties: resp.records };
    }

    case 'snow_cfg_system_property_remove': {
      if (!args.name) throw new ServiceNowError('name is required', 'INVALID_REQUEST');
      requireWrite();
      const existing = await client.queryRecords({ table: 'sys_properties', query: `name=${args.name}`, limit: 1, fields: 'sys_id,value' });
      if (existing.count === 0) return { deleted: false, name: args.name, message: 'Property not found' };
      const sysId = String(existing.records[0].sys_id);
      await client.deleteRecord('sys_properties', sysId);
      return { deleted: true, name: args.name, previous_value: existing.records[0].value };
    }

    case 'snow_cfg_system_properties_query': {
      if (!args.search) throw new ServiceNowError('search is required', 'INVALID_REQUEST');
      const q = `nameLIKE${args.search}^ORvalueLIKE${args.search}^ORdescriptionLIKE${args.search}`;
      const resp = await client.queryRecords({
        table: 'sys_properties',
        query: q,
        limit: args.limit || 20,
        fields: 'sys_id,name,value,description,type,category',
      });
      return { count: resp.count, results: resp.records };
    }

    case 'snow_cfg_get_properties_bulk': {
      if (!args.names || !Array.isArray(args.names) || args.names.length === 0) {
        throw new ServiceNowError('names array is required', 'INVALID_REQUEST');
      }
      const nameIn = args.names.join(',');
      const resp = await client.queryRecords({
        table: 'sys_properties',
        query: `nameIN${nameIn}`,
        limit: args.names.length + 10,
        fields: 'name,value,type,category',
      });
      const result: Record<string, string> = {};
      for (const rec of resp.records) {
        result[String(rec.name)] = String(rec.value ?? '');
      }
      // Mark requested names that were not found
      const notFound = args.names.filter((n: string) => !(n in result));
      return { properties: result, not_found: notFound, found_count: resp.count };
    }

    case 'snow_cfg_set_properties_bulk': {
      if (!args.properties || !Array.isArray(args.properties)) {
        throw new ServiceNowError('properties array is required', 'INVALID_REQUEST');
      }
      requireWrite();
      const results: any[] = [];
      for (const prop of args.properties) {
        const existing = await client.queryRecords({ table: 'sys_properties', query: `name=${prop.name}`, limit: 1, fields: 'sys_id,value' });
        if (existing.count > 0) {
          const sysId = String(existing.records[0].sys_id);
          await client.updateRecord('sys_properties', sysId, { value: prop.value, ...(prop.description ? { description: prop.description } : {}) });
          results.push({ name: prop.name, action: 'updated', previous_value: existing.records[0].value });
        } else {
          await client.createRecord('sys_properties', { name: prop.name, value: prop.value, ...(prop.description ? { description: prop.description } : {}) });
          results.push({ name: prop.name, action: 'created' });
        }
      }
      return { processed: results.length, results };
    }

    case 'snow_cfg_properties_export': {
      let query = '';
      if (args.category) query = `category=${args.category}`;
      if (args.query) query = query ? `${query}^${args.query}` : args.query;
      const resp = await client.queryRecords({
        table: 'sys_properties',
        query: query || undefined,
        limit: 500,
        fields: 'name,value,type,description,category',
      });
      const exported: Record<string, string> = {};
      for (const rec of resp.records) {
        exported[String(rec.name)] = String(rec.value ?? '');
      }
      return { count: resp.count, properties: exported };
    }

    case 'snow_cfg_properties_import': {
      if (!args.properties || typeof args.properties !== 'object') {
        throw new ServiceNowError('properties object is required', 'INVALID_REQUEST');
      }
      if (!args.dry_run) requireWrite();
      const entries = Object.entries(args.properties);
      const changes: any[] = [];
      for (const [propName, propValue] of entries) {
        const existing = await client.queryRecords({ table: 'sys_properties', query: `name=${propName}`, limit: 1, fields: 'sys_id,value' });
        if (existing.count > 0) {
          if (!args.dry_run) {
            await client.updateRecord('sys_properties', String(existing.records[0].sys_id), { value: String(propValue) });
          }
          changes.push({ name: propName, action: 'update', previous_value: existing.records[0].value, new_value: propValue });
        } else {
          if (!args.dry_run) {
            await client.createRecord('sys_properties', { name: propName, value: String(propValue) });
          }
          changes.push({ name: propName, action: 'create', value: propValue });
        }
      }
      return { dry_run: !!args.dry_run, count: changes.length, changes };
    }

    case 'snow_cfg_property_validate': {
      if (!args.name || args.value === undefined) throw new ServiceNowError('name and value are required', 'INVALID_REQUEST');
      const resp = await client.queryRecords({ table: 'sys_properties', query: `name=${args.name}`, limit: 1, fields: 'name,type,value' });
      if (resp.count === 0) return { name: args.name, exists: false, validation: 'Property does not exist (would be created as new)' };
      const prop = resp.records[0];
      const propType = String(prop.type || 'string');
      let valid = true;
      let message = 'Valid';
      if (propType === 'integer' && isNaN(Number(args.value))) { valid = false; message = `Expected integer, got "${args.value}"`; }
      if (propType === 'boolean' && !['true', 'false'].includes(String(args.value).toLowerCase())) { valid = false; message = `Expected boolean (true/false), got "${args.value}"`; }
      return { name: args.name, type: propType, current_value: prop.value, proposed_value: args.value, valid, message };
    }

    case 'snow_cfg_property_categories_index': {
      const resp = await client.queryRecords({ table: 'sys_properties', limit: 2000, fields: 'category' });
      const counts: Record<string, number> = {};
      for (const rec of resp.records) {
        const cat = String(rec.category || '(uncategorised)');
        counts[cat] = (counts[cat] || 0) + 1;
      }
      const categories = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([category, count]) => ({ category, count }));
      return { total_categories: categories.length, categories };
    }

    case 'snow_cfg_property_history_read': {
      if (!args.name) throw new ServiceNowError('name is required', 'INVALID_REQUEST');
      const resp = await client.queryRecords({
        table: 'sys_audit',
        query: `tablename=sys_properties^fieldname=value^documentkey.name=${args.name}`,
        limit: args.limit || 20,
        fields: 'sys_created_on,sys_created_by,oldvalue,newvalue,reason',
      });
      return { name: args.name, count: resp.count, history: resp.records };
    }

    default:
      return null;
  }
}
