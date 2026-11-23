import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { checkFileOf, fileOf, installBlobStream, makeCheck } from './helpers/checkFiles.js';

// "Import from a file" on My passages, through the real importer and store (fake-indexeddb,
// a fresh factory per test). An imported check joins its passage's history and always
// says it was imported from a file, with the time the check itself was made.
vi.setConfig({ testTimeout: 30_000 });

const IMPORTED_AT = Date.parse('2026-11-16T09:00:00Z');
const STRINGS = {
  en: {
    button: 'Import from a file',
    note: 'Choose a file saved from Passage (.json.gz), with one check or all of them. It is read in this browser; nothing is uploaded.',
    done: (time) => `Check imported from a file, departing ${time}.`,
    here: (time) => `This check is already in My passages, departing ${time}.`,
    open: 'Open the check',
    label: (time) => `Imported from a file, not recomputed here · check made ${time}`,
    station: (n) => `Check ${n} · imported`,
    comparison: 'This comparison uses a check imported from a file, which was not recomputed here.',
    offline: 'This check could not be imported now. Check your connection and try again.',
    notCheckFile: 'This file is not a Passage check file.',
    damaged: 'This check was not imported: the file is damaged or has been altered.',
  },
  fr: {
    button: 'Importer depuis un fichier',
    note: 'Choisissez un fichier enregistré depuis Passage (.json.gz), avec une vérification ou toutes. Il est lu dans ce navigateur ; rien n’est envoyé.',
    done: (time) => `Vérification importée depuis un fichier, départ ${time}.`,
    label: (time) => `Importée depuis un fichier, non recalculée ici · vérification faite ${time}`,
    notCheckFile: 'Ce fichier n’est pas un fichier de vérification Passage.',
    damaged: 'Cette vérification n’a pas été importée : le fichier est endommagé ou a été modifié.',
  },
};

let earlier, imported;
beforeAll(async () => {
  installBlobStream();
  // two checks of one passage: the earlier one saved in this browser, the later one imported
  earlier = await makeCheck({ passageId: 'passage-shared', nowMs: Date.parse('2026-07-19T17:00:00Z') });
  imported = await makeCheck({ passageId: 'passage-shared', departureUtc: '2026-07-20T09:00:00Z', nowMs: Date.parse('2026-07-19T18:00:00Z') });
});

