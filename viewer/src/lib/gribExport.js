/**
 * GRIB files page (docs/grib-export.md → GRIB files page): the drawn area,
 * the period, the model each file kind uses, the plan against the pinned
 * forecast store, the run, and the downloads. The engine plans and encodes;
 * this module owns the viewer's choices and formatting.
 */

import {
  GRIB_DATASETS,
  cycleHourLabel,
  gribExportSourceFromStore,
  parseUtc,
  planGribExport,
  runGribExport,
  toIso,
} from '@deepweather/engine';
import { FORECAST_BASE_URL } from './forecastConfig.js';
import { refreshForecastIfStale } from './forecastFreshness.js';
import { fmtTime } from './format.js';

/** Margin around a planner route when it opens the GRIB page. */
export const GRIB_ROUTE_MARGIN_DEG = 1;
export const GRIB_STEPS = ['all', 3, 6];
/** Days from now, or `full`: to the end of every pinned forecast. */
export const GRIB_PERIODS = ['1', '2', '3', '5', '7', 'full'];
export const GRIB_DEFAULT_PERIOD = '3';
export const GRIB_DATASET_IDS = GRIB_DATASETS.map((dataset) => dataset.id);
/**
 * One file per kind. Each kind lists its models; gribModelOrder puts the
 * local model for the area first.
 */
export const GRIB_KINDS = [
  { id: 'wind', datasets: ['wind-ecmwf', 'wind-gfs'] },
  { id: 'currents', datasets: ['currents-ibi', 'currents-global'] },
  { id: 'waves', datasets: ['waves-gfs'] },
];
/** Where ECMWF, the European centre's model, is the local wind model. */
export const GRIB_EUROPE = { minLat: 25, maxLat: 72, minLon: -35, maxLon: 45 };
/** The tab holds every cube of a file in memory. */
export const GRIB_MAX_EST_BYTES = 200_000_000;
/** Regional models: unpublished tiles in the box are outside the model domain. */
export const GRIB_REGIONAL_DATASETS = new Set(['currents-ibi']);
/** Drawn boxes snap outward to this grid and are never smaller than the minimum span. */
const AREA_SNAP_DEG = 0.1;
const AREA_MIN_SPAN_DEG = 0.25;
const HOUR_MS = 3_600_000;

/** Tiles from the local warehouse (dev) are a fixture, not the live runs. */
export const GRIB_TILES_ARE_FIXTURE = !/^https:\/\//.test(FORECAST_BASE_URL);

const finitePoint = (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon);
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
// one decimal of the snap grid, without float noise such as 49.300000000000004
const tidy = (value) => Math.round(value * 1e6) / 1e6;

/**
 * The points of a planner route: the drawn waypoints, or in compute mode the
 * computed route, else the two endpoints. Null when there is no route yet.
 */
export function gribRoutePoints({ mode, waypoints = [], computed = null, endpoints = [] }) {
  const fromLatLng = (list) => list.map(({ lat, lng }) => ({ lat, lon: wrapLon(lng) }));
  let points = null;
  if (mode === 'compute') {
    if (computed?.route?.waypoints?.length >= 2) {
      points = computed.route.waypoints.map(({ lat, lon }) => ({ lat, lon: wrapLon(lon) }));
    } else if (endpoints.length === 2) {
      points = fromLatLng(endpoints);
    }
  } else if (waypoints.length >= 2) {
    points = fromLatLng(waypoints);
  }
  return points?.every(finitePoint) ? points : null;
}

/**
 * A GRIB area from any two opposite corners: snapped outward to 0.1°, at
 * least 0.25° on each side, clamped to the globe. Longitudes are clamped,
 * not wrapped, so a box never crosses the 180° meridian.
 */
export function gribArea(a, b) {
  const lats = [a.lat, b.lat];
  const lons = [a.lon, b.lon];
  if (![...lats, ...lons].every(Number.isFinite)) return null;
  const snapDown = (v) => tidy(Math.floor(tidy(v / AREA_SNAP_DEG)) * AREA_SNAP_DEG);
  const snapUp = (v) => tidy(Math.ceil(tidy(v / AREA_SNAP_DEG)) * AREA_SNAP_DEG);
  const span = (lo, hi, min, max) => {
    let from = snapDown(clamp(lo, min, max));
    let to = snapUp(clamp(hi, min, max));
    if (to - from < AREA_MIN_SPAN_DEG) {
      const centre = (from + to) / 2;
      from = snapDown(clamp(centre - AREA_MIN_SPAN_DEG / 2, min, max - AREA_MIN_SPAN_DEG));
      to = snapUp(from + AREA_MIN_SPAN_DEG);
    }
    return [from, to];
  };
  const [minLat, maxLat] = span(Math.min(...lats), Math.max(...lats), -90, 90);
  const [minLon, maxLon] = span(Math.min(...lons), Math.max(...lons), -180, 180);
  return { minLat, maxLat, minLon, maxLon };
}

