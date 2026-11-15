import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import SaveCheckCopy from '../src/components/SaveCheckCopy.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';
import { localSnapshots } from '../src/lib/localSnapshots.js';
import { gunzipText } from '../src/lib/snapshotCodec.js';
// the earlier demo check: its manifest names only the files a browser-saved check has
import findings from './fixtures/demo/snapshots/snapshot_v2_8ca29e5bd5a065f3/findings.json';
import briefing from './fixtures/demo/snapshots/snapshot_v2_8ca29e5bd5a065f3/briefing.json';
import legacyFindings from './fixtures/compatibility/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import legacyBriefing from './fixtures/compatibility/20260720T060000Z_44d2cd5f_64ea971e/briefing.json';

// Opening a briefing loads its lazy chunk (charts included).
vi.setConfig({ testTimeout: 30_000 });

// "Save a copy to a file" on the passage page: a browser-saved check with a v2
// identity only. Saving reads the check through the local store and hands one gzip
// file to the browser; nothing is sent anywhere and no analytics event is sent.
const BUTTON = { en: 'Save a copy to a file', fr: 'Enregistrer une copie dans un fichier' };
const BUSY = { en: 'Saving a copy…', fr: 'Enregistrement de la copie…' };
const MADE = {
  en: 'Copy made. Your browser saves it with its downloads: one file with the route, the departure time, your limits, the boat reference and the forecast data this check used. Nothing is sent anywhere.',
  fr: 'Copie créée. Votre navigateur l’enregistre avec ses téléchargements\u00A0: un fichier avec la route, l’heure de départ, vos limites, la référence du bateau et les données de prévision utilisées par cette vérification. Rien n’est envoyé nulle part.',
};
const FAILED = {
  unreadable: { en: 'This copy was not saved: this browser could not read every file of the check.', fr: 'Cette copie n’a pas été enregistrée\u00A0: ce navigateur n’a pas pu lire tous les fichiers de la vérification.' },
  damaged: { en: 'This copy was not saved: the check stored in this browser is damaged.', fr: 'Cette copie n’a pas été enregistrée\u00A0: la vérification stockée dans ce navigateur est endommagée.' },
  polar: { en: 'This copy was not saved: the check holds boat polar data, which Passage never puts in a file.', fr: 'Cette copie n’a pas été enregistrée\u00A0: la vérification contient des données de polaire du bateau, que Passage ne met jamais dans un fichier.' },
  failed: { en: 'Could not save the copy. Please try again.', fr: 'Impossible d’enregistrer la copie. Veuillez réessayer.' },
};
const id = 'snapshot_v2_8ca29e5bd5a065f3';
// the served demo check (the passage page test reads it through the fixture server)
const servedId = 'snapshot_v2_406ad333228b0a73';
const demoDir = resolve(import.meta.dirname, 'fixtures/demo/snapshots', id);
const legacyId = '20260720T060000Z_44d2cd5f_64ea971e';

let downloads;
beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  history.replaceState(null, '', '/#plan');
  useApp.setState({ ...useApp.getInitialState(), page: 'planner', language: 'en' }, true);
  downloads = [];
  URL.createObjectURL = vi.fn((blob) => { downloads.push(blob); return `blob:copy-${downloads.length}`; });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { downloads.at(-1).name = this.download; });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { delete URL.createObjectURL; delete URL.revokeObjectURL; vi.unstubAllGlobals(); });

/** The check open in the store, as openSnapshot leaves it. */
function open(state, language = 'en') {
  useApp.setState({ loading: false, loadError: null, language, ...state });
  return render(<div id="root"><SaveCheckCopy /><LocalizedDocument language={language} /></div>);
}
const local = { snapshotId: id, snapshotSource: 'local', findings, briefing };

