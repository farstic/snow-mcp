import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let taskManager: any;

const textMsg = (text: string): any => ({ role: 'user', parts: [{ type: 'text', text }] });
const dataMsg = (data: unknown): any => ({ role: 'user', parts: [{ type: 'data', data }] });
const okFetch = (result: unknown) => vi.spyOn(global, 'fetch').mockResolvedValue({
  ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ result }),
} as unknown as Response);

beforeAll(async () => {
  process.env.SERVICENOW_INSTANCE_URL = 'https://dummy.service-now.com';
  process.env.SERVICENOW_AUTH_METHOD = 'basic';
  process.env.SERVICENOW_BASIC_USERNAME = 'd';
  process.env.SERVICENOW_BASIC_PASSWORD = 'd';
  process.env.LOG_LEVEL = 'error';
  process.env.RETRY_DELAY_MS = '1';
  delete process.env.WRITE_ENABLED;
  delete process.env.MCP_TOOL_PACKAGE;
  ({ taskManager } = await import('../../src/a2a/task-manager.js'));
});
afterEach(() => vi.restoreAllMocks());

describe('A2A task-manager — state machine + messaging', () => {
  it('no matching tool -> completed with help text', async () => {
    const res = await taskManager.sendTask({ message: textMsg('hi there, nothing in particular') });
    expect(res.status.state).toBe('completed');
    const text = res.status.message.parts[0].text;
    expect(text).toMatch(/tools/i);
    expect(text).toContain('tool_name'); // help text advertises the explicit-tool form
    expect(res.artifacts ?? []).toHaveLength(0);
  });

  it('explicit data-part tool_name -> executes, completes, returns a data artifact', async () => {
    okFetch([{ sys_id: 'x', number: 'INC1' }]);
    const res = await taskManager.sendTask({ message: dataMsg({ tool_name: 'snow_core_records_query', arguments: { table: 'incident' } }) });
    expect(res.status.state).toBe('completed');
    expect(res.artifacts[0].name).toBe('snow_core_records_query');
    expect(res.artifacts[0].parts[0].type).toBe('data');
    expect(res.status.message.parts[0].type).toBe('text');
  });

  it('keyword text routing -> list incidents via query_records', async () => {
    okFetch([]);
    const res = await taskManager.sendTask({ message: textMsg('please list active incidents') });
    expect(res.status.state).toBe('completed');
    expect(res.artifacts[0].name).toBe('snow_core_records_query');
  });

  it('tool failure -> failed status with an error message', async () => {
    // write tool with WRITE_ENABLED unset -> ServiceNowError -> failed branch
    const res = await taskManager.sendTask({ message: dataMsg({ tool_name: 'snow_inc_incident_add', arguments: { short_description: 'x' } }) });
    expect(res.status.state).toBe('failed');
    expect(res.status.message.parts[0].text).toMatch(/error/i);
  });

  it('getTask returns the stored task; unknown id -> undefined', async () => {
    await taskManager.sendTask({ id: 'fixed-1', message: textMsg('hello') });
    const t = taskManager.getTask('fixed-1');
    expect(t?.id).toBe('fixed-1');
    expect(t?.history.length).toBeGreaterThan(0);
    expect(taskManager.getTask('no-such-task')).toBeUndefined();
  });

  it('cancelTask guard: unknown -> false, and a terminal task -> false', async () => {
    expect(taskManager.cancelTask('no-such-task')).toBe(false);
    const res = await taskManager.sendTask({ id: 'fixed-2', message: textMsg('hello') });
    expect(res.status.state).toBe('completed');
    expect(taskManager.cancelTask('fixed-2')).toBe(false); // cannot cancel a completed task
  });
});
