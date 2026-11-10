import { describe, expect, it } from 'vitest';
import {
  axisTickLabel, createAxisLabelFormatter, describeTimeSpan, labelledBandIndex, mergeDivergenceBands,
  modelComparisonAriaLabel, plumeAriaLabel, sampleStepMs, timeZoneAxisName,
} from '../src/lib/chartTime.js';
import { localTimeZoneName } from '../src/lib/format.js';
import { MODEL_STYLES, dashArray, modelStyle } from '../src/lib/modelStyles.js';
import { translateText } from '../src/i18n.js';

// Local-time constructors keep these tests independent of the runner's time zone.
const at = (day, hour, minute = 0) => new Date(2026, 6, day, hour, minute).getTime(); // July 2026: 13 Jul is a Monday
const H = 3600_000;

describe('axisTickLabel', () => {
  it('names the day on the first tick and on the first tick of each new day', () => {
    expect(axisTickLabel(at(13, 6))).toBe('06:00\nMon 13');
    expect(axisTickLabel(at(13, 12), at(13, 6))).toBe('12:00');
    expect(axisTickLabel(at(14, 0), at(13, 18))).toBe('00:00\nTue 14');
  });

  it('does not rely on a wall-clock hour, so a day without a midnight tick still gets its name', () => {
    expect(axisTickLabel(at(14, 5), at(13, 23))).toBe('05:00\nTue 14');
  });
});

describe('createAxisLabelFormatter', () => {
  const ticks = [at(13, 6), at(13, 12), at(13, 18), at(14, 0), at(14, 6), at(14, 12)];

  it('never repeats bare hours across days', () => {
    const format = createAxisLabelFormatter();
    expect(ticks.map((t, i) => format(t, i))).toEqual([
      '06:00\nMon 13', '12:00', '18:00', '00:00\nTue 14', '06:00', '12:00',
    ]);
  });

  it('restarts at index 0 so a redraw labels the first tick again', () => {
    const format = createAxisLabelFormatter();
    ticks.forEach((t, i) => format(t, i));
    expect(format(ticks[0], 0)).toBe('06:00\nMon 13');
  });

  it('blanks every second tick on phones and measures the day change against the last visible one', () => {
    const format = createAxisLabelFormatter({ skipOdd: true });
    expect(ticks.map((t, i) => format(t, i))).toEqual(['06:00\nMon 13', '', '18:00', '', '06:00\nTue 14', '']);
  });
});

describe('time zone wording', () => {
  it('uses the header zone with the existing "local time · zone" wording', () => {
    expect(timeZoneAxisName()).toBe(`local time · ${localTimeZoneName()}`);
    expect(translateText('local time · Europe/Paris', 'fr')).toBe('heure locale · Europe/Paris');
  });

  it('describes a span with the header formatter', () => {
    expect(describeTimeSpan(at(13, 6), at(15, 6))).toBe('Mon 13 Jul 06:00 to Wed 15 Jul 06:00');
  });
});

describe('divergence bands', () => {
  const hours = [at(13, 9), at(13, 10), at(13, 11)];

  it('merges touching hours into one band, so three adjacent hours draw one label', () => {
    expect(mergeDivergenceBands(hours)).toEqual([{ start: at(13, 9) - H / 2, end: at(13, 11) + H / 2, hours: 3 }]);
  });

  it('keeps separate bands apart and tolerates unsorted or duplicate input', () => {
    const bands = mergeDivergenceBands([at(13, 20), at(13, 9), at(13, 9), at(13, 10), Number.NaN]);
    expect(bands.map((b) => b.hours)).toEqual([2, 1]);
    expect(bands[0].end).toBe(at(13, 10) + H / 2);
  });

  it('follows the sampling step of coarser series', () => {
    const three = 3 * H;
    expect(mergeDivergenceBands([at(13, 9), at(13, 12)], { stepMs: three })).toHaveLength(1);
    expect(sampleStepMs([at(13, 0), at(13, 3), at(13, 6)])).toBe(three);
    expect(sampleStepMs([at(13, 0)])).toBe(H);
  });

  it('labels only the widest band, earliest on ties', () => {
    const bands = mergeDivergenceBands([at(13, 1), at(13, 5), at(13, 6), at(13, 12), at(13, 13)]);
    expect(labelledBandIndex(bands)).toBe(1);
    expect(labelledBandIndex(mergeDivergenceBands([at(13, 1), at(13, 5)]))).toBe(0);
    expect(labelledBandIndex([])).toBe(-1);
  });
});

