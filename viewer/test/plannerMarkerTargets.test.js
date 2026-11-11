import { expect, it } from 'vitest';
import { MARKER_BOX, hitPolygon } from '../src/pages/planner/plannerMarkers.js';

/** The marker whose clip-path contains the pointer (in pixels, same space as the centres). */
function pickedBy(centres, pointer) {
  const hits = centres.map((c, i) => {
    const polygon = hitPolygon(i, centres);
    const local = [pointer.x - (c.x - MARKER_BOX / 2), pointer.y - (c.y - MARKER_BOX / 2)];
    if (local[0] < 0 || local[1] < 0 || local[0] > MARKER_BOX || local[1] > MARKER_BOX) return false;
    if (polygon === null) return true;
    const points = [...polygon.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map((m) => [Number(m[1]), Number(m[2])]);
    let inside = false;
    for (let a = 0, b = points.length - 1; a < points.length; b = a++) {
      const [xa, ya] = points[a];
      const [xb, yb] = points[b];
      if ((ya > local[1]) !== (yb > local[1]) && local[0] < ((xb - xa) * (local[1] - ya)) / (yb - ya) + xa) inside = !inside;
    }
    return inside;
  });
  return hits.flatMap((hit, i) => (hit ? [i] : []));
}

it('leaves a marker its whole 44 px box when no other box overlaps it', () => {
  expect(hitPolygon(0, [{ x: 0, y: 0 }])).toBeNull();
  expect(hitPolygon(0, [{ x: 0, y: 0 }, { x: 44, y: 0 }])).toBeNull();
  expect(hitPolygon(1, [{ x: 0, y: 0 }, { x: 10, y: 44 }])).toBeNull();
});

it('gives the overlap to whichever marker the pointer is nearer, in either drawing order', () => {
  const start = { x: 100, y: 100 };
  const finish = { x: 120, y: 105 };
  for (const centres of [[start, finish], [finish, start]]) {
    const startIndex = centres.indexOf(start);
    const finishIndex = centres.indexOf(finish);
    // On Start's side of the line halfway between them, and on Finish's side.
    expect(pickedBy(centres, { x: 104, y: 101 })).toEqual([startIndex]);
    expect(pickedBy(centres, { x: 116, y: 104 })).toEqual([finishIndex]);
    // The parts of each box that no other box covers still pick that marker.
    expect(pickedBy(centres, { x: 80, y: 100 })).toEqual([startIndex]);
    expect(pickedBy(centres, { x: 141, y: 105 })).toEqual([finishIndex]);
  }
});

it('never lets one pointer position pick two markers', () => {
  const centres = [{ x: 0, y: 0 }, { x: 14, y: 9 }, { x: -11, y: 20 }, { x: 30, y: -6 }];
  for (let x = -40; x <= 60; x += 3) {
    for (let y = -40; y <= 50; y += 3) {
      expect(pickedBy(centres, { x, y }).length).toBeLessThanOrEqual(1);
    }
  }
});

it('hands a shared pixel to the later marker', () => {
  const centres = [{ x: 5, y: 5 }, { x: 5, y: 5 }];
  expect(pickedBy(centres, { x: 6, y: 6 })).toEqual([1]);
});
