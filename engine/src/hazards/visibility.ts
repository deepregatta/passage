/**
 * Visibility & fog (brief §5): visibility fields + dew-point spread screening.
 * min_visibility_nm is a MINIMUM limit: exceeded when forecast visibility is BELOW it.
 */

export const M_PER_NM = 1852;

export function visibilityNm(visibilityM: number | null): number | null {
  if (visibilityM === null || !Number.isFinite(visibilityM)) return null;
  return Math.round((visibilityM / M_PER_NM) * 10) / 10;
}

export type MinLimitStatus = 'ok' | 'approaching' | 'exceeded' | 'unknown';

/** Below the minimum = exceeded; within 1.5x of it = approaching. */
export function evaluateMinVisibility(
  visNm: number | null,
  minNm: number | null | undefined,
): MinLimitStatus {
  if (minNm === null || minNm === undefined) return 'ok';
  if (visNm === null) return 'unknown';
  if (visNm < minNm) return 'exceeded';
  if (visNm < minNm * 1.5) return 'approaching';
  return 'ok';
}

/** Fog formation screening: small dew-point spread + light wind. */
export function fogRisk(
  tempC: number | null,
  dewPointC: number | null,
  windKt: number | null,
): boolean {
  if (tempC === null || dewPointC === null) return false;
  const spread = tempC - dewPointC;
  return spread < 2.0 && (windKt === null || windKt < 10);
}
