import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { useApp } from '../src/stores/appStore.js';
import { localSnapshots } from '../src/lib/localSnapshots.js';
import { initialPage } from '../src/lib/routes.js';
import findings from './fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/findings.json';

// Opening a briefing loads its lazy chunk (charts included).
vi.setConfig({ testTimeout: 30_000 });

// A render error inside the routed page is contained to the page area: the header and
// navigation stay usable, the tab forgets the check it had open (so a reload does not
// reopen the check that crashed), and leaving or opening another check starts afresh.
const FALLBACK = {
  en: ['This page could not be shown.', 'Something in it could not be displayed. Your saved checks have not been changed.', 'Go to My passages'],
  fr: ['Cette page n’a pas pu être affichée.', 'Une partie de son contenu n’a pas pu être affichée. Vos vérifications enregistrées n’ont pas été modifiées.', 'Aller à Mes traversées'],
};
const OPEN_CHECK_KEY = 'deepweather.open-check';
const goodId = 'snapshot_v2_406ad333228b0a73';
const brokenId = 'snapshot_v2_b40ce000000000e1';
// A leg whose hours are not a list: the page's sections read them while rendering.
const brokenFindings = { ...findings, snapshot_id: brokenId, legs: findings.legs.map((leg, i) => (i === 0 ? { ...leg, hours: { 0: leg.hours[0] } } : leg)) };

let stored;
function saveLocally() {
  stored = new Set([goodId, brokenId]);
  const serve = globalThis.fetch.getMockImplementation();
  vi.spyOn(localSnapshots, 'exists').mockImplementation(async (snapshotId) => stored.has(snapshotId));
  vi.spyOn(localSnapshots, 'read').mockImplementation(async (snapshotId, name) => {
    if (!stored.has(snapshotId)) return null;
    if (snapshotId === brokenId && name === 'findings.json') return JSON.stringify(brokenFindings);
    return JSON.stringify(await (await serve(`/data/snapshots/${goodId}/${name}`)).json());
  });
  vi.spyOn(localSnapshots, 'list').mockResolvedValue([]);
}

function reload() {
  useApp.setState({ ...useApp.getInitialState(), page: initialPage(), language: useApp.getState().language }, true);
  return render(<App />);
}

let consoleError;
beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  history.replaceState(null, '', '/#plan');
  useApp.setState({ ...useApp.getInitialState(), page: 'planner', language: 'en' }, true);
  saveLocally();
  // React reports the caught error too; the boundary adds its own line.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

async function crash(language = 'en') {
  useApp.setState({ language });
  render(<App />);
  let thrown = null;
  try {
    await act(async () => { await useApp.getState().openSnapshot(brokenId); });
  } catch (error) {
    thrown = error;
  }
  expect(useApp.getState().findings?.snapshot_id).toBe(brokenId);
  // without a boundary the whole app unmounts: no header, no navigation
  expect(document.querySelector('header'), `the app went blank: ${thrown}`).not.toBeNull();
  return screen.findByRole('heading', { name: FALLBACK[language][0] });
}