let useApp, localSnapshots, format, passages, i18n;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  ({ useApp } = await import('../src/stores/appStore.js'));
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  format = await import('../src/lib/format.js');
  passages = await import('../src/lib/passages.js');
  i18n = await import('../src/i18n.js');
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/#passages');
  useApp.setState({ language: 'en', page: 'passages' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'], now: IMPORTED_AT });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function showPassages(language = 'en', { served = true } = {}) {
  useApp.setState({ language });
  const { default: Passages } = await import('../src/pages/Passages.jsx');
  const view = render(<div id="root"><Passages /><i18n.LocalizedDocument language={language} /></div>);
  await screen.findByRole('heading', { level: 1 });
  // the control shows once the list of passages is read; a failed served list never sets the manifest
  if (served) await waitFor(() => expect(useApp.getState().manifest).not.toBeNull());
  return view;
}
const fileInput = () => screen.getByTestId('import-check').querySelector('input[type="file"]');
const localTime = (iso, language = 'en') => passages.localTime(iso, language);
const saved = (check) => Object.entries(check.files).map(([filename, content]) => ({ filename, content }))
  .sort((a, b) => (a.filename === 'snapshot.json') - (b.filename === 'snapshot.json'));

it('is offered on My passages with its note, and not without DecompressionStream', async () => {
  const view = await showPassages();
  expect(screen.getByRole('button', { name: STRINGS.en.button })).toBeVisible();
  expect(screen.getByText(STRINGS.en.note, { exact: true })).toBeVisible();
  view.unmount();
  vi.stubGlobal('DecompressionStream', undefined);
  await showPassages();
  expect(screen.queryByRole('button', { name: STRINGS.en.button })).toBeNull();
});

it('says the note in French', async () => {
  await showPassages('fr');
  expect(await screen.findByRole('button', { name: STRINGS.fr.button })).toBeVisible();
  expect((await screen.findByText(STRINGS.fr.note, { exact: true, normalizer: (text) => text }))).toBeVisible();
});

describe('importing a check', () => {
  async function importIt(language = 'en', check = imported) {
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), fileOf((await checkFileOf(check)).bytes));
    return user;
  }

  it('joins its passage’s history after the check saved here, labelled with the time the check was made', async () => {
    await localSnapshots.writeAll(earlier.snapshotId, saved(earlier));
    await importIt();
    const departing = localTime('2026-07-20T09:00:00Z');
    expect(await screen.findByTestId('import-result')).toHaveTextContent(STRINGS.en.done(departing));
    // one passage, both checks, the imported one latest (sorted by when each check was made)
    // its own card is gone into the passage's: one card holds both checks (the served example has its own)
    await waitFor(() => expect(document.querySelector(`[data-snapshot-id="${imported.snapshotId}"]`)).not.toBeNull());
    expect(document.querySelector(`[data-snapshot-id="${earlier.snapshotId}"]`)).toBeNull();
    const card = document.querySelector(`[data-snapshot-id="${imported.snapshotId}"]`).closest('article');
    expect(within(card).getAllByRole('button', { name: /^Open check \d of / })).toHaveLength(2);
    expect(within(card).getByRole('button', { name: /^Open check 2 of / })).toHaveAccessibleName(expect.stringContaining(localTime('2026-07-19T18:00:00.000Z')));
    // the check's own time, never the import time
    expect(within(card).getByTestId('imported-label')).toHaveTextContent(STRINGS.en.label(localTime('2026-07-19T18:00:00.000Z')));
    expect(within(card).getByTestId('imported-label').textContent).not.toContain(format.fmtLocalTime(new Date(IMPORTED_AT).toISOString()));
    expect(useApp.getState().manifest.snapshots.find((s) => s.snapshot_id === imported.snapshotId)).toMatchObject({ imported: true, passage_id: 'passage-shared' });
    expect(useApp.getState().manifest.snapshots.find((s) => s.snapshot_id === earlier.snapshotId).imported).toBeUndefined();
  });

  it('opens the imported check from its button', async () => {
    const user = await importIt();
    await user.click(await screen.findByRole('button', { name: STRINGS.en.open }));
    await waitFor(() => expect(useApp.getState()).toMatchObject({ page: 'briefing', snapshotId: imported.snapshotId, snapshotSource: 'local', imported: true }));
  });

  it('says it in French, with the check’s own time on the label', async () => {
    await importIt('fr');
    expect((await screen.findByTestId('import-result')).textContent).toBe(STRINGS.fr.done(localTime('2026-07-20T09:00:00Z', 'fr')));
    expect((await screen.findByTestId('imported-label')).textContent).toBe(STRINGS.fr.label(localTime('2026-07-19T18:00:00.000Z', 'fr')));
  });

  it('says a check already here is already here, and writes nothing', async () => {
    await localSnapshots.writeAll(imported.snapshotId, saved(imported));
    await importIt();
    expect(await screen.findByTestId('import-result')).toHaveTextContent(STRINGS.en.here(localTime('2026-07-20T09:00:00Z')));
    expect(await localSnapshots.read(imported.snapshotId, 'imported.json')).toBeNull();
    expect(screen.queryByTestId('imported-label')).toBeNull();
  });

  it.each(['en', 'fr'])('refuses a file that is not a check file and one that is damaged, plainly (%s)', async (language) => {
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), fileOf(new TextEncoder().encode('not a check')));
    expect((await screen.findByRole('alert')).textContent).toBe(STRINGS[language].notCheckFile);
    const { bytes } = await checkFileOf(imported);
    await user.upload(fileInput(), fileOf(bytes.slice(0, 200)));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(STRINGS[language].damaged));
    expect(await localSnapshots.list()).toEqual([]);
  });
});

