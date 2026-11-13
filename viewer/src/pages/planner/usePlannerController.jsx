import { captureActionDraft } from '../../lib/actionInputs.js';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { contentHash, deriveLegs, forecastRunGone, totalDistanceNm, parseGpx, refinementDepartures } from '@deepweather/engine';
import { track } from '../../lib/analytics.js';
import { localDateTimeToIso, toLocalDateTimeValue } from '../../lib/format.js';
import { useApp } from '../../stores/appStore.js';
import { RANK_CAUTIOUS, usePlanner } from '../../stores/plannerStore.js';
import { analyzeInBrowser, saveRoute, prepareAnalysisInputs } from '../../lib/browserAnalysis.js';
import { routeOnOneCurrent, scanDeparturesFor } from '../../lib/scanAction.js';
import {
  ScanCancelledError, refinableSnapshot, refineHeld, releaseRefinable, runRefineJob, runScanJob, subscribeRefinable,
} from '../../lib/scanRunner.js';
import { loadRoutingInputs as loadLiveRoutingInputs, routedOutcome } from '../../lib/routingInputs.js';
import { forecastStore } from '../../lib/forecastStore.js';
import { holdForecastRuns, refreshForecastIfStale, withFreshForecast } from '../../lib/forecastFreshness.js';
import { validateDeparture } from './departureInput.js';
import useDownloadQuotes from './useDownloadQuotes.js';
import { loadPorts, loadedPorts, portNameAt } from '../../lib/ports.js';
import { GENERIC_NAME, defaultPassageName, placedPoint } from './passageName.js';
import { ACTION, blockReason, friendlyError } from './plannerFeedback.js';
import {
  changedRoutingInputs, draftSignature, routingInputKey, scanBasis, scanIsCurrent, staleRouteMessage, validPolarPercent,
} from './plannerInputs.js';

/** How long Clear can be undone. */
export const CLEAR_UNDO_MS = 8000;

export const validSpeed = (value) => Number.isFinite(value) && value > 0;

/** What the scan button's status says when a comparison is stopped. */
export const SCAN_STOPPED = 'Comparison stopped.';
export const SCAN_STOPPED_STALE = 'Comparison stopped: the route or departure changed. Compare again.';
/** Said when the limits changed while a comparison ran, and when they changed under the one on show. */
export const SCAN_STOPPED_LIMITS = 'Comparison stopped: your limits changed. Compare again.';
export const SCAN_CLEARED_LIMITS = 'Comparison cleared: your limits changed. Compare again.';
/** What the refine control's status says when a refinement is stopped: the comparison stays as it was. */
export const REFINE_STOPPED = 'Refining stopped. The comparison is unchanged. Compare again to refine.';
/** Why a comparison cannot be refined (the control is shown disabled with this reason). */
export const REFINE_REASON = Object.freeze({
  nothing: 'No other departure times to add within this comparison.',
  notHeld: 'This comparison can no longer be refined. Compare again to refine.',
  limits: 'Your limits have changed since this comparison. Compare again to refine.',
  forecast: 'The forecast has been updated since this comparison. Compare again to refine.',
});

/** The digest of a store's pinned runs, or null when it cannot say (not loaded yet). */
function runsDigest(store) {
  try {
    return typeof store?.describe === 'function' ? contentHash(store.describe()) : null;
  } catch {
    return null;
  }
}

