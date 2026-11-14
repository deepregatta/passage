import { expectedTimingHour } from '@deepweather/engine';

/**
 * A leg's wind arrow on the route map: the wind at the leg's middle occupancy
 * hour where the boat is expected to be then, drawn at that place. On a leg the
 * check read at several points (passage-audit-4) that is the hour's `expected`
 * reading, drawn at its sample point; on a leg read at one point (and older
 * checks) it is the hour itself, drawn at the leg's midpoint. Null without a
 * wind value.
 */
export function legWindArrow(leg) {
  const row = leg.hours?.[Math.floor((leg.hours?.length ?? 0) / 2)];
  if (!row) return null;
  const mid = expectedTimingHour(row);
  if (mid.wind_dir_deg === null || mid.wind_kt === null) return null;
  const at = (row.expected && leg.sample_points?.find((p) => p.point_id === row.expected.sample_point_id)) || leg.sample_point;
  return { leg_id: leg.leg_id, lat: at.lat, lon: at.lon, dir: mid.wind_dir_deg, kt: mid.wind_kt, time: mid.valid_time };
}
