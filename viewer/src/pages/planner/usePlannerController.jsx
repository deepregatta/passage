import { captureActionDraft, freezeActionInputs, routingCurrentInput } from '../../lib/actionInputs.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deriveLegs, totalDistanceNm, parseGpx, computeRoute, scanDepartures, candidateDepartures } from '@deepweather/engine';
import { track } from '../../lib/analytics.js';
import { localDateTimeToIso, toLocalDateTimeValue } from '../../lib/format.js';
import { useApp } from '../../stores/appStore.js';
import { usePlanner } from '../../stores/plannerStore.js';
import { analyzeInBrowser, saveRoute, prepareAnalysisInputs } from '../../lib/browserAnalysis.js';
import { FORECAST_HOURS, loadRoutingInputs as loadLiveRoutingInputs } from '../../lib/routingInputs.js';
import { forecastStore } from '../../lib/forecastStore.js';
import { withFreshForecast } from '../../lib/forecastFreshness.js';
import { validateDeparture } from './departureInput.js';
import { GENERIC_NAME, defaultPassageName } from './passageName.js';
import { ACTION, blockReason, friendlyError } from './plannerFeedback.js';
import {
  changedRoutingInputs, draftSignature, routingInputKey, scanBasis, scanIsCurrent, staleRouteMessage,
} from './plannerInputs.js';

/** How long Clear can be undone. */
export const CLEAR_UNDO_MS = 8000;

export const validSpeed = (value) => Number.isFinite(value) && value > 0;

