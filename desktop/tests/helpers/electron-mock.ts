/** Lightweight manual mock of the `electron` module for main-process unit tests. */

let _appName = 'servicenow-mcp-desktop';
export const app = {
  getPath: (_key: string) => process.env.DESKTOP_TEST_USERDATA || '',
  getName: () => _appName,
  setName: (name: string) => { _appName = name; },
  setPath: (_key: string, _path: string) => {},
  getVersion: () => '0.0.0-test',
  on: () => {},
  whenReady: () => Promise.resolve(),
  quit: () => {},
};

// In-memory safeStorage. Toggle availability via DESKTOP_TEST_NO_SAFESTORAGE=1 to test the fallback.
export const safeStorage = {
  isEncryptionAvailable: () => process.env.DESKTOP_TEST_NO_SAFESTORAGE !== '1',
  encryptString: (s: string) => Buffer.from('ss:' + s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^ss:/, ''),
};

export class BrowserWindow {
  webContents = { send: () => {}, openDevTools: () => {} };
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  on() {}
  static getAllWindows() { return []; }
}

export const ipcMain = { handle: () => {}, on: () => {} };
export const shell = { openExternal: () => Promise.resolve() };
export const dialog = { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] as string[] }) };
export const contextBridge = { exposeInMainWorld: () => {} };
export const ipcRenderer = { invoke: () => Promise.resolve(), on: () => {} };

export default { app, safeStorage, BrowserWindow, ipcMain, shell, dialog, contextBridge, ipcRenderer };
