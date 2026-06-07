import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Unmount React trees between tests so queries don't see leftover renders.
afterEach(() => cleanup());

/** Default window.api mock for renderer component tests (override per-test as needed). */
export const makeApiMock = () => ({
  getConfig: vi.fn().mockResolvedValue(undefined),
  setConfig: vi.fn().mockResolvedValue(undefined),
  getAllConfig: vi.fn().mockResolvedValue({}),
  listInstances: vi.fn().mockResolvedValue([]),
  addInstance: vi.fn().mockResolvedValue({ success: true }),
  removeInstance: vi.fn().mockResolvedValue({ success: true }),
  testInstance: vi.fn().mockResolvedValue({ success: true }),
  startServer: vi.fn().mockResolvedValue({ success: true }),
  stopServer: vi.fn().mockResolvedValue({ success: true }),
  getServerStatus: vi.fn().mockResolvedValue({ running: false }),
  listTools: vi.fn().mockResolvedValue([]),
  routeToolInvocation: vi.fn().mockResolvedValue({ success: true, result: {} }),
  getAuditLogs: vi.fn().mockResolvedValue([]),
  getVersion: vi.fn().mockResolvedValue({ app: 'test', electron: 'x', node: 'y' }),
  openExternal: vi.fn().mockResolvedValue(undefined),
  selectDirectory: vi.fn().mockResolvedValue(null),
  getServerPath: vi.fn().mockResolvedValue('/x/dist/server.js'),
  sendChat: vi.fn().mockResolvedValue({ content: [] }),
});

(window as unknown as { api: unknown }).api = makeApiMock();
