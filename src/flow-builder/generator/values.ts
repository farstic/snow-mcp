/**
 * Value encoders — spec `Value` forms → the strings Flow Designer stores.
 *
 *   {duration}        glide_duration  '1970-01-01 00:00:00' + duration (days added to the day of month)
 *   time + timezone   glide_time      '1970-01-01 HH:MM:SS' converted to UTC (offset of the zone on 1970-01-01)
 *   run_in            glide_date_time 'YYYY-MM-DD HH:MM:SS' INSTANCE-LOCAL wall time (never UTC); an ISO-8601 instant is
 *                                     converted with wallTimeIn(<instance zone>, instant) — FORMAT-DECISIONS D17
 *   {template}        template_value  'f1=v1^f2=v2^EQ'; pills allowed; a {reference} sub-value is written in the
 *                                     UI form field={"display":"<label>","value":"<sys_id>"} (PDI-FACTS §8, FORMAT-DECISIONS.md);
 *                                     a {script} sub-value writes the placeholder `fd-scripted` and a script map
 *   {approval_rules}  approval_rules  ruleSets 'Or' / rules '&' / conditions '|' / Any|All|Res|n#|n% [+M] U[..] G[..]
 *                                     bare sys_id → {{static.<sys_id>}}                                          PDI-FACTS §7
 *   {list}            slushbucket     '<sys_id>:item_option_new,<sys_id>:item_option_new_set'                 PDI-FACTS §8
 *                     glide_list      comma-joined sys_ids / pills
 *   due_date default  schedule_date_time UI default JSON (PDI-FACTS §8)
 *
 * Owner: GENERATOR.
 */
import { ServiceNowError } from '../../utils/errors.js';
import type { DurationSpec, ApprovalRules, ValueInput } from '../spec/types.js';
import { SYS_ID_RE, templateCaretIssue, utcMillis } from '../spec/schema.js';

// ─── Durations / times ────────────────────────────────────────────────────────

export interface DurationParts { days: number; hours: number; minutes: number; seconds: number }

