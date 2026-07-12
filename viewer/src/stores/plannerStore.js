import { create } from 'zustand';

/** Planner working state lives outside the page component so a drawn route,
 * computed route, and departure scan survive switching stages. */

function defaultDeparture() {
  const t = new Date(Date.now() + 24 * 3600_000);
  t.setUTCHours(6, 0, 0, 0);
  return t.toISOString().slice(0, 16);
}

const initial = () => ({
  mode: 'draw', // draw | compute
  waypoints: [],
  endpoints: [],
  computed: null, // RoutingResult
  name: 'My passage',
  speeds: { slow: 4.5, nominal: 5.5, fast: 6.5 },
  departureLocal: defaultDeparture(),
  polarId: 'sun-fast-3200',
  polarLabel: 'SUN FAST 3200',
  scan: null,
});

export const usePlanner = create((set) => ({
  ...initial(),
  patch: (partial) => set(partial),
  reset: () => set(initial()),
}));