it('labels an imported check on the passage page and offers a copy of it', async () => {
  const { importCheckFile } = await import('../src/lib/checkImport.js');
  await useApp.getState().loadManifest();
  expect((await importCheckFile(fileOf((await checkFileOf(imported)).bytes), { servedIds: useApp.getState().servedIds })).outcome).toBe('imported');
  const { default: App } = await import('../src/App.jsx');
  render(<App />);
  await act(async () => { await useApp.getState().openSnapshot(imported.snapshotId); });
  const band = await screen.findByTestId('decision-band');
  expect(within(band).getByTestId('imported-label')).toHaveTextContent(STRINGS.en.label(localTime('2026-07-19T18:00:00.000Z')));
  expect(within(band).getByRole('button', { name: 'Save a copy to a file' })).toBeVisible();
  // a check saved in this browser has no such label
  await localSnapshots.writeAll(earlier.snapshotId, saved(earlier));
  await act(async () => { await useApp.getState().openSnapshot(earlier.snapshotId); });
  expect(within(await screen.findByTestId('decision-band')).queryByTestId('imported-label')).toBeNull();
});

describe('provenance wherever an imported check takes part', () => {
  // the imported check is the earlier one; the sailor's own check of the passage comes after it
  let own;
  beforeAll(async () => { own = await makeCheck({ passageId: 'passage-shared', departureUtc: '2026-07-20T12:00:00Z', nowMs: Date.parse('2026-07-19T19:00:00Z') }); });

  it('marks the imported check\'s station and notes the comparison on the card and on the passage page', async () => {
    const { importCheckFile } = await import('../src/lib/checkImport.js');
    await useApp.getState().loadManifest();
    expect((await importCheckFile(fileOf((await checkFileOf(earlier)).bytes), { servedIds: useApp.getState().servedIds })).outcome).toBe('imported');
    await localSnapshots.writeAll(own.snapshotId, saved(own));
    await showPassages();
    await screen.findByText(STRINGS.en.station(1), { exact: true });
    const card = document.querySelector(`[data-snapshot-id="${own.snapshotId}"]`).closest('article');
    expect(within(card).getByText(STRINGS.en.station(1), { exact: true })).toBeVisible();
    expect(within(card).getByText('Check 2', { exact: true })).toBeVisible();
    // under the "since last check" line, and under "route or departure changed" (the departures differ)
    const notes = within(card).getAllByTestId('imported-comparison');
    expect(notes).toHaveLength(2);
    for (const note of notes) expect(note).toHaveTextContent(STRINGS.en.comparison);
    // the latest is the sailor's own: no import label on the card
    expect(within(card).queryByTestId('imported-label')).toBeNull();
    const { default: App } = await import('../src/App.jsx');
    document.body.innerHTML = '';
    render(<App />);
    await act(async () => { await useApp.getState().openSnapshot(own.snapshotId); });
    expect(await screen.findByTestId('imported-comparison', {}, { timeout: 15_000 })).toHaveTextContent(STRINGS.en.comparison);
    expect(within(screen.getByTestId('decision-band')).queryByTestId('imported-label')).toBeNull();
  });
});

