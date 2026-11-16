import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { checkFileEntryLine, checkFileHeaderLine, checkFileNamesLine, checkFileTrailerLine } from '@deepweather/engine';
import { checkFileOf, fileOf, gzipOf, installBlobStream, makeCheck } from './helpers/checkFiles.js';

// "Import from a file" with a file of many checks (version 2), through the real importer
// and store (fake-indexeddb, a fresh factory per test), and a stand-in importer where a
// state must be held. One summary at the end; problems in one alert; an undo that
// removes exactly what this import added.
vi.setConfig({ testTimeout: 60_000 });

const NB = '\u00A0';
const IMPORTED_AT = Date.parse('2026-11-16T09:00:00Z');
const STRINGS = {
  en: {
    button: 'Import from a file',
    start: 'Importing checks from a file.',
    importing: (i) => `Importing: check ${i}…`,
    stop: 'Stop',
    imported: (n) => (n === 1 ? '1 check imported from the file.' : `${n} checks imported from the file.`),
    already: (n) => (n === 1 ? '1 check was already in My passages.' : `${n} checks were already in My passages.`),
    joined: (n) => (n === 1 ? '1 of the imported checks sits in a passage alongside checks made in this browser.' : `${n} of the imported checks sit in a passage alongside checks made in this browser.`),
    repeated: (n) => (n === 1 ? '1 check appears more than once in the file; it was read once.' : `${n} checks appear more than once in the file; each was read once.`),
    stoppedLarge: 'The import stopped at a check that is too large. The checks after it were not read.',
    tooLarge: (n) => (n === 1 ? '1 check was not imported: it is too large.' : `${n} checks were not imported: they are too large.`),
    undoNote: 'This button stays only until you leave this page.',
    damaged: (n) => (n === 1 ? '1 check was not imported: the file is damaged or has been altered there.' : `${n} checks were not imported: the file is damaged or has been altered there.`),
    endsEarly: 'The file ends early or is damaged, so it may be incomplete. Only the checks before that point were read.',
    full: 'This browser’s storage is full. The checks after that point were not imported.',
    notStored: 'This browser could not store a check. The checks after that point were not imported.',
    stopped: (n) => (n === 1 ? 'Stopped. 1 check was imported before you stopped.' : `Stopped. ${n} checks were imported before you stopped.`),
    tooMany: (n) => `This file holds more checks than Passage imports at once. The first ${n} were read.`,
    offline: 'The checks in this file could not be imported now. Check your connection and try again.',
    remove: (n) => (n === 1 ? 'Remove the check this import added' : 'Remove the checks this import added'),
    question: (n) => (n === 1 ? 'Remove the check this import added?' : `Remove the ${n} checks this import added?`),
    confirm: 'Remove',
    removed: (n) => (n === 1 ? '1 check removed.' : `${n} checks removed.`),
    single: (time) => `Check imported from a file, departing ${time}.`,
    open: 'Open the check',
  },
  fr: {
    button: 'Importer depuis un fichier',
    imported: (n) => (n <= 1 ? `${n} vérification importée depuis le fichier.` : `${n} vérifications importées depuis le fichier.`),
    damaged: (n) => (n <= 1 ? `${n} vérification n’a pas été importée${NB}: le fichier est endommagé ou a été modifié à cet endroit.` : `${n} vérifications n’ont pas été importées${NB}: le fichier est endommagé ou a été modifié à cet endroit.`),
    remove: (n) => (n <= 1 ? 'Retirer la vérification ajoutée par cette importation' : 'Retirer les vérifications ajoutées par cette importation'),
    question: (n) => (n <= 1 ? `Retirer la vérification ajoutée par cette importation${NB}?` : `Retirer les ${n} vérifications ajoutées par cette importation${NB}?`),
    confirm: 'Retirer',
    removed: (n) => (n <= 1 ? `${n} vérification retirée.` : `${n} vérifications retirées.`),
    already: (n) => (n <= 1 ? `${n} vérification était déjà dans Mes traversées.` : `${n} vérifications étaient déjà dans Mes traversées.`),
    repeated: (n) => (n <= 1 ? `${n} vérification apparaît plusieurs fois dans le fichier${NB}; elle a été lue une seule fois.` : `${n} vérifications apparaissent plusieurs fois dans le fichier${NB}; chacune a été lue une seule fois.`),
    undoNote: 'Ce bouton ne reste que jusqu’à ce que vous quittiez cette page.',
    stopped: (n) => (n <= 1 ? `Arrêté. ${n} vérification a été importée avant l’arrêt.` : `Arrêté. ${n} vérifications ont été importées avant l’arrêt.`),
    start: 'Importation de vérifications depuis un fichier.',
    importing: (i) => `Importation${NB}: vérification ${i}…`,
  },
};
const folded = (text) => text.replace(/\s+/g, ' ').trim();
const hasText = (element, text) => expect(folded(element.textContent)).toContain(folded(text));

