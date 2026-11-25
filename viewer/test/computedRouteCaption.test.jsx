import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PassageChart from '../src/pages/briefing/PassageChart.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { isComputedRoute } from '../src/lib/routeOrigin.js';
import { useApp } from '../src/stores/appStore.js';
import fixedRoute from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/route.json';

vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => <div data-testid="map" /> }));
vi.mock('../src/components/SynopticHero.jsx', () => ({ default: () => <div data-testid="pressure-chart" /> }));

afterEach(cleanup);
beforeEach(() => useApp.setState({ ...useApp.getInitialState(), route: null }, true));

// What the router writes (engine/src/routing/isochrone.ts) and the planner saves unchanged as route.json.
const computed = {
  schema_version: 1, route_id: 'computed-2026071908-sun-fast-3200', name: 'Cherbourg → Plymouth (computed)', mode: 'computed',
  waypoints: [{ id: 'wp1', lat: 49.65, lon: -1.62 }, { id: 'wp2', lat: 50.36, lon: -4.14 }],
  speeds_kt: { slow: 4, nominal: 5, fast: 6 }, timing: { basis: 'routed' },
  provenance: { engine_version: 'grid-dijkstra-v1', routing_request: { departure: '2026-07-19T08:00:00Z', polar_id: 'sun-fast-3200' } },
};
const drawn = { schema_version: 1, route_id: 'my-crossing-3wp', name: 'My crossing', mode: 'user',
  waypoints: computed.waypoints, speeds_kt: computed.speeds_kt, timing: { basis: 'through_water' } };

describe('which saved routes were computed', () => {
  it('reads the route mode together with the router request the route records', () => {
    expect(isComputedRoute(computed)).toBe(true);
    // a route the planner saved after the sailor renamed it, or one routed for a departure comparison, keeps both
    expect(isComputedRoute({ ...computed, passage_id: 'p-1', name: 'Home' })).toBe(true);
  });

  it.each([
    ['a drawn or GPX-imported route (mode user)', drawn],
    ['a fixed route, as every committed example and compatibility check holds', fixedRoute],
    ['a drawn route whose id happens to start with computed-', { ...drawn, route_id: 'computed-by-hand' }],
    ['mode computed with no router request recorded', { ...computed, provenance: undefined }],
    ['mode computed with an empty provenance', { ...computed, provenance: {} }],
    ['a router request on a route whose mode is not computed', { ...drawn, provenance: computed.provenance }],
    ['a router request that is not an object', { ...computed, provenance: { routing_request: 'yes' } }],
    ['no route', null],
    ['an unreadable route', 'computed'],
  ])('says nothing for %s', (_, route) => {
    expect(isComputedRoute(route)).toBe(false);
  });
});

const CAPTION = { en: 'Computed route · not for navigation', fr: 'Route calculée · pas pour la navigation' };

describe.each(['en', 'fr'])('the check page chart in %s', (language) => {
  const show = (route, hasSynoptic) => {
    useApp.setState({ route, language });
    return render(<div id="root"><PassageChart hasSynoptic={hasSynoptic} /><LocalizedDocument language={language} /></div>);
  };

  it.each([[false, 'the route map alone'], [true, 'the pressure chart and route map']])(
    'captions a computed route (%s: %s)', async (hasSynoptic) => {
      show(computed, hasSynoptic);
      await waitFor(() => expect(screen.getByTestId('route-computed-note').textContent).toBe(CAPTION[language]));
      expect(screen.getAllByTestId('route-computed-note')).toHaveLength(1);
      // it prints with the chart: nothing hides it from print
      expect(screen.getByTestId('route-computed-note').closest('[data-print-hide]')).toBeNull();
      expect(screen.getByTestId('route-computed-note').textContent).not.toMatch(/deepweather|\bbest\b|probab|\bGO\b/i);
      if (hasSynoptic) {
        fireEvent.click(screen.getByRole('button', { name: language === 'fr' ? /Carte de la route/ : 'Route map' }));
        expect(screen.getByTestId('map')).toBeInTheDocument();
        expect(screen.getByTestId('route-computed-note').textContent).toBe(CAPTION[language]);
      }
    });

  it.each([
    ['a drawn route', drawn],
    ['a fixed route', fixedRoute],
    ['a check that cannot tell (mode computed, no request recorded)', { ...computed, provenance: undefined }],
    ['a check with no route file', null],
  ])('shows nothing for %s', async (_, route) => {
    show(route, false);
    await waitFor(() => expect(screen.getByTestId('map')).toBeInTheDocument());
    expect(screen.queryByTestId('route-computed-note')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/not for navigation|pas pour la navigation/i);
  });
});
