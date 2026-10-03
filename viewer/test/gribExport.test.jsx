import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TileForecastStore } from '@deepweather/engine';
import { buildFixtureRun } from '../../engine/test/helpers/fixtureRun.ts';
import Grib from '../src/pages/Grib.jsx';
import Planner from '../src/pages/Planner.jsx';
import { useApp } from '../src/stores/appStore.js';
import { useGrib } from '../src/stores/gribStore.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { track } from '../src/lib/analytics.js';
import { LocalizedDocument } from '../src/i18n.js';
import {
  describeGribDataset,
  fmtGustWindows,
  fmtGribArea,
  fmtGribBox,
  fmtGribBytes,
  fmtGribGrid,
  fmtLatLon,
  gribArea,
  gribAreaFromHash,
  gribAreaHash,
  gribForecastEnd,
  gribKindDataset,
  gribModelOrder,
  gribPeriodWindow,
  gribRouteArea,
  gribRoutePoints,
  gribRunIds,
  gribRunLabel,
  gribSizeBucket,
  planAreaGrib,
  validGribArea,
} from '../src/lib/gribExport.js';

const store = vi.hoisted(() => ({ current: null }));
const mapState = vi.hoisted(() => ({ rectangle: null, fits: [] }));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null,
  Rectangle: (props) => {
    mapState.rectangle = props;
    return <div data-testid="grib-box" />;
  },
  useMap: () => ({ fitBounds: (bounds) => mapState.fits.push(bounds) }), useMapEvents: vi.fn(),
}));
vi.mock('../src/lib/browserAnalysis.js', () => ({ analyzeInBrowser: vi.fn(), saveRoute: vi.fn() }));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({
  forecastStore: () => store.current,
  friendlyForecastError: () => new Error("Couldn't load the forecast tiles. Check your connection and try again."),
}));

const CYCLE = '2026-07-20T00:00Z';
const NOW = '2026-07-20T06:30:00Z';
const hours = (count, every = 1) => Array.from({ length: count }, (_, i) => i * every);
/** Inside the one published IBI tile (N50W010, whose fixture points span 50–51°N, 10–9°W). */
const CHANNEL = { minLat: 50.2, maxLat: 50.9, minLon: -9.9, maxLon: -9.1 };
/** Across N40W010 too, where IBI has no tile. */
const ACROSS = { minLat: 49.5, maxLat: 50.8, minLon: -9.9, maxLon: -9.1 };

function fixtureTransport({ ibiHours = 25, waves = false, ecmwfTiles = [[50, -10], [40, -10]], ecmwfShort = false } = {}) {
  const wind = (name, scale, value) => ({ name, axis: 'hourly', dtype: 'i16', scale, value });
  const current = (name, value) => ({ name, axis: 'steps', dtype: 'i16', scale: 0.01, value });
  const wave = (name, scale) => ({ name, axis: 'steps', dtype: 'i16', scale, value: () => 1.5 });
  return buildFixtureRun([
    ...(waves ? [{
      layer: 'waves', model: 'gfswave_0p25', cycle: CYCLE, resolution_deg: 0.25,
      time_axes: { steps: { base: CYCLE, offsets_h: hours(33, 3) } },
      variables: [wave('hs_m', 0.01), wave('period_s', 0.1), wave('dir_deg', 0.1)],
      tiles: [[50, -10]],
    }] : []),
    {
      layer: 'weather', model: 'gfs_0p25', cycle: CYCLE, resolution_deg: 0.25,
      time_axes: { hourly: { base: CYCLE, offsets_h: hours(97) } },
      variables: [wind('wind_u_kt', 0.01, (_m, t) => 10 + t / 10), wind('wind_v_kt', 0.01, () => -4), wind('gust_kt', 0.1, () => 18)],
      tiles: [[50, -10], [40, -10]],
    },
    {
      layer: 'weather-ecmwf', model: 'ecmwf_ifs_0p25', cycle: CYCLE, resolution_deg: 0.25,
      time_axes: { steps: { base: CYCLE, offsets_h: hours(49, 3) } },
      variables: [{ ...wind('wind_u_kt', 0.01, () => 5), axis: 'steps' }, { ...wind('wind_v_kt', 0.01, () => 5), axis: 'steps' }],
      tiles: ecmwfTiles,
    },
    ...(ecmwfShort ? [{
      // ECMWF's 06Z run, here to +48 h (the real ones reach 144 h, the 00Z/12Z ones 240 h)
      layer: 'weather-ecmwf-short', model: 'ecmwf_ifs_0p25', cycle: '2026-07-20T06:00Z', resolution_deg: 0.25,
      time_axes: { steps: { base: '2026-07-20T06:00Z', offsets_h: hours(17, 3) } },
      variables: [{ ...wind('wind_u_kt', 0.01, () => 8), axis: 'steps' }, { ...wind('wind_v_kt', 0.01, () => 8), axis: 'steps' }],
      tiles: ecmwfTiles,
    }] : []),
    {
      layer: 'currents', model: 'cmems_glo12', cycle: CYCLE, resolution_deg: 1 / 12,
      time_axes: { steps: { base: CYCLE, offsets_h: hours(41, 6) } },
      variables: [current('cur_u_kt', (_m, _t, i) => (i === 0 ? NaN : 0.5)), current('cur_v_kt', () => -0.25)],
      tiles: [[50, -10], [40, -10]],
    },
    {
      // regional: only the northern tile, and a 24 h horizon
      layer: 'currents-ibi', model: 'cmems_ibi', cycle: CYCLE, resolution_deg: 1 / 36,
      time_axes: { hourly: { base: CYCLE, offsets_h: hours(ibiHours) } },
      variables: [{ ...current('cur_u_kt', () => 1), axis: 'hourly' }, { ...current('cur_v_kt', () => 0.5), axis: 'hourly' }],
      tiles: [[50, -10]], pointsPerSide: 36,
    },
  ]);
}

