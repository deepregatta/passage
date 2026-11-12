import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_SEPARATOR, GRIB_DATASETS, gribDataset } from '../src/export/gribDatasets.js';

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
