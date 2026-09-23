/**
 * GRIB export dataset registry (docs/grib-export.md): which tile variables
 * each downloadable file carries, and the GRIB2 identification each one is
 * written with. Keys mirror NCEP's own GFS / GFS-Wave messages so apps that
 * read NOAA files recognise these; D is never coarser than the tile or the
 * provider original.
 */

import type { GribLevel } from './grib2.js';

/** Knots per m/s, the constant the tile pipeline converts with (forecast-tiles ingest/sources/base.py). */
export const MS_TO_KT = 1.943844;

export type GribDatasetId = 'wind-gfs' | 'wind-ecmwf' | 'waves-gfs' | 'currents-global' | 'currents-ibi';

export type GribDatasetKind = 'wind' | 'waves' | 'currents';

export interface GribVariableSpec {
  /** PFT1 tile variable */
  tileVar: string;
  /** NCEP short name, for inspection output only */
  shortName: string;
  discipline: number;
  category: number;
  number: number;
  level: GribLevel;
  /** decimal scale factor D */
  decimalScale: number;
  /** tile unit → GRIB output unit */
  convert: 'kt-to-ms' | 'none';
  outputUnit: 'm/s' | 'm' | 's' | 'deg';
  /** packed bits per value assumed by size estimates */
  estBits: number;
}

export interface GribDatasetSpec {
  id: GribDatasetId;
  layer: string;
  kind: GribDatasetKind;
  label: string;
  attribution: string;
  /** ocean-model currents disclosure; never suggest tidal-stream predictions */
  note?: string;
  centre: number;
  generatingProcess: number;
  /** land is missing, so messages carry a bitmap (size estimates count it) */
  hasLand: boolean;
  variables: readonly GribVariableSpec[];
}

const LEVEL_10M: GribLevel = { type: 103, value: 10 };
const SURFACE: GribLevel = { type: 1, value: 0 };
const WAVE_SURFACE: GribLevel = { type: 1, value: 1 };
const SWELL_1: GribLevel = { type: 241, value: 1 };

const NOAA = 'NOAA/NCEP';
const ECMWF = 'ECMWF open data, CC BY 4.0';
const COPERNICUS = 'Generated using E.U. Copernicus Marine Service Information';

const kt = { convert: 'kt-to-ms', outputUnit: 'm/s' } as const;

function wind(tileVar: string, shortName: string, number: number, level: GribLevel): GribVariableSpec {
  return { tileVar, shortName, discipline: 0, category: 2, number, level, decimalScale: 1, ...kt, estBits: 10 };
}

function wave(
  tileVar: string,
  shortName: string,
  number: number,
  level: GribLevel,
  quantity: 'height' | 'period' | 'direction',
): GribVariableSpec {
  const byQuantity = {
    height: { decimalScale: 2, outputUnit: 'm', estBits: 11 },
    period: { decimalScale: 1, outputUnit: 's', estBits: 9 },
    direction: { decimalScale: 1, outputUnit: 'deg', estBits: 12 },
  } as const;
  return { tileVar, shortName, discipline: 10, category: 0, number, level, convert: 'none', ...byQuantity[quantity] };
}

const CURRENT_VARIABLES: readonly GribVariableSpec[] = [
  { tileVar: 'cur_u_kt', shortName: 'UOGRD', discipline: 10, category: 1, number: 2, level: SURFACE, decimalScale: 2, ...kt, estBits: 10 },
  { tileVar: 'cur_v_kt', shortName: 'VOGRD', discipline: 10, category: 1, number: 3, level: SURFACE, decimalScale: 2, ...kt, estBits: 10 },
];

const WIND_VARIABLES: readonly GribVariableSpec[] = [
  wind('wind_u_kt', 'UGRD', 2, LEVEL_10M),
  wind('wind_v_kt', 'VGRD', 3, LEVEL_10M),
  wind('gust_kt', 'GUST', 22, SURFACE),
];

export const GRIB_DATASETS: readonly GribDatasetSpec[] = [
  {
    id: 'wind-gfs',
    layer: 'weather',
    kind: 'wind',
    label: 'Wind – GFS',
    attribution: NOAA,
    centre: 7,
    generatingProcess: 96,
    hasLand: false,
    variables: WIND_VARIABLES,
  },
  {
    id: 'wind-ecmwf',
    layer: 'weather-ecmwf',
    kind: 'wind',
    label: 'Wind – ECMWF',
    attribution: ECMWF,
    centre: 98,
    generatingProcess: 255,
    hasLand: false,
    // Gust is exported only when the run's manifest lists it (step-sparse upstream).
    variables: WIND_VARIABLES,
  },
  {
    id: 'waves-gfs',
    layer: 'waves',
    kind: 'waves',
    label: 'Waves – GFS-Wave',
    attribution: NOAA,
    centre: 7,
    generatingProcess: 11,
    hasLand: true,
    variables: [
      wave('hs_m', 'HTSGW', 3, WAVE_SURFACE, 'height'),
      wave('period_s', 'PERPW', 11, WAVE_SURFACE, 'period'),
      wave('dir_deg', 'DIRPW', 10, WAVE_SURFACE, 'direction'),
      wave('wind_wave_h_m', 'WVHGT', 5, WAVE_SURFACE, 'height'),
      wave('wind_wave_period_s', 'WVPER', 6, WAVE_SURFACE, 'period'),
      wave('wind_wave_dir_deg', 'WVDIR', 4, WAVE_SURFACE, 'direction'),
      wave('swell_h_m', 'SWELL', 8, SWELL_1, 'height'),
      wave('swell_period_s', 'SWPER', 9, SWELL_1, 'period'),
      wave('swell_dir_deg', 'SWDIR', 7, SWELL_1, 'direction'),
    ],
  },
  {
    id: 'currents-global',
    layer: 'currents',
    kind: 'currents',
    label: 'Currents – global (6-hourly)',
    attribution: COPERNICUS,
    note: '6-hourly ocean-model currents. Tides are not resolved; do not use as tidal streams.',
    centre: 255,
    generatingProcess: 255,
    hasLand: true,
    variables: CURRENT_VARIABLES,
  },
  {
    id: 'currents-ibi',
    layer: 'currents-ibi',
    kind: 'currents',
    label: 'Currents – IBI regional (hourly, tide included)',
    attribution: COPERNICUS,
    note: 'Hourly regional model currents including tide. Not an official tidal-stream prediction.',
    centre: 255,
    generatingProcess: 255,
    hasLand: true,
    variables: CURRENT_VARIABLES,
  },
];

export const GRIB_EXPORT_NOTICE =
  'Forecast data for planning, not for navigation. Check official forecasts and warnings.';

export function gribDataset(id: string): GribDatasetSpec | undefined {
  return GRIB_DATASETS.find((dataset) => dataset.id === id);
}
