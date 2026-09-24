/**
 * Guards for the flow-builder tools — the safety layer that keeps the builder off
 * any instance the owner has not explicitly allowed.
 *
 * Instance policy (resolveInstanceOrThrow):
 *   1. `instance` is REQUIRED on build/verify (and honoured on plan). The tool NEVER falls
 *      back to the session's current instance (the default instance may be one the builder must not touch).
 *   2. The alias must exist in instanceManager.listAll().
 *   3. ALLOW is the primary control and is default-deny: FLOW_BUILDER_ALLOWED_INSTANCES is a comma
 *      list of aliases; unset or blank ⇒ every instance is refused.
 *   4. DENY wins over ALLOW: FLOW_BUILDER_DENY_PATTERN is an OPTIONAL comma-separated list of
 *      case-insensitive regular expressions, supplied only by local configuration (there is no
 *      built-in default). Every pattern is matched against the alias, the URL host, the group and the
 *      environment of the entry; a match refuses the instance even when it is on the allow list.
 *      An invalid pattern fails closed: every instance is refused (FLOW_BUILDER_BAD_DENY_PATTERN)
 *      until the configuration is fixed.
 *   5. The client is re-resolved via instanceManager.getClient(alias). The router-passed client
 *      is never used; if one is supplied and is not the very same object, the call aborts
 *      (FLOW_BUILDER_CLIENT_MISMATCH) because something upstream disagrees about the target.
 *
 * Feature flags live in src/utils/permissions.ts (requireFlowBuilder / requireFlowBuilderActivate)
 * and are re-exported here for the tool file.
 *
 * Export confinement (resolveExportPath): snow_flow_export_xml may only write under
 * FLOW_BUILDER_EXPORT_ROOT — realpath of the root and of the target's parent are compared,
 * symlinked targets are refused, and the file must end in .xml.
 *
 * Owner: SCAFFOLD (full implementation + tests). Consumers: src/tools/flow-builder.ts.
 */
import { realpathSync, statSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ServiceNowClient } from '../servicenow/client.js';
import { instanceManager } from '../servicenow/instances.js';
import { ServiceNowError } from '../utils/errors.js';
import { currentToolInvocation, type ToolInvocationContext } from '../utils/invocation-context.js';

export { requireFlowBuilder, requireFlowBuilderActivate, isFlowBuilderEnabled, isFlowBuilderActivateEnabled } from '../utils/permissions.js';

export const ENV_ALLOWED_INSTANCES = 'FLOW_BUILDER_ALLOWED_INSTANCES';
export const ENV_DENY_PATTERN = 'FLOW_BUILDER_DENY_PATTERN';
export const ENV_EXPORT_ROOT = 'FLOW_BUILDER_EXPORT_ROOT';

export interface InstanceEntryView { name: string; url: string; group: string; environment: string; active?: boolean }

export interface GuardDeps {
  listAll(): InstanceEntryView[];
  getClient(name: string): ServiceNowClient;
  env: NodeJS.ProcessEnv;
}

export interface ResolvedInstance {
  name: string;
  url: string;
  host: string;
  group: string;
  environment: string;
  client: ServiceNowClient;
}

export interface PolicyVerdict { allowed: boolean; code: string; reason: string }

const defaultDeps = (): GuardDeps => ({
  listAll: () => instanceManager.listAll(),
  getClient: (name: string) => instanceManager.getClient(name),
  env: process.env,
});

/** Host part of an instance URL ('' when unparsable). */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return String(url ?? '').toLowerCase(); }
}

/**
 * The configured deny list: FLOW_BUILDER_DENY_PATTERN split on commas, each entry trimmed and compiled
 * as a case-insensitive regular expression. Empty when unset or blank (the allow list is then the only
 * control). There is no built-in default — the patterns come from local configuration only.
 * Throws FLOW_BUILDER_BAD_DENY_PATTERN when any entry is not a valid regular expression; callers must
 * treat that as "refuse everything" (fail closed), never as "no deny list".
 */
