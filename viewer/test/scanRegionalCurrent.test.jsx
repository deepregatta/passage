// A departure comparison on the regional (prepared) current grid (owner decision, 13 November 2026):
// the departures the grid covers are assessed on it, the later ones are listed as not assessed, and
// the comparison says so under its heading. Through the planner's own action (runScanAction), the
// Worker handler, a refinement, and the rendered line in English and French.
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHash, OUTSIDE_SCAN_CURRENT } from '@deepweather/engine';
import { captureActionDraft } from '../src/lib/actionInputs.js';
import { loadRoutingInputs } from '../src/lib/routingInputs.js';
import { prepareAnalysisInputs } from '../src/lib/browserAnalysis.js';
import { runRefineAction, runScanAction } from '../src/lib/scanAction.js';
import { createScanHandler } from '../src/lib/scanWorkerHandler.js';
import DepartureComparison from '../src/pages/planner/DepartureComparison.jsx';
import { usePlanner } from '../src/stores/plannerStore.js';
import { fmtLocalTime } from '../src/lib/format.js';
import { LocalizedDocument } from '../src/i18n.js';
import limits from '../../config/profiles/default-limits.json';
import { auditStore, DEPARTURE, routingInputs } from './fixtures/routingTiming.js';

vi.mock('../src/lib/routingInputs.js', async (original) => ({ ...await original(), loadRoutingInputs: vi.fn() }));
vi.mock('../src/lib/browserAnalysis.js', () => ({ prepareAnalysisInputs: vi.fn() }));
vi.mock('../src/lib/forecastStore.js', () => ({ forecastStore: () => null }));

const NOW = Date.parse('2026-07-19T12:00:00Z');
const H = 3600_000;
const at = (h) => new Date(Date.parse(DEPARTURE) + h * H).toISOString().replace(/\.\d{3}Z$/, 'Z');
const DEPARTURES = Array.from({ length: 21 }, (_, i) => at(6 * i));
const PROVENANCE = { source: 'prepared-artifact', layer: 'currents', model: 'cmems-ibi', run_id: 'prepared-ibi' };

/** An hourly regional grid over a corridor around the route, `hours` long from the first departure, `along(h)` kt along (2 by default). */
function regional(hours, along = () => 2) {
  const time_axis = Array.from({ length: hours + 1 }, (_, h) => at(h));
  const u = time_axis.flatMap((_, h) => Array(9).fill(along(h)));
  return { schema_version: 1, kind: 'surface_current', run_id: 'prepared-ibi', generated_at: DEPARTURE,
    lat0: 49.4, lon0: -3.55, dlat: 0.1, dlon: 0.2, nlat: 3, nlon: 3, time_axis,
    u_kt: u, v_kt: Array(u.length).fill(0), source: { mode: 'synthetic', dataset_id: 'cmems-ibi' } };
}

