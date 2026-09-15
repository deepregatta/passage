/**
 * Verdict-state harness: the five synthetic scenario bundles must produce
 * the five verdict states. Bundles are generated deterministically by
 * `deepweather-analysis scenario all` and checked in as fixtures.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildPlume, writeSnapshot } from '../src/snapshot.js';
import { diffFindings } from '../src/diff.js';
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

async function runScenario(name: string, visibilityM?: number) {
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
  if (visibilityM !== undefined && multi) {
    for (const forecasts of Object.values(multi.byModel)) {
      for (const forecast of forecasts) forecast.visibility_m = forecast.times.map(() => visibilityM);
    }
  }

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
  return { findings, briefing: renderBriefing(findings, synoptic), route, plume: buildPlume(findings, ens?.forecasts, profile.max_gust_kt, multi?.byModel) };
}

describe('verdict-state harness: five scenarios -> five states', () => {
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

it.each([0, 185.2])('causal story prioritises severe minimum visibility (%s m) over above-limit wind', async (visibilityM) => {
  const { findings } = await runScenario('storm', visibilityM);
  const events = findings.causal_events!.filter(event => {
    const evidence = findings.evidence.filter(item => event.consequence.evidence_ids.includes(item.evidence_id));
    return evidence.some(item => item.rule_id === 'V-VIS-01') && evidence.some(item => item.rule_id.startsWith('W-'));
  });
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) expect(event.consequence.register_plain).toMatch(/visibility/i);
});

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validators = Object.fromEntries(['findings', 'briefing', 'snapshot', 'changes', 'plume'].map(name => [
  name, ajv.compile(JSON.parse(readFileSync(join(REPO, 'contracts', `${name}.schema.json`), 'utf8'))),
]));
for (const name of Object.keys(EXPECTED)) {
  it(`${name}: serialized engine artifacts satisfy their contracts`, async () => {
    const { findings, briefing, route, plume } = await runScenario(name);
    const files = new Map<string, string>();
    await writeSnapshot({ exists: async () => false, write: async (_id, file, body) => { files.set(file, body); } }, findings, briefing, { route, plume }, FIXED_NOW);
    const previous = (await runScenario('reference-demo-prev')).findings;
    files.set('changes.json', JSON.stringify(diffFindings(previous, findings)));
    for (const [artifact, validate] of Object.entries(validators)) {
      expect(files.has(`${artifact}.json`)).toBe(true);
      const value = JSON.parse(files.get(`${artifact}.json`)!);
      expect(validate(value), `${name}/${artifact}: ${JSON.stringify(validate.errors)}`).toBe(true);
      // Prove each validator rejects a broken required field, not just any object.
      delete value.snapshot_id;
      expect(validate(value), `${artifact} must require snapshot_id`).toBe(false);
    }
    expect(JSON.parse(files.get('snapshot.json')!).artifacts.plume).toBe('plume.json');
  });
}
