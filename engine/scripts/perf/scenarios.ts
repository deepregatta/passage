/**
 * Synthetic passages, weather and forecast tiles for the responsiveness
 * measurements (docs/maintenance/2026-11-12-scan-responsiveness.md). Shared by
 * the Node benchmark (engine/scripts/bench-routing-scan.ts) and the browser
 * measurement (viewer/e2e/perf/). Nothing here is product code, and nothing in
 * it is a real forecast, polar or current: every value is invented, with the
 * shapes and sizes of the real inputs (docs/forecast-tile-format.md).
 */

import { buildFixtureRun, type FixtureLayerSpec, type FixtureTileGrid, type FixtureVariable } from '../../test/helpers/fixtureRun.js';
import type { DeepPolarsEntry } from '../../src/routing/deepPolars.js';
import type { RegionGrid } from '../../src/grids.js';

/**
 * The clock of every run: by default a fixed one (the 00Z cycle has been out for four hours), so the
 * numbers do not depend on the day. `PERF_NOW=<ISO>` (set by `npm run perf:fixtures -w engine -- --live`) moves the
 * whole scenario to a real clock, for a phone, which cannot be given a fixed one.
 */
export const NOW_ISO = process.env.PERF_NOW ?? '2026-07-20T04:00:00Z';
export const CYCLE = `${NOW_ISO.slice(0, 10)}T00:00Z`;
/** The departure the planner is asked for: three hours on, on the six-hour grid, so a scan has 21 candidates. */
export const DEPARTURE_ISO = new Date(Math.ceil((Date.parse(NOW_ISO) + 3 * 3600_000) / (6 * 3600_000)) * 6 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface Passage {
  id: string;
  label: string;
  start: { lat: number; lon: number };
  finish: { lat: number; lon: number };
  /** what the passage is meant to exercise */
  note: string;
  /** residual current added to the invented tide, kt (u east, v north): an adverse one for the passage */
  residual: { u: number; v: number };
}

export const PASSAGES: Passage[] = [
  {
    id: 'coastal-20nm', label: 'Coastal hop, about 20 nm (Cherbourg offing to Barfleur offing)',
    start: { lat: 49.72, lon: -1.62 }, finish: { lat: 49.80, lon: -1.10 },
    note: 'short, tidal stream across the passage', residual: { u: 0, v: 0 },
  },
  {
    id: 'channel-63nm', label: 'Channel crossing, about 63 nm (Barfleur offing to Weymouth Bay offing)',
    start: { lat: 49.78, lon: -1.10 }, finish: { lat: 50.45, lon: -2.35 },
    note: 'tidal stream along the track', residual: { u: 0, v: 0 },
  },
  {
    id: 'channel-adverse-63nm', label: 'Channel crossing, about 63 nm, with a 1.5 kt adverse residual',
    start: { lat: 49.78, lon: -1.10 }, finish: { lat: 50.45, lon: -2.35 },
    note: 'a steady 1.5 kt current to the south-south-west on top of the tide', residual: { u: -0.5, v: -1.4 },
  },
  {
    id: 'land-77nm', label: 'Coastal detour, about 77 nm (Start Point offing to Poole offing, Portland Bill in the way)',
    start: { lat: 50.12, lon: -3.70 }, finish: { lat: 50.62, lon: -1.85 },
    note: 'the straight line touches land, so the router must go round Portland', residual: { u: 0, v: 0 },
  },
  {
    id: 'biscay-321nm', label: 'Biscay leg, about 321 nm (A Coruna offing to Brest offing)',
    start: { lat: 43.55, lon: -8.45 }, finish: { lat: 48.30, lon: -4.90 },
    note: 'long, open water, the router box is large', residual: { u: 0, v: 0 },
  },
];

// ---------------------------------------------------------------- weather

const rad = Math.PI / 180;

/** Wind speed (kt) and direction it blows from (deg), varying in space and in time so routes must change course. */
export function windAt(lat: number, lon: number, hoursFromCycle: number): { speed: number; fromDeg: number } {
  const speed = Math.max(2, 13 + 6 * Math.sin(2 * Math.PI * hoursFromCycle / 36 + lon * 0.4) + 3 * Math.cos(lat * 0.9 + hoursFromCycle / 24));
  const fromDeg = 180 + 50 * Math.sin(hoursFromCycle / 30 + lat * 0.5) + 15 * Math.cos(lon * 0.6);
  return { speed, fromDeg };
}
export function windUV(lat: number, lon: number, hoursFromCycle: number): { u: number; v: number; speed: number } {
  const { speed, fromDeg } = windAt(lat, lon, hoursFromCycle);
  return { u: -speed * Math.sin(fromDeg * rad), v: -speed * Math.cos(fromDeg * rad), speed };
}

/** Invented tidal stream (kt): strongest in the Channel, weak in Biscay, plus a steady residual. */
export function currentAt(lat: number, lon: number, hoursFromCycle: number, residual = { u: 0, v: 0 }): { u: number; v: number } {
  const channel = Math.exp(-(((lat - 50) / 1.6) ** 2));
  const amplitude = 0.4 + 2.1 * channel;
  const phase = (2 * Math.PI * hoursFromCycle) / 12.42 + lon * 0.5;
  return { u: amplitude * 0.8 * Math.cos(phase) + residual.u, v: amplitude * 0.6 * Math.sin(phase + 0.6) + residual.v };
}

const POLAR_TWA = [32, 45, 60, 90, 120, 150, 180];
const POLAR_TWS = [4, 8, 12, 16, 20, 25, 30];
/** Fraction of the boat's wind-driven speed made good at each of POLAR_TWA: invented, with a no-go edge at 32 degrees. */
const POLAR_ANGLE_FACTOR = [0.34, 0.62, 0.78, 0.9, 1, 0.93, 0.8];

/**
 * An invented cruiser in the deepregatta-polars/1 shape that /api/polars/<id>
 * serves (speeds_kt[twa][tws]). Computed from a formula, not copied from any
 * boat: it is no real polar, and no polar data enters this repository.
 */
export const INVENTED_POLAR_ENTRY: DeepPolarsEntry = {
  format: 'deepregatta-polars/1', id: 'invented-cruiser', label: 'Invented cruiser (formula)', kind: 'type',
  source: { id: 'synthetic', name: 'Synthetic' },
  table: {
    twa_deg: POLAR_TWA,
    tws_kt: POLAR_TWS,
    speeds_kt: POLAR_ANGLE_FACTOR.map((factor) =>
      POLAR_TWS.map((tws) => Math.round(8.4 * (1 - Math.exp(-tws / 9)) * factor * 10) / 10)),
  },
};

// ------------------------------------------------------------------ tiles

/** Hourly 0 to 120 h, then three-hourly to 240 h: 161 steps, as the real weather layer. */
const WEATHER_OFFSETS = [...Array.from({ length: 121 }, (_, h) => h), ...Array.from({ length: 40 }, (_, k) => 123 + 3 * k)];
const H3_OFFSETS = Array.from({ length: 81 }, (_, k) => 3 * k);
/** 3 h to 144 h, then 6 h to 240 h. */
const ECMWF_OFFSETS = [0, ...Array.from({ length: 48 }, (_, k) => 3 * (k + 1)), ...Array.from({ length: 16 }, (_, k) => 150 + 6 * k)];
/** 3 h to 144 h, then 6 h to 384 h: 89 steps. */
const ENSEMBLE_OFFSETS = [0, ...Array.from({ length: 48 }, (_, k) => 3 * (k + 1)), ...Array.from({ length: 40 }, (_, k) => 150 + 6 * k)];
const WAVE_OFFSETS = Array.from({ length: 129 }, (_, k) => 3 * k);
const CURRENT_OFFSETS = Array.from({ length: 41 }, (_, k) => 6 * k);
export const MEMBERS = 31;

const at = (g: { lat0: number; lon0: number; dlat: number; dlon: number }, i: number, j: number) => ({ lat: g.lat0 + i * g.dlat, lon: g.lon0 + j * g.dlon });
const variable = (name: string, axis: string, dtype: 'i16' | 'i8', scale: number, value: FixtureVariable['value'], per_member = false): FixtureVariable =>
  ({ name, axis, dtype, scale, value, ...(per_member ? { per_member } : {}) });

/**
 * The tiles of one run of every layer the planner reads (weather, ECMWF,
 * ensemble, waves, currents) over the two 10 degree tiles that hold all the
 * passages above: N40W010 and N50W010. Sizes follow the real layers.
 */
export function perfLayerSpecs(residual = { u: 0, v: 0 }): FixtureLayerSpec[] {
  const tiles: Array<[number, number]> = [[40, -10], [50, -10]];
  const w = (offsets: number[], pick: 'u' | 'v' | 'speed', gain = 1) => (_m: number, t: number, i: number, j: number, g: FixtureTileGrid) => {
    const p = at(g, i, j);
    return gain * windUV(p.lat, p.lon, offsets[t]!)[pick];
  };
  return [
    {
      layer: 'weather', model: 'gfs_0p25', cycle: CYCLE, resolution_deg: 0.25, tiles,
      time_axes: { hourly: { base: CYCLE, offsets_h: WEATHER_OFFSETS }, h3: { base: CYCLE, offsets_h: H3_OFFSETS } },
      variables: [
        variable('wind_u_kt', 'hourly', 'i16', 0.01, w(WEATHER_OFFSETS, 'u')),
        variable('wind_v_kt', 'hourly', 'i16', 0.01, w(WEATHER_OFFSETS, 'v')),
        variable('gust_kt', 'hourly', 'i16', 0.1, w(WEATHER_OFFSETS, 'speed', 1.35)),
        variable('visibility_m', 'h3', 'i16', 50, () => 10000),
        variable('cape_jkg', 'h3', 'i16', 1, () => 50),
        variable('temp_c', 'h3', 'i16', 0.1, () => 15),
        variable('dew_point_c', 'h3', 'i16', 0.1, () => 10),
        variable('precip_mm', 'h3', 'i16', 0.1, () => 0),
      ],
    },
    {
      layer: 'weather-ecmwf', model: 'ecmwf_ifs025', cycle: CYCLE, resolution_deg: 0.25, tiles,
      time_axes: { steps: { base: CYCLE, offsets_h: ECMWF_OFFSETS } },
      variables: [
        variable('wind_u_kt', 'steps', 'i16', 0.01, (m, t, i, j, g) => w(ECMWF_OFFSETS, 'u', 1.05)(m, t, i, j, g)),
        variable('wind_v_kt', 'steps', 'i16', 0.01, (m, t, i, j, g) => w(ECMWF_OFFSETS, 'v', 1.05)(m, t, i, j, g)),
        variable('gust_kt', 'steps', 'i16', 0.1, (m, t, i, j, g) => w(ECMWF_OFFSETS, 'speed', 1.4)(m, t, i, j, g)),
      ],
    },
    {
      layer: 'ensemble', model: 'gefs_0p50', cycle: CYCLE, resolution_deg: 0.5, member_count: MEMBERS, tiles,
      time_axes: { steps: { base: CYCLE, offsets_h: ENSEMBLE_OFFSETS } },
      variables: [
        variable('wind_kt_mean', 'steps', 'i16', 0.01, w(ENSEMBLE_OFFSETS, 'speed')),
        variable('wind_kt_anom', 'steps', 'i8', 0.2, (m, t) => (m - 15) * 0.3 * (1 + t / 60), true),
        variable('gust_kt_mean', 'steps', 'i16', 0.01, w(ENSEMBLE_OFFSETS, 'speed', 1.35)),
        variable('gust_kt_anom', 'steps', 'i8', 0.2, (m, t) => (m - 15) * 0.4 * (1 + t / 60), true),
      ],
    },
    {
      layer: 'waves', model: 'gfs_wave_0p25', cycle: CYCLE, resolution_deg: 0.25, tiles,
      time_axes: { steps: { base: CYCLE, offsets_h: WAVE_OFFSETS } },
      variables: [
        ...['hs_m', 'wind_wave_h_m', 'swell_h_m'].map((name, k) =>
          variable(name, 'steps', 'i16', 0.01, (_m, t, i, j, g) => {
            const p = at(g, i, j);
            return (0.4 + 0.08 * windUV(p.lat, p.lon, WAVE_OFFSETS[t]!).speed) * (1 - 0.2 * k);
          })),
        ...['period_s', 'wind_wave_period_s', 'swell_period_s'].map((name) => variable(name, 'steps', 'i16', 0.1, () => 7)),
        ...['dir_deg', 'wind_wave_dir_deg', 'swell_dir_deg'].map((name) => variable(name, 'steps', 'i16', 0.1, () => 250)),
      ],
    },
    {
      layer: 'currents', model: 'cmems_glo12', cycle: CYCLE, resolution_deg: 1 / 12, tiles,
      time_axes: { h6: { base: CYCLE, offsets_h: CURRENT_OFFSETS } },
      variables: [
        variable('cur_u_kt', 'h6', 'i16', 0.01, (_m, t, i, j, g) => { const p = at(g, i, j); return currentAt(p.lat, p.lon, CURRENT_OFFSETS[t]!, residual).u; }),
        variable('cur_v_kt', 'h6', 'i16', 0.01, (_m, t, i, j, g) => { const p = at(g, i, j); return currentAt(p.lat, p.lon, CURRENT_OFFSETS[t]!, residual).v; }),
      ],
    },
  ];
}

/** One in-memory run of every layer. Building it takes a few seconds: it encodes and compresses the tiles. */
export function buildPerfTransport(residual = { u: 0, v: 0 }) {
  return buildFixtureRun(perfLayerSpecs(residual), NOW_ISO);
}

// -------------------------------------------------------- prepared current

/**
 * A prepared current grid as the Python factory publishes it for a region:
 * hourly, 0.0556 degree (IBI, stride 2), 121 steps from its base, the shape
 * of the prepared IBI current_grid.json files under data/processed/runs (24 x 69
 * for the English Channel). `box` is the area it covers; `hours` its length from `base`.
 */
export function preparedCurrentGrid(opts: {
  box: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  baseIso: string;
  hours?: number;
  /** grid spacing, degrees; default the IBI stride-2 spacing */
  step?: number;
  residual?: { u: number; v: number };
}): RegionGrid {
  const step = opts.step ?? 0.0555572509765625;
  const hours = opts.hours ?? 120;
  const nlat = Math.floor((opts.box.maxLat - opts.box.minLat) / step) + 1;
  const nlon = Math.floor((opts.box.maxLon - opts.box.minLon) / step) + 1;
  const baseMs = Date.parse(opts.baseIso);
  const time_axis = Array.from({ length: hours + 1 }, (_, h) => new Date(baseMs + h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const u: number[] = [];
  const v: number[] = [];
  for (let h = 0; h <= hours; h++) {
    for (let i = 0; i < nlat; i++) {
      for (let j = 0; j < nlon; j++) {
        const c = currentAt(opts.box.minLat + i * step, opts.box.minLon + j * step, (baseMs - Date.parse(CYCLE)) / 3600_000 + h, opts.residual);
        u.push(Math.round(c.u * 100) / 100);
        v.push(Math.round(c.v * 100) / 100);
      }
    }
  }
  return {
    schema_version: 1, kind: 'surface_current', run_id: 'perf-prepared-current', generated_at: opts.baseIso,
    lat0: opts.box.minLat, lon0: opts.box.minLon, dlat: step, dlon: step, nlat, nlon,
    time_axis, u_kt: u, v_kt: v,
    under_resolved_note: 'stride-subsampled x2 from native 0.0278 deg to 0.0556 deg (target 0.05 deg); values are exact native cell values, no smoothing',
    source: { mode: 'live', dataset_id: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', resolution_deg: 0.027, fetched_at: opts.baseIso },
  };
}
