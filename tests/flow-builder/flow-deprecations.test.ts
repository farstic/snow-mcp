/**
 * src/tools/flow.ts after the flow-builder migration:
 *   - the five legacy write tools are still dispatchable but throw DEPRECATED_TOOL without any client call
 *   - subflow reads go to sys_hub_flow type=subflow (there is no sys_hub_subflow table)
 *   - the action index reads sys_hub_action_type_definition
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchFlowAction, flowToolManifest, DEPRECATED_FLOW_TOOLS } from '../../src/tools/flow.js';
import type { ServiceNowClient } from '../../src/servicenow/client.js';

const mockClient = {
  queryRecords: vi.fn(),
  getRecord: vi.fn(),
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
} as unknown as ServiceNowClient;
const q = mockClient.queryRecords as unknown as ReturnType<typeof vi.fn>;
const g = mockClient.getRecord as unknown as ReturnType<typeof vi.fn>;
const c = mockClient.createRecord as unknown as ReturnType<typeof vi.fn>;
const u = mockClient.updateRecord as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WRITE_ENABLED = 'true';
});

describe('deprecated flow write tools', () => {
  const names = ['snow_flow_flow_add', 'snow_flow_subflow_add', 'snow_flow_flow_publish', 'snow_flow_flow_test', 'snow_flow_flow_trigger'];

  it('keeps all five names in the manifest, flagged DEPRECATED', () => {
    const manifest = flowToolManifest();
    for (const name of names) {
      const t = manifest.find(x => x.name === name);
      expect(t, name).toBeDefined();
      expect(t!.description).toMatch(/^DEPRECATED/);
    }
    expect(Object.keys(DEPRECATED_FLOW_TOOLS).sort()).toEqual([...names].sort());
  });

  it('throws DEPRECATED_TOOL pointing at the replacement and never calls the client — even with WRITE_ENABLED', async () => {
    for (const name of names) {
      let err: { code?: string; message?: string; details?: { replacement?: string } } | undefined;
      try {
        await dispatchFlowAction(mockClient, name, { name: 'x', flow_sys_id: '0123456789abcdef0123456789abcdef' });
      } catch (e) { err = e as typeof err; }
      expect(err?.code, name).toBe('DEPRECATED_TOOL');
      expect(err?.message).toMatch(/snow_flow_(build|verify|plan)/);
      expect(err?.details?.replacement).toBe(DEPRECATED_FLOW_TOOLS[name]);
    }
    expect(c).not.toHaveBeenCalled();
    expect(u).not.toHaveBeenCalled();
    expect(q).not.toHaveBeenCalled();
  });
});

describe('re-pointed reads', () => {
  it('snow_flow_subflows_index queries sys_hub_flow with type=subflow', async () => {
    q.mockResolvedValue({ count: 0, records: [] });
    await dispatchFlowAction(mockClient, 'snow_flow_subflows_index', { query: 'Approval' });
    expect(q).toHaveBeenCalledWith({ table: 'sys_hub_flow', query: 'active=true^nameCONTAINSApproval^type=subflow', limit: 50 });
    await dispatchFlowAction(mockClient, 'snow_flow_subflows_index', { active: false });
    expect(q).toHaveBeenLastCalledWith({ table: 'sys_hub_flow', query: 'type=subflow', limit: 50 });
  });

  it('snow_flow_subflow_read reads sys_hub_flow by sys_id or by name with type=subflow', async () => {
    g.mockResolvedValue({ sys_id: '0123456789abcdef0123456789abcdef' });
    await dispatchFlowAction(mockClient, 'snow_flow_subflow_read', { name_or_sysid: '0123456789abcdef0123456789abcdef' });
    expect(g).toHaveBeenCalledWith('sys_hub_flow', '0123456789abcdef0123456789abcdef');
    q.mockResolvedValue({ count: 1, records: [{ name: 'Approval Sub' }] });
    const r = await dispatchFlowAction(mockClient, 'snow_flow_subflow_read', { name_or_sysid: 'Approval Sub' });
    expect(q).toHaveBeenCalledWith({ table: 'sys_hub_flow', query: 'type=subflow^nameCONTAINSApproval Sub', limit: 1 });
    expect(r).toEqual({ name: 'Approval Sub' });
  });

  it('snow_flow_action_instances_index reads sys_hub_action_type_definition', async () => {
    q.mockResolvedValue({ count: 0, records: [] });
    await dispatchFlowAction(mockClient, 'snow_flow_action_instances_index', { query: 'Log' });
    expect(q).toHaveBeenCalledWith({ table: 'sys_hub_action_type_definition', query: 'nameCONTAINSLog', limit: 50 });
  });

  it('unrelated names still return null', async () => {
    expect(await dispatchFlowAction(mockClient, 'snow_flow_build', {})).toBeNull();
  });
});
