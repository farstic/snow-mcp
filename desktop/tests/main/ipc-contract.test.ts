import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', '..', rel), 'utf8');

function channels(src: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

describe('IPC contract — preload window.api <-> main ipcMain handlers', () => {
  it('every invoked channel has a handler, and every handler is invoked', () => {
    const invoked = channels(read('main/preload.ts'), /ipcRenderer\.invoke\(\s*'([^']+)'/g);
    const handled = channels(read('main/index.ts'), /ipcMain\.handle\(\s*'([^']+)'/g);

    const missingHandlers = [...invoked].filter((c) => !handled.has(c)); // preload calls a channel main doesn't handle
    const orphanHandlers = [...handled].filter((c) => !invoked.has(c));  // main handles a channel preload never calls

    expect(missingHandlers).toEqual([]);
    expect(orphanHandlers).toEqual([]);
    expect(invoked.size).toBeGreaterThanOrEqual(17);
  });
});
