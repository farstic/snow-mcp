import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchCoreAction, coreToolManifest } from '../../src/tools/core.js';
import type { ServiceNowClient } from '../../src/servicenow/client.js';

const mockClient = {
  queryRecords: vi.fn(),
  getRecord: vi.fn(),
  getTableSchema: vi.fn(),
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
  getUser: vi.fn(),
  getGroup: vi.fn(),
  searchCmdbCi: vi.fn(),
  getCmdbCi: vi.fn(),
  listRelationships: vi.fn(),
  listDiscoverySchedules: vi.fn(),
  listMidServers: vi.fn(),
  listActiveEvents: vi.fn(),
  cmdbHealthDashboard: vi.fn(),
  serviceMappingSummary: vi.fn(),
  naturalLanguageSearch: vi.fn(),
  naturalLanguageUpdate: vi.fn(),
} as unknown as ServiceNowClient;

describe('coreToolManifest', () => {
  it('returns 24 core tool definitions', () => {
    const tools = coreToolManifest();
    expect(tools.length).toBe(24);
  });

  it('all tools have name, description and inputSchema', () => {
    coreToolManifest().forEach(t => {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeTruthy();
    });
  });
});

describe('dispatchCoreAction – query_records', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns records with summary', async () => {
    (mockClient.queryRecords as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2, records: [{ sys_id: 'a' }, { sys_id: 'b' }] });
    const result = await dispatchCoreAction(mockClient, 'snow_core_records_query', { table: 'incident' });
    expect(result.count).toBe(2);
    expect(result.summary).toContain('2 record');
  });

  it('throws when table is missing', async () => {
    await expect(dispatchCoreAction(mockClient, 'snow_core_records_query', {})).rejects.toThrow('Table name is required');
  });
});

describe('dispatchCoreAction – get_record', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns record from client', async () => {
    (mockClient.getRecord as ReturnType<typeof vi.fn>).mockResolvedValue({ sys_id: 'abc', number: 'INC001' });
    const result = await dispatchCoreAction(mockClient, 'snow_core_record_read', { table: 'incident', sys_id: 'abc' });
    expect(result.sys_id).toBe('abc');
  });

  it('throws when sys_id is missing', async () => {
    await expect(dispatchCoreAction(mockClient, 'snow_core_record_read', { table: 'incident' })).rejects.toThrow();
  });
});

describe('dispatchCoreAction – create_record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WRITE_ENABLED = 'true';
  });

  it('creates a record when WRITE_ENABLED=true', async () => {
    (mockClient.createRecord as ReturnType<typeof vi.fn>).mockResolvedValue({ sys_id: 'xyz', number: 'INC001' });
    const result = await dispatchCoreAction(mockClient, 'snow_core_record_add', { table: 'incident', fields: { short_description: 'Test' } });
    expect(result.action).toBe('created');
    expect(result.sys_id).toBe('xyz');
  });

  it('throws when WRITE_ENABLED=false', async () => {
    process.env.WRITE_ENABLED = 'false';
    await expect(dispatchCoreAction(mockClient, 'snow_core_record_add', { table: 'incident', fields: { short_description: 'x' } })).rejects.toThrow();
  });
});

describe('dispatchCoreAction – unknown tool', () => {
  it('returns null for unknown tool names', async () => {
    const result = await dispatchCoreAction(mockClient, 'nonexistent_tool', {});
    expect(result).toBeNull();
  });
});