let own, a, b, ownPassage;
beforeAll(async () => {
  installBlobStream();
  own = await makeCheck({ passageId: 'passage-own', nowMs: Date.parse('2026-07-19T10:00:00Z') });
  a = await makeCheck({ passageId: 'passage-a', nowMs: Date.parse('2026-07-19T11:00:00Z') });
  b = await makeCheck({ passageId: 'passage-b', departureUtc: '2026-07-21T06:00:00Z', nowMs: Date.parse('2026-07-19T12:00:00Z'), name: 'Île d’Yeu → Brest 🌊' });
  ownPassage = await makeCheck({ passageId: 'passage-own', departureUtc: '2026-07-22T06:00:00Z', nowMs: Date.parse('2026-07-19T13:00:00Z') });
});

let useApp, localSnapshots, i18n, passages;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  ({ useApp } = await import('../src/stores/appStore.js'));
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  i18n = await import('../src/i18n.js');
  passages = await import('../src/lib/passages.js');
  localStorage.clear();
  history.replaceState(null, '', '/#passages');
  useApp.setState({ language: 'en', page: 'passages' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'], now: IMPORTED_AT });
});
afterEach(() => { vi.doUnmock('../src/lib/checkImportMany.js'); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const saved = (check) => Object.entries(check.files).map(([filename, content]) => ({ filename, content }))
  .sort((x, y) => (x.filename === 'snapshot.json') - (y.filename === 'snapshot.json'));
const lineOf = (check) => checkFileEntryLine(check).slice(0, -1);
const backupFile = async (lines) => fileOf(await gzipOf(checkFileHeaderLine({ exportedAt: '2026-11-15T12:00:00.000Z', exportedBy: 'Passage engine 0.2.0' })
  + lines.map((line) => `${line}\n`).join('') + checkFileTrailerLine(lines.length)), 'passage-all-checks.json.gz');
const damagedLine = (check) => lineOf({ ...check, files: { ...check.files, 'snapshot.json': JSON.stringify({ ...JSON.parse(check.files['snapshot.json']), check_sequence: 0 }) } });

async function showPassages(language = 'en') {
  useApp.setState({ language });
  const { default: Passages } = await import('../src/pages/Passages.jsx');
  const view = render(<div id="root"><Passages /><i18n.LocalizedDocument language={language} /></div>);
  await screen.findByRole('heading', { level: 1 });
  await waitFor(() => expect(useApp.getState().manifest).not.toBeNull());
  return view;
}
const control = () => screen.getByTestId('import-check');
const fileInput = () => control().querySelector('input[type="file"]');
const liveRegion = () => screen.getByRole('status');
const ids = async () => (await localSnapshots.list()).map((entry) => entry.snapshot_id).sort();

describe('a file of many checks', () => {
  it.each(['en', 'fr'])('stores the valid ones, says it in one summary with the problem in an alert, and can remove what it added (%s)', async (language) => {
    await localSnapshots.writeAll(own.snapshotId, saved(own));
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    const loads = vi.spyOn(useApp.getState(), 'loadManifest');
    await user.upload(fileInput(), await backupFile([lineOf(a), damagedLine(ownPassage), lineOf(b)]));
    const summary = await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    hasText(summary, STRINGS[language].imported(2));
    hasText(within(summary).getByRole('alert'), STRINGS[language].damaged(1));
    // the live region says the summary (the problem is an alert of its own)
    await waitFor(() => hasText(liveRegion(), STRINGS[language].imported(2)));
    expect(await ids()).toEqual([own.snapshotId, a.snapshotId, b.snapshotId].sort());
    // both imported checks are listed, labelled as imported
    await waitFor(() => expect(useApp.getState().manifest.snapshots.filter((entry) => entry.imported)).toHaveLength(2));
    expect(loads).toHaveBeenCalled();
    const remove = within(control()).getByRole('button', { name: STRINGS[language].remove(2) });
    hasText(within(control()).getByTestId('import-undo-note'), STRINGS[language].undoNote);
    // by keyboard: the dialog, its confirm button, then focus on the line saying how many were removed
    remove.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('alertdialog');
    hasText(within(dialog).getByRole('heading'), STRINGS[language].question(2));
    within(dialog).getByRole('button', { name: STRINGS[language].confirm }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => hasText(within(control()).getByTestId('import-removed'), STRINGS[language].removed(2)));
    await waitFor(() => expect(within(control()).getByTestId('import-removed')).toHaveFocus());
    expect(within(control()).queryByTestId('import-undo-note')).toBeNull();
    await waitFor(() => hasText(liveRegion(), STRINGS[language].removed(2)));
    // only what this import added is gone: the check made here stays, byte for byte
    expect(await ids()).toEqual([own.snapshotId]);
    for (const [name, text] of Object.entries(own.files)) expect(await localSnapshots.read(own.snapshotId, name)).toBe(text);
    await waitFor(() => expect(useApp.getState().manifest.snapshots.filter((entry) => entry.local).map((entry) => entry.snapshot_id)).toEqual([own.snapshotId]));
    expect(within(control()).queryByRole('button', { name: STRINGS[language].remove(2) })).toBeNull();
  });

  it('says how many were already here and how many joined a passage holding checks made here; cancelling the undo keeps them', async () => {
    await localSnapshots.writeAll(own.snapshotId, saved(own));
    await localSnapshots.writeAll(a.snapshotId, saved(a));
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a), lineOf(ownPassage), lineOf(b)]));
    const summary = await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    hasText(summary, STRINGS.en.imported(2));
    hasText(summary, STRINGS.en.already(1));
    hasText(summary, STRINGS.en.joined(1));
    expect(within(summary).queryByRole('alert')).toBeNull();
    await user.click(within(control()).getByRole('button', { name: STRINGS.en.remove(2) }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(await ids()).toEqual([own.snapshotId, a.snapshotId, ownPassage.snapshotId, b.snapshotId].sort());
    // focus back on the button that opened the dialog
    expect(within(control()).getByRole('button', { name: STRINGS.en.remove(2) })).toHaveFocus();
  });

  it('tells a version-2 file of one check exactly as stage 1 tells it, with its button', async () => {
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a)]));
    const result = await within(control()).findByTestId('import-result', {}, { timeout: 30_000 });
    expect(result).toHaveTextContent(STRINGS.en.single(passages.localTime('2026-07-20T06:00:00Z', 'en')));
    expect(within(control()).getByRole('button', { name: STRINGS.en.open })).toBeVisible();
    expect(within(control()).queryByTestId('import-summary')).toBeNull();
    expect(within(control()).queryByRole('button', { name: STRINGS.en.remove(1) })).toBeNull();
  });
});

