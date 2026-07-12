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

  // shared by Compute route and the per-departure scan routing
  const loadRoutingInputs = async () => {
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
    return { polar, windGrid, currentGrid, landMask };
  };

  const routeForDeparture = (inputs, departureUtc) =>
    computeRoute({
      start: { lat: endpoints[0].lat, lon: endpoints[0].lng, name: 'Start' },
      finish: { lat: endpoints[1].lat, lon: endpoints[1].lng, name: 'Finish' },
      departureUtc,
      polar: inputs.polar,
      windGrid: inputs.windGrid,
      currentGrid: inputs.currentGrid ?? undefined,
      landMask: inputs.landMask ?? undefined,
    });

  const runRouting = async () => {
    if (endpoints.length !== 2 || !polarId) return;
    setBusy('computing route');
    setError(null);
    try {
      const inputs = await loadRoutingInputs();
      setComputed(routeForDeparture(inputs, `${departureLocal}:00Z`));
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
      // weather-dependent routing: in compute mode every candidate departure
      // gets its own route through its own wind field
      const routes = {};
      let routeFor;
      if (mode === 'compute' && endpoints.length === 2 && polarId) {
        const inputs = await loadRoutingInputs();
        routeFor = (departureUtc) => {
          const result = routeForDeparture(inputs, departureUtc);
          routes[departureUtc] = result;
          return result.route;
        };
      }
      const partial = [];
      const result = await scanDepartures({ route, profile, routeFor }, departures, (c) => {
        partial.push(c);
        setBusy(`scanning departures ${partial.length}/${departures.length}`);
      });
      setScan({ ...result, routes, rerouted: Boolean(routeFor), requested: departures.length });
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
    <div className="px-6 py-5 max-w-[1600px]">
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
            {scan && scan.candidates.length > 0 && (
              <p className="text-[12px] text-ink-soft border-t hairline pt-2">
                Departure comparison ready — see the full-width calendar below the chart.
              </p>
            )}
            <p className="text-[12px] text-ink-soft">
              Runs in your browser · forecasts fetched live · saved as an immutable snapshot.
            </p>
          </div>
        </Panel>
      </div>

      {scan && (
        <DepartureComparison
          scan={scan}
          departureLocal={departureLocal}
          onPick={(candidate) => {
            setDepartureLocal(candidate.departure_utc.slice(0, 16));
            const rerouted = scan.routes?.[candidate.departure_utc];
            if (rerouted) setComputed(rerouted);
          }}
        />
      )}
    </div>
  );
}

/**
 * Full-width departure calendar: days across, one colored cell per candidate
 * (same verdict colors as everywhere else). Click a cell to adopt that
 * departure — in compute mode the cell also carries its own weather-routed track.
 */
function DepartureComparison({ scan, departureLocal, onPick }) {
  if (scan.candidates.length === 0) {
    return (
      <section className="mt-6 border-t border-ink/40 pt-3">
        <h2 className="font-instrument font-semibold uppercase tracking-wider">Departure comparison</h2>
        <p className="font-sans text-sm text-ink-soft mt-2 max-w-[70ch]">
          None of the candidate departures could be assessed — either the live forecast doesn't
          reach that far ahead, or the forecast service was unreachable. Try a departure within
          the next few days, or check your connection.
        </p>
      </section>
    );
  }

  const days = [];
  for (const [i, c] of scan.candidates.entries()) {
    const stamp = fmtTime(c.departure_utc); // "Mon 13 Jul 06:00"
    const day = stamp.slice(0, -6);
    if (days.at(-1)?.day !== day) days.push({ day, cells: [] });
    days.at(-1).cells.push({ ...c, index: i, hhmm: stamp.slice(-5) });
  }
  const best = scan.best_index !== null ? scan.candidates[scan.best_index] : null;
  const baseline = scan.candidates[0];
  const allInsufficient = scan.candidates.every((c) => c.verdict === 'insufficient');

  return (
    <section className="mt-6 border-t border-ink/40 pt-3" aria-label="Departure comparison">
      <div className="flex justify-between items-baseline flex-wrap gap-2">
        <h2 className="font-instrument font-semibold uppercase tracking-wider">
          Departure comparison · next 5 days
        </h2>
        <span className="eyebrow">
          {scan.rerouted ? 'each departure sails its own computed route' : 'same route, different weather'}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-3 mt-3">
        {days.map((d) => (
          <div key={d.day}>
            <p className="font-instrument text-[11px] uppercase tracking-wider text-ink-soft mb-1">{d.day}</p>
            <div className="flex gap-1.5">
              {d.cells.map((c) => {
                const v = VERDICT[c.verdict] ?? VERDICT.insufficient;
                const parts = [SCAN_VERDICT[c.verdict] ?? c.verdict];
                if (c.passage_h) parts.push(`≈${Math.round(c.passage_h)} h passage`);
                if (c.delta && c.index > 0) {
                  parts.push(`gusts ${c.delta.peak_gust_kt > 0 ? '+' : ''}${Math.round(c.delta.peak_gust_kt)} kt vs first option`);
                  parts.push(`${c.delta.hours_over_limit > 0 ? '+' : ''}${c.delta.hours_over_limit} h over your limit`);
                }
                return (
                  <button
                    key={c.departure_utc}
                    type="button"
                    onClick={() => onPick(c)}
                    title={`${fmtTime(c.departure_utc)} UTC — ${parts.join(' · ')}`}
                    className={clsx(
                      'w-[66px] h-[54px] rounded-sm text-white flex flex-col items-center justify-center gap-0.5',
                      `${departureLocal}:00Z` === c.departure_utc && 'outline outline-2 outline-ink outline-offset-1',
                    )}
                    style={{ backgroundColor: v.hex }}
                  >
                    <span className="font-mono text-[12px] font-semibold">{c.hhmm}</span>
                    <span className="text-[11px]" aria-hidden>{c.index === scan.best_index ? '◎' : v.glyph}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {scan.requested > scan.candidates.length && (
        <p className="font-sans text-[12px] text-ink-soft mt-2">
          {scan.requested - scan.candidates.length} of {scan.requested} departure times could not
          be assessed — they fall beyond the {scan.rerouted ? 'prepared routing-wind' : 'forecast'}{' '}
          horizon — and are not shown. No cell does not mean fine.
        </p>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-2 mt-3">
        <p className="font-sans text-[13px] max-w-[80ch]">
          {best && (
            <>
              <span className="font-medium">◎ Least exposure this window: {fmtTime(best.departure_utc)} UTC</span>
              {' — '}your call, as always.{' '}
            </>
          )}
          Click a time to use it{scan.rerouted ? ' (its route appears on the chart)' : ''}, then
          “Check this passage against my limits” for the full briefing.
          {allInsufficient && (
            <> Right now the forecast models disagree near your limits across this whole window —
            a briefing will show you which models and when, and the next update time.</>
          )}
        </p>
        <span className="flex gap-4 font-sans text-[11px] text-ink-soft">
          {['within', 'approaching', 'exceeds', 'insufficient'].map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="w-3.5 h-2.5 inline-block rounded-[2px]" style={{ backgroundColor: VERDICT[s].hex }} />
              {SCAN_VERDICT[s]}
            </span>
          ))}
        </span>
      </div>
    </section>
  );
}
