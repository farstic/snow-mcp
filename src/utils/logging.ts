/**
 * Structured stderr logger.
 *
 * - LOG_LEVEL (error | warn | info | debug, default: info) gates which messages are emitted.
 * - REDACT_SENSITIVE_DATA=true deep-scrubs sensitive keys (passwords, tokens, secrets, …)
 *   from logged data before output.
 * All output goes to stderr so stdout stays a clean JSON-RPC stream for the MCP stdio transport.
 */
type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function activeLevel(): number {
  const lvl = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVEL_ORDER[lvl as LogLevel] ?? LEVEL_ORDER.info;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|api[_-]?key|client[_-]?secret|credential|cookie/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return value; // keep message/stack intact
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '***' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function scrub(data: unknown): unknown {
  return process.env.REDACT_SENSITIVE_DATA === 'true' ? redactValue(data) : data;
}

function emit(level: LogLevel, tag: string, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] > activeLevel()) return;
  if (data === undefined || data === '') {
    console.error(`[${tag}] ${message}`);
  } else {
    console.error(`[${tag}] ${message}`, scrub(data));
  }
}

export const logger = {
  debug(message: string, data?: unknown): void { emit('debug', 'DEBUG', message, data); },
  info(message: string, data?: unknown): void { emit('info', 'INFO', message, data); },
  warn(message: string, data?: unknown): void { emit('warn', 'WARN', message, data); },
  error(message: string, error?: unknown): void { emit('error', 'ERROR', message, error); },
};
