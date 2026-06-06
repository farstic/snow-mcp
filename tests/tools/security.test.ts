import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchSecurityAction } from '../../src/tools/security.js';

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

describe('Security Operations tools', () => {
  describe('snow_sec_security_incident_add', () => {
    it('throws when write is disabled', async () => {
      await expect(
        dispatchSecurityAction(mockClient, 'snow_sec_security_incident_add', {
          short_description: 'Ransomware detected',
          category: 'Malware',
        })
      ).rejects.toThrow('Write operations are disabled');
    });

    it('creates security incident when write enabled', async () => {
      process.env.WRITE_ENABLED = 'true';
      mockClient.createRecord.mockResolvedValue({ sys_id: 'sec001', number: 'SIR0001' });
      const result = await dispatchSecurityAction(mockClient, 'snow_sec_security_incident_add', {
        short_description: 'Ransomware detected on server',
        category: 'Malware',
        severity: 1,
      });
      expect(result.number).toBe('SIR0001');
      expect(mockClient.createRecord).toHaveBeenCalledWith('sn_si_incident', expect.objectContaining({
        category: 'Malware',
      }));
    });
  });

  describe('snow_sec_security_incidents_index', () => {
    it('lists all with no filter', async () => {
      mockClient.queryRecords.mockResolvedValue({ count: 3, records: [] });
      await dispatchSecurityAction(mockClient, 'snow_sec_security_incidents_index', {});
      expect(mockClient.queryRecords).toHaveBeenCalledWith(expect.objectContaining({
        table: 'sn_si_incident',
      }));
    });

    it('applies severity filter', async () => {
      mockClient.queryRecords.mockResolvedValue({ count: 1, records: [] });
      await dispatchSecurityAction(mockClient, 'snow_sec_security_incidents_index', { severity: 1 });
      expect(mockClient.queryRecords).toHaveBeenCalledWith(expect.objectContaining({
        query: 'severity=1',
      }));
    });
  });

  describe('snow_sec_vulnerabilities_index', () => {
    it('lists vulnerabilities with state filter', async () => {
      mockClient.queryRecords.mockResolvedValue({ count: 5, records: [] });
      await dispatchSecurityAction(mockClient, 'snow_sec_vulnerabilities_index', { state: 'open', severity: 'critical' });
      expect(mockClient.queryRecords).toHaveBeenCalledWith(expect.objectContaining({
        table: 'sn_vul_entry',
        query: 'state=open^severity=critical',
      }));
    });
  });

  describe('snow_sec_threat_intelligence_read', () => {
    it('throws when query is missing', async () => {
      await expect(
        dispatchSecurityAction(mockClient, 'snow_sec_threat_intelligence_read', {})
      ).rejects.toThrow('query is required');
    });

    it('searches threat intel by value', async () => {
      mockClient.queryRecords.mockResolvedValue({ count: 1, records: [{ value: '192.168.1.1' }] });
      await dispatchSecurityAction(mockClient, 'snow_sec_threat_intelligence_read', { query: '192.168.1.1' });
      expect(mockClient.queryRecords).toHaveBeenCalledWith(expect.objectContaining({
        table: 'sn_ti_observable',
        query: 'valueCONTAINS192.168.1.1',
      }));
    });

    it('applies type filter when provided', async () => {
      mockClient.queryRecords.mockResolvedValue({ count: 0, records: [] });
      await dispatchSecurityAction(mockClient, 'snow_sec_threat_intelligence_read', { query: '1.2.3.4', type: 'ip_address' });
      expect(mockClient.queryRecords).toHaveBeenCalledWith(expect.objectContaining({
        query: 'type=ip_address^valueCONTAINS1.2.3.4',
      }));
    });
  });

  describe('unknown tool', () => {
    it('returns null for unrecognised tool', async () => {
      const result = await dispatchSecurityAction(mockClient, 'not_a_real_tool', {});
      expect(result).toBeNull();
    });
  });
});
