import { describe, expect, it } from 'vitest';
import { deepWaterWavelengthM, steepness, crossSeaAngleDeg, assessCrossSea, windAgainstSwell } from '../src/hazards/waves.js';
import { squallPotential } from '../src/hazards/convective.js';
import { evaluateMinVisibility, fogRisk, visibilityNm } from '../src/hazards/visibility.js';
import { assessDisagreement } from '../src/disagreement.js';

describe('waves: correct steepness (L = gT²/2π, NOT H/T)', () => {
  it('wavelength: T=6s -> L ≈ 56.2 m (hand calc: 9.81*36/(2π))', () => {
    expect(deepWaterWavelengthM(6)).toBeCloseTo(56.23, 1);
  });

  it('steepness: H=2m, T=6s -> ≈ 0.0356; 1/7 is the theoretical breaking limit', () => {
    const s = steepness(2, 6)!;
    expect(s).toBeCloseTo(2 / 56.23, 3);
    expect(s).toBeLessThan(1 / 7);
  });

  it('same H over shorter period is much steeper (the danger signal)', () => {
    expect(steepness(2, 4)!).toBeGreaterThan(steepness(2, 8)! * 3.9);
  });

  it('degenerate period -> null, not Infinity', () => {
    expect(steepness(2, 0)).toBeNull();
  });

  it('cross-sea: 90° between trains, significant only when both carry energy', () => {
    expect(crossSeaAngleDeg(200, 290)).toBe(90);
    expect(assessCrossSea(1.0, 200, 1.2, 290)).toEqual({ angle_deg: 90, significant: true });
    expect(assessCrossSea(1.0, 200, 0.3, 290)!.significant).toBe(false);
    expect(assessCrossSea(1.0, 200, 1.2, 230)!.significant).toBe(false); // 30° < 45°
  });

  it('wind against swell: reciprocal directions + real swell + real wind', () => {
    expect(windAgainstSwell(90, 20, 275, 1.5)).toBe(true); // wind from E vs swell from W
    expect(windAgainstSwell(90, 10, 275, 1.5)).toBe(false); // too light
    expect(windAgainstSwell(90, 20, 275, 0.5)).toBe(false); // negligible swell
    expect(windAgainstSwell(90, 20, 120, 1.5)).toBe(false); // same quadrant
  });
});

describe('convective screening (labeled low-skill, never precise)', () => {
  it('levels: <300 low, 300-1000 elevated, >=1000 high', () => {
    expect(squallPotential(100)).toBe('low');
    expect(squallPotential(500)).toBe('elevated');
    expect(squallPotential(1500)).toBe('high');
    expect(squallPotential(null)).toBeNull();
  });
});

describe('visibility: minimum limit semantics', () => {
  it('below minimum = exceeded, within 1.5x = approaching', () => {
    expect(visibilityNm(1852)).toBe(1);
    expect(evaluateMinVisibility(1.0, 2)).toBe('exceeded');
    expect(evaluateMinVisibility(2.5, 2)).toBe('approaching');
    expect(evaluateMinVisibility(5, 2)).toBe('ok');
    expect(evaluateMinVisibility(null, 2)).toBe('unknown');
    expect(evaluateMinVisibility(0.5, null)).toBe('ok'); // no declared minimum
  });

  it('fog risk: small dew-point spread + light wind', () => {
    expect(fogRisk(15, 14, 5)).toBe(true);
    expect(fogRisk(15, 14, 15)).toBe(false);
    expect(fogRisk(15, 10, 5)).toBe(false);
  });
});

describe('model disagreement -> insufficient confidence', () => {
  it('agreeing models: no divergence', () => {
    const r = assessDisagreement([
      { valid_time: 't1', byModel: { a: 15, b: 16, c: 14 }, sustained_limit_kt: 22 },
    ]);
    expect(r.divergent_hours).toHaveLength(0);
    expect(r.insufficient).toBe(false);
  });

  it('models split near the limit: divergent AND insufficient', () => {
    const r = assessDisagreement([
      { valid_time: 't1', byModel: { a: 25, b: 14, c: 18 }, sustained_limit_kt: 22 },
    ]);
    expect(r.divergent_hours).toHaveLength(1);
    expect(r.divergent_hours[0]!.spread_kt).toBe(11);
    expect(r.insufficient).toBe(true);
  });

  it('models split but all far below the limit: divergent, NOT insufficient', () => {
    const r = assessDisagreement([
      { valid_time: 't1', byModel: { a: 12, b: 3 }, sustained_limit_kt: 22 },
    ]);
    expect(r.divergent_hours).toHaveLength(1);
    expect(r.insufficient).toBe(false);
  });

  it('single model: nothing to disagree with', () => {
    const r = assessDisagreement([{ valid_time: 't1', byModel: { a: 25 }, sustained_limit_kt: 22 }]);
    expect(r.divergent_hours).toHaveLength(0);
  });
});
