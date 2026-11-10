import { describe, expect, it } from 'vitest';
import { translateText } from '../src/i18n.js';

const fr = (text) => translateText(text, 'fr');

describe('French place grammar', () => {
  it.each([
    // Whole sentences and the DOM-split text nodes the briefing actually renders.
    ['Strongest near Plymouth breakwater', 'Conditions les plus fortes près du brise-lames de Plymouth'],
    ['near Plymouth breakwater', 'près du brise-lames de Plymouth'],
    ['near Mid-Channel', 'près du milieu de la Manche'],
    ['near Casquets TSS crossing', 'près de la traversée du DST des Casquets'],
    ['Strongest near Casquets TSS crossing', 'Conditions les plus fortes près de la traversée du DST des Casquets'],
    // 'au large de' already locates: no stacked "près de au large de".
    ['near Off Omonville-la-Rogue', 'au large d’Omonville-la-Rogue'],
    ['Off Omonville-la-Rogue', 'au large d’Omonville-la-Rogue'],
    ['NW of Cap de la Hague', 'au nord-ouest du Cap de la Hague'],
    ['near NW of Cap de la Hague', 'au nord-ouest du Cap de la Hague'],
    ['near Plymouth approach (E of Eddystone)', 'près de l’approche de Plymouth (à l’est d’Eddystone)'],
    ['near Start', 'près du départ'],
    ['near Finish', 'près de l’arrivée'],
    ['near Ouistreham', 'près d’Ouistreham'],
    ['near Honfleur', 'près d’Honfleur'],
    ['near Barcelona', 'près de Barcelona'],
    ['near waypoint 3', 'près du point de route 3'],
  ])('%s', (english, french) => {
    expect(fr(english)).toBe(french);
    expect(fr(french)).toBe(french);
    expect(translateText(english, 'en')).toBe(english);
  });

  it('localizes places inside generated sentences', () => {
    expect(fr('Wind over tide near Mid-Channel around Mon 20 Jul 14:00 UTC; expect short, steep seas.'))
      .toBe('Vent contre courant près du milieu de la Manche vers lun. 20 juil. 14:00 UTC\u00A0; attendez-vous à une mer courte et abrupte.');
    expect(fr('Winds reach 17 kt near Off Omonville-la-Rogue, close to your 18 kt limit.'))
      .toBe('Le vent atteint 17 nd au large d’Omonville-la-Rogue, proche de votre limite de 18 nd.');
    expect(fr('near Plymouth breakwater around')).toBe('près du brise-lames de Plymouth vers');
    expect(fr('All 51 forecast scenarios exceed your 30 kt gust limit near Mid-Channel.'))
      .toBe('Les 51 scénarios de prévision dépassent votre limite de rafales de 30 nd près du milieu de la Manche.');
    expect(fr('The forecast reaches 32 kt against your 28 kt limit near NW of Cap de la Hague.'))
      .toBe('La prévision atteint 32 nd, pour une limite fixée à 28 nd, au nord-ouest du Cap de la Hague.');
  });
});

describe('French numbers and units', () => {
  it.each([
    ['46.7 nm', '46,7 M'],
    ['2.8 m', '2,8 m'],
    ['+0.3', '+0,3'],
    ['-1.5 kt', '-1,5 nd'],
    ['16.63 22.25', '16,63 22,25'],
    ['48.2°N–50.8°N, 5.5°W–1°W', '48,2°N–50,8°N, 5,5°O–1°O'],
    ['12 NM', '12 M'],
    ['nm', 'M'],
    ['NM', 'M'],
    ['(nm)', '(M)'],
    ['Gusts 25.5 kt', 'rafales 25,5 nd'],
    ['GFS 0.25°', 'GFS 0,25°'],
  ])('%s', (english, french) => {
    expect(fr(english)).toBe(french);
    expect(fr(french)).toBe(french);
    expect(translateText(english, 'en')).toBe(english);
  });

  it.each([
    'latest.json',
    'v0.2.0',
    '1.2.3.4',
    'https://example.org/run/1.5/tile.bin',
    'deepregatta-polars 2026.10.11',
    'tile_1.5',
    'casquets:BMS-large:2026-07-20T12:00:00Z',
    '14:30',
    'First 36.7',
    'CC BY 4.0',
    '(§4.1)',
    '2026-07-11T18:00:00.000Z',
  ])('leaves identifiers, versions, URLs and times alone: %s', (text) => {
    expect(fr(text)).toBe(text);
  });

  it('does not break words that contain nm', () => {
    expect(fr('environment')).toBe('environment');
  });
});

describe('French typography, wording and ages', () => {
  it('puts a no-break space before a semicolon', () => {
    expect(fr('19:00–02:00 close to your limits; 19:00–02:00 beyond your limits'))
      .toBe('19:00–02:00 proches de vos limites\u00A0; 19:00–02:00 au-delà de vos limites');
  });

  it.each([
    ['veer', 'rotation horaire'],
    ['Story', 'Situation météo'],
    ['The weather story', 'Situation météo'],
    ['Route', 'Route'],
    ['Compute a route', 'Calculer la route'],
    ['Compute route', 'Calculer la route'],
    ['2/2 endpoints', '2/2 extrémités placées'],
    ['Text/table alternative for the plume', 'Version texte et tableau du panache'],
    ['Next 1 day', 'Les 24 prochaines heures'],
    ['Switch to Next 1 day', 'Passer aux 24 prochaines heures'],
    ['evidence', 'Voir les éléments probants'],
  ])('%s', (english, french) => {
    expect(fr(english)).toBe(french);
  });

  it.each([
    ['2 d 3 h', '2 j 3 h'],
    ['age', 'âge'],
    ['3 d', '3 j'],
    ['2737 h 32 min', '2737 h 32 min'],
    [' · 2 d 3 h old', ' · il y a 2 j 3 h'],
  ])('renders ages in days as j: %s', (english, french) => {
    expect(fr(english)).toBe(french);
  });
});
