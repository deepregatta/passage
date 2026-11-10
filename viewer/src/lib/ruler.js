// Layout helpers for the time ruler and the leg progress bar (pure, no DOM).

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');

/** HH:MM in the viewer's browser time zone, the zone the page header states. */
export function fmtLocalClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Tue 11" for the browser-local day containing ms (names are localised by the page translator). */
export function fmtLocalDay(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()}`;
}

/**
 * Ruler ticks on browser-local wall-clock hours. The step (6, 12 or 24 h, always
 * aligned to local midnight) is the smallest that keeps at most `maxTicks` labels,
 * so labels never collide. Ticks at local midnight carry `day`.
 */
export function rulerTicks(t0, t1, maxTicks = 8) {
  const hourly = [];
  const d = new Date(t0);
  d.setMinutes(0, 0, 0);
  if (d.getTime() < t0) d.setHours(d.getHours() + 1);
  for (; d.getTime() < t1; d.setHours(d.getHours() + 1)) {
    if (d.getHours() % 6 === 0) hourly.push({ t: d.getTime(), hour: d.getHours() });
  }
  let step = 6;
  for (const candidate of [6, 12, 24]) {
    step = candidate;
    if (hourly.filter((tick) => tick.hour % candidate === 0).length <= maxTicks) break;
  }
  return hourly
    .filter((tick) => tick.hour % step === 0)
    .map((tick) => ({ t: tick.t, label: fmtLocalClock(tick.t), day: tick.hour === 0 ? fmtLocalDay(tick.t) : null }));
}

/**
 * Keep numbered markers at least `minGapPct` apart and inside [minGapPct, 100]
 * so neighbouring circles never touch (the container's padding holds the last one).
 */
export function spreadMarkers(pcts, minGapPct) {
  const n = pcts.length;
  if (!n) return [];
  const gap = Math.min(minGapPct, 100 / (n + 1));
  const out = pcts.map((pct) => Math.max(pct, gap));
  for (let i = 1; i < n; i += 1) out[i] = Math.max(out[i], out[i - 1] + gap);
  out[n - 1] = Math.min(out[n - 1], 100);
  for (let i = n - 2; i >= 0; i -= 1) out[i] = Math.min(out[i], out[i + 1] - gap);
  return out;
}

/** Centre a label on its position, but keep it inside the strip near either end (no clipping). */
export function edgeShift(pctValue, edgePct) {
  if (pctValue < edgePct) return '0';
  if (pctValue > 100 - edgePct) return '-100%';
  return '-50%';
}
