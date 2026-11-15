// The decision band's "Closest to your limits" line is part of the saved check:
// it is read from the limits that check recorded (decision-inputs.json), never
// from the sailor's limits draft, which a freshly loaded page has not loaded yet
// and which may have been edited since the check was saved.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { runAnalysis, ScenarioBundleStore } from '@deepweather/engine';
import DecisionBand from '../src/pages/briefing/DecisionBand.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';
import { localSnapshots } from '../src/lib/localSnapshots.js';

vi.mock('../src/lib/preparedRun.js', () => ({ preparedRun: async () => ({ doc: null }) }));

const read = (path) => JSON.parse(readFileSync(resolve(import.meta.dirname, path), 'utf8'));
const profile = read('../../config/profiles/default-limits.json');
const route = read('../../config/routes/newport-newyork.json');
const LINE = /^Closest to your limits: /;

let check;
let files;
beforeAll(async () => {
  // a calm Check through the real engine: verdict within, so the band's line is the closest margin
  const store = new ScenarioBundleStore({ loadBundle: async (name) => read(`../../engine/test/fixtures/scenarios/calm/${name}.json`) });
  const result = await runAnalysis({ route, profile, departureUtc: '2026-07-20T06:00:00Z', store, now: () => Date.parse('2026-07-19T18:00:00Z') });
  check = result.findings.snapshot_id;
  files = {
    'snapshot.json': { snapshot_id: check, identity_version: 2, artifacts: { decision_inputs: 'decision-inputs.json' } },
    'findings.json': result.findings,
    'briefing.json': result.briefing,
    'route.json': route,
    'decision-inputs.json': result.snapshotInputs.decisionInputs,
  };
});

let stored;
beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, '', '/#passages');
  useApp.setState({ ...useApp.getInitialState(), language: 'en' }, true);
  stored = new Set([check]);
  vi.spyOn(localSnapshots, 'exists').mockImplementation(async (id) => stored.has(id));
  vi.spyOn(localSnapshots, 'read').mockImplementation(async (id, name) => (stored.has(id) && files[name] ? JSON.stringify(files[name]) : null));
  vi.spyOn(localSnapshots, 'list').mockResolvedValue([]);
  // the same files on the server, for a served deep link
  const serve = globalThis.fetch.getMockImplementation();
  globalThis.fetch.mockImplementation(async (input) => {
    const match = new URL(String(input), 'http://deepweather.test').pathname.match(/^\/data\/snapshots\/([^/]+)\/([^/]+)$/);
    if (match?.[1] === check && files[match[2]]) return new Response(JSON.stringify(files[match[2]]), { status: 200 });
    return serve(input);
  });
});

/** The band as a reader sees it, after the store holds the open check. */
async function band(language = 'en') {
  const { findings } = useApp.getState();
  const view = render(<div id="root"><DecisionBand findings={findings} /><LocalizedDocument language={language} /></div>);
  const node = screen.getByTestId('decision-band');
  const text = node.textContent;
  view.unmount();
  return text;
}
/** The band's verdict sentence (its h1), or null when the band shows the chip alone. */
const detail = async () => {
  const { findings } = useApp.getState();
  const view = render(<DecisionBand findings={findings} />);
  const text = screen.queryByTestId('verdict-sentence')?.textContent ?? null;
  view.unmount();
  return text;
};

it('a saved check on a fresh page shows the closest-limit line before the limits draft has loaded, as with the draft', async () => {
  // a fresh page: no limits draft, no defaults loaded
  expect(useApp.getState()).toMatchObject({ limits: null, profileDefaults: null });
  await useApp.getState().openSnapshot(check);
  expect(useApp.getState()).toMatchObject({ snapshotSource: 'local', limits: null, profileDefaults: null });
  const fresh = await detail();
  expect(fresh).toMatch(LINE);
  const freshBand = await band();
  const freshSelection = { leg: useApp.getState().selectedLegId, evidence: useApp.getState().selectedEvidenceId };
  // the same check with the draft loaded (the limits it was made with)
  useApp.setState({ limits: structuredClone(profile), profileDefaults: structuredClone(profile) });
  expect(await detail()).toBe(fresh);
  expect(await band()).toBe(freshBand);
  await useApp.getState().openSnapshot(check);
  expect({ leg: useApp.getState().selectedLegId, evidence: useApp.getState().selectedEvidenceId }).toEqual(freshSelection);
});

