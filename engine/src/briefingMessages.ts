/** Semantic decision messages. Pure JSON facts and canonical English; no DOM. */
import { hazardNoun, limitRelation, VERDICT_TEXT } from './plainLanguage.js';
import { phraseExceedance } from './exceedance.js';
import type { Evidence, Findings } from './types.js';

const text = { type: 'string', maxLength: 4096 } as const;
const identifier = { ...text, minLength: 1 } as const;
const number = { type: 'number' } as const;
const utc = { ...identifier, format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$' } as const;
const units = { type: 'string', enum: ['kt', 'm', 'nm', 'hPa', 'J/kg', ''] } as const;
const count = { type: 'integer', minimum: 0, maximum: 10000 } as const;
const driver = { rule_id: identifier, leg_id: identifier, valid_time: utc, limit: number, units } as const;
const counts = { exceed: count, total: { ...count, minimum: 1 } } as const;

/** Types, runtime validation and the generated producer schema share this registry. */
export const DECISION_MESSAGE_REGISTRY = {
  'briefing.decision.title.v1': {},
  'briefing.decision.within.plain.v1': {},
  'briefing.decision.within.pro.v1': {},
  'briefing.decision.approaching.plain.v1': {},
  'briefing.decision.approaching.pro.v1': {},
  'briefing.decision.exceeds.plain.v1': {},
  'briefing.decision.exceeds.pro.v1': {},
  'briefing.decision.insufficient.plain.v1': {},
  'briefing.decision.insufficient.pro.v1': {},
  'briefing.decision.warning_active.plain.v1': {},
  'briefing.decision.warning_active.pro.v1': {},
  'briefing.decision.numeric.plain.v1': {
    leg_name: text, valid_time: utc, value: number, limit: number, units,
    hazard: { type: 'string', enum: ['gusts', 'winds', 'seas', 'wind against the tide', 'squall risk', 'visibility', 'conditions'] },
    relation: { type: 'string', enum: ['over', 'close to', 'under', 'below', 'above'] },
    style: { type: 'string', enum: ['up_to', 'just_over', 'down_to'] },
  },
  'briefing.decision.numeric.pro.v1': { ...driver, value: number },
  'briefing.decision.ensemble.plain.v1': { leg_name: text, valid_time: utc, limit: number, ...counts },
  'briefing.decision.ensemble.pro.v1': { ...driver, ...counts },
} as const;

type ParamValue<S> = S extends { enum: readonly (infer E)[] } ? E : S extends { type: 'string' } ? string : number;
export type DecisionMessageId = keyof typeof DECISION_MESSAGE_REGISTRY;
export type MessageParams<I extends DecisionMessageId> = keyof typeof DECISION_MESSAGE_REGISTRY[I] extends never ? Record<string, never> : { [K in keyof typeof DECISION_MESSAGE_REGISTRY[I]]: ParamValue<typeof DECISION_MESSAGE_REGISTRY[I][K]> };
export type DecisionMessageRef = { [I in DecisionMessageId]: { message_id: I; params: MessageParams<I> } }[DecisionMessageId];
export type DecisionMessageCatalogue = { [I in DecisionMessageId]: (params: MessageParams<I>) => string };
export interface DecisionMessages {
  title: DecisionMessageRef;
  /** Registers are paired and omitted together when typed gate facts are unavailable. */
  plain?: DecisionMessageRef[];
  pro?: DecisionMessageRef[];
}

/** Retains the original UTC English formatting; only catalogue-owned date tokens localize. */
export function formatMessageTime(iso: string, language: 'en' | 'fr' = 'en'): string {
  const d = new Date(iso);
  const days = language === 'fr' ? ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = language === 'fr' ? ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'] : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export const EN_DECISION_MESSAGES: DecisionMessageCatalogue = {
  'briefing.decision.title.v1': () => 'Against your declared limits',
  'briefing.decision.within.plain.v1': () => VERDICT_TEXT.within!.plain,
  'briefing.decision.within.pro.v1': () => VERDICT_TEXT.within!.pro,
  'briefing.decision.approaching.plain.v1': () => VERDICT_TEXT.approaching!.plain,
  'briefing.decision.approaching.pro.v1': () => VERDICT_TEXT.approaching!.pro,
  'briefing.decision.exceeds.plain.v1': () => VERDICT_TEXT.exceeds!.plain,
  'briefing.decision.exceeds.pro.v1': () => VERDICT_TEXT.exceeds!.pro,
  'briefing.decision.insufficient.plain.v1': () => VERDICT_TEXT.insufficient!.plain,
  'briefing.decision.insufficient.pro.v1': () => VERDICT_TEXT.insufficient!.pro,
  'briefing.decision.warning_active.plain.v1': () => VERDICT_TEXT.warning_active!.plain,
  'briefing.decision.warning_active.pro.v1': () => VERDICT_TEXT.warning_active!.pro,
  'briefing.decision.numeric.plain.v1': (p) => {
    const u = p.units ? ` ${p.units}` : '';
    const claim = p.style === 'down_to'
      ? `visibility down to ${Math.round(p.value)}${u}, ${p.relation} your ${p.limit}${u} minimum`
      : p.style === 'just_over'
        ? `${p.hazard} just over your ${p.limit}${u} limit`
        : `${p.hazard} up to ${Math.round(p.value)}${u}, ${p.relation} your ${p.limit}${u} limit`;
    return `The main signal: ${claim} on ${p.leg_name} around ${formatMessageTime(p.valid_time)} UTC.`;
  },
  'briefing.decision.numeric.pro.v1': (p) => `Driver: ${p.rule_id} on ${p.leg_id} at ${p.valid_time}; ${p.value} ${p.units} vs declared ${p.limit} ${p.units}.`,
  'briefing.decision.ensemble.plain.v1': (p) => `The main signal: ${phraseExceedance(p, `your ${p.limit} kt limit`)} on ${p.leg_name} around ${formatMessageTime(p.valid_time)} UTC.`,
  'briefing.decision.ensemble.pro.v1': (p) => `Driver: ${p.rule_id} on ${p.leg_id} at ${p.valid_time}; ${p.exceed}/${p.total} members > ${p.limit} ${p.units}.`,
};

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function isDecisionMessageRef(value: unknown): value is DecisionMessageRef {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'message_id,params' || typeof value.message_id !== 'string' || !Object.hasOwn(DECISION_MESSAGE_REGISTRY, value.message_id) || !object(value.params)) return false;
  const spec = DECISION_MESSAGE_REGISTRY[value.message_id as DecisionMessageId] as Record<string, { type: string; enum?: readonly string[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; format?: string; pattern?: string }>;
  const p = value.params;
  if (Object.keys(p).sort().join(',') !== Object.keys(spec).sort().join(',')) return false;
  for (const [key, s] of Object.entries(spec)) {
    const v = p[key];
    if (s.type === 'string') {
      if (typeof v !== 'string' || v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity) || (s.enum && !s.enum.includes(v))) return false;
      if (s.format === 'date-time') {
        if (!new RegExp(s.pattern!).test(v) || !Number.isFinite(Date.parse(v))) return false;
        if (new Date(v).toISOString().slice(0, 19) !== v.slice(0, 19)) return false;
      }
    } else if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v)) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity)) return false;
  }
  if ('exceed' in p && (p.exceed as number) > (p.total as number)) return false;
  if ('style' in p) {
    if (p.style === 'down_to' ? p.hazard !== 'visibility' || !['below', 'above'].includes(p.relation as string) : !['over', 'close to', 'under'].includes(p.relation as string)) return false;
    if (p.style === 'just_over' && p.relation !== 'over') return false;
  }
  return true;
}

