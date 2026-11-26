// The About page's credits for the fine coastline, shown only while computed routes read it
// (owner-approved wording, 2026-11-26). Here the switch is on; aboutPage.test.jsx keeps it off.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import About from '../src/pages/About.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';

vi.mock('../src/lib/fineLandSwitch.js', () => ({ FINE_LAND_ENABLED: true, FINE_LAND_INDEX: '/data/land/nweu-20260825T07Z' }));

const tiles = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../contracts/forecast-tiles-data-sources.json'), 'utf8'));
const NOTE = {
  en: 'Computed routes in the Channel, Brittany, Biscay and the southern North Sea avoid land as a routing index built from these two sources shows it. EMODnet’s bathymetry is not for navigation, and neither is this index.',
  fr: 'Dans la Manche, en Bretagne, dans le golfe de Gascogne et dans le sud de la mer du Nord, les routes calculées évitent la terre telle que la représente un index de routage construit à partir de ces deux sources. La bathymétrie d’EMODnet n’est pas destinée à la navigation, pas plus que cet index.',
};
const SUMMARY = {
  en: 'Coastline for computed routes · 2 sources · all confirmed',
  fr: /^Trait de côte des routes calculées · 2 sources/,
};

function show(language) {
  useApp.setState({ language, providers: { providers: {} }, loadConfig: vi.fn(async () => {}) });
  return render(<div id="root"><About /><LocalizedDocument language={language} /></div>);
}
afterEach(() => useApp.setState(useApp.getInitialState(), true));

describe.each(['en', 'fr'])('About, with the fine coastline on, in %s', (language) => {
  it('credits GSHHG and EMODnet in a group of their own, with the register’s words and the note', async () => {
    show(language);
    const summary = await screen.findByText(SUMMARY[language]);
    const group = within(summary.closest('details'));
    await waitFor(() => expect(group.getByTestId('source-group-note').textContent).toBe(NOTE[language]));
    const ids = [...summary.closest('details').querySelectorAll('[data-source-id]')].map((item) => item.dataset.sourceId);
    expect(ids).toEqual(['gshhg', 'emodnet-bathymetry']);
    for (const id of ids) {
      const source = tiles.sources.find((s) => s.id === id);
      expect(group.getByText(source.attribution)).toBeTruthy();
      expect(group.getByText(source.licence)).toBeTruthy();
    }
    // The chart-pack inputs stay out.
    expect(document.querySelector('[data-source-id="shom-balisage"]')).toBeNull();
  });
});
