import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { checkFileEntryLine, checkFileHeaderLine, checkFileTrailerLine } from '@deepweather/engine';
import { fileOf, gzipOf, installBlobStream, makeCheck } from './helpers/checkFiles.js';

// "Import from a file" with a file of many checks (version 2), through the real importer
// and store (fake-indexeddb, a fresh factory per test), and a stand-in importer where a
// state must be held. One summary at the end; problems in one alert; an undo that
// removes exactly what this import added.
vi.setConfig({ testTimeout: 60_000 });

const NB = ' ';
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
    await waitFor(() => hasText(progress, STRINGS[language].importing(5)));
    // indeterminate: no value
    expect(progress.querySelector('progress')).not.toHaveAttribute('value');
    // no announcement per check
    hasText(liveRegion(), STRINGS[language].start);
    const button = within(control()).getByRole('button', { name: language === 'en' ? 'Importing…' : 'Importation en cours…' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    // the bar is named by the running count beside it
    const bar = within(progress).getByRole('progressbar');
    hasText(document.getElementById(bar.getAttribute('aria-labelledby')), STRINGS[language].importing(5));
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
