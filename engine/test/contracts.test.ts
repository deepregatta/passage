import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildFixtureRun } from './helpers/fixtureRun.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = join(HERE, '..', '..', 'contracts');
const CONFIG_DIR = join(HERE, '..', '..', 'config');

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, name), 'utf8'));
}

describe('contracts', () => {
  it('accepts saved routed timing and rejects missing or nonpositive durations', () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(loadSchema('route.schema.json'));
    const route = JSON.parse(readFileSync(join(HERE, 'fixtures/routes/routed-current.json'), 'utf8'));
    expect(validate(route), JSON.stringify(validate.errors)).toBe(true);
    const legacy = structuredClone(route);
    delete legacy.timing;
    expect(validate(legacy)).toBe(true);
    for (const bad of [0, -1, null]) {
      const invalid = structuredClone(route);
      invalid.timing.legs[0].duration_ms.nominal = bad;
      expect(validate(invalid)).toBe(false);
    }
    delete route.timing.departure_utc;
    expect(validate(route)).toBe(false);
  });

  it('every schema compiles under JSON Schema 2020-12', () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const files = readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith('.schema.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const schema = loadSchema(file);
      expect(() => ajv.compile(schema), `${file} should compile`).not.toThrow();
    }
  });

  describe('forecast latest.json', () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(loadSchema('forecast-latest.schema.json'));
    const entry = (layer: string, cycle: string, extra: object = {}) => ({
      run_id: `${layer}-${cycle}Z`,
      previous_run_id: null,
      cycle: `${cycle.slice(0, 4)}-${cycle.slice(4, 6)}-${cycle.slice(6, 8)}T${cycle.slice(9)}:00Z`,
      member_count: 1,
      published_at: '2026-09-29T10:02:11Z',
      ...extra,
    });
    // the shape forecast-tiles publishes from Phase 5C: every live layer, cadence_hours per
    // layer, and ECMWF's 06Z/18Z runs as their own short-range layer
    const published = {
      schema_version: 1,
      updated_at: '2026-09-29T11:15:40Z',
      layers: {
        ...Object.fromEntries(
          (['weather', 'ensemble', 'waves'] as const).map((layer) => [layer, entry(layer, '20260929T00', { cadence_hours: 6 })]),
        ),
        'weather-ecmwf': entry('weather-ecmwf', '20260929T00', { cadence_hours: 12 }),
        'weather-ecmwf-short': entry('weather-ecmwf-short', '20260929T06', { cadence_hours: 12 }),
        currents: entry('currents', '20260929T00', { cadence_hours: 24 }),
        'currents-ibi': entry('currents-ibi', '20260929T00', { cadence_hours: 24 }),
      } as Record<string, ReturnType<typeof entry>>,
    };

    it('accepts the published shape, and runs from before cadence_hours', () => {
      expect(validate(published), JSON.stringify(validate.errors)).toBe(true);
      const before = structuredClone(published);
      for (const layer of Object.values(before.layers)) delete (layer as { cadence_hours?: number }).cadence_hours;
      expect(validate(before), JSON.stringify(validate.errors)).toBe(true);
    });

    it('accepts the fixture runs the store tests are built from', () => {
      const transport = buildFixtureRun([{
        layer: 'weather', model: 'gfs_0p25', cycle: '2026-07-20T00:00Z', resolution_deg: 1,
        time_axes: { hourly: { base: '2026-07-20T00:00Z', offsets_h: [0, 1] } },
        variables: [{ name: 'wind_u_kt', axis: 'hourly', dtype: 'i16', scale: 0.01, value: () => 1 }],
        tiles: [[40, -10]],
      }]);
      transport.latest.layers.weather!.cadence_hours = 6;
      expect(validate(transport.latest), JSON.stringify(validate.errors)).toBe(true);
    });

    it.each([0, -6, 1.5, '6'])('rejects cadence_hours %j', (cadence) => {
      const doc = structuredClone(published);
      (doc.layers.weather as Record<string, unknown>).cadence_hours = cadence;
      expect(validate(doc)).toBe(false);
    });

    it('rejects a layer name no producer publishes', () => {
      const doc = structuredClone(published);
      (doc.layers as Record<string, unknown>)['weather-gfs'] = entry('weather-gfs', '20260929T00');
      expect(validate(doc)).toBe(false);
    });
  });

  for (const [directory, schemaName] of [
    ['routes', 'route'], ['profiles', 'limits-profile'], ['polars', 'polar'],
  ]) {
    const files = readdirSync(join(CONFIG_DIR, directory!)).filter(file => file.endsWith('.json') && file !== 'index.json');
    it(`${directory} corpus is nonempty`, () => expect(files.length).toBeGreaterThan(0));
    for (const file of files) {
      it(`${directory}/${file} validates`, () => {
        const ajv = new Ajv2020({ strict: false });
        addFormats(ajv);
        const validate = ajv.compile(loadSchema(`${schemaName}.schema.json`));
        const value = JSON.parse(readFileSync(join(CONFIG_DIR, directory!, file), 'utf8'));
        expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
      });
    }
  }
});
