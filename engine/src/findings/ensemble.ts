import type { LegHour, LimitsProfile } from '../types.js';
import type { EnsemblePointForecast } from '../forecast/types.js';
import { parseUtc } from '../eta.js';
import { countExceedance, fraction } from '../exceedance.js';

export function evaluateEnsemble(
  inputHours: LegHour[], sustainedLimits: number[], ensemble: EnsemblePointForecast | null,
  profile: LimitsProfile, scenarioFloor: number,
) {
  const ensembleTimeIndex = new Map<number, number>();
  ensemble?.times.forEach((t, idx) => ensembleTimeIndex.set(parseUtc(t), idx));
  const hours: LegHour[] = [];
  let worstEnsembleGust: { hour: LegHour; count: { exceed: number; total: number } } | null = null;
  let worstEnsembleSustained: {
    hour: LegHour;
    count: { exceed: number; total: number };
    limit: number;
  } | null = null;
  let scenarioFractionAboveFloor = false;
  for (const [i, input] of inputHours.entries()) {
    const hour = { ...input };
    const validTime = hour.valid_time;
    const sustainedLimit = sustainedLimits[i]!;
    // ensemble scenario exceedance for this hour (direction for the POS limit comes
    // from the deterministic run; members carry speed/gusts only)
    if (ensemble) {
      const eIdx = ensembleTimeIndex.get(parseUtc(validTime));
      if (eIdx !== undefined) {
        const gustCount = countExceedance(ensemble.gust_kt_members, eIdx, profile.max_gust_kt);
        const sustainedCount = countExceedance(ensemble.wind_kt_members, eIdx, sustainedLimit);
        hour.exceedance = { sustained: sustainedCount, gust: gustCount };
        if (gustCount && fraction(gustCount) >= scenarioFloor) scenarioFractionAboveFloor = true;
        if (sustainedCount && fraction(sustainedCount) >= scenarioFloor) {
          scenarioFractionAboveFloor = true;
        }
        if (gustCount && (!worstEnsembleGust || fraction(gustCount) > fraction(worstEnsembleGust.count))) {
          worstEnsembleGust = { hour, count: gustCount };
        }
        if (
          sustainedCount &&
          (!worstEnsembleSustained ||
            fraction(sustainedCount) > fraction(worstEnsembleSustained.count))
        ) {
          worstEnsembleSustained = { hour, count: sustainedCount, limit: sustainedLimit };
        }
      }
    }
    hours.push(hour);
  }
  return { hours, worstEnsembleGust, worstEnsembleSustained, scenarioFractionAboveFloor };
}
