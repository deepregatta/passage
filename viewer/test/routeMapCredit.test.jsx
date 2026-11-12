import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useApp } from '../src/stores/appStore.js';
import RouteMap from '../src/components/RouteMap.jsx';
import { translateText } from '../src/i18n.js';
import { preparedRun } from '../src/lib/preparedRun.js';
import defaults from '../../config/profiles/default-limits.json';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import route from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/route.json';

// The map draws wind arrows from the prepared ECMWF wind grid, so while they are shown the map's
// attribution credits ECMWF (short form, with the licence link); the full sentence is on the chart
// and the GRIB page. Without the grid there are no arrows and no credit.
const control = { added: [], addAttribution: vi.fn((html) => control.added.push(html)), removeAttribution: vi.fn((html) => {
  control.added = control.added.filter((item) => item !== html);
}) };
vi.mock('../src/lib/preparedRun.js', () => ({ preparedRun: vi.fn(), artifactUrl: async (path) => `/data/${path}`, runsBase: () => '/data/' }));
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null, Polyline: () => null, Marker: () => null, Tooltip: () => null,
  useMap: () => ({ attributionControl: control }),
}));

const windGrid = {
  schema_version: 1, kind: 'wind10m', run_id: 'ecmwf-ifs025-20260720T00Z', generated_at: '2026-07-20T07:00:00Z',
  lat0: 47, lon0: -6, dlat: 0.5, dlon: 0.5, nlat: 10, nlon: 10,
  time_axis: ['2026-07-20T00:00:00Z', '2026-07-22T00:00:00Z'],
  u_kt: Array(200).fill(8), v_kt: Array(200).fill(6),
  source: { mode: 'live', dataset_id: 'ifs-0.25-open-data', resolution_deg: 0.25, fetched_at: '2026-07-20T07:00:00Z' },
};

beforeEach(() => {
  control.added = [];
  control.addAttribution.mockClear();
  control.removeAttribution.mockClear();
  useApp.setState({ ...useApp.getInitialState(), profileDefaults: defaults, loadConfig: vi.fn(), loadManifest: vi.fn(), findings, route }, true);
  vi.stubGlobal('fetch', vi.fn(async (url) => new Response(JSON.stringify(String(url).endsWith('wind_grid.json') ? windGrid : null))));
});

it('credits ECMWF in the map attribution while its wind arrows are shown', async () => {
  preparedRun.mockResolvedValue({ doc: { artifacts: { wind_grid: 'runs/ecmwf-ifs025-20260720T00Z/wind_grid.json' } } });
  render(<RouteMap />);
  await act(async () => {});
  expect(screen.getByTestId('map')).toBeVisible();
  expect(control.added).toHaveLength(1);
  const html = control.added[0];
  expect(html).toContain('ECMWF open data');
  expect(html).toContain('href="https://creativecommons.org/licenses/by/4.0/"');
  expect(html).toContain('CC BY 4.0');
  expect(html).toContain('(modified)');
  // the provider's credit is owned (never translated); only Passage's word is
  expect(html).toMatch(/data-i18n-owned="message"[^>]*>[^<]*ECMWF open data/);
  expect(html).not.toMatch(/data-i18n-owned="message"[^>]*>[^<]*modified/);
  expect(translateText('(modified)', 'fr')).toBe('(modifié)');
});

it('removes the credit again when the arrows go away', async () => {
  preparedRun.mockResolvedValue({ doc: { artifacts: { wind_grid: 'runs/ecmwf-ifs025-20260720T00Z/wind_grid.json' } } });
  const view = render(<RouteMap />);
  await act(async () => {});
  expect(control.added).toHaveLength(1);
  view.unmount();
  expect(control.added).toEqual([]);
});

it('adds no ECMWF credit without a prepared wind grid', async () => {
  preparedRun.mockResolvedValue({ doc: null });
  render(<RouteMap />);
  await act(async () => {});
  expect(screen.getByTestId('map')).toBeVisible();
  expect(control.addAttribution).not.toHaveBeenCalled();
});

it('keeps the OpenStreetMap and OpenSeaMap credits translating when the ECMWF credit follows them', () => {
  // Leaflet joins the layers' attributions with ", ", so the OpenSeaMap text node then ends in a comma.
  expect(translateText('contributors, seamarks © OpenSeaMap', 'fr')).toBe('contributeurs, balisage © OpenSeaMap');
  expect(translateText('contributors, seamarks © OpenSeaMap,', 'fr')).toBe('contributeurs, balisage © OpenSeaMap,');
});
