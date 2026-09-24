export class ServiceNowError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ServiceNowError';
  }
}

/** Max detail lines appended to a tool error message. */
const MAX_DETAIL_LINES = 20;

/**
 * The tool-facing text of a ServiceNowError: the message and code, plus the entries of `details.errors` when the
 * error carries such a list (e.g. FLOW_BUILDER_INVALID_SPEC) — otherwise the caller sees only "N errors".
 */
export function formatServiceNowError(error: ServiceNowError): string {
  const head = `Error: ${error.message} (Code: ${error.code})`;
  const d = error.details && typeof error.details === 'object' ? (error.details as { errors?: unknown }) : undefined;
  if (!d || !Array.isArray(d.errors) || d.errors.length === 0) return head;
  const line = (e: unknown): string => {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && 'message' in e) {
      const { path, message } = e as { path?: unknown; message?: unknown };
      return path ? `${String(path)}: ${String(message)}` : String(message);
    }
    return JSON.stringify(e);
  };
  const lines = d.errors.slice(0, MAX_DETAIL_LINES).map(e => `- ${line(e)}`);
  if (d.errors.length > MAX_DETAIL_LINES) lines.push(`- … ${d.errors.length - MAX_DETAIL_LINES} more`);
  return `${head}\n${lines.join('\n')}`;
}
