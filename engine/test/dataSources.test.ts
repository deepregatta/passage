import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Licence registers: Passage's own feeds (config/data-sources.json) and the vendored
// forecast-tiles register, both under the vendored contracts/data-sources.schema.json.
// A value is recorded only where a file in the recording repository already states it;
// every other entry reads unconfirmed. No licence is verified by these tests.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

interface Source {
  id: string;
  used_by: string[];
  recorded_in: string[];
  redistribute: string;
  licence: string | null;
  verified_on: string | null;
  verified_from: string | null;
  attribution: string | null;
  [key: string]: unknown;
}
interface Register { schema_version: number; sources: Source[] }

const schema = read('contracts/data-sources.schema.json');
const own: Register = read('config/data-sources.json');
const vendored: Register = read('contracts/forecast-tiles-data-sources.json');
const providers: { providers: Record<string, unknown> } = read('config/providers.json');

// Inputs that are not feeds in config/providers.json but are shown on the About page.
const EXTRA_USERS = ['port_index', 'basemap_osm', 'seamarks_openseamap'];

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

describe('data-source registers', () => {
  it('compile the schema and validate both registers against it', () => {
    expect(validate(own), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(vendored), JSON.stringify(validate.errors)).toBe(true);
  });

  it('list every feed in config/providers.json in some entry used_by', () => {
    const used = new Set(own.sources.flatMap((source) => source.used_by));
    const missing = Object.keys(providers.providers).filter((feed) => !used.has(feed));
    expect(missing, `feeds with no config/data-sources.json entry: ${missing}`).toEqual([]);
  });

  it('use only known feed ids, and every extra input is used', () => {
    const known = new Set([...Object.keys(providers.providers), ...EXTRA_USERS]);
    const unknown = own.sources.flatMap((s) => s.used_by.filter((u) => !known.has(u)).map((u) => `${s.id}:${u}`));
    expect(unknown).toEqual([]);
    const used = new Set(own.sources.flatMap((source) => source.used_by));
    expect(EXTRA_USERS.filter((id) => !used.has(id))).toEqual([]);
  });

  it('have unique entry ids within and across the two registers', () => {
    const ids = [...own.sources, ...vendored.sources].map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cite files that exist in this repository for every recorded value', () => {
    for (const source of own.sources) {
      for (const path of source.recorded_in) {
        expect(existsSync(join(ROOT, path)), `${source.id}: ${path}`).toBe(true);
      }
    }
  });

  it('record no verified date and no yes/no answer without a cited file', () => {
    for (const source of [...own.sources, ...vendored.sources]) {
      if (source.verified_on !== null || source.redistribute !== 'unconfirmed') {
        expect(source.recorded_in.length, source.id).toBeGreaterThan(0);
        expect(source.licence, source.id).toBeTruthy();
      }
    }
  });

  it.each([
    ['yes without a licence', (s: Source) => Object.assign(s, { redistribute: 'yes', licence: null })],
    ['an unknown redistribute value', (s: Source) => Object.assign(s, { redistribute: 'maybe' })],
    ['a verified date without its source', (s: Source) => Object.assign(s, { verified_on: '2026-11-11', verified_from: null })],
    ['a malformed date', (s: Source) => Object.assign(s, { verified_on: '11 November 2026' })],
    ['a value with no cited file', (s: Source) => Object.assign(s, { attribution: 'Someone', recorded_in: [] })],
    ['an entry used by nothing', (s: Source) => Object.assign(s, { used_by: [] })],
    ['an unknown property', (s: Source) => Object.assign(s, { unexpected: 1 })],
  ])('schema rejects %s', (_label, mutate) => {
    const doc: Register = structuredClone(own);
    mutate(doc.sources.find((source) => source.id === 'era5-reanalysis')!);
    expect(validate(doc)).toBe(false);
  });
});
