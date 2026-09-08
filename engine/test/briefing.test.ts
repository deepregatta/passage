import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderBriefing, nextForecastRuns } from '../src/briefing.js';
import { diffFindings } from '../src/diff.js';
import { runAnalysis } from '../src/analyze.js';
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import type { LayerInfo } from '../src/forecast/store.js';
import type { Findings, LimitsProfile, Route, SynopticFeatures } from '../src/types.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const findings = read('./golden/findings-cherbourg-plymouth.json') as Findings;
const synoptic = read('./fixtures/scenarios/reference-demo/synoptic.json') as SynopticFeatures;
const layer = (overrides: Partial<LayerInfo> = {}): LayerInfo => ({
  layer: 'weather', model: 'gfs_0p25', run_id: 'weather-20260908T00Z',
  cycle: '2026-09-08T00:00:00Z', published_at: '2026-09-08T04:20:00Z',
  member_count: 1, resolution_deg: 0.25, ...overrides,
});
const now = '2026-09-08T18:00:00Z';

function story(route: Route, lat: number, lon: number) {
  const features = structuredClone(synoptic);
  features.systems = [features.systems.find((s) => s.kind === 'low')!];
  Object.assign(features.systems[0]!.track[0]!, { lat, lon });
  return renderBriefing(findings, features, { route }).sections.find((s) => s.id === 'synoptic_story')!.register_plain;
}

describe('route-relative briefing geography', () => {
  for (const id of ['cherbourg-plymouth', 'newport-newyork', 'brisbane-gladstone', 'palma-barcelona']) {
    it(`locates systems relative to ${id}`, () => {
      const route = read(`../../config/routes/${id}.json`) as Route;
      const lat = (Math.min(...route.waypoints.map((p) => p.lat)) + Math.max(...route.waypoints.map((p) => p.lat))) / 2;
      const lon = (Math.min(...route.waypoints.map((p) => p.lon)) + Math.max(...route.waypoints.map((p) => p.lon))) / 2;
      expect(story(route, lat, lon)).toContain('near the centre of your route');
      expect(story(route, lat + 4, lon)).toContain('100–300 nm N of the centre of your route');
      expect(story(route, lat - 8, lon)).toContain('more than 300 nm S of the centre of your route');
      expect(story(route, lat, lon - 1)).toContain('within 100 nm W of the centre of your route');
    });
  }
  it('uses the short longitude span across the date line', () => {
    const route = read('../../config/routes/palma-barcelona.json') as Route;
    route.waypoints = [{ id: 'a', name: 'a', lat: 0, lon: 179 }, { id: 'b', name: 'b', lat: 0, lon: -179 }];
    expect(story(route, 0, 180)).toContain('near the centre of your route');
    expect(story(route, 0, -178)).toContain('100–300 nm E of the centre of your route');
  });
  it('does not invent route-relative geography without a route', () => {
    expect(renderBriefing(findings, synoptic).sections[0]!.register_plain).toContain('at the charted position');
  });
});

describe('one metadata-based next update', () => {
  it('uses the daily tile publication cadence and observed publication lag', () => {
    expect(nextForecastRuns({ weather: layer() }, now)).toEqual([
      { model: 'gfs_0p25', expected_at: '2026-09-09T04:20:00Z' },
    ]);
  });
  it('orders available layers by expected publication, with their actual model names', () => {
    const layers = { weather: layer(), ensemble: layer({ layer: 'ensemble', model: 'gefs_0p50', published_at: '2026-09-08T04:00:00Z' }) };
    const runs = nextForecastRuns(layers, now);
    expect(runs.map((r) => r.model)).toEqual(['gefs_0p50', 'gfs_0p25']);
    const briefing = renderBriefing(findings, undefined, { nextRuns: runs });
    expect(diffFindings(findings, findings, briefing.next_run).story?.next_run).toEqual(briefing.next_run);
    expect(briefing.next_runs).toEqual(runs);
    expect(briefing.sections.find((s) => s.id === 'what_could_change')?.register_pro).toContain('Estimated');
  });
  it('does not roll overdue publications forward and conceal stale data', () => {
    expect(nextForecastRuns({ weather: layer() }, '2026-09-10T18:00:00Z')).toEqual([]);
    expect(nextForecastRuns({ weather: layer() }, '2026-09-09T04:20:00Z')).toEqual([]);
  });
  it.each([
    { model: 'unknown' }, { cycle: 'scenario' }, { published_at: 'invalid' },
    { published_at: '2026-09-07T23:00:00Z' }, { published_at: '2026-09-09T01:00:00Z' },
  ])('withholds an estimate for unusable metadata %j', (bad) => {
    expect(nextForecastRuns({ weather: layer(bad) }, now)).toEqual([]);
  });
  it('omits next-run fields when no schedule can be estimated', () => {
    const briefing = renderBriefing(findings);
    expect(briefing.next_run).toBeUndefined();
    expect(briefing.next_runs).toEqual([]);
    expect(briefing.sections.find((s) => s.id === 'what_could_change')?.register_plain).toContain('Next forecast update time unavailable');
    expect(diffFindings(findings, findings).story?.next_run).toBeUndefined();
  });
  it('passes store.describe metadata through the analysis pipeline', async () => {
    const store = new ScenarioBundleStore({ loadBundle: async (name) => read(`./fixtures/scenarios/reference-demo/${name}.json`) });
    vi.spyOn(store, 'describe').mockReturnValue({ weather: layer() });
    const result = await runAnalysis({
      store, route: read('../../config/routes/cherbourg-plymouth.json') as Route,
      profile: read('../../config/profiles/default-limits.json') as LimitsProfile,
      departureUtc: '2026-07-20T06:00:00Z', now: () => Date.parse(now), synoptic,
    });
    expect(result.briefing.next_run).toEqual({ model: 'gfs_0p25', expected_at: '2026-09-09T04:20:00Z' });
    expect(result.briefing.sections.find((s) => s.id === 'synoptic_story')?.register_plain).toContain('of the centre of your route');
  });
});

for (const nextRuns of [[], [{ model: 'gfs_0p25', expected_at: '2026-09-09T04:20:00Z' }]]) {
  it(`validates briefing and changes with ${nextRuns.length} update estimates`, () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const briefing = renderBriefing(findings, undefined, { nextRuns });
    const changes = diffFindings(findings, findings, briefing.next_run);
    for (const [name, data] of [['briefing', briefing], ['changes', changes]] as const) {
      const validate = ajv.compile(read(`../../contracts/${name}.schema.json`));
      expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
    }
  });
}
