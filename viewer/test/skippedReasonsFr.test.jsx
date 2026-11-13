// "Unassessed departures" shows each skipped departure's reason; the French page must translate every
// reason the planner can produce, and the time-zone fallback must read French wherever a zone is shown.
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CurrentGapError, OUTSIDE_SCAN_CURRENT, OUTSIDE_SELECTED_CURRENT, SearchBoundsError } from '@deepweather/engine';
import DepartureComparison from '../src/pages/planner/DepartureComparison.jsx';
import { routedOutcome } from '../src/lib/routingInputs.js';
import { localTimeZoneName } from '../src/lib/format.js';
import { plumeAriaLabel, modelComparisonAriaLabel, timeZoneAxisName } from '../src/lib/chartTime.js';
import { passageText } from '../src/lib/passages.js';
import { translateText } from '../src/i18n.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const fr = (text) => translateText(text, 'fr');
const ENGLISH = /\b(the|this|departure time|current grid|forecast horizon|found|within|is on land|local time|browser|router reads)\b/i;

let missingRouting;
try { routedOutcome(new Map(), 'x'); } catch (error) { missingRouting = error.message; }

// [English reason, French]. Sources: engine window.ts (OUTSIDE_SCAN_CURRENT and error messages of routing and analysis),
// currentInput.ts (OUTSIDE_SELECTED_CURRENT), isochrone.ts (CurrentGapError, no route, land), routingInputs.js.
const REASONS = [
  [OUTSIDE_SCAN_CURRENT, 'Cette heure de départ sort de la grille de courants utilisée pour le reste de la comparaison.'],
  [OUTSIDE_SELECTED_CURRENT, 'La route de cette heure de départ sort de la grille de courants utilisée pour le reste de la comparaison.'],
  [new CurrentGapError().message, 'La grille de courants ne couvre pas tous les points et instants lus par le routeur'],
  [missingRouting, 'Aucune route n’a pu être calculée pour ce départ.'],
  ['This departure is beyond the forecast horizon', 'Ce départ dépasse l’horizon des prévisions'],
  ['No route found within 48 h (wind coverage, land, or no-go conditions)', 'Aucune route trouvée en 48 h (couverture du vent, terre ou conditions impraticables)'],
  // A later departure of a comparison on a prepared grid keeps this error (selectComparisonCurrent).
  [new SearchBoundsError('no-route').message, 'Aucune route trouvée dans la zone de recherche autorisée'],
  ['Start or finish is on land', 'Le départ ou l’arrivée se trouve à terre'],
  ['No sea node near start/finish', 'Aucun point en mer près du départ ou de l’arrivée'],
  ['Route is outside the coastline mask', 'La route se trouve hors du masque côtier'],
  ['Forecast tiles unavailable for this area', 'Tuiles de prévision indisponibles pour cette zone'],
  ['Unknown error', 'Erreur inconnue'],
];

it.each(REASONS)('says the skip reason %j in French', (english, french) => {
  expect(fr(english)).toBe(french);
});

// Never a skip reason today (an end outside the grid moves the whole action to tiles), translated all the same.
it('says the router\'s other search-area message in French', () => {
  expect(fr(new SearchBoundsError('endpoint-outside').message)).toBe('Le départ ou l’arrivée est hors de la zone de recherche autorisée');
});

it('shows the reasons in French when rendered in the unassessed list', () => {
  const scan = { candidates: [], skipped: REASONS.map(([reason], i) => ({ departure_utc: `2026-11-13T${String(i).padStart(2, '0')}:00:00Z`, reason })) };
  const { container } = render(<DepartureComparison scan={scan} departureLocal="2026-11-13T19:00" busy={null} disabled={false} onPick={() => {}} />);
  const shown = [...container.querySelectorAll('li span')].map((span) => fr(span.textContent));
  expect(shown).toEqual(REASONS.map(([, french]) => french));
  for (const text of shown) expect(text).not.toMatch(ENGLISH);
});

it('names the browser-local fallback zone in French wherever a zone is shown', () => {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ locale: 'en', timeZone: '' });
  const zone = localTimeZoneName();
  expect(zone).toBe('browser local time');
  const composed = [
    ['local time · browser local time', 'heure locale · fuseau du navigateur', timeZoneAxisName()],
    ['zone alone (departure field, ruler, briefing band)', 'fuseau du navigateur', zone],
    ['local time (browser local time) · within limits', 'heure locale (fuseau du navigateur) · dans les limites', `local time (${zone}) · within limits`],
    ['24-hour local time · browser local time · same route, different weather',
      'heure locale au format 24 heures · fuseau du navigateur · même route, météo différente', `24-hour local time · ${zone} · same route, different weather`],
    ['24-hour clock (HH:mm) · your local time · browser local time', 'format 24 heures (HH:mm) · votre heure locale · fuseau du navigateur', `24-hour clock (HH:mm) · your local time · ${zone}`],
    ['Departing … local time (zone).', 'Départ ven. 13 nov. 19:00, heure locale (fuseau du navigateur).', fr(passageText('Departing {time} local time ({tz}).', { time: 'Fri 13 Nov 19:00', tz: zone }, 'fr'))],
  ];
  for (const [label, french, english] of composed) expect(fr(english), label).toBe(french);
  const plume = fr(plumeAriaLabel({ members: 31, variable: 'gust', startMs: Date.parse('2026-11-13T18:00:00Z'), endMs: Date.parse('2026-11-14T18:00:00Z'), limit: 30, units: 'kt' }));
  const models = fr(modelComparisonAriaLabel({ modelNames: ['GFS', 'ECMWF'], startMs: Date.parse('2026-11-13T18:00:00Z'), endMs: Date.parse('2026-11-14T18:00:00Z'), divergentHours: 3 }));
  for (const text of [plume, models]) {
    expect(text).toContain('heure locale fuseau du navigateur');
    expect(text).not.toMatch(/browser local time|local time/);
  }
});