/** A stand-in importer that ends when the test says, and reports progress as told. */
function standIn() {
  const calls = [];
  vi.doMock('../src/lib/checkImportMany.js', () => ({
    importChecksFile: (file, options) => new Promise((resolve) => {
      calls.push({ options, resolve });
      options.signal.addEventListener('abort', () => resolve(v2({ end: 'stopped', outcomes: { imported: 1 }, importedIds: ['snapshot_v2_0123456789abcdef'] })));
    }),
    removeImportedChecks: vi.fn(async (list) => ({ removed: list, refused: [] })),
  }));
  return calls;
}
const NONE = { imported: 0, already: 0, repeated: 0, damaged: 0, futureTime: 0, polar: 0, served: 0, conflict: 0, tooLarge: 0 };
const v2 = (extra) => ({ kind: 'v2', importedIds: [], joinedOwn: 0, linesRead: 3, first: null, hint: null, notReached: null, refusal: null, storageFull: false, ...extra, outcomes: { ...NONE, ...extra.outcomes } });

describe('while importing, and how an import of many ends', () => {
  it.each(['en', 'fr'])('announces the start once, shows a running count with Stop, and stops between checks (%s)', async (language) => {
    const calls = standIn();
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a)]));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].options.onProgress({ index: 0 });
    await waitFor(() => hasText(liveRegion(), STRINGS[language].start));
    const progress = await within(control()).findByTestId('import-progress');
    hasText(progress, STRINGS[language].importing(1));
    calls[0].options.onProgress({ index: 4 });
    await waitFor(() => hasText(progress, STRINGS[language].importing(4)));
    // indeterminate: no value
    expect(progress.querySelector('progress')).not.toHaveAttribute('value');
    // no announcement per check
    hasText(liveRegion(), STRINGS[language].start);
    const button = within(control()).getByRole('button', { name: language === 'en' ? 'Importing…' : 'Importation en cours…' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    // the bar is named by the running count beside it
    const bar = within(progress).getByRole('progressbar');
    hasText(document.getElementById(bar.getAttribute('aria-labelledby')), STRINGS[language].importing(4));
    within(progress).getByRole('button', { name: language === 'en' ? STRINGS.en.stop : 'Arrêter' }).focus();
    await user.keyboard('{Enter}');
    const summary = await within(control()).findByTestId('import-summary');
    hasText(summary, STRINGS[language].stopped(1));
    // Stop went with the count: focus is on the summary's first line, not the page
    await waitFor(() => expect(summary.querySelector('p')).toHaveFocus());
    expect(folded(summary.textContent)).not.toContain(folded(STRINGS[language].imported(1)));
    expect(within(control()).getByRole('button', { name: STRINGS[language].remove(1) })).toBeVisible();
  });

  it.each([
    ['ends early', { end: 'incomplete', hint: 'truncated', outcomes: { imported: 2 } }, STRINGS.en.endsEarly],
    ['holds more than 1,000 checks', { end: 'incomplete', hint: 'check-count', linesRead: 1000, outcomes: { imported: 1000 } }, STRINGS.en.tooMany(1000)],
    ['meets a full storage', { end: 'storage', storageFull: true, outcomes: { imported: 1 } }, STRINGS.en.full],
    ['meets another storage failure', { end: 'storage', storageFull: false, outcomes: { imported: 1 } }, STRINGS.en.notStored],
    ['grows past its inflated cap', { end: 'incomplete', hint: 'too-large', outcomes: { imported: 1 } }, STRINGS.en.endsEarly],
  ])('says so when the file %s', async (_case, result, line) => {
    const calls = standIn();
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a)]));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(v2({ ...result, importedIds: ['snapshot_v2_0123456789abcdef'] }));
    const alert = await within(control()).findByRole('alert');
    hasText(alert, line);
    hasText(within(control()).getByTestId('import-summary'), STRINGS.en.imported(result.outcomes.imported));
  });

  it('refuses a file of many checks for now when the page never read the served ones', async () => {
    const calls = standIn();
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a), lineOf(b)]));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(v2({ end: 'refused', refusal: 'offline', linesRead: 0 }));
    expect(await within(control()).findByRole('alert')).toHaveTextContent(STRINGS.en.offline);
    expect(within(control()).queryByTestId('import-summary')).toBeNull();
  });
});

