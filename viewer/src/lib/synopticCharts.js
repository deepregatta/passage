import { runsBase } from './preparedRun.js';
import { validSnapshotId } from './routes.js';

// A chart path from a check: relative, under runs/ or charts/, a PNG, no `..`
// segment. Every committed fixture and prepared run uses this shape
// (charts/t000.png, runs/<run>/synoptic/charts/t024[.<digest>].png).
const CHART_PATH = /^(runs|charts)\/[A-Za-z0-9._/-]+\.png$/;

/** Chart images live in two places: prepared runs (repo-relative `runs/...`
 * paths, served at /data/... in dev and from the forecast host's prepared/
 * prefix in production) and snapshot-local copies (`charts/...`, demo
 * fixtures). The path comes from the check, so anything else (another
 * extension, an absolute or outside address, a `..` segment, a snapshot-local
 * chart of an id that is not a check id) gives no image rather than an error
 * (2026-11-15). */
export function chartUrl(file, snapshotId) {
  if (typeof file !== 'string' || !CHART_PATH.test(file) || file.split('/').includes('..')) return null;
  if (file.startsWith('runs/')) return `${runsBase()}${file}`;
  return validSnapshotId(snapshotId) ? `/data/snapshots/${snapshotId}/${file}` : null;
}

export function nearestCaption(captions, cursorHours) {
  if (!captions?.length) return null;
  return captions.reduce((best, item) =>
    Math.abs((item.step_h ?? 0) - cursorHours) < Math.abs((best.step_h ?? 0) - cursorHours)
      ? item
      : best,
  );
}

/** Project lat/lon onto the chart PNG via its published axes geometry.
 * Returns null when the caption carries no geometry (schematic fallback applies). */
export function chartProjector(meta) {
  if (!meta?.axes_px || !meta?.geo || !meta?.size_px) return null;
  const { axes_px: a, geo: g, size_px: s } = meta;
  return {
    w: s.w,
    h: s.h,
    xy: (point) => ({
      x: a.x0 + ((point.lon - g.lon_min) / (g.lon_max - g.lon_min)) * (a.x1 - a.x0),
      y: a.y0 + ((g.lat_max - point.lat) / (g.lat_max - g.lat_min)) * (a.y1 - a.y0),
    }),
  };
}
