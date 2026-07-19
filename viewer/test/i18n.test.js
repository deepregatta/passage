import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultLanguage, getInitialLanguage, getLanguageFromPath, translateText } from '../src/i18n.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  history.replaceState(null, '', '/');
});

describe('language selection', () => {
  it('selects French from a French browser preference', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'en-US']);
    expect(getDefaultLanguage()).toBe('fr');
  });

  it('falls back to English for unsupported browser languages', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['de-DE']);
    expect(getDefaultLanguage()).toBe('en');
  });

  it('lets a saved explicit choice override browser detection', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['fr-FR']);
    localStorage.setItem('passage-language', 'en');
    expect(getInitialLanguage()).toBe('en');
  });

  it('recognises only the /fr/ path prefix as French', () => {
    expect(getLanguageFromPath('/fr/')).toBe('fr');
    expect(getLanguageFromPath('/fr')).toBe('fr');
    expect(getLanguageFromPath('/')).toBe(null);
    expect(getLanguageFromPath('/france')).toBe(null);
  });

  it('lets the /fr/ URL win over saved choice and browser detection', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['en-US']);
    localStorage.setItem('passage-language', 'en');
    history.replaceState(null, '', '/fr/');
    expect(getInitialLanguage()).toBe('fr');
  });

  it('translates dynamic briefing narratives and dates', () => {
    const samples = {
      'Start → Finish': 'Départ → Arrivée',
      'dep Wed 15 Jul 06:00 UTC': 'départ mer. 15 juil. 06:00 UTC',
      'dep Wed 15 Jul 08:00 local time · Europe/Paris': 'départ mer. 15 juil. 08:00 heure locale · Europe/Paris',
      '24-hour clock (HH:mm) · your local time · Europe/Paris': 'format 24 heures (HH:mm) · votre heure locale · Europe/Paris',
      'local time · Europe/Paris': 'heure locale · Europe/Paris',
      'Insufficient forecast confidence': 'Confiance insuffisante dans la prévision',
      'forecast updates ~Mon 13 Jul 16:30 UTC; check again before you cast off': 'mise à jour des prévisions vers lun. 13 juil. 16:30 UTC; vérifiez à nouveau avant d’appareiller',
      'Wind opposes the current at waypoint 2 → waypoint 3, increasing the risk of short, steep seas.': 'Le vent s’oppose au courant au point de route 2 → point de route 3, ce qui augmente le risque de mer courte et abrupte.',
      'The forecast reaches 32 kt against your 28 kt limit near waypoint 8.': 'La prévision atteint 32 nd, pour une limite fixée à 28 nd, près du point de route 8.',
      'models diverge on 7 h of this passage': 'les modèles divergent pendant 7 h sur cette traversée',
      'run 2026-07-13T00:00Z · age 18 h 15 min': 'cycle 2026-07-13T00:00Z · âge 18 h 15 min',
      'system undefined · boat L1': 'aucun système attribué · bateau L1',
      '8 NM': '8 M',
      'evidence:': 'éléments probants :',
    };
    for (const [english, french] of Object.entries(samples)) {
      expect(translateText(english, 'fr')).toBe(french);
    }
  });

  it('translates generated synoptic captions', () => {
    expect(translateText(
      'T+0: high H2 (1020 hPa) west of the Gulf of Lion, building 1 hPa/24h, quasi-stationary. Tighter isobar spacing over the eastern Channel means stronger wind there.',
      'fr',
    )).toBe('T+0 : anticyclone H2 (1020 hPa) à l’ouest du golfe du Lion, se renforçant de 1 hPa/24h, quasi stationnaire. Le resserrement des isobares sur l’est de la Manche y indique un vent plus fort.');
  });

  it('translates expanded briefing sections', () => {
    const samples = [
      'The national weather service has an active marine warning covering part of your route. Official forecasts are the authority; read the bulletin before anything else.',
      'A strengthening low-pressure system sits west of the approaches, at your latitude; that is what sets the wind pattern over your route. The chart panels show how it moves over the next days.',
      'Mid-Channel → Plymouth approach: strong winds while you are on this stretch (Mon 20 Jul 17:28–Tue 21 Jul 04:04 UTC). All 51 forecast scenarios exceed your 18 kt wind limit around Tue 21 Jul 05:00 UTC.',
      'Forecasts update several times a day. Check again after the next model run (expected around Sun 19 Jul 22:30 UTC); especially if you are close to your limits.',
      'Not assessed: tidal currents (no prepared current grid), tidal gates & HW/LW heights (no tide data), tropical systems, ice. No flag does not mean no risk.',
    ];
    for (const sample of samples) {
      const translated = translateText(sample, 'fr');
      expect(translated).not.toMatch(/\b(The|forecast|winds|while|Not assessed|tidal|tropical|ice|limit|around)\b/i);
    }
  });

  it('translates every sentence from the reported French briefing regressions', () => {
    const samples = [
      'A low-pressure system sits near your waters, to the south; that is what sets the wind pattern over your route. The chart panels show how it moves over the next days.',
      'Start → waypoint 2: moderate winds while you are on this stretch (Wed 15 Jul 06:00–Wed 15 Jul 06:17 UTC).',
      'waypoint 8 → Finish: fresh winds while you are on this stretch (Wed 15 Jul 12:23–Wed 15 Jul 15:38 UTC). 6 of 31 forecast scenarios exceed your 28 kt gust limit around Wed 15 Jul 15:00 UTC.',
      'The forecasts disagree too much to assess this passage against your limits. Reassess after the next model run. The main signal: gusts up to 32 kt; over your 28 kt limit on waypoint 7 → waypoint 8 around Wed 15 Jul 14:00 UTC.',
      'This briefing does NOT cover: official marine warnings (no feed configured), tropical systems, ice. No warning here does not mean no risk.',
      'Unassessed hazard classes: official marine warnings (no feed configured); tropical systems; ice. Partial capability coverage: waves (deterministic wave model only; no wave ensemble); visibility_and_convection (screening signals only (single model, GFS); official warnings remain authoritative); tidal_currents (stride-subsampled x2 from native 0.0278 deg to 0.0556 deg (target 0.05 deg); values are exact native cell values, no smoothing). Absence of a flag must not be read as absence of risk (brief §5).',
    ];
    const english = /\b(?:a low-pressure|sits|that is what|chart panels|moderate winds|while you are|the forecasts|assess this passage|reassess|next model run|the main signal|gust limit|official marine warnings|no feed configured|unassessed hazard|partial capability|deterministic wave|no wave ensemble|screening signals|single model|remain authoritative|stride-subsampled|native cell values|no smoothing|absence of a flag|absence of risk)\b/i;

    for (const sample of samples) {
      expect(translateText(sample, 'fr')).not.toMatch(english);
    }
  });

  it('leaves no generated English briefing prose in the bundled snapshots', () => {
    const fixtures = [
      './fixtures/20260720T060000Z_44d2cd5f_4196266b/briefing.json',
      './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_7b2600cd/briefing.json',
      './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json',
    ];
    const english = /\b(?:while you are|forecast scenarios exceed|the forecasts|reassess after|official marine warnings|unassessed hazard classes|partial capability coverage|deterministic wave model|screening signals only|values are exact|absence of a flag|authority override|detected systems|front-type labels|per-leg conditions|sustained \d|gusts to|seas to|raw scenario fraction|calibrated probability|provider modes are recorded)\b/i;
    const visit = (value) => {
      if (typeof value === 'string') expect(translateText(value, 'fr')).not.toMatch(english);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };

    for (const fixture of fixtures) {
      visit(JSON.parse(readFileSync(new URL(fixture, import.meta.url), 'utf8')));
    }
  });
});
