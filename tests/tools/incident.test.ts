import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchIncidentAction, incidentToolManifest } from '../../src/tools/incident.js';
import type { ServiceNowClient } from '../../src/servicenow/client.js';

const mockClient = {
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  queryRecords: vi.fn(),
  getRecord: vi.fn(),
} as unknown as ServiceNowClient;

describe('incidentToolManifest', () => {
  it('returns 7 incident tool definitions', () => {
    expect(incidentToolManifest().length).toBe(7);
  });
});

describe('dispatchIncidentAction – create_incident', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WRITE_ENABLED = 'true';
  });

  it('creates an incident and returns summary', async () => {
    (mockClient.createRecord as ReturnType<typeof vi.fn>).mockResolvedValue({ sys_id: 'inc1', number: 'INC0001' });
    const result = await dispatchIncidentAction(mockClient, 'snow_inc_incident_add', { short_description: 'Test incident' });
    expect(result.summary).toContain('INC0001');
  });

  it('throws when short_description is missing', async () => {
    await expect(dispatchIncidentAction(mockClient, 'snow_inc_incident_add', {})).rejects.toThrow('short_description is required');
  });

  it('blocks writes when WRITE_ENABLED=false', async () => {
    process.env.WRITE_ENABLED = 'false';
    await expect(dispatchIncidentAction(mockClient, 'snow_inc_incident_add', { short_description: 'x' })).rejects.toThrow();
  });
});

describe('dispatchIncidentAction – get_incident', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches incident by sys_id (32 hex chars)', async () => {
    const sysId = 'a'.repeat(32);
    (mockClient.getRecord as ReturnType<typeof vi.fn>).mockResolvedValue({ sys_id: sysId, number: 'INC0001' });
    const result = await dispatchIncidentAction(mockClient, 'snow_inc_incident_read', { number_or_sysid: sysId });
    expect(result.sys_id).toBe(sysId);
  });

  it('fetches incident by number using queryRecords', async () => {
    (mockClient.queryRecords as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1, records: [{ sys_id: 'inc1', number: 'INC0042' }] });
    const result = await dispatchIncidentAction(mockClient, 'snow_inc_incident_read', { number_or_sysid: 'INC0042' });
    expect(result.number).toBe('INC0042');
  });

  it('throws NOT_FOUND when incident does not exist', async () => {
    (mockClient.queryRecords as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0, records: [] });
    await expect(dispatchIncidentAction(mockClient, 'snow_inc_incident_read', { number_or_sysid: 'INC9999' })).rejects.toThrow('Incident not found');
  });
});

describe('dispatchIncidentAction – resolve_incident', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WRITE_ENABLED = 'true';
  });

  it('sets state to 6 with resolution fields', async () => {
    (mockClient.updateRecord as ReturnType<typeof vi.fn>).mockResolvedValue({ sys_id: 'inc1', state: '6' });
    const result = await dispatchIncidentAction(mockClient, 'snow_inc_incident_resolve', {
      sys_id: 'inc1',
      resolution_code: 'Solved (Permanently)',
      resolution_notes: 'Fixed the root cause',
    });
    expect(result.summary).toContain('Resolved incident');
    const call = (mockClient.updateRecord as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2].state).toBe('6');
  });
});

describe('dispatchIncidentAction – add_work_note', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WRITE_ENABLED = 'true';
  });

  it('updates the work_notes field', async () => {
    (mockClient.updateRecord as ReturnType<typeof vi.fn>).mockResolvedValue({ sys_id: 'inc1' });
    await dispatchIncidentAction(mockClient, 'snow_inc_work_note_annotate', { table: 'incident', sys_id: 'inc1', note: 'Working on it' });
    const call = (mockClient.updateRecord as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toEqual({ work_notes: 'Working on it' });
  });
});