/** A planner route's box ± the route margin. */
export function gribRouteArea(points, marginDeg = GRIB_ROUTE_MARGIN_DEG) {
  if (!points?.length) return null;
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  return gribArea(
    { lat: Math.min(...lats) - marginDeg, lon: Math.min(...lons) - marginDeg },
    { lat: Math.max(...lats) + marginDeg, lon: Math.max(...lons) + marginDeg },
  );
}

/** A stored or linked area, or null when it is not a valid box. */
export function validGribArea(area) {
  if (!area || typeof area !== 'object') return null;
  const { minLat, maxLat, minLon, maxLon } = area;
  if (![minLat, maxLat, minLon, maxLon].every(Number.isFinite)) return null;
  if (minLat >= maxLat || minLon >= maxLon) return null;
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) return null;
  return { minLat, maxLat, minLon, maxLon };
}

/** `#plan/grib?area=S,N,W,E`: a bookmarkable area. */
export function gribAreaFromHash(hash = globalThis.location?.hash ?? '') {
  const value = new URLSearchParams(hash.split('?')[1] ?? '').get('area');
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 4) return null;
  const [minLat, maxLat, minLon, maxLon] = parts;
  return validGribArea({ minLat, maxLat, minLon, maxLon });
}

export function gribAreaHash(area) {
  const valid = validGribArea(area);
  if (!valid) return 'plan/grib';
  const { minLat, maxLat, minLon, maxLon } = valid;
  return `plan/grib?area=${[minLat, maxLat, minLon, maxLon].map((v) => tidy(v)).join(',')}`;
}

export function normalizeGribPeriod(value) {
  return GRIB_PERIODS.includes(String(value)) ? String(value) : GRIB_DEFAULT_PERIOD;
}

/**
 * From now, floored to the hour, for the period's days, or with `full` to the
 * last step of the longest pinned forecast (`forecastEndIso`, see
 * gribForecastEnd). Each dataset is then clipped to its own horizon by the plan.
 */
export function gribPeriodWindow({ period, nowMs, forecastEndIso = null }) {
  const startMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const chosen = normalizeGribPeriod(period);
  if (chosen === 'full' && forecastEndIso) {
    return { startIso: toIso(startMs), endIso: toIso(Math.max(startMs, parseUtc(forecastEndIso))) };
  }
  const days = chosen === 'full' ? Number(GRIB_DEFAULT_PERIOD) : Number(chosen);
  return { startIso: toIso(startMs), endIso: toIso(startMs + days * 24 * HOUR_MS) };
}

/**
 * The last forecast time any exportable dataset offers in the pinned runs:
 * the end of the time axes its registry variables use. Null when no dataset
 * has a run.
 */
export function gribForecastEnd(manifests) {
  let endMs = -Infinity;
  for (const spec of GRIB_DATASETS) {
    const manifest = manifests(spec.layer);
    if (!manifest) continue;
    const exported = new Set(spec.variables.map((variable) => variable.tileVar));
    const axes = new Set(manifest.variables.filter((v) => exported.has(v.name) && !v.per_member).map((v) => v.axis));
    for (const axis of axes) {
      const timeAxis = manifest.time_axes[axis];
      if (!timeAxis?.offsets_h.length) continue;
      endMs = Math.max(endMs, parseUtc(timeAxis.base) + Math.max(...timeAxis.offsets_h) * HOUR_MS);
    }
  }
  return Number.isFinite(endMs) ? toIso(endMs) : null;
}

/**
 * Load the pinned runs (latest.json + manifests), re-reading latest.json when
 * the last check is over 10 minutes old; resolves to a manifest lookup.
 */
export async function loadGribManifests(store) {
  await store.init();
  await refreshForecastIfStale({ store });
  return (layer) => store.manifestFor(layer);
}

/**
 * The pinned run ids of the exportable layers, ECMWF's 06Z/18Z one included:
 * a plan's key changes with them.
 */
export function gribRunIds(manifests) {
  const layers = GRIB_DATASETS.flatMap((spec) => [spec.layer, ...(spec.shortRangeLayers ?? [])]);
  return [...new Set(layers.map((layer) => manifests(layer)?.run_id).filter(Boolean))].sort();
}

const GRIB_RUN_NAMES = {
  'wind-arome': 'AROME',
  'wind-icon-eu': 'ICON-EU',
  'wind-ukv': 'UKV',
  'wind-gfs': 'GFS',
  'wind-ecmwf': 'ECMWF',
  'waves-gfs': 'GFS-Wave',
  'currents-global': 'GLO12',
  'currents-ibi': 'IBI',
};

