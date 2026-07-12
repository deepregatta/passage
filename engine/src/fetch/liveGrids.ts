import { haversineNm } from '../geo.js';
import type { RegionGrid } from '../grids.js';
import {
  fetchCurrentForecasts,
  fetchPointForecasts,
  type CurrentPointForecast,
  type OpenMeteoOptions,
  type PointForecast,
} from './openMeteo.js';

export interface RouteBbox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface GridPlan extends RouteBbox {
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
  points: Array<{ lat: number; lon: number }>;
  under_resolved_note?: string;
}

const TIDY_STEPS = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1.0];
const HOUR_MS = 3600_000;

function assertBbox(bbox: RouteBbox): void {
  if (
    bbox.minLat > bbox.maxLat ||
    bbox.minLon > bbox.maxLon ||
    bbox.minLon < -180 ||
    bbox.maxLon > 180 ||
    bbox.maxLon - bbox.minLon > 180
  ) {
    throw new Error('Antimeridian-crossing routes are not supported yet');
  }
}

export function routeBbox(
  start: { lat: number; lon: number },
  finish: { lat: number; lon: number },
): RouteBbox {
  if (Math.abs(finish.lon - start.lon) > 180) {
    throw new Error('Antimeridian-crossing routes are not supported yet');
  }
  const latSpan = Math.abs(finish.lat - start.lat);
  const lonSpan = Math.abs(finish.lon - start.lon);
  const latPad = Math.max(0.5, 0.25 * latSpan);
  const lonPad = Math.max(0.5, 0.25 * lonSpan);
  return {
    minLat: Math.max(-90, Math.min(start.lat, finish.lat) - latPad),
    maxLat: Math.min(90, Math.max(start.lat, finish.lat) + latPad),
    minLon: Math.max(-180, Math.min(start.lon, finish.lon) - lonPad),
    maxLon: Math.min(180, Math.max(start.lon, finish.lon) + lonPad),
  };
}

export function passageMaxHours(
  start: { lat: number; lon: number },
  finish: { lat: number; lon: number },
): number {
  const estimate = Math.ceil(haversineNm(start.lat, start.lon, finish.lat, finish.lon) / 4);
  return Math.max(48, Math.min(240, estimate));
}

export function planGrid(
  bbox: RouteBbox,
  options: { targetPoints?: number; maxResolutionDeg?: number; minResolutionDeg?: number } = {},
): GridPlan {
  assertBbox(bbox);
  const target = options.targetPoints ?? 200;
  const minRes = options.minResolutionDeg ?? 0.15;
  const maxRes = options.maxResolutionDeg ?? 1.0;
  const candidates = TIDY_STEPS.filter((step) => step >= minRes && step <= maxRes);
  if (!candidates.length) throw new Error('No supported grid resolution in the requested range');

  let chosen: { step: number; nlat: number; nlon: number } | null = null;
  for (const step of candidates) {
    const nlat = Math.max(2, Math.ceil((bbox.maxLat - bbox.minLat) / step) + 1);
    const nlon = Math.max(2, Math.ceil((bbox.maxLon - bbox.minLon) / step) + 1);
    if (nlat * nlon <= target) {
      chosen = { step, nlat, nlon };
      break;
    }
  }
  if (!chosen) {
    throw new Error('This passage area is too large for live routing; choose a shorter crossing');
  }

  // Anchor at the upper bounds so the regular lattice covers the requested
  // box without producing invalid coordinates above 90°/180°.
  const lat0 = bbox.maxLat - (chosen.nlat - 1) * chosen.step;
  const lon0 = bbox.maxLon - (chosen.nlon - 1) * chosen.step;
  const points: Array<{ lat: number; lon: number }> = [];
  for (let i = 0; i < chosen.nlat; i++) {
    const lat = lat0 + i * chosen.step;
    for (let j = 0; j < chosen.nlon; j++) {
      const lon = lon0 + j * chosen.step;
      points.push({ lat, lon });
    }
  }
  return {
    ...bbox,
    lat0,
    lon0,
    dlat: chosen.step,
    dlon: chosen.step,
    nlat: chosen.nlat,
    nlon: chosen.nlon,
    points,
    under_resolved_note:
      chosen.step > 0.25
        ? `Forecast grid coarsened to ${chosen.step}° to keep this crossing within the browser point budget.`
        : undefined,
  };
}

interface BuildGridRequest {
  bbox: RouteBbox;
  startIso: string;
  hours: number;
  options?: OpenMeteoOptions;
  planOptions?: { targetPoints?: number; maxResolutionDeg?: number; minResolutionDeg?: number };
}

function isoHour(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function dateOnly(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function vector(speed: number | null, direction: number | null, from: boolean): [number | null, number | null] {
  if (speed === null || direction === null || !Number.isFinite(speed) || !Number.isFinite(direction)) {
    return [null, null];
  }
  const rad = direction * Math.PI / 180;
  const sign = from ? -1 : 1;
  const u = sign * speed * Math.sin(rad);
  const v = sign * speed * Math.cos(rad);
  return [Math.abs(u) < 1e-12 ? 0 : u, Math.abs(v) < 1e-12 ? 0 : v];
}

function selectSeries(
  times: string[],
  valuesA: Array<number | null>,
  valuesB: Array<number | null>,
  axis: string[],
): Array<[number | null, number | null]> {
  const index = new Map(times.map((time, i) => [Date.parse(time), i]));
  return axis.map((time) => {
    const idx = index.get(Date.parse(time));
    if (idx === undefined) throw new Error(`Open-Meteo response is missing ${time}`);
    return [valuesA[idx] ?? null, valuesB[idx] ?? null];
  });
}

async function batches<T>(
  points: Array<{ lat: number; lon: number }>,
  fetchBatch: (batch: Array<{ lat: number; lon: number }>) => Promise<T[]>,
): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; offset < points.length; offset += 50) {
    result.push(...await fetchBatch(points.slice(offset, offset + 50)));
  }
  return result;
}

