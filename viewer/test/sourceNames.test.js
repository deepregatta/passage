import { describe, expect, it } from 'vitest';
import { layerName, modelName, runLabel } from '../src/lib/sourceNames.js';

describe('modelName', () => {
  it.each([
    ['gfs_0p25', 'GFS 0.25°'],
    ['ecmwf_ifs_0p25', 'ECMWF IFS 0.25°'],
    ['gefs_0p50', 'GEFS ensemble 0.5°'],
    ['cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', 'Copernicus IBI ocean currents'],
    ['cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i', 'Copernicus global ocean currents'],
    ['scenario', 'Scenario set (emulated)'],
    ['scenario ensemble', 'Scenario set (emulated)'],
    ['official bulletin', 'official bulletin'],
    [null, 'n/a'],
  ])('%s -> %s', (id, name) => expect(modelName(id)).toBe(name));

  it('names every model in a recorded list once', () => {
    expect(modelName('gfs_0p25,ecmwf_ifs_0p25')).toBe('GFS 0.25°, ECMWF IFS 0.25°');
    expect(modelName('gfs_0p25/icon_eu/gfs_global')).toBe('GFS 0.25°, DWD ICON-EU, GFS');
  });

  it('cleans up unknown ids instead of showing them raw', () => {
    expect(modelName('mystery_model_0p10')).toBe('Mystery model 0.10°');
  });
});

describe('layerName', () => {
  it('maps layers to the product and cleans unknown ones', () => {
    expect(layerName('weather')).toBe('Wind and gusts');
    expect(layerName('weather-ecmwf-short')).toBe('Additional weather model');
    expect(layerName('new-layer')).toBe('New layer');
  });
});

describe('runLabel', () => {
  it.each([
    ['weather-20261110T12Z', undefined, 'GFS run 10 Nov 12Z'],
    ['weather-ecmwf-short-20261001T06Z', undefined, 'ECMWF run 1 Oct 06Z'],
    ['ecmwf-ifs025-20260916T00Z', undefined, 'ECMWF run 16 Sep 00Z'],
    ['20261110T12Z', { layer: 'ensemble' }, 'GEFS run 10 Nov 12Z'],
    ['20261110T12Z', undefined, 'Run 10 Nov 12Z'],
    ['scenario-74bece95', undefined, 'Emulated scenario run'],
    ['reference-demo-20260719T18Z', undefined, 'Reference demo run 19 Jul 18Z'],
    ['some_odd-run', undefined, 'Some odd run'],
  ])('%s -> %s', (id, context, label) => expect(runLabel(id, context)).toBe(label));
});
