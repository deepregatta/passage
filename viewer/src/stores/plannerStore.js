import { newPassageId } from '../lib/passageIdentity.js';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { localDateTimeToIso, nextQuarterHour, toLocalDateTimeValue } from '../lib/format.js';

/** Planner working state lives outside the page component so a drawn route,
 * computed route, and departure scan survive switching stages — and is
 * persisted to localStorage so a half-planned passage survives a reload
 * (a briefing is only saved to My briefings when the passage is checked). */

/** The departure control opens on the sailor's real local clock, rounded up to
 * the next quarter hour — a stale departure restored from a past session would
 * silently plan the wrong day. */
function defaultDeparture() {
  return nextQuarterHour();
}

/** The two ways the departure comparison can rank its times (engine `rankCandidates` modes). */
export const RANK_TYPICAL = 'typical';
export const RANK_CAUTIOUS = 'cautious';

const initial = () => ({
  passageId: newPassageId(),
  mode: 'compute', // compute | draw — computing from the forecast is the primary way in
  waypoints: [],
  endpoints: [],
  computed: null, // RoutingResult
  name: 'My passage',
  // True until the sailor types a name: the page then keeps the name it derives
  // (generic, or "Start → Finish" when both ends are named) and never overwrites a typed one.
  nameAuto: true,
  speeds: { slow: 4.5, nominal: 5.5, fast: 6.5 },
  departureLocal: defaultDeparture(),
  // No boat until the sailor chooses one: a preselected polar would route a boat they never picked.
  // (A draft saved before this change keeps whatever boat it holds.)
  polarId: null,
  polarLabel: null,
  // Percent of the boat's polar speeds the router assumes (compute mode). A draft saved
  // before this field existed takes the default through the persist merge (no migration).
  polarPercent: 100,
  scan: null,
  // How the departure comparison ranks its times: 'typical' (main forecast) or 'cautious'
  // (forecast scenarios first). A view preference over a scan already held: it is not an
  // input of any result, so it stays out of every stale-input key. A draft saved before this
  // field existed takes the default through the persist merge (no migration).
  rankMode: RANK_TYPICAL,
  autoScan: false, // set by the briefing's "Find a departure that fits" — Planner runs one scan and clears it
});

export const usePlanner = create(
  persist(
    (set, get) => ({
      ...initial(),
      // Writing a name from outside the page's own default (a restored draft, a test) makes it a chosen name.
      patch: (partial) => set('name' in partial && !('nameAuto' in partial) ? { ...partial, nameAuto: false } : partial),
      // A new passage starts clean, but the sailor's choice of how to read comparisons carries over.
      reset: () => set({ ...initial(), rankMode: get().rankMode }),
    }),
    {
      name: 'deepweather.planner-draft',
      // Persistence is optional; blocked/full storage must not abort a Check or Scan.
      storage: createJSONStorage(() => ({
        getItem: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
        setItem: (key, value) => { try { localStorage.setItem(key, value); } catch { /* keep the in-memory draft */ } },
        removeItem: (key) => { try { localStorage.removeItem(key); } catch { /* optional persistence */ } },
      })),
      version: 3,
      migrate: (persisted, version) => {
        persisted = { ...persisted, passageId: persisted?.passageId || newPassageId() };
        // Before version 3 nothing recorded who chose the name: only the two default names are the page's own.
        if (version < 3) persisted.nameAuto = !persisted.name || persisted.name === 'My passage' || persisted.name === 'Ma traversée';
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
