/**
 * GPX import — browser-safe (regex-based, no DOM/XML dependencies).
 * Accepts route points (<rtept>), track points (<trkpt>) or waypoints (<wpt>),
 * in that order of preference; densifies nothing (the engine derives legs).
 */

import type { Route, SpeedsKt, Waypoint } from './types.js';

const TAG_RE = /<(rtept|trkpt|wpt)\b([^>]*?)(\/?)>/g;
const LAT_RE = /\blat="([-\d.]+)"/;
const LON_RE = /\blon="([-\d.]+)"/;
const NAME_RE = /<name>([\s\S]*?)<\/name>/;

export function parseGpx(
  gpxText: string,
  options: { route_id: string; name?: string; speeds_kt: SpeedsKt; maxPoints?: number },
): Route {
  const found: Array<{ kind: string; wp: Waypoint }> = [];
  let match: RegExpExecArray | null;
  let counter = 0;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(gpxText)) !== null) {
    const kind = match[1]!;
    const attrs = match[2]!;
    const selfClosing = match[3] === '/' || attrs.trimEnd().endsWith('/');
    const lat = Number(LAT_RE.exec(attrs)?.[1]);
    const lon = Number(LON_RE.exec(attrs)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    counter += 1;
    let name: string | undefined;
    if (!selfClosing) {
      const close = gpxText.indexOf(`</${kind}>`, TAG_RE.lastIndex);
      if (close !== -1) {
        name = NAME_RE.exec(gpxText.slice(TAG_RE.lastIndex, close))?.[1]?.trim();
        TAG_RE.lastIndex = close; // never scan the same inner content twice
      }
    }
    found.push({ kind, wp: { id: `wp${counter}`, ...(name ? { name } : {}), lat, lon } });
  }

  // prefer explicit route points, then track, then bare waypoints
  const byKind = (k: string) => found.filter((f) => f.kind === k).map((f) => f.wp);
  let waypoints = byKind('rtept');
  if (waypoints.length < 2) waypoints = byKind('trkpt');
  if (waypoints.length < 2) waypoints = byKind('wpt');
  if (waypoints.length < 2) {
    throw new Error('GPX contains fewer than 2 usable points (rtept/trkpt/wpt)');
  }

  // tracks can carry thousands of points — thin evenly to a sane waypoint count
  const maxPoints = options.maxPoints ?? 24;
  if (waypoints.length > maxPoints) {
    const step = (waypoints.length - 1) / (maxPoints - 1);
    waypoints = Array.from({ length: maxPoints }, (_, i) => waypoints[Math.round(i * step)]!);
  }
  waypoints = waypoints.map((wp, i) => ({ ...wp, id: `wp${i + 1}` }));

  const gpxName = NAME_RE.exec(gpxText)?.[1]?.trim();
  return {
    schema_version: 1,
    route_id: options.route_id,
    name: options.name ?? gpxName ?? options.route_id,
    mode: 'user',
    waypoints,
    speeds_kt: options.speeds_kt,
  };
}