export function renderDecisionMessage(ref: unknown, catalogue: DecisionMessageCatalogue = EN_DECISION_MESSAGES): string | null {
  if (!isDecisionMessageRef(ref) || !Object.hasOwn(catalogue, ref.message_id)) return null;
  // The registry above proves this discriminated ID/parameter pair at runtime.
  const render = catalogue[ref.message_id] as (params: DecisionMessageRef['params']) => string;
  if (typeof render !== 'function') return null;
  try {
    const text = render(ref.params);
    return typeof text === 'string' && text.length > 0 ? text : null;
  } catch { return null; }
}

export function renderDecisionRegister(refs: unknown, catalogue: DecisionMessageCatalogue = EN_DECISION_MESSAGES): string | null {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 16) return null;
  const rendered = refs.map((ref) => renderDecisionMessage(ref, catalogue));
  return rendered.every((value) => typeof value === 'string' && value.length > 0) ? rendered.join(' ') : null;
}

/** Unknown units/dates and prose-based gates retain a whole legacy register. */
export function decisionMessages(findings: Findings, driver?: Evidence): DecisionMessages {
  const title: DecisionMessageRef = { message_id: 'briefing.decision.title.v1', params: {} };
  const state = findings.verdict.state;
  const plain: DecisionMessageRef[] = [{ message_id: `briefing.decision.${state}.plain.v1`, params: {} }];
  const pro: DecisionMessageRef[] = [{ message_id: `briefing.decision.${state}.pro.v1`, params: {} }];
  if (findings.gates?.length) return { title };
  if (driver && state !== 'within') {
    const leg_name = findings.legs.find(l => l.leg_id === driver.leg_id)?.name ?? driver.leg_id;
    const shared = { valid_time: driver.valid_time, limit: driver.limit };
    const proFacts = { ...shared, rule_id: driver.rule_id, leg_id: driver.leg_id, units: driver.units };
    let plainRef: unknown;
    let proRef: unknown;
    if (driver.member_fraction) {
      plainRef = { message_id: 'briefing.decision.ensemble.plain.v1', params: { ...shared, leg_name, ...driver.member_fraction } };
      proRef = { message_id: 'briefing.decision.ensemble.pro.v1', params: { ...proFacts, ...driver.member_fraction } };
    } else if (typeof driver.value === 'number' && typeof driver.limit === 'number') {
      const visibility = driver.rule_id.startsWith('V-VIS');
      const relation = visibility ? driver.value < driver.limit ? 'below' : 'above' : limitRelation(driver.value, driver.limit);
      const style = visibility ? 'down_to' : relation === 'over' && Math.round(driver.value) <= driver.limit ? 'just_over' : 'up_to';
      plainRef = { message_id: 'briefing.decision.numeric.plain.v1', params: { ...shared, leg_name, value: driver.value, units: driver.units ?? '', hazard: hazardNoun(driver.rule_id), relation, style } };
      proRef = { message_id: 'briefing.decision.numeric.pro.v1', params: { ...proFacts, value: driver.value } };
    }
    if (plainRef !== undefined) {
      if (!isDecisionMessageRef(plainRef) || !isDecisionMessageRef(proRef)) return { title };
      plain.push(plainRef);
      pro.push(proRef);
    }
  }
  return { title, plain, pro };
}

