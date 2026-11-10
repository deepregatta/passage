import { expect, it } from 'vitest';
import { translateText } from '../src/i18n.js';
import {
  ACTION, BUSY_BUTTON_LABEL, FORECAST_LOAD_FAILED, blockReason, friendlyError, progressLabel,
} from '../src/pages/planner/plannerFeedback.js';
import {
  changedRoutingInputs, draftSignature, routingInputKey, scanBasis, scanIsCurrent, staleRouteMessage,
} from '../src/pages/planner/plannerInputs.js';
import { horizonText, validateDeparture } from '../src/pages/planner/departureInput.js';

const RAW_PROGRESS = [
  'starting', 'computing route', 'loading coastline', 'loading forecast tiles', 'loading current tiles',
  'loading prepared data', 'reading forecast run manifest', 'reading deterministic forecast tiles',
  'checking ensemble tiles', 'reading 51-member ensemble tiles', 'reading wave tiles',
  'reading hazard and model-comparison tiles', 'reading current tiles', 'evaluating against your limits',
  'saving immutable snapshot', 'scanning departures', 'scanning departures 3/21',
];

it.each(RAW_PROGRESS)('shows "%s" in plain words with a French translation', (raw) => {
  const label = progressLabel(raw);
  expect(label).toMatch(/…$/);
  expect(label).not.toMatch(/tiles|snapshot|manifest|immutable|prepared|deterministic/i);
  expect(translateText(label, 'fr')).not.toBe(label);
});

it('keeps unknown progress visible instead of hiding it', () => {
  expect(progressLabel('warming up')).toBe('Warming up…');
  expect(progressLabel(null)).toBeNull();
  expect(progressLabel('scanning departures 3/21')).toBe('Comparing departure times 3/21…');
  expect(translateText('Comparing departure times 3/21…', 'fr')).toBe('Comparaison des heures de départ 3/21…');
});

it.each([
  'forecast fetch failed: HTTP 404 for latest.json',
  'forecast tile fetch failed: HTTP 500 for t/1.pft',
  'forecast fetch timed out after 8000 ms for latest.json',
  'forecast fetch failed: network error for latest.json',
  'forecast tile invalid: a.pft (checksum mismatch)',
  'Failed to fetch',
  'TypeError: NetworkError when attempting to fetch resource.',
  'Load failed',
])('turns the raw failure %j into plain language and keeps it as technical detail', (raw) => {
  expect(friendlyError(raw)).toEqual({ message: FORECAST_LOAD_FAILED, detail: raw, polars: false });
});

it.each([
  'No sea route found',
  "Couldn't load the forecast tiles. Check your connection and try again.",
  'This departure is beyond the forecast horizon',
  'Too many boat polar requests. Wait a minute and try again.',
])('leaves the friendly message %j as it is', (raw) => {
  expect(friendlyError(raw)).toEqual({ message: raw, detail: null, polars: false });
});

it('flags unavailable boat polars so the page can offer Draw my route', () => {
  expect(friendlyError('Boat polars are unavailable right now. Use Draw my route instead.').polars).toBe(true);
  expect(friendlyError('').message).toBe('Something went wrong. Please try again.');
});

it('has a French translation for every status, button and block reason it can show', () => {
  const issue = validateDeparture('2000-01-01T08:00', Date.now());
  const draft = { mode: 'compute', endpoints: [], polarId: null, route: null, speedsValid: true, departureIssue: issue };
  const texts = [
    FORECAST_LOAD_FAILED, 'Something went wrong. Please try again.', horizonText(),
    ...Object.values(BUSY_BUTTON_LABEL),
    staleRouteMessage(['boat']), staleRouteMessage(['departure']), staleRouteMessage(['points']), staleRouteMessage(['boat', 'points']),
    issue.message, validateDeparture('', Date.now()).message,
    validateDeparture('2999-01-01T08:00', Date.now()).message,
    blockReason(ACTION.compute, draft),
    blockReason(ACTION.compute, { ...draft, endpoints: [1, 2] }),
    blockReason(ACTION.compute, { ...draft, endpoints: [1, 2], polarId: 'x' }),
    blockReason(ACTION.check, { ...draft, mode: 'draw' }),
    blockReason(ACTION.check, draft),
    blockReason(ACTION.check, { ...draft, endpoints: [1, 2] }),
    blockReason(ACTION.check, { ...draft, route: {}, speedsValid: false }),
  ];
  for (const text of texts) expect(translateText(text, 'fr'), text).not.toBe(text);
  expect(translateText('Forecasts cover the next 9 days, up to Fri 20 Nov', 'fr'))
    .toBe('Les prévisions couvrent les 9 prochains jours, jusqu’au ven. 20 nov.');
  expect(translateText('Choose a departure within the forecast, up to Sat 19 Sep', 'fr'))
    .toBe('Choisissez un départ dans la période couverte par les prévisions, jusqu’au sam. 19 sept.');
});

