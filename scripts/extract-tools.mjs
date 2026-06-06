#!/usr/bin/env node
/**
 * Extract all tool definitions to a static JSON manifest.
 * Run after `npm run build` in root: node scripts/extract-tools.mjs
 * Output: dist/tools-manifest.json
 */
import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distTools = join(__dirname, '..', 'dist', 'tools', 'index.js');

const { collectToolCatalog } = await import(pathToFileURL(distTools).href);
const tools = collectToolCatalog();

const manifest = tools.map(t => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

const outPath = join(__dirname, '..', 'dist', 'tools-manifest.json');
writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`Extracted ${manifest.length} tools → dist/tools-manifest.json`);

// Migration guard: the catalog must expose exactly 394 unique, namespaced tools.
const EXPECTED = 394;
const unique = new Set(manifest.map(t => t.name));
if (manifest.length !== EXPECTED || unique.size !== EXPECTED) {
  console.error(`✗ Tool count parity failed: ${manifest.length} tools (${unique.size} unique), expected ${EXPECTED}.`);
  process.exit(1);
}
const unnamespaced = manifest.filter(t => !t.name.startsWith('snow_')).map(t => t.name);
if (unnamespaced.length) {
  console.error(`✗ Un-namespaced tool names: ${unnamespaced.join(', ')}`);
  process.exit(1);
}
console.log(`✓ Parity OK: ${EXPECTED} unique snow_* tools.`);
