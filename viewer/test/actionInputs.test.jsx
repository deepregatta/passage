import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { runAnalysis, contentHash } from '@deepweather/engine';
import { prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
import { loadPreparedCurrent } from '../src/lib/preparedCurrent.js';
import { preparedRun } from '../src/lib/preparedRun.js';
import { captureActionDraft } from '../src/lib/actionInputs.js';
import { useApp } from '../src/stores/appStore.js';
import ModelsUsed from '../src/components/ModelsUsed.jsx';
import limits from '../../config/profiles/default-limits.json';
import { auditStore, routingInputs, DEPARTURE } from './fixtures/routingTiming.js';

const state = vi.hoisted(() => ({ store: null }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => state.store }));
const route = { schema_version: 1, route_id: 'scratch', name: 'Scratch', mode: 'user',
  waypoints: [{ id: 'a', lat: 49.5, lon: -3.5 }, { id: 'b', lat: 49.5, lon: -3.2 }], speeds_kt: { slow: 4, nominal: 5, fast: 6 } };
const prepared = (id, extra = {}) => ({ ...routingInputs(0).currentGrid, run_id: id, ...extra });
const pointer = id => ({ run_id: id, model: 'cmems', artifacts: { current_grid: `runs/${id}/current.json` } });
let docs;
let latest;
beforeEach(async () => {
  const engine = await vi.importActual('@deepweather/engine');
  state.store = auditStore(engine, prepared('tile-current'));
  vi.spyOn(state.store, 'getCurrentGrid');
  latest = 'prepared-a';
  docs = { 'prepared-a': prepared('prepared-a'), 'prepared-b': prepared('prepared-b', { u_kt: Array(24).fill(1) }) };
  vi.stubGlobal('fetch', vi.fn(async url => {
    const doc = url === '/data/runs/latest.json' ? pointer(latest)
      : url.includes('/current.json') ? docs[url.split('/')[3]] : undefined;
    return new Response(JSON.stringify(doc ?? null), { status: doc ? 200 : 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());
const draft = () => captureActionDraft({ route, profile: limits, departureUtc: DEPARTURE });

it('freezes user revisions, selected artifact digests and optional context before evaluation', async () => {
  const mutable = structuredClone({ route, profile: limits, departureUtc: DEPARTURE });
  const captured = captureActionDraft(mutable);
  const action = await prepareAnalysisInputs(captured);
  mutable.profile.max_gust_kt = 19;
  mutable.route.waypoints[0].lat = 40;
  expect(action.profile.max_gust_kt).toBe(28);
  expect(action.route.waypoints[0].lat).toBe(49.5);
  expect(Object.isFrozen(action.profile.max_sustained_kt)).toBe(true);
  const result = await runAnalysis(action);
  expect(result.findings.route_revision).toBe(action.routeRevision);
  expect(result.findings.inputs.profile_hash).toBe(action.profileRevision);
  expect(result.findings.inputs.forecast_tiles.find(x => x.layer === 'currents')).toMatchObject({
    run_id: 'prepared-a', current_source: 'prepared', artifact_ref: 'runs/prepared-a/current.json', content_digest: contentHash(docs['prepared-a']),
  });
});

it('refreshes the next action while a running action uses only its pinned prepared artifact', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const original = state.store.getPointForecasts.bind(state.store);
  const reads = vi.spyOn(state.store, 'getPointForecasts').mockImplementation(async (...args) => { await held; return original(...args); });
  const first = await prepareAnalysisInputs(draft());
  const pending = runAnalysis(first);
  await vi.waitFor(() => expect(reads).toHaveBeenCalledOnce());
  latest = 'prepared-b'; // new pointer available while the first audit is reading weather
  release();
  const resultA = await pending;
  const next = await prepareAnalysisInputs(draft());
  const resultB = await runAnalysis(next);
  expect(resultA.findings.inputs.forecast_tiles.find(x => x.layer === 'currents').run_id).toBe('prepared-a');
  expect(resultB.findings.inputs.forecast_tiles.find(x => x.layer === 'currents').run_id).toBe('prepared-b');
  expect(first.currentGrid.run_id).toBe('prepared-a');
  expect(fetch.mock.calls.filter(([url]) => url === '/data/runs/latest.json')).toHaveLength(2);
});

it('recovers a failed prepared discovery on the next real action', async () => {
  fetch.mockRejectedValueOnce(new Error('offline'));
  const first = await prepareAnalysisInputs(draft());
  expect(first.currentGrid).toBeUndefined();
  const recovered = await prepareAnalysisInputs(draft());
  expect(recovered.currentGrid.run_id).toBe('prepared-a');
});

it.each(['outside', 'expired', 'all missing'])('renders truthful real ModelsUsed coverage after %s prepared data and zero tile samples', async kind => {
  docs['prepared-a'] = prepared('prepared-a', kind === 'outside' ? { lat0: 39 } : kind === 'expired'
    ? { time_axis: ['2026-07-18T00:00Z', '2026-07-19T00:00Z'] } : { u_kt: Array(24).fill(null) });
  state.store.getCurrentGrid.mockResolvedValue(prepared('tile-current', { u_kt: Array(24).fill(null) }));
  const action = await prepareAnalysisInputs(draft());
  const result = await runAnalysis(action);
  act(() => useApp.setState({ findings: result.findings }));
  render(<ModelsUsed />);
  fireEvent.click(screen.getByText('Models and coverage'));
  const row = within(screen.getByRole('region', { name: 'Recorded coverage' })).getByText('tidal currents').closest('li');
  expect(within(row).getByText('not assessed')).toBeVisible();
  expect(state.store.getCurrentGrid).toHaveBeenCalledOnce();
  expect(result.findings.inputs.forecast_tiles.find(x => x.layer === 'currents')).toMatchObject({ current_source: 'tiles', run_id: 'tile-current' });
});

it('fails the whole action when a tile run changes during a read', async () => {
  let revision = 'a';
  state.store.describe = () => ({ weather: { run_id: revision } });
  const original = state.store.getPointForecasts.bind(state.store);
  state.store.getPointForecasts = async (...args) => { revision = 'b'; return original(...args); };
  const action = await prepareAnalysisInputs(draft());
  await expect(runAnalysis(action)).rejects.toMatchObject({ code: 'forecast-updated' });
});

it.each(['assessed', 'partially_assessed'])('corrects archived zero-sample %s coverage on read without changing saved data', async status => {
  docs['prepared-a'] = prepared('prepared-a', { u_kt: Array(24).fill(null) });
  state.store.getCurrentGrid.mockResolvedValue(prepared('tile-current', { u_kt: Array(24).fill(null) }));
  const result = await runAnalysis(await prepareAnalysisInputs(draft()));
  const archived = structuredClone(result.findings);
  archived.coverage.find(item => item.capability === 'tidal_currents').status = status;
  const bytes = JSON.stringify(archived);
  act(() => useApp.setState({ findings: archived }));
  render(<ModelsUsed />);
  fireEvent.click(screen.getByText('Models and coverage'));
  const row = within(screen.getByRole('region', { name: 'Recorded coverage' })).getByText('tidal currents').closest('li');
  expect(within(row).getByText('not assessed')).toBeVisible();
  expect(JSON.stringify(archived)).toBe(bytes);
});

// C1: Compute loads the prepared grid through the same loader as the Check, so
// a computed route and its own Check name one current source and grid.
it.each([
  ['prepared', 'the routing area', {}],
  // Covers the route's own samples, not the area the router searches.
  ['tiles', 'only a corridor', { lat0: 49.4, lon0: -3.55, dlat: 0.1, dlon: 0.2, nlat: 3, nlon: 3, u_kt: Array(18).fill(1), v_kt: Array(18).fill(0) }],
])('computes and then checks a route on %s when the prepared grid covers %s', async (source, _, extra) => {
  const engine = await vi.importActual('@deepweather/engine');
  docs['prepared-a'] = prepared('prepared-a', { u_kt: Array(24).fill(1), ...extra });
  const inputs = routingInputs(0);
  const tileGrid = await state.store.getCurrentGrid();
  const preparedCurrent = await loadPreparedCurrent((await preparedRun({ refresh: true })).doc);
  const selection = engine.selectRoutingCurrent({
    departures: [DEPARTURE], tileGrid, prepared: preparedCurrent.currentGrid, preparedProvenance: preparedCurrent.currentGridProvenance,
    route: (departureUtc, currentGrid, strictCurrent) => engine.computeRoute({ ...inputs, departureUtc, currentGrid, ...(strictCurrent ? { strictCurrent } : {}) }),
  });
  const routed = selection.results.get(DEPARTURE).result.route;
  state.store.getCurrentGrid.mockClear();
  const check = await runAnalysis(await prepareAnalysisInputs(captureActionDraft({ route: routed, profile: limits, departureUtc: DEPARTURE })));
  const record = check.findings.inputs.forecast_tiles.find(x => x.layer === 'currents');
  expect(selection.currentInput.provenance.current_source).toBe(source);
  expect(record.current_source).toBe(source);
  expect(record.run_id).toBe(selection.currentInput.grid.run_id);
  if (source === 'prepared') {
    expect(record).toMatchObject({ artifact_ref: 'runs/prepared-a/current.json', content_digest: selection.currentInput.provenance.content_digest });
    expect(state.store.getCurrentGrid).not.toHaveBeenCalled();
  } else {
    // The corridor alone would have admitted prepared currents for this Check.
    expect(record.fallback_reason).toBe('route was computed on tile currents');
  }
});

// 2026-11-13: the loader deep-freezes the prepared grid and hashes it once; the
// Compute selection and the Check's admission reuse that digest. canonicalJson
// reads a grid's entries once each time it serialises it, which is what is counted.
it('hashes a loaded prepared grid once for Compute, and once for a Check plus its saved decision hash', async () => {
  const engine = await vi.importActual('@deepweather/engine');
  docs['prepared-a'] = prepared('prepared-a', { u_kt: Array(24).fill(1) });
  const expected = contentHash(structuredClone(docs['prepared-a']));
  const entries = vi.spyOn(Object, 'entries');
  const serialised = grid => entries.mock.calls.filter(([arg]) => arg === grid).length;
  const inputs = routingInputs(0);
  const preparedCurrent = await loadPreparedCurrent((await preparedRun({ refresh: true })).doc);
  const selection = engine.selectRoutingCurrent({
    departures: [DEPARTURE], tileGrid: await state.store.getCurrentGrid(), prepared: preparedCurrent.currentGrid, preparedProvenance: preparedCurrent.currentGridProvenance,
    route: (departureUtc, currentGrid, strictCurrent, searchBounds) => engine.computeRoute({ ...inputs, departureUtc, currentGrid,
      ...(strictCurrent ? { strictCurrent } : {}), ...(searchBounds ? { searchBounds } : {}) }),
  });
  expect(selection.currentInput.provenance).toMatchObject({ current_source: 'prepared', content_digest: expected });
  expect(preparedCurrent.currentGridProvenance.content_digest).toBe(expected);
  expect(serialised(preparedCurrent.currentGrid)).toBe(1);

  const action = await prepareAnalysisInputs(captureActionDraft({ route: selection.results.get(DEPARTURE).result.route, profile: limits, departureUtc: DEPARTURE }));
  const check = await runAnalysis(action);
  expect(check.findings.inputs.forecast_tiles.find(x => x.layer === 'currents')).toMatchObject({ current_source: 'prepared', content_digest: expected });
  // its own record, then the grid inside the decision inputs that the saved identity hashes
  expect(serialised(action.currentGrid)).toBe(2);
});
