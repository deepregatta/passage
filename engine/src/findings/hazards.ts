import type { LegHour, LimitsProfile } from '../types.js';
import type { HazardPointForecast } from '../forecast/types.js';
import type { AssembleOptions } from './options.js';
import { parseUtc } from '../eta.js';
import { squallPotential } from '../hazards/convective.js';
import { fogRisk, visibilityNm, evaluateMinVisibility } from '../hazards/visibility.js';

/** Visibility source order: GFS tiles first (the ECMWF open-data layer carries no
 *  visibility). ScenarioBundleStore preserves icon_eu/gfs_global fixture keys;
 *  these fallbacks are required for scenario and golden visibility assessments. */
export const VIS_MODELS = ['gfs_0p25', 'icon_eu', 'gfs_global'];

export function evaluateHazards(
  inputHours: LegHour[], sustainedLimits: number[],
  multiModel: AssembleOptions['multiModel'], legIndex: number, model: string | null,
  profile: LimitsProfile,
) {
  const modelIndexes: Array<{ model: string; fc: HazardPointForecast; index: Map<number, number> }> =
    [];
  if (multiModel) {
    for (const [m, forecasts] of Object.entries(multiModel.byModel)) {
      const fc = forecasts[legIndex];
      if (!fc) continue;
      const index = new Map<number, number>();
      fc.times.forEach((t, idx) => index.set(parseUtc(t), idx));
      modelIndexes.push({ model: m, fc, index });
    }
  }

  const hours: LegHour[] = [];
  let worstVisibility: { hour: LegHour } | null = null;
  let maxCape: { hour: LegHour; level: 'elevated' | 'high' } | null = null;
  const disagreementInput: Array<{
    valid_time: string;
    byModel: Record<string, number | null>;
    sustained_limit_kt: number;
  }> = [];
  let anyExceeded = false;
  let anyApproaching = false;
  for (const [i, input] of inputHours.entries()) {
    const hour = { ...input, limit_status: { ...input.limit_status } };
    const { valid_time: validTime, wind_kt: wind } = hour;
    const sustainedLimit = sustainedLimits[i]!;
    // ---- convective screening + visibility/fog + model disagreement ----
    if (modelIndexes.length > 0) {
      const primary = modelIndexes.find((m) => m.model === model) ?? modelIndexes[0]!;
      const pIdx = primary.index.get(parseUtc(validTime));
      if (pIdx !== undefined) {
        const cape = primary.fc.cape_jkg[pIdx] ?? null;
        hour.cape_jkg = cape;
        hour.squall_potential = squallPotential(cape);
        if (hour.squall_potential === 'high') {
          anyApproaching = true;
          if (!maxCape || (cape ?? 0) > (maxCape.hour.cape_jkg ?? 0)) {
            maxCape = { hour, level: 'high' };
          }
        } else if (hour.squall_potential === 'elevated' && !maxCape) {
          maxCape = { hour, level: 'elevated' };
        }
        hour.fog_risk = fogRisk(
          primary.fc.temp_c[pIdx] ?? null,
          primary.fc.dew_point_c[pIdx] ?? null,
          wind,
        );
      }
      for (const vm of VIS_MODELS) {
        const src = modelIndexes.find((m) => m.model === vm);
        const vIdx = src?.index.get(parseUtc(validTime));
        const visM = vIdx !== undefined ? (src!.fc.visibility_m[vIdx] ?? null) : null;
        if (visM !== null) {
          hour.visibility_nm = visibilityNm(visM);
          break;
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
          worstVisibility = { hour };
        }
      }
      if (visStatus === 'approaching') anyApproaching = true;

      const byModelWind: Record<string, number | null> = {};
      for (const m of modelIndexes) {
        const idx2 = m.index.get(parseUtc(validTime));
        byModelWind[m.model] = idx2 !== undefined ? (m.fc.wind_kt[idx2] ?? null) : null;
      }
      const windVals = Object.values(byModelWind).filter((v): v is number => v !== null);
      hour.model_spread_kt =
        windVals.length >= 2
          ? Math.round((Math.max(...windVals) - Math.min(...windVals)) * 10) / 10
          : null;
      disagreementInput.push({
        valid_time: validTime,
        byModel: byModelWind,
        sustained_limit_kt: sustainedLimit,
      });
    }

    hours.push(hour);
  }
  return { hours, worstVisibility, maxCape, disagreementInput, anyExceeded, anyApproaching };
}
