import type { LegHour, LimitsProfile } from '../types.js';
import type { PointForecast } from '../forecast/types.js';
import { parseUtc } from '../eta.js';
import { evaluateAgainstLimit, pointOfSail, sustainedLimitKt, trueWindAngle } from '../limits.js';
import { pointTimeIndex, type HourPoints } from './points.js';

/** One sample point's wind at one hour, judged on the leg's course. */
export interface PointWind {
  wind: number | null;
  gust: number | null;
  dir: number | null;
  /** the sustained limit for the point of sail this point's wind gives on the leg's bearing */
  limit: number;
}

/**
 * Evaluate wind limits over the leg's hours; ties keep the first hour.
 * Each hour reads every sample point the boat can be at in it (`hourPoints`):
 * the hour's sustained wind, with its direction, point of sail and limit, is
 * the point's whose wind is highest against its own limit (the point of sail
 * uses the leg's bearing and that point's wind direction); the hour's gust is
 * the highest gust among them. Ties keep the first point along the leg. An
 * hour no point has a value for stays missing.
 */
export function evaluateWind(
  hoursUtc: string[], hourPoints: HourPoints, forecasts: readonly PointForecast[], bearing: number,
  profile: LimitsProfile, ratio: number,
) {
  const timeIndex = pointTimeIndex(forecasts);
  const hours: LegHour[] = [];
  const sustainedLimits: number[] = [];
  /** per hour: each read point's own wind and sustained limit */
  const pointWinds: Array<Map<number, PointWind>> = [];
  /** per hour: the point the sustained wind and the gust came from (null when none had a value) */
  const drivers: Array<{ sustained: number | null; gust: number | null }> = [];
  let worstSustained: { hour: LegHour; index: number; limit: number; ratio: number } | null = null;
  let worstGust: { hour: LegHour; index: number; ratio: number } | null = null;
  let anyExceeded = false;
  let anyApproaching = false;
  const exceededWindows: string[] = [];
  for (const [i, validTime] of hoursUtc.entries()) {
    const tMs = parseUtc(validTime);
    const byPoint = new Map<number, PointWind>();
    let sustainedPick: number | null = null;
    let sustainedRatio = -Infinity;
    let gustPick: number | null = null;
    for (const p of hourPoints[i] ?? []) {
      const forecast = forecasts[p];
      const idx = forecast ? timeIndex(p, tMs) : undefined;
      const wind = idx !== undefined ? (forecast!.wind_kt[idx] ?? null) : null;
      const gust = idx !== undefined ? (forecast!.gust_kt[idx] ?? null) : null;
      const dir = idx !== undefined ? (forecast!.wind_dir_deg[idx] ?? null) : null;
      const twa = dir !== null ? round1(trueWindAngle(dir, bearing)) : null;
      const limit = twa !== null ? sustainedLimitKt(profile, pointOfSail(twa)) : profile.max_sustained_kt.default;
      byPoint.set(p, { wind, gust, dir, limit });
      if (wind !== null && wind / limit > sustainedRatio) {
        sustainedRatio = wind / limit;
        sustainedPick = p;
      }
      if (gust !== null && (gustPick === null || gust > byPoint.get(gustPick)!.gust!)) gustPick = p;
    }
    pointWinds.push(byPoint);
    drivers.push({ sustained: sustainedPick, gust: gustPick });

    const picked = sustainedPick !== null ? byPoint.get(sustainedPick)! : null;
    const wind = picked?.wind ?? null;
    const windDir = picked?.dir ?? null;
    const gust = gustPick !== null ? byPoint.get(gustPick)!.gust : null;
    const twa = windDir !== null ? round1(trueWindAngle(windDir, bearing)) : null;
    const pos = twa !== null ? pointOfSail(twa) : null;
    const sustainedLimit = picked?.limit ?? profile.max_sustained_kt.default;

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
        worstSustained = { hour, index: i, limit: sustainedLimit, ratio: r };
      }
    }
    if (gustStatus === 'exceeded' || gustStatus === 'approaching') {
      const r = (gust as number) / profile.max_gust_kt;
      if (!worstGust || r > worstGust.ratio) worstGust = { hour, index: i, ratio: r };
    }
    if (sustainedStatus === 'exceeded' || gustStatus === 'exceeded') {
      anyExceeded = true;
      exceededWindows.push(validTime);
    }
    if (sustainedStatus === 'approaching' || gustStatus === 'approaching') {
      anyApproaching = true;
    }
  }

  return {
    hours, sustainedLimits, pointWinds, drivers,
    worstSustained, worstGust, anyExceeded, anyApproaching, exceededWindows,
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
