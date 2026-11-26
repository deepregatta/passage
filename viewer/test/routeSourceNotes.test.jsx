import { render, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import RouteSourceNotes from '../src/pages/planner/RouteSourceNotes.jsx';
import { routingCurrentSummary } from '../src/lib/routingInputs.js';

afterEach(cleanup);

const grid = (source, extra = {}) => ({ kind: 'surface_current', run_id: 'run', source, ...extra });
const ibi = grid({ mode: 'live', dataset_id: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m' },
  { under_resolved_note: 'stride-subsampled x2 from native 0.0278 deg to 0.0556 deg (target 0.05 deg); values are exact native cell values, no smoothing' });
const prepared = (currentGrid, record = {}) => ({ grid: currentGrid, provenance: {
  source: 'prepared-artifact', layer: 'currents', model: currentGrid.source.dataset_id, current_source: 'prepared', ...record } });
const tiles = (currentGrid) => ({ grid: currentGrid, provenance: { source: 'tiles', current_source: 'tiles' } });
const UNAVAILABLE = 'Currents unavailable right now. This route uses wind alone.';

// The four results a computed route can show: the summary is built the way the planner builds it.
const cases = {
  prepared: { currents: routingCurrentSummary(prepared(ibi)), notes: [] },
  tiles: { currents: routingCurrentSummary(tiles(grid({ mode: 'live', dataset_id: 'cmems_glo12 tiles (currents-20260720T00Z)' }))), notes: [] },
  emulated: { currents: routingCurrentSummary(prepared(grid({ mode: 'synthetic', dataset_id: 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i' },
    { under_resolved_note: 'native resolution 0.0833 deg is coarser than the 0.05 deg target; native grid kept' }), { source_kind: 'emulated' })), notes: [] },
  none: { currents: routingCurrentSummary(tiles(undefined)), notes: [UNAVAILABLE] },
  // a grid with no dataset id names no model: never a guessed one, and still stamped when synthetic
  unrecorded: { currents: routingCurrentSummary(tiles(grid({ mode: 'synthetic' }))), notes: [] },
};

const expected = {
  en: {
    prepared: ['Currents · Copernicus IBI ocean currents', 'This currents grid is coarser than the model’s native resolution.'],
    tiles: ['Currents · Copernicus global ocean currents'],
    emulated: ['Currents · Copernicus global ocean currents', 'emulated', 'The grid of this currents model is coarser than Passage aims for.'],
    none: [UNAVAILABLE],
    unrecorded: ['Currents · Model not recorded', 'emulated'],
  },
  fr: {
    prepared: ['Courants · Courants océaniques Copernicus IBI', 'Cette grille de courants est plus grossière que la résolution native du modèle.'],
    tiles: ['Courants · Courants océaniques mondiaux Copernicus'],
    emulated: ['Courants · Courants océaniques mondiaux Copernicus', 'simulé', 'La grille de ce modèle de courants est plus grossière que celle visée par Passage.'],
    none: ['Courants indisponibles pour le moment. Cette route utilise uniquement le vent.'],
    unrecorded: ['Courants · Modèle non enregistré', 'simulé'],
  },
};

describe.each(['en', 'fr'])('computed route current source in %s', (language) => {
  it.each(Object.keys(cases))('%s', async (kind) => {
    const view = render(<div id="root"><RouteSourceNotes computed={cases[kind]} /><LocalizedDocument language={language} /></div>);
    const text = view.container.textContent.replace(/\s+/g, ' ');
    if (language === 'fr') await waitFor(() => expect(view.container.textContent.replace(/\s+/g, ' ')).toContain(expected.fr[kind][0]));
    for (const part of expected[language][kind]) expect(view.container.textContent.replace(/\s+/g, ' ')).toContain(part);
    const line = view.queryByTestId('route-currents');
    expect(Boolean(line)).toBe(kind !== 'none');
    expect(view.container.querySelectorAll('.stamp-emulated')).toHaveLength(kind === 'emulated' || kind === 'unrecorded' ? 1 : 0);
    expect(text).not.toMatch(/tidal stream|stride-subsampled|native grid kept/i);
  });
});

it('shows only the navigation caution for a result saved before routes recorded their current source', () => {
  const view = render(<RouteSourceNotes computed={{ notes: [] }} />);
  expect(view.container.children).toHaveLength(1);
  expect(view.getByTestId('route-not-for-navigation')).toBeInTheDocument();
});

// A computed route is checked only against a coarse land outline (owner-approved wording, 2026-11-25).
const NOT_FOR_NAVIGATION = {
  en: 'Not for navigation. This route avoids only a coarse outline of the coast: rocks, shoals and small islands are not in it. Check it on a chart before you sail it.',
  fr: 'Pas pour la navigation. Cette route n’évite qu’un tracé approximatif de la côte\u00A0: les rochers, les hauts-fonds et les petites îles n’y figurent pas. Vérifiez-la sur une carte avant de la suivre.',
};

describe.each(['en', 'fr'])('the navigation caution under a computed route in %s', (language) => {
  it.each(Object.keys(cases))('is the first line, in the caution style, with a %s current result', async (kind) => {
    const view = render(<div id="root"><RouteSourceNotes computed={cases[kind]} /><LocalizedDocument language={language} /></div>);
    await waitFor(() => expect(view.getByTestId('route-not-for-navigation').textContent).toBe(NOT_FOR_NAVIGATION[language]));
    const line = view.getByTestId('route-not-for-navigation');
    expect(line.parentElement.firstElementChild).toBe(line);
    expect(line.className).toContain('text-[13px]');
    expect(line.className).toContain('border-l-2');
    expect(line.className).toContain('border-ink/50');
    expect(line.className).toContain('pl-2');
    expect(view.getAllByTestId('route-not-for-navigation')).toHaveLength(1);
    expect(line.textContent).not.toMatch(/deepweather|\bbest\b|probab/i);
    expect(line.textContent).not.toMatch(/\bGO\b/);
  });

  it('is shown for a confined route too, still first', async () => {
    const view = render(<div id="root"><RouteSourceNotes computed={computedRoute(confined)} /><LocalizedDocument language={language} /></div>);
    await waitFor(() => expect(view.getByTestId('route-not-for-navigation').textContent).toBe(NOT_FOR_NAVIGATION[language]));
    expect(view.getByTestId('route-not-for-navigation').parentElement.firstElementChild).toBe(view.getByTestId('route-not-for-navigation'));
    expect(view.getByTestId('route-confined')).toBeInTheDocument();
  });
});

it('translates the new sentences in the catalogue', () => {
  for (const kind of ['prepared', 'emulated']) {
    const english = expected.en[kind].at(-1);
    expect(translateText(english, 'fr')).toBe(expected.fr[kind].at(-1));
  }
});

// A route the engine confined to the prepared grid's box records the area it searched (C1, 2026-11-13).
const CONFINED = {
  en: 'Routed inside the area the regional current model covers; the route could not go outside it.',
  fr: 'Route calculée à l’intérieur de la zone couverte par le modèle régional de courants ; elle ne pouvait pas en sortir.',
};
const computedRoute = (request) => ({ currents: routingCurrentSummary(prepared(ibi)), notes: [],
  route: { mode: 'computed', provenance: { engine_version: 'grid-dijkstra-v1', routing_request: request } } });
const confined = { current_source: 'prepared', current_digest: 'abc', search_bounds: { minLat: 49.4, maxLat: 49.5, minLon: -3.5, maxLon: -3.2 } };

describe.each(['en', 'fr'])('a route confined to the regional current model in %s', (language) => {
  it('says so in one whole line', async () => {
    const view = render(<div id="root"><RouteSourceNotes computed={computedRoute(confined)} /><LocalizedDocument language={language} /></div>);
    await waitFor(() => expect(view.getByTestId('route-confined').textContent).toBe(CONFINED[language]));
    expect(view.container.textContent).not.toMatch(/tidal stream|\bbest\b|probab/i);
    expect(view.container.textContent).not.toMatch(/\bGO\b/);
  });

  it.each([
    ['routed on the prepared grid without being confined', { current_source: 'prepared', current_digest: 'abc' }],
    ['routed on tiles', { current_run: 'tiles-run' }],
  ])('says nothing for a route %s', async (_, request) => {
    const view = render(<div id="root"><RouteSourceNotes computed={computedRoute(request)} /><LocalizedDocument language={language} /></div>);
    await waitFor(() => expect(view.getByTestId('route-currents')).toBeInTheDocument());
    expect(view.queryByTestId('route-confined')).toBeNull();
    expect(view.container.textContent).not.toContain(language === 'fr' ? 'elle ne pouvait pas en sortir' : 'could not go outside');
  });
});

// When the prepared regional grid was fetched, and a caution once it is old (2026-11-14).
describe.each(['en', 'fr'])('the age of the prepared current grid in %s', (language) => {
  const FETCHED = '2026-11-14T03:22:00Z';
  const withGrid = (extra, source = 'prepared') => ({
    notes: [], currents: routingCurrentSummary(source === 'prepared'
      ? prepared({ ...ibi, ...extra }) : tiles({ ...ibi, ...extra })),
  });
  const show = async (computed, nowMs) => {
    const view = render(<div id="root"><RouteSourceNotes computed={computed} nowMs={nowMs} /><LocalizedDocument language={language} /></div>);
    await waitFor(() => expect(view.getByTestId('route-currents').textContent).toContain(language === 'fr' ? 'Courants' : 'Currents'));
    return view;
  };
  const hours = (n) => Date.parse(FETCHED) + n * 3600_000;
  const withFetch = { source: { ...ibi.source, fetched_at: FETCHED } };
  const LINE = {
    en: 'Currents fetched Sat 14 Nov 04:22 local time, 2 h ago',
    fr: 'Courants récupérés le sam. 14 nov. 04:22 (heure locale), il y a 2 h',
  };
  const CAUTION = {
    en: 'These currents were fetched Sat 14 Nov 04:22 local time, 3 days ago.',
    fr: 'Ces courants ont été récupérés le sam. 14 nov. 04:22 (heure locale), il y a 3 jours.',
  };

  it('states the fetch time and age under the currents line of a route on the prepared grid', async () => {
    const view = await show(withGrid(withFetch), hours(2));
    await waitFor(() => expect(view.getByTestId('route-currents-age').textContent).toBe(LINE[language]));
    expect(view.getByTestId('route-currents-age')).toHaveAttribute('data-stale', 'false');
    expect(view.container.textContent).not.toMatch(/tidal stream|\bbest\b|probab|deepweather/i);
  });

  it('shows the same facts as a caution in the notice style when the grid is over 24 h old', async () => {
    const view = await show(withGrid(withFetch), hours(72));
    await waitFor(() => expect(view.getByTestId('route-currents-age').textContent).toBe(CAUTION[language]));
    const line = view.getByTestId('route-currents-age');
    expect(line).toHaveAttribute('data-stale', 'true');
    expect(line.className).toContain('border-l-2');
    expect(view.getAllByTestId('route-currents-age')).toHaveLength(1);
  });

  it('falls back to the grid’s generation time, and shows nothing when no time reads', async () => {
    const generated = await show(withGrid({ source: ibi.source, generated_at: FETCHED }), hours(2));
    await waitFor(() => expect(generated.getByTestId('route-currents-age').textContent).toBe(LINE[language]));
    cleanup();
    const none = await show(withGrid({ source: { ...ibi.source, fetched_at: 'unknown' }, generated_at: undefined }), hours(2));
    expect(none.queryByTestId('route-currents-age')).toBeNull();
  });

  it('says nothing for tile currents, which have no prepared grid', async () => {
    const view = await show(withGrid(withFetch, 'tiles'), hours(72));
    expect(view.queryByTestId('route-currents-age')).toBeNull();
  });
});

// On the fine routing index (owner-approved wording, 2026-11-26): what the route avoids, and that the grid can be wrong.
const FINE_NOT_FOR_NAVIGATION = {
  en: 'Not for navigation. This route avoids land and areas that dry at low tide as a 230 m grid shows them, with a margin of about 200 m; the grid can be wrong, and single rocks and shallows that do not dry are not in it. Check it on a chart before you sail it.',
  fr: 'Pas pour la navigation. Cette route évite la terre et les zones qui découvrent à basse mer telles qu’une grille de 230 m les représente, avec une marge d’environ 200 m\u00A0; la grille peut être fausse, et les roches isolées et les petits fonds qui ne découvrent pas n’y figurent pas. Vérifiez-la sur une carte avant de la suivre.',
};

describe.each(['en', 'fr'])('the navigation caution under a route computed on the fine routing index in %s', (language) => {
  it('says what the fine grid avoids, and only for a route that recorded it', async () => {
    const fine = { notes: [], route: { provenance: { routing_request: { land_index: 'nweu-20260825T07Z' } } } };
    const view = render(<div id="root"><RouteSourceNotes computed={fine} /><LocalizedDocument language={language} /></div>);
    await waitFor(() => expect(view.getByTestId('route-not-for-navigation').textContent).toBe(FINE_NOT_FOR_NAVIGATION[language]));
    view.unmount();
    const outline = { notes: [], route: { provenance: { routing_request: {} } } };
    const other = render(<div id="root"><RouteSourceNotes computed={outline} /><LocalizedDocument language={language} /></div>);
    await waitFor(() => expect(other.getByTestId('route-not-for-navigation').textContent).toBe(NOT_FOR_NAVIGATION[language]));
  });
});
