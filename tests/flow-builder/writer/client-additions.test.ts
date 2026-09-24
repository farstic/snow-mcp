/**
 * src/servicenow/client.ts — the additive WRITER changes: getConfiguredUsername(), postMultipart() and
 * requestJson(). No behaviour change to the existing methods is asserted here beyond the
 * additive `body` on non-2xx error details.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { ServiceNowClient } from '../../../src/servicenow/client.js';
import { ServiceNowError } from '../../../src/utils/errors.js';

const BASE = 'https://pdi.service-now.com';
const basic = () => new ServiceNowClient({ instanceUrl: `${BASE}/`, authMethod: 'basic', basic: { username: 'mcp.user', password: 'secret' }, retryDelayMs: 1 });

function mockFetch(status: number, body: string, headers: Record<string, string> = {}) {
  return vi.spyOn(global, 'fetch').mockImplementation(async () => ({
    ok: status >= 200 && status < 300, status, statusText: 'x',
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    text: async () => body,
  }) as unknown as Response);
}

afterEach(() => vi.restoreAllMocks());

describe('getConfiguredUsername', () => {
  it('returns the Basic username, the OAuth password-grant username, or undefined', () => {
    expect(basic().getConfiguredUsername()).toBe('mcp.user');
    expect(new ServiceNowClient({ instanceUrl: BASE, authMethod: 'oauth', oauth: { clientId: 'c', clientSecret: 's', username: 'svc', password: 'p' } }).getConfiguredUsername()).toBe('svc');
    expect(new ServiceNowClient({ instanceUrl: BASE, authMethod: 'oauth', oauth: { clientId: 'c', clientSecret: 's' } }).getConfiguredUsername()).toBeUndefined();
    expect(new ServiceNowClient({ instanceUrl: BASE, authMethod: 'basic', basic: { username: '  ', password: 'p' } }).getConfiguredUsername()).toBeUndefined();
  });

  it('is undefined under impersonation / per-user (the effective user is not the configured one)', () => {
    expect(basic().withUser({ sysId: 'a'.repeat(32) }).getConfiguredUsername()).toBeUndefined();
    expect(basic().withUser({ bearerToken: 't' }).getConfiguredUsername()).toBeUndefined();
    expect(basic().getConfiguredUsername()).toBe('mcp.user'); // the original is untouched
  });
});

describe('requestJson', () => {
  it('POSTs JSON to base + path with the Basic Authorization header and returns the parsed body', async () => {
    const spy = mockFetch(200, JSON.stringify({ result: { summary: 'ok', results: [] } }));
    const r = await basic().requestJson<{ result: { summary: string } }>('POST', 'api/now/wfa_fluent/activate_flows?sysparm_transaction_scope=global', { flows: [{ sys_id: 'f', active: '', state: '' }], actions: [] });
    expect(r.result.summary).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/now/wfa_fluent/activate_flows?sysparm_transaction_scope=global`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ flows: [{ sys_id: 'f', active: '', state: '' }], actions: [] });
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from('mcp.user:secret').toString('base64')}`);
    expect(h['Content-Type']).toBe('application/json');
    expect(h.Accept).toBe('application/json');
  });

  it('accepts a leading slash, sends no body for GET, and lets extra headers through', async () => {
    const spy = mockFetch(200, '{"result":[]}');
    await basic().requestJson('GET', '/api/now/table/sys_hub_flow?sysparm_limit=1', undefined, { 'X-Test': '1' });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/now/table/sys_hub_flow?sysparm_limit=1`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-Test']).toBe('1');
  });

  it('a 422 throws a ServiceNowError carrying status and the raw body (activation result), without retrying on 400/404', async () => {
    const body = JSON.stringify({ result: { summary: '1 failed', results: [{ status: 'error' }] } });
    mockFetch(422, body);
    let err: ServiceNowError | undefined;
    try { await basic().requestJson('POST', 'api/now/wfa_fluent/activate_flows', {}); } catch (e) { err = e as ServiceNowError; }
    expect(err).toBeInstanceOf(ServiceNowError);
    expect((err!.details as { status: number; body: string }).status).toBe(422);
    expect((err!.details as { status: number; body: string }).body).toBe(body);

    vi.restoreAllMocks();
    const spy404 = mockFetch(404, '{"error":{"message":"Requested URI does not represent any resource"}}');
    let e404: ServiceNowError | undefined;
    try { await basic().requestJson('POST', 'api/now/wfa_fluent/activate_flows', {}); } catch (e) { e404 = e as ServiceNowError; }
    expect(e404!.code).toBe('NOT_FOUND');
    expect((e404!.details as { status: number }).status).toBe(404);
    expect(spy404).toHaveBeenCalledTimes(1); // 404 is not retried
  });

  it('refuses absolute URLs, protocol-relative paths, parent traversal and unknown methods before any fetch', async () => {
    const spy = vi.spyOn(global, 'fetch');
    const c = basic();
    for (const bad of ['https://evil.example/x', '//evil.example/x', '../api/now/table/x', 'api/../../x', '']) {
      await expect(c.requestJson('GET', bad), bad).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    await expect(c.requestJson('TRACE' as 'GET', 'api/now/table/x')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('existing methods still work and non-2xx details gain the body additively', async () => {
    mockFetch(403, '{"error":{"message":"denied","detail":"acl"}}');
    let err: ServiceNowError | undefined;
    try { await basic().getRecord('sys_hub_flow', 'a'.repeat(32)); } catch (e) { err = e as ServiceNowError; }
    expect(err!.code).toBe('INSUFFICIENT_PRIVILEGES');
    expect(err!.details).toMatchObject({ status: 403, detail: 'acl', body: '{"error":{"message":"denied","detail":"acl"}}' });
  });
});

describe('postMultipart', () => {
  const XML = '<?xml version="1.0"?>\n<record_update table="sys_hub_flow">\n  <sys_hub_flow action="INSERT_OR_UPDATE" apply_defaults="true">\n    <name>A &amp; B</name>\n  </sys_hub_flow>\n</record_update>';
  const file = { field: 'files', filename: `sys_hub_flow_${'f'.repeat(32)}.xml`, content: XML, contentType: 'application/xml' };

  it('POSTs multipart/form-data to base + path + query with the auth header and NO Content-Type (fetch sets the boundary)', async () => {
    const spy = mockFetch(200, JSON.stringify({ result: { targetUpdateSetId: 'a'.repeat(32) } }));
    const r = await basic().postMultipart('api/fluent/load/global', [file], { targetUpdateSetId: 'a'.repeat(32) }, 90000);
    expect(r).toEqual({ status: 200, ok: true, statusText: 'x', json: { result: { targetUpdateSetId: 'a'.repeat(32) } } });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/fluent/load/global?targetUpdateSetId=${'a'.repeat(32)}`);
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from('mcp.user:secret').toString('base64')}`);
    expect(h.Accept).toBe('application/json');
    expect(Object.keys(h).map(k => k.toLowerCase())).not.toContain('content-type');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // the body: one part 'files', filename, content type, exact content
    expect(init.body).toBeInstanceOf(FormData);
    const parts = (init.body as FormData).getAll('files');
    expect(parts).toHaveLength(1);
    const part = parts[0] as File;
    expect(part.name).toBe(file.filename);
    expect(part.type).toBe('application/xml');
    expect(await part.text()).toBe(XML);
  });

  it('several files become several parts; a query already on the path is extended; per-user bearer and impersonation headers apply', async () => {
    const spy = mockFetch(200, '{"result":{}}');
    const c = basic().withUser({ sysId: 'e'.repeat(32) });
    await c.postMultipart('/api/fluent/load/global?x=1', [file, { ...file, filename: 'b.xml', content: '<b/>' }], { targetUpdateSetId: 'u' });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/fluent/load/global?x=1&targetUpdateSetId=u`);
    expect((init.body as FormData).getAll('files').map(p => (p as File).name)).toEqual([file.filename, 'b.xml']);
    expect((init.headers as Record<string, string>)['X-Sn-Impersonate']).toBe('e'.repeat(32));

    vi.restoreAllMocks();
    const spy2 = mockFetch(200, '{"result":{}}');
    await basic().withUser({ bearerToken: 'tok' }).postMultipart('api/fluent/load/global', [file]);
    expect(((spy2.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('never throws on a non-2xx and never retries: returns status / ok:false with json or text', async () => {
    const spy = mockFetch(500, '{"result":{"error":"compile failed"}}');
    const r = await basic().postMultipart('api/fluent/load/global', [file]);
    expect(r).toEqual({ status: 500, ok: false, statusText: 'x', json: { result: { error: 'compile failed' } } });
    expect(spy).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    mockFetch(403, 'Forbidden (html)');
    expect(await basic().postMultipart('api/fluent/load/global', [file])).toEqual({ status: 403, ok: false, statusText: 'x', text: 'Forbidden (html)' });
  });

  it('a network failure or timeout throws NETWORK_ERROR / TIMEOUT', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: new Error('ECONNRESET') }));
    await expect(basic().postMultipart('api/fluent/load/global', [file])).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('ECONNRESET') });
    vi.restoreAllMocks();
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(basic().postMultipart('api/fluent/load/global', [file], undefined, 5)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('the timeout also covers a stalled response BODY: TIMEOUT instead of an unbounded hang', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => ({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => null },
      // headers arrived, the body never completes — only the abort signal ends it
      text: () => new Promise<string>((_resolve, reject) => (init as RequestInit).signal!.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })))),
    }) as unknown as Response);
    await expect(basic().postMultipart('api/fluent/load/global', [file], undefined, 20)).rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('20 ms') });
  });

  it('refuses bad paths and bad file descriptors before any fetch', async () => {
    const spy = vi.spyOn(global, 'fetch');
    const c = basic();
    for (const bad of ['https://evil.example/x', '//evil.example/x', '../api/fluent/load', '']) {
      await expect(c.postMultipart(bad, [file]), bad).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    await expect(c.postMultipart('api/fluent/load/global', [])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(c.postMultipart('api/fluent/load/global', [{ ...file, filename: '' }])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(c.postMultipart('api/fluent/load/global', [{ ...file, contentType: '' }])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('credentials never reach an error or the log (review finding: 401 / 403 / network error)', () => {
  const PASSWORD = 's3cr3t-P@ss-7781';
  const TOKEN = 'bearer-tok-9f8e7d6c';
  const BASIC = Buffer.from(`mcp.user:${PASSWORD}`).toString('base64');
  const SECRETS = ['Basic ', PASSWORD, BASIC, TOKEN];
  const XML = '<?xml version="1.0"?>\n<record_update table="sys_hub_flow"/>';
  const file = { field: 'files', filename: `sys_hub_flow_${'f'.repeat(32)}.xml`, content: XML, contentType: 'application/xml' };
  const secretClient = () => new ServiceNowClient({ instanceUrl: BASE, authMethod: 'basic', basic: { username: 'mcp.user', password: PASSWORD }, retryDelayMs: 1 });
  const logLevel = process.env.LOG_LEVEL;

  /** Everything console.error received (the logger's only sink), as text. */
  function captureLog(): () => string {
    process.env.LOG_LEVEL = 'debug';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return () => spy.mock.calls.map(args => args.map(a => (typeof a === 'string' ? a : inspect(a, { depth: 10 }))).join(' ')).join('\n');
  }
  const leaked = (...texts: string[]) => SECRETS.filter(s => texts.join('\n').includes(s));
  const errorText = (e: unknown) => {
    const err = e as ServiceNowError;
    return [err.message, String(err.stack), JSON.stringify(err.details ?? null), inspect(err, { depth: 10 })].join('\n');
  };
  afterEach(() => { if (logLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = logLevel; });

  for (const status of [401, 403]) {
    it(`HTTP ${status}: the postMultipart result, a requestJson error (message, details, stack) and the log carry no credential`, async () => {
      const log = captureLog();
      const spy = mockFetch(status, JSON.stringify({ error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' }, status: 'failure' }));
      const r = await secretClient().postMultipart('api/fluent/load/global', [file], { targetUpdateSetId: 'a'.repeat(32) });
      expect(r).toMatchObject({ status, ok: false });
      let err: unknown;
      try { await secretClient().requestJson('POST', 'api/now/wfa_fluent/activate_flows', {}); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ServiceNowError);
      // the header really was sent — so the absence below is meaningful
      expect(((spy.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe(`Basic ${BASIC}`);
      expect(leaked(JSON.stringify(r), inspect(r, { depth: 10 }), errorText(err), log())).toEqual([]);
    });
  }

  it('a network error (Basic and per-user bearer): the thrown errors and the log carry no credential', async () => {
    const log = captureLog();
    const fail = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }) }));
    vi.spyOn(global, 'fetch').mockImplementation(fail);
    const errors: unknown[] = [];
    for (const c of [secretClient(), secretClient().withUser({ bearerToken: TOKEN })]) {
      try { await c.postMultipart('api/fluent/load/global', [file]); } catch (e) { errors.push(e); }
      try { await c.requestJson('POST', 'api/now/wfa_fluent/activate_flows', {}); } catch (e) { errors.push(e); }
    }
    expect(errors).toHaveLength(4);
    for (const e of errors) expect(e).toBeInstanceOf(ServiceNowError);
    expect(leaked(...errors.map(errorText), log())).toEqual([]);
  });
});
