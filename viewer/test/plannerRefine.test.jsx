// D2: refining the departure comparison on show. An explicit action, never
// automatic; it runs where the comparison ran, with the same progress and stop;
// it refuses, with a plain reason, when the comparison's forecast or limits are
// no longer the page's or its inputs are gone; refined times appear as a second
// row under their day.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeRoute, ForecastRunGoneError } from '@deepweather/engine';
import Planner from '../src/pages/Planner.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { useApp } from '../src/stores/appStore.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { refineHeld, releaseRefinable, resetScanWorker, runRefineJob, runScanJob, ScanCancelledError } from '../src/lib/scanRunner.js';
import { RefineUnavailableError } from '../src/lib/scanMessages.js';
import { fmtLocalTime, toLocalDateTimeValue } from '../src/lib/format.js';
import { translateText } from '../src/i18n.js';
import limits from '../../config/profiles/default-limits.json';

const mapEvents = vi.hoisted(() => ({ click: null, fitBounds: vi.fn(), eachLayer: () => {}, on: () => {}, off: () => {} }));
const page = vi.hoisted(() => ({ runs: { weather: { layer: 'weather', run_id: 'w1' } } }));
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null, Marker: () => null,
  Polyline: () => <div data-testid="route-line" />, useMap: () => mapEvents,
  useMapEvents: (events) => { mapEvents.click = events.click; },
}));
vi.mock('../src/components/BoatPicker.jsx', () => ({ default: () => null }));
vi.mock('../src/lib/routingInputs.js', async (original) => ({ ...await original(), loadRoutingInputs: vi.fn() }));
vi.mock('../src/lib/browserAnalysis.js', () => ({ analyzeInBrowser: vi.fn(), saveRoute: vi.fn(), prepareAnalysisInputs: vi.fn() }));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn() }));
// The page's store: only its pinned runs matter here.
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => ({ describe: () => page.runs }) }));
vi.mock('@deepweather/engine', async (original) => ({ ...await original(), computeRoute: vi.fn() }));
vi.mock('../src/lib/scanRunner.js', async (original) => ({
  ...await original(), runScanJob: vi.fn(), runRefineJob: vi.fn(), refineHeld: vi.fn(), releaseRefinable: vi.fn(),
}));

const H = 3600_000;
const START = Date.parse('2026-09-15T06:00:00Z');
const at = (h) => new Date(START + h * H).toISOString().replace(/\.\d{3}Z$/, 'Z');
const candidate = (h, extra = {}) => ({
  departure_utc: at(h), verdict: 'exceeds', worst_ratio: 1.4, max_fraction: null, ensemble_covered: false, max_members: null,
  driver_summary: null, passage_h: 2, arrival_hours_over_limit: 6, arrival_hours_approaching: 0, arrival_hours_no_data: 0,
  expected_hours_over_limit: 6, ...extra,
});
const calm = { verdict: 'within', worst_ratio: 0.5, arrival_hours_over_limit: 0, expected_hours_over_limit: 0 };
const routed = (departureUtc) => ({
  route: { schema_version: 1, route_id: 'computed', name: 'Computed', mode: 'computed',
    waypoints: [{ id: 'a', lat: 50.5, lon: -1.5 }, { id: 'b', lat: 50.6, lon: -1.4 }], speeds_kt: { slow: 4, nominal: 5, fast: 6 } },
  distance_nm: 12.3, duration_h: 2, avg_sog_kt: 6.15, arrival_utc: new Date(Date.parse(departureUtc) + 2 * H).toISOString(),
});
// Four 6-hourly times; 12 h after the start is marked, nothing tied: a refinement adds 8, 10, 14 and 16 h.
const COARSE = [0, 6, 12, 18].map((h) => candidate(h, h === 12 ? calm : {}));
const SCANNED = {
  scan: { candidates: COARSE, best_index: 2, skipped: [] },
  routes: Object.fromEntries(COARSE.map((c) => [c.departure_utc, routed(c.departure_utc)])),
  notes: ['note'], currents: null, rerouted: true, requested: 21, scanId: 5, forecastRuns: page.runs,
  dateWindow: { startDate: '2026-09-15', endDate: '2026-09-21' },
};
// The merged comparison: 14 h (a refined time) is now marked, 10 h (refined) tied with it.
const MERGED = [0, 6, 8, 10, 12, 14, 16, 18].map((h) => candidate(h, {
  ...(h === 12 ? { ...calm, worst_ratio: 0.6 } : {}),
  ...(h === 14 ? { ...calm, worst_ratio: 0.3 } : {}),
  ...(h === 10 ? { ...calm, worst_ratio: 0.32 } : {}),
}));
const ADDED = [8, 10, 14, 16].map(at);
const REFINED = {
  scan: { candidates: MERGED, best_index: 5, skipped: [] },
  routes: Object.fromEntries(ADDED.map((d) => [d, routed(d)])), notes: ['note'], currents: null,
  added: ADDED, around: [at(12)], requested: 4,
};

