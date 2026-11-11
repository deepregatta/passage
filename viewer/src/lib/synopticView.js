// Pure view helpers for the synoptic pressure chart (SynopticHero): which
// points the first view must contain, how a viewport of any shape frames them,
// and the one-line phase caption.

const HOUR = 3600_000;

/** The caption under the chart. Every line describes the chart as drawn at the
 * cursor time, in the present tense, relative to the low's crossing of the
 * route; the phase eyebrow names the same phases. */
export const PHASE_CAPTION = {
  cause: 'The system is organizing west of your route.',
  interception: 'The low and the boat are in the same route window.',
  consequence: 'The system is just past your route and its strongest effect is being felt now.',
  easing: 'The low is moving clear and the passage is starting to ease.',
  unavailable: 'No tracked system crosses your route window. The wider pattern still sets your wind.',
};

export function phaseCaption(phase) {
  return PHASE_CAPTION[phase] ?? PHASE_CAPTION.unavailable;
}

/** Plain phase words: the weather story's eyebrow and the hero chart's banner use the same ones. */
export const PHASE_PLAIN = {
  cause: 'what sets this up',
  interception: 'while you are out there',
  consequence: 'right after your passage',
  easing: 'easing off',
  unavailable: '',
};

/** The phase of a causal event at a playback time: before, during, within 6 h after, or later than its route window. */
export function phaseAt(findings, event, cursorHours) {
  if (!event) return 'unavailable';
  const departure = Date.parse(findings.departure_utc);
  const time = departure + cursorHours * HOUR;
  const start = Date.parse(event.route_intersection?.window_start ?? findings.departure_utc);
  const end = Date.parse(event.route_intersection?.window_end ?? findings.departure_utc);
  return time < start ? 'cause' : time <= end ? 'interception' : time <= end + 6 * HOUR ? 'consequence' : 'easing';
}

/** Passage span in ms: departure to the last leg's nominal arrival. */
export function passageWindowMs(findings) {
  const start = Date.parse(findings?.departure_utc);
  if (!Number.isFinite(start)) return null;
  const legs = findings.legs ?? [];
  const ends = legs.map((leg) => Date.parse(leg.eta_range?.nominal)).filter(Number.isFinite);
  return { start, end: ends.length ? Math.max(...ends) : start };
}

/** Lat/lon points the first view must contain: the whole route plus the
 * system's track while it matters to the passage (the window padded by 6 h).
 * When no track point falls inside, the point nearest the route's centre is
 * used so a distant low is still in view. The set does not depend on the
 * playback cursor, so the framing stays still while time plays. */
export function chartFocusPoints({ route, system, window, padHours = 6 }) {
  const waypoints = (route?.waypoints ?? []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const track = (system?.track ?? []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  let tracked = [];
  if (track.length && window) {
    const pad = padHours * HOUR;
    tracked = track.filter((p) => {
      const t = Date.parse(p.valid_time);
      return Number.isFinite(t) && t >= window.start - pad && t <= window.end + pad;
    });
  }
  if (!tracked.length && track.length && waypoints.length) {
    const lat = waypoints.reduce((sum, p) => sum + p.lat, 0) / waypoints.length;
    const lon = waypoints.reduce((sum, p) => sum + p.lon, 0) / waypoints.length;
    const dist = (p) => (p.lat - lat) ** 2 + ((p.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    tracked = [track.reduce((best, p) => (dist(p) < dist(best) ? p : best))];
  }
  return [...waypoints, ...tracked];
}

function axisOffset(view, content, focus) {
  if (content <= view) return (view - content) / 2;
  return Math.min(0, Math.max(view - content, view / 2 - focus));
}

/** Place the chart image inside a viewport of any shape.
 * `points` are in the image's own pixel space. `whole` shows the entire image
 * (contain); `framed` zooms on the points' bounding box plus a margin of
 * `margin` of its size per side, never tighter than `minSpan` of the image
 * width and never more than `maxZoom` times the whole view. The result is
 * clamped so the image always covers the viewport when it is larger than it.
 * Returns the scale and the translation in viewport pixels (origin top-left). */
export function fitChartView({ container, image, points = [], mode = 'framed', margin = 0.3, minSpan = 0.1, maxZoom = 8 }) {
  const whole = Math.min(container.w / image.w, container.h / image.h);
  let scale = whole;
  let cx = image.w / 2;
  let cy = image.h / 2;
  if (mode === 'framed' && points.length) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const boxW = Math.max((Math.max(...xs) - Math.min(...xs)) * (1 + 2 * margin), minSpan * image.w);
    const boxH = Math.max((Math.max(...ys) - Math.min(...ys)) * (1 + 2 * margin), minSpan * image.w);
    cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    scale = Math.min(whole * maxZoom, Math.max(whole, Math.min(container.w / boxW, container.h / boxH)));
  }
  return {
    scale,
    x: axisOffset(container.w, image.w * scale, cx * scale),
    y: axisOffset(container.h, image.h * scale, cy * scale),
  };
}

/** Inline style for the stage that holds the chart image and its overlay.
 * Unmeasured (first paint, no layout) it simply fills the viewport. */
export function chartStageStyle({ size, image, points, framed }) {
  if (!size) return { width: '100%', height: '100%' };
  const view = fitChartView({ container: size, image, points, mode: framed ? 'framed' : 'whole' });
  return {
    width: image.w,
    height: image.h,
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    transformOrigin: '0 0',
    transition: 'transform .35s ease',
  };
}
