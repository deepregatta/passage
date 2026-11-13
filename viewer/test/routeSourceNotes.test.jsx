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

it('shows nothing for a result saved before routes recorded their current source', () => {
  const view = render(<RouteSourceNotes computed={{ notes: [] }} />);
  expect(view.container.textContent).toBe('');
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
