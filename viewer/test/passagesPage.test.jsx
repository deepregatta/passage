import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Passages from '../src/pages/Passages.jsx';
import { useApp } from '../src/stores/appStore.js';
import { fetchSnapshotJson } from '../src/lib/localSnapshots.js';
import { fmtLocalTime, localTimeZoneName } from '../src/lib/format.js';
import { groupPassages, routeChanges, PASSAGE_TEMPLATES } from '../src/lib/passages.js';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import { passageLabels } from '../src/lib/passageLabels.js';

// Reads of snapshot artifacts are scripted; nothing here may write to saved checks.
vi.mock('../src/lib/localSnapshots.js', async (original) => ({
  ...(await original()),
  fetchSnapshotJson: vi.fn(),
}));

const LABEL_KEY = 'deepweather.passage-labels';
const DEPARTURE = '2026-07-20T06:00:00Z';
const entry = (snapshot_id, created_at, extra = {}) => ({
  snapshot_id, created_at, route_id: 'my-passage-5wp', departure_utc: DEPARTURE, verdict_state: 'within',
  identity_version: 2, passage_id: 'intent-1', local: true, ...extra,
});
const oneCheck = () => [entry('snapshot_v2_24c92bf9d8b75610', '2026-07-19T18:00:00Z', { check_sequence: 1 })];
const twoChecks = (second = {}) => [
  entry('check-a', '2026-07-19T18:00:00Z', { check_sequence: 1, route_revision: 'rev-computed' }),
  entry('check-b', '2026-07-19T19:00:00Z', { check_sequence: 2, route_revision: 'rev-drawn', ...second }),
];

let deleteSnapshot;
let openSnapshot;
function show(snapshots, extra = {}) {
  deleteSnapshot = vi.fn(async () => {});
  openSnapshot = vi.fn();
  useApp.setState({
    manifest: { snapshots }, manifestError: null, loadError: null, loading: false, language: 'en',
    loadManifest: vi.fn(async () => {}), deleteSnapshot, openSnapshot, ...extra,
  });
  return render(<><Passages /><LocalizedDocument language={useApp.getState().language} /></>);
}
const departing = fmtLocalTime(DEPARTURE);

beforeEach(() => {
  localStorage.clear();
  passageLabels.forgetMemory();
  vi.mocked(fetchSnapshotJson).mockReset();
  vi.mocked(fetchSnapshotJson).mockImplementation(async (_id, file) => (file === 'route.json'
    ? { name: 'Cherbourg → Plymouth', waypoints: [{ lat: 49.6, lon: -1.6 }, { lat: 50.3, lon: -4.1 }] } : null));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); useApp.setState(useApp.getInitialState(), true); });

it('names the open action after the passage and drops the snapshot id tooltip', async () => {
  const view = show(oneCheck());
  const open = await screen.findByRole('button', { name: `Open Cherbourg → Plymouth, departing ${departing}` });
  expect(open).not.toHaveAttribute('title');
  expect(view.container.innerHTML).not.toContain('title="snapshot_v2_');
  await userEvent.click(open);
  expect(openSnapshot).toHaveBeenCalledWith('snapshot_v2_24c92bf9d8b75610');
});

it('names each lifecycle check with the passage and its time, keeping the short visible text', async () => {
  show(twoChecks());
  const first = await screen.findByRole('button', { name: `Open check 1 of Cherbourg → Plymouth, made ${fmtLocalTime('2026-07-19T18:00:00Z')}, on a different route` });
  expect(first).toHaveTextContent('Check 1');
  expect(screen.getByRole('button', { name: `Open check 2 of Cherbourg → Plymouth, made ${fmtLocalTime('2026-07-19T19:00:00Z')}` })).toHaveTextContent('Check 2');
  await userEvent.click(first);
  expect(openSnapshot).toHaveBeenCalledWith('check-a');
});

