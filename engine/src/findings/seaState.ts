import type { LegHour, LimitsProfile } from '../types.js';
import type { WavePointForecast } from '../forecast/types.js';
import { parseUtc } from '../eta.js';
import { evaluateAgainstLimit } from '../limits.js';
import { steepness, assessCrossSea, windAgainstSwell } from '../hazards/waves.js';

export function evaluateSeaState(
  inputHours: LegHour[], marine: WavePointForecast | null, profile: LimitsProfile, ratio: number,
) {
  const marineTimeIndex = new Map<number, number>();
  marine?.times.forEach((t, idx) => marineTimeIndex.set(parseUtc(t), idx));
  const hours: LegHour[] = [];
  let worstWave: { hour: LegHour; ratio: number } | null = null;
  let worstSteepness: { hour: LegHour; ratio: number } | null = null;
  let crossSeaHour: LegHour | null = null;
  let windAgainstSwellHour: LegHour | null = null;
  let anyExceeded = false;
  let anyApproaching = false;
  for (const input of inputHours) {
    const hour = { ...input, limit_status: { ...input.limit_status } };
    const { valid_time: validTime, wind_kt: wind, wind_dir_deg: windDir } = hour;
    // ---- sea state (deterministic wave model only) ----
    if (marine) {
      const mIdx = marineTimeIndex.get(parseUtc(validTime));
      if (mIdx !== undefined) {
        const hs = marine.hs_m[mIdx] ?? null;
        const period = marine.period_s[mIdx] ?? null;
        const st = hs !== null && period !== null ? steepness(hs, period) : null;
        const crossSea = assessCrossSea(
          marine.wind_wave_h_m[mIdx] ?? null,
          marine.wind_wave_dir_deg[mIdx] ?? null,
          marine.swell_h_m[mIdx] ?? null,
          marine.swell_dir_deg[mIdx] ?? null,
        );
        const was = windAgainstSwell(
          windDir,
          wind,
          marine.swell_dir_deg[mIdx] ?? null,
          marine.swell_h_m[mIdx] ?? null,
        );
        hour.waves = {
          hs_m: hs,
          period_s: period,
          steepness: st !== null ? Math.round(st * 10000) / 10000 : null,
          wind_wave_h_m: marine.wind_wave_h_m[mIdx] ?? null,
          swell_h_m: marine.swell_h_m[mIdx] ?? null,
          cross_sea_deg: crossSea?.angle_deg ?? null,
          cross_sea_significant: crossSea?.significant ?? false,
          wind_against_swell: was,
        };
        if (profile.max_wave_height_m !== undefined) {
          const status = evaluateAgainstLimit(hs, profile.max_wave_height_m, ratio);
          hour.limit_status.wave = status;
          if (status === 'exceeded') anyExceeded = true;
          if (status === 'approaching') anyApproaching = true;
          if (hs !== null && (status === 'exceeded' || status === 'approaching')) {
            const r = hs / profile.max_wave_height_m;
            if (!worstWave || r > worstWave.ratio) worstWave = { hour, ratio: r };
          }
        }
        if (profile.max_steepness !== undefined && st !== null) {
          const status = evaluateAgainstLimit(st, profile.max_steepness, ratio);
          hour.limit_status.steepness = status;
          if (status === 'exceeded') anyExceeded = true;
          if (status === 'approaching') anyApproaching = true;
          if (status === 'exceeded' || status === 'approaching') {
            const r = st / profile.max_steepness;
            if (!worstSteepness || r > worstSteepness.ratio) worstSteepness = { hour, ratio: r };
          }
        }
        if (profile.cross_sea_flag && crossSea?.significant && !crossSeaHour) crossSeaHour = hour;
        if (was && !windAgainstSwellHour) windAgainstSwellHour = hour;
      }
    }

    hours.push(hour);
  }
  return { hours, worstWave, worstSteepness, crossSeaHour, windAgainstSwellHour, anyExceeded, anyApproaching };
}
