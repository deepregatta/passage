import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { installBlobStream, makeCheck } from './helpers/checkFiles.js';

// "Save all checks to a file" in the storage block of My passages, through the real
// store (fake-indexeddb, a fresh factory per test). The file itself is made by the real
// library in the first test and read back; the other states use a stand-in for it so
// each state can be held and seen. No download leaves the test: the anchor click is caught.
vi.setConfig({ testTimeout: 60_000 });

const NB = ' ';
const STRINGS = {
  en: {
    button: 'Save all checks to a file',
    hint: 'One file with every check saved in this browser, made here without sending anything. Keep it on another device or drive: if this browser deletes its checks, you can import them again.',
    making: (i, n) => `Making the file: check ${i} of ${n}…`,
    stop: 'Stop',
    stopped: 'Stopped. No file was made.',
    readySmall: (n) => `File ready: ${n} ${n === 1 ? 'check' : 'checks'}, less than 1 MB.`,
    ready: (n, size) => `File ready: ${n} ${n === 1 ? 'check' : 'checks'}, about ${size}.`,
    save: 'Save the file',
    saved: 'Your browser saves it with its downloads. Nothing is sent anywhere.',
    empty: 'No check saved in this browser can be put in a file.',
    failed: 'Could not make the file. Please try again.',
    last: (date, n) => `Last file of all checks: made ${date}, ${n} ${n === 1 ? 'check' : 'checks'}.`,
    missing: (n) => (n === 1 ? '1 check is not in that file.' : `${n} checks are not in that file.`),
    skipped: [
      '2 checks were left out because they are damaged in this browser.',
      '1 check was left out because this browser could not read it.',
      '1 check was left out because it holds boat polar data, which Passage never puts in a file.',
      '3 checks were left out because they are too large for a file.',
      '4 older checks were left out because the file is full.',
      '1 older check cannot be put in a file: it was saved by an earlier version of Passage.',
      '2 checks in the file have a time in the future. They can be imported only once that time has come: check this device’s date and time.',
    ],
  },
  fr: {
    button: 'Enregistrer toutes les vérifications dans un fichier',
    hint: `Un seul fichier avec toutes les vérifications enregistrées dans ce navigateur, créé ici sans rien envoyer. Gardez-le sur un autre appareil ou support${NB}: si ce navigateur supprime ses vérifications, vous pourrez les importer à nouveau.`,
    making: (i, n) => `Création du fichier${NB}: vérification ${i} sur ${n}…`,
    stop: 'Arrêter',
    stopped: 'Arrêté. Aucun fichier n’a été créé.',
    ready: (n, size) => `Fichier prêt${NB}: ${n} ${n <= 1 ? 'vérification' : 'vérifications'}, environ ${size}.`,
    save: 'Enregistrer le fichier',
    saved: 'Votre navigateur l’enregistre avec ses téléchargements. Rien n’est envoyé nulle part.',
    empty: 'Aucune vérification enregistrée dans ce navigateur ne peut être mise dans un fichier.',
    failed: 'Impossible de créer le fichier. Veuillez réessayer.',
    last: (date, n) => `Dernier fichier de toutes les vérifications${NB}: créé ${date}, ${n} ${n <= 1 ? 'vérification' : 'vérifications'}.`,
    missing: (n) => (n <= 1 ? `${n} vérification n’est pas dans ce fichier.` : `${n} vérifications ne sont pas dans ce fichier.`),
    skipped: [
      '2 vérifications ont été laissées de côté, car elles sont endommagées dans ce navigateur.',
      '1 vérification a été laissée de côté, car ce navigateur n’a pas pu la lire.',
      '1 vérification a été laissée de côté, car elle contient des données de polaire du bateau, que Passage ne met jamais dans un fichier.',
      '3 vérifications ont été laissées de côté, car elles sont trop volumineuses pour un fichier.',
      '4 vérifications plus anciennes ont été laissées de côté, car le fichier est plein.',
      `1 vérification plus ancienne ne peut pas être mise dans un fichier${NB}: elle a été enregistrée par une version antérieure de Passage.`,
      `2 vérifications du fichier ont une heure dans le futur. Elles ne pourront être importées qu’une fois cette heure passée${NB}: vérifiez la date et l’heure de cet appareil.`,
    ],
  },
};

