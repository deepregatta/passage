import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { localDateTimeToIso, toLocalDateTimeValue } from '../lib/format.js';

/** Planner working state lives outside the page component so a drawn route,
 * computed route, and departure scan survive switching stages — and is
 * persisted to localStorage so a half-planned passage survives a reload
 * (a briefing is only saved to My briefings when the passage is checked). */

/** The departure control opens on the sailor's real local clock — a stale
 * departure restored from a past session would silently plan the wrong day. */
function defaultDeparture() {
  return toLocalDateTimeValue(new Date().toISOString());
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
      version: 1,
      migrate: (persisted, version) => {
        if (version === 0 && persisted?.departureLocal) {
          return {
            ...persisted,
            // Version 0 displayed this wall-clock value as UTC. Preserve the
            // instant while moving the control to honest browser-local time.
            departureLocal: toLocalDateTimeValue(`${persisted.departureLocal}:00Z`),
          };
        }
        return persisted;
      },
      // scan results are ephemeral (live forecasts age fast); autoScan is a one-shot flag
      partialize: ({ scan, autoScan, patch, reset, ...rest }) => rest,
      // A departure restored from an earlier session is often already in the
      // past; reopening the planner should show the current local time instead.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const restored = localDateTimeToIso(state.departureLocal);
        if (!restored || Date.parse(restored) < Date.now()) {
          state.patch({ departureLocal: defaultDeparture() });
        }
      },
    },
  ),
);