it('contains a section that throws to the page area, keeping the header and navigation', async () => {
  await crash();
  const [, sentence, button] = FALLBACK.en;
  const main = screen.getByRole('main');
  expect(within(main).getByText(sentence, { exact: true })).toBeVisible();
  expect(within(main).getByRole('button', { name: button })).toBeVisible();
  expect(screen.getByRole('banner')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Passage home' })).toBeEnabled();
  expect(screen.getAllByRole('navigation', { name: 'Main navigation' })).toHaveLength(2);
  expect(main.textContent).not.toMatch(/deepweather|\bbest\b/i);
  expect(main.textContent).not.toMatch(/\bGO\b/);
  // logged by the boundary with the error itself: once per section that failed in that render, then never again
  const logged = () => consoleError.mock.calls.filter(([first]) => first === 'Passage could not show this page:');
  const count = logged().length;
  expect(count).toBeGreaterThan(0);
  for (const [, error] of logged()) expect(error).toBeInstanceOf(Error);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(logged()).toHaveLength(count);
});

it('shows the fallback in French with the catalogue’s vocabulary', async () => {
  await crash('fr');
  const [, sentence, button] = FALLBACK.fr;
  expect(screen.getByText(sentence, { exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: button })).toBeVisible();
});

it('forgets the remembered open check, so a reload does not reopen the check that crashed', async () => {
  await crash();
  expect(sessionStorage.getItem(OPEN_CHECK_KEY)).toBeNull();
  history.replaceState(null, '', '/#passage');
  document.body.innerHTML = '';
  reload();
  expect(await screen.findByText(/No briefing open/)).toBeVisible();
  expect(useApp.getState().snapshotId).toBeNull();
  expect(screen.queryByRole('heading', { name: FALLBACK.en[0] })).toBeNull();
});

it('recovers when the sailor navigates to My passages from the header', async () => {
  await crash();
  const nav = screen.getAllByRole('navigation', { name: 'Main navigation' })[0];
  await userEvent.click(within(nav).getByRole('button', { name: 'My passages' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'My passages' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: FALLBACK.en[0] })).toBeNull();
});

it('recovers when the address changes, as the browser’s back button does', async () => {
  await crash();
  await act(async () => {
    history.pushState(null, '', '/#passages');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(await screen.findByRole('heading', { level: 1, name: 'My passages' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: FALLBACK.en[0] })).toBeNull();
});

it('recovers through its own button', async () => {
  await crash();
  await userEvent.click(screen.getByRole('button', { name: FALLBACK.en[2] }));
  expect(await screen.findByRole('heading', { level: 1, name: 'My passages' })).toBeVisible();
  expect(useApp.getState().page).toBe('passages');
});

it('opens a second, different check normally after a crash', async () => {
  await crash();
  await act(async () => { await useApp.getState().openSnapshot(goodId); });
  expect(await screen.findByTestId('decision-band')).toBeVisible();
  expect(screen.queryByRole('heading', { name: FALLBACK.en[0] })).toBeNull();
  // and the check that did open is the one the tab remembers
  expect(sessionStorage.getItem(OPEN_CHECK_KEY)).toBe(goodId);
});

it('sends no analytics event for the error', async () => {
  const beacon = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
  await crash();
  const sent = [...beacon.mock.calls.map(([, body]) => body), ...globalThis.fetch.mock.calls
    .filter(([url]) => String(url).includes('/api/event')).map(([, init]) => init?.body)];
  for (const body of sent) expect(String(body instanceof Blob ? await body.text() : body)).not.toMatch(/error|crash|fallback/i);
  delete navigator.sendBeacon;
});

it('does not loop when the fallback itself fails', async () => {
  const { default: PageErrorBoundary } = await import('../src/components/PageErrorBoundary.jsx');
  let renders = 0;
  const Throws = () => { throw new Error('page'); };
  const FallbackThrows = () => { renders += 1; throw new Error('fallback'); };
  render(<div><p>header stays</p><PageErrorBoundary resetKey="a" onNavigate={() => {}} Fallback={FallbackThrows}><Throws /></PageErrorBoundary></div>);
  expect(screen.getByText('header stays')).toBeVisible();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  // React retries a failed render a few times, then stops: the count no longer grows
  const settled = renders;
  expect(settled).toBeGreaterThan(0);
  expect(settled).toBeLessThan(10);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(renders).toBe(settled);
  expect(screen.getByText('header stays')).toBeVisible();
});

it('moves keyboard focus to the fallback’s heading, inside the alert', async () => {
  const heading = await crash();
  expect(heading).toHaveFocus();
  expect(heading).toHaveAttribute('tabindex', '-1');
  expect(heading.closest('[role="alert"]')).not.toBeNull();
});

it('resets once when its button leads back to the page that failed (My passages itself)', async () => {
  const { default: PageErrorBoundary } = await import('../src/components/PageErrorBoundary.jsx');
  const { useState } = await import('react');
  let renders = 0;
  const AlwaysThrows = () => { renders += 1; throw new Error('my passages'); };
  function Shell() {
    const [navigation, setNavigation] = useState(0);
    return <PageErrorBoundary resetKey={`passages ${navigation}`} onNavigate={() => setNavigation((n) => n + 1)}><AlwaysThrows /></PageErrorBoundary>;
  }
  render(<Shell />);
  await screen.findByRole('heading', { name: FALLBACK.en[0] });
  const logged = () => consoleError.mock.calls.filter(([first]) => first === 'Passage could not show this page:').length;
  const [rendersBefore, loggedBefore] = [renders, logged()];
  await userEvent.click(screen.getByRole('button', { name: FALLBACK.en[2] }));
  await screen.findByRole('heading', { name: FALLBACK.en[0] });
  // one fresh attempt: one log line, as for the first failure, and no more renders than it took
  expect(logged() - loggedBefore).toBe(loggedBefore);
  expect(renders - rendersBefore).toBeLessThanOrEqual(rendersBefore);
});