let checks;
beforeAll(async () => {
  installBlobStream();
  checks = [
    await makeCheck({ passageId: 'passage-one', nowMs: Date.parse('2026-07-19T17:00:00Z') }),
    await makeCheck({ passageId: 'passage-two', departureUtc: '2026-07-21T06:00:00Z', nowMs: Date.parse('2026-07-19T18:00:00Z') }),
  ];
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
});
afterEach(() => { vi.doUnmock('../src/lib/allChecksFile.js'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const saved = (check) => Object.entries(check.files).map(([filename, content]) => ({ filename, content }))
  .sort((a, b) => (a.filename === 'snapshot.json') - (b.filename === 'snapshot.json'));
const storeAll = async () => { for (const check of checks) await localSnapshots.writeAll(check.snapshotId, saved(check)); };

async function showPassages(language = 'en') {
  useApp.setState({ language });
  const { default: Passages } = await import('../src/pages/Passages.jsx');
  const view = render(<div id="root"><Passages /><i18n.LocalizedDocument language={language} /></div>);
  await screen.findByRole('heading', { level: 1 });
  await waitFor(() => expect(useApp.getState().manifest).not.toBeNull());
  return view;
}
const control = () => screen.getByTestId('save-all-checks');
// no-break spaces and spaces alike, on both sides (toHaveTextContent folds only the element's)
const folded = (text) => text.replace(/\s+/g, ' ').trim();
const hasText = (element, text) => expect(folded(element.textContent)).toContain(folded(text));
const liveRegion = () => screen.getByRole('status');

/** Catch the download: the Blob handed over, the anchor click, the object URLs. */
function catchDownloads() {
  const downloads = { blobs: [], clicks: [], revoked: [] };
  URL.createObjectURL = vi.fn((blob) => { downloads.blobs.push(blob); return `blob:all-${downloads.blobs.length}`; });
  URL.revokeObjectURL = vi.fn((url) => { downloads.revoked.push(url); });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { downloads.clicks.push({ href: this.getAttribute('href'), download: this.download }); });
  return downloads;
}

/** A stand-in library whose file is made when the test says. */
function standIn() {
  const calls = [];
  vi.doMock('../src/lib/allChecksFile.js', () => ({
    prepareAllChecksFile: (options) => new Promise((resolve) => {
      calls.push({ options, resolve });
      options.signal.addEventListener('abort', () => resolve({ outcome: 'stopped' }));
    }),
  }));
  return calls;
}
const madeResult = (counts = {}, size = 2_400_000, included = checks.map((check) => check.snapshotId)) => ({
  outcome: 'made', blob: new Blob([new Uint8Array(size)]), name: 'passage-all-checks-2026-11-16-0900Z.json.gz', exportedAt: '2026-11-16T09:00:00.000Z', included,
  counts: { included: included.length, legacy: 0, damaged: 0, unreadable: 0, polar: 0, tooLarge: 0, overCap: 0, futureDated: 0, ...counts },
});

describe('in the storage block', () => {
  it('comes after the storage line and the note that this browser can delete checks, and before the import', async () => {
    await storeAll();
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { storage: { estimate: async () => ({ usage: 5e6, quota: 1e9 }), persisted: async () => false } }));
    await showPassages();
    const block = await screen.findByTestId('storage-block');
    await within(block).findByTestId('storage-usage');
    await within(block).findByTestId('storage-not-kept');
    const order = [...block.querySelectorAll('[data-testid]')].map((element) => element.dataset.testid)
      .filter((id) => ['storage-usage', 'storage-not-kept', 'save-all-checks', 'import-check'].includes(id));
    expect(order).toEqual(['storage-usage', 'storage-not-kept', 'save-all-checks', 'import-check']);
    expect(within(control()).getByRole('button', { name: STRINGS.en.button })).toBeVisible();
    expect(within(control()).getByText(STRINGS.en.hint)).toBeVisible();
    // the page's live region is there before anything is pressed
    expect(liveRegion()).toBeInTheDocument();
  });

  it('is not offered without a check that can be put in a file, or without CompressionStream', async () => {
    const empty = await showPassages();
    expect(screen.queryByTestId('save-all-checks')).toBeNull();
    // the import still is
    expect(screen.getByTestId('import-check')).toBeInTheDocument();
    empty.unmount();
    // a legacy identity-1 check only
    const legacyId = '20260720T060000Z_44d2cd5f_64ea971e';
    await localSnapshots.writeAll(legacyId, [{ filename: 'snapshot.json', content: JSON.stringify({ snapshot_id: legacyId, created_at: '2026-07-19T13:00:00Z' }) }]);
    const legacy = await showPassages();
    expect(screen.queryByTestId('save-all-checks')).toBeNull();
    legacy.unmount();
    await storeAll();
    vi.stubGlobal('CompressionStream', undefined);
    await showPassages();
    expect(screen.queryByTestId('save-all-checks')).toBeNull();
  });
});

