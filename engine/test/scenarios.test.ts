/**
 * Verdict-state harness (M5): the five synthetic scenario bundles must produce
 * the five §7 verdict states. Bundles are generated deterministically by
 * `deepweather-analysis scenario all` and checked in as fixtures.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleFindings } from '../src/findings.js';
import { renderBriefing } from '../src/briefing.js';
import {
  fetchEnsembleForecasts,
  fetchMarineForecasts,
  fetchMultiModelForecasts,
  fetchPointForecasts,
  MemoryCacheStore,
} from '../src/fetch/openMeteo.js';
import { deriveLegs, legMidpoints } from '../src/route.js';
import { ENGINE_VERSION } from '../src/index.js';
import type { LimitsProfile, Route, WarningsInput } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SCENARIOS_DIR = join(HERE, 'fixtures', 'scenarios');
const DEPARTURE = '2026-07-20T06:00:00Z';
const FIXED_NOW = Date.parse('2026-07-19T18:00:00Z');

const EXPECTED: Record<string, string> = {
  calm: 'within',
  approaching: 'approaching',
  storm: 'exceeds',
  diverging: 'insufficient',
  warning: 'warning_active',
};

async function runScenario(name: string) {
  const dir = join(SCENARIOS_DIR, name);
  const route = JSON.parse(
    readFileSync(join(REPO, 'config', 'routes', 'cherbourg-plymouth.json'), 'utf8'),
  ) as Route;
  const profile = JSON.parse(
    readFileSync(join(REPO, 'config', 'profiles', 'default-limits.json'), 'utf8'),
  ) as LimitsProfile;

  const fileFetch = (async (url: string | URL) => {
    const path = String(url).split('?')[0]!.replace('file://', '');
    return new Response(readFileSync(path, 'utf8'), { status: 200 });
  }) as unknown as typeof fetch;

  const points = legMidpoints(deriveLegs(route)).map((p) => ({ lat: p.lat, lon: p.lon }));
  const opts = (api: string) => ({
    fetchFn: fileFetch,
    cache: new MemoryCacheStore(),
    now: () => FIXED_NOW,
    baseUrl: `file://${dir}/${api}.json`,
  });
  const det = await fetchPointForecasts(points, '2026-07-20', '2026-07-22', opts('forecast'));
  const ens = await fetchEnsembleForecasts(points, '2026-07-20', '2026-07-22', opts('ensemble'));
  const marine = await fetchMarineForecasts(points, '2026-07-20', '2026-07-22', opts('marine'));
  const multi = await fetchMultiModelForecasts(points, '2026-07-20', '2026-07-22', opts('multimodel'));

  let warnings: WarningsInput | undefined;
  const warningsPath = join(dir, 'warnings.json');
  if (existsSync(warningsPath)) {
    warnings = {
      doc: JSON.parse(readFileSync(warningsPath, 'utf8')),
      routeZoneIds: ['casquets', 'hague-barfleur', 'portland', 'plymouth'],
      ref: `scenario:${name}`,
    };
  }

  const findings = assembleFindings({
    route,
    profile,
    departureUtc: DEPARTURE,
    legForecasts: det.forecasts,
    requestMeta: [det.meta],
    legEnsembles: ens.forecasts,
    ensembleMeta: ens.meta,
    legMarine: marine.forecasts,
    marineMeta: marine.meta,
    multiModel: multi,
    warnings,
    engineVersion: ENGINE_VERSION,
    nowMs: FIXED_NOW,
  });
  return { findings, briefing: renderBriefing(findings) };
}

describe('verdict-state harness: five scenarios -> five §7 states', () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`${name} -> ${expected}`, async () => {
      const { findings } = await runScenario(name);
      expect(findings.verdict.state).toBe(expected);
    });
  }

  it('warning scenario: synthetic bulletin is badged emulated and disclosed', async () => {
    const { findings, briefing } = await runScenario('warning');
    const authorityEvidence = findings.evidence.filter((e) => e.rule_id === 'A-WARN-01');
    expect(authorityEvidence).toHaveLength(1);
    expect(authorityEvidence[0]!.source_kind).toBe('emulated'); // synthetic source -> emulated badge
    expect(findings.verdict.warning_override.active).toBe(true);
    expect(findings.verdict.warning_override.bulletin_ref).toContain('casquets');

    const ids = briefing.sections.map((s) => s.id);
    expect(ids[0]).toBe('warnings'); // authority section always first
    expect(ids).toContain('emulated_disclosure');
  });

  it('storm scenario: front signatures present (gust ramp + building seas)', async () => {
    const { findings } = await runScenario('storm');
    const allHours = findings.legs.flatMap((l) => l.hours);
    const gusts = allHours.map((h) => h.gust_kt).filter((g): g is number => g !== null);
    expect(Math.max(...gusts)).toBeGreaterThan(30);
    const hs = allHours.map((h) => h.waves?.hs_m ?? 0);
    expect(Math.max(...hs)).toBeGreaterThan(2); // seas build behind the front, late passage
  });
});
