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
import { ScenarioBundleStore } from '../src/forecast/scenarioStore.js';
import { deriveLegs, legMidpoints } from '../src/route.js';
import { ENGINE_VERSION } from '../src/index.js';
import type { LimitsProfile, Route, SynopticFeatures, WarningsInput } from '../src/types.js';

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
  'reference-demo': 'warning_active',
  'reference-demo-prev': 'warning_active',
};

async function runScenario(name: string) {
  const dir = join(SCENARIOS_DIR, name);
  const route = JSON.parse(
    readFileSync(join(REPO, 'config', 'routes', 'cherbourg-plymouth.json'), 'utf8'),
  ) as Route;
  const profile = JSON.parse(
    readFileSync(join(REPO, 'config', 'profiles', 'default-limits.json'), 'utf8'),
  ) as LimitsProfile;

  const points = legMidpoints(deriveLegs(route)).map((p) => ({ lat: p.lat, lon: p.lon }));
  const store = new ScenarioBundleStore({
    loadBundle: async (name) => {
      const path = join(dir, `${name}.json`);
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    },
    now: () => FIXED_NOW,
  });
  const det = await store.getPointForecasts(points, 0, 0);
  const ens = await store.getEnsembleForecasts(points, 0, 0);
  const marine = await store.getWaveForecasts(points, 0, 0);
  const multi = await store.getHazardForecasts(points, 0, 0);

  let warnings: WarningsInput | undefined;
  const warningsPath = join(dir, 'warnings.json');
  if (existsSync(warningsPath)) {
    warnings = {
      doc: JSON.parse(readFileSync(warningsPath, 'utf8')),
      routeZoneIds: ['casquets', 'hague-barfleur', 'portland', 'plymouth'],
      ref: `scenario:${name}`,
    };
  }

  let synoptic: SynopticFeatures | undefined;
  const synopticPath = join(dir, 'synoptic.json');
  if (existsSync(synopticPath)) {
    synoptic = JSON.parse(readFileSync(synopticPath, 'utf8')) as SynopticFeatures;
  }

  const findings = assembleFindings({
    route,
    profile,
    departureUtc: DEPARTURE,
    legForecasts: det.forecasts,
    requestMeta: [det.meta],
    ...(ens ? { legEnsembles: ens.forecasts, ensembleMeta: ens.meta } : {}),
    ...(marine ? { legMarine: marine.forecasts, marineMeta: marine.meta } : {}),
    ...(multi ? { multiModel: multi } : {}),
    warnings,
    synoptic,
    engineVersion: ENGINE_VERSION,
    nowMs: FIXED_NOW,
  });
  return { findings, briefing: renderBriefing(findings, synoptic) };
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
    expect(findings.coverage?.find((item) => item.capability === 'official_warnings')?.status)
      .toBe('assessed_emulated');
    expect(findings.unsupported_hazards.join(' ')).not.toContain('official marine warnings');
    expect(authorityEvidence[0]!.bulletin_ref?.zone_ids).toContain('casquets');
  });

  it('storm scenario: front signatures present (gust ramp + building seas)', async () => {
    const { findings } = await runScenario('storm');
    const allHours = findings.legs.flatMap((l) => l.hours);
    const gusts = allHours.map((h) => h.gust_kt).filter((g): g is number => g !== null);
    expect(Math.max(...gusts)).toBeGreaterThan(30);
    const hs = allHours.map((h) => h.waves?.hs_m ?? 0);
    expect(Math.max(...hs)).toBeGreaterThan(2); // seas build behind the front, late passage
    expect(findings.causal_events?.length).toBeGreaterThan(0);
    expect(findings.causal_events?.[0]?.consequence.evidence_ids.length).toBeGreaterThan(0);
  });

  it('calm scenario without synoptic input has an explicit unavailable story', async () => {
    const { briefing } = await runScenario('calm');
    const story = briefing.sections.find((section) => section.id === 'synoptic_story');
    expect(story?.availability?.status).toBe('unavailable');
    expect(story?.register_plain).toContain('no causal attribution');
  });

  it('reference demo carries the warning, causal low, and 23/51 gust crossing', async () => {
    const { findings } = await runScenario('reference-demo');
    expect(findings.verdict.warning_override.active).toBe(true);
    expect(findings.causal_events?.some((event) => event.system_id === 'L1')).toBe(true);
    expect(
      findings.evidence.some(
        (item) =>
          item.rule_id === 'W-GUST-03' &&
          item.leg_id === 'L4' &&
          item.member_fraction?.exceed === 23 &&
          item.member_fraction.total === 51,
      ),
    ).toBe(true);
  });
});
