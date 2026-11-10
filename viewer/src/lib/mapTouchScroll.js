import L from 'leaflet';

/**
 * Phone-friendly Leaflet maps: on a touch phone a one-finger swipe that starts
 * on a map scrolls the page; two fingers pinch and pan the map (Leaflet's
 * TouchZoom handler pans while it pinches), and the "Move the map" toggle
 * hands one finger back to the map.
 *
 * Leaflet 1.9.4 mechanics (leaflet.css): the container carries
 * `leaflet-touch-drag` while map.dragging is enabled and `leaflet-touch-zoom`
 * while touchZoom is enabled; both together give `touch-action: none`, zoom
 * alone gives `touch-action: pan-x pan-y`. So disabling map.dragging is enough
 * for the browser to scroll the page on one finger while Leaflet keeps
 * two-finger pinch/pan. Desktop (fine primary pointer) is never touched.
 */

export const TOUCH_SCROLL_QUERIES = Object.freeze({
  coarse: '(pointer: coarse)',
  anyCoarse: '(any-pointer: coarse)',
  narrow: '(max-width: 767px)',
});

/** Container class marking a map whose dragging this helper manages. */
export const TOUCH_SCROLL_CLASS = 'map-touch-scroll';

/**
 * Phone-like input: a coarse primary pointer, or a narrow viewport on a
 * device that has a touch pointer. A narrow desktop window with only a mouse
 * keeps Leaflet's default behaviour.
 */
export function prefersTouchScroll({ coarse = false, anyCoarse = false, narrow = false } = {}) {
  return Boolean(coarse || (narrow && anyCoarse));
}

const browserMatchMedia = () => (typeof matchMedia === 'function' ? matchMedia : null);

export function readTouchScroll(matchMediaFn = browserMatchMedia()) {
  if (typeof matchMediaFn !== 'function') return false;
  const match = (query) => Boolean(matchMediaFn(query)?.matches);
  return prefersTouchScroll({
    coarse: match(TOUCH_SCROLL_QUERIES.coarse),
    anyCoarse: match(TOUCH_SCROLL_QUERIES.anyCoarse),
    narrow: match(TOUCH_SCROLL_QUERIES.narrow),
  });
}

/** Calls onChange whenever pointer or viewport changes; returns the unsubscribe. */
export function watchTouchScroll(onChange, matchMediaFn = browserMatchMedia()) {
  if (typeof matchMediaFn !== 'function') return () => {};
  const lists = Object.values(TOUCH_SCROLL_QUERIES).map((query) => matchMediaFn(query));
  lists.forEach((list) => list?.addEventListener?.('change', onChange));
  return () => lists.forEach((list) => list?.removeEventListener?.('change', onChange));
}

/** A bottom-left Leaflet control holding `element`; its taps never reach the map. */
export function addMapControl(map, element) {
  const control = L.control({ position: 'bottomleft' });
  control.onAdd = () => {
    // a tap on the toggle must not place a waypoint or start a box
    L.DomEvent.disableClickPropagation(element);
    L.DomEvent.disableScrollPropagation(element);
    return element;
  };
  control.addTo(map);
  return () => control.remove();
}

export function createControlElement() {
  return typeof document === 'undefined' ? null : document.createElement('div');
}

/**
 * Who owns a one-finger drag on the map:
 * - 'default'   desktop: Leaflet as configured (one finger / mouse pans)
 * - 'suspended' another interaction (GRIB box drawing) owns the pointer
 * - 'move'      phone, "Move the map" on: one finger pans the map
 * - 'scroll'    phone: one finger scrolls the page, two fingers move the map
 */
export function mapTouchMode({ touchScroll = false, moveMap = false, suspended = false } = {}) {
  if (!touchScroll) return 'default';
  if (suspended) return 'suspended';
  return moveMap ? 'move' : 'scroll';
}

export function oneFingerMovesMap(mode) {
  return mode !== 'scroll';
}

/** Applies a mode to a Leaflet map; undoes only what it did itself. */
export function applyMapTouchMode(map, mode) {
  const container = map?.getContainer?.();
  if (!container || !map.dragging || mode === 'suspended') return;
  if (mode === 'scroll' || mode === 'move') {
    container.classList.add(TOUCH_SCROLL_CLASS);
    if (mode === 'scroll') map.dragging.disable();
    else map.dragging.enable();
    return;
  }
  if (container.classList.contains(TOUCH_SCROLL_CLASS)) {
    container.classList.remove(TOUCH_SCROLL_CLASS);
    map.dragging.enable();
  }
}
