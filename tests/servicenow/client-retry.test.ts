import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function setEnv() {
  process.env.SERVICENOW_INSTANCE_URL = 'https://dummy.service-now.com';
  process.env.SERVICENOW_AUTH_METHOD = 'basic';
  process.env.SERVICENOW_BASIC_USERNAME = 'd';
  process.env.SERVICENOW_BASIC_PASSWORD = 'd';
  process.env.LOG_LEVEL = 'error';
}

describe('ServiceNowClient.request — 429 rate-limit handling', () => {
  beforeEach(() => setEnv());
  afterEach(() => vi.restoreAllMocks());

  it('retries on HTTP 429 honoring Retry-After, then succeeds', async () => {
    setEnv();
    const { instanceManager } = await import('../../src/servicenow/instances.js');
    const client = instanceManager.getClient();
    let calls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false, status: 429, statusText: 'Too Many Requests',
          headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '0' : null) },
          text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
        } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ result: [{ sys_id: 'x', number: 'INC1' }] }),
      } as unknown as Response;
    });
    const r = await client.queryRecords({ table: 'incident', limit: 1 });
    expect(calls).toBe(2);            // retried once after the 429
    expect(r.records?.length).toBe(1); // and ultimately succeeded
  });
});