const refineButton = () => screen.queryByRole('button', { name: /^(Refine around the least-exposure times|Refining…)$/ });
let job;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T09:00:00Z'));
  vi.resetAllMocks();
  localStorage.clear();
  page.runs = { weather: { layer: 'weather', run_id: 'w1' } };
  usePlanner.getState().reset();
  usePlanner.setState({ mode: 'compute', polarId: 'sun-fast-3200', polarLabel: 'SUN FAST 3200',
    departureLocal: toLocalDateTimeValue(at(0)), endpoints: [{ lat: 50.5, lng: -1.5 }, { lat: 50.6, lng: -1.4 }] });
  useApp.setState({ manifest: { snapshots: [] }, profileDefaults: limits, limits, language: 'en', loadConfig: vi.fn(), openSnapshot: vi.fn() });
  loadRoutingInputs.mockResolvedValue({ notes: [], maxHours: 48 });
  computeRoute.mockImplementation(({ departureUtc }) => routed(departureUtc));
  runScanJob.mockResolvedValue({ ...SCANNED, forecastRuns: page.runs });
  refineHeld.mockImplementation((id) => id === 5);
  runRefineJob.mockImplementation((scanId, options) => new Promise((resolve, reject) => {
    job = { scanId, options, resolve, reject };
    options.signal?.addEventListener('abort', () => reject(new ScanCancelledError()));
  }));
  render(<Planner />);
  fireEvent.click(screen.getByRole('button', { name: /^Compute route$/ }));
  await waitFor(() => expect(usePlanner.getState().computed).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: /^Compare departure times \(next 5 days\)$/ }));
  await screen.findByRole('region', { name: 'Departure comparison' });
});
afterEach(() => vi.useRealTimers());

const comparison = () => screen.getByRole('region', { name: 'Departure comparison' });
const cellAt = (h) => within(comparison()).getAllByRole('button').find((b) => b.title.startsWith(fmtLocalTime(at(h))));

it('offers one explicit refinement after a comparison, saying how many times it adds; never runs it by itself', async () => {
  expect(refineButton()).toBeEnabled();
  // no time has scenario evidence: only the Typical ranking's marks, so no "in either ranking"
  expect(screen.getByText('Adds 4 departure times, every 2 h within 6 h of each ◎ or ≈ time, from the same forecast as this comparison.')).toBeInTheDocument();
  expect(runRefineJob).not.toHaveBeenCalled();
  expect(releaseRefinable).not.toHaveBeenCalled();
  expect(within(comparison()).queryByTestId('refined-row')).toBeNull();
});

