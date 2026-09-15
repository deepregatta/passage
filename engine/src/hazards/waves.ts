/**
 * Sea-state hazard:
 *  - steepness computed properly: deep-water wavelength L ≈ gT²/2π, steepness = H/L
 *    (dimensionless; H and L use the same length unit)
 *  - wind-wave and swell components evaluated separately; cross-sea angle between them
 *  - directions are "coming from", degrees true (wave-model convention, matches GFS-Wave tiles)
 */

import { wrap180 } from '../geo.js';

const G = 9.81;
export const CROSS_SEA_ANGLE_DEG = 45;

/** Deep-water wavelength in metres for period T seconds. */
export function deepWaterWavelengthM(periodS: number): number {
  return (G * periodS * periodS) / (2 * Math.PI);
}

/** Wave steepness H/L (dimensionless). Null when period is degenerate. */
export function steepness(heightM: number, periodS: number): number | null {
  if (!(periodS > 0.5)) return null;
  return heightM / deepWaterWavelengthM(periodS);
}

/** Angle between wind-wave and swell trains, degrees [0, 180]. */
export function crossSeaAngleDeg(windWaveFromDeg: number, swellFromDeg: number): number {
  return Math.abs(wrap180(windWaveFromDeg - swellFromDeg));
}

export interface CrossSeaAssessment {
  angle_deg: number;
  significant: boolean;
}

/** Cross-sea is significant when both trains carry energy and cross at > 45°. */
export function assessCrossSea(
  windWaveH: number | null,
  windWaveFrom: number | null,
  swellH: number | null,
  swellFrom: number | null,
): CrossSeaAssessment | null {
  if (windWaveH === null || swellH === null || windWaveFrom === null || swellFrom === null) {
    return null;
  }
  const angle = crossSeaAngleDeg(windWaveFrom, swellFrom);
  return {
    angle_deg: Math.round(angle),
    significant: angle > CROSS_SEA_ANGLE_DEG && windWaveH >= 0.5 && swellH >= 0.5,
  };
}

/**
 * Wind-against-swell: wind opposing the swell's propagation steepens it.
 * Both directions are "coming from": opposition means the two FROM-directions
 * are ~reciprocal (angle > 150°). Flagged when swell and wind are substantial.
 */
export function windAgainstSwell(
  windFromDeg: number | null,
  windKt: number | null,
  swellFromDeg: number | null,
  swellH: number | null,
): boolean {
  if (windFromDeg === null || windKt === null || swellFromDeg === null || swellH === null) {
    return false;
  }
  const angle = Math.abs(wrap180(windFromDeg - swellFromDeg));
  return angle > 150 && swellH >= 1.0 && windKt >= 15;
}
