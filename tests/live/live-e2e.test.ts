/**
 * OPT-IN live end-to-end suite — runs ONLY when RUN_LIVE_E2E=1 and hits a real ServiceNow
 * instance. Configure via .env (or shell env): SERVICENOW_INSTANCE_URL + auth.
 *   RUN_LIVE_E2E=1 npx vitest run tests/live/live-e2e.test.ts
 *
 * Creates only [LIVE E2E]-tagged records and deletes exactly what it creates (tracked, no sweeps).
 * OAuth and impersonation cases are further gated by their own env vars and skip when absent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const LIVE = !!process.env.RUN_LIVE_E2E;

function loadDotEnv(): void {
  const p = join(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    // .env is authoritative for live config — override (the test setup file presets a dummy URL).
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

describe.skipIf(!LIVE)('LIVE E2E against a real ServiceNow instance (opt-in: RUN_LIVE_E2E=1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any, routeToolInvocation: any, ServiceNowClient: any;
  const TAG = `[LIVE E2E ${Date.now()}]`;
  const created: Array<{ table: string; sys_id: string }> = [];

  beforeAll(async () => {
    loadDotEnv();
    process.env.WRITE_ENABLED = 'true';
    process.env.LOG_LEVEL = 'error';
    process.env.REDACT_SENSITIVE_DATA = 'true';
    if (!process.env.RETRY_DELAY_MS) process.env.RETRY_DELAY_MS = '500';
    const inst = await import('../../src/servicenow/instances.js');
    inst.instanceManager.reload();
    client = inst.instanceManager.getClient();
    ({ routeToolInvocation } = await import('../../src/tools/index.js'));
    ({ ServiceNowClient } = await import('../../src/servicenow/client.js'));
  });

  afterAll(async () => {
    for (const c of [...created].reverse()) {
      try { await client.deleteRecord(c.table, c.sys_id); } catch { /* best-effort cleanup */ }
    }
  });

  it('basic-auth handshake returns records', async () => {
    const r = await client.queryRecords({ table: 'incident', limit: 1 });
    expect(Array.isArray(r.records)).toBe(true);
  });

  it('CRUD lifecycle: create -> read -> update -> delete (delete reports success + record gone)', async () => {
    const c = await routeToolInvocation(client, 'snow_inc_incident_add', { short_description: `${TAG} crud`, urgency: '3' });
    expect(c.sys_id).toBeTruthy();
    created.push({ table: 'incident', sys_id: c.sys_id });
    const read = await routeToolInvocation(client, 'snow_inc_incident_read', { number_or_sysid: c.number });
    expect(read.sys_id).toBe(c.sys_id);
    await routeToolInvocation(client, 'snow_inc_incident_modify', { sys_id: c.sys_id, fields: { urgency: '2' } });
    const del = await routeToolInvocation(client, 'snow_core_record_remove', { table: 'incident', sys_id: c.sys_id });
    expect(del.action).toBe('deleted');
    created.pop();
    await expect(client.getRecord('incident', c.sys_id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 30000);

  it('attachment upload (.png) is accepted by the Attachment API', async () => {
    const c = await routeToolInvocation(client, 'snow_inc_incident_add', { short_description: `${TAG} attach` });
    created.push({ table: 'incident', sys_id: c.sys_id });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await client.uploadAttachment('incident', c.sys_id, 'live.png', 'image/png', png);
    const att = await client.queryRecords({ table: 'sys_attachment', query: `table_name=incident^table_sys_id=${c.sys_id}`, limit: 5 });
    expect(att.records.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('pagination returns distinct pages via limit/offset', async () => {
    const p1 = await client.queryRecords({ table: 'incident', limit: 2, offset: 0 });
    const p2 = await client.queryRecords({ table: 'incident', limit: 2, offset: 2 });
    const a = p1.records.map((x: any) => x.sys_id);
    const b = p2.records.map((x: any) => x.sys_id);
    expect(a.filter((x: string) => b.includes(x))).toHaveLength(0);
  });

  it('delete error classification: non-existent record -> DELETE_NOT_FOUND', async () => {
    await expect(client.deleteRecord('incident', 'f'.repeat(32))).rejects.toMatchObject({ code: 'DELETE_NOT_FOUND' });
  });

  // Requires an OAuth app on the instance — gated by OAuth creds being present.
  it.skipIf(!(process.env.SERVICENOW_OAUTH_CLIENT_ID || process.env.SERVICENOW_CLIENT_ID))('OAuth password-grant handshake authenticates and queries', async () => {
    const oauthClient = new ServiceNowClient({
      instanceUrl: process.env.SERVICENOW_INSTANCE_URL,
      authMethod: 'oauth',
      oauth: {
        clientId: process.env.SERVICENOW_OAUTH_CLIENT_ID || process.env.SERVICENOW_CLIENT_ID,
        clientSecret: process.env.SERVICENOW_OAUTH_CLIENT_SECRET || process.env.SERVICENOW_CLIENT_SECRET,
        username: process.env.SERVICENOW_OAUTH_USERNAME || process.env.SERVICENOW_BASIC_USERNAME,
        password: process.env.SERVICENOW_OAUTH_PASSWORD || process.env.SERVICENOW_BASIC_PASSWORD,
      },
    } as any);
    const r = await oauthClient.queryRecords({ table: 'incident', limit: 1 });
    expect(Array.isArray(r.records)).toBe(true);
  }, 30000);

  // Requires impersonation rights + a target user sys_id — gated by SN_LIVE_IMPERSONATE_SYSID.
  it.skipIf(!process.env.SN_LIVE_IMPERSONATE_SYSID)('impersonation: query routed as the target user via X-Sn-Impersonate', async () => {
    const impClient = new ServiceNowClient({
      instanceUrl: process.env.SERVICENOW_INSTANCE_URL,
      authMethod: 'basic',
      basic: { username: process.env.SERVICENOW_BASIC_USERNAME, password: process.env.SERVICENOW_BASIC_PASSWORD },
      authMode: 'impersonation',
    } as any).withUser({ sysId: process.env.SN_LIVE_IMPERSONATE_SYSID });
    const r = await impClient.queryRecords({ table: 'sys_user', limit: 1 });
    expect(Array.isArray(r.records)).toBe(true);
  }, 30000);
});
