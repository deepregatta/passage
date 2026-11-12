// The departure comparison ("scan") as one action, the same code on either
// thread: the scan Worker (scanWorker.js) runs it off the page's main thread,
// and the page runs it itself where no Worker can start (scanRunner.js).
// Everything in it reads the store it is given, so the forecast runs it sees
// are the runs the caller pinned.
import {
  candidateDepartures, computeRoute, refineScan, refinementDepartures, routeOnSelectedCurrent, scanDepartures, selectRoutingCurrent,
} from '@deepweather/engine';
import { freezeActionInputs } from './actionInputs.js';
import { prepareAnalysisInputs } from './browserAnalysis.js';
import { loadRoutingInputs, routedOutcome, routingCurrentSummary, selectedRoutingNotes } from './routingInputs.js';
import { scanDateWindow } from './scanWindow.js';

/** The comparison's span and step: 120 h ahead in 6 h steps (21 candidates on the 6 h grid). */
export const SCAN_SPAN_H = 120;
export const SCAN_STEP_H = 6;

/** The candidate departures of a comparison anchored at `departureUtc`. */
export const scanDeparturesFor = (departureUtc) => candidateDepartures(Date.parse(departureUtc), SCAN_SPAN_H, SCAN_STEP_H);

const routeForDeparture = (inputs, departureUtc, polarPercent, currentGrid, strictCurrent) =>
  computeRoute({
    start: inputs.start,
    finish: inputs.finish,
    departureUtc,
    polar: inputs.polar,
    polarScaling: polarPercent / 100,
    windGrid: inputs.windGrid,
    currentGrid: currentGrid ?? undefined,
    ...(strictCurrent ? { strictCurrent: true } : {}),
    landMask: inputs.landMask,
    maxHours: inputs.maxHours,
  });

/** One current source for every departure of a Compute or a computed scan,
 * by the engine's rule: the prepared grid only when routing and the audit both
 * stay inside it, otherwise the tile grid. The audits of these routes use it too.
 * `onRouted(n)` reports how many departures the current pass has routed. */
export const routeOnOneCurrent = (inputs, departures, polarPercent, prepared = inputs.preparedCurrent, onRouted) => {
  let pass = new Set();
  const selection = selectRoutingCurrent({
    departures,
    route: (departureUtc, currentGrid, strictCurrent) => {
      // A second pass (the prepared grid was rejected) starts the count again.
      if (pass.has(departureUtc)) pass = new Set();
      pass.add(departureUtc);
      try {
        return routeForDeparture(inputs, departureUtc, polarPercent, currentGrid, strictCurrent);
      } finally {
        onRouted?.(pass.size);
      }
    },
    tileGrid: inputs.currentGrid,
    prepared: prepared?.currentGrid,
    preparedProvenance: prepared?.currentGridProvenance,
  });
  return { ...selection, notes: selectedRoutingNotes(inputs, selection.currentInput),
    currents: routingCurrentSummary(selection.currentInput) };
};

/**
 * Run one comparison. Plain data in, plain data out, so that it can cross a
 * thread boundary by structured clone.
 *
 * @param {object} request
 * @param {ReturnType<import('./actionInputs.js').captureActionDraft>} request.draft  the frozen draft captured at the click
 * @param {string} request.departureUtc  the departure the comparison is anchored at
 * @param {'compute' | 'draw'} request.mode
 * @param {Array<{lat: number, lng: number}>} request.endpoints
 * @param {string | null} request.polarId
 * @param {number} request.polarPercent
 * @param {number | null} request.passageHours  a drawn route's nominal duration
 * @param {object} deps
 * @param {import('@deepweather/engine').ForecastStore} [deps.store]  the store the action pins (the page's by default)
 * @param {(step: string) => void} [deps.onProgress]
 * @param {() => number} [deps.now]
 * @param {(context: ScanContext) => void} [deps.keepContext]  receives what a refinement of this
 *   comparison needs (runRefineAction). It holds grids and closures: it stays on the thread that ran
 *   the comparison and never crosses to another.
 * @returns {Promise<{ scan: import('@deepweather/engine').WindowScan, routes: Record<string, object>, notes: string[],
 *   currents: object | null, rerouted: boolean, requested: number, forecastRuns: object,
 *   dateWindow: { startDate: string, endDate: string } }>}
 *   `routes` holds each routed departure's outcome; the caller adds what depends on the page (its input key).
 *   `forecastRuns` are the runs the comparison read (the pinned store's description); `dateWindow` its one
 *   assessment window, which a refinement keeps (its download quote reads it).
 */
