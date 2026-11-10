import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { useApp } from '../src/stores/appStore.js';
import { COPY, documentTitle } from '../src/metadata.js';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null, Rectangle: () => null,
  useMap: () => ({ fitBounds: () => {} }), useMapEvents: vi.fn(),
}));
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => <div data-testid="passage-map" /> }));
vi.mock('../src/lib/analytics.js', () => ({ track: vi.fn(), trackOnce: vi.fn(), withUtm: (href) => href }));
vi.mock('../src/lib/forecastStore.js', () => ({
  forecastStore: () => ({ init: async () => { throw new Error('offline'); }, manifestFor: () => null }),
  friendlyForecastError: () => new Error('offline'),
}));

const SNAPSHOT = '20260720T060000Z_44d2cd5f_64ea971e';
const LANDING = `${COPY.en.title} | DeepRegatta`;

beforeEach(() => {
  window.scrollTo = vi.fn();
  localStorage.clear();
  document.title = LANDING;
});
afterEach(() => {
  history.replaceState(null, '', '/');
  useApp.setState(useApp.getInitialState(), true);
  document.documentElement.lang = 'en';
});

function show(page, language = 'en', hash = page) {
  history.replaceState(null, '', `/#${hash}`);
  useApp.setState({ language, page });
  return render(<App />);
}
const title = () => document.title;

describe('document titles', () => {
  it.each([
    ['passages', 'en', 'My passages · Passage by DeepRegatta'],
    ['passages', 'fr', 'Mes traversées · Passage par DeepRegatta'],
    ['about', 'en', 'About the data · Passage by DeepRegatta'],
    ['about', 'fr', 'À propos des données · Passage par DeepRegatta'],
    ['example', 'en', 'Example passage · Passage by DeepRegatta'],
    ['example', 'fr', 'Exemple de traversée · Passage par DeepRegatta'],
  ])('%s in %s', async (page, language, expected) => {
    show(page, language);
    await waitFor(() => expect(title()).toBe(expected));
  });

  it('keeps the product title on the planner and the standalone titles on GRIB and privacy', () => {
    expect(documentTitle('en', 'planner')).toBe(LANDING);
    expect(documentTitle('fr', 'planner')).toBe(`${COPY.fr.title} | DeepRegatta`);
    expect(documentTitle('en', 'grib')).toBe('Free GRIB files: wind, waves and currents | Passage');
    expect(documentTitle('fr', 'privacy')).toBe('Politique de confidentialité | Passage');
  });

  it('every in-app page has a title of its own', () => {
    const titles = ['planner', 'passages', 'briefing', 'example', 'about', 'grib', 'privacy'].map((page) => documentTitle('en', page));
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('names the passage and its departure date on the passage page, and updates on language change', async () => {
    history.replaceState(null, '', '/#passage');
    useApp.setState({ language: 'en', page: 'briefing' });
    await useApp.getState().openSnapshot(SNAPSHOT, null, 'briefing', 'served');
    render(<App />);
    await waitFor(() => expect(title()).toBe('Cherbourg → Plymouth breakwater, departing 20 Jul · Passage by DeepRegatta'));
    act(() => useApp.getState().setLanguage('fr'));
    await waitFor(() => expect(title()).toBe('Cherbourg → brise-lames de Plymouth, départ le 20 juil. · Passage par DeepRegatta'));
    expect(document.documentElement.lang).toBe('fr');
  });

  it('says "Passage briefing" while the passage has not loaded', async () => {
    show('briefing');
    useApp.setState({ findings: null, loading: true });
    await waitFor(() => expect(title()).toBe('Passage briefing · Passage by DeepRegatta'));
  });

  it('follows in-app navigation', async () => {
    show('about');
    await waitFor(() => expect(title()).toBe('About the data · Passage by DeepRegatta'));
    act(() => useApp.getState().setPage('passages'));
    await waitFor(() => expect(title()).toBe('My passages · Passage by DeepRegatta'));
    act(() => useApp.getState().setPage('planner'));
    await waitFor(() => expect(title()).toBe(LANDING));
  });

  it('keeps no "deepweather" in any title', () => {
    for (const language of ['en', 'fr']) {
      for (const page of ['planner', 'passages', 'briefing', 'example', 'about', 'grib', 'privacy']) {
        expect(documentTitle(language, page).toLowerCase()).not.toContain('deepweather');
      }
    }
  });
});
