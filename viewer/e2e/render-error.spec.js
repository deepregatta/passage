import { expect, test } from '@playwright/test';
import { SNAPSHOT_ID } from './helpers.js';

// A browser-saved check whose stored findings make the passage page throw while
// rendering. The error stays in the page area: the header and navigation keep
// working, the tab forgets the check it had open, and a reload lands on a usable
// page instead of reopening the check that failed (2026-11-15). The check is the
// served demo copied into this test's own scratch IndexedDB, under a new id; the
// demo /data/ tree is only read.
const BROKEN_ID = 'snapshot_v2_e2e0b40ce0000001';

test('a check that cannot be shown is contained to the page area and not reopened on reload', async ({ page }) => {
  await page.route(/^https:\/\//, (route) => route.abort());
  await page.route('**/api/event', (route) => route.fulfill({ status: 204 }));
  await page.route('**/data/runs/latest.json', (route) => route.fulfill({ json: null }));
  await page.goto('/#passages');
  await expect(page.getByRole('heading', { level: 1, name: 'My passages' })).toBeVisible();

  await page.evaluate(async ({ servedId, brokenId }) => {
    const { localSnapshots } = await import('/src/lib/localSnapshots.js');
    const read = async (name) => (await fetch(`/data/snapshots/${servedId}/${name}`)).json();
    const names = ['findings.json', 'briefing.json', 'route.json', 'plume.json', 'warnings.json', 'synoptic.json'];
    const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await read(name)])));
    const manifest = await read('snapshot.json');
    // the first leg's hours are not a list: the page's sections read them while rendering
    const [first, ...legs] = files['findings.json'].legs;
    files['findings.json'] = { ...files['findings.json'], snapshot_id: brokenId, legs: [{ ...first, hours: { 0: first.hours[0] } }, ...legs] };
    files['snapshot.json'] = { ...manifest, snapshot_id: brokenId, passage_id: 'e2e-render-error', demo: undefined };
    await localSnapshots.writeAll(brokenId, Object.entries(files).map(([filename, doc]) => ({ filename, content: JSON.stringify(doc) })));
  }, { servedId: SNAPSHOT_ID, brokenId: BROKEN_ID });

  await page.reload();
  const open = page.locator(`[data-snapshot-id="${BROKEN_ID}"]`);
  await expect(open).toBeVisible();
  await open.click();

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'This page could not be shown.' })).toBeVisible({ timeout: 15_000 });
  await expect(main.getByText('Something in it could not be displayed. Your saved checks have not been changed.', { exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Go to My passages' })).toBeVisible();
  // the header and navigation are still there and usable
  await expect(page.getByRole('banner')).toBeVisible();
  const myPassages = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'My passages' });
  await expect(myPassages).toBeEnabled();
  // the tab no longer remembers the check that failed
  expect(await page.evaluate(() => sessionStorage.getItem('deepweather.open-check'))).toBeNull();

  // a reload is not blank and does not reopen the check: the passage page's empty state
  await page.reload();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByText(/No check open/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'This page could not be shown.' })).toHaveCount(0);
  await myPassages.click();
  await expect(page.getByRole('heading', { level: 1, name: 'My passages' })).toBeVisible();
  // the saved check is unchanged and still listed, so it can be deleted
  await expect(page.locator(`[data-snapshot-id="${BROKEN_ID}"]`)).toBeVisible();
});