describe('the import control and the network', () => {
  it('is shown when the served list failed, and then refuses for now', async () => {
    globalThis.fetch.mockImplementation(async (url) => (String(url).includes('manifest.json') ? new Response('', { status: 500 }) : new Response('null')));
    // the manifest never loads here: do not wait for it (that wait ran out the 8 s waitFor limit, swallowed by a catch)
    await showPassages('en', { served: false });
    await waitFor(() => expect(useApp.getState().manifestError).not.toBeNull());
    expect(await screen.findByRole('button', { name: STRINGS.en.button })).toBeVisible();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), fileOf((await checkFileOf(imported)).bytes));
    expect((await screen.findByRole('alert')).textContent).toBe(STRINGS.en.offline);
    expect(await localSnapshots.list()).toEqual([]);
  });

  it('imports with every request failing once the page has read its lists', async () => {
    await showPassages();
    globalThis.fetch.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), fileOf((await checkFileOf(imported)).bytes));
    expect(await screen.findByTestId('import-result')).toHaveTextContent(STRINGS.en.done(localTime('2026-07-20T09:00:00Z')));
  });

  it('announces two imports that end with the same words', async () => {
    const twin = await makeCheck({ passageId: 'passage-twin', departureUtc: '2026-07-20T09:00:00Z' });
    await showPassages();
    const live = screen.getAllByRole('status').find((element) => element.className.includes('sr-only'));
    const said = [];
    new MutationObserver(() => said.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true });
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), fileOf((await checkFileOf(imported)).bytes));
    await waitFor(() => expect(live.textContent).toBe(STRINGS.en.done(localTime('2026-07-20T09:00:00Z'))));
    await user.upload(fileInput(), fileOf((await checkFileOf(twin)).bytes));
    await waitFor(() => expect(said.filter((text) => text === STRINGS.en.done(localTime('2026-07-20T09:00:00Z')))).toHaveLength(2));
    expect(said).toContain('');
  });
});

it('imports a whole check whose route name is markup, and shows the name as text', async () => {
  const markup = '<img src=x onerror="window.__pwned=1">Brest';
  const check = await makeCheck({ passageId: 'passage-markup', name: markup });
  await showPassages();
  const user = userEvent.setup({ advanceTimers: () => {} });
  await user.upload(fileInput(), fileOf((await checkFileOf(check)).bytes));
  await screen.findByTestId('import-result');
  // the list reloads after the import: wait for the card itself
  const open = await waitFor(() => {
    const element = document.querySelector(`[data-snapshot-id="${check.snapshotId}"]`);
    expect(element).not.toBeNull();
    return element;
  });
  const card = open.closest('article');
  await waitFor(() => expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent(markup));
  expect(card.querySelector('img')).toBeNull();
  expect(window.__pwned).toBeUndefined();
});

describe('an imported check tied in time with the sailor\'s own', () => {
  const T = Date.parse('2026-07-19T19:30:00Z');
  let own, forged;
  beforeAll(async () => {
    own = await makeCheck({ passageId: 'passage-tie', departureUtc: '2026-07-20T06:00:00Z', nowMs: T });
    // the same passage, the same save time and the same sequence (1), another departure
    forged = await makeCheck({ passageId: 'passage-tie', departureUtc: '2026-07-20T08:00:00Z', nowMs: T });
  });

  it('orders before it, keeps the order known, and notes the comparison on the card and the passage page', async () => {
    expect(JSON.parse(own.files['snapshot.json'])).toMatchObject({ created_at: new Date(T).toISOString(), check_sequence: 1 });
    expect(JSON.parse(forged.files['snapshot.json'])).toMatchObject({ created_at: new Date(T).toISOString(), check_sequence: 1 });
    await localSnapshots.writeAll(own.snapshotId, saved(own));
    await useApp.getState().loadManifest();
    const { importCheckFile } = await import('../src/lib/checkImport.js');
    expect((await importCheckFile(fileOf((await checkFileOf(forged)).bytes), { servedIds: useApp.getState().servedIds })).outcome).toBe('imported');
    await showPassages();
    // the list is read again on the page: wait for the imported check to be in it
    await screen.findByText(STRINGS.en.station(1), { exact: true });
    const card = document.querySelector(`[data-snapshot-id="${own.snapshotId}"]`).closest('article');
    // the sailor's own check is the latest; the imported one is check 1
    expect(within(card).getByText(STRINGS.en.station(1), { exact: true })).toBeVisible();
    expect(within(card).getByText('Rechecked · verdict unchanged')).toBeVisible();
    // the "since last check" line and the "route or departure changed" line both say it
    expect(within(card).getAllByTestId('imported-comparison')).toHaveLength(2);
    const { default: App } = await import('../src/App.jsx');
    document.body.innerHTML = '';
    render(<App />);
    await act(async () => { await useApp.getState().openSnapshot(own.snapshotId); });
    expect(await screen.findByTestId('imported-comparison', {}, { timeout: 15_000 })).toHaveTextContent(STRINGS.en.comparison);
    expect(screen.queryByText('Previous check order is unavailable. These saved checks have been kept.')).toBeNull();
  });
});

