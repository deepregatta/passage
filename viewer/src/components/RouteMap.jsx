import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { GridSampler } from '@deepweather/engine';
import { useApp } from '../stores/appStore.js';
import { frameForCursor, usePlayback } from '../stores/playbackStore.js';
import { STATUS_HEX, hourStatus, fmtTime } from '../lib/format.js';
import { fetchSnapshotJson } from '../lib/localSnapshots.js';
import { preparedRun, artifactUrl } from '../lib/preparedRun.js';
import { BASEMAP } from '../lib/basemap.js';

/**
 * The passage on a chart (mockup 1): marine-styled Leaflet; light base +
 * OpenSeaMap seamarks; with the route polyline, leg markers colored by their
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

function legMarkerIcon(label, color, status) {
  const mark = status === 'exceeded' ? '×' : status === 'approaching' ? '!' : '·';
  return L.divIcon({
    className: '',
    html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};color:#F3EEE3;
      border:2px solid #F3EEE3;box-shadow:0 0 0 1.5px ${color};font:600 11px system-ui;
      display:flex;align-items:center;justify-content:center;background-image:${status === 'exceeded' ? 'repeating-linear-gradient(135deg,transparent 0 3px,rgba(255,255,255,.32) 3px 5px)' : 'none'}" title="leg ${label}: ${status}">${label}${mark}</div>`,
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

/** faint background flow arrow (the mockup's wind field); no label, non-interactive */
function fieldArrowIcon(windFromDeg, windKt) {
  const rotation = (windFromDeg + 180) % 360;
  const len = Math.min(20, 8 + windKt * 0.45);
  return L.divIcon({
    className: '',
    html: `<svg width="22" height="22" viewBox="0 0 22 22"
      style="transform:rotate(${rotation}deg);opacity:.5;pointer-events:none">
      <path d="M11 ${11 - len / 2} L11 ${11 + len / 2} M11 ${11 - len / 2} L8 ${11 - len / 2 + 4} M11 ${11 - len / 2} L14 ${11 - len / 2 + 4}"
        stroke="#52739E" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    </svg>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

/** the boat, same gold mark as on the synoptic chart, pointing along its leg */
function boatIcon(bearingDeg) {
  return L.divIcon({
    className: '',
    html: `<div style="pointer-events:none">
      <svg width="34" height="34" viewBox="0 0 34 34" style="transform:rotate(${Math.round(bearingDeg)}deg)">
        <circle cx="17" cy="17" r="12.5" fill="#F3EEE3" fill-opacity=".25" stroke="#A87718" stroke-width="2"/>
        <path d="M17 8 L22.5 24 L17 20.6 L11.5 24 Z" fill="#A87718" stroke="#F3EEE3" stroke-width="1.4"/>
      </svg>
    </div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
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
  const synoptic = useApp((s) => s.synoptic);
  const example = useApp((s) => s.manifest?.snapshots?.some(item => item.snapshot_id === s.snapshotId && item.demo === true));
  const cursor = usePlayback((s) => s.cursorHours);
  const [routeDoc, setRouteDoc] = useState(null);
  const [gatePositions, setGatePositions] = useState({});
  const [windGrid, setWindGrid] = useState(null);

  // same time cursor as the synoptic playback: the boat sails the route as it plays
  const frame = useMemo(
    () => frameForCursor(findings, synoptic, routeDoc, cursor),
    [findings, synoptic, routeDoc, cursor],
  );
  const activeLeg = findings?.legs.find((leg) => leg.leg_id === frame.activeLegId);

  useEffect(() => {
    if (!findings) return;
    fetchSnapshotJson(findings.snapshot_id, 'route.json')
      .catch(() => null)
      .then(setRouteDoc);
    fetch('/data/config/gates.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => {
        const map = {};
        for (const g of doc?.gates ?? []) map[g.gate_id] = g;
        setGatePositions(map);
      });
  }, [findings]);

  useEffect(() => {
    let cancelled = false;
    setWindGrid(null);
    // A stored example must never mix in current forecast data.
    if (!findings || example) return;
    preparedRun()
      .then(({ doc }) =>
        doc?.artifacts?.wind_grid
          ? artifactUrl(doc.artifacts.wind_grid)
              .then(fetch)
              .then((r) => (r.ok ? r.json() : null))
          : null,
      )
      .then(grid => { if (!cancelled) setWindGrid(grid); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [findings, example]);

  const bounds = useMemo(() => {
    if (!routeDoc) return null;
    const lats = routeDoc.waypoints.map((w) => w.lat);
    const lons = routeDoc.waypoints.map((w) => w.lon);
    return [
      [Math.min(...lats) - 0.15, Math.min(...lons) - 0.25],
      [Math.max(...lats) + 0.15, Math.max(...lons) + 0.25],
    ];
  }, [routeDoc]);

  // background wind field at mid-passage time, subsampled from the prepared grid
  const fieldArrows = useMemo(() => {
    if (example || !windGrid || !findings || !bounds) return [];
    const sampler = new GridSampler(windGrid);
    const midMs =
      (Date.parse(findings.departure_utc) +
        Date.parse(findings.legs[findings.legs.length - 1].eta_range.slow)) /
      2;
    const [[latMin, lonMin], [latMax, lonMax]] = bounds;
    const arrows = [];
    const step = Math.max(windGrid.dlat, (latMax - latMin) / 9, 0.2);
    for (let lat = latMin + step / 2; lat <= latMax; lat += step) {
      for (let lon = lonMin + step / 2; lon <= lonMax; lon += step * 1.35) {
        const s = sampler.sample(lat, lon, midMs);
        if (!s) continue;
        const kt = Math.hypot(s.u_kt, s.v_kt);
        if (kt < 2) continue;
        const from = (Math.atan2(-s.u_kt, -s.v_kt) * 180) / Math.PI;
        arrows.push({ lat, lon, dir: (from + 360) % 360, kt });
      }
    }
    return arrows;
  }, [windGrid, findings, bounds, example]);

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
        <TileLayer {...BASEMAP} />
        <TileLayer
          url="https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"
          attribution='seamarks &copy; OpenSeaMap'
        />
        {fieldArrows.map((a, i) => (
          <Marker
            key={`f${i}`}
            position={[a.lat, a.lon]}
            icon={fieldArrowIcon(a.dir, a.kt)}
            interactive={false}
          />
        ))}
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
              icon={legMarkerIcon(i + 1, STATUS_HEX[status], status)}
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
        {frame.boatPosition && (
          <Marker
            position={[frame.boatPosition.lat, frame.boatPosition.lon]}
            icon={boatIcon(activeLeg?.bearing_deg_true ?? 0)}
            interactive={false}
            zIndexOffset={500}
          />
        )}
        {(findings.gates ?? []).map((g) => {
          const pos = gatePositions[g.gate_id];
          if (!pos) return null;
          return (
            <Marker key={g.gate_id} position={[pos.lat, pos.lon]} icon={gateIcon(g.status)}>
              <Tooltip direction="top" offset={[0, -10]}>
                <span className="font-sans text-[12px]">
                  <b>{g.name}</b> · gate {g.status}
                </span>
              </Tooltip>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
