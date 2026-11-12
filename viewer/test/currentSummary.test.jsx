import { render, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { routeSummary } from '@deepweather/engine';
import CurrentSummary from '../src/pages/briefing/CurrentSummary.jsx';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import { CURRENT_CAVEATS, CURRENT_DISCLAIMER, currentSource, currentSummaryEmulated, currentSummaryLines } from '../src/lib/currentSummaryLines.js';
import { fmtTextTime } from '../src/lib/format.js';
import { currentModelFamily, modelName } from '../src/lib/sourceNames.js';
import compatibilityFindings from './fixtures/compatibility/20260720T060000Z_44d2cd5f_4196266b/findings.json';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DISCLAIMER = 'Not an official tidal-stream prediction.';
const DISCLAIMER_FR = 'Ce n’est pas une prédiction officielle des courants de marée.';
// The disclaimer is the one permitted use of the term: the block never calls its own values a tidal stream.
const FORBIDDEN_EN = /tidal|probabilit|chance|likel|odds|%|deepweather/i;
const FORBIDDEN_FR = /de marée|probabilit|chance|probable|%|deepweather/i;
const GLO12_TILES = { source: 'tiles', layer: 'currents', model: 'cmems_glo12 tiles (currents-20260720T00Z)', run_id: 'currents-20260720T00Z', mode: 'live', current_source: 'tiles' };
const IBI_PREPARED = { source: 'prepared-artifact', layer: 'currents', model: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', run_id: 'cmems-ibi-20260719T19Z', current_source: 'prepared' };

// A smooth along-course current, hour by hour (a made-up test signal, not a tide model).
const alongAt = (t) => Math.round((1.4 * Math.sin((2 * Math.PI * t) / (12.4 * HOUR)) + 0.3) * 100) / 100;
const speedAt = (t) => Math.round((Math.abs(alongAt(t)) + 0.4) * 100) / 100;

/** The demo passage's saved findings with a current value at every audited hour and the given record. */
function withCurrent(record = GLO12_TILES, { wac = (t) => (t / HOUR) % 5 === 0, missing = [], speed = speedAt } = {}) {
  const findings = structuredClone(savedFindings);
  findings.inputs.forecast_tiles = [...findings.inputs.forecast_tiles.filter((item) => item.layer !== 'currents'), ...(record ? [record] : [])];
  for (const [legIndex, leg] of findings.legs.entries()) {
    for (const hour of leg.hours) {
      const t = Date.parse(hour.valid_time);
      hour.current = missing.includes(hour.valid_time) ? null : {
        u_kt: alongAt(t), v_kt: 0.4, speed_kt: speed(t, legIndex), set_deg: 120, along_kt: alongAt(t), cross_kt: 0.4,
        wind_against_current: wac(t, legIndex),
      };
    }
  }
  return findings;
}

/** Independent reading: walk the passage minute by minute, hour by hour, and every audited hour, without the engine. */
function independentReading(findings) {
  const legs = findings.legs;
  const legAt = (t) => legs.find((l) => t >= Date.parse(l.enter_range.nominal) && t < Date.parse(l.eta_range.nominal));
  // gain: each minute of a leg's expected time at the along current interpolated between the leg's hourly samples
  let nm = 0;
  for (const leg of legs) {
    for (let t = Date.parse(leg.enter_range.nominal); t < Date.parse(leg.eta_range.nominal); t += MINUTE) {
      const mid = t + MINUTE / 2;
      const h0 = Math.floor(mid / HOUR) * HOUR;
      const a = leg.hours.find((h) => Date.parse(h.valid_time) === h0).current.along_kt;
      const b = leg.hours.find((h) => Date.parse(h.valid_time) === h0 + HOUR).current.along_kt;
      const end = Math.min(t + MINUTE, Date.parse(leg.eta_range.nominal));
      nm += (a + (b - a) * (mid - h0) / HOUR) * (end - t) / HOUR;
    }
  }
  // wind against current on the expected timing: each whole hour, in the leg whose expected window holds it
  let wac = 0;
  let hours = 0;
  const start = Date.parse(legs[0].enter_range.nominal);
  const end = Date.parse(legs.at(-1).eta_range.nominal);
  for (let t = Math.ceil(start / HOUR) * HOUR; t < end; t += HOUR) {
    hours += 1;
    if (legAt(t).hours.find((h) => Date.parse(h.valid_time) === t).current.wind_against_current) wac += 1;
  }
  // strongest: every audited hour of every leg (the arrival range); flagged instants counted once
  let strongest = null;
  const flagged = new Set();
  for (const [index, leg] of legs.entries()) {
    for (const h of leg.hours) {
      const t = Date.parse(h.valid_time);
      if (h.current.wind_against_current) flagged.add(t);
      if (!strongest || h.current.speed_kt > strongest.speed || (h.current.speed_kt === strongest.speed && t < strongest.t)) strongest = { speed: h.current.speed_kt, t, legNumber: index + 1 };
    }
  }
  return { nm, strongest, wac, flagged: flagged.size, hours };
}

const lineTexts = (container) => [...container.querySelectorAll('[data-testid="current-summary"] [data-line]')].map((node) => node.textContent);
const modelLine = (container) => container.querySelector('[data-testid="current-model"]').textContent;
const headingStamped = (container) => container.querySelector('[data-testid="current-summary"] h3 .stamp-emulated') !== null;
const wacStamped = (container) => container.querySelector('[data-testid="current-wac"] .stamp-emulated') !== null;
const view = (findings) => render(<CurrentSummary findings={findings} />).container;

it('renders nothing for the saved demo passage, which has no current data', () => {
  expect(savedFindings.legs.flatMap((leg) => leg.hours).some((hour) => hour.current)).toBe(false);
  expect(view(structuredClone(savedFindings)).innerHTML).toBe('');
  expect(view(structuredClone(compatibilityFindings)).innerHTML).toBe('');
  expect(view(null).innerHTML).toBe('');
  expect(currentSummaryLines(null)).toEqual([]);
});

it('shows gain, strongest current and wind-against-current hours with the numbers of an independent reading', () => {
  const findings = withCurrent();
  const expected = independentReading(findings);
  // the reading is not trivial: a real gain, some flagged hours, and the same hour total as the C2 block
  expect(Math.abs(expected.nm)).toBeGreaterThan(1);
  expect(expected.wac).toBeGreaterThan(0);
  expect(expected.hours).toBe(routeSummary(findings).total_hours);
  const container = view(findings);
  expect(container.querySelector('h3').textContent).toContain('Current along your route');
  expect(modelLine(container)).toBe('Currents · Copernicus global ocean currents');
  expect(lineTexts(container)).toEqual([
    'The model current at the points checked along your passage, on the expected timing.',
    `Distance ${expected.nm > 0 ? 'gained from' : 'lost to'} the current: ${Math.abs(expected.nm).toFixed(1)} nm`,
    'An estimate from one current value per leg, at its midpoint, over the leg’s expected time.',
    `Strongest current at the points checked, anywhere in your arrival range: ${expected.strongest.speed.toFixed(1)} kt at the midpoint of leg ${expected.strongest.legNumber} around ${fmtTextTime(new Date(expected.strongest.t).toISOString())}.`,
    `Wind against current on the expected timing: ${expected.wac} h`,
    '6-hourly ocean-model currents. Tides are not resolved.',
    DISCLAIMER,
  ]);
  expect(container.textContent.replace(DISCLAIMER, '')).not.toMatch(FORBIDDEN_EN);
  // no hours with or against the current: no saved record shows a tide-resolving source
  expect(container.textContent).not.toMatch(/with the current|against the current/i);
});

it('writes the same block in French, with nd for knots and M for nautical miles', async () => {
  const findings = withCurrent();
  const expected = independentReading(findings);
  const en = render(<CurrentSummary findings={structuredClone(findings)} />);
  const english = lineTexts(en.container);
  en.unmount();
  const { container } = render(<div id="root"><CurrentSummary findings={findings} /><LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(container.querySelector('h3').textContent).toContain('Courant le long de votre route'));
  const nm = Math.abs(expected.nm).toFixed(1).replace('.', ',');
  const speed = expected.strongest.speed.toFixed(1).replace('.', ',');
  expect(modelLine(container)).toBe('Courants · Courants océaniques mondiaux Copernicus');
  const texts = lineTexts(container);
  expect(texts[0]).toBe('Le courant du modèle aux points vérifiés le long de votre traversée, selon l’horaire prévu.');
  expect(texts[1]).toBe(`${expected.nm > 0 ? 'Distance gagnée grâce au courant' : 'Distance perdue à cause du courant'}\u00A0: ${nm} M`);
  expect(texts[2]).toBe('Estimation à partir d’une valeur de courant par tronçon, prise en son milieu, sur la durée prévue du tronçon.');
  expect(texts[3]).toMatch(new RegExp(`^Courant le plus fort aux points vérifiés, sur toute votre fenêtre d’arrivée estimée\u00A0: ${speed} nd au milieu du tronçon ${expected.strongest.legNumber} vers (lun|mar|mer|jeu|ven|sam|dim)\\. \\d+ juil\\. \\d{2}:\\d{2}\\.$`));
  expect(texts[4]).toBe(`Vent contre courant selon l’horaire prévu\u00A0: ${expected.wac} h`);
  expect(texts[5]).toBe('Courants d’un modèle océanique, toutes les 6 h. La marée n’est pas résolue.');
  // the disclaimer reuses the IBI GRIB note's existing French sentence verbatim
  expect(texts[6]).toBe(DISCLAIMER_FR);
  expect(translateText('Hourly regional model currents including tide. Not an official tidal-stream prediction.', 'fr')).toContain(DISCLAIMER_FR);
  expect(texts).toEqual(english.map((text) => translateText(text, 'fr')));
  expect(container.textContent.replace(DISCLAIMER_FR, '')).not.toMatch(FORBIDDEN_FR);
  expect(container.textContent).not.toMatch(/\bkt\b|\bnm\b/);
});

it('never shows a strongest current below the check\'s own wind-against-current evidence', () => {
  // a 3.1 kt flagged hour only in the slow arrival range of leg 3 (16:00 lies after its expected end, 15:02)
  const slow = '2026-07-20T16:00:00Z';
  const findings = withCurrent(GLO12_TILES, {
    speed: (t, leg) => (leg === 2 && t === Date.parse(slow) ? 3.1 : 1.2),
    wac: (t, leg) => leg === 2 && t === Date.parse(slow),
  });
  findings.evidence.push({ evidence_id: 'E99', rule_id: 'T-WAC-01', model: 'cmems_glo12', run: null, leg_id: 'L3', valid_time: slow, value: '3.1 kt set 120° vs wind 20 kt from 300°', limit: null, units: null, source_kind: 'currents' });
  const texts = lineTexts(view(findings));
  const strongest = texts.find((text) => text.startsWith('Strongest current'));
  expect(Number(/: ([\d.]+) kt/.exec(strongest)[1])).toBeGreaterThanOrEqual(3.1);
  expect(strongest).toContain('at the midpoint of leg 3');
  expect(texts).toContain('Wind against current: none on the expected timing, but it occurs at other times in your arrival range (1 h).');
  expect(texts.some((text) => text.startsWith('Wind against current on the expected timing'))).toBe(false);
});

it('words wind against current on the expected timing, at other times only, from the hazard alone, and leaves it out when nothing is flagged', () => {
  const base = { total_hours: 10, unavailable_hours: 0, gain: null, strongest: null };
  const wacLine = (summary, options) => currentSummaryLines({ ...base, ...summary }, options).find((line) => line.key === 'wac');
  expect(wacLine({ wind_against_current_hours: 2, wind_against_current_arrival_hours: 5 }).text).toBe('Wind against current on the expected timing: 2 h');
  expect(wacLine({ wind_against_current_hours: 0, wind_against_current_arrival_hours: 3 }).text)
    .toBe('Wind against current: none on the expected timing, but it occurs at other times in your arrival range (3 h).');
  expect(wacLine({ wind_against_current_hours: 0, wind_against_current_arrival_hours: 0 }, { hazard: true }).text)
    .toBe('Wind against current: none on the expected timing, but it occurs at other times in your arrival range.');
  expect(wacLine({ wind_against_current_hours: 0, wind_against_current_arrival_hours: 0 })).toBeUndefined();
  // and on the page: nothing flagged anywhere, no evidence, no line
  const calm = withCurrent(GLO12_TILES, { wac: () => false });
  expect(lineTexts(view(calm)).some((text) => /Wind against current/.test(text))).toBe(false);
  // the hazard fired although no hour sample is flagged (an older check): the line still says so
  calm.evidence.push({ evidence_id: 'E99', rule_id: 'T-WAC-01', model: 'cmems', run: null, leg_id: 'L1', valid_time: calm.legs[0].hours[0].valid_time, value: '1.2 kt', limit: null, units: null, source_kind: 'currents' });
  expect(lineTexts(view(calm))).toContain('Wind against current: none on the expected timing, but it occurs at other times in your arrival range.');
  for (const english of ['Wind against current: none on the expected timing, but it occurs at other times in your arrival range (3 h).',
    'Wind against current: none on the expected timing, but it occurs at other times in your arrival range.']) {
    expect(translateText(english, 'fr')).toMatch(/^Vent contre courant\u00A0: aucun selon l’horaire prévu, mais il se produit à d’autres moments de votre fenêtre d’arrivée estimée( \(3 h\))?\.$/);
  }
});

it('names the model and caveat by family and recorded source; a disclaimer always follows', () => {
  const caveatLines = (findings) => lineTexts(view(findings)).slice(-2);
  const ibi = withCurrent(IBI_PREPARED);
  expect(modelLine(view(ibi))).toBe('Currents · Copernicus IBI ocean currents');
  expect(caveatLines(ibi)).toEqual(['Regional model currents including tide.', DISCLAIMER]);
  // a prepared global grid has no tide, but nothing records it as 6-hourly
  const glo = withCurrent({ ...IBI_PREPARED, model: 'cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i' });
  expect(modelLine(view(glo))).toBe('Currents · Copernicus global ocean currents');
  expect(caveatLines(glo)).toEqual(['Ocean-model currents. Tides are not resolved.', DISCLAIMER]);
  // other families, unknown ids and no record: a neutral caveat
  const neutral = ['Whether this model includes tide is not recorded.', DISCLAIMER];
  for (const [model, name] of [
    ['cmems_mod_nws_phy-cur_anfc_0.027deg-2D_PT1H-m', 'Copernicus North West Shelf ocean currents'],
    ['cmems_mod_med_phy-cur_anfc_4.2km_PT15M-i', 'Copernicus Mediterranean ocean currents'],
    ['cmems_mod_bal_phy_anfc_PT1H-i', 'Copernicus Baltic ocean currents'],
    ['rtofs', 'NOAA RTOFS ocean currents'],
    ['cmems', 'Model not recorded'],
    ['currents', 'Model not recorded'],
  ]) {
    const findings = withCurrent({ ...IBI_PREPARED, model });
    expect(modelLine(view(findings)), model).toBe(`Currents · ${name}`);
    expect(caveatLines(findings), model).toEqual(neutral);
  }
  expect(caveatLines(withCurrent(null))).toEqual(neutral);
  // an older check's record of the prepared grid
  const legacy = withCurrent(null);
  legacy.inputs.openmeteo = [{ api: 'cmems-current-grid', model: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', run: 'cmems-ibi-20260711T19Z', mode: 'live' }];
  expect(currentSource(legacy)).toEqual({ name: 'Copernicus IBI ocean currents', caveat: 'regional_tide' });
  expect(currentSource(withCurrent(GLO12_TILES))).toEqual({ name: 'Copernicus global ocean currents', caveat: 'tiles_global' });
  // French for every caveat and every new name
  expect(translateText(CURRENT_CAVEATS.global, 'fr')).toBe('Courants d’un modèle océanique. La marée n’est pas résolue.');
  expect(translateText(CURRENT_CAVEATS.regional_tide, 'fr')).toBe('Courants d’un modèle régional, marée incluse.');
  expect(translateText(CURRENT_CAVEATS.not_recorded, 'fr')).toBe('L’inclusion de la marée dans ce modèle n’est pas enregistrée.');
  expect(translateText(CURRENT_DISCLAIMER, 'fr')).toBe(DISCLAIMER_FR);
  expect(translateText('Copernicus North West Shelf ocean currents', 'fr')).toBe('Courants océaniques Copernicus (plateau nord-ouest européen)');
  expect(translateText('Copernicus Mediterranean ocean currents', 'fr')).toBe('Courants océaniques Copernicus (Méditerranée)');
  expect(translateText('Copernicus Baltic ocean currents', 'fr')).toBe('Courants océaniques Copernicus (Baltique)');
  expect(translateText('NOAA RTOFS ocean currents', 'fr')).toBe('Courants océaniques NOAA RTOFS');
});

it('credits Copernicus Marine under the block with the product DOI where one is recorded, and says nothing for any other source', () => {
  const credit = (findings) => view(findings).querySelector('[data-testid="current-credit"]')?.textContent ?? null;
  const SENTENCE = 'Generated using E.U. Copernicus Marine Service Information';
  // the two products whose DOI is recorded: tiles (GLO12) and the prepared IBI or global grid
  expect(credit(withCurrent(GLO12_TILES))).toBe(`${SENTENCE}; doi:10.48670/moi-00016`);
  expect(credit(withCurrent({ ...GLO12_TILES, model: 'cmems_ibi tiles (currents-ibi-20260720T00Z)' }))).toBe(`${SENTENCE}; doi:10.48670/moi-00027`);
  expect(credit(withCurrent(IBI_PREPARED))).toBe(`${SENTENCE}; doi:10.48670/moi-00027`);
  expect(credit(withCurrent({ ...IBI_PREPARED, model: 'cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i' }))).toBe(`${SENTENCE}; doi:10.48670/moi-00016`);
  // other Copernicus families: the sentence, no DOI, none guessed
  for (const model of ['cmems_mod_nws_phy-cur_anfc_0.027deg-2D_PT1H-m', 'cmems_mod_med_phy-cur_anfc_4.2km_PT15M-i', 'cmems_mod_bal_phy_anfc_PT1H-i']) {
    expect(credit(withCurrent({ ...IBI_PREPARED, model })), model).toBe(SENTENCE);
  }
  // a multi-year or reanalysis global dataset is a different product: no DOI of the forecast product
  expect(credit(withCurrent({ ...IBI_PREPARED, model: 'cmems_mod_glo_phy_my_0.083deg_P1D-m' }))).toBe(SENTENCE);
  // not Copernicus, or not recorded: nothing
  for (const model of ['rtofs', 'cmems', 'currents']) expect(credit(withCurrent({ ...IBI_PREPARED, model })), model).toBeNull();
  expect(credit(withCurrent(null))).toBeNull();
  expect(credit(withCurrent({ source: 'tiles', layer: 'currents', model: 'cmems', run_id: 'test-surface_current-2', mode: 'synthetic', source_kind: 'emulated', current_source: 'tiles' }))).toBeNull();
});

it('shows no Copernicus credit under emulated values, even when the record carries a real Copernicus dataset id', () => {
  const credit = (findings) => view(findings).querySelector('[data-testid="current-credit"]');
  expect(credit(withCurrent(IBI_PREPARED))).not.toBeNull();
  for (const emulated of [
    { ...IBI_PREPARED, source_kind: 'emulated' },
    { ...IBI_PREPARED, mode: 'synthetic' },
    { ...IBI_PREPARED, source: 'synthetic' },
    { ...GLO12_TILES, source_kind: 'emulated' },
    { ...GLO12_TILES, mode: 'synthetic' },
  ]) {
    const findings = withCurrent(emulated);
    expect(currentSummaryEmulated(findings)).toBe(true);
    expect(credit(findings), JSON.stringify(emulated)).toBeNull();
  }
});

it('shows the Copernicus credit as written on the French page', async () => {
  const { container } = render(<div id="root"><CurrentSummary findings={withCurrent(IBI_PREPARED)} /><LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(container.querySelector('h3').textContent).toContain('Courant le long de votre route'));
  expect(container.querySelector('[data-testid="current-credit"]').textContent)
    .toBe('Generated using E.U. Copernicus Marine Service Information; doi:10.48670/moi-00027');
});

it('a grid with no dataset id is "Model not recorded", never a guessed model, and is stamped when emulated', () => {
  const synthetic = withCurrent({ source: 'tiles', layer: 'currents', model: 'cmems', run_id: 'test-surface_current-2', mode: 'synthetic', source_kind: 'emulated', current_source: 'tiles' });
  const container = view(synthetic);
  expect(modelLine(container)).toBe('Currents · Model not recorded');
  expect(lineTexts(container).slice(-2)).toEqual(['Whether this model includes tide is not recorded.', DISCLAIMER]);
  expect(headingStamped(container)).toBe(true);
});

it('fixes current datasets that the Models panel named as sea level', () => {
  expect(modelName('cmems_mod_med_phy-cur_anfc_4.2km_PT15M-i')).toBe('Copernicus Mediterranean ocean currents');
  expect(modelName('cmems_mod_nws_phy-cur_anfc_0.027deg-2D_PT1H-m')).toBe('Copernicus North West Shelf ocean currents');
  // the sea-level datasets keep their names
  expect(modelName('cmems_mod_med_phy_anfc_4.2km-2D_PT1H-m')).toBe('Copernicus Mediterranean sea level');
  expect(modelName('cmems_mod_ibi_phy_anfc_0.027deg-2D_PT1H-m')).toBe('Copernicus IBI sea level');
  // the current line never shows a sea-level name, whatever the dataset
  expect(currentModelFamily('cmems_mod_ibi_phy_anfc_0.027deg-2D_PT1H-m').name).toBe('Copernicus IBI ocean currents');
  expect(currentModelFamily('cmems_mod_med_phy_anfc_4.2km-2D_PT1H-m').name).toBe('Copernicus Mediterranean ocean currents');
  for (const id of [null, '', 'cmems', 'currents', 'Synthetic current']) expect(currentModelFamily(id)).toBeNull();
});

it('says so when hours have no current value', () => {
  // 08:00 lies in leg 2's expected window, so the passage misses one hour and leg 2 its gain
  const texts = lineTexts(view(withCurrent(null, { missing: ['2026-07-20T08:00:00Z'] })));
  expect(texts).toContain('Distance gained or lost to the current: not available');
  expect(texts).toContain('No current value for 1 h of the passage.');
  expect(texts.join(' ')).not.toMatch(/An estimate|computed route/);
});

it('stamps the heading from the current record only, and the wind-against-current line from the current or the wind', () => {
  // emulated current: synthetic grid, or a record marked emulated
  const synthetic = view(withCurrent({ ...GLO12_TILES, mode: 'synthetic', source_kind: 'emulated' }));
  expect(headingStamped(synthetic)).toBe(true);
  expect(wacStamped(synthetic)).toBe(true);
  expect(headingStamped(view(withCurrent({ ...IBI_PREPARED, source_kind: 'emulated' })))).toBe(true);
  // a real current in a check whose wind forecast is an emulated scenario: the heading is not stamped,
  // the wind-against-current line (wind and current together) is
  const scenarioWind = withCurrent(GLO12_TILES);
  expect(scenarioWind.inputs.forecast_tiles.find((item) => item.layer === 'weather').model).toMatch(/^scenario/);
  const mixed = view(scenarioWind);
  expect(headingStamped(mixed)).toBe(false);
  expect(wacStamped(mixed)).toBe(true);
  expect(currentSummaryEmulated(scenarioWind)).toBe(false);
  // real wind and real current: nothing stamped, though the demo's warning evidence is emulated
  const real = withCurrent(GLO12_TILES);
  for (const layer of real.inputs.forecast_tiles) if (layer.layer !== 'currents') layer.model = 'gfs_0p25';
  expect(real.evidence.some((item) => item.source_kind === 'emulated')).toBe(true);
  const realView = view(real);
  expect(headingStamped(realView)).toBe(false);
  expect(wacStamped(realView)).toBe(false);
  expect(realView.querySelector('[data-testid="current-wac"]')).not.toBeNull();
  // an older check's record decides the same way
  const legacy = withCurrent(null);
  legacy.inputs.openmeteo = [{ api: 'cmems-current-grid', model: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', mode: 'live' }];
  expect(headingStamped(view(legacy))).toBe(false);
  legacy.inputs.openmeteo[0].mode = 'synthetic';
  expect(headingStamped(view(legacy))).toBe(true);
  // no provenance at all: not stamped, unless the current rule's own evidence was emulated
  const bare = withCurrent(null);
  expect(headingStamped(view(bare))).toBe(false);
  bare.evidence.push({ evidence_id: 'E99', rule_id: 'T-WAC-01', model: 'cmems', run: null, leg_id: 'L1', valid_time: bare.legs[0].hours[0].valid_time, value: 'x', limit: null, units: null, source_kind: 'emulated' });
  expect(headingStamped(view(bare))).toBe(true);
});

it('words each basis and amount of the gain', () => {
  const base = { total_hours: 10, unavailable_hours: 0, strongest: null, wind_against_current_hours: 0, wind_against_current_arrival_hours: 0 };
  const text = (gain) => currentSummaryLines({ ...base, gain }).map((line) => line.text);
  expect(text({ nm: 3.342, basis: 'routed_timing' })).toEqual([
    'Distance gained from the current: 3.3 nm',
    'From the computed route’s own timing: speed over ground minus speed through the water, leg by leg.',
  ]);
  expect(text({ nm: -0.96, basis: 'leg_samples' })[0]).toBe('Distance lost to the current: 1.0 nm');
  expect(text({ nm: 0.04, basis: 'leg_samples' })[0]).toBe('Distance gained or lost to the current: under 0.1 nm');
  expect(text({ nm: -0.049, basis: 'routed_timing' })[0]).toBe('Distance gained or lost to the current: under 0.1 nm');
  expect(translateText('Distance gained or lost to the current: under 0.1 nm', 'fr')).toBe('Distance gagnée ou perdue avec le courant\u00A0: moins de 0,1 M');
  expect(translateText('From the computed route’s own timing: speed over ground minus speed through the water, leg by leg.', 'fr'))
    .toBe('D’après l’horaire de la route calculée elle-même\u00A0: vitesse sur le fond moins vitesse surface, tronçon par tronçon.');
  expect(translateText('No current value for 3 h of the passage.', 'fr')).toBe('Aucune valeur de courant pour 3 h de la traversée.');
  expect(translateText('Model not recorded', 'fr')).toBe('Modèle non enregistré');
});