describe('the imported fact on the My passages card, read aloud and folded', () => {
  it('is in the station button\'s name, and in "+n more checks" when folded', async () => {
    const times = ['17:00', '17:10', '17:20', '17:30', '17:40'].map((time) => Date.parse(`2026-07-19T${time}:00Z`));
    const checks = await Promise.all(times.map((nowMs, i) => makeCheck({ passageId: 'passage-folded', departureUtc: `2026-07-2${i}T06:00:00Z`, nowMs })));
    const { importCheckFile } = await import('../src/lib/checkImport.js');
    await useApp.getState().loadManifest();
    // checks 2 and 3 imported (folded away), the others saved here
    for (const [i, check] of checks.entries()) {
      if (i === 1 || i === 2) expect((await importCheckFile(fileOf((await checkFileOf(check)).bytes), { servedIds: useApp.getState().servedIds })).outcome).toBe('imported');
      else await localSnapshots.writeAll(check.snapshotId, saved(check));
    }
    await showPassages();
    expect(await screen.findByText('+2 more checks (2 imported)', { exact: true })).toBeVisible();
    const card = document.querySelector(`[data-snapshot-id="${checks[4].snapshotId}"]`).closest('article');
    expect(within(card).getByText('+2 more checks (2 imported)', { exact: true })).toBeVisible();
    expect(within(card).getByRole('button', { name: /^Open check 1 of / }).getAttribute('aria-label')).not.toContain('imported');
  });

  it('names an imported station "imported from a file", in English and French', async () => {
    const check = await makeCheck({ passageId: 'passage-named' });
    await useApp.getState().loadManifest();
    const { importCheckFile } = await import('../src/lib/checkImport.js');
    await importCheckFile(fileOf((await checkFileOf(check)).bytes), { servedIds: useApp.getState().servedIds });
    const view = await showPassages();
    const station = await screen.findByRole('button', { name: /^Open check 1 of .+, imported from a file$/ });
    expect(station).toHaveTextContent(STRINGS.en.station(1));
    view.unmount();
    await showPassages('fr');
    expect(await screen.findByRole('button', { name: /^Ouvrir la vérification 1 de .+, importée depuis un fichier$/ })).toHaveTextContent('Vérification 1 · importée');
  });
});

it.each([
  ['en', 'This check was not imported: its time is in the future. Check this device’s date and time.'],
  ['fr', 'Cette vérification n’a pas été importée : son heure est dans le futur. Vérifiez la date et l’heure de cet appareil.'],
])('says a check saved in the future is in the future (%s), and stores nothing', async (language, message) => {
  const future = await makeCheck({ passageId: 'passage-future', nowMs: Date.parse('2099-01-01T00:00:00Z') });
  await showPassages(language);
  const user = userEvent.setup({ advanceTimers: () => {} });
  await user.upload(fileInput(), fileOf((await checkFileOf(future, { exportedAt: '2099-01-01T00:00:00.000Z' })).bytes));
  expect((await screen.findByRole('alert')).textContent).toBe(message);
  expect(await localSnapshots.list()).toEqual([]);
});
