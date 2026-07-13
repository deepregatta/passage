import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultLanguage, getInitialLanguage, translateText } from '../src/i18n.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
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

  it('translates dynamic briefing narratives and dates', () => {
    const samples = {
      'Start → Finish': 'Départ → Arrivée',
      'dep Wed 15 Jul 06:00 UTC': 'départ mer. 15 juil. 06:00 UTC',
      'Insufficient forecast confidence': 'Confiance insuffisante dans la prévision',
      'forecast updates ~Mon 13 Jul 16:30 UTC — check again before you cast off': 'mise à jour des prévisions vers lun. 13 juil. 16:30 UTC — vérifiez à nouveau avant d’appareiller',
      'Wind opposes the current at waypoint 2 → waypoint 3, increasing the risk of short, steep seas.': 'Le vent s’oppose au courant au point de route 2 → point de route 3, ce qui augmente le risque de mer courte et abrupte.',
      'The forecast reaches 32 kt against your 28 kt limit near waypoint 8.': 'La prévision atteint 32 nd, pour une limite fixée à 28 nd, près du point de route 8.',
      'models diverge on 7 h of this passage': 'les modèles divergent pendant 7 h sur cette traversée',
      'run 2026-07-13T00:00Z · age 18 h 15 min': 'cycle 2026-07-13T00:00Z · âge 18 h 15 min',
      'system undefined · boat L1': 'aucun système attribué · bateau L1',
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
      'The national weather service has an active marine warning covering part of your route. Official forecasts are the authority — read the bulletin before anything else.',
      'A strengthening low-pressure system sits west of the approaches, at your latitude — that is what sets the wind pattern over your route. The chart panels show how it moves over the next days.',
      'Mid-Channel → Plymouth approach: strong winds while you are on this stretch (Mon 20 Jul 17:28–Tue 21 Jul 04:04 UTC). All 51 forecast scenarios exceed your 18 kt wind limit around Tue 21 Jul 05:00 UTC.',
      'Forecasts update several times a day. Check again after the next model run (expected around Sun 19 Jul 22:30 UTC) — especially if you are close to your limits.',
      'Not assessed: tidal currents (no prepared current grid), tidal gates & HW/LW heights (no tide data), tropical systems, ice. No flag does not mean no risk.',
    ];
    for (const sample of samples) {
      const translated = translateText(sample, 'fr');
      expect(translated).not.toMatch(/\b(The|forecast|winds|while|Not assessed|tidal|tropical|ice|limit|around)\b/i);
    }
  });
});
