import { forecastName } from './verdictSentence.js';
import { legLabel } from './routeLabels.jsx';

// Quick facts for the weather story card, kept in plain JS so each sentence is
// one text node with its own French pattern (i18n.js, "Strongest").

/** Hours when the boat is on the leg: grid hours inside [max(leg entry, departure), slow exit],
 * the engine's occupancy clamp (whole-hour samples before entry or after exit are left out). */
export function occupiedHours(findings, leg) {
  const start = Math.max(Date.parse(leg.enter_range?.fast ?? leg.hours[0]?.valid_time), Date.parse(findings.departure_utc));
  const end = Math.max(start, Date.parse(leg.eta_range?.slow ?? leg.hours.at(-1)?.valid_time));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return leg.hours;
  return leg.hours.filter((h) => {
    const t = Date.parse(h.valid_time);
    return t >= start && t <= end;
  });
}

const maxOf = (hours, fn) => {
  const vals = hours.map(fn).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  return vals.length ? Math.max(...vals) : null;
};

/** The leg with the strongest gust while the boat is on it, with its occupied-hour maxima. */
export function strongestLeg(findings) {
  let best = null;
  for (const leg of findings.legs) {
    const hours = occupiedHours(findings, leg);
    const gust = maxOf(hours, (h) => h.gust_kt);
    const wind = maxOf(hours, (h) => h.wind_kt);
    if (gust === null || wind === null || (best && gust <= best.gust)) continue;
    best = { leg, gust, wind, waves: maxOf(hours, (h) => h.waves?.hs_m ?? null) };
  }
  return best;
}
/**
 * "Strongest near X (leg 6): wind 27 kt," + [gusts] + " 37 kt, waves 2.8 m, hourly
 * maximum of the GFS forecast while you are on this leg." Hours outside the leg's
 * occupancy (the whole-hour samples before entry or after the slow exit) are left out.
 */
export function strongestText(findings) {
  const strongest = strongestLeg(findings);
  if (!strongest) return null;
  const { leg, wind, gust, waves } = strongest;
  const model = forecastName(findings.inputs?.forecast_tiles?.find((m) => m.layer === 'weather')?.model) ?? 'deterministic';
  return {
    leg,
    head: `Strongest ${legLabel(findings, leg.leg_id)}: wind ${Math.round(wind)} kt,`,
    tail: ` ${Math.round(gust)} kt${waves ? `, waves ${waves.toFixed(1)} m` : ''}, hourly maximum of the ${model} forecast while you are on this leg.`,
  };
}
