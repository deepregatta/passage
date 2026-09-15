import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BASEMAP } from '../../lib/basemap.js';

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

/** Bring the whole route into view when returning to the planner or when a
 * route arrives whole (computed / GPX); never while the user is drawing. */
function FitRoute({ positions, fitKey }) {
  const map = useMap();
  const lastFit = useRef(null);
  useEffect(() => {
    // Positions change while drawing; only an explicit fit request moves the map.
    if (lastFit.current?.map === map && lastFit.current.key === fitKey) return;
    lastFit.current = { map, key: fitKey };
    if (positions.length >= 2) {
      map.fitBounds(L.latLngBounds(positions), { padding: [32, 32], maxZoom: 10 });
    }
  }, [map, fitKey, positions]);
  return null;
}

export default function PlannerMap({ mode, waypoints, computed, endpoints, fitNonce, addWaypoint, setWaypoints }) {
  return (
    <div className="lg:col-span-2 border border-ink/30 rounded-sm overflow-hidden" style={{ height: 480 }}>
      <MapContainer
        center={[49.9, -3.0]}
        zoom={8}
        style={{ height: '100%', width: '100%', background: '#DCE5E6' }}
      >
        <TileLayer {...BASEMAP} />
        <TileLayer
          url="https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"
          attribution='seamarks &copy; OpenSeaMap'
        />
        <ClickCapture onClick={addWaypoint} />
        <FitRoute
          positions={
            mode === 'compute'
              ? computed
                ? computed.route.waypoints.map((wp) => [wp.lat, wp.lon])
                : endpoints.map((p) => [p.lat, p.lng])
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
  );
}