it('spells out departure and last-checked on separate lines and keeps the lifecycle from scrolling sideways', async () => {
  const view = show(twoChecks());
  await screen.findByRole('button', { name: /^Open Cherbourg/ });
  const lines = [...view.container.querySelectorAll('p')].map((p) => p.textContent);
  expect(lines).toContain(`Departs ${departing}`);
  expect(lines).toContain(`Last checked ${fmtLocalTime('2026-07-19T19:00:00Z')}`);
  expect(view.container.textContent).not.toMatch(/\bdep\b/);
  expect(view.container.querySelector('ol[aria-label="Passage progress"]').className).not.toMatch(/overflow-x/);
  expect(view.container.innerHTML).not.toMatch(/text-\[(9|10)px\]/);
  // the shared verdict chip is 11px; this page raises it to 12px
  for (const chip of view.container.querySelectorAll('[class*="text-[11px]"]')) {
    expect(chip.parentElement.className).toContain('[&>span]:text-xs');
  }
});

it('opens an alert dialog that names the passage and its departure, and keeps the permanence warning', async () => {
  const confirm = vi.spyOn(window, 'confirm');
  show(twoChecks());
  const trigger = await screen.findByRole('button', { name: `Delete Cherbourg → Plymouth, departing ${departing}` });
  expect(trigger).toHaveTextContent('Delete');
  await userEvent.click(trigger);
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete "Cherbourg → Plymouth"?' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(dialog).toHaveTextContent(`Departing ${departing} local time (${localTimeZoneName()}).`);
  expect(dialog).toHaveTextContent('This will also delete its 2 saved checks.');
  expect(dialog).toHaveTextContent('This cannot be undone.');
  expect(confirm).not.toHaveBeenCalled();
  expect(deleteSnapshot).not.toHaveBeenCalled();
});

it('cancelling or pressing Escape deletes nothing and returns focus to the delete button', async () => {
  show(oneCheck());
  const trigger = await screen.findByRole('button', { name: /^Delete Cherbourg/ });
  await userEvent.click(trigger);
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  await userEvent.tab();
  expect(dialog).toContainElement(document.activeElement);
  await userEvent.tab();
  expect(dialog).toContainElement(document.activeElement);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(deleteSnapshot).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
  await userEvent.click(trigger);
  await screen.findByRole('alertdialog');
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(deleteSnapshot).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});

