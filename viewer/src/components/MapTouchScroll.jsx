import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMap } from 'react-leaflet';
import {
  addMapControl,
  applyMapTouchMode,
  createControlElement,
  mapTouchMode,
  readTouchScroll,
  watchTouchScroll,
} from '../lib/mapTouchScroll.js';

/** True on phone-like input; follows pointer and viewport changes. */
export function useTouchScrollViewport() {
  const [touchScroll, setTouchScroll] = useState(() => readTouchScroll());
  useEffect(() => {
    const update = () => setTouchScroll(readTouchScroll());
    update();
    return watchTouchScroll(update);
  }, []);
  return touchScroll;
}

/**
 * Render inside a react-leaflet MapContainer. On a touch phone one finger
 * scrolls the page and two fingers move the map; a "Move the map" toggle
 * (bottom-left) lets one finger move it. `suspended` hands the pointer to
 * another interaction (GRIB box drawing) and hides the toggle. Desktop
 * behaviour is untouched.
 */
export default function MapTouchScroll({ suspended = false }) {
  const map = useMap();
  const touchScroll = useTouchScrollViewport();
  const [moveMap, setMoveMap] = useState(false);
  const mode = mapTouchMode({ touchScroll, moveMap, suspended });
  const hintId = useId();
  const [holder] = useState(createControlElement);

  useEffect(() => {
    applyMapTouchMode(map, mode);
  }, [map, mode]);

  useEffect(() => {
    if (!touchScroll || !holder) return undefined;
    return addMapControl(map, holder);
  }, [map, touchScroll, holder]);

  if (!touchScroll || suspended || !holder) return null;
  return createPortal(
    <div className="flex flex-col items-start gap-1 font-sans">
      <button
        type="button"
        aria-pressed={moveMap}
        aria-describedby={hintId}
        onClick={() => setMoveMap((on) => !on)}
        className={`min-h-11 min-w-11 flex items-center gap-2 border rounded-sm px-3 text-sm font-medium shadow-panel ${
          moveMap ? 'bg-ink text-paper border-ink' : 'bg-paper/95 text-ink border-ink/40'
        }`}
      >
        <svg aria-hidden width="14" height="14" viewBox="0 0 14 14">
          <path d="M7 1v12M1 7h12M7 1L5 3M7 1l2 2M7 13l-2-2M7 13l2-2M1 7l2-2M1 7l2 2M13 7l-2-2M13 7l-2 2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        Move the map
      </button>
      <p id={hintId} role="status" className="bg-paper/95 text-ink text-xs rounded-sm px-2 py-1 shadow-panel">
        {moveMap ? 'One finger moves the map. Tap again to scroll the page.' : 'Use two fingers to move the map'}
      </p>
    </div>,
    holder,
  );
}
