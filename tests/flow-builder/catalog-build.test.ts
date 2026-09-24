/**
 * The committed catalogue (src/flow-builder/catalog/data) is exactly what scripts/build-flow-catalog.mjs builds from the
 * instance exports in src/flow-builder/catalog/source — no hand edits, nothing from another source.
 *
 * Owner: GENERATOR.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(ROOT, 'src', 'flow-builder', 'catalog', 'source');
const DATA = join(ROOT, 'src', 'flow-builder', 'catalog', 'data');

describe('catalogue build', () => {
  it('rebuilding from catalog/source reproduces catalog/data byte for byte', () => {
    const out = mkdtempSync(join(tmpdir(), 'flow-catalog-'));
    try {
      const log = execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-flow-catalog.mjs'), SOURCE, out], { encoding: 'utf8' });
      expect(log).toMatch(/13 triggers, 33 actions, 18 logic definitions/);
      for (const f of ['triggers.json', 'actions.json', 'logic.json']) {
        expect(readFileSync(join(out, f), 'utf8'), f).toBe(readFileSync(join(DATA, f), 'utf8'));
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('every referenced table of a trigger input carries the table label (reference_display)', () => {
    const { triggers } = JSON.parse(readFileSync(join(DATA, 'triggers.json'), 'utf8')) as { triggers: { name: string; inputs: { name: string; reference?: string; reference_display?: string }[] }[] };
    const refs = triggers.flatMap(t => t.inputs.filter(i => i.reference).map(i => `${t.name}.${i.name}=${i.reference}:${i.reference_display}`));
    expect(refs).toContain('Remote Table Query.u_table=sys_script_vtable:Remote Table');
    for (const r of refs) expect(r).not.toMatch(/:undefined$/);
  });
});
