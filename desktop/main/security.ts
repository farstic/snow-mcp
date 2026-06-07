/** Pure security/validation helpers (extracted from index.ts for unit testing — no Electron deps). */

/** Validate URL protocol for shell.openExternal. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/** Strip potential API-key patterns from error messages before they reach the renderer/logs. */
export function sanitizeError(msg: string): string {
  return msg
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, 'sk-ant-***')
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***')
    .replace(/AIza[a-zA-Z0-9_-]+/g, 'AIza***')
    .replace(/gsk_[a-zA-Z0-9_-]+/g, 'gsk_***')
    .replace(/sk-or-[a-zA-Z0-9_-]+/g, 'sk-or-***')
    .replace(/key=[^&\s]+/g, 'key=***');
}

/** Allowlist of config keys the renderer is permitted to set. */
export const CONFIG_SET_ALLOWLIST = new Set<string>([
  'theme', 'telemetry', 'autoUpdate', 'windowBounds', 'settings', 'activeInstance',
]);

/** Validate a ServiceNow instance URL (must be https). */
export function isValidInstanceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