let store;
let grid;
function request(mode = 'compute') {
  const inputs = routingInputs(1);
  const route = { schema_version: 1, passage_id: 'p', route_id: 'r', name: 'Test passage', mode: 'user',
    waypoints: [{ id: 'a', lat: 49.5, lon: -3.5 }, { id: 'b', lat: 49.5, lon: -3.2 }], speeds_kt: { slow: 4, nominal: 5, fast: 6 },
    timing: { basis: 'through_water' } };
  return {
    draft: captureActionDraft({ route, profile: limits, departureUtc: DEPARTURE }),
    departureUtc: DEPARTURE, mode, polarId: 'constant-5', polarPercent: 100, passageHours: 3,
    endpoints: [inputs.start, inputs.finish].map(({ lat, lon }) => ({ lat, lng: lon })),
  };
}
const clean = (out) => JSON.parse(JSON.stringify(out, (key, value) => (key === 'computed_at' ? undefined : value)));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  const engine = await vi.importActual('@deepweather/engine');
  const inputs = routingInputs(1);
  store = auditStore(engine, inputs.currentGrid);
  vi.spyOn(store, 'getCurrentGrid');
  grid = Object.freeze(regional(103));
  loadRoutingInputs.mockReset().mockResolvedValue(inputs);
  prepareAnalysisInputs.mockReset().mockImplementation(async (draft) => ({
    ...draft, store, tileRuns: {}, inputRecords: [], currentGrid: grid, currentGridProvenance: PROVENANCE,
  }));
  usePlanner.getState().reset();
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('a comparison inside the regional current grid', () => {
  it('routes and assesses the covered departures on the regional grid and lists the later ones as not assessed', async () => {
    const out = await runScanAction(request('compute'), { store });
    expect(out.currents).toMatchObject({ source: 'prepared', model: 'cmems-ibi' });
    expect(out.scan.candidates.map((c) => c.departure_utc)).toEqual(DEPARTURES.slice(0, 17));
    expect(out.scan.skipped).toEqual(DEPARTURES.slice(17).map((departure_utc) => ({ departure_utc, reason: OUTSIDE_SCAN_CURRENT })));
    expect(out.scan.current_reach).toEqual({ last_departure_utc: at(96), not_covered: 4 });
    expect(out.scan.input_records.find((r) => r.layer === 'currents')).toMatchObject({ current_source: 'prepared', content_digest: contentHash(grid) });
    for (const departure of DEPARTURES.slice(0, 17)) {
      expect(out.routes[departure].route.provenance.routing_request).toMatchObject({ current_source: 'prepared', current_digest: contentHash(grid) });
    }
    expect(Object.keys(out.routes)).toEqual(DEPARTURES.slice(0, 17));
  });

  it('does the same for a drawn route, with no tile currents read', async () => {
    const out = await runScanAction(request('draw'), { store });
    expect(store.getCurrentGrid).not.toHaveBeenCalled();
    expect(out.scan.candidates).toHaveLength(17);
    expect(out.scan.current_reach).toEqual({ last_departure_utc: at(96), not_covered: 4 });
    expect(out.scan.skipped.every((s) => s.reason === OUTSIDE_SCAN_CURRENT)).toBe(true);
  });

  it.each(['compute', 'draw'])('gives the same %s comparison and refinement through the Worker handler as on the page', async (mode) => {
    const messages = [];
    const handle = createScanHandler((message) => messages.push(structuredClone(message)), { pinStore: async () => store });
    await handle(structuredClone({ type: 'scan', id: 7, request: request(mode), catalogue: { runs: {}, layers: [], regionalLayers: [] }, nowMs: NOW }));
    const scanned = messages.at(-1);
    expect(scanned).toMatchObject({ type: 'done', id: 7 });
    await handle(structuredClone({ type: 'refine', id: 8, scanId: 7 }));
    const refined = messages.at(-1);
    expect(refined).toMatchObject({ type: 'done', id: 8 });

    let context;
    const inPage = await runScanAction(request(mode), { store, keepContext: (kept) => { context = kept; } });
    expect(clean(scanned.out)).toEqual(clean(inPage));
    const pageRefined = await runRefineAction(context);
    expect(clean(refined.out)).toEqual(clean(pageRefined));

    // the refinement stayed on the regional grid: every added time it assessed carries its digest, the others are not assessed
    const { scan } = refined.out;
    expect(scan.current_reach.last_departure_utc >= at(96)).toBe(true);
    expect(scan.input_records.find((r) => r.layer === 'currents')).toMatchObject({ current_source: 'prepared', content_digest: contentHash(grid) });
    const assessed = new Set(scan.candidates.map((c) => c.departure_utc));
    for (const departure of refined.out.added) {
      if (assessed.has(departure) && mode === 'compute') {
        expect(refined.out.routes[departure].route.provenance.routing_request).toMatchObject({ current_digest: contentHash(grid) });
      }
      if (!assessed.has(departure)) expect(scan.skipped.map((s) => s.departure_utc)).toContain(departure);
    }
    expect(Date.parse(scan.current_reach.last_departure_utc)).toBeLessThan(Date.parse(at(103)));
  });
});

const EN_DAY = { Mon: 'lun.', Tue: 'mar.', Wed: 'mer.', Thu: 'jeu.', Fri: 'ven.', Sat: 'sam.', Sun: 'dim.' };
const frStamp = (stamp) => stamp.replace(/^(\w{3}) (\d+) Jul /, (_m, day, date) => `${EN_DAY[day]} ${date} juil. `);

