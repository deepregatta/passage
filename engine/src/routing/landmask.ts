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

/**
 * A land mask read through a cell accessor rather than an array: the router's window over the
 * fine routing index (fineLandMask.ts), whose cells are far too many to hold one number each.
 * Cell (i, j) is centred on (lat0 + i·dlat, lon0 + j·dlon), as in LandMask; every function here
 * treats both kinds alike.
 */
export interface LandCellMask {
  kind: 'land_cells';
  lat0: number;
  lon0: number;
  dlat: number;
  dlon: number;
  nlat: number;
  nlon: number;
  /** Whether cell (i, j), 0 <= i < nlat and 0 <= j < nlon, is land. */
  landAt(i: number, j: number): boolean;
  /** The fine routing index the cells come from, where they do (null: none). */
  fine_index_id: string | null;
  /** Whether cell (i, j) comes from the fine routing index (absent: none does). */
  fineAt?(i: number, j: number): boolean;
  /**
   * A summary for the land check's quick rejection: whether any cell of block (bi, bj), the cells
   * [bi·size, (bi+1)·size) x [bj·size, (bj+1)·size) inside the grid, is land.
   */
  blocks?: { size: number; anyLandAt(bi: number, bj: number): boolean };
}

/** Any land mask the router and its helpers read. */
export type RoutingLandMask = LandMask | LandCellMask;

/** Whether in-grid cell (i, j) is land, for either kind of mask. */
export function landAtOf(mask: RoutingLandMask): (i: number, j: number) => boolean {
  if (mask.kind === 'land_cells') return mask.landAt;
  const { land, nlon } = mask;
  return (i, j) => land[i * nlon + j] === 1;
}

