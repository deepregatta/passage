import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

// A browser-saved check whose manifest (snapshot.json) is damaged or hostile must
// not take My passages down: the page renders, every other passage is intact, and
// a damaged check that is listed can still be deleted from the page. Scratch
// IndexedDB only (fake-indexeddb, a fresh factory per test).

const DEPARTURE = '2026-07-20T06:00:00Z';
const good = { snapshot_id: 'good-check', created_at: '2026-07-19T18:00:00Z', route_id: 'good-passage-v1',
  departure_utc: DEPARTURE, verdict_state: 'within', identity_version: 2, passage_id: 'intent-good', check_sequence: 1 };

// [record id, stored content]: the manifest is always written as a JSON string; these are what a
// damaged browser store, an old build or a hand-edited file could hold instead.
const SHAPES = {
  'verdict "toString"': ['a-verdict', JSON.stringify({ ...good, snapshot_id: 'a-verdict', passage_id: 'intent-a', route_id: 'damaged-passage-v1', verdict_state: 'toString' })],
  'wrong types': ['a-types', JSON.stringify({ snapshot_id: 42, created_at: {}, route_id: 7, profile_id: [], departure_utc: true,
    verdict_state: { label: 'x' }, identity_version: '2', passage_id: { toString: 1 }, route_revision: 5, decision_hash: null, check_sequence: '1' })],
  'inherited-property names': ['a-inherited', JSON.stringify({ snapshot_id: 'a-inherited', created_at: 'constructor', route_id: '__proto__',
    departure_utc: 'toString', verdict_state: '__proto__', identity_version: 2, passage_id: 'constructor', route_revision: 'valueOf' })],
  'missing fields': ['a-missing', '{}'],
  'a JSON array': ['a-array', '[]'],
  'a JSON number': ['a-number', '5'],
  'not valid JSON': ['a-invalid', '{"snapshot_id": "a-invalid",'],
  'JSON null': ['a-null', 'null'],
  'content a number': ['a-content-number', 42],
  'content an object': ['a-content-object', { snapshot_id: 'a-content-object' }],
  'content null': ['a-content-null', null],
  'content bytes': ['a-content-bytes', new Uint8Array([123, 125])],
  'an id the record is not stored under': ['a-mismatch', JSON.stringify({ ...good, snapshot_id: 'elsewhere', passage_id: 'intent-m', route_id: 'mismatched-passage-v1' })],
};
// The shapes listing keeps (and so the page must offer to delete); the others are not listed, as before.
const LISTED = {
  'verdict "toString"': { snapshot_id: 'a-verdict', verdict_state: 'toString', passage_id: 'intent-a' },
  'wrong types': { snapshot_id: 'a-types', verdict_state: null },
  'inherited-property names': { snapshot_id: 'a-inherited', created_at: 'constructor', route_id: '__proto__', verdict_state: '__proto__', passage_id: 'constructor' },
  'missing fields': { snapshot_id: 'a-missing', verdict_state: null },
  'a JSON array': { snapshot_id: 'a-array', verdict_state: null },
  'a JSON number': { snapshot_id: 'a-number', verdict_state: null },
  'content a number': { snapshot_id: 'a-content-number', verdict_state: null },
  'an id the record is not stored under': { snapshot_id: 'a-mismatch', passage_id: 'intent-m' },
};

let localSnapshots;
let useApp;

