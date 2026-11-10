import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import About from '../src/pages/About.jsx';
import Privacy from '../src/pages/Privacy.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';

const real = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../config/providers.json'), 'utf8'));
const PROVIDERS = {
  providers: {
    forecast_tiles: { mode: 'live' },
    warnings_meteoalarm: { mode: 'live' },
    ecmwf_open_data: { mode: 'live' },
    tides: { mode: 'fixture' },
    observations: { mode: 'synthetic' },
    wind_lab_feed: { mode: 'live' },
  },
};

function show(language = 'en', providers = PROVIDERS) {
  useApp.setState({ language, providers, loadConfig: vi.fn(async () => {}) });
  return render(<div id="root"><About /><LocalizedDocument language={language} /></div>);
}
const row = (name) => screen.getByText(name).closest('li');

afterEach(() => useApp.setState(useApp.getInitialState(), true));

describe('About: data providers', () => {
  it('shows readable provider names with their mode, never the raw ids', () => {
    show();
    const list = within(screen.getByRole('heading', { name: 'Data providers' }).closest('section'));
    expect(within(row('Forecast tiles (NOAA, ECMWF, Copernicus)')).getByText('live')).toBeTruthy();
    expect(within(row('Weather warnings (Meteoalarm)')).getByText('live')).toBeTruthy();
    expect(within(row('ECMWF open data')).getByText('live')).toBeTruthy();
    expect(within(row('Tide data')).getByText('fixture')).toBeTruthy();
    for (const id of ['forecast_tiles', 'warnings_meteoalarm', 'ecmwf_open_data']) expect(list.queryByText(id)).toBeNull();
  });

  it('keeps the emulated badge on synthetic feeds', () => {
    show();
    expect(row('Observations (buoys and moorings)').querySelector('.stamp-emulated')).toBeTruthy();
  });

  it('humanises a provider id it does not know instead of printing the raw id', () => {
    show();
    expect(row('Wind lab feed')).toBeTruthy();
    expect(screen.queryByText('wind_lab_feed')).toBeNull();
  });

  it('names every provider in the real configuration without underscores', () => {
    show('en', real);
    const names = screen.getAllByRole('listitem').map((item) => item.firstChild.textContent);
    expect(names.length).toBeGreaterThanOrEqual(Object.keys(real.providers).length);
    expect(names).toContain('Weather warnings (Meteoalarm)');
    for (const text of names) expect(text).not.toMatch(/_/);
  });

  it('translates names and modes in French and restores English', async () => {
    const view = show('fr');
    await waitFor(() => expect(screen.getByText('Tuiles de prévision (NOAA, ECMWF, Copernicus)')).toBeTruthy());
    expect(within(row('Données ouvertes ECMWF')).getByText('direct')).toBeTruthy();
    expect(within(row('Données de marée')).getByText('jeu de test')).toBeTruthy();
    view.rerender(<div id="root"><About /><LocalizedDocument language="en" /></div>);
  });
});

describe('About: wording and size', () => {
  it('does not cite an internal brief section', () => {
    const { container } = show();
    expect(container.textContent).not.toMatch(/brief §|spécification §/);
    expect(container.textContent).toContain('not independent ground truth');
  });

  it('cites no brief section in French either', async () => {
    const { container } = show('fr');
    await waitFor(() => expect(container.textContent).toContain('vérité terrain indépendante'));
    expect(container.textContent).not.toMatch(/brief §|spécification §/);
  });

  it('uses no text under 12px and raises the shared eyebrow and stamp sizes on this page', () => {
    const { container } = show();
    expect(container.innerHTML).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
    expect(container.firstChild.firstChild).toHaveClass('min-text-12');
  });

  it('keeps the privacy page free of sub-12px text and gives its links a phone tap height', () => {
    useApp.setState({ language: 'en' });
    const { container } = render(<Privacy />);
    expect(container.innerHTML).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
    const links = [...container.querySelectorAll('a')];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.className).toMatch(/min-h-11/);
  });
});