export async function runScanAction(request, { store, onProgress = () => {}, now, keepContext } = {}) {
  const { draft, departureUtc, mode, endpoints, polarId, polarPercent, passageHours } = request;
  const action = await prepareAnalysisInputs(draft, onProgress, store);
  const departures = scanDeparturesFor(departureUtc);
  // weather-dependent routing: in compute mode every candidate departure
  // gets its own route through its own wind field
  const routes = {};
  let routeFor;
  let currentInput;
  let selection;
  let scanPassageHours = passageHours ?? 48;
  let routingInputs;
  if (mode === 'compute' && endpoints.length === 2 && polarId) {
    routingInputs = await loadRoutingInputs({
      start: { lat: endpoints[0].lat, lon: endpoints[0].lng, name: 'Start' },
      finish: { lat: endpoints[1].lat, lon: endpoints[1].lng, name: 'Finish' },
      polarId,
      departureIso: departureUtc,
      scanning: true,
      store: action.store,
      onProgress,
      ...(now ? { now } : {}),
    });
    // Computed candidates and their audits share one routing grid: the
    // action's prepared grid when every candidate stays inside it, else
    // tiles. A drawn scan selects coverage across every candidate in engine.
    onProgress(`routing departures 0/${departures.length}`);
    selection = routeOnOneCurrent(routingInputs, departures, polarPercent,
      { currentGrid: action.currentGrid, currentGridProvenance: action.currentGridProvenance },
      (n) => onProgress(`routing departures ${n}/${departures.length}`));
    currentInput = selection.currentInput;
    scanPassageHours = routingInputs.maxHours;
    routeFor = (candidateUtc) => {
      // A routing failure is reported as that candidate's skip reason.
      const result = routedOutcome(selection.results, candidateUtc);
      routes[candidateUtc] = result;
      return { ...result.route, passage_id: draft.route.passage_id, name: draft.route.name };
    };
  }
  onProgress(`scanning departures 0/${departures.length}`);
  // one shared assessment window covering every candidate: all candidates read
  // the same immutable tile run and share the tile cache
  const dateWindow = scanDateWindow(departures, scanPassageHours);
  let audited = 0;
  const scanInputs = freezeActionInputs({ ...action, currentInput });
  const base = { ...scanInputs, routeFor, dateWindow, ...(now ? { now } : {}) };
  const { refinement, ...scan } = await scanDepartures(base, departures, () => {
    audited += 1;
    onProgress(`scanning departures ${audited}/${departures.length}`);
  }, { refinable: true });
  const out = {
    scan, routes, notes: selection?.notes ?? [], currents: selection?.currents ?? null,
    rerouted: Boolean(routeFor), requested: departures.length, forecastRuns: action.tileRuns, dateWindow,
  };
  keepContext?.({
    base, coarse: { ...scan, refinement }, notes: out.notes, currents: out.currents,
    routing: selection ? { inputs: routingInputs, polarPercent, passageId: draft.route.passage_id, name: draft.route.name } : null,
  });
  return out;
}

/**
 * What a refinement needs from the comparison it refines: the very inputs that
 * comparison ran with (the frozen action inputs and pinned store, its one current
 * input, its assessment window and clock, its routing inputs), and its result
 * with the engine's refinement data. Kept on the thread that ran the comparison.
 * @typedef {{ base: object, coarse: import('@deepweather/engine').RefinableScan, notes: string[], currents: object | null,
 *   routing: { inputs: object, polarPercent: number, passageId: string, name: string } | null }} ScanContext
 */

/**
 * Refine a comparison: route (computed) and audit the departures every 2 h
 * around its marked and tied times, on exactly the comparison's inputs, and
 * merge them in (engine refineScan). Nothing is loaded again: no newer forecast
 * run, prepared grid or polar can enter.
 * @param {ScanContext} context
 * @param {{ onProgress?: (step: string) => void }} [deps]
 * @returns {Promise<{ scan: import('@deepweather/engine').WindowScan, routes: Record<string, object>, notes: string[],
 *   currents: object | null, added: string[], around: string[], requested: number }>}
 */
export async function runRefineAction(context, { onProgress = () => {} } = {}) {
  const { base, coarse, routing } = context;
  const { departures } = refinementDepartures(coarse);
  const routes = {};
  let routeFor;
  if (routing) {
    onProgress(`routing departures 0/${departures.length}`);
    let routed = 0;
    // On the comparison's own current grid, strict when it is the prepared one: never another source.
    const results = routeOnSelectedCurrent({
      departures,
      currentInput: coarse.refinement.current_input,
      route: (departureUtc, currentGrid, strictCurrent) => {
        try {
          return routeForDeparture(routing.inputs, departureUtc, routing.polarPercent, currentGrid, strictCurrent);
        } finally {
          routed += 1;
          onProgress(`routing departures ${routed}/${departures.length}`);
        }
      },
    });
    routeFor = (candidateUtc) => {
      const result = routedOutcome(results, candidateUtc);
      routes[candidateUtc] = result;
      return { ...result.route, passage_id: routing.passageId, name: routing.name };
    };
  }
  onProgress(`scanning departures 0/${departures.length}`);
  let audited = 0;
  const { refinement: _engineData, refined_departures: added, refined_around: around, ...scan } = await refineScan(
    { ...base, ...(routeFor ? { routeFor } : {}) }, coarse, {}, () => {
      audited += 1;
      onProgress(`scanning departures ${audited}/${departures.length}`);
    },
  );
  return { scan, routes, notes: context.notes, currents: context.currents, added, around, requested: added.length };
}