describe('making the file', () => {
  it('makes the real file, then saves it with a second tap, keeping focus, and remembers what it holds', async () => {
    await storeAll();
    const downloads = catchDownloads();
    await showPassages();
    const user = userEvent.setup();
    const button = within(control()).getByRole('button', { name: STRINGS.en.button });
    await user.click(button);
    const ready = await within(control()).findByTestId('save-all-ready', {}, { timeout: 30_000 });
    expect(ready).toHaveTextContent(STRINGS.en.readySmall(2));
    expect(button).toHaveFocus();
    await waitFor(() => expect(liveRegion()).toHaveTextContent(STRINGS.en.readySmall(2)));
    // nothing handed over before the second tap
    expect(downloads.clicks).toEqual([]);
    await user.click(within(control()).getByRole('button', { name: STRINGS.en.save }));
    expect(downloads.clicks).toEqual([{ href: 'blob:all-1', download: expect.stringMatching(/^passage-all-checks-\d{4}-\d{2}-\d{2}-\d{4}Z\.json\.gz$/) }]);
    expect(within(control()).getByTestId('save-all-saved')).toHaveTextContent(STRINGS.en.saved);
    expect(liveRegion()).toHaveTextContent(STRINGS.en.saved);
    // the file is the backup: read back, two lines
    const { readCheckFileLines } = await import('../src/lib/checkFileLines.js');
    const lines = [];
    let header;
    for await (const item of readCheckFileLines(downloads.blobs[0])) {
      if (typeof item === 'string') lines.push(item);
      else if (item.kind === 'v2') ({ header } = item);
    }
    expect(lines).toHaveLength(2);
    // the last file, remembered with its checks and the instant the file was made (its header's, as in its name)
    const record = JSON.parse(localStorage.getItem('deepweather.last-checks-file'));
    expect(record.ids.sort()).toEqual(checks.map((check) => check.snapshotId).sort());
    expect(record.made_at).toBe(header.exportedAt);
    const iso = header.exportedAt;
    expect(downloads.clicks[0].download).toBe(`passage-all-checks-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}Z.json.gz`);
    expect(within(control()).getByTestId('last-checks-file')).toHaveTextContent(STRINGS.en.last(passages.localTime(record.made_at, 'en'), 2));
    // the object URL is kept for another tap, and released a minute after pagehide (some browsers read it late)
    await user.click(within(control()).getByRole('button', { name: STRINGS.en.save }));
    expect(downloads.clicks.map((click) => click.href)).toEqual(['blob:all-1', 'blob:all-1']);
    expect(downloads.revoked).toEqual([]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      window.dispatchEvent(new Event('pagehide'));
      vi.advanceTimersByTime(59_999);
      expect(downloads.revoked).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(downloads.revoked).toEqual(['blob:all-1']);
    } finally {
      vi.useRealTimers();
    }
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(['en', 'fr'])('shows the count while making, stops on Stop and keeps nothing (%s)', async (language) => {
    await storeAll();
    const calls = standIn();
    const downloads = catchDownloads();
    await showPassages(language);
    const user = userEvent.setup();
    const button = within(control()).getByRole('button', { name: STRINGS[language].button });
    await user.click(button);
    await waitFor(() => expect(calls).toHaveLength(1));
    // busy: focus stays, a second press starts nothing
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
    await user.click(button);
    expect(calls).toHaveLength(1);
    calls[0].options.onProgress({ index: 1, total: 2 });
    const progress = await within(control()).findByTestId('save-all-progress');
    await waitFor(() => hasText(progress, STRINGS[language].making(2, 2)));
    expect(progress.querySelector('progress')).toHaveAttribute('value', '1');
    // the bar is named by the text beside it
    const bar = within(progress).getByRole('progressbar');
    hasText(document.getElementById(bar.getAttribute('aria-labelledby')), STRINGS[language].making(2, 2));
    if (language === 'en') expect(within(progress).getByRole('progressbar', { name: STRINGS.en.making(2, 2) })).toBe(bar);
    // no announcement per check
    expect(liveRegion()).toHaveTextContent('');
    // by keyboard: Stop, then focus on the line saying it stopped, never the page
    within(progress).getByRole('button', { name: STRINGS[language].stop }).focus();
    await user.keyboard('{Enter}');
    await within(control()).findByTestId('save-all-stopped');
    await waitFor(() => expect(within(control()).getByTestId('save-all-stopped')).toHaveFocus());
    hasText(within(control()).getByTestId('save-all-stopped'), STRINGS[language].stopped);
    await waitFor(() => hasText(liveRegion(), STRINGS[language].stopped));
    expect(within(control()).queryByRole('button', { name: STRINGS[language].save })).toBeNull();
    expect(downloads.clicks).toEqual([]);
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it.each(['en', 'fr'])('lists each reason checks were left out, one line each (%s)', async (language) => {
    await storeAll();
    const calls = standIn();
    catchDownloads();
    await showPassages(language);
    const user = userEvent.setup();
    await user.click(within(control()).getByRole('button', { name: STRINGS[language].button }));
    await waitFor(() => expect(calls).toHaveLength(1));
    // focus on Stop when the file is made: it moves to the ready line as Stop goes
    within(control()).getByRole('button', { name: STRINGS[language].stop }).focus();
    calls[0].resolve(madeResult({ damaged: 2, unreadable: 1, polar: 1, tooLarge: 3, overCap: 4, legacy: 1, futureDated: 2 }));
    const ready = await within(control()).findByTestId('save-all-ready');
    await waitFor(() => expect(ready).toHaveFocus());
    const size = i18n.translateText('2 MB', language);
    hasText(ready, STRINGS[language].ready(2, size));
    const lines = within(control()).getAllByRole('listitem').map((item) => item.textContent);
    expect(lines.map(folded)).toEqual(STRINGS[language].skipped.map(folded));
    expect(within(control()).getByRole('button', { name: STRINGS[language].save })).toBeVisible();
  });

  it.each(['en', 'fr'])('says plainly when nothing could be put in a file, and when the file could not be made (%s)', async (language) => {
    await storeAll();
    const calls = standIn();
    await showPassages(language);
    const user = userEvent.setup();
    await user.click(within(control()).getByRole('button', { name: STRINGS[language].button }));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve({ outcome: 'empty', counts: { included: 0, legacy: 1, damaged: 0, unreadable: 0, polar: 0, tooLarge: 0, overCap: 0, futureDated: 0 } });
    hasText(await within(control()).findByRole('alert'), STRINGS[language].empty);
    expect(within(control()).getAllByRole('listitem').map((item) => folded(item.textContent))).toEqual([folded(STRINGS[language].skipped[5])]);
    await user.click(within(control()).getByRole('button', { name: STRINGS[language].button }));
    await waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve({ outcome: 'failed', reason: 'verify' });
    await waitFor(() => hasText(within(control()).getByRole('alert'), STRINGS[language].failed));
    expect(within(control()).queryByRole('button', { name: STRINGS[language].save })).toBeNull();
  });

  it('releases the previous file\'s object URL at once when a new file is made, and a minute after leaving the page', async () => {
    await storeAll();
    const calls = standIn();
    const downloads = catchDownloads();
    const view = await showPassages();
    const user = userEvent.setup();
    const button = within(control()).getByRole('button', { name: STRINGS.en.button });
    await user.click(button);
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(madeResult());
    await user.click(await within(control()).findByRole('button', { name: STRINGS.en.save }));
    expect(downloads.revoked).toEqual([]);
    await user.click(button);
    expect(downloads.revoked).toEqual(['blob:all-1']);
    await waitFor(() => expect(calls).toHaveLength(2));
    calls[1].resolve(madeResult());
    await user.click(await within(control()).findByRole('button', { name: STRINGS.en.save }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      view.unmount();
      expect(downloads.revoked).toEqual(['blob:all-1']);
      vi.advanceTimersByTime(60_000);
      expect(downloads.revoked).toEqual(['blob:all-1', 'blob:all-2']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the last file', () => {
  it.each(['en', 'fr'])('says when it was made, how many checks it holds, and how many saved since are not in it (%s)', async (language) => {
    await storeAll();
    localStorage.setItem('deepweather.last-checks-file', JSON.stringify({ made_at: '2026-11-15T08:30:00.000Z', ids: [checks[0].snapshotId] }));
    await showPassages(language);
    const line = within(control()).getByTestId('last-checks-file');
    hasText(line, STRINGS[language].last(passages.localTime('2026-11-15T08:30:00.000Z', language), 1));
    hasText(line, STRINGS[language].missing(1));
  });

  it('says nothing more when every check is in it, and nothing at all without a check saved here or a readable record', async () => {
    await storeAll();
    localStorage.setItem('deepweather.last-checks-file', JSON.stringify({ made_at: '2026-11-15T08:30:00.000Z', ids: checks.map((check) => check.snapshotId) }));
    const all = await showPassages();
    expect(within(control()).getByTestId('last-checks-file').querySelectorAll('p')).toHaveLength(1);
    all.unmount();
    localStorage.setItem('deepweather.last-checks-file', '{not json');
    const broken = await showPassages();
    expect(screen.queryByTestId('last-checks-file')).toBeNull();
    broken.unmount();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
    ({ useApp } = await import('../src/stores/appStore.js'));
    i18n = await import('../src/i18n.js');
    localStorage.setItem('deepweather.last-checks-file', JSON.stringify({ made_at: '2026-11-15T08:30:00.000Z', ids: [checks[0].snapshotId] }));
    await showPassages();
    expect(screen.queryByTestId('last-checks-file')).toBeNull();
  });

  it('works when this browser will not keep the record', async () => {
    await storeAll();
    const calls = standIn();
    const downloads = catchDownloads();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    await showPassages();
    const user = userEvent.setup();
    await user.click(within(control()).getByRole('button', { name: STRINGS.en.button }));
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0].resolve(madeResult());
    await user.click(await within(control()).findByRole('button', { name: STRINGS.en.save }));
    expect(downloads.clicks).toHaveLength(1);
    expect(within(control()).getByTestId('save-all-saved')).toHaveTextContent(STRINGS.en.saved);
  });
});

it('has French for every template of both controls, keeping its placeholders', async () => {
  const { CHECKS_FILE_TEMPLATES } = await import('../src/lib/checksFileText.js');
  expect(CHECKS_FILE_TEMPLATES).toHaveLength(60);
  for (const template of CHECKS_FILE_TEMPLATES) {
    const french = i18n.translateText(template, 'fr');
    expect(french, template).not.toBe(template);
    expect((french.match(/\{\w+\}/g) ?? []).sort(), template).toEqual((template.match(/\{\w+\}/g) ?? []).sort());
    // a no-break space before French double punctuation
    expect(french, template).not.toMatch(/ [:;?]/);
  }
});
