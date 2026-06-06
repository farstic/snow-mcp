import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression: a successful DELETE returns 204 No Content. The client must NOT JSON-parse the
// empty body (which threw -> spurious retry -> second DELETE 404s -> a successful delete was
// wrongly reported as DELETE_NOT_FOUND). Found via live E2E against a real instance.
function setEnv() {
  process.env.SERVICENOW_INSTANCE_URL = 'https://dummy.service-now.com';
  process.env.SERVICENOW_AUTH_METHOD = 'basic';
  process.env.SERVICENOW_BASIC_USERNAME = 'd';
  process.env.SERVICENOW_BASIC_PASSWORD = 'd';
  process.env.LOG_LEVEL = 'error';
}

describe('ServiceNowClient.deleteRecord — 204 No Content', () => {
  beforeEach(() => setEnv());
  afterEach(() => vi.restoreAllMocks());

  it('resolves without throwing and does not retry on a 204 delete', async () => {
    setEnv();
    const { instanceManager } = await import('../../src/servicenow/instances.js');
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 204,
      json: async () => { throw new Error('Unexpected end of JSON input'); },
      text: async () => '',
    } as unknown as Response);
    const client = instanceManager.getClient();
    await expect(client.deleteRecord('incident', '0'.repeat(32))).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // single DELETE, no spurious retry
  });

  it('classifies a real 404 as DELETE_NOT_FOUND', async () => {
    setEnv();
    const { instanceManager } = await import('../../src/servicenow/instances.js');
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found',
      text: async () => JSON.stringify({ error: { message: 'No Record found', detail: "Record doesn't exist" } }),
    } as unknown as Response);
    const client = instanceManager.getClient();
    await expect(client.deleteRecord('incident', '0'.repeat(32))).rejects.toMatchObject({ code: 'DELETE_NOT_FOUND' });
  });
});