/** Owns the draft, routing, scan and audit lifecycle for the planner page. */
export default function usePlannerController() {
  const openSnapshot = useApp((s) => s.openSnapshot);
  const loadConfig = useApp((s) => s.loadConfig);
  const manifest = useApp((s) => s.manifest);
  const loadManifest = useApp((s) => s.loadManifest);
  const language = useApp((s) => s.language);

  // working state survives stage switches; see plannerStore.js
  const passageId = usePlanner((s) => s.passageId);
  const mode = usePlanner((s) => s.mode);
  const waypoints = usePlanner((s) => s.waypoints);
  const storedComputed = usePlanner((s) => s.computed);
  const endpoints = usePlanner((s) => s.endpoints);
  const polarId = usePlanner((s) => s.polarId);
  const polarLabel = usePlanner((s) => s.polarLabel);
  const polarPercent = usePlanner((s) => s.polarPercent);
  const name = usePlanner((s) => s.name);
  const nameAuto = usePlanner((s) => s.nameAuto);
  const speeds = usePlanner((s) => s.speeds);
  const departureLocal = usePlanner((s) => s.departureLocal);
  const storedScan = usePlanner((s) => s.scan);
  const patch = usePlanner((s) => s.patch);
  const inputKey = routingInputKey({ endpoints, polarId, departureLocal, polarPercent });
  const computed = storedComputed?.inputKey === inputKey ? storedComputed : null;
  // A comparison belongs to the boat, route points and departures it was run for,
  // and to the limits it was ranked against: changed limits drop it (and the page says so).
  const limits = useApp((s) => s.limits);
  const limitsRevision = useMemo(() => (limits ? contentHash(limits) : null), [limits]);
  const scanDraft = { mode, endpoints, waypoints, polarId, speeds, departureLocal, polarPercent };
  const scan = storedScan && scanIsCurrent(storedScan, { ...scanDraft, profileRevision: limitsRevision }) ? storedScan : null;
  // Dropped for the limits alone: the route and departure still match.
  const droppedForLimits = Boolean(storedScan && !scan && scanIsCurrent(storedScan, scanDraft));
  // The key of the last computed route that was thrown away, so the page can say why.
  const [discardedKey, setDiscardedKey] = useState(null);
  useEffect(() => {
    // Discard legacy/unmatched results; never render or audit them as current.
    if (storedComputed && !computed) {
      patch({ computed: null });
      if (storedComputed.inputKey) setDiscardedKey(storedComputed.inputKey);
    }
  }, [storedComputed, computed, patch]);
  useEffect(() => {
    if (!storedScan || scan) return;
    patch({ scan: null });
    if (droppedForLimits) {
      setNoticeState({ kind: ACTION.scan, text: SCAN_CLEARED_LIMITS, signature: draftSignature(usePlanner.getState()) });
    }
  }, [storedScan, scan, droppedForLimits, patch]);
  /** Switching tabs carries the route across: a drawn route hands its first and
   * last waypoint to the router as start/finish, and endpoints hand themselves
   * back — so "Compute route" is ready to run straight after a switch. */
  const setMode = (value) => {
    if (value === mode) return;
    const next = { mode: value };
    if (value === 'compute' && endpoints.length === 0 && waypoints.length >= 2) {
      next.endpoints = [waypoints[0], waypoints[waypoints.length - 1]];
    }
    if (value === 'draw' && waypoints.length === 0 && endpoints.length === 2) {
      next.waypoints = [...endpoints];
    }
    setSeededFromCompute(Boolean(next.waypoints));
    patch(next);
    if (next.endpoints || next.waypoints) setFitNonce((n) => n + 1);
  };
  const setWaypoints = useCallback((value) => patch({ waypoints: typeof value === 'function' ? value(usePlanner.getState().waypoints) : value }), [patch]);
  const setEndpoints = useCallback((value) => patch({ endpoints: typeof value === 'function' ? value(usePlanner.getState().endpoints) : value }), [patch]);
  const setComputed = useCallback((value) => patch({ computed: value }), [patch]);
  // Typing is the sailor's choice of name: from then on the page leaves it alone.
  const setName = (value) => patch({ name: value, nameAuto: false });
  const setSpeeds = (value) => patch({ speeds: typeof value === 'function' ? value(usePlanner.getState().speeds) : value });
  const setDepartureLocal = (value) => patch({ departureLocal: value });
  const setPolarPercent = (value) => patch({ polarPercent: value });
  const setScan = useCallback((value) => patch({ scan: value }), [patch]);

  // `busy` is the running step's raw progress text; `activeAction` says which
  // control started it ({kind: 'compute' | 'scan' | 'check', source}), so the
  // progress, result and failure show next to that control and no other.
  const [busy, setBusy] = useState(null);
  const [activeAction, setActiveAction] = useState(null);
  const [failureState, setFailureState] = useState(null);
  const [noticeState, setNoticeState] = useState(null);
  // Draw mode started from the Compute endpoints: say so, because new points are added after them.
  const [seededFromCompute, setSeededFromCompute] = useState(false);
  // What Clear removed, offered back for a few seconds ({before, signature}).
  const [cleared, setCleared] = useState(null);
  const [fitNonce, setFitNonce] = useState(0);
  const fileRef = useRef(null);

  const beginAction = useCallback((kind, source = null) => {
    setActiveAction({ kind, source });
    setFailureState(null);
    setNoticeState(null);
  }, []);
  const endAction = useCallback(() => {
    setBusy(null);
    setActiveAction(null);
  }, []);
  // Stamped with the draft as it is now (not as the closure saw it): the message
  // stops being shown as soon as any input it was about changes.
  const failAction = useCallback((kind, error, source = null) => {
    setFailureState({ kind, source, raw: error?.message ?? String(error), signature: draftSignature(usePlanner.getState()) });
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);
  useEffect(() => {
    if (!manifest) loadManifest();
  }, [manifest, loadManifest]);
  // Until the sailor types a name it is the page's: "Start → Finish" when both
  // ends are named, else the generic name in the page language.
  const derivedName = defaultPassageName({ mode, endpoints, waypoints }, language);
  useEffect(() => {
    if (nameAuto && name !== derivedName) patch({ name: derivedName, nameAuto: true });
  }, [nameAuto, name, derivedName, patch]);

  // The sailor's title for the passage, in both modes; it labels the saved check and
  // is never part of the routing inputs, so renaming keeps a computed route.
  const passageName = name.trim() || (GENERIC_NAME[language] ?? GENERIC_NAME.en);
  const route = useMemo(() => {
    if (mode === 'compute') return computed?.route ? { ...computed.route, passage_id: passageId, name: passageName } : null;
    if (waypoints.length < 2) return null;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'route';
    return {
      schema_version: 1,
      passage_id: passageId,
      route_id: `${slug}-${waypoints.length}wp`,
      name: passageName,
      mode: 'user',
      waypoints: waypoints.map((wp, i) => ({
        id: `wp${i + 1}`,
        lat: Math.round(wp.lat * 10000) / 10000,
        lon: Math.round(wp.lng * 10000) / 10000,
      })),
      speeds_kt: { ...speeds },
      timing: { basis: 'through_water' },
    };
  }, [mode, computed, waypoints, name, passageName, speeds, passageId]);

  const distance = useMemo(() => {
    if (!route) return null;
    return Math.round(totalDistanceNm(deriveLegs(route)) * 10) / 10;
  }, [route]);
  const polarPercentValid = validPolarPercent(polarPercent);
  const speedsValid = mode === 'compute' || ['slow', 'nominal', 'fast'].every(k => validSpeed(speeds[k]));
  const passageHours = distance && validSpeed(speeds.nominal) ? Math.round(distance / speeds.nominal) : null;
  const departureUtc = localDateTimeToIso(departureLocal);
  // Past, beyond the forecast or unreadable: Compute, Scan and Check stop with this reason.
  const departureIssue = validateDeparture(departureLocal);

  // The list of ports loads once, in the background; a failure leaves every point unnamed.
  useEffect(() => { loadPorts(); }, []);
  const busyRef = useRef(null);
  busyRef.current = busy;
  /** A point placed before the list arrived is named when it does, but only
   * while it is still the same point and nothing has been computed or checked
   * from it: a late file must not rename a route that already has results. */
  const nameWhenPortsLoad = useCallback((point) => {
    if (loadedPorts()) return;
    loadPorts().then((list) => {
      if (!list) return;
      const state = usePlanner.getState();
      if (state.computed || busyRef.current) return;
      const isEndpoint = state.endpoints.includes(point);
      if (!isEndpoint && !state.waypoints.includes(point)) return;
      const named = placedPoint(point, point, portNameAt);
      if (!named.name) return;
      const swap = (points) => points.map((p) => (p === point ? named : p));
      patch(isEndpoint ? { endpoints: swap(state.endpoints) } : { waypoints: swap(state.waypoints) });
    });
  }, [patch]);
  const placePoint = useCallback((previous, latlng) => {
    const point = placedPoint(previous, latlng, portNameAt);
    nameWhenPortsLoad(point);
    return point;
  }, [nameWhenPortsLoad]);
  /** Dragging a drawn point gives it the name of the port it now sits at, or none. */
  const moveWaypoint = useCallback((index, latlng) => {
    setWaypoints((wps) => wps.map((wp, i) => (i === index ? placePoint(wp, latlng) : wp)));
  }, [setWaypoints, placePoint]);

  const addWaypoint = useCallback(
    (latlng) => {
      if (mode === 'compute') {
        if (computed) setDiscardedKey(computed.inputKey);
        setComputed(null);
        setEndpoints((eps) => (eps.length >= 2 ? [placePoint(null, latlng)] : [...eps, placePoint(null, latlng)]));
      } else {
        setWaypoints((wps) => [...wps, placePoint(null, latlng)]);
      }
    },
    [mode, computed, setComputed, setEndpoints, setWaypoints, placePoint],
  );

  const runRouting = async () => {
    if (endpoints.length !== 2 || !polarId || !polarPercentValid || !departureUtc || departureIssue) return;
    const hadRoute = Boolean(computed);
    beginAction(ACTION.compute);
    setDiscardedKey(null);
    setComputed(null);
    setBusy('computing route');
    try {
      // Compute stays on the page's thread (a fraction of a second; the scan is what the Worker takes).
      const inputs = await withFreshForecast(() => loadLiveRoutingInputs({
        start: { lat: endpoints[0].lat, lon: endpoints[0].lng, name: 'Start' },
        finish: { lat: endpoints[1].lat, lon: endpoints[1].lng, name: 'Finish' },
        polarId, departureIso: departureUtc, store: forecastStore(), prepared: true, onProgress: setBusy,
      }));
      if (routingInputKey(usePlanner.getState()) !== inputKey) return;
      setBusy('computing route');
      const { results, notes, currents } = routeOnOneCurrent(inputs, [departureUtc], polarPercent);
      setComputed({ ...routedOutcome(results, departureUtc), notes, currents, inputKey });
      setNoticeState({
        kind: ACTION.compute, text: hadRoute ? 'Route updated' : 'Route computed',
        signature: draftSignature(usePlanner.getState()),
      });
    } catch (e) {
      if (routingInputKey(usePlanner.getState()) === inputKey) failAction(ACTION.compute, e);
    } finally {
      endAction();
    }
  };

  const onGpx = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    beginAction(ACTION.gpx);
    try {
      const parsed = parseGpx(await file.text(), {
        route_id: 'gpx-import',
        speeds_kt: { ...speeds },
      });
      const points = parsed.waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lon, ...(wp.name ? { name: wp.name } : {}) }));
      // A file that names its route keeps that name. parseGpx falls back to the
      // first <name> it finds (often the first point's) or to the route id.
      const named = parsed.name !== 'gpx-import' && parsed.name !== parsed.waypoints[0]?.name;
      setWaypoints(points);
      // Without one the passage keeps its name: the default follows the named ends, a typed name stays.
      if (named) setName(parsed.name);
      setFitNonce((n) => n + 1);
    } catch (e) {
      failAction(ACTION.gpx, e);
    } finally {
      endAction();
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // The comparison running now ({controller, basis, anchorMs, departures}), or null.
  // Only that run may report a result, a failure or the end of its action.
  const scanRunRef = useRef(null);
  const runScan = useCallback(async () => {
    if (!route || !departureUtc || !speedsValid || departureIssue) return;
    const run = {
      kind: ACTION.scan,
      controller: new AbortController(),
      // What this comparison is for, captured at the click: if any of it changes
      // while it runs it is stopped, and afterwards the result is dropped instead of shown.
      basis: scanBasis({ mode, endpoints, waypoints, polarId, speeds, polarPercent }),
      anchorMs: Date.parse(departureUtc),
      departures: scanDeparturesFor(departureUtc).map((iso) => Date.parse(iso)),
    };
    const current = () => scanRunRef.current === run;
    scanRunRef.current = run;
    beginAction(ACTION.scan);
    setBusy('scanning departures');
    setScan(null);
    let draft;
    try {
      if (!useApp.getState().limits) await useApp.getState().ensureLimits();
      draft = captureActionDraft({ route, profile: useApp.getState().limits, departureUtc });
      if (current()) run.profileRevision = draft.profileRevision;
    } catch (e) {
      if (!current()) return;
      scanRunRef.current = null;
      endAction();
      failAction(ACTION.scan, e);
      return;
    }
    const request = {
      draft, departureUtc, mode, endpoints: endpoints.map(({ lat, lng }) => ({ lat, lng })), polarId, polarPercent, passageHours,
    };
    try {
      // A deleted run retries discovery; the user draft remains the one at the click.
      const out = await withFreshForecast(() => runScanJob(request, {
        signal: run.controller.signal,
        onProgress: (step) => { if (current()) setBusy(step); },
      }));
      if (!current()) return;
      // The input key is the page's (its local time), so it is added here, after the comparison.
      const routes = Object.fromEntries(Object.entries(out.routes).map(([candidateUtc, result]) => [candidateUtc, {
        ...result, notes: out.notes, currents: out.currents,
        inputKey: routingInputKey({ endpoints, polarId, departureLocal: toLocalDateTimeValue(candidateUtc), polarPercent }),
      }]));
      setScan({
        ...out.scan, routes, rerouted: out.rerouted, requested: out.requested,
        notes: out.rerouted ? Object.values(routes)[0]?.notes ?? [] : [],
        basis: run.basis, anchorMs: run.anchorMs,
        // What a refinement must still match: the runs and limits this comparison read,
        // and where its inputs are held. Memory only, like the comparison itself.
        scanId: out.scanId ?? null, runsDigest: out.forecastRuns ? contentHash(out.forecastRuns) : null,
        profileRevision: draft.profileRevision, dateWindow: out.dateWindow ?? null, refined: null,
      });
      scanRunRef.current = null;
      endAction();
    } catch (e) {
      if (!current()) return;
      scanRunRef.current = null;
      endAction();
      if (!(e instanceof ScanCancelledError)) failAction(ACTION.scan, e);
    }
  }, [route, departureUtc, departureIssue, speedsValid, setScan, passageHours, mode, endpoints, waypoints, polarId, polarPercent, speeds, beginAction, endAction, failAction]);

  /** Stop the running comparison: nothing is shown from it, and the line under its button says why. */
  const stopScan = useCallback((text) => {
    const run = scanRunRef.current;
    if (!run) return;
    scanRunRef.current = null;
    run.controller.abort();
    endAction();
    // A stopped refinement leaves its comparison in place; a stale one is said at the comparison's button.
    const kind = run.kind === ACTION.refine && text === undefined ? ACTION.refine : ACTION.scan;
    const said = text ?? (kind === ACTION.refine ? REFINE_STOPPED : SCAN_STOPPED);
    setNoticeState({ kind, text: said, signature: draftSignature(usePlanner.getState()) });
  }, [endAction]);
  // The page answers while a comparison runs: a change to what it compares stops
  // it. Moving the departure to the anchor or one of its candidate times does not.
  useEffect(() => {
    const run = scanRunRef.current;
    if (!run) return;
    const departureMs = Date.parse(localDateTimeToIso(departureLocal) ?? '');
    const sameRoute = scanBasis({ mode, endpoints, waypoints, polarId, speeds, polarPercent }) === run.basis;
    const sameTimes = departureMs === run.anchorMs || run.departures.includes(departureMs);
    const sameLimits = !run.profileRevision || !limitsRevision || run.profileRevision === limitsRevision;
    if (!sameRoute || !sameTimes) stopScan(SCAN_STOPPED_STALE);
    else if (!sameLimits) stopScan(SCAN_STOPPED_LIMITS);
  }, [mode, endpoints, waypoints, polarId, speeds, polarPercent, departureLocal, limitsRevision, stopScan]);
  // Leaving the planner stops a comparison silently.
  useEffect(() => () => {
    const run = scanRunRef.current;
    scanRunRef.current = null;
    run?.controller.abort();
  }, []);

  // Refining the comparison on show: why it cannot run (null when it can), and the times it would add.
  // Re-rendered whenever the runner's held inputs change (a refinement taken, a Worker that failed or ended).
  useSyncExternalStore(subscribeRefinable, refinableSnapshot);
  const refinement = useMemo(() => (scan && scan.candidates.length > 0 && !scan.refined ? refinementDepartures(scan) : null), [scan]);
  const refineReason = (() => {
    if (!refinement) return null;
    if (refinement.departures.length === 0) return REFINE_REASON.nothing;
    if (!refineHeld(scan.scanId)) return REFINE_REASON.notHeld;
    const runs = runsDigest(forecastStore());
    if (scan.runsDigest && runs && runs !== scan.runsDigest) return REFINE_REASON.forecast;
    return null;
  })();
  // The inputs held for a refinement are the comparison's whole working set (its pinned store with
  // decoded tiles, routing and current grids, records). Release them as soon as it can no longer be
  // refined: the comparison is replaced, dropped or cleared (any change of the comparison on show
  // releases the previous one), the planner is left (unmount), or its forecast runs were replaced
  // (the page's runs only move forward). Changed limits drop the comparison, so they release it
  // through the scanId cleanup below; the action-time guard in runRefine is only a defence.
  const scanId = scan?.scanId ?? null;
  useEffect(() => () => { if (scanId !== null) releaseRefinable(scanId); }, [scanId]);
  useEffect(() => {
    if (scanId !== null && refineReason === REFINE_REASON.forecast) releaseRefinable(scanId);
  }, [refineReason, scanId]);

  /** Refine the comparison on show once, on the inputs it ran with. Never automatic. */
  const runRefine = useCallback(async () => {
    const held = usePlanner.getState().scan;
    if (!held || !scan || held !== scan || busyRef.current !== null) return;
    const { departures } = refinementDepartures(held);
    const run = {
      kind: ACTION.refine,
      controller: new AbortController(),
      basis: held.basis,
      profileRevision: held.profileRevision,
      anchorMs: held.anchorMs,
      departures: [...held.candidates.map((c) => Date.parse(c.departure_utc)), ...departures.map((iso) => Date.parse(iso))],
    };
    const current = () => scanRunRef.current === run;
    scanRunRef.current = run;
    beginAction(ACTION.refine);
    setBusy('refining departures');
    try {
      // The runs this comparison read must still be the page's: a refinement never reads newer ones.
      const store = forecastStore();
      await refreshForecastIfStale({ store });
      const appLimits = useApp.getState().limits;
      if (held.profileRevision && appLimits && contentHash(appLimits) !== held.profileRevision) throw new Error(REFINE_REASON.limits);
      const runs = runsDigest(store);
      if (held.runsDigest && runs !== held.runsDigest) {
        releaseRefinable(held.scanId); // replaced runs never come back
        throw new Error(REFINE_REASON.forecast);
      }
      const out = await holdForecastRuns(() => runRefineJob(held.scanId, {
        signal: run.controller.signal,
        onProgress: (step) => { if (current()) setBusy(step); },
      }));
      if (!current()) return;
      scanRunRef.current = null;
      endAction();
      const latest = usePlanner.getState().scan;
      if (latest !== held) return; // the comparison was replaced or dropped meanwhile
      const added = Object.fromEntries(Object.entries(out.routes).map(([candidateUtc, result]) => [candidateUtc, {
        ...result, notes: out.notes, currents: out.currents,
        inputKey: routingInputKey({ endpoints, polarId, departureLocal: toLocalDateTimeValue(candidateUtc), polarPercent }),
      }]));
      setScan({
        ...held, ...out.scan, routes: { ...held.routes, ...added },
        requested: (held.requested ?? held.candidates.length + held.skipped.length) + out.requested,
        refined: { departures: out.added, around: out.around },
      });
    } catch (e) {
      if (!current()) return;
      scanRunRef.current = null;
      endAction();
      if (e instanceof ScanCancelledError) return;
      const gone = forecastRunGone(e) || e?.code === 'forecast-updated';
      failAction(ACTION.refine, gone ? new Error(REFINE_REASON.forecast) : e);
    }
  }, [scan, endpoints, polarId, polarPercent, setScan, beginAction, endAction, failAction]);

  // arriving from a briefing's "Find a departure that fits": run the scan once, then clear the flag
  const autoScan = usePlanner((s) => s.autoScan);
  useEffect(() => {
    if (autoScan && route && !busy) {
      patch({ autoScan: false });
      runScan();
    }
  }, [autoScan, route, busy, patch, runScan]);

  /** Picking a departure from the comparison checks it immediately, so the route
   * and departure it just chose are passed in — React state has not flushed yet. */
  const run = async (overrides = {}) => {
    const selectedRoute = overrides.route ?? route;
    const checkRoute = selectedRoute ? { ...selectedRoute, passage_id: passageId, name: passageName } : null;
    const checkDepartureUtc = overrides.departureUtc ?? departureUtc;
    if (!checkRoute || !speedsValid || (departureIssue && !overrides.departureUtc)) return;
    beginAction(ACTION.check, overrides.source);
    setBusy('starting');
    try {
      if (!useApp.getState().limits) await useApp.getState().ensureLimits();
      const draft = captureActionDraft({ route: checkRoute, profile: useApp.getState().limits, departureUtc: checkDepartureUtc });
      if (!checkDepartureUtc) throw new Error('Enter a valid departure date and 24-hour time.');
      if (checkRoute.waypoints?.length < 2 || !checkRoute.waypoints?.every(wp => Number.isFinite(wp.lat) && Number.isFinite(wp.lon))) throw new Error('Specify at least two valid waypoints.');
      // Same non-secure-context fallback as analyticsClient's event ids.
      const measurementAttempt = globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
      track('passage_attempt', { route_specified: true });
      await saveRoute(checkRoute);
      const { snapshotId } = await withFreshForecast(async () => {
        const action = await prepareAnalysisInputs(draft, setBusy);
        return analyzeInBrowser({ ...action, onProgress: setBusy });
      });
      endAction();
      // Include the newly completed check before its comparison section opens.
      await loadManifest();
      await openSnapshot(snapshotId, measurementAttempt);
    } catch (e) {
      endAction();
      failAction(ACTION.check, e, overrides.source);
    }
  };

  // Messages about an action stop showing once any input they were about changes.
  const signature = draftSignature({ mode, endpoints, waypoints, polarId, departureLocal, speeds, polarPercent });
  const failure = failureState?.signature === signature ? { ...failureState, ...friendlyError(failureState.raw) } : null;
  const notice = noticeState?.signature === signature ? noticeState : null;
  // Why the computed route is gone, when it was thrown away because an input changed.
  const staleRoute = mode === 'compute' && !computed && discardedKey
    ? staleRouteMessage(changedRoutingInputs(discardedKey, { endpoints, polarId, departureLocal, polarPercent }))
    : null;
  const blocked = (action) => blockReason(action, { mode, endpoints, polarId, route, speedsValid, departureIssue, polarPercentValid });
  // Scan is held by the same reasons as Check. The line under a button is for an action that can run.
  const canCheck = blocked(ACTION.check) === null;
  const downloadLines = useDownloadQuotes({
    want: { compute: mode === 'compute' && blocked(ACTION.compute) === null, scan: canCheck, check: canCheck,
      refine: Boolean(refinement) && refineReason === null },
    busy, mode, endpoints, polarId, route, departureUtc, passageHours,
    refine: refinement && scan ? { departures: refinement.departures, dateWindow: scan.dateWindow, rerouted: scan.rerouted } : null,
  });

  /** Run again whatever just failed. A failed GPX import has nothing to re-run: it asks for another file. */
  const retryAction = (kind) => {
    if (kind === ACTION.compute) runRouting();
    else if (kind === ACTION.scan || kind === ACTION.refine) runScan();
    else if (kind === ACTION.check) run();
    else fileRef.current?.click();
  };
  const clearDraft = () => {
    const before = { waypoints, endpoints, computed: storedComputed };
    const empty = waypoints.length === 0 && endpoints.length === 0 && !storedComputed;
    setWaypoints([]);
    setEndpoints([]);
    setComputed(null);
    setDiscardedKey(null);
    setSeededFromCompute(false);
    // Offered back only while nothing has been edited since.
    setCleared(empty ? null : { before, signature: draftSignature(usePlanner.getState()) });
  };
  const undoClear = () => {
    if (cleared) patch(cleared.before);
    setCleared(null);
  };
  useEffect(() => {
    if (!cleared) return undefined;
    const timer = setTimeout(() => setCleared(null), CLEAR_UNDO_MS);
    return () => clearTimeout(timer);
  }, [cleared]);

  return {
    mode, waypoints, computed, endpoints, polarId, polarLabel, polarPercent, polarPercentValid, name, speeds,
    departureLocal, scan, patch, setMode, setWaypoints, setEndpoints, setComputed,
    setName, setSpeeds, setDepartureLocal, setPolarPercent, busy, activeAction, failure, notice, staleRoute,
    departureIssue, blocked, retryAction, clearDraft, undoClear, fitNonce, fileRef, passageName,
    seededFromCompute: mode === 'draw' && seededFromCompute && waypoints.length > 0,
    clearedNotice: cleared?.signature === signature,
    route, distance, speedsValid, passageHours, departureUtc, addWaypoint, moveWaypoint,
    runRouting, onGpx, runScan, stopScan, run, downloadLines,
    runRefine, refineReason, refineCount: refinement?.departures.length ?? 0,
    refineBothRankings: refinement?.rankings.includes(RANK_CAUTIOUS) ?? false,
  };
}