describe('who is offered a copy', () => {
  it.each([
    ['a browser-saved v2 check', local, true],
    ['a served check', { ...local, snapshotSource: 'served' }, false],
    ['the example', { ...local, snapshotSource: 'served', page: 'example' }, false],
    ['a legacy identity-v1 check saved in this browser', { snapshotId: legacyId, snapshotSource: 'local', findings: legacyFindings, briefing: legacyBriefing }, false],
    ['nothing open', { snapshotId: null, snapshotSource: null, findings: null, briefing: null }, false],
    ['a check still loading', { ...local, loading: true }, false],
    ['a check that failed to open', { ...local, loadError: 'x' }, false],
  ])('%s: %s', (_case, state, offered) => {
    open(state);
    expect(Boolean(screen.queryByRole('button', { name: BUTTON.en }))).toBe(offered);
  });

  it('is not offered in a browser without CompressionStream', () => {
    vi.stubGlobal('CompressionStream', undefined);
    open(local);
    expect(screen.queryByRole('button', { name: BUTTON.en })).toBeNull();
  });
});

describe('saving a copy', () => {
  // the demo check's own files, as a browser that saved it reads them back
  function storedDemo({ without = null, plant = null } = {}) {
    vi.spyOn(localSnapshots, 'exists').mockResolvedValue(true);
    vi.spyOn(localSnapshots, 'read').mockImplementation(async (_id, name) => {
      if (name === without || !existsSync(join(demoDir, name))) return null;
      const text = readFileSync(join(demoDir, name), 'utf8');
      return plant?.[name] ? plant[name](text) : text;
    });
  }

  it.each(['en', 'fr'])('keeps focus on the button through a save, announces the copy (%s), and hands one gzip file to the browser', async (language) => {
    storedDemo();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const read = localSnapshots.read.getMockImplementation();
    localSnapshots.read.mockImplementation(async (...args) => { await gate; return read(...args); });
    open(local, language);
    // the live region is there, empty, before anything happens
    const live = screen.getByRole('status');
    expect(live.textContent).toBe('');
    const button = screen.getByRole('button', { name: BUTTON[language] });
    await userEvent.click(button);
    expect(button).toHaveAccessibleName(BUSY[language]);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button).toHaveFocus();
    // a second press while saving starts nothing
    await userEvent.click(button);
    await act(async () => { release(); });
    await waitFor(() => expect(live.textContent).toBe(MADE[language]));
    expect(screen.getByRole('status')).toBe(live);
    expect(button).toHaveAccessibleName(BUTTON[language]);
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).toHaveFocus();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toMatch(/^passage-check-\d{4}-\d{2}-\d{2}-8ca29e5bd5a065f3\.json\.gz$/);
    const document = JSON.parse(await gunzipText(new Uint8Array(await downloads[0].arrayBuffer())));
    expect(document).toMatchObject({ format: 'passage-checks', format_version: 1, checks: [{ snapshot_id: id }] });
    // nothing sent: no request beyond the check's own reads, no analytics
    expect(globalThis.fetch.mock.calls.map(([url]) => String(url)).filter((url) => !url.startsWith(`/data/snapshots/${id}/`))).toEqual([]);
  });

  it.each([
    ['unreadable', { without: 'route.json' }],
    ['damaged', { plant: { 'snapshot.json': (text) => text.replace('"decision_hash": "8ca29e5bd5a065f3"', '"decision_hash": "0000000000000000"') } }],
    ['polar', { plant: { 'findings.json': (text) => text.replace('{', `{"${['speeds', 'kt'].join('_')}": [[4.1, 5.2]],`) } }],
  ])('says plainly when it is %s, in English and French, and makes no file', async (code, setup) => {
    storedDemo(setup);
    const view = open(local);
    await userEvent.click(screen.getByRole('button', { name: BUTTON.en }));
    expect((await screen.findByRole('alert')).textContent).toBe(FAILED[code].en);
    expect(downloads).toEqual([]);
    view.unmount();
    open(local, 'fr');
    await userEvent.click(screen.getByRole('button', { name: BUTTON.fr }));
    expect((await screen.findByRole('alert')).textContent).toBe(FAILED[code].fr);
  });

  it('says plainly when the file cannot be made, in English and French', async () => {
    storedDemo();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('blocked'); });
    const view = open(local);
    await userEvent.click(screen.getByRole('button', { name: BUTTON.en }));
    expect((await screen.findByRole('alert')).textContent).toBe(FAILED.failed.en);
    view.unmount();
    open(local, 'fr');
    await userEvent.click(screen.getByRole('button', { name: BUTTON.fr }));
    expect((await screen.findByRole('alert')).textContent).toBe(FAILED.failed.fr);
  });

  it('keeps each check’s own outcome: a save of A finishing after B’s started leaves B’s button alone', async () => {
    const other = 'snapshot_v2_0123456789abcdef';
    storedDemo();
    const read = localSnapshots.read.getMockImplementation();
    const gates = {};
    const release = {};
    for (const check of [id, other]) gates[check] = new Promise((resolve) => { release[check] = resolve; });
    localSnapshots.read.mockImplementation(async (check, name) => { await gates[check]; return read(check, name); });
    const checkB = { snapshotId: other, findings: { ...findings, snapshot_id: other } };
    open(local);
    await userEvent.click(screen.getByRole('button', { name: BUTTON.en }));
    expect(screen.getByRole('button', { name: BUSY.en })).toBeInTheDocument();
    // B opens while A is still saving: B's button is its own, idle
    await act(async () => { useApp.setState(checkB); });
    expect(screen.getByRole('button', { name: BUTTON.en })).not.toHaveAttribute('aria-disabled');
    await userEvent.click(screen.getByRole('button', { name: BUTTON.en }));
    expect(screen.getByRole('button', { name: BUSY.en })).toBeInTheDocument();
    // A finishes last: B still shows its own save, running
    await act(async () => { release[id](); });
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(screen.getByRole('button', { name: BUSY.en })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status').textContent).toBe('');
    // B's own outcome (the demo files are not B's: damaged), then A's when A is open again
    await act(async () => { release[other](); });
    expect((await screen.findByRole('alert')).textContent).toBe(FAILED.damaged.en);
    await act(async () => { useApp.setState(local); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(MADE.en);
  });

  it('shows no outcome for a check that was not saved here, once another is opened', async () => {
    storedDemo();
    open(local);
    await userEvent.click(screen.getByRole('button', { name: BUTTON.en }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(MADE.en));
    await act(async () => { useApp.setState({ snapshotId: 'snapshot_v2_0123456789abcdef', findings: { ...findings, snapshot_id: 'snapshot_v2_0123456789abcdef' } }); });
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.getByRole('button', { name: BUTTON.en })).not.toHaveAttribute('aria-disabled');
  });
});

it('sits beside "Share this check" on the passage page of a browser-saved check, and not on a served one', async () => {
  const serve = globalThis.fetch.getMockImplementation();
  vi.spyOn(localSnapshots, 'exists').mockImplementation(async (snapshotId) => snapshotId === servedId);
  vi.spyOn(localSnapshots, 'read').mockImplementation(async (snapshotId, name) => (snapshotId === servedId
    ? JSON.stringify(await (await serve(`/data/snapshots/${servedId}/${name}`)).json()) : null));
  vi.spyOn(localSnapshots, 'list').mockResolvedValue([]);
  render(<App />);
  await act(async () => { await useApp.getState().openSnapshot(servedId); });
  const band = await screen.findByTestId('decision-band');
  const share = within(band).getByRole('button', { name: 'Share this check' });
  const save = within(band).getByRole('button', { name: BUTTON.en });
  expect(share.parentElement.nextElementSibling).toBe(save.parentElement);
  await act(async () => { await useApp.getState().openSnapshot(servedId, null, 'briefing', 'served'); });
  expect(within(await screen.findByTestId('decision-band')).queryByRole('button', { name: BUTTON.en })).toBeNull();
});
