import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeTile } from '../src/forecast/tileCodec.js';
import { ATTRIBUTION_SEPARATOR, GRIB_DATASETS, gribDataset, type GribDatasetId } from '../src/export/gribDatasets.js';
import { gribCreditPayload, gribCreditSectionBytes, gribCreditText } from '../src/export/gribCredit.js';
import { planGribExport } from '../src/export/exportPlan.js';
import { runGribExport } from '../src/export/exportGrib.js';
import { buildFixtureRun, type FixtureLayerSpec } from './helpers/fixtureRun.js';
import { expectedCreditSectionBytes, expectedCreditText } from './helpers/gribCreditText.js';
import { readGrib2, withoutSection2 } from './helpers/grib2Reader.js';
import { buildGribFixtures, concat, GRIB_FIXTURES, readCommittedFixture, type GribFixture } from './helpers/gribFixtures.js';

// The credit lines shown under "Data sources:" on the GRIB files page. The recorded terms
// (forecast-tiles/DATA-LICENSES.md, docs/maintenance/2026-11-12-credit-audit.md) ask for the
// provider's own sentence, the licence link and a statement that the data were modified.
const text = (id: string) => gribDataset(id)!.attribution;
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';

const SENTENCE = 'This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF)';
const COPERNICUS = 'Generated using E.U. Copernicus Marine Service Information';
const MODIFIED = 'modified: converted and quantized data';
const UKV_LINE = 'British Crown copyright 2023–2025, Met Office UKV via Open-Meteo; CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); native CRS corrected, remapped and quantized data';
const shape = (id: string) => gribDataset(id)!.attributionParts!.map((part) => [part.text, part.verbatim]);

describe('GRIB page credit lines', () => {
  it('credits ECMWF with its service sentence, source, licence link and a modification statement', () => {
    expect(text('wind-ecmwf')).toBe(`${SENTENCE}; ECMWF open data; CC BY 4.0 (${CC_BY}); ${MODIFIED}`);
  });

  it('gives each Copernicus Marine product its own DOI, with the credit sentence and a modification statement', () => {
    expect(text('currents-global')).toBe(`${COPERNICUS}; doi:10.48670/moi-00016; ${MODIFIED}`);
    expect(text('currents-ibi')).toBe(`${COPERNICUS}; doi:10.48670/moi-00027; ${MODIFIED}`);
  });

  it.each([
    ['wind-icon-eu', 'Deutscher Wetterdienst ICON-EU via Open-Meteo'],
    ['wind-arome', 'Météo-France AROME via Open-Meteo'],
  ])('adds the licence link and a modification statement to %s', (id, credit) => {
    expect(text(id)).toBe(`${credit}; CC BY 4.0 (${CC_BY}); ${MODIFIED}`);
  });

  it('leaves the NOAA and UKV lines as they were', () => {
    expect(text('wind-gfs')).toBe('NOAA/NCEP');
    expect(text('waves-gfs')).toBe('NOAA/NCEP');
    expect(text('wind-ukv')).toBe(UKV_LINE);
    expect(gribDataset('wind-gfs')!.attributionParts).toBeUndefined();
  });

  it('marks only what a provider prescribes as verbatim: its credit sentence, DOI, copyright statement, licence name and link', () => {
    expect(shape('wind-ecmwf')).toEqual([[SENTENCE, true], ['ECMWF open data', false], [`CC BY 4.0 (${CC_BY})`, true], [MODIFIED, false]]);
    for (const [id, doi] of [['currents-global', 'doi:10.48670/moi-00016'], ['currents-ibi', 'doi:10.48670/moi-00027']] as const) {
      expect(shape(id), id).toEqual([[COPERNICUS, true], [doi, true], [MODIFIED, false]]);
    }
    expect(shape('wind-icon-eu')).toEqual([['Deutscher Wetterdienst ICON-EU via Open-Meteo', false], [`CC BY 4.0 (${CC_BY})`, true], [MODIFIED, false]]);
    expect(shape('wind-arome')).toEqual([['Météo-France AROME via Open-Meteo', false], [`CC BY 4.0 (${CC_BY})`, true], [MODIFIED, false]]);
    expect(shape('wind-ukv')).toEqual([
      ['British Crown copyright 2023–2025', true], ['Met Office UKV via Open-Meteo', false],
      ['CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)', true], ['native CRS corrected, remapped and quantized data', false],
    ]);
  });

  it('builds the one-string line from its parts, with each part’s own separator', () => {
    for (const dataset of GRIB_DATASETS.filter((item) => item.attributionParts)) {
      const parts = dataset.attributionParts!;
      const joined = parts.map((part, index) => part.text + (index < parts.length - 1 ? part.then ?? ATTRIBUTION_SEPARATOR : '')).join('');
      expect(joined, dataset.id).toBe(dataset.attribution);
    }
  });

  it('never carries the internal codename', () => {
    for (const dataset of GRIB_DATASETS) expect(dataset.attribution.toLowerCase()).not.toContain('deepweather');
  });
});

