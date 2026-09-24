/**
 * Planner GRIB export (docs/grib-export.md → Planner defaults): the route
 * area, window and step defaults, the plan against the pinned forecast store,
 * the run, and the Save links. The engine plans and encodes; this module
 * owns the viewer's choices and formatting.
 */

import {
  GRIB_DATASETS,
  gribExportSourceFromStore,
  planGribExport,
  runGribExport,
  toIso,
} from '@deepweather/engine';
import { FORECAST_BASE_URL } from './forecastConfig.js';
import { fmtTime } from './format.js';

export const GRIB_MARGIN_DEFAULT_DEG = 1;
export const GRIB_MARGIN_OPTIONS = Array.from({ length: 11 }, (_, i) => i / 2);
export const GRIB_STEPS = ['all', 3, 6];
export const GRIB_DATASET_IDS = GRIB_DATASETS.map((dataset) => dataset.id);
export const GRIB_DEFAULT_DATASETS = ['wind-gfs'];
/** ETA when neither a drawn route with speeds nor a computed route gives one */
export const GRIB_FALLBACK_ETA_H = 48;
/** hours of forecast kept after the estimated arrival */
export const GRIB_WINDOW_TAIL_H = 24;
/** Hard stop until Phase 3's size guardrails: the tab holds every cube in memory. */
export const GRIB_MAX_EST_BYTES = 200_000_000;
/** Regional models: unpublished tiles in the box are outside the model domain. */
export const GRIB_REGIONAL_DATASETS = new Set(['currents-ibi']);
export const GRIB_LON_STORAGE_KEY = 'deepweather.gribLonConvention';
const LON_CONVENTIONS = ['0-360', 'signed'];
const HOUR_MS = 3_600_000;

/** Tiles from the local warehouse (dev) are a fixture, not the live runs. */
export const GRIB_TILES_ARE_FIXTURE = !/^https:\/\//.test(FORECAST_BASE_URL);

const finitePoint = (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon);
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * The points that define the export: the drawn waypoints, or in compute mode
 * the computed route, else the two endpoints. Null when there is no route yet.
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

/** The points' bounding box ± margin, clamped to the globe. */
export function gribBbox(points, marginDeg = GRIB_MARGIN_DEFAULT_DEG) {
  if (!points?.length) return null;
  const margin = normalizeGribMargin(marginDeg);
  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  return {
    minLat: clamp(Math.min(...lats) - margin, -90, 90),
    maxLat: clamp(Math.max(...lats) + margin, -90, 90),
    minLon: clamp(Math.min(...lons) - margin, -180, 180),
    maxLon: clamp(Math.max(...lons) + margin, -180, 180),
  };
}

/** 0–5° in 0.5° steps; anything else falls back to the default. */
export function normalizeGribMargin(value) {
  const margin = Number(value);
  if (!Number.isFinite(margin)) return GRIB_MARGIN_DEFAULT_DEG;
  return Math.min(5, Math.max(0, Math.round(margin * 2) / 2));
}

/** Passage duration: distance / speeds.slow (draw), the computed duration (compute), else 48 h. */
export function gribEtaHours({ mode, distance, speeds, computed }) {
  if (mode === 'compute') {
    const hours = computed?.duration_h;
    return Number.isFinite(hours) && hours > 0 ? hours : GRIB_FALLBACK_ETA_H;
  }
  const slow = speeds?.slow;
  if (Number.isFinite(distance) && distance > 0 && Number.isFinite(slow) && slow > 0) return distance / slow;
  return GRIB_FALLBACK_ETA_H;
}

/**
 * From max(departure, now), floored to the hour, to that plus the ETA plus
 * 24 h (rounded up to the hour). Each dataset is then clipped to its own
 * horizon by the plan.
 */
