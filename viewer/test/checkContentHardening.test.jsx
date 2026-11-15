import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerdictChip } from '../src/components/common.jsx';
import RouteMap from '../src/components/RouteMap.jsx';
import SynopticHero from '../src/components/SynopticHero.jsx';
import EnsemblePlume from '../src/components/EnsemblePlume.jsx';
import { VERDICT } from '../src/lib/format.js';
import { chartUrl } from '../src/lib/synopticCharts.js';
import { fitChartView, passageWindowMs } from '../src/lib/synopticView.js';
import { strongestLeg } from '../src/pages/briefing/storyFacts.js';
import { ruleLabel } from '../src/lib/ruleLabels.js';
import { modelStyle } from '../src/lib/modelStyles.js';
import { checkWording, sectionTitle } from '../src/pages/briefing/checkWording.js';
import { translateText } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';
import defaults from '../../config/profiles/default-limits.json';
import findings from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/findings.json';
import route from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/route.json';
import synoptic from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/synoptic.json';
import plume from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/plume.json';

// Check content reaches the page as data the page did not write: a saved check,
// a served one, later an imported file. A damaged or hostile value must render as
// the existing unknown presentation, never throw (2026-11-15 hardening).

vi.mock('../src/lib/preparedRun.js', () => ({ preparedRun: vi.fn(async () => ({ doc: null })), artifactUrl: async (path) => `/data/${path}`, runsBase: () => '/data/' }));
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null, Polyline: () => null, Marker: () => null, Tooltip: () => null,
  useMap: () => ({ attributionControl: { addAttribution: () => {}, removeAttribution: () => {} } }),
}));
const chart = vi.hoisted(() => ({ option: null }));
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: (props) => { chart.option = props.option; return null; } }));

afterEach(() => { cleanup(); useApp.setState(useApp.getInitialState(), true); });

const INHERITED = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];
// 200,000 values: Math.min(...values) throws a RangeError in Node at this length; Safari's limit is lower.
const LONG = 200_000;
const longRoute = () => ({ ...route, waypoints: Array.from({ length: LONG }, (_, i) => ({ lat: 49 + (i % 100) / 100, lon: -4 + (i % 50) / 50 })) });

describe('a verdict state the page does not know', () => {
  it.each(INHERITED)('"%s" renders the existing insufficient chip', (state) => {
    render(<span data-testid="chip"><VerdictChip state={state} small /></span>);
    expect(screen.getByTestId('chip')).toHaveTextContent(`${VERDICT.insufficient.glyph}Models disagree`);
  });
});

describe('lookups keyed by check text', () => {
  it.each(INHERITED)('"%s" falls back like any unknown key', (key) => {
    expect(ruleLabel(key)).toBe('conditions');
    expect(modelStyle(key)).toMatchObject({ label: key });
    expect(sectionTitle({ title: key })).toBe(key);
    expect(checkWording(key)).toBe(key);
    expect(translateText(key, 'fr')).toBe(key);
  });

  it('keeps every known translation and label', () => {
    expect(ruleLabel('W-GUST-01')).toBe('gusts');
    expect(modelStyle('ecmwf_ifs025').label).not.toBe('ecmwf_ifs025');
    expect(translateText('My passages', 'fr')).toBe('Mes traversées');
    expect(translateText('gusts', 'fr')).toBe('rafales');
  });
});

describe(`a check with ${LONG.toLocaleString('en')} points`, () => {
  it('draws its route map', async () => {
    useApp.setState({ profileDefaults: defaults, loadConfig: vi.fn(), loadManifest: vi.fn(), findings, route: longRoute() });
    render(<RouteMap />);
    await act(async () => {});
    expect(screen.getByTestId('map')).toBeInTheDocument();
  });

  it('draws its synoptic schematic', () => {
    useApp.setState({ findings, synoptic: { ...synoptic, chart_captions: [] }, route: longRoute() });
    render(<SynopticHero />);
    expect(screen.getByRole('img', { name: /track and route occupancy/ })).toBeInTheDocument();
  });

  it('draws its scenario plume', () => {
    const leg = plume.legs[0];
    const members = Array.from({ length: LONG / 2 }, () => [12, 14]);
    useApp.setState({ findings, plume: { ...plume, legs: [{ ...leg, times: leg.times.slice(0, 2), wind_members: members, gust_members: members }] } });
    render(<EnsemblePlume evidence={{ leg_id: leg.leg_id, limit: 20, units: 'kt' }} variable="wind" />);
    expect(chart.option).not.toBeNull();
  });

  it('frames its chart, spans its passage and names its strongest leg', () => {
    const points = Array.from({ length: LONG }, (_, i) => ({ x: i % 1000, y: i % 700 }));
    expect(fitChartView({ container: { w: 800, h: 600 }, image: { w: 1200, h: 900 }, points }).scale).toBeGreaterThan(0);
    const legs = Array.from({ length: LONG }, (_, i) => ({ eta_range: { nominal: new Date(Date.parse(findings.departure_utc) + i * 1000).toISOString() } }));
    expect(passageWindowMs({ departure_utc: findings.departure_utc, legs }).end).toBe(Date.parse(findings.departure_utc) + (LONG - 1) * 1000);
    const hours = Array.from({ length: LONG }, (_, i) => ({ valid_time: findings.departure_utc, gust_kt: i % 30, wind_kt: i % 20 }));
    const strongest = strongestLeg({ ...findings, legs: [{ ...findings.legs[0], enter_range: undefined, eta_range: undefined, hours }] });
    expect(strongest).toMatchObject({ gust: 29, wind: 19 });
  });
});

describe('chart image addresses', () => {
  it('accepts every chart path the committed fixtures and prepared runs use', () => {
    expect(chartUrl('charts/t000.png', 'snapshot_v2_406ad333228b0a73')).toBe('/data/snapshots/snapshot_v2_406ad333228b0a73/charts/t000.png');
    expect(chartUrl('charts/t024.png', '20260720T060000Z_44d2cd5f_64ea971e')).toBe('/data/snapshots/20260720T060000Z_44d2cd5f_64ea971e/charts/t024.png');
    for (const file of [
      'runs/ecmwf-ifs025-20260916T00Z/synoptic/charts/t048.png',
      `runs/ecmwf-ifs025-20260916T00Z/synoptic/charts/t000.${'a'.repeat(64)}.png`,
      'runs/ecmwf-ifs025-20260901T00Z/chart.legacy.png',
      'runs/missing/chart.png',
    ]) expect(chartUrl(file, 'saved')).toBe(`/data/${file}`);
  });

  it.each([
    'runs/../secret.png', 'charts/../../x.png', 'runs/a/../b.png', '..', 'charts/..',
    'https://example.com/chart.png', '//example.com/chart.png', '/data/charts/t000.png', 'javascript:alert(1).png',
    'charts/t000.svg', 'charts/t000.png.html', 'runs/t000.PNG', 'charts/t000', 'charts/.png',
    'charts/t 000.png', 'charts/t000.png?x=1', 'charts/t000.png#x', 'charts\\t000.png', 'charts/t%2e%2e.png', 'charts/tö.png',
    'other/t000.png', 'chartsX/t000.png', 42, {}, ['charts/t000.png'], null, undefined, '',
  ])('gives no image for %j', (file) => {
    expect(chartUrl(file, 'snapshot_v2_406ad333228b0a73')).toBeNull();
  });

  it('gives no image for a snapshot-local chart of a check whose id is not a check id', () => {
    expect(chartUrl('charts/t000.png', '../runs')).toBeNull();
    expect(chartUrl('charts/t000.png', undefined)).toBeNull();
  });
});
