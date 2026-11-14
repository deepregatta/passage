import type { LegHour, LimitsProfile } from '../types.js';
import type { AssembleOptions } from './options.js';
import { parseUtc } from '../eta.js';
import { squallPotential } from '../hazards/convective.js';
import { fogRisk, visibilityNm, evaluateMinVisibility } from '../hazards/visibility.js';
import { pointTimeIndex, type HourPoints } from './points.js';
import { hourDivergence } from '../disagreement.js';
import type { PointWind } from './wind.js';

/** Visibility source order: GFS tiles first (the ECMWF open-data layer carries no
 *  visibility). ScenarioBundleStore preserves icon_eu/gfs_global fixture keys;
 *  these fallbacks are required for scenario and golden visibility assessments. */
export const VIS_MODELS = ['gfs_0p25', 'icon_eu', 'gfs_global'];

/**
 * Convective screening, visibility, fog and model disagreement per hour, from
 * every sample point the hour reads (`hourPoints`), each the worst among them:
 * the highest CAPE, the lowest visibility, fog when any point screens for it
 * (with its own wind), and the models compared at every point (each against
 * its own sustained limit): the hour diverges, or is insufficient, when it does
 * at any point, and shows such a point (see below). Ties keep the first point
 * along the leg. Every model is read at the same sample points.
 */
export function evaluateHazards(
  inputHours: LegHour[], hourPoints: HourPoints,
  pointWinds: ReadonlyArray<ReadonlyMap<number, PointWind>>,
  multiModel: AssembleOptions['multiModel'], model: string | null,
  profile: LimitsProfile,
) {
  const models = multiModel
    ? Object.entries(multiModel.byModel).map(([m, forecasts]) => ({ model: m, forecasts, index: pointTimeIndex(forecasts) }))
    : [];
  const hours: LegHour[] = [];
  /** per hour: the point the CAPE, the visibility and the compared models came from */
  const drivers: Array<{ cape: number | null; visibility: number | null; divergence: number | null; divergenceNearLimit: boolean }> = [];
  let worstVisibility: { hour: LegHour; index: number } | null = null;
  let maxCape: { hour: LegHour; index: number; level: 'elevated' | 'high' } | null = null;
  const disagreementInput: Array<{
    valid_time: string;
    byModel: Record<string, number | null>;
    sustained_limit_kt: number;
  }> = [];
  let anyExceeded = false;
  let anyApproaching = false;
  for (const [i, input] of inputHours.entries()) {
    const hour = { ...input, limit_status: { ...input.limit_status } };
    const { valid_time: validTime } = hour;
    const tMs = parseUtc(validTime);
    const points = (hourPoints[i] ?? []).filter((p) => models.some((m) => m.forecasts[p]));
    const driver = { cape: null as number | null, visibility: null as number | null, divergence: null as number | null, divergenceNearLimit: false };
    // ---- convective screening + visibility/fog + model disagreement ----
    if (points.length > 0) {
      const primary = models.find((m) => m.model === model) ?? models[0]!;
      let capeRead = false;
      let cape: number | null = null;
      let fog = false;
      for (const p of points) {
        const fc = primary.forecasts[p];
        const pIdx = fc ? primary.index(p, tMs) : undefined;
        if (!fc || pIdx === undefined) continue;
        capeRead = true;
        const value = fc.cape_jkg[pIdx] ?? null;
        if (value !== null && (cape === null || value > cape)) { cape = value; driver.cape = p; }
        fog ||= fogRisk(fc.temp_c[pIdx] ?? null, fc.dew_point_c[pIdx] ?? null, pointWinds[i]?.get(p)?.wind ?? null);
      }
      if (capeRead) {
        hour.cape_jkg = cape;
        hour.squall_potential = squallPotential(cape);
        if (hour.squall_potential === 'high') {
          anyApproaching = true;
          if (!maxCape || (cape ?? 0) > (maxCape.hour.cape_jkg ?? 0)) {
            maxCape = { hour, index: i, level: 'high' };
          }
        } else if (hour.squall_potential === 'elevated' && !maxCape) {
          maxCape = { hour, index: i, level: 'elevated' };
        }
        hour.fog_risk = fog;
      }
      for (const p of points) {
        for (const vm of VIS_MODELS) {
          const src = models.find((m) => m.model === vm);
          const vIdx = src?.forecasts[p] ? src.index(p, tMs) : undefined;
          const visM = vIdx !== undefined ? (src!.forecasts[p]!.visibility_m[vIdx] ?? null) : null;
          if (visM !== null) {
            const nm = visibilityNm(visM);
            if (nm !== null && (hour.visibility_nm === undefined || hour.visibility_nm === null || nm < hour.visibility_nm)) {
              hour.visibility_nm = nm;
              driver.visibility = p;
            }
            break;
          }
        }
      }
      const visStatus = evaluateMinVisibility(
        hour.visibility_nm ?? null,
        profile.min_visibility_nm,
      );
      hour.limit_status.visibility = visStatus;
      if (visStatus === 'exceeded') {
        anyExceeded = true;
        if (!worstVisibility || (hour.visibility_nm ?? 99) < (worstVisibility.hour.visibility_nm ?? 99)) {
          worstVisibility = { hour, index: i };
        }
      }
      if (visStatus === 'approaching') anyApproaching = true;

      // The divergence rule is judged at every point the hour reads: the hour is divergent, and
      // insufficient, when it is so at any of them. The point shown is one that triggers near the
      // limit (the highest wind-to-limit ratio), else a divergent one (the widest spread), else the
      // widest spread.
      let compared: { byModel: Record<string, number | null>; spread: number; limit: number; rank: [number, number] } | null = null;
      for (const p of points) {
        const byModelWind: Record<string, number | null> = {};
        for (const m of models) {
          const idx2 = m.forecasts[p] ? m.index(p, tMs) : undefined;
          byModelWind[m.model] = idx2 !== undefined ? (m.forecasts[p]!.wind_kt[idx2] ?? null) : null;
        }
        const limit = pointWinds[i]?.get(p)?.limit ?? profile.max_sustained_kt.default;
        const at = hourDivergence(byModelWind, limit);
        const rank: [number, number] = at.nearLimit ? [2, at.max / limit] : at.divergent ? [1, at.spread] : [0, at.spread];
        if (!compared || rank[0] > compared.rank[0] || (rank[0] === compared.rank[0] && rank[1] > compared.rank[1])) {
          compared = { byModel: byModelWind, spread: at.spread, limit, rank };
          driver.divergence = p;
        }
      }
      driver.divergenceNearLimit = compared!.rank[0] === 2;
      hour.model_spread_kt = Number.isFinite(compared!.spread) ? Math.round(compared!.spread * 10) / 10 : null;
      disagreementInput.push({
        valid_time: validTime,
        byModel: compared!.byModel,
        sustained_limit_kt: compared!.limit,
      });
    }

    hours.push(hour);
    drivers.push(driver);
  }
  return { hours, drivers, worstVisibility, maxCape, disagreementInput, anyExceeded, anyApproaching };
}
