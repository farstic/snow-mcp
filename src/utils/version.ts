import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let cached: string | undefined;

/**
 * Reads the package version once from package.json so reported versions (MCP server
 * handshake, /health) stay in sync with the package instead of a hardcoded string.
 * Resolves dist/utils/version.js -> ../../package.json (and src/utils in dev).
 */
export function getPackageVersion(): string {
  if (cached !== undefined) return cached;
  let version = '0.0.0';
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string') version = pkg.version;
  } catch {
    /* keep fallback */
  }
  cached = version;
  return version;
}
