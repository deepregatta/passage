import { palette } from '../../lib/palette.js';
import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Rectangle, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BASEMAP } from '../../lib/basemap.js';
import MapTouchScroll from '../../components/MapTouchScroll.jsx';
import { labelMarker, markerIcon, markerSpecs } from './plannerMarkers.js';

/** The map frame stretches to the Passage panel beside it; tell Leaflet whenever
 * that height changes so tiles fill the new area. */
function TrackFrameSize({ frameRef }) {
  const map = useMap();
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(frameRef.current);
    return () => observer.disconnect();
  }, [map, frameRef]);
  return null;
}

function ClickCapture({ onClick }) {
  useMapEvents({ click: (e) => onClick(e.latlng) });
  return null;
}

/** Bring the whole route into view when returning to the planner or when a
 * route arrives whole (computed / GPX); never while the user is drawing. */
function FitRoute({ positions, fitKey, chartArea }) {
  const map = useMap();
  const lastFit = useRef(null);
  useEffect(() => {
    // Positions change while drawing; only an explicit fit request moves the map.
    if (lastFit.current?.map === map && lastFit.current.key === fitKey && lastFit.current.area === chartArea) return;
    const newArea = chartArea && (lastFit.current?.map !== map || lastFit.current?.area !== chartArea);
    lastFit.current = { map, key: fitKey, area: chartArea };
    if (newArea) {
      map.fitBounds([[chartArea.minLat, chartArea.minLon], [chartArea.maxLat, chartArea.maxLon]], { padding: [32, 32] });
    } else if (positions.length >= 2) {
      map.fitBounds(L.latLngBounds(positions), { padding: [32, 32], maxZoom: 10 });
    }
  }, [map, fitKey, positions, chartArea]);
  return null;
}

export default function PlannerMap({ mode, waypoints, computed, endpoints, fitNonce, chartArea, addWaypoint, setWaypoints, children }) {
  const frameRef = useRef(null);
  return (
    <div ref={frameRef} className="isolate relative h-[40vh] min-h-[240px] lg:h-auto lg:min-h-[calc(100vh-8rem)] border border-ink/30 rounded-sm overflow-hidden">
      <MapContainer
        center={[49.9, -3.0]}
        zoom={8}
        style={{ height: '100%', width: '100%', background: palette.shoal }}
      >
        <TileLayer {...BASEMAP} />
        <TileLayer
          url="https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"
          attribution='seamarks &copy; OpenSeaMap'
        />
        <TrackFrameSize frameRef={frameRef} />
        <MapTouchScroll />
        <ClickCapture onClick={addWaypoint} />
        <FitRoute
          chartArea={chartArea}
          positions={
            mode === 'compute'
              ? computed
                ? computed.route.waypoints.map((wp) => [wp.lat, wp.lon])
                : endpoints.map((p) => [p.lat, p.lng])
              : waypoints.map((wp) => [wp.lat, wp.lng])
          }
          fitKey={`${fitNonce}:${mode === 'compute' ? computed?.arrival_utc ?? '' : ''}`}
        />
        {chartArea && <Rectangle bounds={[[chartArea.minLat, chartArea.minLon], [chartArea.maxLat, chartArea.maxLon]]}
          pathOptions={{ color: palette.ink.DEFAULT, weight: 1, dashArray: '6 4', fill: false }} />}
        {mode === 'draw' &&
          markerSpecs(waypoints.length).map((spec, i) => (
            <Marker
              key={`${i}:${spec.ariaLabel}`}
              position={waypoints[i]}
              icon={markerIcon(spec)}
              title={spec.ariaLabel}
              draggable
              eventHandlers={{
                ...labelMarker(spec),
                dragend: (e) => {
                  const next = [...waypoints];
                  next[i] = e.target.getLatLng();
                  setWaypoints(next);
                },
              }}
            />
          ))}
        {mode === 'draw' && waypoints.length >= 2 && (
          <Polyline positions={waypoints} pathOptions={{ color: palette.ink.DEFAULT, weight: 2.5, dashArray: '6 4' }} />
        )}
        {mode === 'compute' &&
          markerSpecs(endpoints.length).map((spec, i) => (
            <Marker
              key={`ep${i}:${spec.ariaLabel}`}
              position={endpoints[i]}
              icon={markerIcon(spec)}
              title={spec.ariaLabel}
              eventHandlers={labelMarker(spec)}
            />
          ))}
        {mode === 'compute' && computed && (
          <Polyline
            positions={computed.route.waypoints.map((wp) => [wp.lat, wp.lon])}
            pathOptions={{ color: palette.verdict.within, weight: 3 }}
          />
        )}
      </MapContainer>
      {children}
    </div>
  );
}
