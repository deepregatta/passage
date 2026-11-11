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

  // The pressure-system summary of the pro register: coordinates and bearings use French ouest.
  it.each([
    ['lows L1 (1002 hPa near 49°N 7°W), deepening 18 hPa/24h, moving WSW 31 kt; highs none',
      'dépressions L1 (1002 hPa près de 49°N 7°O), se creusant de 18 hPa/24 h, se déplaçant vers l’OSO à 31 nd ; aucun anticyclone'],
    ['lows L2 (1011 hPa near 48°S 12°E), steady, moving ENE 9 kt; highs none',
      'dépressions L2 (1011 hPa près de 48°S 12°E), stable, se déplaçant vers l’ENE à 9 nd ; aucun anticyclone'],
  ])('writes ouest as O in detected systems: %s', (systems, french) => {
    expect(fr(`Detected systems (run-1): ${systems}.`)).toBe(`Systèmes détectés (run-1) : ${french}.`);
  });
});

describe('French labels that carry a unit', () => {
  it('keeps the knots unit apart from the small caps of its label', () => {
    // The label is three text nodes so the unit can stay lower case: "(ND)" is not a unit.
    expect(fr('Speed')).toBe('Vitesse');
    expect(fr('(kt)')).toBe('(nd)');
    expect(fr('· slow / usual / fast')).toBe('· lente / habituelle / rapide');
  });
});

describe('French identifiers and proper names', () => {
  it.each([
    'boat-a',
    'my-boat-5wp',
    'boat_1',
    'orc-2025/boat-b',
    'polars/boat-a.json',
    'boat:boat-a',
  ])('leaves an identifier containing "boat" untouched: %s', (id) => {
    expect(fr(id)).toBe(id);
    expect(fr(`Polar ${id} loaded`)).toContain(id);
  });

  it('still translates the word boat in prose', () => {
    expect(fr('Pick the boat.')).toContain('bateau.');
    expect(fr('boat, kt')).toContain('bateau,');
    expect(fr('(boat)')).toBe('(bateau)');
    expect(fr('Your boat: Oceanis')).toContain('bateau: Oceanis');
  });

  it('uses the typographic apostrophe in the Cherbourg approach name', () => {
    expect(fr('Cherbourg, Passe de l\'Ouest')).toBe('Cherbourg, Passe de l’Ouest');
    expect(fr('Cherbourg, Passe de l\'Ouest → Off Omonville-la-Rogue')).toBe('Cherbourg, Passe de l’Ouest → au large d’Omonville-la-Rogue');
    expect(fr('Cherbourg, Passe de l’Ouest')).toBe('Cherbourg, Passe de l’Ouest');
    expect(translateText('Cherbourg, Passe de l\'Ouest', 'en')).toBe('Cherbourg, Passe de l\'Ouest');
  });

  it('never rewrites the apostrophe of a name the sailor typed', () => {
    expect(fr('Dad\'s l\'Ouest trip')).toBe('Dad\'s l\'Ouest trip');
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

describe('French wording fixes from the page walk', () => {
  it.each([
    // "raz de marée" means tsunami in French; a tidal race is a "raz de courant".
    ['Global models under-resolve coastal wind acceleration, harbours and tidal races. Ocean-model currents are not tidal stream predictions.',
      'Les modèles globaux représentent mal l’accélération côtière du vent, les ports et les raz de courant. Les courants des modèles océaniques ne sont pas des prévisions de courants de marée.'],
    // "la" used to read as a stray pronoun for "rafales".
    ['A brief burst above the sustained wind. Gusts are often 20–40% stronger; squalls can double it.',
      'Une brève pointe au-dessus du vent moyen. Les rafales sont souvent 20 à 40 % plus fortes ; les grains peuvent aller jusqu’au double.'],
    // The verification table prints raw variable ids from the published case.
    ['Low L1 is the same system as in the previous briefing. It now reaches the route 3 h earlier.',
      'La dépression L1 est le même système que dans le briefing précédent. Elle atteint désormais la route 3 h plus tôt.'],
    ['Low L2 is the same system as in the previous briefing. It now reaches the route 2 h later.',
      'La dépression L2 est le même système que dans le briefing précédent. Elle atteint désormais la route 2 h plus tard.'],
    // Near-gale is force 7, which French calls "grand frais" (not "close to" it).
    ['L5 Mid-Channel → Finish: near-gale winds while you are on this stretch (Mon 20 Jul 17:28–Tue 21 Jul 04:04 UTC).',
      'L5 milieu de la Manche → Arrivée : vents de grand frais pendant ce tronçon (lun. 20 juil. 17:28–mar. 21 juil. 04:04 UTC).'],
    ['gust_kt', 'rafales (nd)'],
    ['wind_kt', 'vent (nd)'],
    ['wave_height_m', 'hauteur des vagues (m)'],
  ])('%s', (english, french) => {
    expect(fr(english)).toBe(french);
    expect(translateText(english, 'en')).toBe(english);
  });
});
