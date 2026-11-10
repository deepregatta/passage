import { fmtLocalTime, localTimeZoneName } from './format.js';

// Time axis and accessible-text helpers shared by the forecast charts.
// Chart times follow the briefing header: browser-local time, zone named explicitly
// (fmtLocalTime / localTimeZoneName from format.js), never a second convention.

const sameLocalDay = (a, b) => {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};

/** "Mon 13 Jul 06:00" split into its parts, from the header's own formatter. */
function localParts(ms) {
  const [weekday, day, month, clock] = fmtLocalTime(new Date(ms).toISOString()).split(' ');
  return { weekday, day, month, clock };
}

/**
 * One x-axis tick label. The clock time always shows; the first tick shown and the
 * first tick of each new local day also carry "Mon 13" on a second line, so a three-day
 * axis never repeats bare hours.
 */
export function axisTickLabel(ms, previousShownMs = null) {
  const { weekday, day, clock } = localParts(ms);
  if (previousShownMs !== null && sameLocalDay(ms, previousShownMs)) return clock;
  return `${clock}\n${weekday} ${day}`;
}

/**
 * ECharts axis-label formatter. ECharts asks for the ticks in order and index 0 starts
 * a pass, so the formatter remembers the last label it showed. `skipOdd` blanks every
 * second tick (phone widths) and measures day changes against the last visible tick.
 */
export function createAxisLabelFormatter({ skipOdd = false } = {}) {
  let lastShown = null;
  return (value, index = 0) => {
    if (index === 0) lastShown = null;
    if (skipOdd && index % 2) return '';
    const label = axisTickLabel(value, lastShown);
    lastShown = value;
    return label;
  };
}

/** The axis caption naming the zone; reuses the "local time · zone" wording (and its French pattern). */
export function timeZoneAxisName() {
  return `local time · ${localTimeZoneName()}`;
}

/** x-axis caption props: the zone named under the axis, clear of the two-line tick labels. */
export function timeZoneAxisProps(color) {
  return {
    name: timeZoneAxisName(),
    nameLocation: 'middle',
    nameGap: 52,
    nameTextStyle: { color, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
  };
}

/** "Mon 13 Jul 06:00 to Wed 15 Jul 06:00", header formatting. */
export function describeTimeSpan(startMs, endMs) {
  const stamp = (ms) => fmtLocalTime(new Date(ms).toISOString());
  return `${stamp(startMs)} to ${stamp(endMs)}`;
}

/**
 * Merge hours that touch into continuous bands. `halfWidthMs` is half the width drawn
 * around each hour; consecutive hours at most one `stepMs` apart join one band.
 */
export function mergeDivergenceBands(timesMs, { stepMs = 3600_000, halfWidthMs = stepMs / 2 } = {}) {
  const sorted = [...new Set(timesMs.filter(Number.isFinite))].sort((a, b) => a - b);
  const bands = [];
  for (const t of sorted) {
    const last = bands.at(-1);
    if (last && t - last.lastHour <= stepMs) {
      last.end = t + halfWidthMs;
      last.lastHour = t;
      last.hours += 1;
    } else {
      bands.push({ start: t - halfWidthMs, end: t + halfWidthMs, lastHour: t, hours: 1 });
    }
  }
  return bands.map(({ start, end, hours }) => ({ start, end, hours }));
}

/** Index of the one band that carries the "divergence" label: the widest, earliest on ties. */
export function labelledBandIndex(bands) {
  let best = -1;
  bands.forEach((band, i) => {
    if (best < 0 || band.end - band.start > bands[best].end - bands[best].start) best = i;
  });
  return best;
}

/** Smallest positive gap between samples, falling back to one hour. */
export function sampleStepMs(timesMs) {
  let step = Infinity;
  for (let i = 1; i < timesMs.length; i++) {
    const gap = timesMs[i] - timesMs[i - 1];
    if (gap > 0 && gap < step) step = gap;
  }
  return Number.isFinite(step) ? step : 3600_000;
}

/** Screen-reader text for the ensemble plume. Kept one regular sentence so it can be translated. */
export function plumeAriaLabel({ members, variable, startMs, endMs, limit, units }) {
  const noun = variable === 'gust' ? 'gust' : 'wind';
  const span = `${describeTimeSpan(startMs, endMs)}, local time ${localTimeZoneName()}`;
  const limitText = Number.isFinite(limit) ? ` Your limit: ${limit} ${units}.` : '';
  return `Ensemble plume of ${members} forecast scenarios for ${noun}, from ${span}. Median and P10 to P90 range shown.${limitText}`;
}

/** Screen-reader text for the model comparison chart. */
export function modelComparisonAriaLabel({ modelNames, startMs, endMs, divergentHours }) {
  const span = `${describeTimeSpan(startMs, endMs)}, local time ${localTimeZoneName()}`;
  const names = modelNames.join(', ');
  const divergence = divergentHours > 0 ? ` Models diverge in ${divergentHours} h of this period.` : ' No divergent hours flagged.';
  return `Model comparison of 10 m sustained wind: ${names}, from ${span}.${divergence}`;
}
