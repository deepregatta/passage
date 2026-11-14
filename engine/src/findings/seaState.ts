import type { LegHour, LimitsProfile } from '../types.js';
import type { WavePointForecast } from '../forecast/types.js';
import { parseUtc } from '../eta.js';
import { evaluateAgainstLimit } from '../limits.js';
import { steepness, assessCrossSea, windAgainstSwell } from '../hazards/waves.js';
import { pointTimeIndex, type HourPoints } from './points.js';
import type { PointWind } from './wind.js';

/**
 * Sea state per hour from every sample point the hour reads (`hourPoints`),
 * each value the worst among them: the wave record (height, period, wind sea
 * and swell heights) of the point with the highest significant height, the
 * steepest sea of any point (each from its own height and period), a cross sea
 * when any point has a significant one (the widest), wind against swell when
 * any point has it (with that point's own wind). Ties keep the first point.
 */
export function evaluateSeaState(
  inputHours: LegHour[], hourPoints: HourPoints, marine: readonly WavePointForecast[] | null,
  pointWinds: ReadonlyArray<ReadonlyMap<number, PointWind>>, profile: LimitsProfile, ratio: number,
) {
  const timeIndex = pointTimeIndex(marine ?? []);
  const hours: LegHour[] = [];
  /** per hour: the point the wave height and the steepness came from */
  const drivers: Array<{ wave: number | null; steepness: number | null; crossSea: number | null; windAgainstSwell: number | null }> = [];
  let worstWave: { hour: LegHour; index: number; ratio: number } | null = null;
  let worstSteepness: { hour: LegHour; index: number; ratio: number } | null = null;
  let crossSeaHour: { hour: LegHour; index: number } | null = null;
  let windAgainstSwellHour: { hour: LegHour; index: number } | null = null;
  let anyExceeded = false;
  let anyApproaching = false;
  for (const [i, input] of inputHours.entries()) {
    const hour = { ...input, limit_status: { ...input.limit_status } };
    const driver = { wave: null as number | null, steepness: null as number | null, crossSea: null as number | null, windAgainstSwell: null as number | null };
    // ---- sea state (deterministic wave model only) ----
    if (marine) {
      const tMs = parseUtc(hour.valid_time);
      let base: number | null = null;
      let firstRead: number | null = null;
      let steepest: number | null = null;
      let steepestPoint: number | null = null;
      let crossSea: { angle_deg: number; significant: boolean } | null = null;
      let crossPoint: number | null = null;
      let was = false;
      let wasPoint: number | null = null;
      for (const p of hourPoints[i] ?? []) {
        const m = marine[p];
        const mIdx = m ? timeIndex(p, tMs) : undefined;
        if (!m || mIdx === undefined) continue;
        firstRead ??= p;
        const hs = m.hs_m[mIdx] ?? null;
        const period = m.period_s[mIdx] ?? null;
        if (hs !== null && (base === null || hs > (marine[base]!.hs_m[timeIndex(base, tMs)!] as number))) base = p;
        const st = hs !== null && period !== null ? steepness(hs, period) : null;
        if (st !== null && (steepest === null || st > steepest)) { steepest = st; steepestPoint = p; }
        const cs = assessCrossSea(
          m.wind_wave_h_m[mIdx] ?? null, m.wind_wave_dir_deg[mIdx] ?? null,
          m.swell_h_m[mIdx] ?? null, m.swell_dir_deg[mIdx] ?? null,
        );
        if (cs?.significant && (!crossSea || cs.angle_deg > crossSea.angle_deg)) { crossSea = cs; crossPoint = p; }
        const own = pointWinds[i]?.get(p);
        if (!was && windAgainstSwell(own?.dir ?? null, own?.wind ?? null, m.swell_dir_deg[mIdx] ?? null, m.swell_h_m[mIdx] ?? null)) {
          was = true;
          wasPoint = p;
        }
      }
      const recordPoint = base ?? firstRead;
      if (recordPoint !== null) {
        const m = marine[recordPoint]!;
        const mIdx = timeIndex(recordPoint, tMs)!;
        const baseCross = assessCrossSea(
          m.wind_wave_h_m[mIdx] ?? null, m.wind_wave_dir_deg[mIdx] ?? null,
          m.swell_h_m[mIdx] ?? null, m.swell_dir_deg[mIdx] ?? null,
        );
        const cross = crossSea ?? baseCross;
        const hs = m.hs_m[mIdx] ?? null;
        hour.waves = {
          hs_m: hs,
          period_s: m.period_s[mIdx] ?? null,
          steepness: steepest !== null ? Math.round(steepest * 10000) / 10000 : null,
          wind_wave_h_m: m.wind_wave_h_m[mIdx] ?? null,
          swell_h_m: m.swell_h_m[mIdx] ?? null,
          cross_sea_deg: cross?.angle_deg ?? null,
          cross_sea_significant: cross?.significant ?? false,
          wind_against_swell: was,
        };
        driver.wave = base;
        driver.steepness = steepestPoint;
        driver.crossSea = crossSea ? crossPoint : null;
        driver.windAgainstSwell = wasPoint;
        if (profile.max_wave_height_m !== undefined) {
          const status = evaluateAgainstLimit(hs, profile.max_wave_height_m, ratio);
          hour.limit_status.wave = status;
          if (status === 'exceeded') anyExceeded = true;
          if (status === 'approaching') anyApproaching = true;
          if (hs !== null && (status === 'exceeded' || status === 'approaching')) {
            const r = hs / profile.max_wave_height_m;
            if (!worstWave || r > worstWave.ratio) worstWave = { hour, index: i, ratio: r };
          }
        }
        if (profile.max_steepness !== undefined && steepest !== null) {
          const status = evaluateAgainstLimit(steepest, profile.max_steepness, ratio);
          hour.limit_status.steepness = status;
          if (status === 'exceeded') anyExceeded = true;
          if (status === 'approaching') anyApproaching = true;
          if (status === 'exceeded' || status === 'approaching') {
            const r = steepest / profile.max_steepness;
            if (!worstSteepness || r > worstSteepness.ratio) worstSteepness = { hour, index: i, ratio: r };
          }
        }
        if (profile.cross_sea_flag && cross?.significant && !crossSeaHour) crossSeaHour = { hour, index: i };
        if (was && !windAgainstSwellHour) windAgainstSwellHour = { hour, index: i };
      }
    }

    hours.push(hour);
    drivers.push(driver);
  }
  return { hours, drivers, worstWave, worstSteepness, crossSeaHour, windAgainstSwellHour, anyExceeded, anyApproaching };
}
