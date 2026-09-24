import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TileForecastStore } from '@deepweather/engine';
import { buildFixtureRun } from '../../engine/test/helpers/fixtureRun.ts';
import Planner from '../src/pages/Planner.jsx';
import { useApp } from '../src/stores/appStore.js';
import { usePlanner } from '../src/stores/plannerStore.js';
import { track } from '../src/lib/analytics.js';
import { toLocalDateTimeValue } from '../src/lib/format.js';
import { LocalizedDocument } from '../src/i18n.js';
import {
  GRIB_LON_STORAGE_KEY,
  describeGribDataset,
  fmtGribArea,
  fmtGribBytes,
  fmtGribGrid,
  fmtLatLon,
  gribBbox,
  gribEtaHours,
  gribForecastEnd,
  gribLonConvention,
  gribRoutePoints,
  gribSizeBucket,
  gribWindow,
  normalizeGribMargin,
} from '../src/lib/gribExport.js';

const store = vi.hoisted(() => ({ current: null }));
const mapState = vi.hoisted(() => ({ rectangle: null }));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null,
  Rectangle: (props) => {
    mapState.rectangle = props;
    return <div data-testid="export-box" />;
  },
  useMap: () => ({ fitBounds: vi.fn() }), useMapEvents: vi.fn(),
}));
vi.mock('../src/lib/browserAnalysis.js', () => ({ analyzeInBrowser: vi.fn(), saveRoute: vi.fn() }));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({
  forecastStore: () => store.current,
  friendlyForecastError: () => new Error("Couldn't load the forecast tiles. Check your connection and try again."),
}));

const CYCLE = '2026-07-20T00:00Z';
const NOW = '2026-07-20T06:30:00Z';
const DEPARTURE = '2026-07-20T08:00:00Z';
const hours = (count, every = 1) => Array.from({ length: count }, (_, i) => i * every);

function fixtureTransport({ ibiHours = 25, waves = false } = {}) {
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
      // published, but nowhere near the route
      layer: 'weather-ecmwf', model: 'ecmwf_ifs_0p25', cycle: CYCLE, resolution_deg: 0.25,
      time_axes: { steps: { base: CYCLE, offsets_h: hours(49, 3) } },
      variables: [{ ...wind('wind_u_kt', 0.01, () => 5), axis: 'steps' }, { ...wind('wind_v_kt', 0.01, () => 5), axis: 'steps' }],
      tiles: [[0, 0]], pointsPerSide: 4,
    },
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

const panelButton = () => screen.getByRole('button', { name: 'Download GRIBs…' });
const section = () => within(screen.getByRole('region', { name: 'GRIB download' }));
const datasetBox = (label) => section().getByRole('checkbox', { name: new RegExp(`^${label}`) });

async function openSection() {
  fireEvent.click(panelButton());
  await waitFor(() => expect(section().getByRole('button', { name: 'Prepare files' })).toBeInTheDocument());
}