// Section 2 of every exported GRIB message (docs/grib-export.md → Credits inside the file).
const expectedText = expectedCreditText;
const ECMWF_LINE = `${SENTENCE}; ECMWF open data; CC BY 4.0 (${CC_BY}); ${MODIFIED}`;
const CREDIT_BY_DATASET: Record<GribDatasetId, string> = {
  'wind-ecmwf': ECMWF_LINE,
  'wind-gfs': 'NOAA/NCEP',
  'waves-gfs': 'NOAA/NCEP',
  'currents-global': `${COPERNICUS}; doi:10.48670/moi-00016; ${MODIFIED}`,
  'currents-ibi': `${COPERNICUS}; doi:10.48670/moi-00027; ${MODIFIED}`,
  'wind-icon-eu': `Deutscher Wetterdienst ICON-EU via Open-Meteo; CC BY 4.0 (${CC_BY}); ${MODIFIED}`,
  'wind-arome': `Météo-France AROME via Open-Meteo; CC BY 4.0 (${CC_BY}); ${MODIFIED}`,
  'wind-ukv': UKV_LINE,
};
const utf8 = new TextDecoder('utf-8', { fatal: true });

describe('GRIB file credit section (Section 2)', () => {
  it('writes the ECMWF credit, its licence and the modification statement as four UTF-8 lines', () => {
    expect(gribCreditText(gribDataset('wind-ecmwf')!)).toBe(
      'Passage by DeepRegatta: data credit and licence. UTF-8 text added by Passage, not by the originating centre.\n' +
      'Data sources: This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF); ' +
      'ECMWF open data; CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); modified: converted and quantized data\n' +
      'This GRIB message was produced by Passage by DeepRegatta from that data and modified; it is not an official product of the data provider.\n' +
      'Forecast data for planning, not for navigation. Check official forecasts and warnings.\n',
    );
  });

  it('carries the UKV Crown copyright, CC BY-SA 4.0 label and link, and its modification notice, as written', () => {
    const payload = gribCreditPayload(gribDataset('wind-ukv')!);
    const text = utf8.decode(payload.subarray(2));
    expect(text).toBe(expectedText(UKV_LINE));
    expect(text).toContain('British Crown copyright 2023–2025');
    expect(text).toContain('CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)');
    expect(text).toContain('native CRS corrected, remapped and quantized data');
    // The en dash is one UTF-8 character, not folded to ASCII.
    expect([...payload]).toEqual(expect.arrayContaining([0xe2, 0x80, 0x93]));
  });

  it.each(GRIB_DATASETS.map((dataset) => dataset.id))('%s: local section number 0, then the text, nothing else', (id) => {
    const spec = gribDataset(id)!;
    const payload = gribCreditPayload(spec);
    // ecCodes reads these two bytes as the centre's local definition number: 0 = empty local section.
    expect([payload[0], payload[1]]).toEqual([0, 0]);
    const text = utf8.decode(payload.subarray(2));
    expect(text).toBe(expectedText(CREDIT_BY_DATASET[id]));
    // No control character other than the line feed.
    expect([...text].filter((c) => c !== '\n' && (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))).toEqual([]);
    expect(text.toLowerCase()).not.toContain('deepweather');
    expect(gribCreditSectionBytes(spec)).toBe(expectedCreditSectionBytes(CREDIT_BY_DATASET[id]));
  });

  it('is deterministic: the same dataset gives the same bytes', () => {
    for (const dataset of GRIB_DATASETS) {
      const again = gribCreditPayload({ attribution: `${dataset.attribution}` });
      expect([...again]).toEqual([...gribCreditPayload(dataset)]);
    }
  });
});

const CYCLE = '2026-07-20T00:00Z';
const OFFSETS = [0, 1, 2, 3];

