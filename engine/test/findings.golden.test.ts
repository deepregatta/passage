/**
 * Golden test: recorded Open-Meteo fixture + fixed clock -> byte-stable findings.
 * Regenerate the golden after intentional engine changes:
 *   UPDATE_GOLDEN=1 npm -w engine test
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { assembleFindings } from '../src/findings.js';
import { renderBriefing } from '../src/briefing.js';
import { buildPlume } from '../src/snapshot.js';
import {
  fetchEnsembleForecasts,
  fetchPointForecasts,
  MemoryCacheStore,
} from '../src/fetch/openMeteo.js';
import { deriveLegs, legMidpoints } from '../src/route.js';
import { ENGINE_VERSION } from '../src/index.js';
import type { LimitsProfile, Route } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIXTURE = join(HERE, 'fixtures', 'openmeteo-forecast-cherbourg-plymouth.json');
const ENSEMBLE_FIXTURE = join(HERE, 'fixtures', 'openmeteo-ensemble-cherbourg-plymouth.json');
const GOLDEN = join(HERE, 'golden', 'findings-cherbourg-plymouth.json');
const GOLDEN_BRIEFING = join(HERE, 'golden', 'briefing-cherbourg-plymouth.json');

const DEPARTURE = '2026-07-12T06:00:00Z';
const FIXED_NOW = Date.parse('2026-07-11T18:00:00Z');

async function computePipeline() {
  const route = JSON.parse(
    readFileSync(join(REPO, 'config', 'routes', 'cherbourg-plymouth.json'), 'utf8'),
  ) as Route;
  const profile = JSON.parse(
    readFileSync(join(REPO, 'config', 'profiles', 'default-limits.json'), 'utf8'),
  ) as LimitsProfile;

  const forecastBody = readFileSync(FIXTURE, 'utf8');
  const ensembleBody = readFileSync(ENSEMBLE_FIXTURE, 'utf8');
  const fakeFetch = (async (url: string | URL) =>
    new Response(String(url).includes('ensemble') ? ensembleBody : forecastBody, {
      status: 200,
    })) as unknown as typeof fetch;

  const midpoints = legMidpoints(deriveLegs(route));
  const points = midpoints.map((p) => ({ lat: p.lat, lon: p.lon }));
  const opts = { fetchFn: fakeFetch, cache: new MemoryCacheStore(), now: () => FIXED_NOW };
  const det = await fetchPointForecasts(points, '2026-07-12', '2026-07-14', opts);
  const ens = await fetchEnsembleForecasts(points, '2026-07-12', '2026-07-14', opts);

  const findings = assembleFindings({
    route,
    profile,
    departureUtc: DEPARTURE,
    legForecasts: det.forecasts,
    requestMeta: [det.meta],
    legEnsembles: ens.forecasts,
    ensembleMeta: ens.meta,
    engineVersion: ENGINE_VERSION,
    nowMs: FIXED_NOW,
  });
  const briefing = renderBriefing(findings);
  const plume = buildPlume(findings, ens.forecasts, profile.max_gust_kt);
  return { findings, briefing, plume };
}

const computeFindings = async () => (await computePipeline()).findings;

describe('findings golden (Cherbourg → Plymouth, recorded fixture)', () => {
  it('matches the checked-in golden byte for byte', async () => {
    const findings = await computeFindings();
    const serialized = JSON.stringify(findings, null, 2);

    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, serialized);
    }
    expect(serialized).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('is deterministic across runs', async () => {
    const a = JSON.stringify(await computeFindings());
    const b = JSON.stringify(await computeFindings());
    expect(a).toBe(b);
  });

  it('validates against contracts/findings.schema.json', async () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const schema = JSON.parse(
      readFileSync(join(REPO, 'contracts', 'findings.schema.json'), 'utf8'),
    );
    const validate = ajv.compile(schema);
    const findings = await computeFindings();
    expect(validate(findings), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('briefing golden: two registers, byte-stable, safe wording', async () => {
    const { briefing } = await computePipeline();
    const serialized = JSON.stringify(briefing, null, 2);
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN_BRIEFING)) {
      writeFileSync(GOLDEN_BRIEFING, serialized);
    }
    expect(serialized).toBe(readFileSync(GOLDEN_BRIEFING, 'utf8'));

    const ids = briefing.sections.map((s) => s.id);
    expect(ids).toContain('route_impact');
    expect(ids).toContain('decision');
    expect(ids).toContain('what_could_change');
    expect(ids).toContain('unsupported');
    // §6/§7 wording bans: no GO verdict, no probability/confidence claims for raw
    // fractions — the explicit DISCLAIMER "not a calibrated probability" is allowed.
    const allText = JSON.stringify(briefing)
      .toLowerCase()
      .replaceAll('not a calibrated probability', '');
    expect(allText).not.toMatch(/"[^"]*\bgo\b[^"]*":/);
    expect(allText).not.toContain('probability');
    expect(allText).not.toContain('% confidence');
    // scenario fractions phrased as "N of M forecast scenarios"
    expect(JSON.stringify(briefing)).toMatch(/\d+ of \d+ forecast scenarios exceed/);
  });

  it('ensemble: exceedance counts present, bounded, and evidenced', async () => {
    const { findings, plume } = await computePipeline();
    let sawExceedance = false;
    for (const leg of findings.legs) {
      for (const hour of leg.hours) {
        if (hour.exceedance?.gust) {
          sawExceedance = true;
          expect(hour.exceedance.gust.exceed).toBeGreaterThanOrEqual(0);
          expect(hour.exceedance.gust.exceed).toBeLessThanOrEqual(hour.exceedance.gust.total);
          expect(hour.exceedance.gust.total).toBe(51);
        }
      }
    }
    expect(sawExceedance).toBe(true);
    const ensembleEvidence = findings.evidence.filter((e) => e.source_kind === 'ensemble');
    expect(ensembleEvidence.length).toBeGreaterThan(0);
    for (const e of ensembleEvidence) {
      expect(e.member_fraction).toBeDefined();
      expect(e.rule_id).toMatch(/W-(GUST|SUST)-03/);
    }
    expect(plume.legs).toHaveLength(findings.legs.length);
    expect(plume.legs[0]!.gust_members).toHaveLength(51);
  });

  it('properties: ETA(slow) ≥ ETA(fast); occupancy hours evaluated; evidence traceable', async () => {
    const findings = await computeFindings();
    for (const leg of findings.legs) {
      expect(Date.parse(leg.eta_range.slow)).toBeGreaterThanOrEqual(Date.parse(leg.eta_range.fast));
      expect(leg.hours.length).toBeGreaterThan(0);
    }
    for (const e of findings.evidence) {
      expect(e.rule_id).toMatch(/^W-/);
      expect(e.model).toMatch(/^ecmwf_ifs025( ensemble)?$/);
      expect(e.leg_id).toMatch(/^L\d$/);
      expect(e.value).not.toBeNull();
      expect(e.limit).not.toBeNull();
    }
    if (findings.verdict.state === 'exceeds' || findings.verdict.state === 'approaching') {
      expect(findings.verdict.driver_evidence_id).not.toBeNull();
    }
    expect(findings.unsupported_hazards.length).toBeGreaterThan(0);
  });
});