function baseGrid(plan: GridPlan, axis: string[], kind: RegionGrid['kind'], dataset: string): RegionGrid {
  return {
    schema_version: 1,
    kind,
    run_id: `live-${kind}-${axis[0]}`,
    generated_at: new Date().toISOString(),
    lat0: plan.lat0,
    lon0: plan.lon0,
    dlat: plan.dlat,
    dlon: plan.dlon,
    nlat: plan.nlat,
    nlon: plan.nlon,
    time_axis: axis,
    u_kt: [],
    v_kt: [],
    under_resolved_note: plan.under_resolved_note,
    source: { mode: 'live', dataset_id: dataset, resolution_deg: plan.dlat, fetched_at: new Date().toISOString() },
  };
}

function timeWindow(startIso: string, hours: number): { start: number; axis: string[]; startDate: string; endDate: string } {
  const parsed = Date.parse(startIso);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid departure time: ${startIso}`);
  const start = Math.floor(parsed / HOUR_MS) * HOUR_MS;
  const count = Math.ceil(hours) + 1;
  const axis = Array.from({ length: count }, (_, i) => isoHour(start + i * HOUR_MS));
  return { start, axis, startDate: dateOnly(start), endDate: dateOnly(start + (count - 1) * HOUR_MS) };
}

export async function buildWindGrid(request: BuildGridRequest): Promise<RegionGrid> {
  const plan = planGrid(request.bbox, request.planOptions);
  const window = timeWindow(request.startIso, request.hours);
  const forecasts = await batches<PointForecast>(plan.points, async (batch) =>
    (await fetchPointForecasts(batch, window.startDate, window.endDate, request.options)).forecasts,
  );
  const grid = baseGrid(plan, window.axis, 'wind10m', request.options?.model ?? 'ecmwf_ifs025');
  const perPoint = forecasts.map((forecast) =>
    selectSeries(forecast.times, forecast.wind_kt, forecast.wind_dir_deg, window.axis)
      .map(([speed, direction]) => vector(speed, direction, true)),
  );
  for (let t = 0; t < window.axis.length; t++) {
    for (let p = 0; p < plan.points.length; p++) {
      const [u, v] = perPoint[p]![t]!;
      if (u === null || v === null) throw new Error(`Wind forecast contains a gap at ${window.axis[t]}`);
      grid.u_kt.push(u);
      grid.v_kt.push(v);
    }
  }
  return grid;
}

function fillCurrentStep(
  u: Array<number | null>,
  v: Array<number | null>,
  nlat: number,
  nlon: number,
): { u: number[]; v: number[]; zeroed: number } {
  const outU = new Array<number>(u.length);
  const outV = new Array<number>(v.length);
  let zeroed = 0;
  for (let p = 0; p < u.length; p++) {
    if (u[p] !== null && v[p] !== null) {
      outU[p] = u[p]!;
      outV[p] = v[p]!;
      continue;
    }
    const i = Math.floor(p / nlon);
    const j = p % nlon;
    let best: { p: number; d2: number } | null = null;
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || ii >= nlat || jj < 0 || jj >= nlon) continue;
        const q = ii * nlon + jj;
        if (u[q] === null || v[q] === null) continue;
        const d2 = di * di + dj * dj;
        if (!best || d2 < best.d2) best = { p: q, d2 };
      }
    }
    if (best) {
      outU[p] = u[best.p]!;
      outV[p] = v[best.p]!;
    } else {
      outU[p] = 0;
      outV[p] = 0;
      zeroed++;
    }
  }
  return { u: outU, v: outV, zeroed };
}

export async function buildCurrentGrid(request: BuildGridRequest): Promise<RegionGrid | null> {
  try {
    const plan = planGrid(request.bbox, request.planOptions);
    const window = timeWindow(request.startIso, request.hours);
    const forecasts = await batches<CurrentPointForecast>(plan.points, async (batch) =>
      (await fetchCurrentForecasts(batch, window.startDate, window.endDate, request.options)).forecasts,
    );
    const grid = baseGrid(plan, window.axis, 'surface_current', 'open-meteo-marine-best-match');
    const perPoint = forecasts.map((forecast) =>
      selectSeries(forecast.times, forecast.current_kt, forecast.current_dir_deg, window.axis)
        .map(([speed, direction]) => vector(speed, direction, false)),
    );
    let heavilyZeroFilled = false;
    for (let t = 0; t < window.axis.length; t++) {
      const u: Array<number | null> = [];
      const v: Array<number | null> = [];
      for (let p = 0; p < plan.points.length; p++) {
        const pair = perPoint[p]![t]!;
        u.push(pair[0]);
        v.push(pair[1]);
      }
      const filled = fillCurrentStep(u, v, plan.nlat, plan.nlon);
      grid.u_kt.push(...filled.u);
      grid.v_kt.push(...filled.v);
      if (filled.zeroed > plan.points.length / 2) heavilyZeroFilled = true;
    }
    if (heavilyZeroFilled) {
      const note = 'More than half of at least one current time step had no nearby data and was filled with zero current.';
      grid.under_resolved_note = [grid.under_resolved_note, note].filter(Boolean).join(' ');
    }
    return grid;
  } catch {
    return null;
  }
}
