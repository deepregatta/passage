/** Land mask (published by the Python factory from global-land-mask GLOBE data). */

export interface LandMask {
  schema_version: number;
  kind: 'land_mask';
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
  /** 1 = land, 0 = sea; index i*nlon + j */
  land: number[];
}

export function isLand(mask: LandMask, lat: number, lon: number): boolean {
  const i = Math.round((lat - mask.lat0) / mask.dlat);
  const j = Math.round((lon - mask.lon0) / mask.dlon);
  if (i < 0 || i >= mask.nlat || j < 0 || j >= mask.nlon) return false; // outside mask: assume sea
  return mask.land[i * mask.nlon + j] === 1;
}

/**
 * How near, in cells, a leg may pass a cell and still touch it. Far below any real distance
 * (6 µm on a 0.05° cell) and far above the floating-point error of the cell coordinates, so
 * a cell boundary the leg runs along or through counts on both sides, whichever cell
 * Math.round would put the boundary in.
 */
const TOUCH_CELLS = 1e-9;
/**
 * A land cell the leg meets only within this many cells of one of its ends is left to isLand
 * at that end: a leg leaving a sea point that lies on a land cell's edge or corner does not
 * touch that land. (About 6 mm on a 0.05° cell.) Legs shorter than twice this, and ends on
 * a pinch corner, get no such exception.
 */
const END_CELLS = 1e-6;

/**
 * Whether the cell point (u, v) lies within 2·END_CELLS of a cell corner where two land cells
 * meet diagonally and the other two cells are sea: the only place where two legs meeting at
 * a node could pass between sea cells that share no edge.
 */
function onPinchCorner(mask: LandMask, u: number, v: number): boolean {
  const r = 2 * END_CELLS;
  const i = Math.floor(u - r);
  const j = Math.floor(v - r);
  if (i === Math.floor(u + r) || j === Math.floor(v + r)) return false; // not near a corner
  const { nlat, nlon, land } = mask;
  const at = (ci: number, cj: number) => ci >= 0 && ci < nlat && cj >= 0 && cj < nlon && land[ci * nlon + cj] === 1;
  const sw = at(i, j);
  const se = at(i, j + 1);
  const nw = at(i + 1, j);
  const ne = at(i + 1, j + 1);
  return sw === ne && se === nw && sw !== se;
}

/**
 * Whether the leg a→b touches a land cell. The leg is the straight line in latitude and
 * longitude (the geometry of interpolatePosition, which the timing, the audit's sample
 * points and the former 0.4 nm sampler use), with longitudes taken as given, not wrapped.
 * Every mask cell the leg passes through is visited, row by row (a supercover of the line),
 * so a leg that clips a land cell's corner for any distance is caught. Touching a land cell
 * along an edge or at a corner counts, except a contact within END_CELLS of one of the
 * leg's ends, which isLand judges at that end (not for legs under 2·END_CELLS, nor at an end
 * on a pinch corner). Cells outside the mask are sea, as in isLand; a non-finite coordinate,
 * a latitude beyond ±90 or a longitude beyond ±360 counts as land.
 */
