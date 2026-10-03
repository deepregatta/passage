import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { runAnalysis, contentHash } from '@deepweather/engine';
import { prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
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
  expect(result.findings.inputs.route_hash).toBe(action.routeRevision);
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
