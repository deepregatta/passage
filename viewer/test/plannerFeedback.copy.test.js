import { expect, it } from 'vitest';
import { translateText } from '../src/i18n.js';
import {
  ACTION, BUSY_BUTTON_LABEL, FORECAST_LOAD_FAILED, blockReason, friendlyError, progressLabel,
} from '../src/pages/planner/plannerFeedback.js';
import {
  changedRoutingInputs, draftSignature, polarPercentNote, routingInputKey, scanBasis, scanIsCurrent, staleRouteMessage,
  validPolarPercent,
} from '../src/pages/planner/plannerInputs.js';
import { localDateTimeToIso } from '../src/lib/format.js';
import { horizonText, validateDeparture } from '../src/pages/planner/departureInput.js';

const RAW_PROGRESS = [
  'starting', 'computing route', 'loading coastline', 'loading forecast tiles', 'loading current tiles',
  'loading prepared data', 'reading forecast run manifest', 'reading deterministic forecast tiles',
  'checking ensemble tiles', 'reading 51-member ensemble tiles', 'reading wave tiles',
  'reading hazard and model-comparison tiles', 'reading current tiles', 'evaluating against your limits',
  'saving immutable snapshot', 'scanning departures', 'scanning departures 3/21', 'routing departures 7/21',
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

it('counts the routed departures before the compared ones, in both languages', () => {
  expect(progressLabel('routing departures 0/21')).toBe('Routing departures 0/21…');
  expect(translateText('Routing departures 7/21…', 'fr')).toBe('Calcul des routes 7/21…');
});

it.each([
  ['Stop comparing', 'Arrêter la comparaison'],
  ['Comparison stopped.', 'Comparaison arrêtée.'],
  ['Comparison stopped: the route or departure changed. Compare again.', 'Comparaison arrêtée\u00A0: la route ou le départ a changé. Relancez la comparaison.'],
  ['Comparison stopped: your limits changed. Compare again.', 'Comparaison arrêtée\u00A0: vos limites ont changé. Relancez la comparaison.'],
  ['Comparison cleared: your limits changed. Compare again.', 'Comparaison effacée\u00A0: vos limites ont changé. Relancez la comparaison.'],
  ['The comparison could not finish. Try again.', 'La comparaison n’a pas pu aboutir. Réessayez.'],
])('translates the comparison control and stop message "%s"', (english, french) => {
  expect(translateText(english, 'fr')).toBe(french);
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
    staleRouteMessage(['boat']), staleRouteMessage(['speed']), staleRouteMessage(['departure']), staleRouteMessage(['points']), staleRouteMessage(['boat', 'points']),
    issue.message, validateDeparture('', Date.now()).message,
    validateDeparture('2999-01-01T08:00', Date.now()).message,
    blockReason(ACTION.compute, draft),
    blockReason(ACTION.compute, { ...draft, endpoints: [1, 2] }),
    blockReason(ACTION.compute, { ...draft, endpoints: [1, 2], polarId: 'x' }),
    blockReason(ACTION.compute, { ...draft, endpoints: [1, 2], polarId: 'x', polarPercentValid: false }),
    polarPercentNote({ provenance: { routing_request: { polar_scaling: 0.9 } } }),
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

it('drops a departure comparison when the limits it was ranked against changed', () => {
  const here = '2026-09-12T08:00';
  const anchorMs = Date.parse(localDateTimeToIso(here));
  const scan = { candidates: [], basis: scanBasis(draft()), anchorMs, profileRevision: 'rev-a' };
  expect(scanIsCurrent(scan, draft({ departureLocal: here, profileRevision: 'rev-a' }))).toBe(true);
  expect(scanIsCurrent(scan, draft({ departureLocal: here, profileRevision: 'rev-b' }))).toBe(false);
  // limits not loaded yet, or a comparison saved before the revision was recorded: left alone
  expect(scanIsCurrent(scan, draft({ departureLocal: here }))).toBe(true);
  expect(scanIsCurrent({ ...scan, profileRevision: undefined }, draft({ departureLocal: here, profileRevision: 'rev-b' }))).toBe(true);
});

it('changes the message signature with every input a status can be about', () => {
  const base = draftSignature(draft());
  for (const change of [{ mode: 'draw' }, { polarId: 'b' }, { departureLocal: '2026-09-13T08:00' },
    { endpoints: [] }, { waypoints: [{ lat: 1, lng: 1 }] }, { speeds: { slow: 1, nominal: 5, fast: 6 } }]) {
    expect(draftSignature(draft(change))).not.toBe(base);
  }
  expect(draftSignature(draft({ name: 'unrelated' }))).toBe(base);
});

it('keys the boat speed into every routing input, and keeps a three-element key equal to 100 %', () => {
  const at100 = routingInputKey(draft());
  expect(JSON.parse(at100)).toHaveLength(3);
  expect(routingInputKey(draft({ polarPercent: 100 }))).toBe(at100);
  // A key stored before the percentage existed.
  const stored = JSON.stringify([[[50, -1], [51, -2]], 'a', '2026-09-12T07:00:00Z']);
  expect(changedRoutingInputs(stored, draft({ departureLocal: '2026-09-12T08:00' }))).not.toContain('speed');
  const at90 = routingInputKey(draft({ polarPercent: 90 }));
  expect(JSON.parse(at90)).toHaveLength(4);
  expect(at90).not.toBe(at100);
  expect(changedRoutingInputs(at100, draft({ polarPercent: 90 }))).toEqual(['speed']);
  expect(changedRoutingInputs(at90, draft())).toEqual(['speed']);
  expect(changedRoutingInputs(at90, draft({ polarPercent: 90 }))).toEqual([]);
  expect(changedRoutingInputs(at90, draft({ polarPercent: 95, polarId: 'b' }))).toEqual(['boat', 'speed']);
  // An unreadable percentage never matches a key made at 100.
  for (const bad of ['', Number.NaN, 49, 121]) {
    expect(routingInputKey(draft({ polarPercent: bad }))).not.toBe(at100);
    expect(changedRoutingInputs(at100, draft({ polarPercent: bad }))).toEqual(['speed']);
  }
  expect(staleRouteMessage(['speed'])).toBe('Boat speed changed — recompute the route');
  expect(scanBasis(draft({ polarPercent: 90 }))).not.toBe(scanBasis(draft()));
  expect(scanBasis(draft({ mode: 'draw', polarPercent: 90 }))).toBe(scanBasis(draft({ mode: 'draw' })));
  expect(draftSignature(draft({ polarPercent: 90 }))).not.toBe(draftSignature(draft()));
});

it('accepts a whole percent from 50 to 120 only, and notes a non-100 route in words', () => {
  for (const ok of [50, 100, 120]) expect(validPolarPercent(ok)).toBe(true);
  for (const bad of ['', 49, 121, 90.5, Number.NaN, '90', null, undefined]) expect(validPolarPercent(bad)).toBe(false);
  expect(blockReason(ACTION.compute, { mode: 'compute', endpoints: [1, 2], polarId: 'x', polarPercentValid: false, departureIssue: null }))
    .toBe('Enter a percent of polar from 50 to 120.');
  const note = (polar_scaling) => polarPercentNote({ provenance: { routing_request: { polar_scaling } } });
  expect(note(0.9)).toBe('Routed at 90% of the boat polar speeds');
  expect(note(1.2)).toBe('Routed at 120% of the boat polar speeds');
  expect(note(1)).toBeNull();
  expect(polarPercentNote({})).toBeNull();
  expect(polarPercentNote(null)).toBeNull();
  expect(translateText(note(0.9), 'fr')).toBe('Routé à 90 % des vitesses de la polaire du bateau');
});