export function parseDuration(d: DurationSpec): DurationParts {
  if (typeof d === 'string') {
    const m = /^(?:(\d+) )?(\d{1,2}):(\d{2}):(\d{2})$/.exec(d);
    if (!m) throw new ServiceNowError(`invalid duration "${d}"`, 'FLOW_BUILDER_INVALID_SPEC');
    return { days: Number(m[1] ?? 0), hours: Number(m[2]), minutes: Number(m[3]), seconds: Number(m[4]) };
  }
  return { days: d.days ?? 0, hours: d.hours ?? 0, minutes: d.minutes ?? 0, seconds: d.seconds ?? 0 };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** glide_duration storage form: 1970-01-01 00:00:00 plus the duration (UTC arithmetic). */
export function durationToGlide(d: DurationSpec | undefined): string {
  if (d === undefined) return '1970-01-01 00:00:00';
  const p = parseDuration(d);
  const ms = (((p.days * 24 + p.hours) * 60 + p.minutes) * 60 + p.seconds) * 1000;
  return formatGlideDateTime(new Date(Date.UTC(1970, 0, 1) + ms));
}

export function formatGlideDateTime(dt: Date): string {
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())} ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}`;
}

/** Offset (minutes east of UTC) of an IANA zone at a given instant, via Intl. */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    throw new ServiceNowError(`unknown timezone "${timeZone}"`, 'FLOW_BUILDER_INVALID_SPEC');
  }
  const parts = Object.fromEntries(fmt.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const asUtc = utcMillis(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** True when Intl knows the IANA zone name (e.g. 'Europe/Brussels'). */
export function isKnownTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}

/**
 * Wall-clock time 'YYYY-MM-DD HH:MM:SS' of an instant in an IANA zone (the form a glide_date_time
 * trigger input stores: instance-local). Intl applies the zone's rules for that very instant, so
 * daylight saving time is handled per date (Europe/Brussels: +02:00 in summer, +01:00 in winter).
 */
export function wallTimeIn(timeZone: string, at: Date): string {
  const off = zoneOffsetMinutes(timeZone, at);
  return formatGlideDateTime(new Date(Math.floor(at.getTime() / 1000) * 1000 + off * 60000));
}

/**
 * The instants at which a zone's wall clock shows `wall` ('YYYY-MM-DD HH:MM:SS'): one normally, none in a
 * DST gap (the clock jumps over it), two in a DST overlap (the hour is repeated).
 */
export function instantsForWallTime(timeZone: string, wall: string): Date[] {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(wall);
  if (!m) return [];
  const asUtc = utcMillis(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const offsets = new Set<number>();
  for (const probe of [-36, -12, 0, 12, 36]) offsets.add(zoneOffsetMinutes(timeZone, new Date(asUtc + probe * 3600000)));
  const found = new Set<number>();
  for (const off of offsets) {
    const t = asUtc - off * 60000;
    if (wallTimeIn(timeZone, new Date(t)) === wall) found.add(t);
  }
  return [...found].sort((a, b) => a - b).map(t => new Date(t));
}

/**
 * glide_time storage form for a scheduled trigger: 'HH:MM:SS' in `timezone` (default UTC)
 * converted to UTC on 1970-01-01, the date glide_time values are stored on (PDI-FACTS §8; 08:00 Europe/Sofia → 06:00:00).
 */
export function timeToGlide(time: string, timezone?: string): string {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!m) throw new ServiceNowError(`invalid time "${time}"`, 'FLOW_BUILDER_INVALID_SPEC');
  let ms = Date.UTC(1970, 0, 1, Number(m[1]), Number(m[2]), Number(m[3]));
  if (timezone && timezone.toUpperCase() !== 'UTC') ms -= zoneOffsetMinutes(timezone, new Date(Date.UTC(1970, 0, 1))) * 60000;
  const dt = new Date(ms);
  // keep the date part at 1970-01-01 (a negative/positive day roll is folded back onto the same day)
  return `1970-01-01 ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}`;
}

// ─── Scalars ──────────────────────────────────────────────────────────────────

/** Coerce a spec scalar for a typed action input (booleans and integers keep their JSON type; strings pass through). */
export function coerceScalar(v: string | number | boolean, internalType: string): string | number | boolean {
  if (internalType === 'boolean') {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === '1' || v === 1) return true;
    if (v === 'false' || v === '0' || v === 0 || v === '') return false;
    return v;
  }
  if (internalType === 'integer' && typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return v;
}

/** Scalars inside flow-variable / subflow-output assignments are stored stringified ('5', 'true'). */
export function stringifyScalar(v: string | number | boolean): string {
  return typeof v === 'string' ? v : String(v);
}

// ─── Value classification ─────────────────────────────────────────────────────

export type ValueKind = 'scalar' | 'pill' | 'text' | 'template' | 'conditions' | 'reference' | 'approval_rules' | 'duration' | 'list' | 'script';

export function valueKind(v: ValueInput): ValueKind {
  if (typeof v !== 'object' || v === null) return 'scalar';
  const o = v as Record<string, unknown>;
  if ('pill' in o) return 'pill';
  if ('text' in o) return 'text';
  if ('template' in o) return 'template';
  if ('conditions' in o) return 'conditions';
  if ('reference' in o) return 'reference';
  if ('approval_rules' in o) return 'approval_rules';
  if ('duration' in o) return 'duration';
  if ('list' in o) return 'list';
  if ('script' in o) return 'script';
  throw new ServiceNowError(`unrecognised value ${JSON.stringify(v)}`, 'FLOW_BUILDER_INVALID_SPEC');
}

// ─── Template value ───────────────────────────────────────────────────────────

export interface TemplateEncoding {
  value: string;
  /** field → script, for {script} sub-values (stored on the entry as script[field]) */
  scripts: Record<string, string>;
}

/**
 * Encode a {template} object: 'f1=v1^f2=v2^EQ'. `renderPill` rewrites a symbolic pill;
 * `renderText` rewrites the {{...}} tokens of a text.
 */
export function encodeTemplate(
  template: Record<string, ValueInput>,
  renderPill: (symbolic: string) => string,
  renderText: (text: string) => string,
): TemplateEncoding {
  const parts: string[] = [];
  const scripts: Record<string, string> = {};
  for (const [field, v] of Object.entries(template)) {
    // Defence in depth (the schema already rejects this): a '^' in a literal part would inject
    // extra 'field=value' assignments into the '^'-joined template string.
    if (!/^[a-z][a-z0-9_.]*$/.test(field)) throw new ServiceNowError(`template field name "${field}" is not a dictionary element name`, 'FLOW_BUILDER_INVALID_SPEC');
    const caret = templateCaretIssue(v);
    if (caret) throw new ServiceNowError(`template field "${field}": the ${caret} contains "^", which would inject extra field assignments into the template`, 'FLOW_BUILDER_INVALID_SPEC');
    switch (valueKind(v)) {
      case 'scalar': parts.push(`${field}=${renderText(stringifyScalar(v as string | number | boolean))}`); break;
      case 'pill': parts.push(`${field}=${renderPill((v as { pill: string }).pill)}`); break;
      case 'text': parts.push(`${field}=${renderText((v as { text: string }).text)}`); break;
      case 'reference': {
        const r = v as { reference: string; display?: string };
        // UI-built form (PDI-FACTS §8): field={"display":"…","value":"<sys_id>"}.
        parts.push(`${field}=${JSON.stringify({ display: r.display ?? '', value: r.reference })}`);
        break;
      }
      case 'script': parts.push(`${field}=fd-scripted`); scripts[field] = (v as { script: string }).script; break;
      case 'duration': parts.push(`${field}=${durationToGlide((v as { duration: DurationSpec }).duration)}`); break;
      case 'conditions': parts.push(`${field}=${renderText((v as { conditions: string }).conditions)}`); break;
      case 'list': parts.push(`${field}=${encodeList((v as { list: ListItem[] }).list, 'glide_list', renderPill)}`); break;
      default:
        throw new ServiceNowError(`template field "${field}": unsupported value form ${valueKind(v)}`, 'FLOW_BUILDER_INVALID_SPEC');
    }
  }
  parts.push('EQ');
  return { value: parts.join('^'), scripts };
}

// ─── Lists (slushbucket / glide_list) ─────────────────────────────────────────

export type ListItem = string | { pill: string } | { reference: string; display?: string; table?: string } | { template: Record<string, unknown> };

/** Index of the first {template} item of a list (an object literal — only valid when appending to an array.object variable), or -1. */
export function templateItemIndex(list: readonly unknown[]): number {
  return list.findIndex(i => typeof i === 'object' && i !== null && 'template' in i);
}

export function encodeList(list: ListItem[], internalType: string, renderPill: (symbolic: string) => string): string {
  const t = templateItemIndex(list);
  if (t >= 0) {
    throw new ServiceNowError(`{list}[${t}] is a {template} object literal — only valid in an append_variables value for an array.object variable, not in a ${internalType} list`, 'FLOW_BUILDER_INVALID_SPEC');
  }
  const items = (list as Exclude<ListItem, { template: Record<string, unknown> }>[]).map(item => {
    if (typeof item === 'string') {
      if (internalType === 'slushbucket' && SYS_ID_RE.test(item)) return `${item}:item_option_new`;
      return item;
    }
    if ('pill' in item) return renderPill(item.pill);
    return internalType === 'slushbucket' ? `${item.reference}:item_option_new` : item.reference;
  });
  return items.join(',');
}

// ─── Approval rules ───────────────────────────────────────────────────────────

export type ApproverRef = string | { pill: string } | { reference: string; display?: string; table?: string };

function approverToken(a: ApproverRef, renderPill: (symbolic: string) => string): string {
  if (typeof a === 'string') return `{{static.${a}}}`;
  if ('pill' in a) return renderPill(a.pill);
  return `{{static.${a.reference}}}`;
}

/** 'ApprovesAnyG[{{...}}]' grammar — PDI-FACTS §8. */
export function encodeApprovalRules(rules: ApprovalRules, renderPill: (symbolic: string) => string): string {
  return rules.rule_sets.map(set => {
    const groups = set.rules.map(group => group.map(cond => {
      const rt = typeof cond.rule === 'string' ? cond.rule : 'count' in cond.rule ? `${cond.rule.count}#` : `${cond.rule.percent}%`;
      if (cond.manual) return `${rt}M`;
      let s = rt;
      if (cond.users?.length) s += `U[${cond.users.map(u => approverToken(u as ApproverRef, renderPill)).join(',')}]`;
      if (cond.groups?.length) s += `G[${cond.groups.map(g => approverToken(g as ApproverRef, renderPill)).join(',')}]`;
      return s;
    }).join('|')).join('&');
    return `${set.action}${groups}`;
  }).join('Or');
}

/** UI default for askForApproval.due_date when the spec omits it (PDI-FACTS §8). */
export const DUE_DATE_DEFAULT = '{"action":"none","date_type":"actual","date":"{{}}","duration":1,"duration_type":"days","schedule":"","schedule_label":""}';

// ─── Misc ─────────────────────────────────────────────────────────────────────

/** internal_name derivation when the spec does not supply one: lowercase, spaces → '_', ' - ' → '__', other chars dropped. */
export function internalNameFor(name: string): string {
  return name.trim().toLowerCase().replace(/\s+-\s+/g, '__').replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/_{3,}/g, '__') || 'flow';
}
