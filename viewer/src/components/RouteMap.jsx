import { palette } from '../lib/palette.js';
import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { GridSampler } from '@deepweather/engine';
import { useApp } from '../stores/appStore.js';
import { frameForCursor, usePlayback } from '../stores/playbackStore.js';
import { STATUS_HEX, hourStatus, fmtTime } from '../lib/format.js';
import { preparedRun, artifactUrl } from '../lib/preparedRun.js';
import { BASEMAP } from '../lib/basemap.js';

/**
 * The passage on a chart (mockup 1): marine-styled Leaflet; light base +
 * OpenSeaMap seamarks; with the route polyline, leg markers colored by their
 * worst limit status, wind arrows at each leg midpoint, and tidal-gate marks.
 */

const seaStyle = { height: '100%', width: '100%', background: palette.sea };

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
    html: `<div class="font-instrument" style="width:22px;height:22px;border-radius:50%;background:${color};color:${palette.paper.DEFAULT};
      border:2px solid ${palette.paper.DEFAULT};box-shadow:0 0 0 1.5px ${color};font-size:11px;font-weight:600;line-height:normal;
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
        <path d="M15 4 L15 24 M15 4 L10 11 M15 4 L20 11" stroke="${palette.wind}" stroke-width="2.4"
          fill="none" stroke-linecap="round"/>
      </svg>
      <span style="font:600 9px ui-monospace,monospace;color:${palette.wind};background:${palette.paper.DEFAULT}cc;
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
        stroke="${palette.wave}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
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
        <circle cx="17" cy="17" r="12.5" fill="${palette.paper.DEFAULT}" fill-opacity=".25" stroke="${palette.verdict.approaching}" stroke-width="2"/>
        <path d="M17 8 L22.5 24 L17 20.6 L11.5 24 Z" fill="${palette.verdict.approaching}" stroke="${palette.paper.DEFAULT}" stroke-width="1.4"/>
      </svg>
    </div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function gateIcon(status) {
  const color = status === 'conflict' ? palette.verdict.exceeds : status === 'marginal' ? palette.verdict.approaching : palette.verdict.within;
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;background:${color};transform:rotate(45deg);
      border:2px solid ${palette.paper.DEFAULT};box-shadow:0 0 0 1px ${color}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export default function RouteMap({ height = 420 }) {
  const findings = useApp((s) => s.findings);
  const example = useApp((s) => s.manifest?.snapshots?.some(item => item.snapshot_id === s.snapshotId && item.demo === true));
  const routeDoc = useApp((s) => s.route);
  const [gatePositions, setGatePositions] = useState({});
  const [windGrid, setWindGrid] = useState(null);

  useEffect(() => {
    setGatePositions({});
    if (!findings) return;
    const controller = new AbortController();
    fetch('/data/config/gates.json', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => {
        if (controller.signal.aborted) return;
        const map = {};
        for (const g of doc?.gates ?? []) map[g.gate_id] = g;
        setGatePositions(map);
      })
      .catch(() => {}); // Optional gate markers are unavailable offline.
    return () => controller.abort();
  }, [findings]);

  useEffect(() => {
    const controller = new AbortController();
    setWindGrid(null);
    // A stored example must never mix in current forecast data.
    if (!findings || example) return;
    preparedRun()
      .then(async ({ doc }) => {
        if (!doc?.artifacts?.wind_grid || controller.signal.aborted) return null;
        const url = await artifactUrl(doc.artifacts.wind_grid);
        if (controller.signal.aborted) return null;
        const response = await fetch(url, { signal: controller.signal });
        return response.ok ? response.json() : null;
      })
      .then(grid => { if (!controller.signal.aborted) setWindGrid(grid); })
      .catch(() => {}); // Keep the route visible without the background field.
    return () => controller.abort();
  }, [findings, example]);

  const bounds = useMemo(() => {
    if (!routeDoc?.waypoints?.length) return null;
    const lats = routeDoc.waypoints.map((w) => w.lat);
    const lons = routeDoc.waypoints.map((w) => w.lon);
    return [
      [Math.min(...lats) - 0.15, Math.min(...lons) - 0.25],
      [Math.max(...lats) + 0.15, Math.max(...lons) + 0.25],
    ];
  }, [routeDoc]);

  // background wind field at mid-passage time, subsampled from the prepared grid
  const fieldArrows = useMemo(() => {
    if (example || !windGrid || !findings?.legs.length || !bounds) return [];
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
          pathOptions={{ color: palette.ink.DEFAULT, weight: 2.5, dashArray: '1 7', lineCap: 'round' }}
        />
        {findings.legs.map((leg, i) => {
          const status = legWorstStatus(leg);
          const wp = routeDoc.waypoints[i + 1] ?? routeDoc.waypoints[i];
          if (!wp) return null;
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
        <BoatMarker findings={findings} route={routeDoc} />
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

/** Keep frame updates inside the moving marker, away from the static map layers. */
function BoatMarker({ findings, route }) {
  const cursor = usePlayback((s) => s.cursorHours);
  const frame = frameForCursor(findings, null, route, cursor);
  const bearing = findings.legs.find((leg) => leg.leg_id === frame.activeLegId)?.bearing_deg_true ?? 0;
  const icon = useMemo(() => boatIcon(bearing), [bearing]);
  if (!frame.boatPosition) return null;
  return <Marker position={[frame.boatPosition.lat, frame.boatPosition.lon]} icon={icon} interactive={false} zIndexOffset={500} />;
}