let urls;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  localStorage.clear();
  history.replaceState(null, '', '/#plan/planner');
  mapState.rectangle = null;
  store.current = new TileForecastStore({ transport: fixtureTransport() });
  urls = 0;
  URL.createObjectURL = vi.fn(() => `blob:grib-${++urls}`);
  URL.revokeObjectURL = vi.fn();
  usePlanner.getState().reset();
  usePlanner.setState({
    waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.75, lng: -1.25 }],
    departureLocal: toLocalDateTimeValue(DEPARTURE),
  });
  useApp.setState({
    manifest: { snapshots: [] }, profileDefaults: {}, findings: null, language: 'en',
    loadConfig: vi.fn(), openSnapshot: vi.fn(),
  });
});
afterEach(() => {
  vi.useRealTimers();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

describe('route-area defaults', () => {
  it('pads the route points by the margin and clamps the box to the globe', () => {
    const points = [{ lat: 50.5, lon: -1.5 }, { lat: 49.65, lon: -1.62 }, { lat: 50.75, lon: -1.25 }];
    expect(gribBbox(points, 1)).toEqual({ minLat: 48.65, maxLat: 51.75, minLon: -2.62, maxLon: -0.25 });
    expect(gribBbox(points, 0)).toEqual({ minLat: 49.65, maxLat: 50.75, minLon: -1.62, maxLon: -1.25 });
    expect(gribBbox([{ lat: 88, lon: 178 }, { lat: 89, lon: 179 }], 5)).toEqual({ minLat: 83, maxLat: 90, minLon: 173, maxLon: 180 });
    expect(gribBbox(null, 1)).toBeNull();
    expect([normalizeGribMargin(2.3), normalizeGribMargin(9), normalizeGribMargin(-1), normalizeGribMargin('x')]).toEqual([2.5, 5, 0, 1]);
  });

  it('uses the drawn waypoints, else the computed route, else the two endpoints', () => {
    const waypoints = [{ lat: 50, lng: -2 }, { lat: 51, lng: 361 }];
    expect(gribRoutePoints({ mode: 'draw', waypoints })).toEqual([{ lat: 50, lon: -2 }, { lat: 51, lon: 1 }]);
    expect(gribRoutePoints({ mode: 'draw', waypoints: waypoints.slice(0, 1) })).toBeNull();
    const endpoints = [{ lat: 49, lng: -3 }, { lat: 50, lng: -1 }];
    expect(gribRoutePoints({ mode: 'compute', endpoints })).toEqual([{ lat: 49, lon: -3 }, { lat: 50, lon: -1 }]);
    const computed = { route: { waypoints: [{ lat: 49, lon: -3 }, { lat: 49.5, lon: -2 }, { lat: 50, lon: -1 }] } };
    expect(gribRoutePoints({ mode: 'compute', endpoints, computed })).toHaveLength(3);
    expect(gribRoutePoints({ mode: 'compute', endpoints: endpoints.slice(0, 1) })).toBeNull();
  });

  it('runs the window from max(departure, now), floored to the hour, to the ETA plus 24 h', () => {
    const nowMs = Date.parse('2026-07-20T06:30:00Z');
    expect(gribWindow({ departureUtc: '2026-07-20T08:45:00Z', etaHours: 10.2, nowMs }))
      .toEqual({ startIso: '2026-07-20T08:00:00Z', endIso: '2026-07-21T19:00:00Z' });
    // a departure in the past starts now
    expect(gribWindow({ departureUtc: '2026-07-19T08:00:00Z', etaHours: 48, nowMs }))
      .toEqual({ startIso: '2026-07-20T06:00:00Z', endIso: '2026-07-23T06:00:00Z' });
    expect(gribWindow({ departureUtc: null, etaHours: NaN, nowMs }).endIso).toBe('2026-07-23T06:00:00Z');
    expect(gribEtaHours({ mode: 'draw', distance: 45, speeds: { slow: 4.5 } })).toBe(10);
    expect(gribEtaHours({ mode: 'draw', distance: null, speeds: { slow: 4.5 } })).toBe(48);
    expect(gribEtaHours({ mode: 'draw', distance: 45, speeds: { slow: '' } })).toBe(48);
    expect(gribEtaHours({ mode: 'compute', computed: { duration_h: 17.5 } })).toBe(17.5);
    expect(gribEtaHours({ mode: 'compute', computed: null })).toBe(48);
  });

  it('extends the window to the end of the longest pinned forecast on request', async () => {
    const nowMs = Date.parse('2026-07-20T06:30:00Z');
    const departureUtc = '2026-07-20T08:45:00Z';
    await store.current.init();
    const manifests = (layer) => store.current.manifestFor(layer);
    // currents run to +240 h; GFS wind (+96 h), ECMWF (+144 h) and IBI (+24 h) end sooner
    expect(gribForecastEnd(manifests)).toBe('2026-07-30T00:00:00Z');
    expect(gribForecastEnd(() => null)).toBeNull();
    const forecastEndIso = gribForecastEnd(manifests);
    expect(gribWindow({ departureUtc, etaHours: 10, nowMs, extent: 'full', forecastEndIso }))
      .toEqual({ startIso: '2026-07-20T08:00:00Z', endIso: '2026-07-30T00:00:00Z' });
    // a departure after every forecast leaves an empty window rather than an invalid one
    expect(gribWindow({ departureUtc: '2026-08-02T00:00:00Z', etaHours: 10, nowMs, extent: 'full', forecastEndIso }))
      .toEqual({ startIso: '2026-08-02T00:00:00Z', endIso: '2026-08-02T00:00:00Z' });
    // until the runs have loaded, the passage window stands in
    expect(gribWindow({ departureUtc, etaHours: 10, nowMs, extent: 'full', forecastEndIso: null }).endIso)
      .toBe('2026-07-21T18:00:00Z');
  });

  it('parses the gribLon override from the hash query and remembers it', () => {
    expect(gribLonConvention('#plan/planner')).toBe('0-360');
    expect(gribLonConvention('#plan/planner?gribLon=signed')).toBe('signed');
    expect(localStorage.getItem(GRIB_LON_STORAGE_KEY)).toBe('signed');
    // in-app navigation drops the query; the setting survives
    expect(gribLonConvention('#plan/planner')).toBe('signed');
    expect(gribLonConvention('#plan/planner?gribLon=bogus')).toBe('signed');
    expect(gribLonConvention('#plan/planner?gribLon=0-360')).toBe('0-360');
    expect(localStorage.getItem(GRIB_LON_STORAGE_KEY)).toBeNull();
    expect(gribLonConvention('#plan/planner')).toBe('0-360');
  });

  it('keeps working when storage is unavailable', () => {
    const blocked = () => { throw new Error('denied'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    expect(gribLonConvention('#plan/planner?gribLon=signed')).toBe('signed');
    expect(gribLonConvention('#plan/planner')).toBe('0-360');
    vi.restoreAllMocks();
  });

  it('formats sizes, grids and coordinates for the file details', () => {
    expect([fmtGribBytes(420), fmtGribBytes(82_400), fmtGribBytes(2_214_000), fmtGribBytes(33_000_000)])
      .toEqual(['1 kB', '82 kB', '2.2 MB', '33 MB']);
    expect([gribSizeBucket(900_000), gribSizeBucket(2e6), gribSizeBucket(6e6), gribSizeBucket(25e6), gribSizeBucket(80e6)])
      .toEqual(['0-1MB', '1-5MB', '5-20MB', '20-50MB', '50MB+']);
    expect(fmtGribGrid({ ni: 97, nj: 37, step_deg: 10 / 120 })).toBe('97 × 37 points · 1/12°');
    expect(fmtGribGrid({ ni: 33, nj: 13, step_deg: 0.25 })).toBe('33 × 13 points · 0.25°');
    expect(fmtGribArea({ south: 48, north: 51, west: -6, east: 2 })).toBe('48°N–51°N, 6°W–2°E');
    expect(fmtLatLon(-33.5, 151.25)).toBe('33.5°S 151.25°E');
  });

  it('flags a regional dataset with unpublished tiles and a horizon shorter than the window', () => {
    const dataset = {
      datasetId: 'currents-ibi', availability: 'ok',
      steps: [{ time: '2026-07-20T08:00:00Z' }, { time: '2026-07-21T00:00:00Z' }],
      tiles: [{ id: 'N50W010', present: true }, { id: 'N40W010', present: false }],
    };
    expect(describeGribDataset(dataset, { endIso: '2026-07-21T10:00:00Z' })).toMatchObject({
      ok: true, steps: 2, first: '2026-07-20T08:00:00Z', last: '2026-07-21T00:00:00Z', horizonShort: true, partial: true,
    });
    expect(describeGribDataset({ ...dataset, datasetId: 'waves-gfs' }, { endIso: '2026-07-21T00:00:00Z' }))
      .toMatchObject({ horizonShort: false, partial: false });
  });
});

describe('Download GRIBs section', () => {
  it('opens from the Passage panel once a route exists and draws the export box', async () => {
    usePlanner.setState({ waypoints: [{ lat: 50.5, lng: -1.5 }] });
    const { rerender } = render(<Planner />);
    expect(panelButton()).toBeDisabled();
    usePlanner.setState({ waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.75, lng: -1.25 }] });
    rerender(<Planner />);
    expect(screen.queryByTestId('export-box')).not.toBeInTheDocument();
    await openSection();
    expect(mapState.rectangle.bounds).toEqual([[49.5, -2.5], [51.75, -0.25]]);
    expect(mapState.rectangle.interactive).toBe(false);
    fireEvent.change(section().getByLabelText('Margin around the route'), { target: { value: '2.5' } });
    expect(mapState.rectangle.bounds).toEqual([[48, -4], [53.25, 1.25]]);
    fireEvent.click(section().getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'GRIB download' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-box')).not.toBeInTheDocument();
  });

  it('closes when the route is cleared, so the next route starts closed', async () => {
    render(<Planner />);
    await openSection();
    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(screen.queryByRole('region', { name: 'GRIB download' })).not.toBeInTheDocument();
    expect(panelButton()).toBeDisabled();
    act(() => usePlanner.setState({ waypoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.75, lng: -1.25 }] }));
    expect(panelButton()).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'GRIB download' })).not.toBeInTheDocument();
  });

  it('shows each dataset’s availability, time range, estimate and coverage notes', async () => {
    render(<Planner />);
    await openSection();
    // 17.8 nm at the slow 4.5 kt ≈ 4 h, + 24 h → 08:00 to 12:00 the next day
    // the window, and GFS wind which covers all of it
    expect(section().getAllByText('Mon 20 Jul 08:00 → Tue 21 Jul 12:00 UTC')).toHaveLength(2);
    const wind = datasetBox('Wind – GFS');
    expect(wind).toBeChecked();
    expect(wind).toBeEnabled();
    const windItem = within(wind.closest('li'));
    expect(windItem.getByText('Mon 20 Jul 08:00 → Tue 21 Jul 12:00 UTC')).toBeInTheDocument();
    expect(windItem.getByText('29 steps')).toBeInTheDocument();
    expect(windItem.getByText(/^\d+ kB$/)).toBeInTheDocument();

    expect(datasetBox('Wind – ECMWF')).toBeDisabled();
    expect(within(datasetBox('Wind – ECMWF').closest('li')).getByText('No data for this area.')).toBeInTheDocument();
    expect(datasetBox('Waves – GFS-Wave')).toBeDisabled();
    expect(within(datasetBox('Waves – GFS-Wave').closest('li')).getByText('Not in the current forecast runs.')).toBeInTheDocument();

    const global = within(datasetBox('Currents – global').closest('li'));
    expect(global.getByText('6-hourly ocean-model currents. Tides are not resolved; do not use as tidal streams.')).toBeInTheDocument();
    const ibi = within(datasetBox('Currents – IBI regional').closest('li'));
    expect(ibi.getByText(/^Partial coverage: this regional model covers only part of the area\./)).toBeInTheDocument();
    expect(ibi.getByText('This forecast ends Tue 21 Jul 00:00 UTC, before the end of your window.')).toBeInTheDocument();
    expect(ibi.getByText('Hourly regional model currents including tide. Not an official tidal-stream prediction.')).toBeInTheDocument();

    expect(section().getByText('Forecast data for planning, not for navigation. Check official forecasts and warnings.')).toBeInTheDocument();
    expect(section().getByText('NOAA/NCEP')).toBeInTheDocument();
    fireEvent.click(datasetBox('Currents – global'));
    expect(section().getByText('Generated using E.U. Copernicus Marine Service Information')).toBeInTheDocument();
    // dev and tests read the local warehouse: an emulated fixture, never the live forecast
    expect(section().getByText('Local test tiles, not the live forecast.')).toBeInTheDocument();
  });

  it('thins to the chosen step and marks datasets whose horizon the dates miss', async () => {
    usePlanner.setState({ departureLocal: toLocalDateTimeValue('2026-07-23T12:00:00Z') });
    render(<Planner />);
    await openSection();
    expect(datasetBox('Currents – IBI regional')).toBeDisabled();
    expect(within(datasetBox('Currents – IBI regional').closest('li')).getByText('Your dates are beyond this forecast’s range.')).toBeInTheDocument();
    // GFS wind (96 h) still reaches the start of the window
    expect(datasetBox('Wind – GFS')).toBeEnabled();
    expect(within(datasetBox('Wind – GFS').closest('li')).getByText(/^This forecast ends Fri 24 Jul 00:00 UTC/)).toBeInTheDocument();
    fireEvent.change(section().getByLabelText('Time step'), { target: { value: '6' } });
    expect(within(datasetBox('Wind – GFS').closest('li')).getByText('3 steps')).toBeInTheDocument();
  });

  it('prepares files, offers Save links and revokes them on regenerate and unmount', async () => {
    const { unmount } = render(<Planner />);
    await openSection();
    fireEvent.click(datasetBox('Currents – global'));
    fireEvent.click(section().getByRole('button', { name: 'Prepare files' }));
    const files = await screen.findByRole('list', { name: 'Prepared GRIB files' });
    const links = within(files).getAllByRole('link', { name: 'Save' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['blob:grib-1', 'blob:grib-2']);
    expect(links[0]).toHaveAttribute('download', 'passage-fixture_wind-gfs_20260720T00Z_N49W003_N52E000.grb2');
    expect(links[0]).toHaveAccessibleDescription('passage-fixture_wind-gfs_20260720T00Z_N49W003_N52E000.grb2');
    expect(links[1].getAttribute('download')).toMatch(/^passage-fixture_currents-global_20260720T00Z_/);
    const blob = URL.createObjectURL.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/octet-stream');
    expect(new TextDecoder().decode((await blob.arrayBuffer()).slice(0, 4))).toBe('GRIB');
    expect(track).toHaveBeenCalledWith('grib_export', { datasets: 'wind-gfs,currents-global', window: 'passage', size_bucket: '0-1MB' });

    // File details: run, grid and the spot values at the route's ends
    const details = within(files.querySelector('li'));
    expect(details.getByText('weather-20260720T00Z')).toBeInTheDocument();
    expect(details.getByText('Mon 20 Jul 00:00 UTC')).toBeInTheDocument();
    expect(details.getByText('0…360°')).toBeInTheDocument();
    expect(details.getByText(/^[0-9a-f]{16}$/)).toBeInTheDocument();
    expect(details.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Time (UTC)', 'Wind (kt)', 'From (°)', 'Gust (kt)', 'Time (UTC)', 'Wind (kt)', 'From (°)', 'Gust (kt)',
    ]);
    expect(details.getAllByText('Start')).toHaveLength(1);

    fireEvent.click(section().getByRole('button', { name: 'Prepare files' }));
    await waitFor(() => expect(URL.revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(['blob:grib-1', 'blob:grib-2']));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Prepared GRIB files' })).getAllByRole('link', { name: 'Save' })[0])
      .toHaveAttribute('href', 'blob:grib-3'));
    unmount();
    expect(URL.revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(['blob:grib-1', 'blob:grib-2', 'blob:grib-3', 'blob:grib-4']);
  });

  it('offers the full forecast: each dataset runs to its own last step', async () => {
    render(<Planner />);
    await openSection();
    const ibi = () => within(datasetBox('Currents – IBI regional').closest('li'));
    expect(ibi().getByText(/^This forecast ends/)).toBeInTheDocument();
    fireEvent.change(section().getByLabelText('Window'), { target: { value: 'full' } });
    expect(section().getByText('Mon 20 Jul 08:00 → Thu 30 Jul 00:00 UTC')).toBeInTheDocument();
    expect(section().getByText(/^From your departure \(or now, if later\) to the end of each forecast/)).toBeInTheDocument();
    const wind = within(datasetBox('Wind – GFS').closest('li'));
    expect(wind.getByText('Mon 20 Jul 08:00 → Fri 24 Jul 00:00 UTC')).toBeInTheDocument();
    expect(wind.getByText('89 steps')).toBeInTheDocument();
    const global = within(datasetBox('Currents – global').closest('li'));
    expect(global.getByText('Mon 20 Jul 06:00 → Thu 30 Jul 00:00 UTC')).toBeInTheDocument();
    // ending before the window is the point of this preset, so no per-dataset note
    expect(section().queryByText(/^This forecast ends/)).not.toBeInTheDocument();

    fireEvent.click(section().getByRole('button', { name: 'Prepare files' }));
    const files = await screen.findByRole('list', { name: 'Prepared GRIB files' });
    expect(within(files).getByText('267')).toBeInTheDocument(); // GRIB messages: 89 steps × 3 variables
    expect(track).toHaveBeenCalledWith('grib_export', { datasets: 'wind-gfs', window: 'full', size_bucket: '0-1MB' });
    fireEvent.change(section().getByLabelText('Window'), { target: { value: 'passage' } });
    expect(screen.queryByRole('list', { name: 'Prepared GRIB files' })).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:grib-1');
  });

  it('drops prepared files when the area changes', async () => {
    render(<Planner />);
    await openSection();
    fireEvent.click(section().getByRole('button', { name: 'Prepare files' }));
    await screen.findByRole('list', { name: 'Prepared GRIB files' });
    fireEvent.change(section().getByLabelText('Margin around the route'), { target: { value: '0.5' } });
    expect(screen.queryByRole('list', { name: 'Prepared GRIB files' })).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:grib-1');
  });

  it('encodes signed longitudes when the tester override is set', async () => {
    history.replaceState(null, '', '/#plan/planner?gribLon=signed');
    render(<Planner />);
    await openSection();
    expect(section().getByText('Longitude test setting: −180 to 180° (signed).')).toBeInTheDocument();
    fireEvent.click(section().getByRole('button', { name: 'Prepare files' }));
    const files = await screen.findByRole('list', { name: 'Prepared GRIB files' });
    expect(within(files).getByText('−180…180°')).toBeInTheDocument();
    expect(localStorage.getItem(GRIB_LON_STORAGE_KEY)).toBe('signed');
  });

  it('keeps run ids and file names intact under the French localiser', async () => {
    store.current = new TileForecastStore({ transport: fixtureTransport({ waves: true }) });
    render(<div id="root"><Planner /><LocalizedDocument language="fr" /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Télécharger des GRIB…' }));
    // the localiser translates added subtrees from a MutationObserver, so wait for it
    const region = await screen.findByRole('region', { name: 'Téléchargement GRIB' });
    const french = () => within(region);
    const waves = await french().findByRole('checkbox', { name: /^Vagues – GFS-Wave/ });
    fireEvent.click(waves);
    fireEvent.click(await french().findByRole('button', { name: 'Préparer les fichiers' }));
    const files = within(await screen.findByRole('list', { name: 'Fichiers GRIB préparés' }));
    // "waves" is a French fragment elsewhere ("vagues"); identifiers must survive it
    expect(files.getByText('waves-20260720T00Z').tagName).toBe('CODE');
    expect(files.getByText('passage-fixture_waves-gfs_20260720T00Z_N49W003_N52E000.grb2').tagName).toBe('CODE');
    expect(await files.findAllByRole('link', { name: 'Enregistrer' })).toHaveLength(2);
    expect(files.getAllByText('Détails du fichier')).toHaveLength(2);
  });

  it('cancels a running export', async () => {
    let release;
    const transport = fixtureTransport();
    const fetchTile = transport.fetchTile.bind(transport);
    transport.fetchTile = (...args) => new Promise((resolve) => { release = () => resolve(fetchTile(...args)); });
    store.current = new TileForecastStore({ transport });
    render(<Planner />);
    await openSection();
    fireEvent.click(section().getByRole('button', { name: 'Prepare files' }));
    const cancel = await section().findByRole('button', { name: 'Cancel' });
    expect(section().getByRole('progressbar', { name: 'GRIB export progress' })).toBeInTheDocument();
    expect(section().getByText('Reading forecast tiles')).toBeInTheDocument();
    expect(datasetBox('Wind – GFS')).toBeDisabled();
    fireEvent.click(cancel);
    release();
    expect(await section().findByText('Cancelled. No files were prepared.')).toBeInTheDocument();
    expect(section().getByRole('button', { name: 'Prepare files' })).toBeEnabled();
    expect(screen.queryByRole('list', { name: 'Prepared GRIB files' })).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith('grib_export', expect.anything());
    fireEvent.change(section().getByLabelText('Time step'), { target: { value: '3' } });
    expect(section().queryByText('Cancelled. No files were prepared.')).not.toBeInTheDocument();
  });

  it('asks for a reload when the pinned run was rotated away', async () => {
    const transport = fixtureTransport();
    transport.fetchTile = async (runId, path) => {
      throw Object.assign(new Error(`forecast fetch failed: HTTP 404 for ${runId}/${path}`), { status: 404 });
    };
    store.current = new TileForecastStore({ transport });
    render(<Planner />);
    await openSection();
    fireEvent.click(section().getByRole('button', { name: 'Prepare files' }));
    expect(await section().findByText('The forecast has been updated. Reload the page and try again.')).toBeInTheDocument();
  });

  it('explains when the forecast runs cannot be loaded, and retries', async () => {
    const transport = fixtureTransport();
    const fetchLatest = transport.fetchLatest.bind(transport);
    transport.fetchLatest = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(fetchLatest);
    store.current = new TileForecastStore({ transport });
    render(<Planner />);
    fireEvent.click(panelButton());
    expect(await section().findByText('The forecast runs are unavailable, so GRIB files can’t be prepared right now.')).toBeInTheDocument();
    fireEvent.click(section().getByRole('button', { name: 'Try again' }));
    expect(await section().findByRole('button', { name: 'Prepare files' })).toBeEnabled();
  });
});
