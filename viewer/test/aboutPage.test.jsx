import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import About from '../src/pages/About.jsx';
import SourceTerms, { SourceGroup } from '../src/components/SourceTerms.jsx';
import { ARRANGEMENT_SOURCES, groupSummary } from '../src/lib/dataSources.js';
import Privacy from '../src/pages/Privacy.jsx';
import { LocalizedDocument, localizeNotationFr, translateText } from '../src/i18n.js';
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

describe('About: terms for each source', () => {
  const tiles = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../contracts/forecast-tiles-data-sources.json'), 'utf8'));
  const own = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../config/data-sources.json'), 'utf8'));
  const card = (id) => document.querySelector(`[data-source-id="${id}"]`);
  const value = (element, label) => within(element).getByText(label).nextElementSibling;

  it('shows every Passage source from both registers, and not the routing-index or chart-pack inputs', () => {
    show();
    const shown = [...document.querySelectorAll('[data-source-id]')].map((item) => item.dataset.sourceId);
    const passageSources = tiles.sources.filter((s) => s.used_by.some((u) => !['land', 'charts'].includes(u)));
    expect(shown).toEqual([...passageSources, ...own.sources].map((s) => s.id));
    for (const hidden of ['gshhg', 'openstreetmap', 'protomaps-basemap', 'open-waters-seamap', 'shom-balisage', 'emodnet-bathymetry']) {
      expect(card(hidden)).toBeNull();
    }
  });

  it('shows the recorded licence, attribution, share-alike, redistribution answer and verified date of UKV', () => {
    show();
    const ukv = card('metoffice-ukv');
    expect(value(ukv, 'Licence').textContent).toBe('CC BY-SA 4.0');
    expect(value(ukv, 'Attribution').textContent).toMatch(/^British Crown copyright, Met Office UKV via Open-Meteo/);
    expect(value(ukv, 'Verified on').textContent).toBe('2026-11-12');
    expect(value(ukv, 'Share-alike').textContent).toBe('Yes, adapted data keep the same licence');
    expect(value(ukv, 'Redistribution').textContent).toBe('Yes, under the licence');
  });

  it('reads an unconfirmed source plainly as not yet confirmed, never as permission', () => {
    show();
    // Passage's own tile service is the only entry the registers leave unconfirmed.
    const service = card('forecast-tiles-service');
    for (const label of ['Licence', 'Attribution', 'Redistribution']) expect(value(service, label).textContent).toBe('Not yet confirmed');
    expect(value(service, 'Verified on').textContent).toBe('Not yet verified');
    expect(service.textContent).not.toMatch(/\b(?:Yes|permitted|allowed|free to)\b/i);
    for (const item of document.querySelectorAll('[data-source-id]')) {
      const source = [...tiles.sources, ...own.sources].find((s) => s.id === item.dataset.sourceId);
      if (source.redistribute === 'unconfirmed') {
        expect(value(item, 'Redistribution').textContent, source.id).toBe('Not yet confirmed');
      }
    }
  });

  it('shows a licence that is recorded but whose redistribution is unconfirmed without reading as permission', () => {
    // A fixture: the registers no longer hold this combination.
    const { container } = render(<SourceTerms sources={[{
      id: 'fixture', name: 'Fixture', provider: 'Fixture', licence: 'CC BY 4.0', attribution: null,
      share_alike: null, redistribute: 'unconfirmed', verified_on: null,
    }]} />);
    expect(within(container).getByText('Licence').nextElementSibling.textContent).toBe('CC BY 4.0');
    expect(within(container).getByText('Redistribution').nextElementSibling.textContent).toBe('Not yet confirmed');
  });

  it('keeps "Not yet verified" for the entries confirmed on the owner’s decision with no provider page read', () => {
    show();
    for (const id of ['meteofrance-arome', 'ndbc-observations', 'world-port-index']) {
      const item = card(id);
      expect(value(item, 'Redistribution').textContent, id).toBe('Yes, under the licence');
      expect(value(item, 'Verified on').textContent, id).toBe('Not yet verified');
    }
    const arome = card('meteofrance-arome');
    expect(value(arome, 'Licence').textContent).toBe('CC BY 4.0 (Open-Meteo bulk catalogue); Météo-France open data');
    expect(value(arome, 'Attribution').textContent).toBe('Météo-France AROME via Open-Meteo; CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); modified: converted and quantized data');
    expect(arome.querySelector('time')).toBeNull();
  });

  it('shows what the owner confirmed on 12 November 2026: licence, redistribution and verified date', () => {
    show();
    const gfs = card('noaa-gfs');
    expect(value(gfs, 'Licence').textContent).toBe('US Government work, public domain');
    expect(value(gfs, 'Redistribution').textContent).toBe('Yes, under the licence');
    expect(value(gfs, 'Verified on').textContent).toBe('2026-11-12');
    const ecmwf = card('ecmwf-open-ifs');
    expect(value(ecmwf, 'Attribution').textContent).toBe('This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF); ECMWF open data; CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); modified: converted and quantized data');
    const era5 = card('era5-reanalysis');
    expect(value(era5, 'Licence').textContent).toBe('CC BY 4.0');
    expect(value(era5, 'Redistribution').textContent).toBe('Yes, under the licence');
  });

  it('shows the credits the recorded terms give for Copernicus Marine, ERA5, Météo-France bulletins and the Queensland feeds', () => {
    show();
    const attribution = (id) => value(card(id), 'Attribution').textContent;
    expect(attribution('cmems-glo12')).toBe('Generated using E.U. Copernicus Marine Service Information; doi:10.48670/moi-00016; modified: converted and quantized data');
    expect(attribution('cmems-ibi')).toBe('Generated using E.U. Copernicus Marine Service Information; doi:10.48670/moi-00027; modified: converted and quantized data');
    expect(attribution('copernicus-marine-currents')).toBe('Generated using E.U. Copernicus Marine Service Information; doi:10.48670/moi-00027 (IBI), doi:10.48670/moi-00016 (global analysis and forecast)');
    expect(attribution('ecmwf-open-data-charts')).toMatch(/^This service is based on data and products of the European Centre for Medium-Range Weather Forecasts \(ECMWF\); ECMWF open data; CC BY 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/\); modified: /);
    expect(attribution('era5-reanalysis')).toContain('doi:10.24381/cds.adbb2d47');
    expect(attribution('meteofrance-marine-bulletins')).toBe('Météo-France');
    expect(attribution('msq-queensland-tides')).toMatch(/^State of Queensland \(Transport and Main Roads, Maritime Safety Queensland\); CC BY 4\.0/);
    expect(attribution('queensland-wave-buoys')).toMatch(/^Queensland Government; for the Gladstone buoy, Queensland Government and Gladstone Ports Corporation; CC BY 4\.0/);
    // wording that is not recorded stays empty
    for (const id of ['noaa-gfs', 'noaa-gfs-wave', 'noaa-gefs', 'copernicus-insitu-observations', 'world-port-index', 'forecast-tiles-service', 'noaa-coops-tides']) {
      expect(attribution(id), id).toBe('Not yet confirmed');
    }
  });

  it('shows the two arrangement entries with the exact wording the owner gave, not as a licence', () => {
    show();
    for (const id of ARRANGEMENT_SOURCES) {
      const item = card(id);
      expect(value(item, 'Licence').textContent, id).toBe('By arrangement with the provider');
      expect(value(item, 'Attribution').textContent, id).toBe('Not yet confirmed');
      expect(value(item, 'Redistribution').textContent, id).toBe('Yes, by arrangement with the provider');
      expect(value(item, 'Verified on').textContent, id).toBe('Not yet verified');
      expect(item.textContent, id).not.toMatch(/under the licence/);
    }
  });

  it('keeps the arrangement list in step with the register', () => {
    const byArrangement = own.sources.filter((s) => s.licence === 'By arrangement with the provider').map((s) => s.id);
    expect(byArrangement.sort()).toEqual([...ARRANGEMENT_SOURCES].sort());
    for (const source of own.sources.filter((s) => ARRANGEMENT_SOURCES.includes(s.id))) {
      expect(source).toMatchObject({ redistribute: 'yes', licence_url: null, share_alike: null, verified_on: null, verified_from: null });
    }
  });

  it('keeps the page free of sub-12px text and lets long credit lines wrap on a phone', () => {
    const { container } = show();
    expect(container.innerHTML).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
    const credit = value(card('metoffice-ukv'), 'Attribution');
    expect(credit.className).toContain('[overflow-wrap:anywhere]');
    expect(card('metoffice-ukv').className).toContain('min-w-0');
  });

  it('translates labels and status words in French but leaves register data as recorded', async () => {
    const view = show('fr');
    await waitFor(() => expect(screen.getByText('Conditions de chaque source')).toBeTruthy());
    const ukv = card('metoffice-ukv');
    expect(within(ukv).getByText('Vérifié le')).toBeTruthy();
    expect(value(ukv, 'Redistribution').textContent).toBe('Oui, selon la licence');
    expect(within(ukv).getByText('Partage dans les mêmes conditions')).toBeTruthy();
    expect(value(ukv, 'Vérifié le').textContent).toBe('2026-11-12');
    expect(value(ukv, 'Licence').textContent).toBe('CC BY-SA 4.0');
    expect(value(ukv, 'Attribution').textContent).toContain('native CRS correction, geographic remapping and quantization');
    const arome = card('meteofrance-arome');
    expect(within(arome).getByText('Météo-France AROME 0,025°')).toBeTruthy();
    expect(value(arome, 'Redistribution').textContent).toBe('Oui, selon la licence');
    expect(value(arome, 'Vérifié le').textContent).toBe('Pas encore vérifié');
    const service = card('forecast-tiles-service');
    expect(value(service, 'Redistribution').textContent).toBe('Pas encore confirmé');
    const gfs = card('noaa-gfs');
    expect(value(gfs, 'Redistribution').textContent).toBe('Oui, selon la licence');
    for (const id of ARRANGEMENT_SOURCES) {
      expect(value(card(id), 'Licence').textContent, id).toBe('Par accord avec le fournisseur');
      expect(value(card(id), 'Redistribution').textContent, id).toBe('Oui, par accord avec le fournisseur');
    }
    expect(value(gfs, 'Vérifié le').textContent).toBe('2026-11-12');
    view.rerender(<div id="root"><About /><LocalizedDocument language="en" /></div>);
  });

  it('translates every visible source name and provider, or lists it as a proper name', () => {
    // Proper names and product codes that read the same in French. Anything else
    // (a description such as "tide predictions") needs a catalogue entry.
    const PROPER = new Set([
      'NOAA GFS 0.25°', 'NOAA GFS-Wave 0.25°', 'NOAA GEFS 0.5°', 'Copernicus Marine GLO12', 'Copernicus Marine IBI',
      'Météo-France AROME 0.025°', 'DWD ICON-EU', 'Met Office UKV 2 km', 'World Port Index (Publication 150)',
      'NOAA/NCEP', 'ECMWF', 'Copernicus Marine Service', 'Copernicus', 'Météo-France', 'Deutscher Wetterdienst',
      'Met Office', 'forecast-tiles', 'NWS', 'Meteoalarm', 'BOM', 'NOAA CO-OPS', 'Maritime Safety Queensland', 'NDBC',
      'Queensland Coastal Data System', 'NGA', 'OpenSeaMap',
    ]);
    show('en');
    const shown = new Set([...document.querySelectorAll('[data-source-id]')].map((item) => item.dataset.sourceId));
    const sources = [...tiles.sources, ...own.sources].filter((source) => shown.has(source.id));
    expect(sources.length).toBe(shown.size);
    const untranslated = sources.flatMap((source) => [source.name, source.provider])
      .filter((text) => translateText(text, 'fr') === localizeNotationFr(text) && !PROPER.has(text));
    expect(untranslated, 'add a French catalogue entry, or list a proper name above').toEqual([]);
    const unused = [...PROPER].filter((text) => !sources.some((s) => s.name === text || s.provider === text));
    expect(unused, 'stale proper-name entries').toEqual([]);
  });
});