describe('model catalogue', () => {
  it('gives the two live models different colour and different dash', () => {
    const gfs = modelStyle('gfs_0p25');
    const ecmwf = modelStyle('ecmwf_ifs_0p25');
    expect(gfs.color).not.toBe(ecmwf.color);
    expect(gfs.dash).not.toBe(ecmwf.dash);
    expect(gfs.label).toBe('GFS 0.25°');
    expect(ecmwf.label).toBe('ECMWF IFS 0.25°');
  });

  it('keeps every catalogued model distinguishable in colour+dash and aliases consistent', () => {
    const looks = ['ecmwf_ifs_0p25', 'gfs_0p25', 'icon_eu'].map((m) => `${modelStyle(m).color}/${modelStyle(m).dash}`);
    expect(new Set(looks).size).toBe(3);
    expect(modelStyle('ecmwf_ifs025')).toBe(MODEL_STYLES.ecmwf_ifs_0p25);
    expect(modelStyle('gfs_global').color).toBe(modelStyle('gfs_0p25').color);
  });

  it('falls back to the raw id with a look of its own', () => {
    const other = modelStyle('arpege_eu');
    expect(other.label).toBe('arpege_eu');
    expect(Object.values(MODEL_STYLES).map((s) => s.color)).toContain(modelStyle('icon_eu').color);
    expect(other.color).not.toBe(modelStyle('gfs_0p25').color);
  });

  it('maps chart dashes to legend swatch dashes', () => {
    expect(dashArray('solid')).toBeUndefined();
    expect(dashArray('dashed')).toBe('7 4');
    expect(dashArray('dotted')).toBe('2 3');
    expect(dashArray([8, 3, 2, 3])).toBe('8 3 2 3');
  });
});

describe('chart accessible text', () => {
  const zone = localTimeZoneName();

  it('describes the plume with its span, zone and limit, and translates to French', () => {
    const label = plumeAriaLabel({ members: 51, variable: 'gust', startMs: at(13, 6), endMs: at(15, 6), limit: 28, units: 'kt' });
    expect(label).toBe(`Ensemble plume of 51 forecast scenarios for gust, from Mon 13 Jul 06:00 to Wed 15 Jul 06:00, local time ${zone}. Median and P10 to P90 range shown. Your limit: 28 kt.`);
    expect(translateText(label, 'fr')).toBe(`Panache d’ensemble de 51 scénarios de prévision pour les rafales, de lun. 13 juil. 06:00 à mer. 15 juil. 06:00, heure locale ${zone}. Médiane et plage P10 à P90 affichées. Votre limite : 28 nd.`);
  });

  it('omits the limit sentence when there is none', () => {
    const label = plumeAriaLabel({ members: 51, variable: 'wind', startMs: at(13, 6), endMs: at(15, 6), limit: null, units: 'kt' });
    expect(label).not.toContain('Your limit');
    expect(translateText(label, 'fr')).toContain('pour le vent');
    expect(translateText(label, 'fr')).not.toContain('limite');
  });

  it('describes the model comparison with names, span and divergence, and translates to French', () => {
    const label = modelComparisonAriaLabel({ modelNames: ['ECMWF IFS 0.25°', 'GFS 0.25°'], startMs: at(13, 6), endMs: at(15, 6), divergentHours: 3 });
    expect(label).toBe(`Model comparison of 10 m sustained wind: ECMWF IFS 0.25°, GFS 0.25°, from Mon 13 Jul 06:00 to Wed 15 Jul 06:00, local time ${zone}. Models diverge in 3 h of this period.`);
    expect(translateText(label, 'fr')).toBe(`Comparaison des modèles pour le vent moyen à 10 m : ECMWF IFS 0.25°, GFS 0.25°, de lun. 13 juil. 06:00 à mer. 15 juil. 06:00, heure locale ${zone}. Les modèles divergent pendant 3 h sur cette période.`);
    const calm = modelComparisonAriaLabel({ modelNames: ['GFS 0.25°'], startMs: at(13, 6), endMs: at(15, 6), divergentHours: 0 });
    expect(calm).toMatch(/No divergent hours flagged\.$/);
    expect(translateText(calm, 'fr')).toMatch(/Aucune heure de divergence signalée\.$/);
  });

  it('translates the grey-band legend entry', () => {
    expect(translateText('grey band: models diverge', 'fr')).toBe('bande grise : divergence des modèles');
  });
});