/**
 * The run a file was read from, as sailors name it: "ECMWF 06Z". An ECMWF
 * file holds one run, the newest that covers the whole period (06Z/18Z ones
 * reach 144 h, 00Z/12Z ones 240 h).
 */
export function gribRunLabel(file) {
  return `${GRIB_RUN_NAMES[file.datasetId] ?? file.model} ${cycleHourLabel(file.cycle)}`;
}

/** A model's short name on the page's model picker. */
export function gribModelName(datasetId) {
  return datasetId === 'currents-global' ? 'Global' : GRIB_RUN_NAMES[datasetId] ?? datasetId;
}

/** A model's grid spacing in the pinned run, as "3.1 km"; null without a run. */
export function gribModelSpacing(manifests, dataset) {
  const deg = manifests?.(dataset.spec.layer)?.resolution_deg;
  if (!deg) return null;
  const km = deg * 111.2;
  return `${km < 10 ? Math.round(km * 10) / 10 : Math.round(km)} km`;
}

/**
 * The longest period over which a model whose forecast ends too early becomes
 * available for this area, else null.
 */
export function gribPeriodFor(manifests, { area, step, nowMs, datasetId }) {
  const forecastEndIso = gribForecastEnd(manifests);
  for (const period of [...GRIB_PERIODS].reverse()) {
    const window = gribPeriodWindow({ period, nowMs, forecastEndIso });
    const dataset = planAreaGrib(manifests, { area, window, step }).datasets.find((d) => d.datasetId === datasetId);
    if (dataset?.availability === 'ok') return period;
  }
  return null;
}

/** Plan every dataset, so the page can show each model's availability. */
export function planAreaGrib(manifests, { area, window, step, fixture = GRIB_TILES_ARE_FIXTURE }) {
  const centre = { lat: (area.minLat + area.maxLat) / 2, lon: (area.minLon + area.maxLon) / 2 };
  return planGribExport(manifests, {
    bbox: area,
    datasetIds: GRIB_DATASET_IDS,
    startIso: window.startIso,
    endIso: window.endIso,
    step,
    lonConvention: '0-360',
    checkpoints: [centre],
    fixture,
  });
}

/** A regional dataset some of whose tiles in the box are unpublished (outside its domain). */
export function gribPartial(dataset) {
  return GRIB_REGIONAL_DATASETS.has(dataset.datasetId) && dataset.tiles.some((tile) => !tile.present);
}

/**
 * The distinct windows (h) of a planned file's gust when it is written as a
 * maximum over the hours before each step (ECMWF), else none.
 */
export function gribGustWindows(dataset) {
  const index = dataset.variables.findIndex((variable) => variable.tileVar === 'gust_kt' && variable.statistic);
  const windows = index < 0 ? null : dataset.windowsH?.[index];
  return windows ? [...new Set(windows.filter((w) => w !== null))].sort((a, b) => a - b) : [];
}

/** Page notes per planned dataset: time range, horizon, coverage and gust windows. */
export function describeGribDataset(dataset, window) {
  const ok = dataset.availability === 'ok';
  const first = ok ? dataset.steps[0]?.time ?? null : null;
  const last = ok ? dataset.steps[dataset.steps.length - 1]?.time ?? null : null;
  return {
    ok,
    first,
    last,
    steps: ok ? dataset.steps.length : 0,
    horizonShort: ok && last !== null && Date.parse(last) < Date.parse(window.endIso),
    partial: gribPartial(dataset),
    gustWindows: ok ? gribGustWindows(dataset) : [],
  };
}

const insideBox = (box, lat, lon) => lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;

/**
 * A kind's models, the local one first: ECMWF for wind in Europe (GFS
 * elsewhere), the regional IBI model for currents wherever it exists.
 */
export function gribModelOrder(kindId, area, plan = null) {
  const kind = GRIB_KINDS.find((entry) => entry.id === kindId);
  if (!kind) return [];
  if (kindId !== 'wind') return [...kind.datasets];
  const regional = ['wind-arome', 'wind-icon-eu', 'wind-ukv'].filter((id) =>
    plan?.datasets.some((dataset) => dataset.datasetId === id && dataset.availability !== 'no-layer'));
  if (!area) return [...kind.datasets, ...regional];
  const lat = (area.minLat + area.maxLat) / 2;
  const lon = (area.minLon + area.maxLon) / 2;
  return [...(insideBox(GRIB_EUROPE, lat, lon) ? ['wind-ecmwf', 'wind-gfs'] : ['wind-gfs', 'wind-ecmwf']), ...regional];
}

/**
 * The planned dataset a kind downloads: the sailor's chosen model when it is
 * available here, else the first model in local-first order that covers the
 * whole area, else the first available one. With nothing available, the
 * preferred model, so the page can say why.
 */
