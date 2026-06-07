import { describe, it, expect } from 'vitest';
import { ServerManager } from '../../main/server-manager';

const basic: any = { name: 'd', instanceUrl: 'https://x.service-now.com', authMethod: 'basic', username: 'u', password: 'p', writeEnabled: true, nowAssistEnabled: false };
const oauth: any = { name: 'o', instanceUrl: 'https://y.service-now.com', authMethod: 'oauth', clientId: 'cid', clientSecret: 'sec', username: 'u', password: 'p', writeEnabled: false };

describe('ServerManager', () => {
  it('buildEnv maps basic auth + permission flags + default tool package', () => {
    const env = (new ServerManager() as any).buildEnv(basic);
    expect(env.SERVICENOW_INSTANCE_URL).toBe('https://x.service-now.com');
    expect(env.SERVICENOW_AUTH_METHOD).toBe('basic');
    expect(env.SERVICENOW_BASIC_USERNAME).toBe('u');
    expect(env.SERVICENOW_BASIC_PASSWORD).toBe('p');
    expect(env.SERVICENOW_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.WRITE_ENABLED).toBe('true');
    expect(env.NOW_ASSIST_ENABLED).toBe('false');
    expect(env.MCP_TOOL_PACKAGE).toBe('full');
  });

  it('buildEnv maps oauth auth (no basic creds)', () => {
    const env = (new ServerManager() as any).buildEnv(oauth);
    expect(env.SERVICENOW_AUTH_METHOD).toBe('oauth');
    expect(env.SERVICENOW_OAUTH_CLIENT_ID).toBe('cid');
    expect(env.SERVICENOW_OAUTH_CLIENT_SECRET).toBe('sec');
    expect(env.SERVICENOW_BASIC_USERNAME).toBeUndefined();
    expect(env.WRITE_ENABLED).toBe('false');
  });

  it('getStatus reports not-running before start', () => {
    expect(new ServerManager().getStatus()).toMatchObject({ running: false });
  });
});
