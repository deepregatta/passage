import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Planner working state lives outside the page component so a drawn route,
 * computed route, and departure scan survive switching stages — and is
 * persisted to localStorage so a half-planned passage survives a reload
 * (a briefing is only saved to My briefings when the passage is checked). */

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
  autoScan: false, // set by the briefing's "Find a departure that fits" — Planner runs one scan and clears it
});

export const usePlanner = create(
  persist(
    (set) => ({
      ...initial(),
      patch: (partial) => set(partial),
      reset: () => set(initial()),
    }),
    {
      name: 'deepweather.planner-draft',
      // scan results are ephemeral (live forecasts age fast); autoScan is a one-shot flag
      partialize: ({ scan, autoScan, patch, reset, ...rest }) => rest,
    },
  ),
);
