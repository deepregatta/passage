import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { runAnalysis, type AnalyzeResult } from '../src/analyze.js';
import { scanDepartures, type ScanOptions } from '../src/window.js';
import type { Evidence, Findings, Route } from '../src/types.js';

vi.mock('../src/analyze.js', () => ({ runAnalysis: vi.fn() }));
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const base: ScanOptions = {
  route: read('../../config/routes/cherbourg-plymouth.json'),
  profile: read('../../config/profiles/default-limits.json'),
  store: {} as ScanOptions['store'],
};
const departures = ['2026-07-12T06:00:00Z', '2026-07-12T12:00:00Z', '2026-07-12T18:00:00Z'];
function result(value = 1): AnalyzeResult {
  const findings = read('./golden/findings-cherbourg-plymouth.json') as Findings;
  const evidence: Evidence = { ...findings.evidence[0]!, rule_id: 'V-VIS-01', value, limit: 2, units: 'nm' };
  delete evidence.member_fraction;
  findings.evidence = [evidence];
  findings.verdict.state = 'exceeds';
  return { findings } as AnalyzeResult;
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(runAnalysis).mockResolvedValue(result()); });

it('returns per-departure analysis and routing failures while continuing with the candidate-specific route', async () => {
  vi.mocked(runAnalysis).mockRejectedValueOnce(new Error('Tile service unavailable')).mockResolvedValueOnce(result());
  const route: Route = { ...base.route, route_id: 'rerouted' };
  const routeFor = vi.fn((departure: string) => {
    if (departure === departures[1]) throw new Error('No sea route found');
    return route;
  });
  const onCandidate = vi.fn();
  const scan = await scanDepartures({ ...base, routeFor }, departures, onCandidate);
  expect(scan).toMatchObject({
    skipped: [
      { departure_utc: departures[0], reason: 'Tile service unavailable' },
      { departure_utc: departures[1], reason: 'No sea route found' },
    ], best_index: 0,
  });
  expect(scan.candidates.map(c => c.departure_utc)).toEqual([departures[2]]);
  expect(onCandidate).toHaveBeenCalledTimes(1);
  expect(runAnalysis).toHaveBeenLastCalledWith(expect.objectContaining({ route, store: base.store, departureUtc: departures[2] }));
});

it('keeps reasons when all candidates fail, including non-Error throws', async () => {
  vi.mocked(runAnalysis).mockRejectedValueOnce('Forecast horizon exceeded').mockRejectedValueOnce(null);
  expect(await scanDepartures(base, departures.slice(0, 2))).toEqual({
    candidates: [], best_index: null, skipped: [
      { departure_utc: departures[0], reason: 'Forecast horizon exceeded' },
      { departure_utc: departures[1], reason: 'Unknown error' },
    ],
  });
});

it('ranks lower visibility as worse, including zero visibility', async () => {
  vi.mocked(runAnalysis).mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(0.5)).mockResolvedValueOnce(result(1));
  const scan = await scanDepartures(base, departures);
  expect(scan.candidates.map(c => c.worst_ratio)).toEqual([Infinity, 4, 2]);
  expect(scan.best_index).toBe(2);
  expect(scan).toHaveProperty('skipped', []);
});

it('retains maximum-limit and ensemble ranking semantics', async () => {
  const analyzed = result();
  analyzed.findings.evidence[0] = { ...analyzed.findings.evidence[0]!, rule_id: 'W-GUST-01', value: 30, limit: 20 };
  analyzed.findings.evidence.push({ ...analyzed.findings.evidence[0]!, value: 100, member_fraction: { exceed: 3, total: 10 } });
  vi.mocked(runAnalysis).mockResolvedValue(analyzed);
  const scan = await scanDepartures(base, departures.slice(0, 1));
  expect(scan.candidates[0]).toMatchObject({ worst_ratio: 1.5, max_fraction: 0.3 });
});

it('returns an empty scan without invoking analysis for no departures', async () => {
  expect(await scanDepartures(base, [])).toEqual({ candidates: [], best_index: null, skipped: [] });
  expect(runAnalysis).not.toHaveBeenCalled();
});