export function segmentCrossesLand(
  mask: LandMask,
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): boolean {
  // Fail closed on NaN, infinities and impossible coordinates (NaN fails every comparison).
  if (!(Math.abs(a.lat) <= 90 && Math.abs(b.lat) <= 90 && Math.abs(a.lon) <= 360 && Math.abs(b.lon) <= 360)) return true;
  // The ends, and the ends as interpolatePosition(·, ·, 1) computes them in either direction.
  if (isLand(mask, a.lat, a.lon) || isLand(mask, b.lat, b.lon) ||
    isLand(mask, a.lat + (b.lat - a.lat), a.lon + (b.lon - a.lon)) ||
    isLand(mask, b.lat + (a.lat - b.lat), b.lon + (a.lon - b.lon))) return true;
  const { lat0, lon0, dlat, dlon, nlat, nlon, land } = mask;
  // Cell coordinates: cell (i, j) spans [i, i + 1) x [j, j + 1), the cell isLand's Math.round picks.
  const ua = (a.lat - lat0) / dlat + 0.5;
  const va = (a.lon - lon0) / dlon + 0.5;
  const ub = (b.lat - lat0) / dlat + 0.5;
  const vb = (b.lon - lon0) / dlon + 0.5;
  const du = ub - ua;
  const dv = vb - va;
  const length = Math.hypot(du, dv);
  if (!(length > 0)) return false; // a zero-length leg is its point, checked above
  const e = TOUCH_CELLS;
  const exempt = length > 2 * END_CELLS ? END_CELLS / length : 0;
  const endA = exempt && !onPinchCorner(mask, ua, va) ? exempt : 0;
  const endB = exempt && !onPinchCorner(mask, ub, vb) ? exempt : 0;
  const iLo = Math.max(0, Math.floor(Math.min(ua, ub) - e));
  const iHi = Math.min(nlat - 1, Math.floor(Math.max(ua, ub) + e));
  for (let i = iLo; i <= iHi; i++) {
    // The part of the leg, t in [r0, r1], within row i (widened by e).
    let r0 = 0;
    let r1 = 1;
    if (du !== 0) {
      const p = (i - e - ua) / du;
      const q = (i + 1 + e - ua) / du;
      r0 = Math.max(0, Math.min(p, q));
      r1 = Math.min(1, Math.max(p, q));
      if (r0 > r1) continue;
    }
    const v0 = va + dv * r0;
    const v1 = va + dv * r1;
    const jLo = Math.max(0, Math.floor(Math.min(v0, v1) - e));
    const jHi = Math.min(nlon - 1, Math.floor(Math.max(v0, v1) + e));
    for (let j = jLo; j <= jHi; j++) {
      if (land[i * nlon + j] !== 1) continue;
      if (endA === 0 && endB === 0) return true;
      // The part of the leg within this cell; ignored only when it lies at an exempt end.
      let c0 = r0;
      let c1 = r1;
      if (dv !== 0) {
        const p = (j - e - va) / dv;
        const q = (j + 1 + e - va) / dv;
        c0 = Math.max(c0, Math.min(p, q));
        c1 = Math.min(c1, Math.max(p, q));
      }
      if (c1 <= endA || c0 >= 1 - endB) continue;
      return true;
    }
  }
  return false;
}

/**
 * Whether sea cells of the mask can join the point `a` to the point `b`, edge to edge.
 * The router's land check (segmentCrossesLand) rejects any leg that touches a land cell,
 * corners included, so a leg stays inside sea cells that share edges, and a route can
 * exist only if both ends lie in one 4-connected sea component. This is that test, a
 * flood fill from `a`'s cell: run it only once a route has already failed.
 *
 * `outsideIsSea`: whether the router can use water beyond the window (its graph reaches
 * past the mask, where isLand counts every cell as sea). True adds a ring of sea cells
 * around the window, joined to each other, so that going round the window counts as a
 * way through. False keeps the fill inside the window.
 *
 * Returns false only when the two are provably apart: anything it cannot judge (a
 * non-finite point, an end on land, an end outside the window with nothing outside to
 * stand on) returns true, so a caller never says "closed" without being sure.
 */
export function seaJoinsPoints(
  mask: LandMask,
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  outsideIsSea: boolean,
): boolean {
  const { nlat, nlon, land } = mask;
  // Row/column 0 and the last one of the padded grid are the ring of cells outside the window.
  const rows = nlat + 2;
  const cols = nlon + 2;
  const cellOf = (p: { lat: number; lon: number }): number => {
    const i = Math.round((p.lat - mask.lat0) / mask.dlat);
    const j = Math.round((p.lon - mask.lon0) / mask.dlon);
    if (!Number.isFinite(i) || !Number.isFinite(j)) return -1;
    return (Math.max(-1, Math.min(nlat, i)) + 1) * cols + Math.max(-1, Math.min(nlon, j)) + 1;
  };
  const seaAt = (cell: number): boolean => {
    const i = Math.floor(cell / cols);
    const j = cell % cols;
    if (i === 0 || i === rows - 1 || j === 0 || j === cols - 1) return outsideIsSea;
    return land[(i - 1) * nlon + (j - 1)] !== 1;
  };
  const from = cellOf(a);
  const to = cellOf(b);
  if (from < 0 || to < 0 || !seaAt(from) || !seaAt(to)) return true;
  if (from === to) return true;
  const seen = new Uint8Array(rows * cols);
  const stack = [from];
  seen[from] = 1;
  while (stack.length) {
    const cell = stack.pop()!;
    if (cell === to) return true;
    const i = Math.floor(cell / cols);
    const j = cell % cols;
    const next = [
      i > 0 ? cell - cols : -1, i < rows - 1 ? cell + cols : -1,
      j > 0 ? cell - 1 : -1, j < cols - 1 ? cell + 1 : -1,
    ];
    for (const n of next) {
      if (n < 0 || seen[n] || !seaAt(n)) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return false;
}
