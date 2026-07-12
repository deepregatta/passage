import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  deriveLegs,
  totalDistanceNm,
  parseGpx,
  computeRoute,
  scanDepartures,
  candidateDepartures,
} from '@deepweather/engine';
import { fmtTime, VERDICT } from '../lib/format.js';
import { useApp } from '../stores/appStore.js';
import { usePlanner } from '../stores/plannerStore.js';
import { analyzeInBrowser, saveRoute } from '../lib/browserAnalysis.js';
import { Panel } from '../components/common.jsx';
import BoatPicker from '../components/BoatPicker.jsx';
import clsx from 'clsx';

async function loadJson(url) {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

// ink-navy waypoint dots instead of Leaflet's default blue pin
const waypointIcon = L.divIcon({
  className: '',
  html: '<div style="width:14px;height:14px;border-radius:50%;background:#16283E;border:2px solid #F3EEE3;box-shadow:0 0 0 1px #16283E"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

/** compact verdict labels for the scan rows — the full wording lives in the briefing */
const SCAN_VERDICT = {
  within: 'within limits',
  approaching: 'approaching',
  exceeds: 'exceeds',
  insufficient: 'models disagree',
  warning_active: 'official warning',
};

function ClickCapture({ onClick }) {
  useMapEvents({ click: (e) => onClick(e.latlng) });
  return null;
}

/** Bring the whole route into view when returning to the planner or when a
 * route arrives whole (computed / GPX) — never while the user is drawing. */
function FitRoute({ positions, fitKey }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length >= 2) {
      map.fitBounds(L.latLngBounds(positions), { padding: [32, 32], maxZoom: 10 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey]);
  return null;
}

export default function Planner() {
  const openSnapshot = useApp((s) => s.openSnapshot);
  const profileDefaults = useApp((s) => s.profileDefaults);
  const loadConfig = useApp((s) => s.loadConfig);
  const manifest = useApp((s) => s.manifest);
  const loadManifest = useApp((s) => s.loadManifest);

  // working state survives stage switches — see plannerStore.js
  const mode = usePlanner((s) => s.mode);
  const waypoints = usePlanner((s) => s.waypoints);
  const computed = usePlanner((s) => s.computed);
  const endpoints = usePlanner((s) => s.endpoints);
  const polarId = usePlanner((s) => s.polarId);
  const polarLabel = usePlanner((s) => s.polarLabel);
  const name = usePlanner((s) => s.name);
  const speeds = usePlanner((s) => s.speeds);
  const departureLocal = usePlanner((s) => s.departureLocal);
  const scan = usePlanner((s) => s.scan);
  const patch = usePlanner((s) => s.patch);
  const setMode = (value) => patch({ mode: value });
  const setWaypoints = (value) => patch({ waypoints: typeof value === 'function' ? value(usePlanner.getState().waypoints) : value });
  const setEndpoints = (value) => patch({ endpoints: typeof value === 'function' ? value(usePlanner.getState().endpoints) : value });
  const setComputed = (value) => patch({ computed: value });
  const setName = (value) => patch({ name: value });
  const setSpeeds = (value) => patch({ speeds: typeof value === 'function' ? value(usePlanner.getState().speeds) : value });
  const setDepartureLocal = (value) => patch({ departureLocal: value });
  const setScan = (value) => patch({ scan: value });

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
  const demoSnapshot = manifest?.snapshots?.find((s) => s.demo);

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
  const passageHours = distance ? Math.round(distance / speeds.nominal) : null;

  const addWaypoint = useCallback(
    (latlng) => {
      if (mode === 'compute') {
        setComputed(null);
        setEndpoints((eps) => (eps.length >= 2 ? [latlng] : [...eps, latlng]));
      } else {
        setWaypoints((wps) => [...wps, latlng]);
      }
    },
    [mode],
  );

  const runRouting = async () => {
    if (endpoints.length !== 2 || !polarId) return;
    setBusy('computing route');
    setError(null);
    try {
      const [latest, polar] = await Promise.all([
        loadJson('/data/runs/latest.json'),
        // full published db first; the two curated config polars remain a fallback
        loadJson(`/data/polars/boats/${polarId}.json`).then(
          (doc) => doc ?? loadJson(`/data/config/polars/${polarId}.json`),
        ),
      ]);
      if (!latest?.artifacts?.wind_grid) {
        throw new Error('No prepared wind grid — run deepweather-analysis prepare-run first');
      }
      if (!polar) {
        throw new Error(`Boat polar “${polarId}” not found — run deepweather-analysis build-polar-db`);
      }
      const [windGrid, currentGrid, landMask] = await Promise.all([
        loadJson(`/data/${latest.artifacts.wind_grid}`),
        latest.artifacts.current_grid ? loadJson(`/data/${latest.artifacts.current_grid}`) : null,
        latest.artifacts.land_mask ? loadJson(`/data/${latest.artifacts.land_mask}`) : null,
      ]);
      const result = computeRoute({
        start: { lat: endpoints[0].lat, lon: endpoints[0].lng, name: 'Start' },
        finish: { lat: endpoints[1].lat, lon: endpoints[1].lng, name: 'Finish' },
        departureUtc: `${departureLocal}:00Z`,
        polar,
        windGrid,
        currentGrid: currentGrid ?? undefined,
        landMask: landMask ?? undefined,
      });
      setComputed(result);
      setBusy(null);
    } catch (e) {
      setBusy(null);
      setError(e.message);
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

  const runScan = async () => {
    if (!route) return;
    setBusy('scanning departures');
    setError(null);
    setScan(null);
    try {
      const profileDraft = localStorage.getItem('deepweather.profile-draft');
      const profile = profileDraft ? JSON.parse(profileDraft) : profileDefaults;
      const departures = candidateDepartures(Date.parse(`${departureLocal}:00Z`), 120, 6);
      const partial = [];
      const result = await scanDepartures({ route, profile }, departures, (c) => {
        partial.push(c);
        setBusy(`scanning departures ${partial.length}/${departures.length}`);
      });
      setScan(result);
      setBusy(null);
    } catch (e) {
      setBusy(null);
      setError(e.message);
    }
  };

  // arriving from a briefing's "Find a departure that fits": run the scan once, then clear the flag
  const autoScan = usePlanner((s) => s.autoScan);
  useEffect(() => {
    if (autoScan && route && !busy) {
      patch({ autoScan: false });
      runScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScan, route]);

  const run = async () => {
    if (!route) return;
    setBusy('starting');
    setError(null);
    try {
      const profileDraft = localStorage.getItem('deepweather.profile-draft');
      const profile = profileDraft ? JSON.parse(profileDraft) : profileDefaults;
      if (!profile) throw new Error('No limits profile available — open Settings once');
      const departureUtc = `${departureLocal}:00Z`;
      await saveRoute(route);
      const { snapshotId } = await analyzeInBrowser({
        route,
        profile,
        departureUtc,
        onProgress: setBusy,
      });
      setBusy(null);
      await openSnapshot(snapshotId);
    } catch (e) {
      setBusy(null);
      setError(e.message);
    }
  };

  return (
    <div className="px-6 py-5 max-w-6xl">
      <h1 className="font-chart text-3xl mb-1">Plan a passage</h1>
      <p className="font-sans text-sm text-ink-soft mb-4">
        Click the chart to drop waypoints (drag to adjust), or import a GPX file. The analysis
        runs right here in your browser.
        {demoSnapshot && waypoints.length === 0 && !computed && (
          <>
            {' '}First time here?{' '}
            <button
              type="button"
              className="underline underline-offset-2 text-ink hover:text-ink-deep"
              onClick={() => openSnapshot(demoSnapshot.snapshot_id)}
            >
              See an example briefing
            </button>
            .
          </>
        )}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 border border-ink/30 rounded-sm overflow-hidden" style={{ height: 480 }}>
          <MapContainer
            center={[49.9, -3.0]}
            zoom={8}
            style={{ height: '100%', width: '100%', background: '#DCE5E6' }}
          >
            <TileLayer
              url="https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
              attribution='&copy; OpenStreetMap &copy; CARTO'
            />
            <TileLayer
              url="https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"
              attribution='seamarks &copy; OpenSeaMap'
            />
            <ClickCapture onClick={addWaypoint} />
            <FitRoute
              positions={
                mode === 'compute'
                  ? (computed?.route.waypoints ?? []).map((wp) => [wp.lat, wp.lon])
                  : waypoints.map((wp) => [wp.lat, wp.lng])
              }
              fitKey={`${fitNonce}:${mode === 'compute' ? computed?.arrival_utc ?? '' : ''}`}
            />
            {mode === 'draw' &&
              waypoints.map((wp, i) => (
                <Marker
                  key={i}
                  position={wp}
                  icon={waypointIcon}
                  draggable
                  eventHandlers={{
                    dragend: (e) => {
                      const next = [...waypoints];
                      next[i] = e.target.getLatLng();
                      setWaypoints(next);
                    },
                  }}
                />
              ))}
            {mode === 'draw' && waypoints.length >= 2 && (
              <Polyline positions={waypoints} pathOptions={{ color: '#16283E', weight: 2.5, dashArray: '6 4' }} />
            )}
            {mode === 'compute' &&
              endpoints.map((p, i) => <Marker key={`ep${i}`} position={p} icon={waypointIcon} />)}
            {mode === 'compute' && computed && (
              <Polyline
                positions={computed.route.waypoints.map((wp) => [wp.lat, wp.lon])}
                pathOptions={{ color: '#2F6E4F', weight: 3 }}
              />
            )}
          </MapContainer>
        </div>

        <Panel title="Passage">
          <div className="space-y-3 font-sans text-sm">
            <div className="flex gap-1.5" role="tablist" aria-label="Route mode">
              {[
                ['draw', 'Draw my route'],
                ['compute', 'Compute a route'],
              ].map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={clsx(
                    'px-2.5 py-1 border rounded-sm text-[13px]',
                    mode === m ? 'bg-ink text-paper border-ink' : 'border-line text-ink-soft hover:border-ink-soft',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === 'draw' && (
              <label className="block">
                <span className="eyebrow block mb-1">Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5"
                />
              </label>
            )}

            {mode === 'draw' && (
              <div>
                <span className="eyebrow block mb-1">Boat speed (kt) — slow / usual / fast</span>
                <div className="flex gap-2">
                  {['slow', 'nominal', 'fast'].map((k) => (
                    <input
                      key={k}
                      type="number"
                      step="0.5"
                      value={speeds[k]}
                      onChange={(e) => setSpeeds({ ...speeds, [k]: Number(e.target.value) })}
                      className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5 font-mono"
                      aria-label={`${k} speed`}
                    />
                  ))}
                </div>
              </div>
            )}

            {mode === 'compute' && (
              <>
                <BoatPicker
                  polarId={polarId}
                  polarLabel={polarLabel}
                  onSelect={(entry) => patch({ polarId: entry.polar_id, polarLabel: entry.label })}
                />
                <p className="text-[12px] text-ink-soft">
                  Click the chart twice: start, then finish. The route is computed from forecast
                  wind, currents and your polar — then audited like any other route.
                </p>
                <button
                  type="button"
                  onClick={runRouting}
                  disabled={endpoints.length !== 2 || !polarId || busy !== null}
                  className="w-full border border-ink/50 rounded-sm px-3 py-2 hover:bg-white/50 disabled:opacity-40"
                >
                  Compute route
                </button>
                {computed && (
                  <p className="text-[13px]">
                    <span className="font-mono">{computed.distance_nm} nm</span> ·{' '}
                    <span className="font-mono">{computed.duration_h} h</span> · arrives{' '}
                    <span className="font-mono">{computed.arrival_utc.slice(11, 16)} UTC</span> · avg{' '}
                    <span className="font-mono">{computed.avg_sog_kt} kt</span>
                    <span className="block text-[11px] text-ink-soft mt-0.5">
                      computed route — inherits polar uncertainty; audited below like any route
                    </span>
                  </p>
                )}
              </>
            )}

            <label className="block">
              <span className="eyebrow block mb-1">Departure (UTC)</span>
              <input
                type="datetime-local"
                value={departureLocal}
                onChange={(e) => setDepartureLocal(e.target.value)}
                className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5 font-mono"
              />
            </label>

            <div className="flex items-center justify-between border-t hairline pt-3">
              <span className="text-ink-soft">
                {mode === 'draw' ? `${waypoints.length} waypoints` : `${endpoints.length}/2 endpoints`}
                {mode === 'draw' && distance !== null && (
                  <>
                    {' · '}
                    <span className="font-mono">{distance} nm</span>
                    {' · ~'}
                    <span className="font-mono">{passageHours} h</span>
                  </>
                )}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    mode === 'draw' ? setWaypoints((w) => w.slice(0, -1)) : setEndpoints((e) => e.slice(0, -1))
                  }
                  className="underline text-ink-soft hover:text-ink"
                >
                  undo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWaypoints([]);
                    setEndpoints([]);
                    setComputed(null);
                  }}
                  className="underline text-ink-soft hover:text-ink"
                >
                  clear
                </button>
              </span>
            </div>

            {mode === 'draw' && (
              <div className="flex gap-2 items-center">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="border border-ink/40 rounded-sm px-3 py-1.5 hover:bg-white/50"
                >
                  Import GPX…
                </button>
                <input ref={fileRef} type="file" accept=".gpx" onChange={onGpx} className="hidden" />
              </div>
            )}

            <button
              type="button"
              onClick={run}
              disabled={!route || busy !== null}
              className="w-full bg-ink text-paper font-medium rounded-sm px-3 py-2.5 hover:bg-ink-deep disabled:opacity-40"
            >
              {busy ? `${busy}…` : 'Check this passage against my limits'}
            </button>
            {!route && busy === null && (
              <p className="text-[13px] text-ink-soft">
                {mode === 'draw'
                  ? 'To enable: click the chart at least twice — your start and your destination.'
                  : 'To enable: click the chart twice to set the two endpoints.'}
              </p>
            )}
            {route && busy === null && (
              <p className="text-[13px] text-ink-soft">
                Checking runs the analysis and saves the briefing to My briefings. Until then
                your draft stays here on this page.
              </p>
            )}
            <button
              type="button"
              onClick={runScan}
              disabled={!route || busy !== null}
              className="w-full border border-ink/50 rounded-sm px-3 py-2 hover:bg-white/50 disabled:opacity-40"
            >
              Compare departure times (next 5 days)
            </button>
            {error && <p className="text-verdict-exceeds text-[13px]">{error}</p>}
            {scan && scan.candidates.length === 0 && (
              <div className="border-t hairline pt-2">
                <span className="eyebrow">Departure comparison</span>
                <p className="text-[13px] text-ink-soft mt-1">
                  None of the candidate departures could be assessed — either the live forecast
                  doesn't reach that far ahead, or the forecast service was unreachable. Try a
                  departure within the next few days, or check your connection.
                </p>
              </div>
            )}
            {scan && scan.candidates.length > 0 && (
              <div className="border-t hairline pt-2">
                <span className="eyebrow">Departure comparison</span>
                <ul className="mt-1 space-y-1">
                  {scan.candidates.map((c, i) => (
                    <li key={c.departure_utc}>
                      <button
                        type="button"
                        onClick={() => setDepartureLocal(c.departure_utc.slice(0, 16))}
                        title="Use this departure time"
                        className={clsx(
                          'w-full flex items-center justify-between gap-2 text-[12px] px-1.5 py-1.5 rounded-sm text-left hover:bg-white/60',
                          i === scan.best_index && 'bg-shoal/50 border hairline',
                          `${departureLocal}:00Z` === c.departure_utc && 'outline outline-1 outline-ink/50',
                        )}
                      >
                        <span className="font-mono">{fmtTime(c.departure_utc)}</span>
                        <span
                          className="px-1.5 py-0.5 rounded-sm text-white text-[10px] font-medium whitespace-nowrap"
                          style={{ backgroundColor: (VERDICT[c.verdict] ?? VERDICT.insufficient).hex }}
                        >
                          {SCAN_VERDICT[c.verdict] ?? c.verdict}
                        </span>
                        {i === scan.best_index && (
                          <span className="text-ink-soft">least exposure — your call</span>
                        )}
                        {c.avoids_event_key && <span className="text-event">avoids {c.avoids_event_key}</span>}
                        {c.delta && i > 0 && <span className="font-mono text-[10px] text-ink-soft">gust {c.delta.peak_gust_kt > 0 ? '+' : ''}{c.delta.peak_gust_kt} kt · {c.delta.hours_over_limit > 0 ? '+' : ''}{c.delta.hours_over_limit} h over</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="text-[12px] text-ink-soft mt-1.5">
                  Click a time to use it, then “Check this passage against my limits” for the
                  full briefing.
                  {scan.candidates.length > 0 && scan.candidates.every((c) => c.verdict === 'insufficient') && (
                    <> Right now the forecast models disagree near your limits across this whole
                    window — a briefing will show you which models and when, and the next update
                    time.</>
                  )}
                </p>
              </div>
            )}
            <p className="text-[12px] text-ink-soft">
              Runs in your browser · forecasts fetched live · saved as an immutable snapshot.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