it('confirming deletes every check of the passage and its label', async () => {
  localStorage.setItem(LABEL_KEY, JSON.stringify({ 'local|passage|intent-1': 'Weekend trip', 'local|passage|other': 'Keep me' }));
  show(twoChecks());
  await userEvent.click(await screen.findByRole('button', { name: /^Delete Weekend trip/ }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete passage' }));
  await waitFor(() => expect(deleteSnapshot).toHaveBeenCalledTimes(2));
  expect(deleteSnapshot.mock.calls.map(([id]) => id)).toEqual(['check-a', 'check-b']);
  await waitFor(() => expect(JSON.parse(localStorage.getItem(LABEL_KEY))).toEqual({ 'local|passage|other': 'Keep me' }));
});

it('shows a delete failure next to its card as an alert', async () => {
  show(oneCheck());
  deleteSnapshot.mockRejectedValue(new Error('Could not delete: disk full'));
  await userEvent.click(await screen.findByRole('button', { name: /^Delete Cherbourg/ }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete briefing' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Could not delete: disk full');
  expect(screen.getByRole('article')).toContainElement(alert);
});

it('renames as a display label only: label stored, saved checks untouched, survives remount', async () => {
  const snapshots = twoChecks({ route_revision: 'rev-computed' });
  const before = structuredClone(snapshots);
  const grouped = structuredClone(groupPassages(snapshots).map(({ key, checks }) => [key, checks]));
  const view = show(snapshots);
  await userEvent.click(await screen.findByRole('button', { name: 'Rename Cherbourg → Plymouth' }));
  const input = screen.getByRole('textbox', { name: 'Passage name' });
  expect(input).toHaveValue('Cherbourg → Plymouth');
  expect(input).toHaveAttribute('maxlength', '80');
  expect(input.className).toMatch(/text-base/);
  await userEvent.clear(input);
  await userEvent.type(input, '  Summer   delivery  {Enter}');
  expect(screen.getByRole('heading', { name: /Summer delivery/ })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Passage renamed to Summer delivery.');
  expect(screen.getByRole('button', { name: `Open Summer delivery, departing ${departing}` })).toBeVisible();
  expect(screen.getByRole('button', { name: /^Open check 1 of Summer delivery/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /^Delete Summer delivery/ })).toBeVisible();
  expect(JSON.parse(localStorage.getItem(LABEL_KEY))).toEqual({ 'local|passage|intent-1': 'Summer delivery' });
  // identity untouched: same entries, same grouping key, no artifact written or removed
  expect(snapshots).toEqual(before);
  expect(groupPassages(snapshots).map(({ key, checks }) => [key, checks])).toEqual(grouped);
  expect(vi.mocked(fetchSnapshotJson).mock.calls.every(([, file]) => file === 'route.json')).toBe(true);
  expect(deleteSnapshot).not.toHaveBeenCalled();
  view.unmount();
  show(snapshots);
  expect(await screen.findByRole('button', { name: /^Open Summer delivery/ })).toBeVisible();
});

it('an empty name restores the original; Escape cancels without saving', async () => {
  localStorage.setItem(LABEL_KEY, JSON.stringify({ 'local|passage|intent-1': 'Old label' }));
  show(oneCheck());
  await userEvent.click(await screen.findByRole('button', { name: 'Rename Old label' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Passage name' }), ' draft{Escape}');
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button', { name: /^Open Old label/ })).toBeVisible();
  expect(JSON.parse(localStorage.getItem(LABEL_KEY))).toEqual({ 'local|passage|intent-1': 'Old label' });
  expect(screen.getByRole('button', { name: 'Rename Old label' })).toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: 'Rename Old label' }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Passage name' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('button', { name: /^Open Cherbourg → Plymouth/ })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Original name restored.');
  expect(JSON.parse(localStorage.getItem(LABEL_KEY) ?? '{}')).toEqual({});
});

it('still renames for this visit when storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  show(oneCheck());
  await userEvent.click(await screen.findByRole('button', { name: 'Rename Cherbourg → Plymouth' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Passage name' }), '{Control>}a{/Control}Offline name{Enter}');
  expect(await screen.findByRole('button', { name: /^Open Offline name/ })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('could not save the name');
});

it('states when the route changed between checks, by revision, without regrouping', async () => {
  const snapshots = twoChecks();
  expect(groupPassages(snapshots)).toHaveLength(1);
  const view = show(snapshots);
  expect(await screen.findByText('Route changed between checks. The thumbnail shows the latest route.')).toBeVisible();
  expect(view.container.querySelectorAll('li ol li [data-route-differs]')).toHaveLength(1);
  expect(screen.getByText('Different route')).toBeVisible();
});

it('does not claim a route change for equal revisions or checks without a revision', async () => {
  show(twoChecks({ route_revision: 'rev-computed' }));
  await screen.findByRole('button', { name: /^Open Cherbourg/ });
  expect(screen.queryByText(/changed between checks/)).toBeNull();
  cleanup();
  show(twoChecks({ route_revision: undefined }));
  await screen.findByRole('button', { name: /^Open Cherbourg/ });
  expect(screen.queryByText(/changed between checks/)).toBeNull();
});

it('does not tell a route change from a departure change, and says so', () => {
  const checks = [
    entry('a', '2026-07-19T18:00:00Z', { route_revision: 'r1', departure_utc: '2026-07-20T05:00:00Z' }),
    entry('b', '2026-07-19T19:00:00Z', { route_revision: 'r2' }),
  ];
  expect(routeChanges(checks)).toMatchObject({ kind: 'route_or_departure' });
  expect(routeChanges(twoChecks()).kind).toBe('route');
  expect(routeChanges(twoChecks({ route_revision: 'rev-computed' })).kind).toBeNull();
  expect(routeChanges(twoChecks({ route_revision: undefined })).kind).toBeNull();
});

it('every composed passage phrase has a French translation that keeps the passage name untouched', () => {
  for (const template of PASSAGE_TEMPLATES) expect(translateText(template, 'fr'), template).not.toBe(template);
  expect(translateText('Open {name}, departing {time}', 'fr')).toContain('{name}');
});

it('renders the dialog and card names in French without translating the user label', async () => {
  localStorage.setItem(LABEL_KEY, JSON.stringify({ 'local|passage|intent-1': 'Boat limit Start Finish' }));
  show(oneCheck(), { language: 'fr' });
  const trigger = await screen.findByRole('button', { name: /^Supprimer Boat limit Start Finish, départ / });
  await userEvent.click(trigger);
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveAccessibleName('Supprimer « Boat limit Start Finish » ?');
  await waitFor(() => expect(dialog).toHaveTextContent('Cette action est irréversible.'));
  expect(dialog).toHaveTextContent('Départ lun. 20 juil. 08:00, heure locale');
  expect(screen.getByRole('button', { name: /^Ouvrir Boat limit Start Finish, départ lun\. 20 juil\. 08:00$/ })).toBeVisible();
  expect(screen.getAllByRole('heading', { level: 2 })[0]).toHaveTextContent(/^Boat limit Start Finish$/);
  await act(async () => { await userEvent.click(within(dialog).getByRole('button', { name: 'Annuler' })); });
});

describe('storage usage line', () => {
  const SENTENCE = 'Passage uses about {size} of this browser’s storage, counting saved checks and downloaded forecasts.';
  const SHARE = (percent) => `That is ${percent} % of what this browser allows.`;
  const NEARLY_FULL = 'This browser’s storage for Passage is nearly full. Delete checks you no longer need, so that new checks can still be saved.';
  const sentence = (size) => SENTENCE.replace('{size}', size);
  let estimate;
  const stubEstimate = (...answers) => {
    estimate = vi.fn();
    for (const answer of answers) estimate.mockImplementationOnce(async () => answer);
    estimate.mockImplementation(async () => answers.at(-1));
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { storage: { estimate } }));
  };
  afterEach(() => vi.unstubAllGlobals());

  it('says what Passage uses of this browser at the ok level, with no share and no caution', async () => {
    stubEstimate({ usage: 29_400_000, quota: 100_000_000 });
    show(oneCheck());
    const line = await screen.findByTestId('storage-usage');
    expect(line).toHaveAttribute('data-level', 'ok');
    expect(line.textContent).toBe(sentence('29 MB'));
    expect(screen.queryByTestId('storage-nearly-full')).toBeNull();
  });

  it('writes less than 1 MB and one-decimal gigabytes', async () => {
    stubEstimate({ usage: 400_000, quota: 100_000_000 });
    show(oneCheck());
    // below 1 MB there is no "about": "about less than" would not parse
    expect((await screen.findByTestId('storage-usage')).textContent)
      .toBe('Passage uses less than 1 MB of this browser’s storage, counting saved checks and downloaded forecasts.');
    cleanup();
    stubEstimate({ usage: 1_200_000_000, quota: 10_000_000_000 });
    show(oneCheck());
    expect((await screen.findByTestId('storage-usage')).textContent).toBe(sentence('1.2 GB'));
  });

  it('adds the share from the high level, without the caution', async () => {
    stubEstimate({ usage: 50_000_000, quota: 100_000_000 });
    show(oneCheck());
    const line = await screen.findByTestId('storage-usage');
    expect(line).toHaveAttribute('data-level', 'high');
    expect(line.textContent).toBe(`${sentence('50 MB')} ${SHARE(50)}`);
    expect(screen.queryByTestId('storage-nearly-full')).toBeNull();
  });

  it('rounds the percent down, so a share below a threshold never reads as the threshold', async () => {
    stubEstimate({ usage: 79_600_000, quota: 100_000_000 });
    show(oneCheck());
    const line = await screen.findByTestId('storage-usage');
    expect(line).toHaveAttribute('data-level', 'high');
    expect(line.textContent).toBe(`${sentence('80 MB')} ${SHARE(79)}`);
    cleanup();
    stubEstimate({ usage: 49_900_000, quota: 100_000_000 });
    show(oneCheck());
    expect((await screen.findByTestId('storage-usage')).textContent).toBe(sentence('50 MB'));
    cleanup();
    stubEstimate({ usage: 29_000_000, quota: 100_000_000 });
    show(oneCheck());
    await screen.findByTestId('storage-usage');
    cleanup();
    stubEstimate({ usage: 800_000_000, quota: 1_000_000_000 });
    show(oneCheck());
    expect((await screen.findByTestId('storage-usage')).textContent).toContain(SHARE(80));
  });

  it('shows 100 % at most when usage exceeds the quota', async () => {
    stubEstimate({ usage: 130_000_000, quota: 100_000_000 });
    show(oneCheck());
    const line = await screen.findByTestId('storage-usage');
    expect(line).toHaveAttribute('data-level', 'nearly-full');
    expect(line.textContent).toContain(SHARE(100));
    expect(line.textContent).not.toMatch(/130 %/);
  });

  it('adds the caution only at the nearly-full level, in the page’s warning colour', async () => {
    stubEstimate({ usage: 80_000_000, quota: 100_000_000 });
    show(oneCheck());
    const line = await screen.findByTestId('storage-usage');
    expect(line).toHaveAttribute('data-level', 'nearly-full');
    const caution = screen.getByTestId('storage-nearly-full');
    expect(caution.textContent).toBe(NEARLY_FULL);
    expect(caution.className).toContain('text-verdict-exceeds');
    expect(line.textContent).toBe(`${sentence('80 MB')} ${SHARE(80)}${NEARLY_FULL}`);
    expect(caution).not.toHaveAttribute('role');
  });

  it('shows nothing when the browser gives no estimate, a broken one or no quota', async () => {
    for (const make of [
      () => vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { storage: undefined })),
      () => vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { storage: { estimate: async () => { throw new Error('no'); } } })),
      () => stubEstimate({ usage: 5, quota: 0 }),
      () => stubEstimate({ quota: 100 }),
    ]) {
      make();
      show(oneCheck());
      await screen.findByRole('button', { name: /^Open Cherbourg/ });
      await act(async () => {});
      expect(screen.queryByTestId('storage-usage')).toBeNull();
      cleanup();
    }
  });

  it('sits after the example button, so it never moves the list or that button, and asks for nothing persistent', async () => {
    const persist = vi.fn();
    stubEstimate({ usage: 1_000_000, quota: 100_000_000 });
    navigator.storage.persist = persist;
    const view = show(oneCheck());
    const line = await screen.findByTestId('storage-usage');
    const example = screen.getByRole('button', { name: /See an example briefing/ });
    expect(example.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.container.querySelector('ul').compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(persist).not.toHaveBeenCalled();
  });

  it('shows the list before the estimate resolves, then the line, without moving the list', async () => {
    let resolve;
    estimate = vi.fn(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { storage: { estimate } }));
    const view = show(oneCheck());
    await screen.findByRole('button', { name: /^Open Cherbourg/ });
    expect(screen.queryByTestId('storage-usage')).toBeNull();
    const before = view.container.querySelector('ul').outerHTML;
    await act(async () => resolve({ usage: 29_000_000, quota: 100_000_000 }));
    expect((await screen.findByTestId('storage-usage')).textContent).toBe(sentence('29 MB'));
    expect(view.container.querySelector('ul').outerHTML).toBe(before);
  });

  it('reads again after a passage is deleted, and not before', async () => {
    stubEstimate({ usage: 90_000_000, quota: 100_000_000 }, { usage: 10_000_000, quota: 100_000_000 });
    show(oneCheck());
    expect(await screen.findByTestId('storage-nearly-full')).toBeTruthy();
    expect(estimate).toHaveBeenCalledTimes(1);
    await userEvent.click(await screen.findByRole('button', { name: /^Delete Cherbourg/ }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete briefing' }));
    await waitFor(() => expect(screen.getByTestId('storage-usage')).toHaveAttribute('data-level', 'ok'));
    expect(screen.getByTestId('storage-usage').textContent).toBe(sentence('10 MB'));
    expect(screen.queryByTestId('storage-nearly-full')).toBeNull();
    expect(estimate).toHaveBeenCalledTimes(2);
  });

  it('does not read again when a delete fails', async () => {
    stubEstimate({ usage: 10_000_000, quota: 100_000_000 });
    show(oneCheck());
    await screen.findByTestId('storage-usage');
    deleteSnapshot.mockRejectedValue(new Error('Could not delete: disk full'));
    await userEvent.click(await screen.findByRole('button', { name: /^Delete Cherbourg/ }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete briefing' }));
    await screen.findByRole('alert');
    expect(estimate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ok', { usage: 29_400_000, quota: 100_000_000 }, 'Passage utilise environ 29 Mo de l’espace de stockage de ce navigateur, vérifications enregistrées et prévisions téléchargées comprises.'],
    ['ok', { usage: 400_000, quota: 100_000_000 }, 'Passage utilise moins de 1 Mo de l’espace de stockage de ce navigateur, vérifications enregistrées et prévisions téléchargées comprises.'],
    ['high', { usage: 1_200_000_000, quota: 2_000_000_000 }, 'Passage utilise environ 1,2 Go de l’espace de stockage de ce navigateur, vérifications enregistrées et prévisions téléchargées comprises. Cela représente 60 % de ce que ce navigateur autorise.'],
    ['nearly-full', { usage: 85_000_000, quota: 100_000_000 }, 'Passage utilise environ 85 Mo de l’espace de stockage de ce navigateur, vérifications enregistrées et prévisions téléchargées comprises. Cela représente 85 % de ce que ce navigateur autorise.'],
  ])('is in French at the %s level', async (level, answer, text) => {
    stubEstimate(answer);
    show(oneCheck(), { language: 'fr' });
    const line = await screen.findByTestId('storage-usage');
    expect(line).toHaveAttribute('data-level', level);
    const [first] = line.querySelectorAll('p');
    expect(first.textContent).toBe(text);
    if (level === 'nearly-full') {
      expect(screen.getByTestId('storage-nearly-full').textContent).toBe('L’espace de stockage de ce navigateur pour Passage est presque plein. Supprimez les vérifications dont vous n’avez plus besoin, afin que de nouvelles vérifications puissent encore être enregistrées.');
    } else {
      expect(screen.queryByTestId('storage-nearly-full')).toBeNull();
    }
  });
});

describe('storage not-kept line', () => {
  const LINE = 'This browser can delete saved checks on its own, for example when the device is short of space or after a while without using Passage. Passage keeps no other copy.';
  const LINE_FR = 'Ce navigateur peut supprimer de lui-même les vérifications enregistrées, par exemple lorsque l’appareil manque d’espace ou après un certain temps sans utiliser Passage. Passage n’en conserve aucune autre copie.';
  let persisted;
  const stubStorage = (storage) => vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { storage }));
  const stubPersisted = (...answers) => {
    persisted = vi.fn();
    for (const answer of answers) persisted.mockImplementationOnce(async () => answer);
    persisted.mockImplementation(async () => answers.at(-1));
    stubStorage({ persisted });
  };
  const settle = async () => { await screen.findByRole('button', { name: /^Open Cherbourg/ }); await act(async () => {}); };
  afterEach(() => vi.unstubAllGlobals());

  it('says it, exactly, when a check is saved in this browser and the browser has not agreed to keep it', async () => {
    stubPersisted(false);
    show(oneCheck());
    const line = await screen.findByTestId('storage-not-kept');
    expect(line.textContent).toBe(LINE);
    // a calm note like the usage line, never a warning colour
    expect(line.className).toContain('text-ink-soft');
    expect(line.className).not.toMatch(/verdict|red|amber/);
    expect(line).not.toHaveAttribute('role');
  });

  it('also says it when the browser cannot say (no API, no persisted(), a throwing call)', async () => {
    for (const make of [
      () => stubStorage(undefined),
      () => stubStorage({}),
      () => stubStorage({ persisted: async () => { throw new Error('no'); } }),
    ]) {
      make();
      show(oneCheck());
      expect((await screen.findByTestId('storage-not-kept')).textContent).toBe(LINE);
      cleanup();
    }
  });

  it('is absent when the browser keeps the data', async () => {
    stubPersisted(true);
    show(oneCheck());
    await settle();
    expect(screen.queryByTestId('storage-not-kept')).toBeNull();
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it('is absent when no check is saved in this browser: none at all, or only the served example', async () => {
    stubPersisted(false);
    show([]);
    await act(async () => {});
    expect(persisted).toHaveBeenCalled();
    expect(screen.queryByTestId('storage-not-kept')).toBeNull();
    cleanup();
    show([entry('snapshot_v2_24c92bf9d8b75610', '2026-07-19T18:00:00Z', { check_sequence: 1, local: false, demo: true })]);
    await settle();
    expect(screen.queryByTestId('storage-not-kept')).toBeNull();
  });

  it('shows on its own when the browser gives no storage estimate, and under the usage line when it does', async () => {
    stubStorage({ persisted: async () => false });
    show(oneCheck());
    await screen.findByTestId('storage-not-kept');
    expect(screen.queryByTestId('storage-usage')).toBeNull();
    cleanup();
    stubStorage({ persisted: async () => false, estimate: async () => ({ usage: 29_000_000, quota: 100_000_000 }) });
    show(oneCheck());
    const usage = await screen.findByTestId('storage-usage');
    const notKept = await screen.findByTestId('storage-not-kept');
    expect(usage.compareDocumentPosition(notKept) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows without a usage estimate that fails, and does not ask for persistence itself', async () => {
    const persist = vi.fn();
    stubStorage({ persist, persisted: async () => false, estimate: async () => { throw new Error('no'); } });
    show(oneCheck());
    await screen.findByTestId('storage-not-kept');
    expect(persist).not.toHaveBeenCalled();
  });

  it('is in French', async () => {
    stubPersisted(false);
    show(oneCheck(), { language: 'fr' });
    expect((await screen.findByTestId('storage-not-kept')).textContent).toBe(LINE_FR);
  });

  it('sits below the list, which renders before the answer arrives and does not move', async () => {
    let resolve;
    stubStorage({ persisted: () => new Promise((done) => { resolve = done; }) });
    const view = show(oneCheck());
    await screen.findByRole('button', { name: /^Open Cherbourg/ });
    expect(screen.queryByTestId('storage-not-kept')).toBeNull();
    const before = view.container.querySelector('ul').outerHTML;
    await act(async () => resolve(false));
    const line = await screen.findByTestId('storage-not-kept');
    expect(view.container.querySelector('ul').outerHTML).toBe(before);
    expect(view.container.querySelector('ul').compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reads again after a passage is deleted, and not before', async () => {
    stubPersisted(false, true);
    show(oneCheck());
    await screen.findByTestId('storage-not-kept');
    expect(persisted).toHaveBeenCalledTimes(1);
    await userEvent.click(await screen.findByRole('button', { name: /^Delete Cherbourg/ }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete briefing' }));
    await waitFor(() => expect(screen.queryByTestId('storage-not-kept')).toBeNull());
    expect(persisted).toHaveBeenCalledTimes(2);
  });
});
