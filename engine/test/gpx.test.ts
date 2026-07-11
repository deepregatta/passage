import { describe, expect, it } from 'vitest';
import { parseGpx } from '../src/gpx.js';

const SPEEDS = { slow: 4.5, nominal: 5.5, fast: 6.5 };

const ROUTE_GPX = `<?xml version="1.0"?>
<gpx version="1.1"><rte><name>Test Crossing</name>
<rtept lat="49.665" lon="-1.645"><name>Cherbourg</name></rtept>
<rtept lat="49.95" lon="-2.85"/>
<rtept lat="50.333" lon="-4.175"><name>Plymouth</name></rtept>
</rte></gpx>`;

describe('GPX import', () => {
  it('parses route points with names', () => {
    const route = parseGpx(ROUTE_GPX, { route_id: 'test', speeds_kt: SPEEDS });
    expect(route.mode).toBe('user');
    expect(route.waypoints).toHaveLength(3);
    expect(route.waypoints[0]).toMatchObject({ id: 'wp1', name: 'Cherbourg', lat: 49.665, lon: -1.645 });
    expect(route.waypoints[1]!.name).toBeUndefined();
    expect(route.name).toBe('Test Crossing');
  });

  it('thins dense tracks to a sane waypoint count, keeping endpoints', () => {
    const pts = Array.from(
      { length: 500 },
      (_, i) => `<trkpt lat="${(49 + i * 0.002).toFixed(4)}" lon="${(-2 - i * 0.003).toFixed(4)}"/>`,
    ).join('');
    const route = parseGpx(`<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`, {
      route_id: 'track',
      speeds_kt: SPEEDS,
      maxPoints: 20,
    });
    expect(route.waypoints).toHaveLength(20);
    expect(route.waypoints[0]!.lat).toBeCloseTo(49, 3);
    expect(route.waypoints[19]!.lat).toBeCloseTo(49 + 499 * 0.002, 3);
  });

  it('rejects files with fewer than 2 points', () => {
    expect(() =>
      parseGpx('<gpx><wpt lat="49" lon="-2"/></gpx>', { route_id: 'x', speeds_kt: SPEEDS }),
    ).toThrow(/fewer than 2/);
  });
});