it('runs with its own progress and stop, then shows the refined times in a second row with the marks and tooltips', async () => {
  fireEvent.click(refineButton());
  await waitFor(() => expect(runRefineJob).toHaveBeenCalledWith(5, expect.objectContaining({ signal: expect.any(AbortSignal) })));
  act(() => job.options.onProgress('routing departures 2/4'));
  expect(within(comparison()).getByText('Routing departures 2/4…')).toBeInTheDocument();
  act(() => job.options.onProgress('scanning departures 3/4'));
  expect(within(comparison()).getByText('Comparing departure times 3/4…')).toBeInTheDocument();
  expect(within(comparison()).getByRole('button', { name: 'Stop refining' })).toBeInTheDocument();
  expect(screen.getByTestId('planner-action-bar').querySelector('button')).toHaveTextContent('Stop refining');
  // the comparison stays on show while it refines, its times not pickable
  expect(cellAt(12)).toBeDisabled();
  await act(async () => job.resolve(REFINED));

  const rows = within(comparison()).getAllByTestId('refined-row');
  const refinedCells = rows.flatMap((row) => within(row).getAllByRole('button'));
  expect(refinedCells.map((b) => b.title.slice(0, fmtLocalTime(at(8)).length))).toEqual(ADDED.map((d) => fmtLocalTime(d)));
  expect(refinedCells.every((b) => b.dataset.refined === 'true' && b.title.includes('added by refining'))).toBe(true);
  // 6-hourly cells stay in the first row, unmarked as refined
  expect(cellAt(12).dataset.refined).toBeUndefined();
  expect(cellAt(12).title).not.toContain('added by refining');
  // the mark and the tie can sit on refined times
  expect(cellAt(14)).toHaveTextContent('◎');
  expect(cellAt(10)).toHaveTextContent('≈');
  expect(cellAt(10).title).toContain('effectively tied with the least-exposure time');
  expect(within(comparison()).getByText(`◎ Least exposure this window: ${fmtLocalTime(at(14))} local time`)).toBeInTheDocument();
  expect(within(comparison()).getByText('second row: added by refining, every 2 h')).toBeInTheDocument();
  expect(within(comparison()).getByText('Refined: 4 more departure times compared, every 2 h around the ◎ and ≈ times. They are in a second row under their day.')).toBeInTheDocument();
  // one refinement per comparison: the action is gone
  expect(refineButton()).toBeNull();
  const scan = usePlanner.getState().scan;
  expect(scan).toMatchObject({ requested: 25, refined: { departures: ADDED, around: [at(12)] }, scanId: 5 });
  expect(scan.routes[at(14)]).toMatchObject({ notes: ['note'], inputKey: expect.any(String) });
  expect(Object.keys(scan.routes)).toHaveLength(8);
  // a refined time is picked like any other, and the comparison stays
  fireEvent.click(cellAt(14));
  await waitFor(() => expect(usePlanner.getState().departureLocal).toBe(toLocalDateTimeValue(at(14))));
  expect(usePlanner.getState().scan?.refined).toBeTruthy();
});

it('counts only the added times that were assessed; the others are listed as unassessed', async () => {
  fireEvent.click(refineButton());
  await waitFor(() => expect(runRefineJob).toHaveBeenCalled());
  const reason = 'This departure time leaves the current grid used by the rest of the comparison.';
  await act(async () => job.resolve({ ...REFINED,
    scan: { candidates: MERGED.filter((c) => c.departure_utc !== at(16)), best_index: 5, skipped: [{ departure_utc: at(16), reason }] } }));
  expect(within(comparison()).getByText('Refined: 3 more departure times compared, every 2 h around the ◎ and ≈ times. They are in a second row under their day.')).toBeInTheDocument();
  expect(within(comparison()).getByText(/^\d+ of 25 departure times could not be assessed/)).toBeInTheDocument(); // 21 asked first, 4 added
  expect(within(comparison()).getByText(reason)).toBeInTheDocument();
});

