import { createElement } from 'react';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalizedDocument, getDefaultLanguage, getInitialLanguage, getLanguageFromPath, translateText } from '../src/i18n.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  history.replaceState(null, '', '/');
});

it('translates transport timeouts, network errors and tile validation failures', () => {
  expect(translateText('forecast fetch timed out after 15000 ms for latest.json', 'fr'))
    .toBe('Délai de chargement des prévisions dépassé après 15000 ms pour latest.json');
  expect(translateText('forecast fetch failed: network error for latest.json', 'fr'))
    .toBe('Échec du chargement des prévisions : erreur réseau pour latest.json');
  expect(translateText('forecast tile invalid: run/tile.bin (checksum mismatch)', 'fr'))
    .toBe('Tuile de prévision invalide : run/tile.bin (somme de contrôle incorrecte)');
  expect(translateText('forecast tile invalid: run/tile.bin (decode failed)', 'fr'))
    .toBe('Tuile de prévision invalide : run/tile.bin (échec du décodage)');
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
    )).toBe('T+0 : anticyclone H2 (1020 hPa) à l’ouest du golfe du Lion, se renforçant de 1 hPa/24 h, quasi stationnaire. Le resserrement des isobares sur la Manche orientale y indique un vent plus fort.');
  });

  it('translates multi-system captions and decision-band clauses', () => {
    const samples = {
      'T+0: high H5 (1022 hPa) over the Gulf of Genoa, building 1.7 hPa/24h, quasi-stationary; high H7 (1019 hPa) south of Iberia, steady, quasi-stationary. Tighter isobar spacing over the North Sea means stronger wind there.':
        'T+0 : anticyclone H5 (1022 hPa) sur le golfe de Gênes, se renforçant de 1.7 hPa/24 h, quasi stationnaire ; anticyclone H7 (1019 hPa) au sud de la péninsule Ibérique, stable, quasi stationnaire. Le resserrement des isobares sur la mer du Nord y indique un vent plus fort.',
      'T+24: low L1 (996 hPa) west of Ireland, deepening 3 hPa/24h, moving NE 20 kt.':
        'T+24 : dépression L1 (996 hPa) à l’ouest de l’Irlande, se creusant de 3 hPa/24 h, se déplaçant vers le NE à 20 nd.',
      'T+48: no closed pressure centres in the window.':
        'T+48 : aucun centre de pression fermé dans la fenêtre.',
      'Winds reach 17 kt near waypoint 2, close to your 18 kt limit.':
        'Le vent atteint 17 nd près du point de route 2, proche de votre limite de 18 nd.',
      'A low-pressure system crosses your route. gusts reach 22 kt near Barcelona, over your 20 kt limit.':
        'Une dépression traverse votre route. Les rafales atteignent 22 nd près de Barcelona, au-dessus de votre limite de 20 nd.',
      'Every forecast scenario shows gusts over your 18 kt limit near waypoint 2.':
        'Tous les scénarios de prévision montrent des rafales au-dessus de votre limite de 18 nd près du point de route 2.',
      'No tracked system crosses your route window. The wider pattern still sets your wind.':
        'Aucun système suivi ne traverse votre fenêtre de route. La configuration d’ensemble détermine néanmoins votre vent.',
      'A low-pressure system sits near your waters, to the north.':
        'Une dépression se trouve près de votre zone de navigation, au nord.',
      'A strengthening low-pressure system sits west of the approaches, at your latitude. It sets the wind pattern over your route. The charts track it over the next few days.':
        'Une dépression qui se renforce se trouve à l’ouest des approches, à votre latitude. Elle détermine le régime de vent sur votre route. Les cartes suivent son déplacement au cours des prochains jours.',
      'next forecast ~Sun 19 Jul 18:00 UTC · recheck before departure':
        'prochaine prévision vers dim. 19 juil. 18:00 UTC · revérifiez avant le départ',
    };
    for (const [english, french] of Object.entries(samples)) {
      expect(translateText(english, 'fr')).toBe(french);
    }
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
      './fixtures/compatibility/20260720T060000Z_44d2cd5f_4196266b/briefing.json',
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

describe('review 1.12 briefing prose', () => {
  it('translates route-relative positions, including shortened story headlines', () => {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const positions = ['near the centre of your route', 'at the charted position', ...directions.flatMap((dir) => ['within 100 nm', '100–300 nm', 'more than 300 nm'].map((band) => `${band} ${dir} of the centre of your route`))];
    for (const position of positions) {
      for (const suffix of ['', ' It sets the wind pattern over your route. The charts track it over the next few days.']) {
        const text = `A strengthening low-pressure system sits ${position}.${suffix}`;
        expect(translateText(text, 'fr')).not.toMatch(/strengthening|sits|centre of your route|within|more than|charted|It sets|charts track/);
      }
    }
    expect(translateText('A low-pressure system sits within 100 nm W of the centre of your route.', 'fr')).toBe('Une dépression se trouve à moins de 100 M O du centre de votre route.');
  });
  it('translates estimated and unavailable updates without losing the timestamp', () => {
    const samples = {
      'Next forecast update time unavailable. Check the published forecast before departure.': 'Heure de la prochaine mise à jour indisponible. Consultez la prévision publiée avant le départ.',
      'The next forecast update is estimated around Wed 9 Sep 04:20 UTC. Check again then, especially if conditions are close to your limits.': 'La prochaine mise à jour des prévisions est estimée vers mer. 9 sept. 04:20 UTC. Vérifiez à nouveau à ce moment-là, surtout si les conditions approchent vos limites.',
      'Next forecast update estimated around Wed 9 Sep 04:20 UTC. Check again before departure.': 'Prochaine mise à jour des prévisions estimée vers mer. 9 sept. 04:20 UTC. Vérifiez à nouveau avant le départ.',
      'Estimated next gfs_0p25 publication ~2026-09-09T04:20:00Z, using the loaded cycle, publication lag and tile-pipeline cadence. Publication may be delayed. Agreement between runs is not proof of accuracy.': 'Prochaine publication de gfs_0p25 estimée vers 2026-09-09T04:20:00Z, à partir du cycle chargé, du délai de publication et de la cadence de la chaîne de tuiles. La publication peut être retardée. La concordance entre les cycles ne prouve pas leur exactitude.',
      'No future publication estimate is available from the loaded forecast metadata and known tile-pipeline schedules. Synthetic runs have no scheduled update.': 'Les métadonnées des prévisions chargées et les calendriers connus de la chaîne de tuiles ne permettent pas d’estimer une prochaine publication. Les cycles synthétiques n’ont aucune mise à jour programmée.',
    };
    for (const [en, fr] of Object.entries(samples)) expect(translateText(en, 'fr')).toBe(fr);
  });
});

it('translates skipped-departure labels and unknown failures', () => {
  for (const text of ['Unassessed departures', 'A missing cell does not mean safe conditions.', 'Unknown error', '2 of 21 departure times could not be assessed and are not shown.']) {
    expect(translateText(text, 'fr')).not.toBe(text);
  }
});

it('translates HTTP scan failure details while preserving the status and artifact path', () => {
  expect(translateText('forecast fetch failed: HTTP 503 for latest.json', 'fr'))
    .toBe('Échec du chargement des prévisions : HTTP 503 pour latest.json');
  expect(translateText('forecast tile fetch failed: HTTP 404 for tiles/a.pft', 'fr'))
    .toBe('Échec du chargement d’une tuile de prévision : HTTP 404 pour tiles/a.pft');
});

// Real MutationObserver delivery verifies work scope as well as translated output.
describe('document localiser scope', () => {
  let host;
  let view;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const mount = (language) => {
    host = document.createElement('div');
    host.id = 'root';
    host.innerHTML = '<section><span>Start</span></section><aside title="Finish">Finish</aside>';
    document.body.append(host);
    view = render(createElement(LocalizedDocument, { language }));
  };
  afterEach(() => { view?.unmount(); host?.remove(); });

  it('does no DOM walk or observation in English, including mutations', async () => {
    const walk = vi.spyOn(document, 'createTreeWalker');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    mount('en');
    host.firstChild.firstChild.firstChild.data = 'Finish';
    await settle();
    expect(walk.mock.calls.filter(([, mask]) => mask === NodeFilter.SHOW_TEXT)).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
  });

  it('localises added subtrees and direct text/attribute edits without revisiting siblings', async () => {
    mount('fr');
    await settle();
    const walk = vi.spyOn(document, 'createTreeWalker');
    const siblingRead = vi.spyOn(host.lastChild, 'getAttribute');
    const span = host.querySelector('span');
    span.firstChild.data = 'Finish';
    span.setAttribute('title', 'Start');
    const added = document.createElement('div');
    added.title = 'Finish';
    added.innerHTML = '<b>Start</b><pre>Start</pre><code>Finish</code>';
    host.firstChild.append(added);
    await settle();
    expect(span.textContent).toBe('Arrivée');
    expect(span.title).toBe('Départ');
    expect(added.title).toBe('Arrivée');
    expect(added.querySelector('b').textContent).toBe('Départ');
    expect(added.querySelector('pre').textContent).toBe('Start');
    expect(added.querySelector('code').textContent).toBe('Finish');
    expect(siblingRead).not.toHaveBeenCalled();
    expect(walk.mock.calls.filter(([, mask]) => mask === NodeFilter.SHOW_TEXT).every(([root]) => root !== host && root !== host.firstChild)).toBe(true);
    const count = walk.mock.calls.length;
    await settle();
    expect(walk).toHaveBeenCalledTimes(count);
  });

  it('restores current English values once and stops observing after a language switch', async () => {
    mount('fr');
    host.querySelector('span').firstChild.data = 'Finish';
    await settle();
    view.rerender(createElement(LocalizedDocument, { language: 'en' }));
    expect(host.querySelector('span').textContent).toBe('Finish');
    expect(host.lastChild.title).toBe('Finish');
    const walk = vi.spyOn(document, 'createTreeWalker');
    host.querySelector('span').firstChild.data = 'Start';
    await settle();
    expect(walk.mock.calls.filter(([, mask]) => mask === NodeFilter.SHOW_TEXT)).toEqual([]);
    view.rerender(createElement(LocalizedDocument, { language: 'fr' }));
    expect(host.querySelector('span').textContent).toBe('Départ');
  });

  it('does not restart observation when unmounted with mutations pending', async () => {
    mount('fr');
    host.querySelector('span').firstChild.data = 'Finish';
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    view.unmount();
    await settle();
    expect(observe).not.toHaveBeenCalled();
    expect(host.querySelector('span').textContent).toBe('Finish');
  });
});
