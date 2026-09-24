/**
 * gzip + base64 encoding of the JSON blobs Flow Designer stores on
 * `sys_hub_*_instance_v2.values`, `sys_hub_trigger_instance_v2.trigger_inputs`
 * and friends (node:zlib only).
 *
 * Determinism: node's gzip header carries an OS byte that differs between
 * Windows (0x0a) and Unix (0x03) and an mtime that zlib leaves at 0. We
 * normalise the 10-byte header to `1f 8b 08 00 | 00 00 00 00 | 00 | 03` so the
 * same JSON string yields the same base64 on every platform and every run.
 * The deflate body is produced at a fixed level with fixed settings, so it is
 * deterministic for a given zlib build; for the same JSON it is byte-identical to the deflate stream of
 * UI-built rows on the PDI (only their OS header byte, 0xff, differs — generator/pdi-conformance.test.ts).
 *
 * Owner: SCAFFOLD (full implementation). Consumers: GENERATOR, WRITER, tools.
 */
import { gzipSync, gunzipSync, constants as zc } from 'node:zlib';

const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);

/** gzip a UTF-8 string and return base64 with a normalised, deterministic header. */
export function gzipB64(text: string): string {
  if (typeof text !== 'string') throw new TypeError('gzipB64: expected a string');
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: zc.Z_DEFAULT_COMPRESSION, memLevel: 8, strategy: zc.Z_DEFAULT_STRATEGY });
  GZIP_HEADER.copy(gz, 0, 0, GZIP_HEADER.length);
  return gz.toString('base64');
}

/** base64 → gunzip → UTF-8 string. Accepts any valid gzip stream, not only ours. */
export function unB64Gzip(b64: string): string {
  if (typeof b64 !== 'string' || b64.length === 0) throw new TypeError('unB64Gzip: expected a non-empty base64 string');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 18 || buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error('unB64Gzip: input is not a gzip stream');
  return gunzipSync(buf).toString('utf8');
}

/** JSON.stringify (no whitespace) → gzip → base64 — the platform's storage form of these blobs. */
export function encodeValues(value: unknown): string {
  if (value === undefined) throw new TypeError('encodeValues: value must be JSON-serialisable (got undefined)');
  return gzipB64(JSON.stringify(value));
}

/** base64 → gunzip → JSON.parse. */
export function decodeValues(b64gz: string): unknown {
  return JSON.parse(unB64Gzip(b64gz));
}

/** True when the string looks like one of our (or the platform's) gzip+base64 blobs. */
export function looksLikeGzipB64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 24) return false;
  // gzip magic 1f 8b → base64 'H4sI'
  return value.startsWith('H4sI') && /^[A-Za-z0-9+/]+=*$/.test(value);
}
