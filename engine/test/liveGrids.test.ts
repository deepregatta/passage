import { describe, expect, it } from 'vitest';
import { passageMaxHours, planGrid, routeBbox } from '../src/fetch/liveGrids.js';

describe('live grid planning', () => {
  it('pads route bounds, scales duration, and coarsens within the point budget', () => {
    expect(routeBbox({ lat: 50, lon: -2 }, { lat: 51, lon: 0 })).toEqual({
      minLat: 49.5, maxLat: 51.5, minLon: -2.5, maxLon: 0.5,
    });
    expect(passageMaxHours({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBe(48);
    const plan = planGrid({ minLat: 0, maxLat: 5, minLon: 0, maxLon: 5 });
    expect(plan.points.length).toBeLessThanOrEqual(200);
    expect(plan.dlat).toBeGreaterThan(0.25);
    expect(plan.under_resolved_note).toMatch(/coarsened/);
  });

  it('refuses oversized and antimeridian-crossing areas', () => {
    expect(() => planGrid({ minLat: -20, maxLat: 20, minLon: -20, maxLon: 20 })).toThrow(/too large/);
    expect(() => routeBbox({ lat: 0, lon: 170 }, { lat: 0, lon: -170 })).toThrow(/Antimeridian/);
  });
});
