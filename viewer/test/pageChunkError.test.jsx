import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { useApp } from '../src/stores/appStore.js';
import { localSnapshots } from '../src/lib/localSnapshots.js';
import * as pageErrors from '../src/lib/pageErrors.js';

// A page whose code cannot be loaded (offline, or an old hashed chunk after a deploy)
// is not damaged check content: the page says to check the connection and reload,
// and the tab keeps the check it remembers having open, so that reload reopens it.
// The page module's code is unavailable: reading it fails with Chromium's message, as a
// rejected dynamic import does (a throwing mock factory would be rewrapped by vitest).
vi.mock('../src/pages/About.jsx', () => ({
  get default() { throw new TypeError('Failed to fetch dynamically imported module: /assets/About-abc123.js'); },
}));
vi.mock('../src/lib/pageErrors.js', async (original) => ({ ...(await original()), reloadPage: vi.fn() }));

const NOT_LOADED = {
  en: ['This page could not be loaded.', 'Check your connection, then reload the page.', 'Reload the page'],
  fr: ['Cette page n’a pas pu être chargée.', 'Vérifiez votre connexion, puis rechargez la page.', 'Recharger la page'],
};
const OPEN_CHECK_KEY = 'deepweather.open-check';
const remembered = 'snapshot_v2_406ad333228b0a73';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(pageErrors.reloadPage).mockClear();
  history.replaceState(null, '', '/#plan');
  sessionStorage.clear();
  sessionStorage.setItem(OPEN_CHECK_KEY, remembered);
  useApp.setState({ ...useApp.getInitialState(), page: 'planner', language: 'en' }, true);
  vi.spyOn(localSnapshots, 'list').mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

async function openAbout(language = 'en') {
  useApp.setState({ language });
  render(<App />);
  await act(async () => { useApp.getState().setPage('about'); });
  return screen.findByRole('heading', { name: NOT_LOADED[language][0] });
}

it('says the page could not be loaded, offers a reload and keeps the remembered check', async () => {
  const heading = await openAbout();
  const [, sentence, button] = NOT_LOADED.en;
  expect(screen.getByText(sentence, { exact: true })).toBeVisible();
  expect(screen.queryByText(/Your saved checks have not been changed/)).toBeNull();
  expect(sessionStorage.getItem(OPEN_CHECK_KEY)).toBe(remembered);
  expect(heading).toHaveFocus();
  expect(heading.closest('[role="alert"]')).not.toBeNull();
  await userEvent.click(screen.getByRole('button', { name: button }));
  expect(pageErrors.reloadPage).toHaveBeenCalledTimes(1);
});

it('says so in French', async () => {
  await openAbout('fr');
  const [, sentence, button] = NOT_LOADED.fr;
  expect(screen.getByText(sentence, { exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: button })).toBeVisible();
});

it('lets the sailor navigate to a page that loads', async () => {
  await openAbout();
  await userEvent.click(within(screen.getAllByRole('navigation', { name: 'Main navigation' })[0]).getByRole('button', { name: 'My passages' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'My passages' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: NOT_LOADED.en[0] })).toBeNull();
  expect(sessionStorage.getItem(OPEN_CHECK_KEY)).toBe(remembered);
});

describe('telling a failed import from other errors', () => {
  it.each([
    ['Chromium', new TypeError('Failed to fetch dynamically imported module: https://passage.deepregatta.com/assets/Briefing-abc.js')],
    ['Firefox', new TypeError('error loading dynamically imported module: https://passage.deepregatta.com/assets/Briefing-abc.js')],
    ['Safari', new TypeError('Importing a module script failed.')],
    ['Vite preload', new Error('Unable to preload CSS for /assets/Briefing-abc.css')],
    ['webpack-style', Object.assign(new Error('Loading chunk 3 failed.'), { name: 'ChunkLoadError' })],
  ])('recognises %s', (_browser, error) => {
    expect(pageErrors.isChunkLoadError(error)).toBe(true);
  });

  it.each([
    new TypeError('leg.hours is not iterable'),
    new TypeError("Cannot read properties of undefined (reading 'split')"),
    new Error('Objects are not valid as a React child (found: object with keys {a}).'),
    new TypeError('Failed to fetch'),
    'Failed to fetch dynamically imported module',
    { message: 7 },
    null,
    undefined,
  ])('does not take %j for one', (error) => {
    expect(pageErrors.isChunkLoadError(error)).toBe(false);
  });
});