const routeForDeparture = (inputs, departureUtc) =>
  computeRoute({
    start: inputs.start,
    finish: inputs.finish,
    departureUtc,
    polar: inputs.polar,
    windGrid: inputs.windGrid,
    currentGrid: inputs.currentGrid ?? undefined,
    landMask: inputs.landMask,
    maxHours: inputs.maxHours,
  });

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
  const name = usePlanner((s) => s.name);
  const nameAuto = usePlanner((s) => s.nameAuto);
  const speeds = usePlanner((s) => s.speeds);
  const departureLocal = usePlanner((s) => s.departureLocal);
  const storedScan = usePlanner((s) => s.scan);
  const patch = usePlanner((s) => s.patch);
  const inputKey = routingInputKey({ endpoints, polarId, departureLocal });
  const computed = storedComputed?.inputKey === inputKey ? storedComputed : null;
  // A comparison belongs to the boat, route points and departures it was run for.
  const scan = storedScan && scanIsCurrent(storedScan, { mode, endpoints, waypoints, polarId, speeds, departureLocal })
    ? storedScan : null;
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
    if (storedScan && !scan) patch({ scan: null });
  }, [storedScan, scan, patch]);
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
  const speedsValid = mode === 'compute' || ['slow', 'nominal', 'fast'].every(k => validSpeed(speeds[k]));
  const passageHours = distance && validSpeed(speeds.nominal) ? Math.round(distance / speeds.nominal) : null;
  const departureUtc = localDateTimeToIso(departureLocal);
  // Past, beyond the forecast or unreadable: Compute, Scan and Check stop with this reason.
  const departureIssue = validateDeparture(departureLocal);

  const addWaypoint = useCallback(
    (latlng) => {
      if (mode === 'compute') {
        if (computed) setDiscardedKey(computed.inputKey);
        setComputed(null);
        setEndpoints((eps) => (eps.length >= 2 ? [latlng] : [...eps, latlng]));
      } else {
        setWaypoints((wps) => [...wps, latlng]);
      }
    },
    [mode, computed, setComputed, setEndpoints, setWaypoints],
  );

  // shared by Compute route and the per-departure scan routing
  const loadRoutingInputs = useCallback((scanning = false, store = forecastStore()) =>
    loadLiveRoutingInputs({
      start: { lat: endpoints[0].lat, lon: endpoints[0].lng, name: 'Start' },
      finish: { lat: endpoints[1].lat, lon: endpoints[1].lng, name: 'Finish' },
      polarId,
      departureIso: departureUtc,
      scanning,
      store,
      onProgress: setBusy,
    }), [endpoints, polarId, departureUtc]);

  const runRouting = async () => {
    if (endpoints.length !== 2 || !polarId || !departureUtc || departureIssue) return;
    const hadRoute = Boolean(computed);
    beginAction(ACTION.compute);
    setDiscardedKey(null);
    setComputed(null);
    setBusy('computing route');
    try {
      const inputs = await withFreshForecast(() => loadRoutingInputs());
      if (routingInputKey(usePlanner.getState()) !== inputKey) return;
      setBusy('computing route');
      setComputed({ ...routeForDeparture(inputs, departureUtc), notes: inputs.notes, inputKey });
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

  const runScan = useCallback(async () => {
    if (!route || !departureUtc || !speedsValid || departureIssue) return;
    beginAction(ACTION.scan);
    setBusy('scanning departures');
    setScan(null);
    // What this comparison is for, captured at the click: if any of it changes
    // while it runs or afterwards, the result is dropped instead of shown.
    const basis = scanBasis({ mode, endpoints, waypoints, polarId, speeds });
    let draft;
    try {
      if (!useApp.getState().limits) await useApp.getState().ensureLimits();
      draft = captureActionDraft({ route, profile: useApp.getState().limits, departureUtc });
    } catch (e) { endAction(); failAction(ACTION.scan, e); return; }
    // A deleted run retries discovery; the user draft remains the one at the click.
    const scanOnce = async () => {
      const action = await prepareAnalysisInputs(draft, setBusy);
      const departures = candidateDepartures(Date.parse(departureUtc), 120, 6);
      // weather-dependent routing: in compute mode every candidate departure
      // gets its own route through its own wind field
      const routes = {};
      let routeFor;
      let currentInput;
      let scanPassageHours = passageHours ?? 48;
      if (mode === 'compute' && endpoints.length === 2 && polarId) {
        const inputs = await loadRoutingInputs(true, action.store);
        // Computed candidates and their audits share the routing grid. A drawn
        // scan selects prepared-vs-tile coverage across every candidate in engine.
        currentInput = routingCurrentInput(inputs.currentGrid);
        scanPassageHours = inputs.maxHours;
        routeFor = (departureUtc) => {
          const result = {
            ...routeForDeparture(inputs, departureUtc), notes: inputs.notes,
            inputKey: routingInputKey({ endpoints, polarId, departureLocal: toLocalDateTimeValue(departureUtc) }),
          };
          routes[departureUtc] = result;
          return { ...result.route, passage_id: draft.route.passage_id, name: draft.route.name };
        };
      }
      // one shared assessment window covering every candidate: all candidates read
      // the same immutable tile run and share the tile cache
      const scanEndMs = Math.min(
        Date.parse(departures[departures.length - 1]) + (scanPassageHours + 24) * 3600_000,
        Date.now() + FORECAST_HOURS * 3600_000,
      );
      const dateWindow = {
        startDate: departures[0].slice(0, 10),
        endDate: new Date(Math.max(scanEndMs, Date.parse(departures[0]))).toISOString().slice(0, 10),
      };
      const partial = [];
      const scanInputs = freezeActionInputs({ ...action, currentInput });
      const result = await scanDepartures({ ...scanInputs, routeFor, dateWindow }, departures, (c) => {
        partial.push(c);
        setBusy(`scanning departures ${partial.length}/${departures.length}`);
      });
      setScan({
        ...result, routes, rerouted: Boolean(routeFor), requested: departures.length,
        notes: routeFor ? Object.values(routes)[0]?.notes ?? [] : [],
        basis, anchorMs: Date.parse(departureUtc),
      });
      endAction();
    };
    try {
      await withFreshForecast(scanOnce);
    } catch (e) {
      endAction();
      failAction(ACTION.scan, e);
    }
  }, [route, departureUtc, departureIssue, speedsValid, setScan, passageHours, mode, endpoints, waypoints, polarId, speeds, loadRoutingInputs, beginAction, endAction, failAction]);

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
  const signature = draftSignature({ mode, endpoints, waypoints, polarId, departureLocal, speeds });
  const failure = failureState?.signature === signature ? { ...failureState, ...friendlyError(failureState.raw) } : null;
  const notice = noticeState?.signature === signature ? noticeState : null;
  // Why the computed route is gone, when it was thrown away because an input changed.
  const staleRoute = mode === 'compute' && !computed && discardedKey
    ? staleRouteMessage(changedRoutingInputs(discardedKey, { endpoints, polarId, departureLocal }))
    : null;
  const blocked = (action) => blockReason(action, { mode, endpoints, polarId, route, speedsValid, departureIssue });

  /** Run again whatever just failed. A failed GPX import has nothing to re-run: it asks for another file. */
  const retryAction = (kind) => {
    if (kind === ACTION.compute) runRouting();
    else if (kind === ACTION.scan) runScan();
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
    mode, waypoints, computed, endpoints, polarId, polarLabel, name, speeds,
    departureLocal, scan, patch, setMode, setWaypoints, setEndpoints, setComputed,
    setName, setSpeeds, setDepartureLocal, busy, activeAction, failure, notice, staleRoute,
    departureIssue, blocked, retryAction, clearDraft, undoClear, fitNonce, fileRef, passageName,
    seededFromCompute: mode === 'draw' && seededFromCompute && waypoints.length > 0,
    clearedNotice: cleared?.signature === signature,
    route, distance, speedsValid, passageHours, departureUtc, addWaypoint,
    runRouting, onGpx, runScan, run
  };
}