describe('display defects seen live (2026-11-16)', () => {
  it('never shows a check number above the number of check lines in the file', async () => {
    for (const check of [a, b, ownPassage]) await localSnapshots.writeAll(check.snapshotId, saved(check));
    await showPassages();
    const shown = [];
    const watch = new MutationObserver(() => {
      const text = control().querySelector('[data-testid="import-progress"]')?.textContent ?? '';
      const found = /check (\d+)/.exec(text);
      if (found) shown.push(Number(found[1]));
    });
    watch.observe(control(), { childList: true, subtree: true, characterData: true });
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a), lineOf(b), lineOf(ownPassage)]));
    await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    watch.disconnect();
    expect(shown.length).toBeGreaterThan(0);
    expect(Math.max(...shown)).toBe(3);
  });

  it.each(['en', 'fr'])('leaves out the zero line when nothing was imported but others are told, and says the first line shown (%s)', async (language) => {
    for (const check of [a, b]) await localSnapshots.writeAll(check.snapshotId, saved(check));
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a), lineOf(b)]));
    const summary = await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    expect(folded(summary.textContent)).not.toContain(folded(STRINGS[language].imported(0)));
    const first = summary.querySelector('p');
    hasText(first, STRINGS[language].already(2));
    await waitFor(() => expect(folded(liveRegion().textContent)).toBe(folded(STRINGS[language].already(2))));
  });

  it.each(['en', 'fr'])('keeps the zero line when nothing was imported and every check was refused (%s)', async (language) => {
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([damagedLine(a), damagedLine(b)]));
    const summary = await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    const first = summary.querySelector('p');
    hasText(first, STRINGS[language].imported(0));
    hasText(within(summary).getByRole('alert'), STRINGS[language].damaged(2));
  });

  it.each([
    ['0 imported, some already here', { already: 2 }, 'already', 2],
    ['0 imported, only refusals', { damaged: 2 }, 'imported', 0],
  ])('moves focus from Stop to the first line shown (%s)', async (_case, outcomes, key, n) => {
    const calls = standIn();
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a)]));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].options.onProgress({ index: 0 });
    const progress = await within(control()).findByTestId('import-progress');
    within(progress).getByRole('button', { name: STRINGS.en.stop }).focus();
    calls[0].resolve(v2({ end: 'complete', linesRead: 2, notReached: 0, outcomes }));
    const summary = await within(control()).findByTestId('import-summary');
    hasText(summary.querySelector('p'), STRINGS.en[key](n));
    await waitFor(() => expect(summary.querySelector('p')).toHaveFocus());
  });

  it('keeps the imported line first when some were imported and some were already here', async () => {
    await localSnapshots.writeAll(a.snapshotId, saved(a));
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a), lineOf(b)]));
    const summary = await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    const lines = [...summary.querySelectorAll('p')].map((p) => folded(p.textContent));
    expect(lines.slice(0, 2)).toEqual([folded(STRINGS.en.imported(1)), folded(STRINGS.en.already(1))]);
    await waitFor(() => expect(folded(liveRegion().textContent)).toBe(folded(`${STRINGS.en.imported(1)} ${STRINGS.en.already(1)}`)));
  });
});

