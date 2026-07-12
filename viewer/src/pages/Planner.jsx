import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents } from 'react-leaflet';
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
import { VerdictChip } from '../components/common.jsx';
import { fmtTime } from '../lib/format.js';
import { useApp } from '../stores/appStore.js';
import { analyzeInBrowser, saveRoute } from '../lib/browserAnalysis.js';
import { Panel } from '../components/common.jsx';
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

function ClickCapture({ onClick }) {
  useMapEvents({ click: (e) => onClick(e.latlng) });
  return null;
}

function defaultDeparture() {
  const t = new Date(Date.now() + 24 * 3600_000);
  t.setUTCHours(6, 0, 0, 0);
  return t.toISOString().slice(0, 16);
}

export default function Planner() {
  const openSnapshot = useApp((s) => s.openSnapshot);
  const profileDefaults = useApp((s) => s.profileDefaults);
  const loadConfig = useApp((s) => s.loadConfig);

  const [mode, setMode] = useState('draw'); // draw | compute
  const [waypoints, setWaypoints] = useState([]);
  const [computed, setComputed] = useState(null); // RoutingResult
  const [endpoints, setEndpoints] = useState([]); // [start, finish] in compute mode
  const [polars, setPolars] = useState([]);
  const [polarId, setPolarId] = useState(null);
  const [name, setName] = useState('My passage');
  const [speeds, setSpeeds] = useState({ slow: 4.5, nominal: 5.5, fast: 6.5 });
  const [departureLocal, setDepartureLocal] = useState(defaultDeparture);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    loadConfig();
    loadJson('/data/config/polars/index.json').then((idx) => {
      const list = idx?.polars ?? [];
      setPolars(list);
      if (list.length) setPolarId(list[0].polar_id);
    });
  }, [loadConfig]);

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
        loadJson(`/data/config/polars/${polarId}.json`),
      ]);
      if (!latest?.artifacts?.wind_grid) {
        throw new Error('No prepared wind grid — run deepweather-analysis prepare-run first');
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
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const [scan, setScan] = useState(null);

  const runScan = async () => {
    if (!route) return;
    setBusy('scanning departures');
    setError(null);
    setScan(null);
    try {
      const profileDraft = localStorage.getItem('deepweather.profile-draft');
      const profile = profileDraft ? JSON.parse(profileDraft) : profileDefaults;
      const departures = candidateDepartures(Date.parse(`${departureLocal}:00Z`), 48, 6);
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
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 border border-ink/30 rounded-sm overflow-hidden" style={{ height: 480 }}>
          <MapContainer
            center={[49.9, -3.0]}
            zoom={8}
            style={{ height: '100%', width: '100%', background: '#DCE5E6' }}
          >
            <TileLayer
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; OpenStreetMap contributors'
              opacity={0.55}
            />
            <TileLayer
              url="https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"
              attribution='seamarks &copy; OpenSeaMap'
            />
            <ClickCapture onClick={addWaypoint} />
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
                <label className="block">
                  <span className="eyebrow block mb-1">Your boat (ORC polar)</span>
                  <select
                    value={polarId ?? ''}
                    onChange={(e) => setPolarId(e.target.value)}
                    className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5"
                  >
                    {polars.map((p) => (
                      <option key={p.polar_id} value={p.polar_id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
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
            <button
              type="button"
              onClick={runScan}
              disabled={!route || busy !== null}
              className="w-full border border-ink/50 rounded-sm px-3 py-2 hover:bg-white/50 disabled:opacity-40"
            >
              Compare departure times (next 48 h)
            </button>
            {error && <p className="text-verdict-exceeds text-[13px]">{error}</p>}
            {scan && (
              <div className="border-t hairline pt-2">
                <span className="eyebrow">Departure comparison</span>
                <ul className="mt-1 space-y-1">
                  {scan.candidates.map((c, i) => (
                    <li
                      key={c.departure_utc}
                      className={clsx(
                        'flex items-center justify-between gap-2 text-[12px] px-1.5 py-1 rounded-sm',
                        i === scan.best_index && 'bg-shoal/50 border hairline',
                      )}
                    >
                      <span className="font-mono">{fmtTime(c.departure_utc)}</span>
                      <VerdictChip state={c.verdict} small />
                      {i === scan.best_index && (
                        <span className="text-ink-soft">least exposure — your call</span>
                      )}
                    </li>
                  ))}
                </ul>
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
