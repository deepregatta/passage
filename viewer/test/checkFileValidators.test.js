import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkFileValidators, dateTime } from '../src/lib/generated/checkFileValidators.js';
import { makeCheck, scenarioSynoptic } from './helpers/checkFiles.js';

// The precompiled validators (scripts/generate-check-file-validators.mjs) the
// import runs on every file of a check file; `npm run check:validators` fails
// when they are stale. Ajv itself is never in the viewer: the site has no
// 'unsafe-eval'.
const require = createRequire(resolve(import.meta.dirname, '../../engine/package.json'));
const { fullFormats } = require('ajv-formats/dist/formats.js');

let check;
beforeAll(async () => { check = await makeCheck(); });

describe('the vendored date-time format', () => {
  it.each([
    '2026-07-20T06:00:00Z', '2026-07-20T06:00:00.000Z', '2026-07-20t06:00:00z', '2026-07-20 06:00:00+02:00', '2026-07-20T06:00:00-0230',
    '2024-02-29T00:00:00Z', '2023-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-07-20T24:00:00Z', '2026-07-20T06:00:00',
    '2026-07-20T06:00Z', '2026-07-20', 'yesterday', '2016-12-31T23:59:60Z', '2016-12-31T23:59:60+01:00', '2026-07-20T06:00:00+24:00', '',
  ])('reads %j as ajv-formats does', (value) => {
    expect(dateTime(value)).toBe(fullFormats['date-time'].validate(value));
  });
});

describe('the validators', () => {
  it('accept every file of a real check', () => {
    for (const [name, text] of Object.entries(check.files)) {
      const validate = checkFileValidators[name];
      if (!validate) { expect(name).toBe('decision-inputs.json'); continue; }
      expect(validate(JSON.parse(text)), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it.each(['reference-demo', 'storm'])('accept the %s scenario synoptic, which has no route_transitions (the one documented tolerance)', (scenario) => {
    const synoptic = scenarioSynoptic(scenario);
    expect(synoptic.route_transitions).toBeUndefined();
    expect(checkFileValidators['synoptic.json'](synoptic)).toBe(true);
    expect(checkFileValidators['synoptic.json']({ ...synoptic, systems: 'none' })).toBe(false);
  });

  it.each([
    ['snapshot.json', (m) => ({ ...m, created_at: 'yesterday' })],
    ['snapshot.json', (m) => ({ ...m, artifacts: 'all' })],
    ['findings.json', (f) => ({ ...f, legs: 'many' })],
    ['findings.json', (f) => ({ ...f, verdict: { ...f.verdict, state: 42 } })],
    ['briefing.json', (b) => ({ ...b, sections: {} })],
    ['route.json', (r) => ({ ...r, waypoints: [{ lat: 'north', lon: 0 }] })],
    ['plume.json', (p) => ({ ...p, schema_version: 2 })],
  ])('refuse a %s of the wrong shape', (name, change) => {
    expect(checkFileValidators[name](change(JSON.parse(check.files[name])))).toBe(false);
  });
});
