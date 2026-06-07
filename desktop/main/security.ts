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

export type BuildVariant = 'dev' | 'prod';

/**
 * Decide whether this process is the isolated DEV build or the production build.
 * The result drives whether the app uses a separate Application Support directory.
 * Resolution order (first match wins):
 *   1. SNMCP_VARIANT=dev|prod — explicit override (CI, `SNMCP_VARIANT=prod npm run dev`).
 *   2. Packaged DEV build — the bundled package.json name ends with "-dev", injected via
 *      `-c.extraMetadata.name=servicenow-mcp-dev` in the package:*:dev scripts. This is the
 *      LOAD-BEARING isolation signal — do not drop it from those scripts or dev silently
 *      shares the production data directory.
 *   3. Unpackaged development (`--dev`) — default to DEV so `npm run dev` never writes into a
 *      real production install's data directory.
 *   4. Otherwise — production. Production is never renamed, so its data dir is left untouched.
 */
export function resolveBuildVariant(opts: { envVariant?: string; appName?: string; isDev?: boolean }): BuildVariant {
  const { envVariant, appName = '', isDev = false } = opts;
  if (envVariant === 'dev') return 'dev';
  if (envVariant === 'prod') return 'prod';
  if (appName.toLowerCase().endsWith('-dev')) return 'dev';
  if (isDev) return 'dev';
  return 'prod';
}