it('says "in either ranking" only when the Cautious ranking\'s marks are refined around too', async () => {
  const covered = COARSE.map((c, i) => ({ ...c, ensemble_covered: true, max_fraction: i === 0 ? 0 : 0.3 }));
  act(() => usePlanner.setState({ scan: { ...usePlanner.getState().scan, candidates: covered } }));
  // scenario evidence: the Cautious ranking's marks are refined around as well (here the same time)
  expect(within(comparison()).getByText('Adds 4 departure times, every 2 h within 6 h of each ◎ or ≈ time in either ranking, from the same forecast as this comparison.')).toBeInTheDocument();
  expect(translateText('Adds 8 departure times, every 2 h within 6 h of each ◎ or ≈ time, from the same forecast as this comparison.', 'fr'))
    .toBe('Ajoute 8 heures de départ, toutes les 2 h à moins de 6 h de chaque heure ◎ ou ≈, sur la même prévision que cette comparaison.');
});

it('says when none of the added times could be assessed, with no second row', async () => {
  fireEvent.click(refineButton());
  await waitFor(() => expect(runRefineJob).toHaveBeenCalled());
  const reason = 'This departure time leaves the current grid used by the rest of the comparison.';
  await act(async () => job.resolve({ ...REFINED,
    scan: { candidates: COARSE, best_index: 2, skipped: ADDED.map((departure_utc) => ({ departure_utc, reason })) } }));
  expect(within(comparison()).getByText('Refined: none of the added departure times could be assessed. They are listed under Unassessed departures.')).toBeInTheDocument();
  expect(within(comparison()).queryByTestId('refined-row')).toBeNull();
  expect(within(comparison()).queryByText(/second row/)).toBeNull();
  expect(translateText('Refined: none of the added departure times could be assessed. They are listed under Unassessed departures.', 'fr'))
    .toBe('Affinage\u00A0: aucune des heures de départ ajoutées n’a pu être évaluée. Elles figurent sous Départs non évalués.');
});

it('releases the held inputs when the comparison is dropped, cleared or left, or its forecast was replaced; not for changed limits', async () => {
  act(() => useApp.setState({ limits: { ...limits, max_gust_kt: limits.max_gust_kt + 5 } }));
  expect(releaseRefinable).not.toHaveBeenCalled(); // limits can be changed back
  act(() => useApp.setState({ limits }));
  page.runs = { weather: { layer: 'weather', run_id: 'w2' } };
  act(() => usePlanner.getState().patch({ name: 'Solent hop' }));
  expect(releaseRefinable).toHaveBeenCalledWith(5); // replaced runs never come back
  releaseRefinable.mockClear();
  page.runs = { weather: { layer: 'weather', run_id: 'w1' } };
  act(() => usePlanner.getState().patch({ polarPercent: 90 })); // the comparison is no longer current
  await waitFor(() => expect(usePlanner.getState().scan).toBeNull());
  expect(releaseRefinable).toHaveBeenCalledWith(5);
});

it('releases them on Clear and when the planner is left', async () => {
  fireEvent.click(screen.getByRole('button', { name: 'clear' }));
  await waitFor(() => expect(usePlanner.getState().scan).toBeNull());
  expect(releaseRefinable).toHaveBeenCalledWith(5);
  // a new comparison, then the page goes
  fireEvent.click(screen.getByRole('button', { name: 'Undo clear' }));
  await waitFor(() => expect(usePlanner.getState().computed).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: /^Compare departure times \(next 5 days\)$/ }));
  await screen.findByRole('region', { name: 'Departure comparison' });
  releaseRefinable.mockClear();
  cleanup();
  expect(releaseRefinable).toHaveBeenCalledWith(5);
});

it('turns unavailable as soon as the runner drops the inputs (a Worker that failed between jobs)', async () => {
  expect(refineButton()).toBeEnabled();
  refineHeld.mockReturnValue(false);
  act(() => resetScanWorker()); // the runner's slot changes and tells its subscribers
  expect(refineButton()).toBeDisabled();
  expect(within(comparison()).getByText('This comparison can no longer be refined. Compare again to refine.')).toBeInTheDocument();
});