export function gribKindDataset(plan, kindId, area, choice = null) {
  const byId = new Map(plan.datasets.map((dataset) => [dataset.datasetId, dataset]));
  const order = gribModelOrder(kindId, area, plan).filter((id) => byId.has(id));
  const usable = (id) => byId.get(id).availability === 'ok';
  if (choice && order.includes(choice) && usable(choice)) return byId.get(choice);
  const id = order.find((candidate) => usable(candidate) && !gribPartial(byId.get(candidate)))
    ?? order.find(usable)
    ?? order[0];
  return id ? byId.get(id) : null;
}

/** Run one dataset of the plan against the pinned store (tiles are read without evicting the analysis's). */
export async function runDatasetGrib(store, plan, dataset, { signal, onProgress } = {}) {
  const files = await runGribExport(gribExportSourceFromStore(store), { ...plan, datasets: [dataset] }, { signal, onProgress });
  return files[0];
}

/** A Blob URL for the file's download; revoke it with revokeGribFile. */
export function gribFileWithUrl({ parts, ...file }) {
  return { ...file, url: URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' })) };
}

export function revokeGribFile(file) {
  if (file?.url) URL.revokeObjectURL(file.url);
}

/** Start the browser download of a prepared file. */
export function saveGribFile(file) {
  const link = document.createElement('a');
  link.href = file.url;
  link.download = file.name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}

/** Low-cardinality size bucket for analytics. */
export function gribSizeBucket(bytes) {
  if (bytes < 1e6) return '0-1MB';
  if (bytes < 5e6) return '1-5MB';
  if (bytes < 20e6) return '5-20MB';
  if (bytes < 50e6) return '20-50MB';
  return '50MB+';
}

/** kB / MB, decimal, as the docs and file managers show them. */
export function fmtGribBytes(bytes) {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}

export function fmtUtc(iso) {
  return `${fmtTime(iso)} UTC`;
}

export function fmtUtcRange(startIso, endIso) {
  return `${fmtTime(startIso)} → ${fmtTime(endIso)} UTC`;
}

export function fmtGribSteps(count) {
  return count === 1 ? '1 step' : `${count} steps`;
}

export function fmtHorizonShort(lastIso) {
  return `This forecast ends ${fmtTime(lastIso)} UTC, before the end of your period.`;
}

/** Display the maximum windows declared by the selected forecast. */
export function fmtGustWindows(windows) {
  const list = windows.length > 1 ? `${windows.slice(0, -1).join(', ')} or ${windows.at(-1)}` : String(windows[0]);
  return `Gusts are the maximum over the ${list} h before each time, rather than instantaneous values.`;
}

export function fmtTooLarge(bytes) {
  return `This file would be about ${fmtGribBytes(bytes)}, over the 200 MB limit. Draw a smaller box or choose a shorter period.`;
}

const trimDeg = (value, digits) => String(Number(value.toFixed(digits)));

/** "49.65°N 1.62°W" */
export function fmtLatLon(lat, lon, digits = 2) {
  return `${trimDeg(Math.abs(lat), digits)}°${lat < 0 ? 'S' : 'N'} ${trimDeg(Math.abs(lon), digits)}°${lon < 0 ? 'W' : 'E'}`;
}

/** "48°N–51°N, 6°W–2°E" */
export function fmtGribArea(grid) {
  const lat = (v) => `${trimDeg(Math.abs(v), 3)}°${v < 0 ? 'S' : 'N'}`;
  const lon = (v) => `${trimDeg(Math.abs(v), 3)}°${v < 0 ? 'W' : 'E'}`;
  return `${lat(grid.south)}–${lat(grid.north)}, ${lon(grid.west)}–${lon(grid.east)}`;
}

/** A drawn area in the same notation as the file details. */
export function fmtGribBox(area) {
  return fmtGribArea({ south: area.minLat, north: area.maxLat, west: area.minLon, east: area.maxLon });
}

/** "33 × 13 points · 0.25°" (1/12° and 1/36° grids named as fractions) */
export function fmtGribGrid(grid) {
  const n = Math.round(10 / grid.step_deg);
  const step = Number.isInteger(1e4 / n) ? `${trimDeg(grid.step_deg, 3)}°` : `1/${n / 10}°`;
  return `${grid.ni} × ${grid.nj} points · ${step}`;
}

export function fmtGribCoverage(coverage) {
  return `${Math.round(coverage * 100)}%`;
}

/** Spot-value columns in the order the engine reports them (wind, currents, or the wave variables). */
export function gribSpotKeys(file) {
  return Object.keys(file.checkpoints[0]?.steps[0]?.values ?? {});
}
