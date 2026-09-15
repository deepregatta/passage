import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deriveLegs, totalDistanceNm, parseGpx, computeRoute, scanDepartures, candidateDepartures } from '@deepweather/engine';
import { track } from '../../lib/analytics.js';
import { localDateTimeToIso, toLocalDateTimeValue } from '../../lib/format.js';
import { useApp } from '../../stores/appStore.js';
import { usePlanner } from '../../stores/plannerStore.js';
import { analyzeInBrowser, saveRoute } from '../../lib/browserAnalysis.js';
import { loadRoutingInputs as loadLiveRoutingInputs } from '../../lib/routingInputs.js';
import { forecastStore } from '../../lib/forecastStore.js';

// Persist the routing inputs with each result so restored drafts can be checked too.
const routingInputKey = ({ endpoints, polarId, departureLocal }) => JSON.stringify([
  endpoints.map(({ lat, lng }) => [lat, lng]), polarId, localDateTimeToIso(departureLocal),
]);

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
  const profileDefaults = useApp((s) => s.profileDefaults);
  const loadConfig = useApp((s) => s.loadConfig);
  const manifest = useApp((s) => s.manifest);
  const loadManifest = useApp((s) => s.loadManifest);
  const language = useApp((s) => s.language);

  // working state survives stage switches; see plannerStore.js
  const mode = usePlanner((s) => s.mode);
  const waypoints = usePlanner((s) => s.waypoints);
  const storedComputed = usePlanner((s) => s.computed);
  const endpoints = usePlanner((s) => s.endpoints);
  const polarId = usePlanner((s) => s.polarId);
  const polarLabel = usePlanner((s) => s.polarLabel);
  const name = usePlanner((s) => s.name);
  const speeds = usePlanner((s) => s.speeds);
  const departureLocal = usePlanner((s) => s.departureLocal);
  const scan = usePlanner((s) => s.scan);
  const patch = usePlanner((s) => s.patch);
  const inputKey = routingInputKey({ endpoints, polarId, departureLocal });
  const computed = storedComputed?.inputKey === inputKey ? storedComputed : null;
  useEffect(() => {
    // Discard legacy/unmatched results; never render or audit them as current.
    if (storedComputed && !computed) patch({ computed: null });
  }, [storedComputed, computed, patch]);
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
    patch(next);
    if (next.endpoints || next.waypoints) setFitNonce((n) => n + 1);
  };
  const setWaypoints = useCallback((value) => patch({ waypoints: typeof value === 'function' ? value(usePlanner.getState().waypoints) : value }), [patch]);
  const setEndpoints = useCallback((value) => patch({ endpoints: typeof value === 'function' ? value(usePlanner.getState().endpoints) : value }), [patch]);
  const setComputed = useCallback((value) => patch({ computed: value }), [patch]);
  const setName = (value) => patch({ name: value });
  const setSpeeds = (value) => patch({ speeds: typeof value === 'function' ? value(usePlanner.getState().speeds) : value });
  const setDepartureLocal = (value) => patch({ departureLocal: value });
  const setScan = useCallback((value) => patch({ scan: value }), [patch]);

  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [fitNonce, setFitNonce] = useState(0);
  const fileRef = useRef(null);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);
  useEffect(() => {
    if (!manifest) loadManifest();
  }, [manifest, loadManifest]);
  useEffect(() => {
    if (language === 'fr' && name === 'My passage') patch({ name: 'Ma traversée' });
    if (language === 'en' && name === 'Ma traversée') patch({ name: 'My passage' });
  }, [language, name, patch]);

  const route = useMemo(() => {
    if (mode === 'compute') return computed?.route ?? null;
    if (waypoints.length < 2) return null;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'route';
    return {
      schema_version: 1,
      route_id: `${slug}-${waypoints.length}wp`,
      name,
      mode: 'user',
      waypoints: waypoints.map((wp, i) => ({
        id: `wp${i + 1}`,
        lat: Math.round(wp.lat * 10000) / 10000,
        lon: Math.round(wp.lng * 10000) / 10000,
      })),
      speeds_kt: { ...speeds },
    };
  }, [mode, computed, waypoints, name, speeds]);

  const distance = useMemo(() => {
    if (!route) return null;
    return Math.round(totalDistanceNm(deriveLegs(route)) * 10) / 10;
  }, [route]);
  const speedsValid = mode === 'compute' || ['slow', 'nominal', 'fast'].every(k => validSpeed(speeds[k]));
  const passageHours = distance && validSpeed(speeds.nominal) ? Math.round(distance / speeds.nominal) : null;
  const departureUtc = localDateTimeToIso(departureLocal);

  const addWaypoint = useCallback(
    (latlng) => {
      if (mode === 'compute') {
        setComputed(null);
        setEndpoints((eps) => (eps.length >= 2 ? [latlng] : [...eps, latlng]));
      } else {
        setWaypoints((wps) => [...wps, latlng]);
      }
    },
    [mode, setComputed, setEndpoints, setWaypoints],
  );

  // shared by Compute route and the per-departure scan routing
  const loadRoutingInputs = useCallback((scanning = false) =>
    loadLiveRoutingInputs({
      start: { lat: endpoints[0].lat, lon: endpoints[0].lng, name: 'Start' },
      finish: { lat: endpoints[1].lat, lon: endpoints[1].lng, name: 'Finish' },
      polarId,
      departureIso: departureUtc,
      scanning,
      onProgress: setBusy,
    }), [endpoints, polarId, departureUtc]);

  const runRouting = async () => {
    if (endpoints.length !== 2 || !polarId || !departureUtc) return;
    setComputed(null);
    setBusy('computing route');
    setError(null);
    try {
      const inputs = await loadRoutingInputs();
      if (routingInputKey(usePlanner.getState()) !== inputKey) return;
      setBusy('computing route');
      setComputed({ ...routeForDeparture(inputs, departureUtc), notes: inputs.notes, inputKey });
    } catch (e) {
      if (routingInputKey(usePlanner.getState()) === inputKey) setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const onGpx = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = parseGpx(await file.text(), {
        route_id: 'gpx-import',
        speeds_kt: { ...speeds },
      });
      setName(parsed.name);
      setWaypoints(parsed.waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lon })));
      setFitNonce((n) => n + 1);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const runScan = useCallback(async () => {
    if (!route || !departureUtc || !speedsValid) return;
    setBusy('scanning departures');
    setError(null);
    setScan(null);
    try {
      const profileDraft = localStorage.getItem('deepweather.profile-draft');
      const profile = profileDraft ? JSON.parse(profileDraft) : profileDefaults;
      const departures = candidateDepartures(Date.parse(departureUtc), 120, 6);
      // weather-dependent routing: in compute mode every candidate departure
      // gets its own route through its own wind field
      const routes = {};
      let routeFor;
      let scanPassageHours = passageHours ?? 48;
      if (mode === 'compute' && endpoints.length === 2 && polarId) {
        const inputs = await loadRoutingInputs(true);
        scanPassageHours = inputs.maxHours;
        routeFor = (departureUtc) => {
          const result = {
            ...routeForDeparture(inputs, departureUtc), notes: inputs.notes,
            inputKey: routingInputKey({ endpoints, polarId, departureLocal: toLocalDateTimeValue(departureUtc) }),
          };
          routes[departureUtc] = result;
          return result.route;
        };
      }
      // one shared assessment window covering every candidate: all candidates read
      // the same immutable tile run and share the tile cache
      const scanEndMs = Math.min(
        Date.parse(departures[departures.length - 1]) + (scanPassageHours + 24) * 3600_000,
        Date.now() + 10 * 24 * 3600_000, // deterministic tile horizon (240 h)
      );
      const dateWindow = {
        startDate: departures[0].slice(0, 10),
        endDate: new Date(Math.max(scanEndMs, Date.parse(departures[0]))).toISOString().slice(0, 10),
      };
      const partial = [];
      const result = await scanDepartures({ route, profile, routeFor, dateWindow, store: forecastStore() }, departures, (c) => {
        partial.push(c);
        setBusy(`scanning departures ${partial.length}/${departures.length}`);
      });
      setScan({ ...result, routes, rerouted: Boolean(routeFor), requested: departures.length, notes: routeFor ? Object.values(routes)[0]?.notes ?? [] : [] });
      setBusy(null);
    } catch (e) {
      setBusy(null);
      setError(e.message);
    }
  }, [route, departureUtc, speedsValid, setScan, profileDefaults, passageHours, mode, endpoints, polarId, loadRoutingInputs]);

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
    const checkRoute = overrides.route ?? route;
    const checkDepartureUtc = overrides.departureUtc ?? departureUtc;
    if (!checkRoute || !speedsValid) return;
    setBusy('starting');
    setError(null);
    try {
      const profileDraft = localStorage.getItem('deepweather.profile-draft');
      const profile = profileDraft ? JSON.parse(profileDraft) : profileDefaults;
      if (!profile) throw new Error('No limits profile available. Open My limits first.');
      if (!checkDepartureUtc) throw new Error('Enter a valid departure date and 24-hour time.');
      if (checkRoute.waypoints?.length < 2 || !checkRoute.waypoints?.every(wp => Number.isFinite(wp.lat) && Number.isFinite(wp.lon))) throw new Error('Specify at least two valid waypoints.');
      // Same non-secure-context fallback as analyticsClient's event ids.
      const measurementAttempt = globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
      track('passage_attempt', { route_specified: true });
      await saveRoute(checkRoute);
      const { snapshotId } = await analyzeInBrowser({
        route: checkRoute,
        profile,
        departureUtc: checkDepartureUtc,
        onProgress: setBusy,
      });
      setBusy(null);
      await openSnapshot(snapshotId, measurementAttempt);
    } catch (e) {
      setBusy(null);
      setError(e.message);
    }
  };

  return {
    mode, waypoints, computed, endpoints, polarId, polarLabel, name, speeds,
    departureLocal, scan, patch, setMode, setWaypoints, setEndpoints, setComputed,
    setName, setSpeeds, setDepartureLocal, busy, error, fitNonce, fileRef,
    route, distance, speedsValid, passageHours, departureUtc, addWaypoint,
    runRouting, onGpx, runScan, run
  };
}