it('shows each message once: a failure or a "stopped" notice is not repeated as the reason', async () => {
  runRefineJob.mockRejectedValueOnce(new RefineUnavailableError());
  refineHeld.mockImplementation((id) => id === 5 && runRefineJob.mock.calls.length === 0);
  fireEvent.click(refineButton());
  await waitFor(() => expect(within(comparison()).getByRole('alert')).toBeInTheDocument());
  expect(within(comparison()).getAllByText('This comparison can no longer be refined. Compare again to refine.')).toHaveLength(1);
});

it('says "stopped" once, without repeating "Compare again to refine" under it', async () => {
  fireEvent.click(refineButton());
  await waitFor(() => expect(runRefineJob).toHaveBeenCalled());
  refineHeld.mockReturnValue(false);
  fireEvent.click(within(comparison()).getByRole('button', { name: 'Stop refining' }));
  await waitFor(() => expect(within(comparison()).getByText('Refining stopped. The comparison is unchanged. Compare again to refine.')).toBeInTheDocument());
  expect(within(comparison()).getAllByText(/Compare again to refine\.$/)).toHaveLength(1);
});

it('stops on request: the comparison stays as it was and says so', async () => {
  fireEvent.click(refineButton());
  await waitFor(() => expect(runRefineJob).toHaveBeenCalled());
  refineHeld.mockReturnValue(false); // stopping ends the Worker that held the inputs
  fireEvent.click(within(comparison()).getByRole('button', { name: 'Stop refining' }));
  expect(job.options.signal.aborted).toBe(true);
  await waitFor(() => expect(within(comparison()).getByText('Refining stopped. The comparison is unchanged. Compare again to refine.')).toBeInTheDocument());
  expect(usePlanner.getState().scan).toMatchObject({ candidates: COARSE, refined: null });
  expect(refineButton()).toBeDisabled();
  expect(within(comparison()).queryByText('This comparison can no longer be refined. Compare again to refine.')).toBeNull(); // the notice says it
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('stops when the route changes while it refines, and the comparison goes with it', async () => {
  fireEvent.click(refineButton());
  await waitFor(() => expect(runRefineJob).toHaveBeenCalled());
  act(() => usePlanner.getState().patch({ polarPercent: 90 }));
  expect(job.options.signal.aborted).toBe(true);
  await waitFor(() => expect(screen.getByText('Comparison stopped: the route or departure changed. Compare again.')).toBeInTheDocument());
  expect(usePlanner.getState().scan).toBeNull();
});

it('is unavailable, with the reason, once the page\'s forecast run is no longer the comparison\'s', async () => {
  page.runs = { weather: { layer: 'weather', run_id: 'w2' } };
  act(() => usePlanner.getState().patch({ name: 'Solent hop' })); // the next render of the page says so (the click checks again)
  expect(refineButton()).toBeDisabled();
  expect(within(comparison()).getByText('The forecast has been updated since this comparison. Compare again to refine.')).toBeInTheDocument();
});

it('checks the runs again at the click, and never refines on newer ones', async () => {
  const button = refineButton();
  page.runs = { weather: { layer: 'weather', run_id: 'w2' } }; // replaced between the render and the click
  fireEvent.click(button);
  await waitFor(() => expect(within(comparison()).getByRole('alert')).toHaveTextContent('The forecast has been updated since this comparison. Compare again to refine.'));
  expect(runRefineJob).not.toHaveBeenCalled();
});

it('is unavailable when the limits changed since the comparison', async () => {
  act(() => useApp.setState({ limits: { ...limits, max_gust_kt: limits.max_gust_kt + 5 } }));
  expect(refineButton()).toBeDisabled();
  expect(within(comparison()).getByText('Your limits have changed since this comparison. Compare again to refine.')).toBeInTheDocument();
});

it.each([
  ['a deleted forecast run', new ForecastRunGoneError('weather', 'w1'), 'The forecast has been updated since this comparison. Compare again to refine.'],
  ['inputs no longer held', new RefineUnavailableError(), 'This comparison can no longer be refined. Compare again to refine.'],
])('fails plainly on %s, without retrying on other data, and offers to compare again', async (_, error, message) => {
  runRefineJob.mockRejectedValueOnce(error);
  fireEvent.click(refineButton());
  await waitFor(() => expect(within(comparison()).getByRole('alert')).toHaveTextContent(message));
  expect(runRefineJob).toHaveBeenCalledTimes(1);
  expect(usePlanner.getState().scan).toMatchObject({ candidates: COARSE });
  fireEvent.click(within(comparison()).getByRole('button', { name: 'Compare again' }));
  await waitFor(() => expect(runScanJob).toHaveBeenCalledTimes(2));
});

it('says the refinement and its reasons in French', () => {
  const fr = (text) => translateText(text, 'fr');
  expect(fr('Refine around the least-exposure times')).toBe('Affiner autour des heures les moins exposées');
  expect(fr('Adds 4 departure times, every 2 h within 6 h of each ◎ or ≈ time in either ranking, from the same forecast as this comparison.'))
    .toBe('Ajoute 4 heures de départ, toutes les 2 h à moins de 6 h de chaque heure ◎ ou ≈ de l’un ou l’autre classement, sur la même prévision que cette comparaison.');
  expect(fr('Adds 1 departure time, every 2 h within 6 h of each ◎ or ≈ time in either ranking, from the same forecast as this comparison.'))
    .toBe('Ajoute 1 heure de départ, toutes les 2 h à moins de 6 h de chaque heure ◎ ou ≈ de l’un ou l’autre classement, sur la même prévision que cette comparaison.');
  expect(fr('Refined: 4 more departure times compared, every 2 h around the ◎ and ≈ times. They are in a second row under their day.'))
    .toBe('Affinage : 4 heures de départ de plus comparées, toutes les 2 h autour des heures ◎ et ≈. Elles figurent sur une seconde ligne sous leur jour.');
  expect(fr('second row: added by refining, every 2 h')).toBe('seconde ligne : ajoutées par l’affinage, toutes les 2 h');
  expect(fr('within limits · added by refining · ≈2 h passage')).toContain('ajoutée par l’affinage');
  for (const [en, french] of [
    ['Refining…', 'Affinage…'],
    ['Refining the comparison…', 'Affinage de la comparaison…'],
    ['Stop refining', 'Arrêter l’affinage'],
    ['Compare again', 'Relancer la comparaison'],
    ['Refining stopped. The comparison is unchanged. Compare again to refine.', 'Affinage arrêté. La comparaison est inchangée. Relancez la comparaison pour l’affiner.'],
    ['No other departure times to add within this comparison.', 'Aucune autre heure de départ à ajouter dans cette comparaison.'],
    ['This comparison can no longer be refined. Compare again to refine.', 'Cette comparaison ne peut plus être affinée. Relancez la comparaison pour l’affiner.'],
    ['Your limits have changed since this comparison. Compare again to refine.', 'Vos limites ont changé depuis cette comparaison. Relancez la comparaison pour l’affiner.'],
    ['The forecast has been updated since this comparison. Compare again to refine.', 'La prévision a été mise à jour depuis cette comparaison. Relancez la comparaison pour l’affiner.'],
    ['This departure time leaves the current grid used by the rest of the comparison.', 'Cette heure de départ sort de la grille de courants utilisée pour le reste de la comparaison.'],
    ['This departure time\'s route leaves the current grid used by the rest of the comparison.', 'La route de cette heure de départ sort de la grille de courants utilisée pour le reste de la comparaison.'],
  ]) expect(fr(en)).toBe(french);
});