describe('the line under the heading', () => {
  const show = async (hours, language, { mode = 'compute', along } = {}) => {
    grid = Object.freeze(regional(hours, along));
    const out = await runScanAction(request(mode), { store });
    const scan = { ...out.scan, routes: {}, rerouted: out.rerouted, requested: out.requested };
    const view = language
      ? render(<div id="root"><DepartureComparison scan={scan} departureLocal="2026-07-20T02:00" busy={null} disabled={false} onPick={() => {}} /><LocalizedDocument language={language} /></div>)
      : render(<DepartureComparison scan={scan} departureLocal="2026-07-20T02:00" busy={null} disabled={false} onPick={() => {}} />);
    return { view, scan };
  };
  const line = (container) => container.querySelector('[data-testid="current-reach"]')?.textContent ?? null;
  const textOf = (container) => [...container.querySelectorAll('p')].map((p) => p.textContent);

  it('says the comparison used the regional current model, how far it reaches, and that later times were not assessed', async () => {
    const { view } = await show(103);
    const stamp = fmtLocalTime(at(96));
    expect(line(view.container)).toBe(`This comparison used the regional current model, which covers departures up to ${stamp} local time; 4 departure times it does not cover were not assessed.`);
    // directly under the heading, which keeps "next 5 days"
    const heading = view.container.querySelector('h2');
    expect(heading.textContent).toContain('next 5 days');
    expect(heading.parentElement.nextElementSibling.getAttribute('data-testid')).toBe('current-reach');
    // the existing count, caution and list keep working
    expect(textOf(view.container)).toContain('4 of 21 departure times could not be assessed and are not shown.');
    expect(textOf(view.container)).toContain('A missing cell does not mean safe conditions.');
    expect([...view.container.querySelectorAll('li span')].map((s) => s.textContent)).toEqual(Array(4).fill(OUTSIDE_SCAN_CURRENT));
    expect(line(view.container)).not.toMatch(/tidal stream|best|\bGO\b|probab/i);
  });

  it('says it in French, as whole lines', async () => {
    const { view } = await show(103, 'fr');
    const stamp = frStamp(fmtLocalTime(at(96)));
    expect(line(view.container)).toBe(`Cette comparaison a utilisé le modèle régional de courants, qui couvre les départs jusqu’au ${stamp}, heure locale ; 4 heures de départ qu’il ne couvre pas n’ont pas été évaluées.`);
    expect(textOf(view.container)).toContain('4 sur 21 heures de départ n’ont pas pu être évaluées et ne sont pas affichées.');
    expect(textOf(view.container)).toContain('Une case manquante ne signifie pas des conditions sûres.');
    expect(view.container.querySelector('h2').textContent).toContain('Comparaison des départs · 5 prochains jours');
    expect([...view.container.querySelectorAll('li span')].map((s) => s.textContent))
      .toEqual(Array(4).fill('Cette heure de départ sort de la grille de courants utilisée pour le reste de la comparaison.'));
  });

  it('counts one departure left out in the singular, in English and French', async () => {
    // A 119 h grid: 114 h arrives inside it, 120 h departs after it.
    const { view, scan } = await show(119);
    expect(scan.current_reach).toEqual({ last_departure_utc: at(114), not_covered: 1 });
    const stamp = fmtLocalTime(at(114));
    expect(line(view.container)).toBe(`This comparison used the regional current model, which covers departures up to ${stamp} local time; 1 departure time it does not cover was not assessed.`);
    view.unmount();
    const fr = await show(119, 'fr');
    expect(line(fr.view.container)).toBe(`Cette comparaison a utilisé le modèle régional de courants, qui couvre les départs jusqu’au ${frStamp(stamp)}, heure locale ; 1 heure de départ qu’il ne couvre pas n’a pas été évaluée.`);
  });

  it('counts a departure left out that is earlier than the last covered one (its passage outlasts the grid)', async () => {
    // Drawn route of 11.7 nm, 4 kt at the slow end: 2.6 kt against it from 88 to 95 h, 3 kt with it otherwise.
    // The 90 h departure makes 1.4 kt and arrives at about 98.4 h, past the 98 h grid; the 96 h departure
    // sails in the fair current and arrives at about 97.7 h, inside it.
    const { view, scan } = await show(98, undefined, { mode: 'draw', along: (h) => (h >= 88 && h <= 95 ? -2.6 : 3) });
    const left = [at(90), at(102), at(108), at(114), at(120)];
    expect(scan.current_reach).toEqual({ last_departure_utc: at(96), not_covered: 5 });
    expect(scan.candidates.map((c) => c.departure_utc)).toContain(at(96));
    expect(scan.skipped).toEqual(left.map((departure_utc) => ({ departure_utc, reason: OUTSIDE_SCAN_CURRENT })));
    expect(line(view.container)).toBe(`This comparison used the regional current model, which covers departures up to ${fmtLocalTime(at(96))} local time; 5 departure times it does not cover were not assessed.`);
    expect([...view.container.querySelectorAll('li')].map((li) => li.textContent))
      .toEqual(left.map((d) => `${fmtLocalTime(d)} · ${OUTSIDE_SCAN_CURRENT}`));
    expect(textOf(view.container)).toContain('5 of 21 departure times could not be assessed and are not shown.');
  });

  it('is not shown when the regional grid covers every departure', async () => {
    const { view, scan } = await show(130);
    expect(scan.candidates).toHaveLength(21);
    expect(scan.input_records.find((r) => r.layer === 'currents')).toMatchObject({ current_source: 'prepared' });
    expect(line(view.container)).toBeNull();
  });

  it('is not shown when the comparison is on tiles', async () => {
    const { view, scan } = await show(50); // 9 of 21 departures inside the grid: fewer than half
    expect(scan.input_records.find((r) => r.layer === 'currents')).toMatchObject({ current_source: 'tiles',
      fallback_reason: 'prepared grid covers fewer than half of the departure times' });
    expect(scan.candidates).toHaveLength(21);
    expect(line(view.container)).toBeNull();
  });
});

