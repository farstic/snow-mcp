import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchHrsdAction } from '../../src/tools/hrsd.js';

const mockClient: any = {
  createRecord: vi.fn(),
  getRecord: vi.fn(),
  updateRecord: vi.fn(),
  queryRecords: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WRITE_ENABLED;
});

describe('HRSD tools', () => {
  describe('snow_hr_hr_case_add', () => {
    it('throws when WRITE_ENABLED is not set', async () => {
      await expect(
        dispatchHrsdAction(mockClient, 'snow_hr_hr_case_add', { short_description: 'Onboarding', hr_service: 'Onboarding' })
      ).rejects.toThrow('Write operations are disabled');
    });

    it('throws when short_description is missing', async () => {
      process.env.WRITE_ENABLED = 'true';
      await expect(
        dispatchHrsdAction(mockClient, 'snow_hr_hr_case_add', { hr_service: 'Onboarding' })
      ).rejects.toThrow('short_description and hr_service are required');
    });

    it('creates HR case when write is enabled', async () => {
      process.env.WRITE_ENABLED = 'true';
      mockClient.createRecord.mockResolvedValue({ sys_id: 'abc123', number: 'HRCS0001' });
      const result = await dispatchHrsdAction(mockClient, 'snow_hr_hr_case_add', {
        short_description: 'New employee onboarding',
        hr_service: 'Onboarding',
      });
      expect(result.number).toBe('HRCS0001');
      expect(result.summary).toContain('HRCS0001');
      expect(mockClient.createRecord).toHaveBeenCalledWith('sn_hr_core_case', expect.objectContaining({
        short_description: 'New employee onboarding',
      }));
    });
  });

  describe('snow_hr_hr_case_read', () => {
    it('throws when number_or_sysid is missing', async () => {
      await expect(
        dispatchHrsdAction(mockClient, 'snow_hr_hr_case_read', {})
      ).rejects.toThrow('number_or_sysid is required');
    });

    it('fetches by sys_id directly', async () => {
      mockClient.getRecord.mockResolvedValue({ sys_id: 'abc123def456abc123def456abc12345', number: 'HRCS0001' });
      const result = await dispatchHrsdAction(mockClient, 'snow_hr_hr_case_read', { number_or_sysid: 'abc123def456abc123def456abc12345' });
      expect(mockClient.getRecord).toHaveBeenCalledWith('sn_hr_core_case', 'abc123def456abc123def456abc12345');
      expect(result.number).toBe('HRCS0001');
    });

    it('queries by case number', async () => {
      mockClient.queryRecords.mockResolvedValue({ count: 1, records: [{ sys_id: 'abc123', number: 'HRCS0001' }] });
      const result = await dispatchHrsdAction(mockClient, 'snow_hr_hr_case_read', { number_or_sysid: 'HRCS0001' });
      expect(mockClient.queryRecords).toHaveBeenCalledWith(expect.objectContaining({ query: 'number=HRCS0001' }));
      expect(result.number).toBe('HRCS0001');
    });

    it('throws NOT_FOUND when case does not exist', async () => {
      mockClient.queryRecords.mockResolvedValue({ count: 0, records: [] });
      await expect(
        dispatchHrsdAction(mockClient, 'snow_hr_hr_case_read', { number_or_sysid: 'HRCS9999' })
      ).rejects.toThrow('HR case not found');
    });
  });

  describe('snow_hr_hr_cases_index', () => {
    it('returns all cases with no filters', async () => {
      mockClient.queryRecords.mockResolvedValue({ count: 2, records: [{}, {}] });
      const result = await dispatchHrsdAction(mockClient, 'snow_hr_hr_cases_index', {});
      expect(mockClient.queryRecords).toHaveBeenCalledWith(expect.objectContaining({ table: 'sn_hr_core_case' }));
      expect(result.count).toBe(2);
    });

    it('applies state filter', async () => {
      mockClient.queryRecords.mockResolvedValue({ count: 1, records: [{}] });
      await dispatchHrsdAction(mockClient, 'snow_hr_hr_cases_index', { state: 'open' });
      expect(mockClient.queryRecords).toHaveBeenCalledWith(expect.objectContaining({ query: 'state=open' }));
    });
  });

  describe('snow_hr_hr_services_index', () => {
    it('returns active services by default', async () => {
      mockClient.queryRecords.mockResolvedValue({ count: 5, records: [] });
      await dispatchHrsdAction(mockClient, 'snow_hr_hr_services_index', {});
      expect(mockClient.queryRecords).toHaveBeenCalledWith(expect.objectContaining({
        table: 'sn_hr_core_service',
        query: expect.stringContaining('active=true'),
      }));
    });
  });

  describe('returns null for unknown tool', () => {
    it('returns null for unrecognised tool name', async () => {
      const result = await dispatchHrsdAction(mockClient, 'nonexistent_hrsd_tool', {});
      expect(result).toBeNull();
    });
  });
});