it('the line does not change when the limits are edited after the check was saved', async () => {
  useApp.setState({ limits: structuredClone(profile), profileDefaults: structuredClone(profile) });
  await useApp.getState().openSnapshot(check);
  const before = await band();
  expect(await detail()).toMatch(LINE);
  // the sailor edits the limits afterwards: the saved check still says what it said
  useApp.getState().updateLimit(['max_sustained_kt', 'reach'], 40);
  useApp.getState().updateLimit(['max_sustained_kt', 'downwind'], 40);
  useApp.getState().updateLimit(['max_sustained_kt', 'upwind'], 40);
  useApp.getState().updateLimit(['max_sustained_kt', 'default'], 40);
  useApp.getState().updateLimit(['max_gust_kt'], 12);
  expect(await band()).toBe(before);
  // and a reload with the edited draft keeps it too
  useApp.setState({ ...useApp.getInitialState(), language: 'en', limits: useApp.getState().limits, profileDefaults: profile }, true);
  await useApp.getState().openSnapshot(check);
  expect(await band()).toBe(before);
});

it('a served deep link shows the same line, read from the served check', async () => {
  await useApp.getState().openSnapshot(check);
  const local = await detail();
  stored.clear();
  useApp.setState({ ...useApp.getInitialState(), language: 'en' }, true);
  await useApp.getState().openSnapshot(check, null, 'briefing', 'served');
  expect(useApp.getState()).toMatchObject({ snapshotSource: 'served', limits: null });
  // the same sentence (only the local-sharing note differs between a served and a saved copy)
  expect(await detail()).toMatch(LINE);
  expect(await detail()).toBe(local);
});

it('in French the reloaded check shows the translated line', async () => {
  await useApp.getState().openSnapshot(check);
  const { findings } = useApp.getState();
  render(<div id="root"><DecisionBand findings={findings} /><LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(screen.getByTestId('verdict-sentence').textContent).toMatch(/^Au plus près de vos limites : /));
  expect(screen.getByTestId('decision-band').textContent).not.toMatch(/Closest|against your/);
});

it('a check that did not record its limits has no line, whatever the current draft', async () => {
  const { 'decision-inputs.json': _recorded, ...legacy } = files;
  const saved = files;
  files = legacy;
  try {
    useApp.setState({ limits: structuredClone(profile), profileDefaults: structuredClone(profile) });
    await useApp.getState().openSnapshot(check);
    expect(await detail()).toBeNull();
  } finally {
    files = saved;
  }
});

it('a recorded profile that is not the one the check hashed is never used', async () => {
  const saved = files;
  files = { ...files, 'decision-inputs.json': { ...files['decision-inputs.json'], profile: { ...profile, max_gust_kt: 99 } } };
  try {
    await useApp.getState().openSnapshot(check);
    expect(await detail()).toBeNull();
  } finally {
    files = saved;
  }
});

it.each([
  ['example', () => useApp.getState().loadExample()],
  ...['20260720T060000Z_44d2cd5f_4196266b', '20260720T060000Z_44d2cd5f_64ea971e', '20260720T060000Z_44d2cd5f_7b2600cd']
    .map((id) => [`legacy ${id}`, async () => {
      const dir = `./fixtures/compatibility/${id}`;
      const findings = read(`${dir}/findings.json`);
      useApp.setState({ findings, briefing: read(`${dir}/briefing.json`), snapshotId: id });
    }]),
])('%s: the band is the same with and without the limits draft, and has no closest-limit line', async (_name, open) => {
  await open();
  const without = await band();
  useApp.setState({ limits: structuredClone(profile), profileDefaults: structuredClone(profile) });
  expect(await band()).toBe(without);
  expect(without).not.toMatch(/Closest to your limits/);
});
