import type { LegHour, LimitsProfile } from '../types.js';
import type { PointForecast } from '../forecast/types.js';
import { parseUtc } from '../eta.js';
import { evaluateAgainstLimit, pointOfSail, sustainedLimitKt, trueWindAngle } from '../limits.js';

/** Evaluate wind limits over the full occupancy window; ties keep the first hour. */
export function evaluateWind(
  occupancyHours: string[], forecast: PointForecast, bearing: number,
  profile: LimitsProfile, ratio: number,
) {
  const timeIndex = new Map<number, number>();
  forecast.times.forEach((t, idx) => timeIndex.set(parseUtc(t), idx));
  const hours: LegHour[] = [];
  const sustainedLimits: number[] = [];
  let worstSustained: { hour: LegHour; limit: number; ratio: number } | null = null;
  let worstGust: { hour: LegHour; ratio: number } | null = null;
  let anyExceeded = false;
  let anyApproaching = false;
  const exceededWindows: string[] = [];
  for (const validTime of occupancyHours) {
    const idx = timeIndex.get(parseUtc(validTime));
    const wind = idx !== undefined ? (forecast.wind_kt[idx] ?? null) : null;
    const gust = idx !== undefined ? (forecast.gust_kt[idx] ?? null) : null;
    const windDir = idx !== undefined ? (forecast.wind_dir_deg[idx] ?? null) : null;

    const twa = windDir !== null ? round1(trueWindAngle(windDir, bearing)) : null;
    const pos = twa !== null ? pointOfSail(twa) : null;
    const sustainedLimit = pos !== null ? sustainedLimitKt(profile, pos) : profile.max_sustained_kt.default;

    const sustainedStatus = evaluateAgainstLimit(wind, sustainedLimit, ratio);
    const gustStatus = evaluateAgainstLimit(gust, profile.max_gust_kt, ratio);

    const hour: LegHour = {
      valid_time: validTime,
      wind_kt: wind,
      gust_kt: gust,
      wind_dir_deg: windDir,
      twa_deg: twa,
      point_of_sail: pos,
      limit_status: { sustained: sustainedStatus, gust: gustStatus },
    };

    hours.push(hour);
    sustainedLimits.push(sustainedLimit);
    if (sustainedStatus === 'exceeded' || sustainedStatus === 'approaching') {
      const r = (wind as number) / sustainedLimit;
      if (!worstSustained || r > worstSustained.ratio) {
        worstSustained = { hour, limit: sustainedLimit, ratio: r };
      }
    }
    if (gustStatus === 'exceeded' || gustStatus === 'approaching') {
      const r = (gust as number) / profile.max_gust_kt;
      if (!worstGust || r > worstGust.ratio) worstGust = { hour, ratio: r };
    }
    if (sustainedStatus === 'exceeded' || gustStatus === 'exceeded') {
      anyExceeded = true;
      exceededWindows.push(validTime);
    }
    if (sustainedStatus === 'approaching' || gustStatus === 'approaching') {
      anyApproaching = true;
    }
  }

  return { hours, sustainedLimits, worstSustained, worstGust, anyExceeded, anyApproaching, exceededWindows };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
