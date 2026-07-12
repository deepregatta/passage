import { create } from 'zustand';

const HOUR = 3600_000;

export function frameForCursor(findings, synoptic, route, cursorHours, eventId) {
  if (!findings) return { phase: 'unavailable', cursorTime: null };
  const cursorMs = Date.parse(findings.departure_utc) + cursorHours * HOUR;
  const event = findings.causal_events?.find((item) => item.event_id === eventId) ?? findings.causal_events?.[0] ?? null;
  const system = synoptic?.systems?.find((item) => item.system_id === event?.system_id) ?? synoptic?.systems?.[0] ?? null;
  const systemPosition = interpolateTrack(system?.track ?? [], cursorMs);
  const leg = findings.legs.find((item) => cursorMs >= Date.parse(item.enter_range.nominal) && cursorMs <= Date.parse(item.eta_range.nominal)) ??
    (cursorMs < Date.parse(findings.departure_utc) ? findings.legs[0] : findings.legs.at(-1));
  const legIndex = findings.legs.indexOf(leg);
  const enter = Date.parse(leg?.enter_range.nominal ?? findings.departure_utc);
  const exit = Date.parse(leg?.eta_range.nominal ?? findings.departure_utc);
  const progress = Math.max(0, Math.min(1, (cursorMs - enter) / Math.max(1, exit - enter)));
  const from = route?.waypoints?.[legIndex];
  const to = route?.waypoints?.[legIndex + 1];
  const boatPosition = from && to ? { lat: from.lat + (to.lat - from.lat) * progress, lon: from.lon + (to.lon - from.lon) * progress, leg_id: leg?.leg_id } : leg?.sample_point;
  const intersection = event?.route_intersection;
  const start = Date.parse(intersection?.window_start ?? findings.departure_utc);
  const end = Date.parse(intersection?.window_end ?? findings.departure_utc);
  const phase = !event ? 'unavailable' : cursorMs < start ? 'cause' : cursorMs <= end ? 'interception' : cursorMs <= end + 6 * HOUR ? 'consequence' : 'easing';
  const evidence = (event?.consequence.evidence_ids ?? [])
    .map((id) => findings.evidence.find((item) => item.evidence_id === id))
    .filter((item) => item?.valid_time)
    .sort((a, b) => Math.abs(Date.parse(a.valid_time) - cursorMs) - Math.abs(Date.parse(b.valid_time) - cursorMs))[0] ?? null;
  return {
    cursorTime: new Date(cursorMs).toISOString().replace('.000Z', 'Z'),
    phase,
    event,
    systemPosition,
    boatPosition,
    activeLegId: leg?.leg_id ?? null,
    focusedEvidenceId: evidence?.evidence_id ?? null,
  };
}

function interpolateTrack(track, cursorMs) {
  if (!track.length) return null;
  const sorted = [...track].sort((a, b) => Date.parse(a.valid_time) - Date.parse(b.valid_time));
  if (cursorMs <= Date.parse(sorted[0].valid_time)) return sorted[0];
  if (cursorMs >= Date.parse(sorted.at(-1).valid_time)) return sorted.at(-1);
  const right = sorted.findIndex((point) => Date.parse(point.valid_time) >= cursorMs);
  const a = sorted[right - 1], b = sorted[right];
  const ratio = (cursorMs - Date.parse(a.valid_time)) / (Date.parse(b.valid_time) - Date.parse(a.valid_time));
  return { valid_time: new Date(cursorMs).toISOString(), lat: a.lat + (b.lat - a.lat) * ratio, lon: a.lon + (b.lon - a.lon) * ratio, center_hpa: a.center_hpa + (b.center_hpa - a.center_hpa) * ratio };
}

let raf = null;
let last = 0;
export const usePlayback = create((set, get) => ({
  cursorHours: 0,
  playing: false,
  focusedEventId: null,
  departureVariant: 'nominal',
  focusedEvidenceId: null,
  setCursor: (cursorHours) => set({ cursorHours: Math.max(0, cursorHours) }),
  step: (delta = 3) => set((state) => ({ cursorHours: Math.max(0, state.cursorHours + delta) })),
  focusEvent: (focusedEventId) => set({ focusedEventId }),
  setDepartureVariant: (departureVariant) => set({ departureVariant }),
  setFocusedEvidence: (focusedEvidenceId) => set({ focusedEvidenceId }),
  play: (maxHours = 36) => {
    if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    set({ playing: true });
    last = performance.now();
    const tick = (now) => {
      if (!get().playing) return;
      const delta = ((now - last) / 1000) * 1.5;
      last = now;
      set((state) => ({ cursorHours: state.cursorHours + delta > maxHours ? 0 : state.cursorHours + delta }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  },
  pause: () => {
    set({ playing: false });
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  },
}));
