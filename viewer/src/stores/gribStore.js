import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { GRIB_DEFAULT_PERIOD, normalizeGribPeriod, validGribArea } from '../lib/gribExport.js';

/** GRIB files page choices, remembered so a sailor's usual area and period
 * are ready on the next visit (docs/grib-export.md → GRIB files page). */
const initial = () => ({
  area: null, // { minLat, maxLat, minLon, maxLon }
  period: GRIB_DEFAULT_PERIOD,
  step: 'all',
  // a model the sailor picked per kind; null follows the local-first default
  models: { wind: null, currents: null },
  // bumped when the area arrives from elsewhere (planner, link), so the chart fits it
  fitNonce: 0,
});

export const useGrib = create(
  persist(
    (set) => ({
      ...initial(),
      patch: (partial) => set(partial),
      /** An area chosen outside the chart: store it and bring it into view. */
      showArea: (area) => set((state) => ({ area: validGribArea(area), fitNonce: state.fitNonce + 1 })),
      reset: () => set(initial()),
    }),
    {
      name: 'deepweather.grib',
      version: 1,
      partialize: ({ area, period, step, models }) => ({ area, period, step, models }),
      merge: (persisted, current) => ({
        ...current,
        area: validGribArea(persisted?.area),
        period: normalizeGribPeriod(persisted?.period),
        step: ['all', 3, 6].includes(persisted?.step) ? persisted.step : 'all',
        models: { ...current.models, ...(persisted?.models ?? {}) },
      }),
    },
  ),
);