export function gribWindow({ departureUtc, etaHours, nowMs }) {
  const departureMs = departureUtc ? Date.parse(departureUtc) : NaN;
  const from = Number.isFinite(departureMs) ? Math.max(departureMs, nowMs) : nowMs;
  const startMs = Math.floor(from / HOUR_MS) * HOUR_MS;
  const hours = Math.ceil((Number.isFinite(etaHours) && etaHours > 0 ? etaHours : GRIB_FALLBACK_ETA_H) + GRIB_WINDOW_TAIL_H);
  return { startIso: toIso(startMs), endIso: toIso(startMs + hours * HOUR_MS) };
}

/**
 * Longitude convention for the Adrena test: `#plan/planner?gribLon=signed`
 * switches it, `?gribLon=0-360` resets it. Remembered in localStorage because
 * in-app navigation drops the hash query. Phase 3 settles one convention.
 */
export function gribLonConvention(hash = globalThis.location?.hash ?? '') {
  const requested = new URLSearchParams(hash.split('?')[1] ?? '').get('gribLon');
  if (LON_CONVENTIONS.includes(requested)) {
    try {
      if (requested === 'signed') localStorage.setItem(GRIB_LON_STORAGE_KEY, requested);
      else localStorage.removeItem(GRIB_LON_STORAGE_KEY);
    } catch {
      // Storage can be unavailable in privacy-restricted contexts; the URL still wins.
    }
    return requested;
  }
  try {
    const saved = localStorage.getItem(GRIB_LON_STORAGE_KEY);
    if (LON_CONVENTIONS.includes(saved)) return saved;
  } catch {
    // fall through to the default
  }
  return '0-360';
}

/** Load the pinned runs (latest.json + manifests); resolves to a manifest lookup. */
export async function loadGribManifests(store) {
  await store.init();
  return (layer) => store.manifestFor(layer);
}

/** Plan every dataset, so the UI can show each one's availability. */
export function planRouteGrib(manifests, { bbox, window, step, lonConvention, points, fixture = GRIB_TILES_ARE_FIXTURE }) {
  const checkpoints = points?.length ? [points[0], points[points.length - 1]] : [];
  return planGribExport(manifests, {
    bbox,
    datasetIds: GRIB_DATASET_IDS,
    startIso: window.startIso,
    endIso: window.endIso,
    step,
    lonConvention,
    checkpoints: checkpoints.map(({ lat, lon }) => ({ lat, lon })),
    fixture,
  });
}

/** Viewer notes per planned dataset: time range, horizon and coverage. */
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
    partial: GRIB_REGIONAL_DATASETS.has(dataset.datasetId) && dataset.tiles.some((tile) => !tile.present),
  };
}

/** The plan restricted to the ticked, available datasets. */
export function selectedGribPlan(plan, selected) {
  return {
    ...plan,
    datasets: plan.datasets.filter((dataset) => selected.has(dataset.datasetId) && dataset.availability === 'ok'),
  };
}

export function gribEstimatedBytes(plan) {
  return plan.datasets.reduce((sum, dataset) => sum + dataset.estBytes, 0);
}

/** Run the export against the pinned store (tiles are read without evicting the analysis's). */
export function runRouteGrib(store, plan, { signal, onProgress } = {}) {
  return runGribExport(gribExportSourceFromStore(store), plan, { signal, onProgress });
}

/** Blob URLs for the Save links; revoke them with revokeGribFiles. */
export function gribFilesWithUrls(files) {
  return files.map(({ parts, ...file }) => ({
    ...file,
    url: URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' })),
  }));
}

export function revokeGribFiles(files) {
  for (const file of files ?? []) {
    if (file.url) URL.revokeObjectURL(file.url);
  }
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
  return `This forecast ends ${fmtTime(lastIso)} UTC, before the end of your window.`;
}

export function fmtTooLarge(bytes) {
  return `These files would be about ${fmtGribBytes(bytes)}, over the 200 MB limit. Choose a coarser time step, a smaller margin or fewer datasets.`;
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

export function fmtLonConvention(convention) {
  return convention === 'signed' ? '−180…180°' : '0…360°';
}
