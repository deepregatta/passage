// Deterministic UTC formatting + verdict metadata (§7 wording, exactly).

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

export function fmtHour(iso) {
  const d = new Date(Date.parse(iso));
  return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

export function runAge(fetchedAtIso, nowMs) {
  if (!fetchedAtIso) return null;
  const ms = nowMs - Date.parse(fetchedAtIso);
  if (ms < 0) return '0 min';
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

/** §7 verdict states; exact wording, never "GO". */
export const VERDICT = {
  within: { label: 'Within your declared limits', glyph: '✓', tw: 'verdict-within', hex: '#2F6E4F' },
  approaching: { label: 'Approaching your limits', glyph: '⚠', tw: 'verdict-approaching', hex: '#A87718' },
  exceeds: { label: 'Exceeds your limits', glyph: '⛔', tw: 'verdict-exceeds', hex: '#A63B2A' },
  insufficient: {
    label: 'Models disagree · reassess after the next run',
    glyph: '◌',
    tw: 'verdict-insufficient',
    hex: '#5A6B82',
  },
  warning_active: { label: 'Official warning active', glyph: '🚩', tw: 'authority', hex: '#9E2B63' },
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
  ok: '#2F6E4F',
  approaching: '#A87718',
  exceeded: '#A63B2A',
  unknown: '#9AA6B5',
};

/** worst per-hour condition status across all evaluated conditions */
export function hourStatus(hour) {
  const statuses = Object.values(hour.limit_status ?? {});
  if (statuses.includes('exceeded')) return 'exceeded';
  if (statuses.includes('approaching')) return 'approaching';
  if (statuses.includes('unknown') && statuses.every((s) => s === 'unknown')) return 'unknown';
  return 'ok';
}