describe('review round', () => {
  it.each(['en', 'fr'])('says a check given twice was read once, as information, not damage (%s)', async (language) => {
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a), lineOf(a), lineOf(b)]));
    const summary = await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    hasText(summary, STRINGS[language].imported(2));
    hasText(summary, STRINGS[language].repeated(1));
    expect(within(summary).queryByRole('alert')).toBeNull();
    expect(await ids()).toEqual([a.snapshotId, b.snapshotId].sort());
  });

  it('says the import stopped at a check that is too large, instead of a damaged file and a too-large count', async () => {
    const calls = standIn();
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a)]));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(v2({ end: 'incomplete', hint: 'too-large', linesRead: 1, outcomes: { imported: 1, tooLarge: 1 }, importedIds: ['snapshot_v2_0123456789abcdef'] }));
    const alert = await within(control()).findByRole('alert');
    expect(folded(alert.textContent)).toBe(folded(STRINGS.en.stoppedLarge));
    expect(folded(alert.textContent)).not.toContain(folded(STRINGS.en.endsEarly));
    expect(folded(alert.textContent)).not.toContain(folded(STRINGS.en.tooLarge(1)));
  });

  it('empties a renamed passage through the page\'s own delete: the name goes with it; the undo is gone after leaving the page', async () => {
    const { passageLabels } = await import('../src/lib/passageLabels.js');
    // the page's own "Delete" path (it also forgets the remembered open check), spied before the page takes it
    const deleting = vi.spyOn(useApp.getState(), 'deleteSnapshot');
    const view = await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a), lineOf(b)]));
    await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    const key = passages.groupPassages(useApp.getState().manifest.snapshots).find((passage) => passage.checks.some((check) => check.snapshot_id === a.snapshotId)).key;
    passageLabels.set(key, 'Renamed passage');
    expect(passageLabels.all()[key]).toBe('Renamed passage');
    // the station of an imported check says so in its name
    expect(await screen.findAllByRole('button', { name: /^Open check 1 of .+, imported from a file$/ })).toHaveLength(2);
    await user.click(within(control()).getByRole('button', { name: STRINGS.en.remove(2) }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: STRINGS.en.confirm }));
    await waitFor(() => hasText(within(control()).getByTestId('import-removed'), STRINGS.en.removed(2)));
    expect(deleting.mock.calls.map(([id]) => id).sort()).toEqual([a.snapshotId, b.snapshotId].sort());
    expect(passageLabels.all()[key]).toBeUndefined();
    expect(await ids()).toEqual([]);
    view.unmount();
    // a second import, then the page left and opened again: no undo any more
    const again = await showPassages();
    await user.upload(fileInput(), await backupFile([lineOf(a), lineOf(b)]));
    expect(await within(control()).findByRole('button', { name: STRINGS.en.remove(2) }, { timeout: 30_000 })).toBeVisible();
    again.unmount();
    await showPassages();
    expect(within(control()).queryByRole('button', { name: STRINGS.en.remove(2) })).toBeNull();
    expect(await ids()).toEqual([a.snapshotId, b.snapshotId].sort());
  });
});

