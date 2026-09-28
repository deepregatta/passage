import { useEffect, useRef, useState } from 'react';
import { MapContainer, Marker, Rectangle, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BASEMAP } from '../../lib/basemap.js';
import { gribArea } from '../../lib/gribExport.js';
import { palette } from '../../lib/palette.js';

// a press that moves less than this is a click: the first corner of a two-click box
const DRAG_THRESHOLD_PX = 6;

const boxStyle = { color: palette.event, weight: 2, dashArray: '6 4', fillColor: palette.event, fillOpacity: 0.06 };

const cornerIcon = L.divIcon({
  className: '',
  html: `<div style="width:14px;height:14px;background:${palette.paper.DEFAULT};border:2px solid ${palette.event};cursor:nwse-resize"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

const toBounds = (area) => [[area.minLat, area.minLon], [area.maxLat, area.maxLon]];
const rawBox = (a, b) => ({
  minLat: Math.min(a.lat, b.lat), maxLat: Math.max(a.lat, b.lat),
  minLon: Math.min(a.lon, b.lon), maxLon: Math.max(a.lon, b.lon),
});

/** Brings the area into view on mount and whenever it arrives from elsewhere. */
function FitArea({ area, fitNonce }) {
  const map = useMap();
  const last = useRef(null);
  const current = useRef(area);
  current.current = area;
  useEffect(() => {
    // A box drawn on this chart is already in view: only mount and fitNonce move the map.
    if (last.current === fitNonce) return;
    last.current = fitNonce;
    if (current.current) map.fitBounds(toBounds(current.current), { padding: [32, 32], maxZoom: 9 });
  }, [map, fitNonce]);
  return null;
}

/**
 * Draw mode: press and drag across the chart (or click two opposite corners).
 * Panning is paused while drawing; Escape or the Cancel button leaves.
 */
function BoxDrawer({ drawing, onDrawn, onCancel, onPreview }) {
  const map = useMap();
  const handlers = useRef({ onDrawn, onCancel, onPreview });
  handlers.current = { onDrawn, onCancel, onPreview };
  useEffect(() => {
    if (!drawing) return undefined;
    const container = map.getContainer();
    const previousCursor = container.style.cursor;
    const previousTouch = container.style.touchAction;
    map.dragging.disable();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();
    container.style.cursor = 'crosshair';
    container.style.touchAction = 'none';
    let anchor = null; // { latlng, x, y, pointerId, clicked }
    const at = (event) => {
      const { lat, lng } = map.mouseEventToLatLng(event);
      return { lat, lon: lng };
    };
    const onControl = (event) => event.target instanceof Element && event.target.closest('.leaflet-control');
    const down = (event) => {
      if (onControl(event) || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault();
      if (anchor?.clicked) return; // the second corner of a two-click box lands on pointerup
      anchor = { point: at(event), x: event.clientX, y: event.clientY, clicked: false };
      container.setPointerCapture?.(event.pointerId);
    };
    const move = (event) => {
      if (!anchor) return;
      handlers.current.onPreview(rawBox(anchor.point, at(event)));
    };
    const up = (event) => {
      if (!anchor || onControl(event)) return;
      const moved = Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) > DRAG_THRESHOLD_PX;
      if (!moved && !anchor.clicked) {
        // a click: keep this corner and let the pointer (or a second tap) set the other
        anchor.clicked = true;
        return;
      }
      const area = gribArea(anchor.point, at(event));
      anchor = null;
      handlers.current.onPreview(null);
      if (area) handlers.current.onDrawn(area);
    };
    const key = (event) => {
      if (event.key === 'Escape') handlers.current.onCancel();
    };
    container.addEventListener('pointerdown', down);
    container.addEventListener('pointermove', move);
    container.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    return () => {
      container.removeEventListener('pointerdown', down);
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      container.style.cursor = previousCursor;
      container.style.touchAction = previousTouch;
      map.dragging.enable();
      map.boxZoom.enable();
      map.doubleClickZoom.enable();
      handlers.current.onPreview(null);
    };
  }, [map, drawing]);
  return null;
}

/** Corner handles: drag one to resize the box; the opposite corner stays put. */
function CornerHandles({ area, onChange, onPreview }) {
  const corners = [
    [{ lat: area.maxLat, lon: area.minLon }, { lat: area.minLat, lon: area.maxLon }],
    [{ lat: area.maxLat, lon: area.maxLon }, { lat: area.minLat, lon: area.minLon }],
    [{ lat: area.minLat, lon: area.maxLon }, { lat: area.maxLat, lon: area.minLon }],
    [{ lat: area.minLat, lon: area.minLon }, { lat: area.maxLat, lon: area.maxLon }],
  ];
  const moved = (event) => {
    const { lat, lng } = event.target.getLatLng();
    return { lat, lon: lng };
  };
  return corners.map(([corner, opposite], index) => (
    <Marker
      // re-keyed per area so a snapped box resets each handle onto its corner
      key={`${index}:${area.minLat},${area.maxLat},${area.minLon},${area.maxLon}`}
      position={[corner.lat, corner.lon]}
      icon={cornerIcon}
      draggable
      keyboard={false}
      eventHandlers={{
        drag: (event) => onPreview(rawBox(moved(event), opposite)),
        dragend: (event) => {
          onPreview(null);
          const next = gribArea(moved(event), opposite);
          if (next) onChange(next);
        },
      }}
    />
  ));
}

export default function GribMap({ area, fitNonce, drawing, onDrawn, onCancelDraw, onStartDraw, onAreaChange, disabled }) {
  const [preview, setPreview] = useState(null);
  const shown = preview ?? area;
  return (
    <div className="lg:col-span-2 relative border border-ink/30 rounded-sm overflow-hidden" style={{ height: 480 }}>
      <MapContainer
        center={[48.5, -3.5]}
        zoom={6}
        style={{ height: '100%', width: '100%', background: palette.shoal }}
      >
        <TileLayer {...BASEMAP} />
        <TileLayer
          url="https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"
          attribution='seamarks &copy; OpenSeaMap'
        />
        <FitArea area={area} fitNonce={fitNonce} />
        <BoxDrawer drawing={drawing} onDrawn={onDrawn} onCancel={onCancelDraw} onPreview={setPreview} />
        {shown && (
          <Rectangle
            bounds={toBounds(shown)}
            interactive={false}
            pathOptions={boxStyle}
          />
        )}
        {area && !drawing && !disabled && <CornerHandles area={area} onChange={onAreaChange} onPreview={setPreview} />}
      </MapContainer>
      <div className="absolute top-3 inset-x-3 z-[1000] flex justify-center pointer-events-none">
        {drawing ? (
          <p className="pointer-events-auto flex flex-wrap items-center gap-3 bg-ink text-paper font-sans text-sm rounded-sm px-3 py-2 shadow-panel">
            <span>Drag across the chart to draw your area.</span>
            <button type="button" onClick={onCancelDraw} className="underline">Cancel</button>
          </p>
        ) : (
          <button
            type="button"
            onClick={onStartDraw}
            disabled={disabled}
            className="pointer-events-auto bg-ink text-paper font-sans font-medium text-sm rounded-sm px-4 py-2 shadow-panel hover:bg-ink-deep disabled:opacity-40"
          >
            {area ? 'Redraw the box' : 'Draw a box'}
          </button>
        )}
      </div>
    </div>
  );
}
