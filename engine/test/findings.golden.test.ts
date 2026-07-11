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
import { fetchPointForecasts, MemoryCacheStore } from '../src/fetch/openMeteo.js';
import { deriveLegs, legMidpoints } from '../src/route.js';
import { ENGINE_VERSION } from '../src/index.js';
import type { LimitsProfile, Route } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIXTURE = join(HERE, 'fixtures', 'openmeteo-forecast-cherbourg-plymouth.json');
const GOLDEN = join(HERE, 'golden', 'findings-cherbourg-plymouth.json');

const DEPARTURE = '2026-07-12T06:00:00Z';
const FIXED_NOW = Date.parse('2026-07-11T18:00:00Z');

async function computeFindings() {
  const route = JSON.parse(
    readFileSync(join(REPO, 'config', 'routes', 'cherbourg-plymouth.json'), 'utf8'),
  ) as Route;
  const profile = JSON.parse(
    readFileSync(join(REPO, 'config', 'profiles', 'default-limits.json'), 'utf8'),
  ) as LimitsProfile;

  const fixtureBody = readFileSync(FIXTURE, 'utf8');
  const fakeFetch = (async () =>
    new Response(fixtureBody, { status: 200 })) as unknown as typeof fetch;

  const midpoints = legMidpoints(deriveLegs(route));
  const { forecasts, meta } = await fetchPointForecasts(
    midpoints.map((p) => ({ lat: p.lat, lon: p.lon })),
    '2026-07-12',
    '2026-07-14',
    { fetchFn: fakeFetch, cache: new MemoryCacheStore(), now: () => FIXED_NOW },
  );

  return assembleFindings({
    route,
    profile,
    departureUtc: DEPARTURE,
    legForecasts: forecasts,
    requestMeta: [meta],
    engineVersion: ENGINE_VERSION,
    nowMs: FIXED_NOW,
  });
}

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

  it('properties: ETA(slow) ≥ ETA(fast); occupancy hours evaluated; evidence traceable', async () => {
    const findings = await computeFindings();
    for (const leg of findings.legs) {
      expect(Date.parse(leg.eta_range.slow)).toBeGreaterThanOrEqual(Date.parse(leg.eta_range.fast));
      expect(leg.hours.length).toBeGreaterThan(0);
    }
    for (const e of findings.evidence) {
      expect(e.rule_id).toMatch(/^W-/);
      expect(e.model).toBe('ecmwf_ifs025');
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