export function isLand(mask: RoutingLandMask, lat: number, lon: number): boolean {
  const i = Math.round((lat - mask.lat0) / mask.dlat);
  const j = Math.round((lon - mask.lon0) / mask.dlon);
  if (i < 0 || i >= mask.nlat || j < 0 || j >= mask.nlon) return false; // outside mask: assume sea
  return mask.kind === 'land_cells' ? mask.landAt(i, j) : mask.land[i * mask.nlon + j] === 1;
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
function onPinchCorner(mask: RoutingLandMask, landAt: (i: number, j: number) => boolean, u: number, v: number): boolean {
  const r = 2 * END_CELLS;
  const i = Math.floor(u - r);
  const j = Math.floor(v - r);
  if (i === Math.floor(u + r) || j === Math.floor(v + r)) return false; // not near a corner
  const { nlat, nlon } = mask;
  const at = (ci: number, cj: number) => ci >= 0 && ci < nlat && cj >= 0 && cj < nlon && landAt(ci, cj);
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
  mask: RoutingLandMask,
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): boolean {
  // Fail closed on NaN, infinities and impossible coordinates (NaN fails every comparison).
  if (!(Math.abs(a.lat) <= 90 && Math.abs(b.lat) <= 90 && Math.abs(a.lon) <= 360 && Math.abs(b.lon) <= 360)) return true;
  // The ends, and the ends as interpolatePosition(·, ·, 1) computes them in either direction.
  if (isLand(mask, a.lat, a.lon) || isLand(mask, b.lat, b.lon) ||
    isLand(mask, a.lat + (b.lat - a.lat), a.lon + (b.lon - a.lon)) ||
    isLand(mask, b.lat + (a.lat - b.lat), b.lon + (a.lon - b.lon))) return true;
  const { lat0, lon0, dlat, dlon, nlat, nlon } = mask;
  const landAt = landAtOf(mask);
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
  // Quick rejection: a leg touching no block that holds land touches no land cell.
  const blocks = mask.kind === 'land_cells' ? mask.blocks : undefined;
  if (blocks && !touchesAnyCell(ua / blocks.size, va / blocks.size, ub / blocks.size, vb / blocks.size,
    Math.ceil(nlat / blocks.size), Math.ceil(nlon / blocks.size), blocks.anyLandAt, e)) return false;
  const exempt = length > 2 * END_CELLS ? END_CELLS / length : 0;
  const endA = exempt && !onPinchCorner(mask, landAt, ua, va) ? exempt : 0;
  const endB = exempt && !onPinchCorner(mask, landAt, ub, vb) ? exempt : 0;
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
      if (!landAt(i, j)) continue;
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
 * Whether the straight line (ua, va)→(ub, vb), in cell coordinates (cell (i, j) spans
 * [i, i + 1) x [j, j + 1)), widened by `e`, touches a cell of the rows x cols grid for which
 * `set` holds: the same row-by-row supercover as segmentCrossesLand, with no end exception.
 */
function touchesAnyCell(
  ua: number, va: number, ub: number, vb: number, rows: number, cols: number,
  set: (i: number, j: number) => boolean, e: number,
): boolean {
  const du = ub - ua;
  const dv = vb - va;
  const iLo = Math.max(0, Math.floor(Math.min(ua, ub) - e));
  const iHi = Math.min(rows - 1, Math.floor(Math.max(ua, ub) + e));
  for (let i = iLo; i <= iHi; i++) {
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
    const jHi = Math.min(cols - 1, Math.floor(Math.max(v0, v1) + e));
    for (let j = jLo; j <= jHi; j++) if (set(i, j)) return true;
  }
  return false;
}

/**
 * Above this many cells (the padded window), seaJoinsPoints does not flood the whole window
 * cell by cell (about 5 bytes a cell): a fine-index window over a long passage holds tens of
 * millions of cells. Every 0.05° outline window is far below it.
 */
export const SEA_FILL_MAX_CELLS = 4_000_000;
/** In a larger window, how many cells each end's own bounded fill may visit. */
const SEA_FILL_END_BUDGET = 1_000_000;

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
 * A window of more than SEA_FILL_MAX_CELLS cells is judged in two ways, each of which can
 * only prove the ends apart: a fill from each end that may visit SEA_FILL_END_BUDGET cells
 * (an end in a closed pocket, a harbour or a gulf, fills it all without meeting the other
 * end), then a fill over square blocks of cells, a block counting as sea when any cell in it
 * is (any edge-to-edge sea path runs through such blocks, each the same as or edge to edge
 * with the one before, so blocks that do not join prove the ends apart). When neither proves
 * it, the answer is true.
 *
 * Returns false only when the two are provably apart: anything it cannot judge (a
 * non-finite point, an end on land, an end outside the window with nothing outside to
 * stand on, a large window neither way above can settle) returns true, so a caller never
 * says "closed" without being sure.
 */
export function seaJoinsPoints(
  mask: RoutingLandMask,
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  outsideIsSea: boolean,
): boolean {
  const { nlat, nlon } = mask;
  const landAt = landAtOf(mask);
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
    return !landAt(i - 1, j - 1);
  };
  const from = cellOf(a);
  const to = cellOf(b);
  if (from < 0 || to < 0 || !seaAt(from) || !seaAt(to)) return true;
  if (from === to) return true;
  // The same question on the same mask has the same answer: a departure scan asks it of every
  // departure that fails, and on the fine routing index each answer can take a tenth of a second.
  let answers = seaJoinsAnswers.get(mask);
  if (!answers) seaJoinsAnswers.set(mask, (answers = new Map()));
  const key = `${from} ${to} ${outsideIsSea}`;
  let answer = answers.get(key);
  if (answer === undefined) answers.set(key, (answer = seaJoinsCells(from, to, rows, cols, seaAt)));
  return answer;
}

/** seaJoinsPoints' answers by mask, then by end cells and outsideIsSea. */
const seaJoinsAnswers = new WeakMap<RoutingLandMask, Map<string, boolean>>();

/** seaJoinsPoints between two sea cells of the padded grid. */
function seaJoinsCells(from: number, to: number, rows: number, cols: number, seaAt: (cell: number) => boolean): boolean {
  const total = rows * cols;
  if (total <= SEA_FILL_MAX_CELLS) return fill(from, to, rows, cols, seaAt, total) !== 'apart';
  // A pocket around either end, filled to its last cell without meeting the other end.
  if (fill(from, to, rows, cols, seaAt, SEA_FILL_END_BUDGET) === 'apart') return false;
  if (fill(to, from, rows, cols, seaAt, SEA_FILL_END_BUDGET) === 'apart') return false;
  // Blocks of size × size cells.
  const size = Math.ceil(Math.sqrt(total / SEA_FILL_MAX_CELLS));
  const brows = Math.ceil(rows / size);
  const bcols = Math.ceil(cols / size);
  const seaBlock = new Uint8Array(brows * bcols);
  for (let i = 0; i < rows; i++) {
    const rowBase = Math.floor(i / size) * bcols;
    for (let j = 0; j < cols; j++) {
      const block = rowBase + Math.floor(j / size);
      if (!seaBlock[block] && seaAt(i * cols + j)) seaBlock[block] = 1;
    }
  }
  const blockOf = (cell: number) => Math.floor(Math.floor(cell / cols) / size) * bcols + Math.floor((cell % cols) / size);
  return fill(blockOf(from), blockOf(to), brows, bcols, (block) => seaBlock[block] === 1, brows * bcols) !== 'apart';
}

/**
 * Flood a rows × cols grid of sea cells edge to edge from `start`: 'joined' when it reaches
 * `goal`, 'apart' when it has filled start's whole component without reaching it, and
 * 'unknown' when it stopped after visiting `budget` cells.
 */
function fill(
  start: number, goal: number, rows: number, cols: number, seaAt: (cell: number) => boolean, budget: number,
): 'joined' | 'apart' | 'unknown' {
  const total = rows * cols;
  const seen = new Uint8Array(Math.ceil(total / 8));
  const stack = new Int32Array(Math.min(total, budget));
  const mark = (cell: number) => { seen[cell >> 3]! |= 1 << (cell & 7); };
  const unseen = (cell: number) => (seen[cell >> 3]! & (1 << (cell & 7))) === 0;
  let top = 0;
  let visited = 1;
  stack[top++] = start;
  mark(start);
  while (top > 0) {
    const cell = stack[--top]!;
    if (cell === goal) return 'joined';
    const i = Math.floor(cell / cols);
    const j = cell % cols;
    const next = [i > 0 ? cell - cols : -1, i < rows - 1 ? cell + cols : -1, j > 0 ? cell - 1 : -1, j < cols - 1 ? cell + 1 : -1];
    for (const n of next) {
      if (n < 0 || !unseen(n) || !seaAt(n)) continue;
      if (visited >= budget) return 'unknown';
      mark(n);
      visited += 1;
      stack[top++] = n;
    }
  }
  return 'apart';
}