async function store(records) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('passage-local-snapshots', 2);
    request.onupgradeneeded = () => {
      const files = request.result.createObjectStore('files', { keyPath: 'key' });
      files.createIndex('snapshot_id', 'snapshot_id');
      files.createIndex('filename', 'filename');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite');
    for (const [id, filename, content] of records) transaction.objectStore('files').put({ key: `${id}/${filename}`, snapshot_id: id, filename, content });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  ({ localSnapshots } = await import('../src/lib/localSnapshots.js'));
  ({ useApp } = await import('../src/stores/appStore.js'));
  useApp.setState({ language: 'en', page: 'passages' });
  localStorage.clear();
  await store([['good-check', 'snapshot.json', JSON.stringify(good)]]);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('listing saved checks', () => {
  it.each(Object.entries(SHAPES))('with a manifest holding %s keeps the other checks', async (shape, [id, content]) => {
    await store([[id, 'snapshot.json', content]]);
    const list = await localSnapshots.list();
    expect(list.find((entry) => entry.snapshot_id === 'good-check')).toEqual({ ...good, demo: false, local: true });
    const damaged = list.filter((entry) => entry.snapshot_id !== 'good-check');
    if (!LISTED[shape]) {
      expect(damaged).toEqual([]);
      return;
    }
    expect(damaged).toHaveLength(1);
    expect(damaged[0]).toMatchObject(LISTED[shape]);
    // every listed field is the type the page reads it as, or absent
    for (const key of ['snapshot_id', 'created_at', 'route_id', 'profile_id', 'departure_utc', 'passage_id', 'route_revision', 'decision_hash']) {
      expect(damaged[0][key] === undefined || typeof damaged[0][key] === 'string').toBe(true);
    }
    for (const key of ['identity_version', 'check_sequence']) expect(damaged[0][key] === undefined || typeof damaged[0][key] === 'number').toBe(true);
    expect(damaged[0].verdict_state === null || typeof damaged[0].verdict_state === 'string').toBe(true);
  });
});

describe('My passages with damaged checks', () => {
  async function showPassages() {
    const { default: Passages } = await import('../src/pages/Passages.jsx');
    render(<Passages />);
    // the served example and the good local check
    return screen.findByRole('button', { name: /^Open Good passage, departing / });
  }

  it('renders with one local manifest carrying verdict_state "toString"', async () => {
    await store([SHAPES['verdict "toString"']].map(([id, content]) => [id, 'snapshot.json', content]));
    await showPassages();
    expect(await screen.findByRole('button', { name: /^Open Cherbourg → Plymouth, departing / })).toBeInTheDocument();
    // the damaged check shows the existing insufficient chip, and can be deleted
    const card = (await screen.findByRole('button', { name: /^Open Damaged passage, departing / })).closest('article');
    expect(card).toHaveTextContent('Models disagree');
    expect(within(card).getByRole('button', { name: /^Delete Damaged passage, departing / })).toBeEnabled();
    expect(screen.getAllByRole('button', { name: /^Delete / })).toHaveLength(3);
  });

  it('renders every damaged shape at once, keeps the other passages and deletes each listed damaged check', async () => {
    await store(Object.values(SHAPES).map(([id, content]) => [id, 'snapshot.json', content]));
    await showPassages();
    expect(await screen.findByRole('button', { name: /^Open Cherbourg → Plymouth, departing / })).toBeInTheDocument();
    const listed = () => screen.getAllByRole('button', { name: /^Open / }).map((button) => button.dataset.snapshotId).filter((id) => id?.startsWith('a-')).sort();
    await waitFor(() => expect(listed()).toEqual(Object.values(LISTED).map((entry) => entry.snapshot_id).sort()));

    for (const id of listed()) {
      const card = screen.getAllByRole('button', { name: /^Open / }).find((button) => button.dataset.snapshotId === id).closest('article');
      await userEvent.click(within(card).getByRole('button', { name: /^Delete / }));
      await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^Delete (briefing|passage)$/ }));
      await waitFor(() => expect(listed()).not.toContain(id));
    }
    expect(listed()).toEqual([]);
    // the records themselves are gone, the good check and the example are not
    expect((await localSnapshots.list()).map((entry) => entry.snapshot_id)).toEqual(['good-check']);
    expect(screen.getByRole('button', { name: /^Open Good passage, departing / })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Open Cherbourg → Plymouth, departing / })).toBeInTheDocument();
  });

  it('draws a passage whose saved route is malformed', async () => {
    await store([
      ['a-route', 'snapshot.json', JSON.stringify({ ...good, snapshot_id: 'a-route', passage_id: 'intent-r', route_id: 'route-v1' })],
      ['a-route', 'route.json', JSON.stringify({ name: { en: 'x' }, waypoints: { 0: { lat: 1, lon: 2 } } })],
      ['b-route', 'snapshot.json', JSON.stringify({ ...good, snapshot_id: 'b-route', passage_id: 'intent-s', route_id: 'other-v1' })],
      ['b-route', 'route.json', JSON.stringify({ name: 'Nulls', waypoints: [null, 5, { lat: 49, lon: -2 }, { lat: '50', lon: -3 }, { lat: 50, lon: -4 }] })],
    ]);
    await showPassages();
    expect(await screen.findByRole('button', { name: /^Open Route, departing / })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Open Nulls, departing / })).toBeInTheDocument();
  });
});