describe('About: the ERA5 credit beside the skill statement', () => {
  const CREDIT = 'ERA5 reanalysis (Copernicus Climate Data Store), doi:10.24381/cds.adbb2d47; CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)';

  it('shows the dataset credit with its DOI next to "Skill claims use N real ERA5 cases."', () => {
    show();
    const statement = screen.getByText(/^Skill claims use \d+ real ERA5 cases\.$/);
    const credit = screen.getByTestId('era5-credit');
    expect(credit.textContent).toContain(CREDIT);
    expect(statement.closest('section')).toBe(credit.closest('section'));
    expect(credit.textContent).not.toMatch(/deepweather/i);
  });

  it('shows the credit as written on the French page, with only the label translated', async () => {
    const view = show('fr');
    await waitFor(() => expect(screen.getByTestId('era5-credit').textContent).toContain('Crédit de la réanalyse'));
    expect(screen.getByTestId('era5-credit').textContent).toContain(CREDIT);
    expect(view.container.textContent).toContain(CREDIT);
  });
});

describe('About: redistribution answers', () => {
  // Fixture entries: the registers hold no "no" answer, and the "yes" strings need their own test.
  const fixture = (redistribute) => ({
    id: `fixture-${redistribute}`, name: 'Fixture source', provider: 'Fixture provider',
    licence: 'Fixture licence 1.0', attribution: 'Fixture credit', share_alike: null,
    redistribute, verified_on: null, used_by: ['fixture'],
  });

  it('reads a yes answer as "Yes, under the licence"', () => {
    const { container } = render(<SourceTerms sources={[fixture('yes')]} />);
    expect(within(container).getByText('Redistribution').nextElementSibling.textContent).toBe('Yes, under the licence');
  });

  it('reads a no answer as "No"', () => {
    const { container } = render(<SourceTerms sources={[fixture('no')]} />);
    expect(within(container).getByText('Redistribution').nextElementSibling.textContent).toBe('No');
  });

  it('reads a yes answer for an arrangement entry as "Yes, by arrangement with the provider"', () => {
    const { container } = render(<SourceTerms sources={[{ ...fixture('yes'), id: 'bom-marine-warnings', licence: 'By arrangement with the provider' }]} />);
    expect(within(container).getByText('Redistribution').nextElementSibling.textContent).toBe('Yes, by arrangement with the provider');
    expect(within(container).getByText('Licence').nextElementSibling.textContent).toBe('By arrangement with the provider');
  });

  it('translates both answers in French', async () => {
    const view = render(<div id="root"><SourceTerms sources={[fixture('yes'), fixture('no')]} /><LocalizedDocument language="fr" /></div>);
    await waitFor(() => expect(view.container.textContent).toContain('Oui, selon la licence'));
    expect([...view.container.querySelectorAll('dt')].filter((dt) => dt.textContent === 'Redistribution')
      .map((dt) => dt.nextElementSibling.textContent)).toEqual(['Oui, selon la licence', 'Non']);
  });
});

