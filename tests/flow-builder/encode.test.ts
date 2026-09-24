import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { gzipB64, unB64Gzip, encodeValues, decodeValues, looksLikeGzipB64 } from '../../src/flow-builder/encode.js';

/** The values object of an Else / End Flow logic row, in the UI key order (all arrays empty; PDI-FACTS §6). */
const EMPTY_LOGIC_VALUES = { outputsToAssign: [], inputs: [], variables: [], decisionTableInputs: [], dynamicInputs: [], workflowInputs: [] };

describe('gzipB64 / unB64Gzip', () => {
  it('round-trips ASCII and UTF-8 text', () => {
    for (const text of ['', '{}', 'P1 created {{Created_1.current.number}}', 'Триаж ➛ Number', JSON.stringify(EMPTY_LOGIC_VALUES)]) {
      expect(unB64Gzip(gzipB64(text))).toBe(text);
    }
  });

  it('produces a normalised gzip header (mtime 0, xfl 0, OS 3) so output is identical across platforms', () => {
    const buf = Buffer.from(gzipB64('{}'), 'base64');
    expect(buf.subarray(0, 10).toString('hex')).toBe('1f8b08000000000000' + '03');
  });

  it('is deterministic: identical JSON gives identical base64', () => {
    const a = encodeValues(EMPTY_LOGIC_VALUES);
    const b = encodeValues({ ...EMPTY_LOGIC_VALUES });
    expect(a).toBe(b);
    expect(a.startsWith('H4sI')).toBe(true);
  });

  it('decodes a stream produced by plain node gzip (platform-native header)', () => {
    const native = gzipSync(Buffer.from('{"a":1}')).toString('base64');
    expect(decodeValues(native)).toEqual({ a: 1 });
  });

  it('rejects non-gzip input', () => {
    expect(() => unB64Gzip('')).toThrow(/non-empty/);
    expect(() => unB64Gzip(Buffer.from('plain text that is long enough').toString('base64'))).toThrow(/not a gzip stream/);
    expect(() => gzipB64(42 as unknown as string)).toThrow(/expected a string/);
  });
});

describe('encodeValues / decodeValues', () => {
  it('round-trips nested objects with JSON types preserved', () => {
    const v = { inputs: [{ id: '', name: 'condition', value: '{{Created_1.current.urgency}}=1', children: [], parameter: {}, scriptActive: false }], n: 1, b: true, nul: null };
    expect(decodeValues(encodeValues(v))).toEqual(v);
  });

  it('serialises with no whitespace (the platform storage form)', () => {
    expect(unB64Gzip(encodeValues({ a: [1, 2], b: 'x' }))).toBe('{"a":[1,2],"b":"x"}');
  });

  it('rejects undefined', () => {
    expect(() => encodeValues(undefined)).toThrow(/JSON-serialisable/);
  });
});

describe('looksLikeGzipB64', () => {
  it('recognises our blobs and rejects other strings', () => {
    expect(looksLikeGzipB64(encodeValues(EMPTY_LOGIC_VALUES))).toBe(true);
    expect(looksLikeGzipB64('H4sI')).toBe(false);
    expect(looksLikeGzipB64('incident')).toBe(false);
    expect(looksLikeGzipB64(123)).toBe(false);
  });
});