describe('the mark and summary of a comparison the regional current model cut short', () => {
  const H6 = (i) => at(6 * i);
  const cand = (i, verdict = 'within') => ({ departure_utc: H6(i), verdict, worst_ratio: 0.5 - i / 100, max_fraction: null, ensemble_covered: false,
    max_members: null, driver_summary: null, passage_h: 2, arrival_hours_over_limit: 0, arrival_hours_approaching: 0, arrival_hours_no_data: 0,
    expected_hours_over_limit: 0 });
  const scanOf = (cut, verdict) => ({ candidates: [0, 1, 2].map((i) => cand(i, verdict)), best_index: 2, rerouted: false, requested: cut ? 5 : 3,
    skipped: cut ? [3, 4].map((i) => ({ departure_utc: H6(i), reason: OUTSIDE_SCAN_CURRENT })) : [],
    ...(cut ? { current_reach: { last_departure_utc: H6(2), not_covered: 2 } } : {}) });
  const render$ = (scan, language) => render(language
    ? <div id="root"><DepartureComparison scan={scan} departureLocal="2026-07-20T02:00" busy={null} disabled={false} onPick={() => {}} /><LocalizedDocument language={language} /></div>
    : <DepartureComparison scan={scan} departureLocal="2026-07-20T02:00" busy={null} disabled={false} onPick={() => {}} />);
  const mark = (container) => [...container.querySelectorAll('span.font-medium')].find((s) => s.textContent.startsWith('◎')).textContent;
  const stamp = () => fmtLocalTime(H6(2));

  it('names the mark among the assessed departure times only when departures were left out', () => {
    let view = render$(scanOf(true));
    expect(mark(view.container)).toBe(`◎ Least exposure among the assessed departure times: ${stamp()} local time`);
    view.unmount();
    view = render$(scanOf(false));
    expect(mark(view.container)).toBe(`◎ Least exposure this window: ${stamp()} local time`);
  });

  it('says it in French, as whole lines', () => {
    let view = render$(scanOf(true), 'fr');
    expect(mark(view.container)).toBe(`◎ Exposition minimale parmi les heures de départ évaluées : ${frStamp(stamp())} heure locale`);
    view.unmount();
    view = render$(scanOf(false), 'fr');
    expect(mark(view.container)).toBe(`◎ Exposition minimale sur cette fenêtre : ${frStamp(stamp())} heure locale`);
  });

  it('says the models disagree at every assessed time, not throughout the window, when it was cut short', () => {
    const p = (container) => container.querySelector('p.text-\\[13px\\]').textContent;
    let view = render$(scanOf(true, 'insufficient'));
    expect(p(view.container)).toContain(' The models disagree near your limits at every assessed departure time. Open a briefing to see where they diverge and when the next update is due.');
    expect(p(view.container)).not.toContain('this window');
    view.unmount();
    view = render$(scanOf(true, 'insufficient'), 'fr');
    expect(p(view.container)).toContain('Les modèles divergent près de vos limites à chaque heure de départ évaluée. Ouvrez un briefing pour voir où ils divergent et quand la prochaine mise à jour est attendue.');
    view.unmount();
    view = render$(scanOf(false, 'insufficient'));
    expect(p(view.container)).toContain('The models disagree near your limits throughout this window.');
    for (const text of [mark(view.container), p(view.container)]) expect(text).not.toMatch(/\bbest\b|\bGO\b|probab/i);
  });
});