export function denyPatterns(env: NodeJS.ProcessEnv = process.env): RegExp[] {
  const entries = (env[ENV_DENY_PATTERN] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return entries.map(raw => {
    try {
      return new RegExp(raw, 'i');
    } catch (e) {
      throw new ServiceNowError(`${ENV_DENY_PATTERN} entry "${raw}" is not a valid regular expression: ${(e as Error).message}`, 'FLOW_BUILDER_BAD_DENY_PATTERN');
    }
  });
}

/** The allow list, lower-cased; `undefined` when unset or blank (⇒ refuse everything). */
export function allowedInstanceNames(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env[ENV_ALLOWED_INSTANCES];
  if (raw === undefined) return undefined;
  const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return names.length ? names : undefined;
}

/** Pure policy check for one instance entry. Deny is evaluated first and wins; an invalid deny list fails closed. */
export function evaluateInstancePolicy(entry: InstanceEntryView, env: NodeJS.ProcessEnv = process.env): PolicyVerdict {
  let denies: RegExp[];
  try {
    denies = denyPatterns(env);
  } catch (e) {
    return { allowed: false, code: 'FLOW_BUILDER_BAD_DENY_PATTERN', reason: `${(e as Error).message} — the flow builder refuses every instance until ${ENV_DENY_PATTERN} is fixed` };
  }
  const fields: [string, string][] = [
    ['alias', entry.name ?? ''],
    ['host', hostOf(entry.url ?? '')],
    ['group', entry.group ?? ''],
    ['environment', entry.environment ?? ''],
  ];
  for (const deny of denies) {
    for (const [what, value] of fields) {
      if (value && deny.test(value)) {
        return { allowed: false, code: 'FLOW_BUILDER_INSTANCE_DENIED', reason: `instance "${entry.name}" is denied: ${what} "${value}" matches ${ENV_DENY_PATTERN} /${deny.source}/i` };
      }
    }
  }
  const allow = allowedInstanceNames(env);
  if (!allow) {
    return { allowed: false, code: 'FLOW_BUILDER_ALLOW_LIST_UNSET', reason: `${ENV_ALLOWED_INSTANCES} is unset or empty — the flow builder refuses every instance until an explicit allow list is configured` };
  }
  if (!allow.includes((entry.name ?? '').toLowerCase())) {
    return { allowed: false, code: 'FLOW_BUILDER_INSTANCE_NOT_ALLOWED', reason: `instance "${entry.name}" is not in ${ENV_ALLOWED_INSTANCES} (${allow.join(', ')})` };
  }
  return { allowed: true, code: 'OK', reason: 'allowed' };
}

/**
 * Resolve and authorise the target instance for a build/verify/plan call.
 * `routerClient` is the client the dispatcher was handed; it is never used, only checked.
 */
export function resolveInstanceOrThrow(
  args: Record<string, unknown>,
  routerClient?: ServiceNowClient,
  deps: GuardDeps = defaultDeps()
): ResolvedInstance {
  const requested = args?.instance;
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new ServiceNowError(
      'instance is required: name the target instance alias explicitly (the flow builder never uses the session\'s current instance)',
      'FLOW_BUILDER_INSTANCE_REQUIRED'
    );
  }
  const wanted = requested.trim();
  const entries = deps.listAll();
  const entry = entries.find(e => e.name === wanted) ?? entries.find(e => e.name.toLowerCase() === wanted.toLowerCase());
  if (!entry) {
    throw new ServiceNowError(`Unknown instance "${wanted}"`, 'FLOW_BUILDER_UNKNOWN_INSTANCE', { available: entries.map(e => e.name) });
  }
  const verdict = evaluateInstancePolicy(entry, deps.env);
  if (!verdict.allowed) throw new ServiceNowError(verdict.reason, verdict.code);

  const client = deps.getClient(entry.name);
  if (routerClient !== undefined && routerClient !== client) {
    throw new ServiceNowError(
      `router-supplied client does not match the re-resolved client for instance "${entry.name}" — aborting`,
      'FLOW_BUILDER_CLIENT_MISMATCH'
    );
  }
  return { name: entry.name, url: entry.url, host: hostOf(entry.url), group: entry.group, environment: entry.environment, client };
}

