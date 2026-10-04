import { describe, expect, it } from 'vitest';
import { passageMaxHours, routeBbox } from '../src/fetch/liveGrids.js';

describe('route grid bounds and duration', () => {
  it('pads route bounds and scales duration', () => {
    expect(routeBbox({ lat: 50, lon: -2 }, { lat: 51, lon: 0 })).toEqual({
      minLat: 49.5, maxLat: 51.5, minLon: -2.5, maxLon: 0.5,
    });
    expect(passageMaxHours({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBe(48);
  });

  it('refuses antimeridian-crossing routes', () => {
    expect(() => routeBbox({ lat: 0, lon: 170 }, { lat: 0, lon: -170 })).toThrow(/Antimeridian/);
  });
});
