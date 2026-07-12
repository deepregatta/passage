import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useApp } from '../stores/appStore.js';
import { STATUS_HEX, hourStatus, fmtTime } from '../lib/format.js';

/**
 * The passage on a chart (mockup 1): marine-styled Leaflet — light base +
 * OpenSeaMap seamarks — with the route polyline, leg markers colored by their
 * worst limit status, wind arrows at each leg midpoint, and tidal-gate marks.
 */

const seaStyle = { height: '100%', width: '100%', background: '#CBDCE0' };

function legWorstStatus(leg) {
  let worst = 'ok';
  const rank = { ok: 0, unknown: 0, approaching: 1, exceeded: 2 };
  for (const hour of leg.hours) {
    const s = hourStatus(hour);
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}

function legMarkerIcon(label, color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};color:#F3EEE3;
      border:2px solid #F3EEE3;box-shadow:0 0 0 1.5px ${color};font:600 11px system-ui;
      display:flex;align-items:center;justify-content:center">${label}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

/** arrow flies WITH the wind (dir = coming-from, so rotate +180) */
function windArrowIcon(windFromDeg, windKt) {
  const rotation = (windFromDeg + 180) % 360;
  return L.divIcon({
    className: '',
    html: `<div style="display:flex;flex-direction:column;align-items:center;pointer-events:none">
      <svg width="30" height="30" viewBox="0 0 30 30" style="transform:rotate(${rotation}deg);opacity:.85">
        <path d="M15 4 L15 24 M15 4 L10 11 M15 4 L20 11" stroke="#31445E" stroke-width="2.4"
          fill="none" stroke-linecap="round"/>
      </svg>
      <span style="font:600 9px ui-monospace,monospace;color:#31445E;background:#F3EEE3cc;
        padding:0 3px;border-radius:2px;margin-top:-4px">${Math.round(windKt)}kt</span>
    </div>`,
    iconSize: [30, 40],
    iconAnchor: [15, 20],
  });
}

function gateIcon(status) {
  const color = status === 'conflict' ? '#A63B2A' : status === 'marginal' ? '#A87718' : '#2F6E4F';
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;background:${color};transform:rotate(45deg);
      border:2px solid #F3EEE3;box-shadow:0 0 0 1px ${color}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export default function RouteMap({ height = 420 }) {
  const findings = useApp((s) => s.findings);
  const [routeDoc, setRouteDoc] = useState(null);
  const [gatePositions, setGatePositions] = useState({});

  useEffect(() => {
    if (!findings) return;
    fetch(`/data/snapshots/${findings.snapshot_id}/route.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setRouteDoc);
    fetch('/data/config/gates.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => {
        const map = {};
        for (const g of doc?.gates ?? []) map[g.gate_id] = g;
        setGatePositions(map);
      });
  }, [findings]);

  const bounds = useMemo(() => {
    if (!routeDoc) return null;
    const lats = routeDoc.waypoints.map((w) => w.lat);
    const lons = routeDoc.waypoints.map((w) => w.lon);
    return [
      [Math.min(...lats) - 0.15, Math.min(...lons) - 0.25],
      [Math.max(...lats) + 0.15, Math.max(...lons) + 0.25],
    ];
  }, [routeDoc]);

  const legArrows = useMemo(() => {
    if (!findings) return [];
    return findings.legs
      .map((leg) => {
        // wind at the mid-occupancy hour, drawn at the leg's sample point
        const mid = leg.hours[Math.floor(leg.hours.length / 2)];
        if (!mid || mid.wind_dir_deg === null || mid.wind_kt === null) return null;
        return {
          leg_id: leg.leg_id,
          lat: leg.sample_point.lat,
          lon: leg.sample_point.lon,
          dir: mid.wind_dir_deg,
          kt: mid.wind_kt,
          time: mid.valid_time,
        };
      })
      .filter(Boolean);
  }, [findings]);

  if (!findings || !routeDoc || !bounds) {
    return <p className="font-sans text-sm text-ink-soft">Loading chart…</p>;
  }

  const positions = routeDoc.waypoints.map((w) => [w.lat, w.lon]);

  return (
    <div className="border border-ink/30 rounded-sm overflow-hidden" style={{ height }}>
      <MapContainer bounds={bounds} style={seaStyle} scrollWheelZoom={false} attributionControl>
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; OpenStreetMap'
          opacity={0.55}
        />
        <TileLayer
          url="https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"
          attribution='seamarks &copy; OpenSeaMap'
        />
        <Polyline
          positions={positions}
          pathOptions={{ color: '#16283E', weight: 2.5, dashArray: '1 7', lineCap: 'round' }}
        />
        {findings.legs.map((leg, i) => {
          const status = legWorstStatus(leg);
          const wp = routeDoc.waypoints[i + 1] ?? routeDoc.waypoints[i];
          return (
            <Marker
              key={leg.leg_id}
              position={[wp.lat, wp.lon]}
              icon={legMarkerIcon(i + 1, STATUS_HEX[status])}
            >
              <Tooltip direction="top" offset={[0, -12]}>
                <span className="font-sans text-[12px]">
                  <b>{leg.leg_id}</b> · {leg.distance_nm} nm · arrive{' '}
                  {fmtTime(leg.eta_range.fast).slice(-5)}–{fmtTime(leg.eta_range.slow).slice(-5)} UTC
                </span>
              </Tooltip>
            </Marker>
          );
        })}
        {legArrows.map((a) => (
          <Marker key={`w${a.leg_id}`} position={[a.lat, a.lon]} icon={windArrowIcon(a.dir, a.kt)} interactive={false} />
        ))}
        {(findings.gates ?? []).map((g) => {
          const pos = gatePositions[g.gate_id];
          if (!pos) return null;
          return (
            <Marker key={g.gate_id} position={[pos.lat, pos.lon]} icon={gateIcon(g.status)}>
              <Tooltip direction="top" offset={[0, -10]}>
                <span className="font-sans text-[12px]">
                  <b>{g.name}</b> — gate {g.status}
                </span>
              </Tooltip>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
