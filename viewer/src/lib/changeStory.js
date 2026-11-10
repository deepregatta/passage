import { fmtTextTime } from './format.js';

export { ruleLabels } from './ruleLabels.js';

export const kindLabels = {
  verdict_changed: 'the verdict changed',
  event_shifted: 'timing shifted',
  value_changed: 'strength changed',
  event_new: 'new signal',
  event_gone: 'signal cleared',
  source_updated: 'newer model run',
};

export function deriveChangeStory(changes, briefing) {
  if (changes?.story) return changes.story;
  const ranked = [...(changes?.entries ?? [])].map((entry, index) => ({ entry, index, score: entry.kind === 'verdict_changed' ? 100 : entry.kind === 'event_shifted' ? 70 : entry.kind === 'value_changed' ? 60 : entry.rule_id === 'A-WARN-01' ? 40 : 0 })).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3);
  return {
    headline_plain: changes?.verdict_transition?.from !== changes?.verdict_transition?.to ? `The verdict changed from “${label(changes.verdict_transition.from)}” to “${label(changes.verdict_transition.to)}”.` : `The assessment remains ${label(changes?.verdict_transition?.to ?? 'unchanged')}, with updated detail.`,
    headline_pro: 'Client-derived story for a legacy changes artifact; the full ledger remains authoritative.',
    material: ranked.map(({ entry, index }) => ({ change_ref: index, before: entry.previous ?? null, after: entry.latest ?? null, why_it_matters: entry.description, evidence_ids: entry.evidence_pair ?? [] })),
    next_run: briefing?.next_run ?? briefing?.next_runs?.[0] ?? null,
  };
}

const label = (state) => ({ within: 'within your limits', approaching: 'close to your limits', exceeds: 'beyond your limits', insufficient: 'too uncertain to assess', warning_active: 'official warning active' })[state] ?? String(state).replaceAll('_', ' ');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ENGINE_TIME = new RegExp(`\\b(?:${DAYS.join('|')}) (\\d{1,2}) (${MONTHS.join('|')}) (\\d{2}):(\\d{2})(?: UTC)?`, 'g');

/**
 * Engine ledger prose (engine/src/diff.ts) for the page: its UTC times ("Mon 20 Jul 18:00 UTC",
 * "A → B UTC") in the header zone like every other time in page text, and a tracked system named
 * so its id does not read like a leg ("The low (L1 on the chart)"). The saved text is unchanged.
 * @param {string} text
 * @param {string} referenceIso an instant of the check (departure), for the year the engine omits
 */
export function ledgerText(text, referenceIso) {
  if (typeof text !== 'string') return text;
  const ref = new Date(referenceIso);
  const year = Number.isFinite(ref.getTime()) ? ref.getUTCFullYear() : new Date().getUTCFullYear();
  return text
    .replace(ENGINE_TIME, (match, day, month, hh, mm) => {
      // the engine omits the year: take the one that puts the time nearest the check
      const candidates = [year - 1, year, year + 1].map((y) => Date.UTC(y, MONTHS.indexOf(month), Number(day), Number(hh), Number(mm)));
      const best = candidates.sort((a, b) => Math.abs(a - ref.getTime()) - Math.abs(b - ref.getTime()))[0];
      return Number.isFinite(best) ? fmtTextTime(new Date(best).toISOString()) : match;
    })
    .replace(/^(Low|High) (\S+) is the same system as in the previous briefing\./, (_m, kind, id) => `The ${kind.toLowerCase()} (${id} on the chart) is the same system as in the previous check.`);
}