describe('About: source groups', () => {
  const forecast = () => document.querySelector('details:has([data-source-id="noaa-gfs"])');
  const other = () => document.querySelector('details:has([data-source-id="era5-reanalysis"])');
  const confirmed = (id) => ({ id, redistribute: 'yes' });
  const pending = (id) => ({ id, redistribute: 'unconfirmed' });

  it('keeps the explanation visible and both groups closed by default', () => {
    show();
    expect(screen.getByText(/A licence shown here is a record/)).toBeTruthy();
    expect(forecast().open).toBe(false);
    expect(other().open).toBe(false);
    expect(document.querySelectorAll('details').length).toBe(2);
  });

  it('opens with the native summary control and then shows the cards', async () => {
    show();
    const summary = forecast().querySelector('summary');
    expect(summary.tagName).toBe('SUMMARY');
    await userEvent.click(summary);
    expect(forecast().open).toBe(true);
    expect(within(forecast()).getAllByRole('listitem').length).toBe(9);
    expect(other().open).toBe(false);
  });

  it('gives each summary the group name, the source count and how many are not yet confirmed', () => {
    show();
    expect(forecast().querySelector('summary').textContent).toBe('Forecast model data · 9 sources · all confirmed');
    expect(other().querySelector('summary').textContent).toBe('Other feeds and map layers · 18 sources · 1 not yet confirmed');
  });

  it('counts correctly for one source, mixed and fully confirmed groups', () => {
    expect(groupSummary('Group', [pending('a')])).toBe('Group · 1 source · not yet confirmed');
    expect(groupSummary('Group', [confirmed('a')])).toBe('Group · 1 source · confirmed');
    expect(groupSummary('Group', [pending('a'), confirmed('b'), pending('c')])).toBe('Group · 3 sources · 2 not yet confirmed');
    expect(groupSummary('Group', [confirmed('a'), confirmed('b')])).toBe('Group · 2 sources · all confirmed');
    expect(groupSummary('Group', [pending('a'), pending('b')])).toBe('Group · 2 sources · none confirmed yet');
  });

  it('makes the summary a 44 px touch target', () => {
    show();
    expect(forecast().querySelector('summary').className).toContain('min-h-11');
  });

  it('translates the summary lines, with their numbers, in French', async () => {
    const view = show('fr');
    await waitFor(() => expect(forecast().querySelector('summary').textContent)
      .toBe('Données des modèles de prévision · 9 sources · toutes confirmées'));
    expect(other().querySelector('summary').textContent).toBe('Autres flux et fonds de carte · 18 sources · 1 pas encore confirmée');
    view.rerender(<div id="root"><About /><LocalizedDocument language="en" /></div>);
  });

  it('translates the other summary forms in French', async () => {
    const view = render(<div id="root">
      <SourceGroup title="Forecast model data" sources={[pending('a')]} />
      <SourceGroup title="Forecast model data" sources={[confirmed('a')]} />
      <SourceGroup title="Forecast model data" sources={[pending('a'), confirmed('b'), pending('c')]} />
      <SourceGroup title="Forecast model data" sources={[confirmed('a'), pending('b')]} />
      <SourceGroup title="Forecast model data" sources={[confirmed('a'), confirmed('b')]} />
      <LocalizedDocument language="fr" />
    </div>);
    await waitFor(() => expect([...view.container.querySelectorAll('summary')].map((s) => s.textContent)).toEqual([
      'Données des modèles de prévision · 1 source · pas encore confirmée',
      'Données des modèles de prévision · 1 source · confirmée',
      'Données des modèles de prévision · 3 sources · 2 pas encore confirmées',
      'Données des modèles de prévision · 2 sources · 1 pas encore confirmée',
      'Données des modèles de prévision · 2 sources · toutes confirmées',
    ]));
  });
});
