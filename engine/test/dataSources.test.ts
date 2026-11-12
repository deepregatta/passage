import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Licence registers: Passage's own feeds (config/data-sources.json) and the vendored
// forecast-tiles register, both under the vendored contracts/data-sources.schema.json.
// A value is recorded only where a file in the recording repository already states it;
// every other entry reads unconfirmed. The owner confirmed 32 sources as redistributable on
// 2026-11-12 (docs/maintenance/2026-11-12-licence-verification-proposals.md); these tests
// pin that set and check structure, they do not verify any provider's terms.
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
  notes: string | null;
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

const CONFIRMED_FORECAST_TILES = [
  'noaa-gfs', 'noaa-gefs', 'noaa-gfs-wave', 'ecmwf-open-ifs', 'cmems-glo12', 'cmems-ibi',
  'dwd-icon-eu', 'emodnet-bathymetry', 'shom-balisage', 'openstreetmap', 'protomaps-basemap', 'metoffice-ukv',
  'meteofrance-arome', 'gshhg', 'open-waters-seamap',
];
const CONFIRMED_PASSAGE = [
  'noaa-coops-tides', 'nws-marine-alerts', 'ecmwf-open-data-charts', 'era5-reanalysis',
  'copernicus-marine-currents', 'copernicus-marine-ssh-tides', 'meteofrance-marine-bulletins',
  'msq-queensland-tides', 'queensland-wave-buoys', 'bom-marine-warnings', 'metoffice-shipping-forecast',
  'meteoalarm-warnings', 'ndbc-observations', 'copernicus-insitu-observations', 'world-port-index',
  'openstreetmap-base-map', 'openseamap-seamarks',
];
// Entries recorded on the owner's decision with no provider licence statement read, or an arrangement
// with no terms in the repository: no verified date and no page.
const NO_VERIFIED_DATE = [
  'meteofrance-arome', 'ndbc-observations', 'world-port-index', 'bom-marine-warnings', 'metoffice-shipping-forecast',
];

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

  it('say yes for exactly the 32 sources the owner confirmed on 2026-11-12, and nothing else', () => {
    const yes = (register: Register) => register.sources.filter((s) => s.redistribute === 'yes').map((s) => s.id).sort();
    expect(yes(vendored)).toEqual([...CONFIRMED_FORECAST_TILES].sort());
    expect(yes(own)).toEqual([...CONFIRMED_PASSAGE].sort());
    for (const source of [...vendored.sources, ...own.sources]) {
      if (source.redistribute === 'yes') {
        expect(source.licence, source.id).toBeTruthy();
        if (NO_VERIFIED_DATE.includes(source.id)) {
          expect(source.verified_on, source.id).toBeNull();
          expect(source.verified_from, source.id).toBeNull();
        } else {
          expect(source.verified_from, source.id).toMatch(/^https:\/\//);
          expect(source.verified_on, source.id).toBe('2026-11-12');
        }
        if (source.id !== 'bom-marine-warnings' && source.id !== 'metoffice-shipping-forecast') {
          expect(source.notes, source.id).toMatch(/Confirmed by the owner on 2026-11-12\.$/);
        }
      }
    }
  });

  it('leave only the Passage tile service unconfirmed', () => {
    const rest = [...vendored.sources, ...own.sources].filter((s) => s.redistribute !== 'yes').map((s) => s.id).sort();
    expect(rest).toEqual(['forecast-tiles-service']);
  });
});