/** One exported file of the dataset, from a small fixture run of its own layer, as the browser writes it. */
async function exportedFile(id: GribDatasetId, creditSection = true): Promise<Uint8Array> {
  const spec = gribDataset(id)!;
  const layer: FixtureLayerSpec = {
    layer: spec.layer, model: spec.id, cycle: CYCLE, resolution_deg: 0.25, pointsPerSide: 8,
    time_axes: { steps: { base: CYCLE, offsets_h: OFFSETS } },
    variables: spec.variables.map((variable, v) => ({
      name: variable.tileVar, axis: 'steps', dtype: 'i16' as const, scale: 0.01,
      ...(variable.statistic ? { statistic: { kind: 'max' as const, window_h: [null, 1, 1, 1] } } : {}),
      // A land point when the dataset has land; no gust window at step 0.
      value: (_m: number, t: number, i: number, j: number) =>
        (spec.hasLand && i === 2 && j === 2) || (variable.statistic && t === 0) ? NaN : 3 + v + 0.1 * i - 0.05 * j + t,
    })),
    tiles: [[40, -10]],
  };
  const transport = buildFixtureRun([layer]);
  const manifest = [...transport.manifests.values()][0]!;
  // Regional layers (UKV, AROME, ICON-EU) also need a coverage box and tile size metadata.
  manifest.coverage = { minLat: 40, maxLat: 41.75, minLon: -10, maxLon: -8.25 };
  for (const tile of Object.values(manifest.tiles)) Object.assign(tile, { uncompressed_bytes: 4096, decoded_bytes: 4096 });
  const plan = planGribExport({ [spec.layer]: manifest }, {
    bbox: { minLat: 40.5, maxLat: 41.25, minLon: -9.5, maxLon: -8.75 }, datasetIds: [id],
    startIso: CYCLE, endIso: '2026-07-20T03:00Z', step: 'all', lonConvention: '0-360', creditSection,
  });
  expect(plan.datasets[0]!.availability, id).toBe('ok');
  const source = {
    tile: async (_layer: string, tileId: string) => {
      const bytes = transport.tiles.get(`${manifest.run_id}/${manifest.tiling.path_template.replace('{tile_id}', tileId)}`);
      return bytes ? decodeTile(new Uint8Array(gunzipSync(bytes))) : null;
    },
  };
  const [file] = await runGribExport(source, plan);
  expect(file!.bytes).toBe(concat(file!.parts).byteLength);
  if (creditSection) {
    // The estimate counts Section 2 in every message (bit widths differ from the fixture's).
    expect(plan.datasets[0]!.estBytes).toBeGreaterThanOrEqual(file!.messages * gribCreditSectionBytes(spec));
  }
  return concat(file!.parts);
}

describe('exported GRIB files with creditSection carry the credit in every message', () => {
  it.each(GRIB_DATASETS.map((dataset) => [dataset.id, dataset.centre] as const))('%s (centre %i)', async (id, centre) => {
    const bytes = await exportedFile(id);
    const messages = readGrib2(bytes);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.centre).toBe(centre);
      expect(message.sections.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect([message.localUse![0], message.localUse![1]]).toEqual([0, 0]);
      expect(utf8.decode(message.localUse!.subarray(2))).toBe(expectedText(CREDIT_BY_DATASET[id]));
    }
    // ECMWF, AROME and ICON-EU gust messages (template 4.8) and land bitmaps carry it too.
    if (gribDataset(id)!.variables.some((v) => v.statistic)) expect(messages.some((m) => m.product.template === 8)).toBe(true);
    if (gribDataset(id)!.hasLand) expect(messages.some((m) => m.bitmapIndicator === 0)).toBe(true);
    // Same input, same bytes.
    expect([...(await exportedFile(id))]).toEqual([...bytes]);
    // The default export (what the page and the CLI write today) has no Section 2 and otherwise the same bytes.
    const plain = await exportedFile(id, false);
    expect(readGrib2(plain).every((message) => message.localUse === undefined)).toBe(true);
    expect([...plain]).toEqual([...withoutSection2(bytes)]);
  });
});

describe('golden GRIB fixtures with Section 2 added', () => {
  let built: GribFixture[];
  beforeAll(async () => {
    built = await buildGribFixtures({ creditSection: true });
  });

  // The committed goldens are the default export, without Section 2. With the
  // credit section, everything outside Section 2 and the Section 0 total length
  // must still be exactly the committed bytes.
  it.each(GRIB_FIXTURES.map((f) => f.name))('%s: sections 0, 1 and 3–8 match the committed file', (name) => {
    const fixture = built.find((f) => f.name === name)!;
    const committed = readCommittedFixture(name);
    expect(Buffer.from(withoutSection2(fixture.bytes)).equals(Buffer.from(withoutSection2(committed.bytes)))).toBe(true);
    const messages = readGrib2(fixture.bytes);
    expect(messages).toHaveLength(committed.expected.messages.length);
    const before = readGrib2(withoutSection2(committed.bytes));
    messages.forEach((message, m) => {
      expect(message.localUse, `${name} #${m}`).toBeDefined();
      expect(Array.from(message.values)).toEqual(Array.from(before[m]!.values));
    });
    const s2 = messages.reduce((sum, message) => sum + message.sections.find((s) => s.number === 2)!.length, 0);
    expect(fixture.bytes.byteLength).toBe(withoutSection2(committed.bytes).byteLength + s2);
    expect(fixture.expected.messages).toEqual(committed.expected.messages);
  });
});
