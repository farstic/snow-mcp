/**
 * Symbolic pills (spec side) → platform pills (what Flow Designer stores).
 *
 *   trigger.current[.f]         → {{<TriggerName>_1.current[.f]}}   e.g. {{Created_1.current.number}}
 *   trigger.<output>[.f]        → {{<TriggerName>_1.<output>[.f]}}
 *   steps.<key>.<Output>[.f]    → {{<step uuid>.<Output>[.f]}}      (Output is case-sensitive: Record / Records / approval_state / 'Catalog Task')
 *   loop.<key>.item[.f]         → {{<forEach uuid>.item[.f]}}
 *   vars.<name>[.f]             → {{flow_variable.<name>[.f]}}
 *   inputs.<name>[.f]           → {{subflow.<name>[.f]}}             (PDI-FACTS §7: `{{subflow.<input>}}`)
 *   error.<name>                → {{<catch uuid>.__status__.<name>}} (PDI error-handler snapshot: `{{<catch ui_id>.__status__.message}}`)
 *   static.<sys_id>             → {{static.<sys_id>}}
 *
 * No '|type' suffix is ever emitted in values; typing lives in label_cache (labels.ts).
 *
 * Owner: SCAFFOLD (parsePill + grammar helpers) → GENERATOR (toPlatformPill, rewritePills).
 */
import { ServiceNowError } from '../utils/errors.js';
import { PILL_RE, pillTokensOf } from './spec/schema.js';
import type { ParsedPill } from './spec/types.js';

export { PILL_RE, pillTokensOf };

/** Parse a symbolic pill string into its parts. Throws on a lexically invalid pill. */
export function parsePill(symbolic: string): ParsedPill {
  const s = symbolic.trim();
  if (!PILL_RE.test(s)) throw new ServiceNowError(`invalid symbolic pill "${symbolic}"`, 'FLOW_BUILDER_INVALID_PILL');
  const seg = s.split('.');
  switch (seg[0]) {
    case 'trigger': return { root: 'trigger', name: seg[1], path: seg.slice(2) };
    case 'steps': return { root: 'steps', key: seg[1], output: seg[2], path: seg.slice(3) };
    case 'loop': return { root: 'loop', key: seg[1], path: seg.slice(3) }; // seg[2] === 'item'
    case 'vars': return { root: 'vars', name: seg[1], path: seg.slice(2) };
    case 'inputs': return { root: 'inputs', name: seg[1], path: seg.slice(2) };
    case 'error': return { root: 'error', name: seg[1], path: seg.slice(2) };
    case 'static': return { root: 'static', sys_id: seg[1] };
    default: throw new ServiceNowError(`invalid symbolic pill "${symbolic}"`, 'FLOW_BUILDER_INVALID_PILL');
  }
}

/** Every distinct symbolic pill referenced by a string that may contain `{{...}}` tokens. */
export function pillsInText(text: string): string[] {
  return [...new Set(pillTokensOf(text).map(t => t.trim()))];
}

/** What the generator knows when it rewrites pills for one flow. */
export interface PillContext {
  /** e.g. 'Created_1' for trigger.record.created; '' when the flow has no trigger. */
  triggerPrefix: string;
  /** uuid (8-4-4-4-12) of the action/subflow/logic instance that owns the step key. */
  stepUuid: (stepKey: string) => string | undefined;
  /** uuid of the for_each logic instance for the loop key. */
  loopUuid: (loopKey: string) => string | undefined;
  /** uuid of the TOP_LEVEL_CATCH row when the flow has an error handler (error.* pills). */
  errorHandlerUuid?: string;
}

/** A {{token}} with a non-empty body; the empty `{{}}` (the UI due_date "date" placeholder) is literal text. */
export const PLATFORM_PILL_RE = /\{\{(\s*[^{}\s][^{}]*)\}\}/g;

/** The platform pill string (without braces) for a symbolic pill. */
export function toPlatformPillName(symbolic: string, ctx: PillContext): string {
  const p = parsePill(symbolic);
  const tail = (path: string[]) => (path.length ? '.' + path.join('.') : '');
  switch (p.root) {
    case 'trigger':
      if (!ctx.triggerPrefix) throw new ServiceNowError(`pill "${symbolic}" needs a trigger`, 'FLOW_BUILDER_UNKNOWN_PILL_TARGET');
      return `${ctx.triggerPrefix}.${p.name}${tail(p.path)}`;
    case 'steps': {
      const uuid = ctx.stepUuid(p.key);
      if (!uuid) throw new ServiceNowError(`pill "${symbolic}" refers to unknown step "${p.key}"`, 'FLOW_BUILDER_UNKNOWN_PILL_TARGET');
      return `${uuid}.${p.output}${tail(p.path)}`;
    }
    case 'loop': {
      const uuid = ctx.loopUuid(p.key);
      if (!uuid) throw new ServiceNowError(`pill "${symbolic}" refers to unknown for_each "${p.key}"`, 'FLOW_BUILDER_UNKNOWN_PILL_TARGET');
      return `${uuid}.item${tail(p.path)}`;
    }
    case 'vars': return `flow_variable.${p.name}${tail(p.path)}`;
    case 'inputs': return `subflow.${p.name}${tail(p.path)}`;
    case 'error': {
      if (!ctx.errorHandlerUuid) throw new ServiceNowError(`pill "${symbolic}" is only valid inside error_handler steps`, 'FLOW_BUILDER_UNKNOWN_PILL_TARGET');
      return `${ctx.errorHandlerUuid}.__status__.${p.name}${tail(p.path)}`;
    }
    case 'static': return `static.${p.sys_id}`;
  }
}

/**
 * Rewrite one symbolic pill into its platform form (`{{...}}`).
 * Throws FLOW_BUILDER_UNKNOWN_PILL_TARGET when the key is unknown.
 */
export function toPlatformPill(symbolic: string, ctx: PillContext): string {
  return `{{${toPlatformPillName(symbolic, ctx)}}}`;
}

/** Rewrite every `{{symbolic}}` token in a text value to its platform form. */
export function rewritePills(text: string, ctx: PillContext): string {
  return text.replace(PLATFORM_PILL_RE, (_m, body: string) => toPlatformPill(body, ctx));
}

/** Every distinct platform pill (without braces) found in an already-rewritten string. */
export function platformPillsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLATFORM_PILL_RE)) out.push(m[1]);
  return [...new Set(out)];
}
