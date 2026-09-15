import type { LegHour } from '../types.js';
import { type GridSampler, currentSpeedKt, currentSetDeg, alongCourseKt, crossCourseKt } from '../grids.js';
import { parseUtc } from '../eta.js';
import { wrap180 } from '../geo.js';

export function evaluateCurrents(
  inputHours: LegHour[], gridSampler: GridSampler | null,
  midpointPos: { lat: number; lon: number }, bearing: number,
) {
  const hours: LegHour[] = [];
  let worstWac: { hour: LegHour; opposition: number } | null = null;
  for (const input of inputHours) {
    const hour = { ...input };
    const { valid_time: validTime, wind_kt: wind, wind_dir_deg: windDir } = hour;
    // ---- surface current at this hour (CMEMS region grid) ----
    if (gridSampler) {
      const sample = gridSampler.sample(midpointPos.lat, midpointPos.lon, parseUtc(validTime));
      if (sample) {
        const speed = currentSpeedKt(sample);
        const set = currentSetDeg(sample);
        // wind-against-current: water moving INTO the wind (set ≈ wind-from direction)
        // steepens the sea; the Alderney Race effect. Needs real current + real wind.
        const opposition =
          windDir !== null && wind !== null && speed >= 1 && wind >= 12
            ? 180 - Math.abs(wrap180(set - windDir))
            : null;
        const wac = opposition !== null && opposition > 135;
        hour.current = {
          u_kt: sample.u_kt,
          v_kt: sample.v_kt,
          speed_kt: speed,
          set_deg: Math.round(set),
          along_kt: alongCourseKt(sample, bearing),
          cross_kt: crossCourseKt(sample, bearing),
          wind_against_current: wac,
        };
        if (wac && (!worstWac || speed > (worstWac.hour.current?.speed_kt ?? 0))) {
          worstWac = { hour, opposition: opposition! };
        }
      } else {
        hour.current = null;
      }
    }

    hours.push(hour);
  }
  return { hours, worstWac };
}