it('names the first thing missing before an action can run', () => {
  const base = { mode: 'compute', endpoints: [], polarId: null, route: null, speedsValid: true, departureIssue: null };
  expect(blockReason(ACTION.compute, base)).toBe('Mark a start and finish on the chart.');
  expect(blockReason(ACTION.compute, { ...base, endpoints: [1, 2] })).toBe('Choose your boat first');
  expect(blockReason(ACTION.compute, { ...base, endpoints: [1, 2], polarId: 'x' })).toBeNull();
  expect(blockReason(ACTION.compute, { ...base, endpoints: [1, 2], polarId: 'x', departureIssue: { message: 'Past' } })).toBe('Past');
  expect(blockReason(ACTION.check, { ...base, endpoints: [1, 2], polarId: 'x' })).toBe('Compute the route first.');
  expect(blockReason(ACTION.check, { ...base, mode: 'draw' })).toMatch(/^Mark at least two points/);
  expect(blockReason(ACTION.scan, { ...base, route: {}, speedsValid: false })).toMatch(/^Enter a speed above zero/);
  expect(blockReason(ACTION.scan, { ...base, route: {}, departureIssue: { message: 'Past' } })).toBe('Past');
  expect(blockReason(ACTION.check, { ...base, route: {} })).toBeNull();
});

const draft = (over = {}) => ({
  mode: 'compute', endpoints: [{ lat: 50, lng: -1 }, { lat: 51, lng: -2 }], waypoints: [], polarId: 'a',
  speeds: { slow: 4, nominal: 5, fast: 6 }, departureLocal: '2026-09-12T08:00', ...over,
});

it('says which routing input changed since a discarded result, and nothing for unknown provenance', () => {
  const key = routingInputKey(draft());
  expect(changedRoutingInputs(key, draft())).toEqual([]);
  expect(changedRoutingInputs(key, draft({ polarId: 'b' }))).toEqual(['boat']);
  expect(changedRoutingInputs(key, draft({ departureLocal: '2026-09-12T09:00' }))).toEqual(['departure']);
  expect(changedRoutingInputs(key, draft({ endpoints: [{ lat: 50, lng: -1 }] }))).toEqual(['points']);
  expect(changedRoutingInputs(key, draft({ polarId: 'b', departureLocal: '2026-09-13T08:00' }))).toEqual(['boat', 'departure']);
  expect(changedRoutingInputs('not json', draft())).toEqual([]);
  expect(changedRoutingInputs(undefined, draft())).toEqual([]);
  expect(staleRouteMessage([])).toBeNull();
  expect(staleRouteMessage(['boat'])).toBe('Boat changed — recompute the route');
  expect(staleRouteMessage(['departure'])).toBe('Departure changed — recompute the route');
  expect(staleRouteMessage(['points'])).toBe('Route points changed — recompute the route');
});

it('keeps a departure comparison while the departure is its anchor or one of its candidates', () => {
  const candidates = [{ departure_utc: '2026-09-12T12:00:00Z' }, { departure_utc: '2026-09-12T18:00:00Z' }];
  const anchor = Date.parse('2026-09-12T08:00:00Z');
  const scan = { candidates, basis: scanBasis(draft()), anchorMs: anchor };
  const at = (iso) => new Date(iso);
  const localOf = (iso) => {
    const d = at(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  expect(scanIsCurrent(scan, draft({ departureLocal: localOf('2026-09-12T08:00:00Z') }))).toBe(true);
  expect(scanIsCurrent(scan, draft({ departureLocal: localOf('2026-09-12T18:00:00Z') }))).toBe(true);
  expect(scanIsCurrent(scan, draft({ departureLocal: localOf('2026-09-12T19:00:00Z') }))).toBe(false);
  expect(scanIsCurrent(scan, draft({ departureLocal: 'T' }))).toBe(false);
  expect(scanIsCurrent(scan, draft({ polarId: 'b', departureLocal: localOf('2026-09-12T08:00:00Z') }))).toBe(false);
  expect(scanIsCurrent(scan, draft({ mode: 'draw', departureLocal: localOf('2026-09-12T08:00:00Z') }))).toBe(false);
  // drawn mode depends on waypoints and speeds, not on the hidden boat
  const drawn = draft({ mode: 'draw', waypoints: [{ lat: 50, lng: -1 }, { lat: 51, lng: -2 }] });
  const drawnScan = { candidates, basis: scanBasis(drawn), anchorMs: anchor };
  const here = localOf('2026-09-12T08:00:00Z');
  expect(scanIsCurrent(drawnScan, { ...drawn, polarId: 'b', departureLocal: here })).toBe(true);
  expect(scanIsCurrent(drawnScan, { ...drawn, speeds: { slow: 4, nominal: 5.5, fast: 6 }, departureLocal: here })).toBe(false);
  expect(scanIsCurrent(drawnScan, { ...drawn, waypoints: [{ lat: 50, lng: -1 }], departureLocal: here })).toBe(false);
  // a comparison without a basis predates this check
  expect(scanIsCurrent({ candidates }, draft())).toBe(true);
  expect(scanIsCurrent(null, draft())).toBe(true);
});

it('changes the message signature with every input a status can be about', () => {
  const base = draftSignature(draft());
  for (const change of [{ mode: 'draw' }, { polarId: 'b' }, { departureLocal: '2026-09-13T08:00' },
    { endpoints: [] }, { waypoints: [{ lat: 1, lng: 1 }] }, { speeds: { slow: 1, nominal: 5, fast: 6 } }]) {
    expect(draftSignature(draft(change))).not.toBe(base);
  }
  expect(draftSignature(draft({ name: 'unrelated' }))).toBe(base);
});