describe('a version-3 file: the passage names it gives', () => {
  const NB = '\u00A0';
  const WORDS = {
    en: {
      taken: (n) => (n === 1 ? '1 passage name was taken from the file.' : `${n} passage names were taken from the file.`),
      unreadable: 'The passage names in this file could not be read. Its checks were read as usual.',
      notPersisted: 'This browser could not save the passage names; they may be gone when you leave this page.',
      dialog: 'The passage names it took from the file are removed too.',
      notUsed: (n) => (n === 1 ? '1 passage name in the file was not used: that passage was already here.' : `${n} passage names in the file were not used: those passages were already here.`),
    },
    fr: {
      taken: (n) => (n <= 1 ? `${n} nom de traversée a été repris du fichier.` : `${n} noms de traversée ont été repris du fichier.`),
      unreadable: 'Les noms de traversée de ce fichier n’ont pas pu être lus. Ses vérifications ont été lues normalement.',
      notPersisted: `Ce navigateur n’a pas pu enregistrer les noms de traversée${NB}; ils risquent de disparaître quand vous quitterez cette page.`,
      dialog: 'Les noms de traversée qu’elle a repris du fichier sont aussi retirés.',
      notUsed: (n) => (n <= 1 ? `${n} nom de traversée du fichier n’a pas été utilisé${NB}: cette traversée était déjà ici.` : `${n} noms de traversée du fichier n’ont pas été utilisés${NB}: ces traversées étaient déjà ici.`),
    },
  };
  const backup3 = async (names, lines) => fileOf(await gzipOf(checkFileHeaderLine({ exportedAt: '2026-11-15T12:00:00.000Z', exportedBy: 'Passage engine 0.2.0', version: 3 })
    + checkFileNamesLine(names) + lines.map((line) => `${line}\n`).join('') + checkFileTrailerLine(lines.length)), 'passage-all-checks.json.gz');
  const NAMES = [{ passage_id: 'passage-a', name: 'Alpha run' }, { passage_id: 'passage-b', name: 'Bravo → Brest' }];
  const cardTitles = () => screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);

  it.each(['en', 'fr'])('shows the names on the cards at once, says how many were taken, and the undo takes them back (%s)', async (language) => {
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backup3(NAMES, [lineOf(a), lineOf(b)]));
    const summary = await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    hasText(summary, WORDS[language].taken(2));
    await waitFor(() => expect(cardTitles()).toEqual(expect.arrayContaining(['Alpha run', 'Bravo → Brest'])));
    await user.click(within(control()).getByRole('button', { name: STRINGS[language].remove(2) }));
    const dialog = await screen.findByRole('alertdialog');
    hasText(dialog, WORDS[language].dialog);
    await user.click(within(dialog).getByRole('button', { name: STRINGS[language].confirm }));
    await waitFor(() => hasText(within(control()).getByTestId('import-removed'), STRINGS[language].removed(2)));
    expect(localStorage.getItem('deepweather.passage-labels')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Alpha run' })).toBeNull();
  });

  it('offers the undo after a file of one check when it gave a name, and not without one', async () => {
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backup3([NAMES[0]], [lineOf(a)]));
    expect(await within(control()).findByTestId('import-result', {}, { timeout: 30_000 })).toHaveTextContent(STRINGS.en.single(passages.localTime('2026-07-20T06:00:00Z', 'en')));
    // the single-check result says it took the name too
    expect(within(control()).getByTestId('import-names')).toHaveTextContent(WORDS.en.taken(1));
    await waitFor(() => hasText(liveRegion(), WORDS.en.taken(1)));
    await user.click(within(control()).getByRole('button', { name: STRINGS.en.remove(1) }));
    hasText(await screen.findByRole('alertdialog'), WORDS.en.dialog);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    // the same kind of file without a name: today's single-check result, no undo
    await user.upload(fileInput(), await backup3([], [lineOf(b)]));
    await waitFor(() => expect(within(control()).getByTestId('import-result')).toHaveTextContent('Check imported from a file'));
    expect(within(control()).queryByRole('button', { name: STRINGS.en.remove(1) })).toBeNull();
    expect(within(control()).queryByTestId('import-names')).toBeNull();
  });

  it.each(['en', 'fr'])('says a name in the file was not used after a step-by-step restore, in the summary and under a one-check result (%s)', async (language) => {
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    // step 1: a's own file of one check, which carries no passage names
    await user.upload(fileInput(), fileOf((await checkFileOf(a)).bytes));
    await within(control()).findByTestId('import-result', {}, { timeout: 30_000 });
    expect(within(control()).queryByTestId('import-names')).toBeNull();
    // step 2: a file of one check naming that passage: told as one check, with the line under it
    await user.upload(fileInput(), await backup3([NAMES[0]], [lineOf(a)]));
    await waitFor(() => hasText(within(control()).getByTestId('import-names'), WORDS[language].notUsed(1)));
    // exactly as written, the no-break space before the French colon included
    expect(within(control()).getByTestId('import-names').textContent).toBe(WORDS[language].notUsed(1));
    await waitFor(() => hasText(liveRegion(), WORDS[language].notUsed(1)));
    // step 3: the file of all checks naming both: one name taken, one not used, in the summary
    await user.upload(fileInput(), await backup3(NAMES, [lineOf(a), lineOf(b)]));
    const summary = await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    hasText(summary, WORDS[language].taken(1));
    hasText(summary, WORDS[language].notUsed(1));
    expect(JSON.parse(localStorage.getItem('deepweather.passage-labels'))).toEqual({ 'local|passage|passage-b': 'Bravo → Brest' });
  });

  it('says nothing about unused names when the same file comes back to a browser holding everything under the same names', async () => {
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    const file = await backup3(NAMES, [lineOf(a), lineOf(b)]);
    await user.upload(fileInput(), file);
    hasText(await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 }), WORDS.en.taken(2));
    await user.upload(fileInput(), await backup3(NAMES, [lineOf(a), lineOf(b)]));
    await waitFor(() => hasText(within(control()).getByTestId('import-summary'), STRINGS.en.already(2)));
    expect(within(control()).getByTestId('import-summary').textContent).not.toMatch(/passage names? (in the file w|w)/);
  });

  it.each(['en', 'fr'])('says the name of a forged check on the sailor\'s own passage was not used, and keeps the passage\'s name (%s)', async (language) => {
    await localSnapshots.writeAll(own.snapshotId, saved(own));
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backup3([{ passage_id: 'passage-own', name: 'Hostile name' }, NAMES[0]], [lineOf(ownPassage), lineOf(a)]));
    const summary = await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    hasText(summary, WORDS[language].taken(1));
    hasText(summary, WORDS[language].notUsed(1));
    expect(JSON.parse(localStorage.getItem('deepweather.passage-labels'))).toEqual({ 'local|passage|passage-a': 'Alpha run' });
    expect(screen.queryByRole('heading', { name: 'Hostile name' })).toBeNull();
  });

  it.each(['en', 'fr'])('says when the names could not be read, and when this browser could not keep them (%s)', async (language) => {
    const calls = standIn();
    await showPassages(language);
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backupFile([lineOf(a)]));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(v2({ end: 'complete', linesRead: 2, outcomes: { imported: 2 }, importedIds: ['snapshot_v2_0123456789abcdef', 'snapshot_v2_0123456789abcde0'],
      namesUnreadable: true, namesNotPersisted: true, appliedNames: [{ key: 'local|passage|x', name: 'X' }] }));
    const alert = await within(control()).findByRole('alert');
    hasText(alert, WORDS[language].unreadable);
    hasText(alert, WORDS[language].notPersisted);
    hasText(within(control()).getByTestId('import-summary'), WORDS[language].taken(1));
  });
});

