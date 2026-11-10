import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Rectangle, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BASEMAP } from '../../lib/basemap.js';
import { gribArea } from '../../lib/gribExport.js';
import { palette } from '../../lib/palette.js';
import MapTouchScroll from '../../components/MapTouchScroll.jsx';
import { GRIB_CORNERS, nudgeGribCorner } from './gribBox.js';

// a press that moves less than this is a click: the first corner of a two-click box
const DRAG_THRESHOLD_PX = 6;

const boxStyle = { color: palette.event, weight: 2, dashArray: '6 4', fillColor: palette.event, fillOpacity: 0.06 };

// A 14 px square to see, inside a 44 px target to press, drag or focus.
const cornerIcon = L.divIcon({
  className: 'rounded-sm focus-visible:outline-2 focus-visible:outline-ink focus-visible:-outline-offset-8',
  html: `<div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:nwse-resize"><div style="width:14px;height:14px;background:${palette.paper.DEFAULT};border:2px solid ${palette.event}"></div></div>`,
  iconSize: [44, 44],
  iconAnchor: [22, 22],
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

/**
 * Corner handles: drag one to resize the box; the opposite corner stays put.
 * Each is also a focusable button: the arrow keys move it by 0.1°, Shift +
 * arrow by 1°, through the same snapping as a drawn box.
 */
function CornerHandles({ area, onChange, onPreview, hintId }) {
  const { minLat, maxLat, minLon, maxLon } = area;
  // the corner to focus again once the nudged box re-creates the handles
  const refocus = useRef(null);
  const current = useRef({ area, onChange });
  current.current = { area, onChange };
  // One position array per box: react-leaflet moves a marker whenever its
  // position prop is a new array, so a fresh one on each drag re-render would
  // snap the handle back to where the drag started.
  const corners = useMemo(() => {
    const box = { minLat, maxLat, minLon, maxLon };
    return GRIB_CORNERS.map((corner) => {
      const at = corner.at(box);
      return { ...corner, position: [at.lat, at.lon], fixed: corner.opposite(box) };
    });
  }, [minLat, maxLat, minLon, maxLon]);
  const moved = (event) => {
    const { lat, lng } = event.target.getLatLng();
    return { lat, lon: lng };
  };
  const added = (corner) => (event) => {
    const element = event.target.getElement();
    if (!element) return;
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', corner.label);
    element.setAttribute('aria-describedby', hintId);
    element.addEventListener('keydown', (key) => {
      const next = nudgeGribCorner(current.current.area, corner.id, key.key, key.shiftKey);
      if (!next) return;
      // the arrows move this corner, not the chart or the page
      key.preventDefault();
      key.stopPropagation();
      refocus.current = corner.id;
      current.current.onChange(next);
    });
    if (refocus.current === corner.id) {
      refocus.current = null;
      element.focus();
    }
  };
  return corners.map((corner) => (
    <Marker
      // re-keyed per area so a snapped box resets each handle onto its corner
      key={`${corner.id}:${minLat},${maxLat},${minLon},${maxLon}`}
      position={corner.position}
      icon={cornerIcon}
      draggable
      keyboard={false}
      eventHandlers={{
        add: added(corner),
        drag: (event) => onPreview(rawBox(moved(event), corner.fixed)),
        dragend: (event) => {
          onPreview(null);
          const next = gribArea(moved(event), corner.fixed);
          if (next) onChange(next);
        },
      }}
    />
  ));
}

export default function GribMap({ area, fitNonce, drawing, onDrawn, onCancelDraw, onStartDraw, onClear, onAreaChange, disabled }) {
  const [preview, setPreview] = useState(null);
  const hintId = useId();
  const shown = preview ?? area;
  const button = 'pointer-events-auto min-h-11 font-sans font-medium text-sm rounded-sm px-4 py-2 shadow-panel disabled:opacity-40';
  return (
    // On wide screens the chart stays in view beside the tool panel (below the 56 px header).
    <div className="isolate lg:col-span-2 lg:sticky lg:top-[4.5rem] lg:self-start relative border border-ink/30 rounded-sm overflow-hidden" style={{ height: 480 }}>
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
        {/* after BoxDrawer: once drawing ends it re-enables dragging, then this re-applies phone scrolling */}
        <MapTouchScroll suspended={drawing} />
        {shown && (
          <Rectangle
            bounds={toBounds(shown)}
            interactive={false}
            pathOptions={boxStyle}
          />
        )}
        {area && !drawing && !disabled && <CornerHandles area={area} onChange={onAreaChange} onPreview={setPreview} hintId={hintId} />}
      </MapContainer>
      <p id={hintId} className="sr-only">Arrow keys move the corner by 0.1°, Shift and an arrow key by 1°.</p>
      <div className="absolute top-3 inset-x-3 z-[1000] flex flex-wrap justify-center gap-2 pointer-events-none">
        {drawing ? (
          <p className="pointer-events-auto flex flex-wrap items-center gap-x-3 bg-ink text-paper font-sans text-sm rounded-sm px-3 py-1 shadow-panel">
            <span>Tap two corners or drag across the chart to draw your area.</span>
            <button type="button" onClick={onCancelDraw} className="min-h-11 underline">Cancel</button>
          </p>
        ) : area ? (
          <>
            <button type="button" onClick={onStartDraw} disabled={disabled} className={`${button} bg-ink text-paper hover:bg-ink-deep`}>
              Draw a new box
            </button>
            <button type="button" onClick={onClear} disabled={disabled} className={`${button} bg-paper text-ink border border-ink/50 hover:bg-white`}>
              Clear box
            </button>
          </>
        ) : (
          <button type="button" onClick={onStartDraw} disabled={disabled} className={`${button} bg-ink text-paper hover:bg-ink-deep`}>
            Draw a box
          </button>
        )}
      </div>
    </div>
  );
}
