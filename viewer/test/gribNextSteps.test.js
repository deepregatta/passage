import { describe, expect, it } from 'vitest';
import { gribReplayRaces } from '../src/lib/gribNextSteps.js';

describe('static race course intersections', () => {
  it.each([
    ['fastnet2025', { minLat: 50.6, maxLat: 50.8, minLon: -1.6, maxLon: -1.3 }],
    ['rmsr2025', { minLat: 35.8, maxLat: 36, minLon: 14.4, maxLon: 14.6 }],
    ['arc2018', { minLat: 21.9, maxLat: 22.9, minLon: -39, maxLon: -38 }],
  ])('finds %s even when the box cuts a segment between course nodes', (id, area) => {
    expect(gribReplayRaces(area).map((race) => race.id)).toEqual([id]);
  });
  it('excludes a box within ARC’s bounding rectangle but away from its course', () => {
    expect(gribReplayRaces({ minLat: 26, maxLat: 27, minLon: -59, maxLon: -58 })).toEqual([]);
  });
  it('excludes unrelated and invalid boxes', () => {
    expect(gribReplayRaces({ minLat: -35, maxLat: -34, minLon: 18, maxLon: 19 })).toEqual([]);
    expect(gribReplayRaces(null)).toEqual([]);
  });
});
