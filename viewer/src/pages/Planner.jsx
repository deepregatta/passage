import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { deriveLegs, totalDistanceNm, parseGpx } from '@deepweather/engine';
import { useApp } from '../stores/appStore.js';
import { analyzeInBrowser, saveRoute } from '../lib/browserAnalysis.js';
import { Panel } from '../components/common.jsx';

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

  const [waypoints, setWaypoints] = useState([]);
  const [name, setName] = useState('My passage');
  const [speeds, setSpeeds] = useState({ slow: 4.5, nominal: 5.5, fast: 6.5 });
  const [departureLocal, setDepartureLocal] = useState(defaultDeparture);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const route = useMemo(() => {
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
  }, [waypoints, name, speeds]);

  const distance = useMemo(() => {
    if (!route) return null;
    return Math.round(totalDistanceNm(deriveLegs(route)) * 10) / 10;
  }, [route]);
  const passageHours = distance ? Math.round(distance / speeds.nominal) : null;

  const addWaypoint = useCallback((latlng) => {
    setWaypoints((wps) => [...wps, latlng]);
  }, []);

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
            />
            <ClickCapture onClick={addWaypoint} />
            {waypoints.map((wp, i) => (
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
            {waypoints.length >= 2 && (
              <Polyline positions={waypoints} pathOptions={{ color: '#16283E', weight: 2.5, dashArray: '6 4' }} />
            )}
          </MapContainer>
        </div>

        <Panel title="Passage">
          <div className="space-y-3 font-sans text-sm">
            <label className="block">
              <span className="eyebrow block mb-1">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-white/60 border hairline rounded-sm px-2 py-1.5"
              />
            </label>

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
                {waypoints.length} waypoints
                {distance !== null && (
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
                  onClick={() => setWaypoints((w) => w.slice(0, -1))}
                  disabled={!waypoints.length}
                  className="underline text-ink-soft hover:text-ink disabled:opacity-40"
                >
                  undo
                </button>
                <button
                  type="button"
                  onClick={() => setWaypoints([])}
                  disabled={!waypoints.length}
                  className="underline text-ink-soft hover:text-ink disabled:opacity-40"
                >
                  clear
                </button>
              </span>
            </div>

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

            <button
              type="button"
              onClick={run}
              disabled={!route || busy !== null}
              className="w-full bg-ink text-paper font-medium rounded-sm px-3 py-2.5 hover:bg-ink-deep disabled:opacity-40"
            >
              {busy ? `${busy}…` : 'Check this passage against my limits'}
            </button>
            {error && <p className="text-verdict-exceeds text-[13px]">{error}</p>}
            <p className="text-[12px] text-ink-soft">
              Runs in your browser · forecasts fetched live · saved as an immutable snapshot.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
