import L from 'leaflet';
import { palette } from '../../lib/palette.js';

/** Map markers for the route being planned. Each point is numbered; the first
 * is marked Start and the last Finish, in shape (circle, square), colour and
 * a visible word, so no marker is told apart by colour alone. The icon box is
 * 44 px so it is a touch target; the visible dot sits in its middle.
 *
 * Only the 44 px `hit` square takes pointer events (the icon itself and the
 * word do not), so that two close points can share the overlap between their
 * boxes by distance: see `hitPolygon`. */

export const MARKER_BOX = 44;

/**
 * @param {number} count how many points the route has
 * @returns {Array<{kind: 'start' | 'finish' | 'waypoint', number: number, label: string, ariaLabel: string}>}
 */
export function markerSpecs(count) {
  return Array.from({ length: count }, (_, i) => {
    const number = i + 1;
    if (i === 0) return { kind: 'start', number, label: 'Start', ariaLabel: 'Start' };
    if (i === count - 1) return { kind: 'finish', number, label: 'Finish', ariaLabel: 'Finish' };
    return { kind: 'waypoint', number, label: '', ariaLabel: `Waypoint ${number} of ${count}` };
  });
}

const cache = new Map();

/** A Leaflet icon for one marker spec. */
export function markerIcon({ kind, number, label }) {
  const key = `${kind}:${number}:${label}`;
  if (cache.has(key)) return cache.get(key);
  const fill = kind === 'start' ? palette.verdict.within : palette.ink.DEFAULT;
  const shape = kind === 'finish' ? '3px' : '50%';
  const dot = `<span style="position:absolute;left:11px;top:11px;width:22px;height:22px;border-radius:${shape};`
    + `background:${fill};color:${palette.paper.DEFAULT};border:2px solid ${palette.paper.DEFAULT};`
    + `box-shadow:0 0 0 1px ${fill};display:flex;align-items:center;justify-content:center;`
    + `font:600 12px/1 sans-serif;pointer-events:none">${number}</span>`;
  const word = label
    ? `<span style="position:absolute;left:36px;top:12px;padding:1px 5px;border-radius:2px;white-space:nowrap;`
      + `background:${palette.paper.DEFAULT};border:1px solid ${fill};color:${palette.ink.DEFAULT};`
      + `font:600 12px/1.2 sans-serif;pointer-events:none">${label}</span>`
    : '';
  const hit = `<span data-marker-hit style="position:absolute;left:0;top:0;width:${MARKER_BOX}px;height:${MARKER_BOX}px"></span>`;
  const icon = L.divIcon({
    className: 'passage-marker',
    html: `${hit}${dot}${word}`,
    iconSize: [MARKER_BOX, MARKER_BOX],
    iconAnchor: [MARKER_BOX / 2, MARKER_BOX / 2],
  });
  cache.set(key, icon);
  return icon;
}

/** Leaflet gives a marker role="button", a tab stop and the title; the name a
 * screen reader reads is set here. The marker is keyed by its label, so a
 * changed label builds a new element that gets it. */
export function labelMarker(spec) {
  return { add: (event) => event.target.getElement()?.setAttribute('aria-label', spec.ariaLabel) };
}

/** Where, inside its 44 px box, a marker takes the pointer when other markers'
 * boxes overlap it: the part of the box nearer to it than to any overlapping
 * neighbour, so whichever point the finger is nearest to is the one picked,
 * whatever the order they were drawn in. A marker with no overlapping
 * neighbour keeps its whole box. Two points on the same pixel cannot be told
 * apart by position: the later one keeps the box.
 * @param {number} index which marker
 * @param {Array<{x: number, y: number}>} centres every marker's centre in one pixel space
 * @returns {string | null} a CSS clip-path, or null for the whole box
 */
export function hitPolygon(index, centres) {
  const me = centres[index];
  let region = [[0, 0], [MARKER_BOX, 0], [MARKER_BOX, MARKER_BOX], [0, MARKER_BOX]];
  let clipped = false;
  centres.forEach((other, j) => {
    if (j === index) return;
    const dx = other.x - me.x;
    const dy = other.y - me.y;
    if (Math.abs(dx) >= MARKER_BOX || Math.abs(dy) >= MARKER_BOX) return;
    const d = Math.hypot(dx, dy);
    clipped = true;
    if (d < 0.5) {
      // Same spot: the earlier marker yields completely.
      if (j > index) region = [];
      return;
    }
    // Keep what is on my side of the bisector: (p - centre) . n <= d / 2.
    const nx = dx / d;
    const ny = dy / d;
    const half = MARKER_BOX / 2;
    const inside = ([x, y]) => (x - half) * nx + (y - half) * ny - d / 2;
    const next = [];
    region.forEach((a, k) => {
      const b = region[(k + 1) % region.length];
      const ia = inside(a);
      const ib = inside(b);
      if (ia <= 0) next.push(a);
      if ((ia < 0 && ib > 0) || (ia > 0 && ib < 0)) {
        const t = ia / (ia - ib);
        next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    });
    region = next;
  });
  if (!clipped) return null;
  if (region.length < 3) return 'polygon(0 0, 0 0, 0 0)';
  return `polygon(${region.map(([x, y]) => `${x.toFixed(2)}px ${y.toFixed(2)}px`).join(', ')})`;
}

/** Applies `hitPolygon` to the planner markers on a Leaflet map, now and
 * whenever the zoom or the set of layers changes. Returns the cleanup. */
export function separateMarkerTargets(map) {
  const apply = () => {
    const markers = [];
    map.eachLayer((layer) => { if (layer instanceof L.Marker && layer.getElement()) markers.push(layer); });
    markers.sort((a, b) => a.options.pointIndex - b.options.pointIndex);
    const centres = markers.map((marker) => map.latLngToLayerPoint(marker.getLatLng()));
    markers.forEach((marker, i) => {
      const hit = marker.getElement().firstElementChild;
      if (hit?.hasAttribute('data-marker-hit')) hit.style.clipPath = hitPolygon(i, centres) ?? '';
    });
  };
  apply();
  map.on('zoomend', apply);
  map.on('layeradd', apply);
  return () => { map.off('zoomend', apply); map.off('layeradd', apply); };
}
