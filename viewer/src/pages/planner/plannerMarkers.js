import L from 'leaflet';
import { palette } from '../../lib/palette.js';

/** Map markers for the route being planned. Each point is numbered; the first
 * is marked Start and the last Finish, in shape (circle, square), colour and
 * a visible word, so no marker is told apart by colour alone. The icon box is
 * 44 px so it is a touch target; the visible dot sits in its middle. */

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
    + `font:600 12px/1 sans-serif">${number}</span>`;
  const word = label
    ? `<span style="position:absolute;left:36px;top:12px;padding:1px 5px;border-radius:2px;white-space:nowrap;`
      + `background:${palette.paper.DEFAULT};border:1px solid ${fill};color:${palette.ink.DEFAULT};`
      + `font:600 12px/1.2 sans-serif">${label}</span>`
    : '';
  const icon = L.divIcon({
    className: '',
    html: `${dot}${word}`,
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