describe('the undo and names changed after the import', () => {
  const backup3 = async (names, lines) => fileOf(await gzipOf(checkFileHeaderLine({ exportedAt: '2026-11-15T12:00:00.000Z', exportedBy: 'Passage engine 0.2.0', version: 3 })
    + checkFileNamesLine(names) + lines.map((line) => `${line}\n`).join('') + checkFileTrailerLine(lines.length)), 'passage-all-checks.json.gz');
  const labels = () => JSON.parse(localStorage.getItem('deepweather.passage-labels') ?? '{}');

  it('removes the name of a passage the undo empties, even one the sailor renamed after the import', async () => {
    const { passageLabels } = await import('../src/lib/passageLabels.js');
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.upload(fileInput(), await backup3([{ passage_id: 'passage-a', name: 'Alpha run' }], [lineOf(a)]));
    await within(control()).findByTestId('import-result', {}, { timeout: 30_000 });
    passageLabels.set('local|passage|passage-a', 'Renamed after the import');
    await user.click(within(control()).getByRole('button', { name: STRINGS.en.remove(1) }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: STRINGS.en.confirm }));
    await waitFor(() => hasText(within(control()).getByTestId('import-removed'), STRINGS.en.removed(1)));
    expect(labels()).toEqual({});
  });

  it('keeps a name the sailor changed on a passage that still has checks after the undo', async () => {
    const { passageLabels } = await import('../src/lib/passageLabels.js');
    await showPassages();
    const user = userEvent.setup({ advanceTimers: () => {} });
    // two checks of passage-a: one in this import, then one made here, which the undo leaves
    await user.upload(fileInput(), await backup3([{ passage_id: 'passage-a', name: 'Alpha run' }], [lineOf(a), lineOf(b)]));
    await within(control()).findByTestId('import-summary', {}, { timeout: 30_000 });
    const sameA = await makeCheck({ passageId: 'passage-a', departureUtc: '2026-07-27T06:00:00Z', nowMs: Date.parse('2026-07-19T23:00:00Z') });
    await localSnapshots.writeAll(sameA.snapshotId, saved(sameA));
    passageLabels.set('local|passage|passage-a', 'Changed since');
    await user.click(within(control()).getByRole('button', { name: STRINGS.en.remove(2) }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: STRINGS.en.confirm }));
    await waitFor(() => hasText(within(control()).getByTestId('import-removed'), STRINGS.en.removed(2)));
    expect(labels()).toEqual({ 'local|passage|passage-a': 'Changed since' });
    expect(await ids()).toEqual([sameA.snapshotId]);
  });
});