async function planFor(area, { period = '3', step = 'all' } = {}) {
  await store.current.init();
  const manifests = (layer) => store.current.manifestFor(layer);
  const window = gribPeriodWindow({ period, nowMs: Date.parse(NOW), forecastEndIso: gribForecastEnd(manifests) });
  return planAreaGrib(manifests, { area, window, step, fixture: true });
}

const page = () => within(screen.getByRole('region', { name: 'GRIB download' }));
const kindItem = (name) => within(page().getByRole('button', { name }).closest('li'));

async function openWith(area) {
  act(() => useGrib.setState({ area }));
  render(<Grib />);
  await waitFor(() => expect(page().getByRole('button', { name: 'Download wind' })).toBeEnabled());
}

let urls;
let saves;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  localStorage.clear();
  history.replaceState(null, '', '/#plan/grib');
  mapState.rectangle = null;
  mapState.fits = [];
  store.current = new TileForecastStore({ transport: fixtureTransport() });
  urls = 0;
  URL.createObjectURL = vi.fn(() => `blob:grib-${++urls}`);
  URL.revokeObjectURL = vi.fn();
  saves = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    saves.push({ href: this.getAttribute('href'), name: this.getAttribute('download') });
  });
  useGrib.getState().reset();
  usePlanner.getState().reset();
  useApp.setState({
    page: 'grib', manifest: { snapshots: [] }, profileDefaults: {}, findings: null, language: 'en',
    loadConfig: vi.fn(), openSnapshot: vi.fn(),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

describe('area, period and model choices', () => {
  it('snaps a drawn box outward to 0.1°, keeps a minimum size and clamps it to the globe', () => {
    expect(gribArea({ lat: 50.87, lon: 1.23 }, { lat: 49.13, lon: -2.71 }))
      .toEqual({ minLat: 49.1, maxLat: 50.9, minLon: -2.8, maxLon: 1.3 });
    // a click without a drag still gives a usable box
    expect(gribArea({ lat: 50.02, lon: -1.02 }, { lat: 50.02, lon: -1.02 }))
      .toEqual({ minLat: 49.9, maxLat: 50.2, minLon: -1.2, maxLon: -0.9 });
    // clamped, never wrapped: a box cannot cross the 180° meridian
    expect(gribArea({ lat: 88, lon: 175 }, { lat: 95, lon: 190 })).toEqual({ minLat: 88, maxLat: 90, minLon: 175, maxLon: 180 });
    expect(gribArea({ lat: NaN, lon: 0 }, { lat: 1, lon: 1 })).toBeNull();
  });

  it('turns a planner route into its box plus a 1° margin', () => {
    const points = [{ lat: 50.5, lon: -1.5 }, { lat: 49.65, lon: -1.62 }, { lat: 50.75, lon: -1.25 }];
    expect(gribRouteArea(points)).toEqual({ minLat: 48.6, maxLat: 51.8, minLon: -2.7, maxLon: -0.2 });
    expect(gribRouteArea(null)).toBeNull();
  });

  it('uses the drawn waypoints, else the computed route, else the two endpoints', () => {
    const waypoints = [{ lat: 50, lng: -2 }, { lat: 51, lng: 361 }];
    expect(gribRoutePoints({ mode: 'draw', waypoints })).toEqual([{ lat: 50, lon: -2 }, { lat: 51, lon: 1 }]);
    expect(gribRoutePoints({ mode: 'draw', waypoints: waypoints.slice(0, 1) })).toBeNull();
    const endpoints = [{ lat: 49, lng: -3 }, { lat: 50, lng: -1 }];
    expect(gribRoutePoints({ mode: 'compute', endpoints })).toEqual([{ lat: 49, lon: -3 }, { lat: 50, lon: -1 }]);
    const computed = { route: { waypoints: [{ lat: 49, lon: -3 }, { lat: 49.5, lon: -2 }, { lat: 50, lon: -1 }] } };
    expect(gribRoutePoints({ mode: 'compute', endpoints, computed })).toHaveLength(3);
  });

  it('round-trips an area through a bookmarkable link and rejects bad ones', () => {
    const area = { minLat: 48.9, maxLat: 51, minLon: -4.7, maxLon: 1.2 };
    expect(gribAreaHash(area)).toBe('plan/grib?area=48.9,51,-4.7,1.2');
    expect(gribAreaFromHash(`#${gribAreaHash(area)}`)).toEqual(area);
    expect(gribAreaHash(null)).toBe('plan/grib');
    for (const hash of ['#plan/grib', '#plan/grib?area=51,48,-4,1', '#plan/grib?area=1,2,3', '#plan/grib?area=a,b,c,d', '#plan/grib?area=80,95,0,1']) {
      expect(gribAreaFromHash(hash), hash).toBeNull();
    }
    expect(validGribArea({ minLat: 1, maxLat: 2, minLon: 3, maxLon: 4 })).toEqual({ minLat: 1, maxLat: 2, minLon: 3, maxLon: 4 });
    expect(validGribArea('nope')).toBeNull();
  });

  it('runs the period from now, floored to the hour, or to the end of the longest forecast', async () => {
    const nowMs = Date.parse(NOW);
    expect(gribPeriodWindow({ period: '3', nowMs })).toEqual({ startIso: '2026-07-20T06:00:00Z', endIso: '2026-07-23T06:00:00Z' });
    expect(gribPeriodWindow({ period: '7', nowMs }).endIso).toBe('2026-07-27T06:00:00Z');
    expect(gribPeriodWindow({ period: 'bogus', nowMs }).endIso).toBe('2026-07-23T06:00:00Z');
    await store.current.init();
    const manifests = (layer) => store.current.manifestFor(layer);
    // currents run to +240 h; GFS wind (+96 h), ECMWF (+144 h) and IBI (+24 h) end sooner
    expect(gribForecastEnd(manifests)).toBe('2026-07-30T00:00:00Z');
    expect(gribForecastEnd(() => null)).toBeNull();
    expect(gribPeriodWindow({ period: 'full', nowMs, forecastEndIso: gribForecastEnd(manifests) }).endIso).toBe('2026-07-30T00:00:00Z');
    // until the runs have loaded, three days stand in
    expect(gribPeriodWindow({ period: 'full', nowMs, forecastEndIso: null }).endIso).toBe('2026-07-23T06:00:00Z');
  });

  it('puts the local model first: ECMWF wind in Europe, GFS elsewhere, IBI currents first', () => {
    expect(gribModelOrder('wind', CHANNEL)).toEqual(['wind-ecmwf', 'wind-gfs']);
    expect(gribModelOrder('wind', { minLat: 39, maxLat: 42, minLon: 1, maxLon: 4 })).toEqual(['wind-ecmwf', 'wind-gfs']);
    expect(gribModelOrder('wind', { minLat: 40, maxLat: 42, minLon: -72, maxLon: -70 })).toEqual(['wind-gfs', 'wind-ecmwf']);
    expect(gribModelOrder('wind', { minLat: -25, maxLat: -23, minLon: 151, maxLon: 153 })).toEqual(['wind-gfs', 'wind-ecmwf']);
    expect(gribModelOrder('currents', CHANNEL)).toEqual(['currents-ibi', 'currents-global']);
    expect(gribModelOrder('waves', CHANNEL)).toEqual(['waves-gfs']);
  });

  it('downloads the local model unless it is missing, partial here, or the sailor chose another', async () => {
    const plan = await planFor(CHANNEL);
    expect(gribKindDataset(plan, 'wind', CHANNEL).datasetId).toBe('wind-ecmwf');
    expect(gribKindDataset(plan, 'wind', CHANNEL, 'wind-gfs').datasetId).toBe('wind-gfs');
    expect(gribKindDataset(plan, 'currents', CHANNEL).datasetId).toBe('currents-ibi');
    // IBI covers only part of this box, so the global model covers it whole
    const across = await planFor(ACROSS);
    expect(gribKindDataset(across, 'currents', ACROSS).datasetId).toBe('currents-global');
    expect(gribKindDataset(across, 'currents', ACROSS, 'currents-ibi').datasetId).toBe('currents-ibi');
    // no waves run: the preferred model comes back so the page can say why
    expect(gribKindDataset(plan, 'waves', CHANNEL)).toMatchObject({ datasetId: 'waves-gfs', availability: 'no-layer' });
    // ECMWF missing here: GFS stands in, whatever was chosen
    store.current = new TileForecastStore({ transport: fixtureTransport({ ecmwfTiles: [[0, 0]] }) });
    const noEcmwf = await planFor(CHANNEL);
    expect(gribKindDataset(noEcmwf, 'wind', CHANNEL, 'wind-ecmwf').datasetId).toBe('wind-gfs');
  });

  it('formats sizes, grids and coordinates for the file details', () => {
    expect([fmtGribBytes(420), fmtGribBytes(82_400), fmtGribBytes(2_214_000), fmtGribBytes(33_000_000)])
      .toEqual(['1 kB', '82 kB', '2.2 MB', '33 MB']);
    expect([gribSizeBucket(900_000), gribSizeBucket(2e6), gribSizeBucket(6e6), gribSizeBucket(25e6), gribSizeBucket(80e6)])
      .toEqual(['0-1MB', '1-5MB', '5-20MB', '20-50MB', '50MB+']);
    expect(fmtGribGrid({ ni: 97, nj: 37, step_deg: 10 / 120 })).toBe('97 × 37 points · 1/12°');
    expect(fmtGribGrid({ ni: 33, nj: 13, step_deg: 0.25 })).toBe('33 × 13 points · 0.25°');
    expect(fmtGribArea({ south: 48, north: 51, west: -6, east: 2 })).toBe('48°N–51°N, 6°W–2°E');
    expect(fmtGribBox({ minLat: 48.9, maxLat: 51, minLon: -4.7, maxLon: 1.2 })).toBe('48.9°N–51°N, 4.7°W–1.2°E');
    expect(fmtLatLon(-33.5, 151.25)).toBe('33.5°S 151.25°E');
  });

  it('plans ECMWF wind from its 06Z run while that covers the period, else from the 00Z run', async () => {
    store.current = new TileForecastStore({ transport: fixtureTransport({ ecmwfShort: true }) });
    const wind = async (period) => (await planFor(CHANNEL, { period })).datasets.find((d) => d.datasetId === 'wind-ecmwf');
    expect(await wind('2')).toMatchObject({ layer: 'weather-ecmwf-short', run_id: 'weather-ecmwf-short-20260720T06Z' });
    expect(await wind('3')).toMatchObject({ layer: 'weather-ecmwf', run_id: 'weather-ecmwf-20260720T00Z' });
    // a new 06Z/18Z run changes the plan's key like any other
    const manifests = (layer) => store.current.manifestFor(layer);
    expect(gribRunIds(manifests)).toContain('weather-ecmwf-short-20260720T06Z');
    expect(gribRunLabel({ datasetId: 'wind-ecmwf', cycle: '2026-07-20T06:00Z', model: 'ecmwf_ifs_0p25' })).toBe('ECMWF 06Z');
    expect(gribRunLabel({ datasetId: 'currents-ibi', cycle: '2026-07-20T00:00Z', model: 'cmems_ibi' })).toBe('IBI 00Z');
  });

  it('flags a regional dataset with unpublished tiles and a horizon shorter than the period', () => {
    const dataset = {
      datasetId: 'currents-ibi', availability: 'ok',
      steps: [{ time: '2026-07-20T08:00:00Z' }, { time: '2026-07-21T00:00:00Z' }],
      tiles: [{ id: 'N50W010', present: true }, { id: 'N40W010', present: false }],
      variables: [{ tileVar: 'cur_u_kt' }, { tileVar: 'cur_v_kt' }],
      windowsH: [null, null],
    };
    expect(describeGribDataset(dataset, { endIso: '2026-07-21T10:00:00Z' })).toMatchObject({
      ok: true, steps: 2, first: '2026-07-20T08:00:00Z', last: '2026-07-21T00:00:00Z', horizonShort: true, partial: true,
      gustWindows: [],
    });
    expect(describeGribDataset({ ...dataset, datasetId: 'waves-gfs' }, { endIso: '2026-07-21T00:00:00Z' }))
      .toMatchObject({ horizonShort: false, partial: false });
  });

  it('names the gust windows of an ECMWF file, and none for an instantaneous gust', () => {
    const wind = [{ tileVar: 'wind_u_kt' }, { tileVar: 'wind_v_kt' }];
    const ecmwf = {
      datasetId: 'wind-ecmwf', availability: 'ok', steps: [{ time: '2026-07-20T00:00:00Z' }], tiles: [],
      variables: [...wind, { tileVar: 'gust_kt', statistic: 'max' }],
      windowsH: [null, null, [null, 1, 1, 3, 6, 6]],
    };
    expect(describeGribDataset(ecmwf, { endIso: '2026-07-20T00:00:00Z' }).gustWindows).toEqual([1, 3, 6]);
    expect(fmtGustWindows([1, 3, 6])).toBe(
      'Gusts are the maximum over the 1, 3 or 6 h before each time, rather than instantaneous values.',
    );
    expect(fmtGustWindows([1])).toBe(
      'Gusts are the maximum over the 1 h before each time, rather than instantaneous values.',
    );
    const gfs = { ...ecmwf, datasetId: 'wind-gfs', variables: [...wind, { tileVar: 'gust_kt' }], windowsH: [null, null, null] };
    expect(describeGribDataset(gfs, { endIso: '2026-07-20T00:00:00Z' }).gustWindows).toEqual([]);
  });
});

describe('GRIB files page', () => {
  it('asks for a box first', async () => {
    render(<Grib />);
    expect(page().getByText('Move the chart to your sailing area, press Draw a box, then drag across the chart.')).toBeInTheDocument();
    expect(page().getByText('Draw your area first.')).toBeInTheDocument();
    expect(page().queryByRole('button', { name: /^Download/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Draw a box' })).toBeEnabled();
    expect(screen.queryByTestId('grib-box')).not.toBeInTheDocument();
    // dev and tests read the local warehouse: an emulated fixture, never the live forecast
    expect(screen.getByText('Local test tiles, not the live forecast.')).toBeInTheDocument();
  });

  it('offers one download per kind with the local model, its times, size and notes', async () => {
    await openWith(CHANNEL);
    expect(mapState.rectangle.bounds).toEqual([[50.2, -9.9], [50.9, -9.1]]);
    // corner handles adjust an existing box; there is no redraw button
    expect(screen.queryByRole('button', { name: /Draw a box|Redraw/ })).not.toBeInTheDocument();
    expect(page().getByText('Drag a corner of the box to adjust it.')).toBeInTheDocument();
    expect(page().getByText('50.2°N–50.9°N, 9.9°W–9.1°W')).toBeInTheDocument();
    // the period, and ECMWF wind which covers all of it
    expect(page().getAllByText('Mon 20 Jul 06:00 → Thu 23 Jul 06:00 UTC')).toHaveLength(2);

    const wind = kindItem('Download wind');
    expect(wind.getByText('Wind – ECMWF')).toBeInTheDocument();
    expect(wind.getByText('Mon 20 Jul 06:00 → Thu 23 Jul 06:00 UTC')).toBeInTheDocument();
    expect(wind.getByText('25 steps')).toBeInTheDocument();
    expect(wind.getByText(/^\d+ kB$/)).toBeInTheDocument();

    const currents = kindItem('Download currents');
    expect(currents.getByText('Currents – IBI regional (hourly, tide included)')).toBeInTheDocument();
    expect(currents.getByText('This forecast ends Tue 21 Jul 00:00 UTC, before the end of your period.')).toBeInTheDocument();
    expect(currents.getByText('Hourly regional model currents including tide. Not an official tidal-stream prediction.')).toBeInTheDocument();

    expect(page().getByRole('button', { name: 'Download waves' })).toBeDisabled();
    expect(kindItem('Download waves').getByText('Not in the current forecast runs.')).toBeInTheDocument();

    expect(page().getByText('Forecast data for planning, not for navigation. Check official forecasts and warnings.')).toBeInTheDocument();
    expect(page().getByText('ECMWF open data, CC BY 4.0')).toBeInTheDocument();
    expect(page().getByText('Generated using E.U. Copernicus Marine Service Information')).toBeInTheDocument();
  });

  it('offers a one-day export window for short regional forecasts', async () => {
    await openWith(CHANNEL);
    const period = page().getByRole('combobox', { name: 'Period' });
    expect(within(period).getByRole('option', { name: 'Next 1 day' })).toBeInTheDocument();
    fireEvent.change(period, { target: { value: '1' } });
    expect(useGrib.getState().period).toBe('1');
    const window = gribPeriodWindow({ period: '1', nowMs: Date.parse(NOW) });
    expect(Date.parse(window.endIso) - Date.parse(window.startIso)).toBe(24 * 3_600_000);
    expect(page().getAllByText('Mon 20 Jul 06:00 → Tue 21 Jul 06:00 UTC')).toHaveLength(2);
  });

  it('falls back to the global currents where IBI covers only part of the box', async () => {
    await openWith(ACROSS);
    const currents = kindItem('Download currents');
    expect(currents.getByText('Currents – global (6-hourly)')).toBeInTheDocument();
    expect(currents.getByText('6-hourly ocean-model currents. Tides are not resolved; do not use as tidal streams.')).toBeInTheDocument();
    // the regional model stays one choice away, with its coverage caveat
    fireEvent.change(page().getByLabelText('Currents model'), { target: { value: 'currents-ibi' } });
    expect(useGrib.getState().models.currents).toBe('currents-ibi');
    expect(kindItem('Download currents').getByText(/^Partial coverage: this regional model covers only part of the area\./)).toBeInTheDocument();
  });

  it('builds and saves a file in one click, re-saves it without rebuilding, and drops it when the period changes', async () => {
    await openWith(CHANNEL);
    fireEvent.click(page().getByRole('button', { name: 'Download wind' }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({ href: 'blob:grib-1', name: 'passage-fixture_wind-ecmwf_20260720T00Z_N50W010_N51W009.grb2' });
    const blob = URL.createObjectURL.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/octet-stream');
    expect(new TextDecoder().decode((await blob.arrayBuffer()).slice(0, 4))).toBe('GRIB');
    expect(track).toHaveBeenCalledWith('grib_export', { datasets: 'wind-ecmwf', window: '3d', size_bucket: '0-1MB' });

    const wind = kindItem('Download wind');
    expect(wind.getByText('Saved')).toBeInTheDocument();
    expect(wind.getByText('passage-fixture_wind-ecmwf_20260720T00Z_N50W010_N51W009.grb2').tagName).toBe('CODE');
    expect(wind.getByRole('link', { name: 'Save again' })).toHaveAttribute('href', 'blob:grib-1');
    expect(wind.getByRole('link', { name: 'Save again' })).toHaveAttribute('download', 'passage-fixture_wind-ecmwf_20260720T00Z_N50W010_N51W009.grb2');
    expect(page().getByText('Your browser saves the files in its Downloads folder. Open them from there in your GRIB software.')).toBeInTheDocument();
    // File details: run, grid and the spot values at the centre of the box
    expect(wind.getByText('weather-ecmwf-20260720T00Z')).toBeInTheDocument();
    expect(wind.getByText('Centre of the area')).toBeInTheDocument();
    expect(wind.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Time (UTC)', 'Wind (kt)', 'From (°)']);

    fireEvent.click(page().getByRole('button', { name: 'Download wind' }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1].href).toBe('blob:grib-1');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    fireEvent.change(page().getByLabelText('Period'), { target: { value: '5' } });
    expect(useGrib.getState().period).toBe('5');
    expect(page().queryByText('Saved')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:grib-1');
  });

  it('names the ECMWF run in the file details: 06Z for the next 2 days, 00Z beyond its range', async () => {
    store.current = new TileForecastStore({ transport: fixtureTransport({ ecmwfShort: true }) });
    act(() => useGrib.setState({ period: '2' }));
    await openWith(CHANNEL);
    fireEvent.click(page().getByRole('button', { name: 'Download wind' }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].name).toBe('passage-fixture_wind-ecmwf_20260720T06Z_N50W010_N51W009.grb2');
    let wind = kindItem('Download wind');
    expect(wind.getByText('ECMWF 06Z')).toBeInTheDocument();
    expect(wind.getByText('weather-ecmwf-short-20260720T06Z').tagName).toBe('CODE');

    fireEvent.change(page().getByLabelText('Period'), { target: { value: '3' } });
    fireEvent.click(page().getByRole('button', { name: 'Download wind' }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1].name).toBe('passage-fixture_wind-ecmwf_20260720T00Z_N50W010_N51W009.grb2');
    wind = kindItem('Download wind');
    expect(wind.getByText('ECMWF 00Z')).toBeInTheDocument();
    expect(wind.getByText('weather-ecmwf-20260720T00Z')).toBeInTheDocument();
  });

  it('keeps one file per kind, uses the chosen model, and revokes files on unmount', async () => {
    act(() => useGrib.setState({ area: CHANNEL }));
    const { unmount } = render(<Grib />);
    await waitFor(() => expect(page().getByRole('button', { name: 'Download wind' })).toBeEnabled());
    fireEvent.click(page().getByRole('button', { name: 'Download currents' }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].name).toMatch(/^passage-fixture_currents-ibi_20260720T00Z_/);
    fireEvent.change(page().getByLabelText('Wind model'), { target: { value: 'wind-gfs' } });
    fireEvent.click(page().getByRole('button', { name: 'Download wind' }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1].name).toMatch(/^passage-fixture_wind-gfs_20260720T00Z_/);
    expect(track).toHaveBeenLastCalledWith('grib_export', { datasets: 'wind-gfs', window: '3d', size_bucket: '0-1MB' });
    expect(kindItem('Download currents').getByText('Saved')).toBeInTheDocument();
    expect(kindItem('Download wind').getByText('Saved')).toBeInTheDocument();
    unmount();
    expect(URL.revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual(['blob:grib-1', 'blob:grib-2']);
  });

  it('adopts a bookmarked area, then keeps the address in step with the box', async () => {
    history.replaceState(null, '', '/#plan/grib?area=50.2,50.9,-9.9,-9.1');
    render(<Grib />);
    await waitFor(() => expect(useGrib.getState().area).toEqual(CHANNEL));
    expect(mapState.fits.at(-1)).toEqual([[50.2, -9.9], [50.9, -9.1]]);
    await waitFor(() => expect(page().getByRole('button', { name: 'Download wind' })).toBeEnabled());
    act(() => useGrib.getState().patch({ area: { ...CHANNEL, maxLat: 51.5 } }));
    expect(location.hash).toBe('#plan/grib?area=50.2,51.5,-9.9,-9.1');
    // a box drawn on this chart is already in view: no refit
    expect(mapState.fits).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('deepweather.grib')).state.area).toEqual({ ...CHANNEL, maxLat: 51.5 });
  });

  it('opens from the planner with the route’s area, or empty without a route', async () => {
    usePlanner.setState({ mode: 'draw', waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.75, lng: -1.25 }] });
    const setPage = vi.fn();
    useApp.setState({ page: 'planner', setPage });
    const { unmount } = render(<Planner />);
    fireEvent.click(screen.getByRole('button', { name: 'Export GRIB for this area' }));
    expect(setPage).toHaveBeenCalledWith('grib');
    expect(useGrib.getState().area).toEqual({ minLat: 49.5, maxLat: 51.8, minLon: -2.5, maxLon: -0.2 });
    expect(useGrib.getState().fitNonce).toBe(1);
    unmount();
    // no route: the button still opens the page, keeping whatever box was there
    act(() => usePlanner.getState().reset());
    render(<Planner />);
    expect(screen.getByRole('button', { name: 'Export GRIB for this area' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Export GRIB for this area' }));
    expect(setPage).toHaveBeenCalledTimes(2);
    expect(useGrib.getState().fitNonce).toBe(1);
  });

  it('cancels a running file', async () => {
    let release;
    const transport = fixtureTransport();
    const fetchTile = transport.fetchTile.bind(transport);
    transport.fetchTile = (...args) => new Promise((resolve) => { release = () => resolve(fetchTile(...args)); });
    store.current = new TileForecastStore({ transport });
    await openWith(CHANNEL);
    fireEvent.click(page().getByRole('button', { name: 'Download wind' }));
    const cancel = await page().findByRole('button', { name: 'Cancel' });
    expect(page().getByRole('progressbar', { name: 'GRIB file progress' })).toBeInTheDocument();
    expect(page().getByText('Reading forecast tiles')).toBeInTheDocument();
    expect(page().getByRole('button', { name: 'Download currents' })).toBeDisabled();
    fireEvent.click(cancel);
    release();
    expect(await page().findByText('Cancelled. No file was saved.')).toBeInTheDocument();
    expect(page().getByRole('button', { name: 'Download wind' })).toBeEnabled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(saves).toHaveLength(0);
    expect(track).not.toHaveBeenCalledWith('grib_export', expect.anything());
  });

  it('asks to try again when the pinned run is gone and latest.json has nothing newer', async () => {
    const transport = fixtureTransport();
    transport.fetchTile = async (runId, path) => {
      throw Object.assign(new Error(`forecast fetch failed: HTTP 404 for ${runId}/${path}`), { status: 404 });
    };
    const latest = vi.spyOn(transport, 'fetchLatest');
    store.current = new TileForecastStore({ transport });
    await openWith(CHANNEL);
    fireEvent.click(page().getByRole('button', { name: 'Download wind' }));
    expect(await page().findByText('The forecast has been updated. Try again.')).toBeInTheDocument();
    expect(latest).toHaveBeenCalledTimes(2); // page load, then one refresh after the 404
    expect(saves).toHaveLength(0);
  });

  it('refreshes once and builds the file from the new run when the pinned one was deleted', async () => {
    const transport = fixtureTransport();
    const NEXT = '2026-07-20T06:00Z';
    const next = buildFixtureRun([{
      layer: 'weather-ecmwf', model: 'ecmwf_ifs_0p25', cycle: NEXT, resolution_deg: 0.25,
      time_axes: { steps: { base: NEXT, offsets_h: hours(49, 3) } },
      variables: ['wind_u_kt', 'wind_v_kt'].map((name) => ({ name, axis: 'steps', dtype: 'i16', scale: 0.01, value: () => 6 })),
      tiles: [[50, -10], [40, -10]],
    }]);
    store.current = new TileForecastStore({ transport });
    await openWith(CHANNEL);
    // forecast-tiles publishes 06Z and deletes 00Z while the page stays open
    for (const [runId, manifest] of next.manifests) transport.manifests.set(runId, manifest);
    for (const [key, bytes] of next.tiles) transport.tiles.set(key, bytes);
    transport.latest = {
      ...transport.latest,
      layers: { ...transport.latest.layers, 'weather-ecmwf': { ...next.latest.layers['weather-ecmwf'], previous_run_id: null } },
    };
    for (const key of [...transport.tiles.keys()]) {
      if (key.startsWith('weather-ecmwf-20260720T00Z/')) transport.tiles.delete(key);
    }
    fireEvent.click(page().getByRole('button', { name: 'Download wind' }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].name).toBe('passage-fixture_wind-ecmwf_20260720T06Z_N50W010_N51W009.grb2');
    expect(page().queryByText('The forecast has been updated. Try again.')).toBeNull();
  });

  it('explains when the forecast runs cannot be loaded, and retries', async () => {
    const transport = fixtureTransport();
    const fetchLatest = transport.fetchLatest.bind(transport);
    transport.fetchLatest = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(fetchLatest);
    store.current = new TileForecastStore({ transport });
    act(() => useGrib.setState({ area: CHANNEL }));
    render(<Grib />);
    expect(await page().findByText('The forecast runs are unavailable, so GRIB files can’t be prepared right now.')).toBeInTheDocument();
    fireEvent.click(page().getByRole('button', { name: 'Try again' }));
    expect(await page().findByRole('button', { name: 'Download wind' })).toBeEnabled();
  });

  it('keeps run ids and file names intact under the French localiser', async () => {
    store.current = new TileForecastStore({ transport: fixtureTransport({ waves: true }) });
    act(() => useGrib.setState({ area: CHANNEL }));
    render(<div id="root"><Grib /><LocalizedDocument language="fr" /></div>);
    // the localiser translates added subtrees from a MutationObserver, so wait for it
    const region = await screen.findByRole('region', { name: 'Téléchargement GRIB' });
    const waves = await within(region).findByRole('button', { name: 'Télécharger les vagues' });
    await waitFor(() => expect(waves).toBeEnabled());
    fireEvent.click(waves);
    const item = within(waves.closest('li'));
    // "waves" is a French fragment elsewhere ("vagues"); identifiers must survive it
    expect((await item.findByText('passage-fixture_waves-gfs_20260720T00Z_N50W010_N51W009.grb2')).tagName).toBe('CODE');
    expect(item.getByText('waves-20260720T00Z').tagName).toBe('CODE');
    expect(await item.findByRole('link', { name: 'Enregistrer à nouveau' })).toBeInTheDocument();
    expect(item.getByText('Détails du fichier')).toBeInTheDocument();
  });
});

describe('IBI horizon (forecast-tiles serves 0–120 h from 2026-09-29)', () => {
  // A run is served until the next day's bulletin replaces it, so it is up to
  // 24 h plus its publication delay (at most ~16 h after 00Z) old: 40 h.
  const OLDEST_MS = Date.parse(CYCLE) + 40 * 3_600_000;

  async function ibiFileFor(ibiHours) {
    store.current = new TileForecastStore({ transport: fixtureTransport({ ibiHours }) });
    await store.current.init();
    const manifests = (layer) => store.current.manifestFor(layer);
    const window = gribPeriodWindow({ period: '3', nowMs: OLDEST_MS });
    const plan = planAreaGrib(manifests, { area: CHANNEL, window, step: 'all', fixture: true });
    const dataset = gribKindDataset(plan, 'currents', CHANNEL);
    expect(dataset.datasetId).toBe('currents-ibi');
    return describeGribDataset(dataset, window);
  }

  it('covers the next 3 days even at the oldest a 0–120 h run is served', async () => {
    expect(await ibiFileFor(121)).toMatchObject({
      ok: true, horizonShort: false, steps: 73, first: '2026-07-21T16:00:00Z', last: '2026-07-24T16:00:00Z',
    });
  });

  it('ended 40 h short with the former 0–72 h axis', async () => {
    expect(await ibiFileFor(73)).toMatchObject({ ok: true, horizonShort: true, last: '2026-07-23T00:00:00Z' });
  });
});

it('offers opted-in regional GRIB models only when the catalogue provides them', () => {
  const area = {minLat: 48, maxLat: 49, minLon: -5, maxLon: -4};
  const absent = {datasets: [{datasetId: 'wind-arome', availability: 'no-layer'}]};
  expect(gribModelOrder('wind', area, absent)).toEqual(['wind-ecmwf', 'wind-gfs']);
  const plan = {datasets: [
    {datasetId: 'wind-ecmwf', availability: 'ok', tiles: []},
    {datasetId: 'wind-arome', availability: 'ok', tiles: []},
  ]};
  expect(gribModelOrder('wind', area, plan)).toEqual(['wind-ecmwf', 'wind-gfs', 'wind-arome']);
  expect(gribKindDataset(plan, 'wind', area, 'wind-arome').datasetId).toBe('wind-arome');
});

it('offers opted-in UKV beside global models and exposes its label and data terms', () => {
  const area = {minLat: 49, maxLat: 50, minLon: -5, maxLon: -4};
  const plan = {datasets: [{datasetId: 'wind-ukv', availability: 'ok', tiles: []}]};
  expect(gribModelOrder('wind', area, plan)).toEqual(['wind-ecmwf', 'wind-gfs', 'wind-ukv']);
  expect(gribKindDataset(plan, 'wind', area, 'wind-ukv').datasetId).toBe('wind-ukv');
});
