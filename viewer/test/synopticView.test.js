import { describe, expect, it } from 'vitest';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import synoptic from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/synoptic.json';
import route from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/route.json';
import { chartProjector } from '../src/lib/synopticCharts.js';
import { PHASE_CAPTION, chartFocusPoints, chartStageStyle, fitChartView, passageWindowMs, phaseCaption } from '../src/lib/synopticView.js';
import { translateText } from '../src/i18n.js';

const projector = chartProjector(synoptic.chart_captions[0]);
const image = { w: projector.w, h: projector.h };
const system = synoptic.systems[0];

describe('phaseCaption', () => {
  it('has a caption for every playback phase, falling back to the unavailable one', () => {
    for (const phase of ['cause', 'interception', 'consequence', 'easing', 'unavailable']) {
      expect(phaseCaption(phase)).toBe(PHASE_CAPTION[phase]);
    }
    expect(phaseCaption('anything else')).toBe(PHASE_CAPTION.unavailable);
  });

  it('describes the chart time in the present tense and has a French line for each', () => {
    for (const text of Object.values(PHASE_CAPTION)) {
      expect(text).not.toMatch(/\b(has|have) crossed\b|\bcrossed\b|\bright after your passage\b/i);
      expect(translateText(text, 'fr')).not.toBe(text);
    }
  });
});

describe('chartFocusPoints', () => {
  const window = passageWindowMs(findings);

  it('contains the route and the system track points that fall in the passage window', () => {
    const points = chartFocusPoints({ route, system, window });
    expect(points.length).toBeGreaterThan(route.waypoints.length);
    for (const waypoint of route.waypoints) expect(points).toContainEqual(waypoint);
    expect(points.some((p) => p.lon === system.track[0].lon)).toBe(true);
  });

  it('keeps one nearest track point when the whole track is outside the window', () => {
    const late = { start: Date.parse('2027-01-01T00:00:00Z'), end: Date.parse('2027-01-02T00:00:00Z') };
    const points = chartFocusPoints({ route, system, window: late });
    expect(points).toHaveLength(route.waypoints.length + 1);
    expect(points.at(-1)).toEqual(system.track[1]);
  });

  it('returns only the route when there is no system', () => {
    expect(chartFocusPoints({ route, system: null, window })).toEqual(route.waypoints);
  });
});

describe('fitChartView', () => {
  const projected = chartFocusPoints({ route, system, window: passageWindowMs(findings) }).map(projector.xy);

  it('whole view shows the entire image inside the viewport', () => {
    const view = fitChartView({ container: { w: 400, h: 300 }, image, mode: 'whole' });
    expect(view.scale).toBeCloseTo(400 / 1200);
    expect(view.x).toBeCloseTo(0);
    expect(view.y).toBeCloseTo(0);
  });

  it('whole view is centred in a taller viewport', () => {
    const view = fitChartView({ container: { w: 345, h: 600 }, image, mode: 'whole' });
    expect(view.x).toBeCloseTo(0);
    expect(view.y).toBeCloseTo((600 - 900 * view.scale) / 2);
  });

  it('framed view zooms in and keeps the route and the system in the viewport', () => {
    for (const container of [{ w: 700, h: 525 }, { w: 345, h: 520 }, { w: 800, h: 360 }]) {
      const whole = fitChartView({ container, image, mode: 'whole' });
      const view = fitChartView({ container, image, points: projected, mode: 'framed' });
      expect(view.scale).toBeGreaterThan(whole.scale * 1.5);
      expect(view.scale).toBeLessThanOrEqual(whole.scale * 8 + 1e-9);
      for (const p of projected) {
        const sx = p.x * view.scale + view.x;
        const sy = p.y * view.scale + view.y;
        expect(sx).toBeGreaterThanOrEqual(0);
        expect(sx).toBeLessThanOrEqual(container.w);
        expect(sy).toBeGreaterThanOrEqual(0);
        expect(sy).toBeLessThanOrEqual(container.h);
      }
    }
  });

  it('framed view fills the viewport when it zooms in: no blank band', () => {
    const container = { w: 345, h: 520 };
    const view = fitChartView({ container, image, points: projected, mode: 'framed' });
    expect(view.x).toBeLessThanOrEqual(0);
    expect(view.y).toBeLessThanOrEqual(0);
    expect(view.x + image.w * view.scale).toBeGreaterThanOrEqual(container.w - 1e-6);
    expect(view.y + image.h * view.scale).toBeGreaterThanOrEqual(container.h - 1e-6);
  });

  it('never zooms tighter than the minimum span for a tiny route', () => {
    const point = { x: 600, y: 450 };
    const container = { w: 600, h: 450 };
    const view = fitChartView({ container, image, points: [point], mode: 'framed', minSpan: 0.1, maxZoom: 100 });
    // the viewport's tighter axis shows exactly the minimum span (10% of the image width)
    expect(image.w * 0.1 * view.scale).toBeCloseTo(Math.min(container.w, container.h));
  });

  it('falls back to the whole view when the points span the whole chart', () => {
    const container = { w: 600, h: 450 };
    const view = fitChartView({ container, image, points: [{ x: 0, y: 0 }, { x: 1200, y: 900 }], mode: 'framed' });
    expect(view.scale).toBeCloseTo(0.5);
  });

  it('re-fits when the viewport changes shape (orientation change)', () => {
    const portrait = fitChartView({ container: { w: 375, h: 700 }, image, points: projected });
    const landscape = fitChartView({ container: { w: 700, h: 340 }, image, points: projected });
    expect(landscape.scale).not.toBeCloseTo(portrait.scale);
  });
});

describe('passageWindowMs', () => {
  it('runs from departure to the last leg arrival', () => {
    const window = passageWindowMs(findings);
    expect(window.start).toBe(Date.parse(findings.departure_utc));
    expect(window.end).toBeGreaterThan(window.start);
  });
  it('is null without a departure', () => {
    expect(passageWindowMs({ legs: [] })).toBeNull();
  });
});

describe('chartStageStyle', () => {
  it('fills the viewport until it has been measured', () => {
    expect(chartStageStyle({ size: null, image, points: [], framed: true })).toEqual({ width: '100%', height: '100%' });
  });
  it('places the image in native pixels with a transform once measured', () => {
    const style = chartStageStyle({ size: { w: 400, h: 300 }, image, points: [], framed: false });
    expect(style.width).toBe(1200);
    expect(style.transform).toBe(`translate(0px, 0px) scale(${400 / 1200})`);
  });
});