/** Generated JSON Schema: closed producer contract, separate tolerant read envelope. */
export function decisionMessageDefinitions(closed: boolean) {
  const envelope = { type: 'object', required: ['message_id', 'params'], additionalProperties: false, properties: { message_id: { type: 'string', minLength: 1 }, params: { type: 'object' } } };
  return {
    decisionMessage: closed ? { oneOf: Object.entries(DECISION_MESSAGE_REGISTRY).map(([id, params]) => ({ ...envelope, properties: { message_id: { const: id }, params: { type: 'object', required: Object.keys(params), additionalProperties: false, properties: params } } })) } : envelope,
    decisionMessages: {
      type: 'object', required: ['title'], additionalProperties: false,
      dependentRequired: { plain: ['pro'], pro: ['plain'] },
      properties: { title: { $ref: '#/$defs/decisionMessage' }, ...Object.fromEntries(['plain', 'pro'].map(register => [register, { type: 'array', minItems: 1, maxItems: 16, items: { $ref: '#/$defs/decisionMessage' } }])) },
    },
  };
}

/** Producer's second validation layer: cross-parameter bounds and English parity. */
export function validDecisionMessageFields(section: { title: string; register_plain: string; register_pro: string; messages?: DecisionMessages }): boolean {
  const m = section.messages;
  if (m === undefined) return true;
  if (!object(m)) return false;
  if (Object.keys(m).some(key => !['title', 'plain', 'pro'].includes(key)) || renderDecisionMessage(m.title) !== section.title) return false;
  if ((m.plain === undefined) !== (m.pro === undefined)) return false;
  return m.plain === undefined || (renderDecisionRegister(m.plain) === section.register_plain && renderDecisionRegister(m.pro) === section.register_pro);
}
