/**
 * Tests that build audit options by hand and mean "the same forecast all along
 * each leg": copy each leg's series to every audit sample point of that leg
 * (auditSamplePoints), at the point's own position.
 */
import { auditSamplePoints } from '../../src/auditSampling.js';
import { deriveLegs } from '../../src/route.js';
import type { Route } from '../../src/types.js';

export function alongEachLeg<T extends { lat: number; lon: number }>(route: Route, perLeg: readonly T[]): T[] {
  return auditSamplePoints(deriveLegs(route)).map((p) => ({ ...structuredClone(perLeg[p.leg_index]!), lat: p.lat, lon: p.lon }));
}