/**
 * Refuse a high-risk tool (snow_flow_build) unless it was invoked DIRECTLY by an MCP client over the
 * stdio server — the only path on which the client's permission prompt and the §2.1 'write approved'
 * gate see this tool by name. Refused:
 *   - no invocation context: REST /api/tool, A2A tasks, this package's programmatic ./sdk export (FLOW_BUILDER_TRANSPORT_REFUSED)
 *   - an MCP transport other than stdio (sse / http)                           (FLOW_BUILDER_TRANSPORT_REFUSED)
 *   - a nested call: the MCP client invoked another tool that routes to this one, e.g.
 *     snow_orch_playbook_exec with a snow_flow_build step                        (FLOW_BUILDER_NESTED_REFUSED)
 */
export function requireDirectMcpInvocation(tool: string, ctx: Readonly<ToolInvocationContext> | undefined = currentToolInvocation()): void {
  if (!ctx || ctx.channel !== 'mcp') {
    throw new ServiceNowError(
      `${tool} can only be invoked directly by an MCP client over the stdio server — refused on this path (REST /api/tool, A2A or programmatic calls carry no MCP permission prompt)`,
      'FLOW_BUILDER_TRANSPORT_REFUSED'
    );
  }
  if (ctx.transport !== 'stdio') {
    throw new ServiceNowError(`${tool} is only available over the MCP stdio transport (current transport: ${ctx.transport})`, 'FLOW_BUILDER_TRANSPORT_REFUSED');
  }
  if (ctx.tool !== tool) {
    throw new ServiceNowError(
      `${tool} cannot be invoked from inside another tool (${ctx.tool}) — call it directly so the MCP permission prompt and the write approval name it`,
      'FLOW_BUILDER_NESTED_REFUSED'
    );
  }
}

function normaliseForCompare(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isInside(root: string, target: string): boolean {
  const r = normaliseForCompare(root);
  const t = normaliseForCompare(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Confine an export path to FLOW_BUILDER_EXPORT_ROOT. Returns the absolute, real path to write.
 * A relative out_path is resolved against the root; an absolute one must already lie under it.
 */
export function resolveExportPath(outPath: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const rootRaw = (env[ENV_EXPORT_ROOT] ?? '').trim();
  if (!rootRaw) {
    throw new ServiceNowError(`${ENV_EXPORT_ROOT} is unset — snow_flow_export_xml refuses to write anywhere until an export root is configured`, 'FLOW_BUILDER_EXPORT_ROOT_UNSET');
  }
  let rootReal: string;
  try {
    rootReal = realpathSync.native(resolve(rootRaw));
    if (!statSync(rootReal).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    throw new ServiceNowError(`${ENV_EXPORT_ROOT} "${rootRaw}" is not an existing directory: ${(e as Error).message}`, 'FLOW_BUILDER_EXPORT_ROOT_INVALID');
  }

  if (typeof outPath !== 'string' || outPath.trim() === '') {
    throw new ServiceNowError('out_path is required', 'FLOW_BUILDER_EXPORT_PATH_REQUIRED');
  }
  const candidate = isAbsolute(outPath) ? resolve(outPath) : resolve(rootReal, outPath);
  if (!/\.xml$/i.test(basename(candidate))) {
    throw new ServiceNowError('out_path must name a .xml file', 'FLOW_BUILDER_EXPORT_NOT_XML');
  }

  let parentReal: string;
  try {
    parentReal = realpathSync.native(dirname(candidate));
  } catch {
    throw new ServiceNowError(`the parent directory of out_path does not exist: ${dirname(candidate)}`, 'FLOW_BUILDER_EXPORT_PARENT_MISSING');
  }
  const finalPath = join(parentReal, basename(candidate));
  if (!isInside(rootReal, finalPath)) {
    throw new ServiceNowError(`out_path resolves outside ${ENV_EXPORT_ROOT}: ${finalPath}`, 'FLOW_BUILDER_EXPORT_OUTSIDE_ROOT');
  }
  try {
    const st = lstatSync(finalPath);
    if (st.isSymbolicLink()) throw new ServiceNowError(`out_path is a symbolic link — refusing to write through it: ${finalPath}`, 'FLOW_BUILDER_EXPORT_SYMLINK');
    if (st.isDirectory()) throw new ServiceNowError(`out_path is a directory: ${finalPath}`, 'FLOW_BUILDER_EXPORT_IS_DIRECTORY');
  } catch (e) {
    if (e instanceof ServiceNowError) throw e;
    // ENOENT: the file does not exist yet — fine.
  }
  return finalPath;
}
