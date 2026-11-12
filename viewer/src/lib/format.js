import { palette } from './palette.js';
// Deterministic UTC formatting + verdict metadata (exact verdict wording).

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtTime(iso) {
  if (!iso) return 'n/a';
  const d = new Date(Date.parse(iso));
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm}`;
}

/** Human-readable timestamp in the viewer's browser timezone. */
export function fmtLocalTime(iso) {
  if (!iso) return 'n/a';
  const d = new Date(Date.parse(iso));
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${hh}:${mm}`;
}

/** Convert an instant to the value used by the planner's browser-local controls. */
export function toLocalDateTimeValue(iso) {
  if (!iso) return '';
  const d = new Date(Date.parse(iso));
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hh}:${mm}`;
}

/** The next quarter hour at or after the given instant, as a planner value. */
export function nextQuarterHour(nowMs = Date.now()) {
  const step = 15 * 60_000;
  return toLocalDateTimeValue(new Date(Math.ceil(nowMs / step) * step).toISOString());
}

/** Interpret a planner value as browser-local wall time and return a UTC instant. */
export function localDateTimeToIso(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  if (hour > 23 || minute > 59) return null;
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
    || d.getHours() !== hour || d.getMinutes() !== minute
  ) return null;
  return d.toISOString();
}

/** IANA timezone name makes the meaning of "local" explicit without ambiguous abbreviations. */
export function localTimeZoneName() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'browser local time';
}

export function fmtHour(iso) {
  const d = new Date(Date.parse(iso));
  return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

/** Time inside page text. Page text uses the zone the header states ("times in
 * <zone>", localTimeZoneName()), so no zone is repeated here. Chart axes and
 * the engine's own prose are separate; a cross-reference to a UTC axis adds
 * fmtUtcClock as a clearly marked secondary. */
export function fmtTextTime(iso) {
  return fmtLocalTime(iso);
}

/** Header-zone clock only ("21:38"), for sentences that already name the day. */
export function fmtTextClock(iso) {
  if (!iso) return 'n/a';
  const d = new Date(Date.parse(iso));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Marked secondary UTC clock ("19:38 UTC") for cross-references to UTC axes. */
export function fmtUtcClock(iso) {
  if (!iso) return 'n/a';
  const d = new Date(Date.parse(iso));
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/**
 * An age for display: minutes under an hour, hours up to 48 h, days beyond
 * ("114 days"). Negative ages (clock skew) read as zero. `exact` keeps the
 * minutes inside the first 48 h ("2 h 05 min") for run-age lines.
 */
export function fmtAge(ms, { exact = false } = {}) {
  const totalMin = Math.round(Math.max(0, ms) / 60_000);
  const hours = totalMin / 60;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (exact) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
  }
  if (totalMin < 60) return 'under 1 h';
  return `${Math.round(hours)} h`;
}

/** "5 h old" / "114 days old" / "under 1 h old". */
export function fmtAgeOld(ms) {
  return `${fmtAge(ms)} old`;
}

export function runAge(fetchedAtIso, nowMs) {
  if (!fetchedAtIso) return null;
  return fmtAge(nowMs - Date.parse(fetchedAtIso), { exact: true });
}

/** Verdict states; exact wording, never "GO". */
export const VERDICT = {
  within: { label: 'Within your declared limits', glyph: '✓', tw: 'verdict-within', hex: palette.verdict.within },
  approaching: { label: 'Approaching your limits', glyph: '⚠', tw: 'verdict-approaching', hex: palette.verdict.approaching },
  exceeds: { label: 'Exceeds your limits', glyph: '⛔', tw: 'verdict-exceeds', hex: palette.verdict.exceeds },
  insufficient: {
    label: 'Models disagree · reassess after the next run',
    glyph: '◌',
    tw: 'verdict-insufficient',
    hex: palette.verdict.insufficient,
  },
  warning_active: { label: 'Official warning active', glyph: '🚩', tw: 'authority', hex: palette.authority },
};

/** Drawn routes have machine waypoint ids (wp1, wp2…); spell them out for display. */
export function placeLabel(raw) {
  return typeof raw === 'string' ? raw.replace(/\bwp(\d+)\b/gi, 'waypoint $1') : raw;
}

/** Jack layer: rule family → plain noun (mirrors engine plainLanguage.ts). */
export function hazardNoun(ruleId) {
  if (!ruleId) return 'conditions';
  if (ruleId.startsWith('W-GUST')) return 'gusts';
  if (ruleId.startsWith('W-SUST')) return 'winds';
  if (ruleId.startsWith('S-')) return 'seas';
  if (ruleId.startsWith('T-WAC')) return 'wind against the tide';
  if (ruleId.startsWith('C-CAPE')) return 'squall risk';
  if (ruleId.startsWith('V-VIS')) return 'visibility';
  return 'conditions';
}

/** Jack layer: causal event → plain noun phrase ("a deepening low"); ids stay in the pro register. */
export function plainEventNoun(event, synoptic) {
  const system = synoptic?.systems?.find((s) => s.system_id === event.system_id);
  const deepening = (system?.deepening_hpa_per_24h ?? 0) >= 6;
  if (event.kind === 'low') return deepening ? 'a deepening low' : 'a low-pressure system';
  if (event.kind === 'high') return 'a high-pressure ridge';
  if (event.kind === 'front') return 'a weather front';
  return 'a weather system';
}

/** Jack layer: member fraction → subject + verb ("every forecast scenario shows"). */
export function scenarioShare(memberFraction) {
  const { exceed, total } = memberFraction;
  if (exceed === total) return 'every forecast scenario shows';
  if (exceed / total >= 0.5) return 'most forecast scenarios show';
  return `${exceed} of ${total} forecast scenarios show`;
}

export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const STATUS_HEX = {
  ok: palette.verdict.within,
  approaching: palette.verdict.approaching,
  exceeded: palette.verdict.exceeds,
  unknown: palette.unknown,
};

/**
 * Worst per-hour condition status across the evaluated conditions. An hour with
 * an "unknown" status, or no status for a limit in `limits` (the limits the check
 * recorded anywhere, see recordedLimits), and nothing exceeded or approaching,
 * reads "unknown" (a forecast value is missing), never "ok". Display only: the
 * verdict ignores these hours.
 */
export function hourStatus(hour, limits) {
  const status = hour.limit_status ?? {};
  const statuses = Object.values(status);
  if (statuses.includes('exceeded')) return 'exceeded';
  if (statuses.includes('approaching')) return 'approaching';
  if (statuses.includes('unknown')) return 'unknown';
  for (const key of limits ?? []) if (status[key] !== 'ok') return 'unknown';
  return 'ok';
}

/** Severity order of hourStatus for "worst of" scans: missing sits between fine and approaching. */
export const STATUS_RANK = { ok: 0, unknown: 1, approaching: 2, exceeded: 3 };
