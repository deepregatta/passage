import { runsBase } from './preparedRun.js';

/** Chart images live in two places: prepared runs (repo-relative `runs/...`
 * paths, served at /data/... in dev and from the forecast host's prepared/
 * prefix in production) and snapshot-local copies (`charts/...`, demo
 * fixtures). */
export function chartUrl(file, snapshotId) {
  if (!file) return null;
  return file.startsWith('runs/') ? `${runsBase()}${file}` : `/data/snapshots/${snapshotId}/${file}`;
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
