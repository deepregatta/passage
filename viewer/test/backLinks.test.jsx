import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { useApp } from '../src/stores/appStore.js';

// The map and chart libraries are not under test; Grib only needs its own page chrome here.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null, Rectangle: () => null,
  useMap: () => ({ fitBounds: () => {}, eachLayer: () => {}, on: () => {}, off: () => {} }), useMapEvents: vi.fn(),
}));
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => <div data-testid="passage-map" /> }));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn(), trackOnce: vi.fn(), withUtm: (href) => href }));
vi.mock('../src/lib/forecastStore.js', () => ({
  forecastStore: () => ({
    init: async () => { throw new Error('offline'); },
    manifestFor: () => null,
  }),
  friendlyForecastError: () => new Error('offline'),
}));

const SNAPSHOT = '20260720T060000Z_44d2cd5f_64ea971e';

function show(page, language = 'en', path = '/') {
  history.replaceState(null, '', `${path}${path.includes('#') ? '' : `#${page === 'planner' ? 'plan' : page}`}`);
  useApp.setState({ language, page });
  return render(<App />);
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  localStorage.clear();
});
afterEach(() => {
  history.replaceState(null, '', '/');
  useApp.setState(useApp.getInitialState(), true);
  document.documentElement.lang = 'en';
});

const backLink = (name) => screen.findByRole('link', { name });

describe('back links', () => {
  it('About returns to Plan', async () => {
    const user = userEvent.setup();
    show('about');
    const link = await backLink('Back to Plan');
    expect(link.className).toMatch(/min-h-11/);
    await user.click(link);
    expect(useApp.getState().page).toBe('planner');
    expect(location.hash).toBe('#plan');
  });

  it('Privacy returns to Plan, from the hash route and from the standalone /privacy page', async () => {
    const user = userEvent.setup();
    const hash = show('privacy');
    await user.click(await backLink('Back to Plan'));
    expect(useApp.getState().page).toBe('planner');
    hash.unmount();

    history.replaceState(null, '', '/privacy');
    useApp.setState({ language: 'en', page: 'privacy' });
    render(<App />);
    await user.click(await backLink('Back to Plan'));
    expect(useApp.getState().page).toBe('planner');
    expect(location.pathname).toBe('/');
    expect(location.hash).toBe('#plan');
  });

  it('Privacy in French returns to the French Plan', async () => {
    const user = userEvent.setup();
    history.replaceState(null, '', '/fr/privacy');
    useApp.setState({ language: 'fr', page: 'privacy' });
    render(<App />);
    await user.click(await backLink('Retour à Planifier'));
    expect(useApp.getState().page).toBe('planner');
    expect(location.pathname).toBe('/fr/');
  });

  it('GRIB returns to Plan and keeps Plan marked as the current place', async () => {
    const user = userEvent.setup();
    show('grib', 'en', '/#plan/grib');
    const link = await backLink('Back to Plan');
    // the Plan place stays current on the GRIB page, in both navigations
    const plan = screen.getAllByRole('button', { name: 'Plan' });
    expect(plan.length).toBe(2);
    for (const button of plan) expect(button).toHaveAttribute('aria-current', 'page');
    await user.click(link);
    expect(useApp.getState().page).toBe('planner');
  });

  it('the passage page returns to My passages', async () => {
    const user = userEvent.setup();
    history.replaceState(null, '', '/#passage');
    useApp.setState({ language: 'en', page: 'briefing' });
    await useApp.getState().openSnapshot(SNAPSHOT, null, 'briefing', 'served');
    render(<App />);
    const link = await backLink('My passages');
    expect(link.className).toMatch(/min-h-11/);
    await user.click(link);
    expect(useApp.getState().page).toBe('passages');
    await waitFor(() => expect(location.hash).toBe('#passages'));
  });

  it('is plain text with an arrow that screen readers skip', async () => {
    show('about');
    const link = await backLink('Back to Plan');
    expect(link.textContent).toBe('←Back to Plan');
    expect(link.querySelector('[aria-hidden="true"]')?.textContent).toBe('←');
  });
});
