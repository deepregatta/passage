import { expect, test } from '@playwright/test';
import { openAuditedSnapshot, SNAPSHOT_ID } from './helpers.js';

test('Back during planner loading restores the shared briefing without reinitializing its map', async ({ page }) => {
  let releasePlanner;
  let plannerRequested;
  const pendingPlanner = new Promise((resolve) => { releasePlanner = resolve; });
  const requested = new Promise((resolve) => { plannerRequested = resolve; });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/\/src\/pages\/Planner\.jsx(\?.*)?$/, async (route) => {
    plannerRequested();
    await pendingPlanner;
    await route.continue();
  });
  const url = `/#passage?snapshot=${SNAPSHOT_ID}`;
  try {
    await page.goto(url);
    await expect(page.getByTestId('decision-band')).toBeVisible();
    await page.getByRole('button', { name: 'Route map' }).click();
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.getByRole('button', { name: 'Plan', exact: true }).first().click();
    await requested;
    await expect(page.getByText('Loading your passage…', { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`#passage\\?snapshot=${SNAPSHOT_ID}$`));
    await expect(page.getByTestId('decision-band')).toBeVisible();
    await page.getByRole('button', { name: 'Route map' }).click();
    await expect(page.locator('.leaflet-container')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    releasePlanner();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const french of [false, true]) {
  test(`copied analysis opens in an independent ${french ? 'French' : 'English'} browser context and survives reload/history`, async ({ page, context, browser, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openAuditedSnapshot(page);
    if (french) await page.getByRole('button', { name: 'Français' }).click();
    await page.getByRole('button', { name: french ? 'Partager cette vérification' : 'Share this check' }).click();
    await expect(page.getByRole('button', { name: french ? 'Lien copié' : 'Link copied' })).toBeVisible();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toBe(new URL(`/${french ? 'fr/' : ''}#passage?snapshot=${SNAPSHOT_ID}`, baseURL).href);
    const recipient = await browser.newContext();
    try {
      const tab = await recipient.newPage();
      await tab.goto(url);
      await expect(tab.getByTestId('decision-band')).toBeVisible();
      await expect(tab.getByText(french ? 'SCÉNARIO D’ALERTE SIMULÉ' : 'EMULATED WARNING SCENARIO', { exact: false }).first()).toBeVisible();
      await tab.reload();
      await expect(tab.getByTestId('decision-band')).toBeVisible();
      await tab.getByRole('button', { name: french ? 'Planifier' : 'Plan', exact: true }).first().click();
      await expect(tab).toHaveURL(/#plan$/);
      await tab.goBack();
      await expect(tab).toHaveURL(url);
      await expect(tab.getByTestId('decision-band')).toBeVisible();
    } finally {
      await recipient.close();
    }
  });
}

test('local briefings cannot be shared by link', async ({ page }) => {
  await page.goto('/#passages');
  await page.evaluate(async (id) => {
    const { localSnapshots } = await import('/src/lib/localSnapshots.js');
    for (const name of ['snapshot.json', 'findings.json', 'briefing.json']) {
      const doc = await (await fetch(`/data/snapshots/${id}/${name}`)).json();
      doc.snapshot_id = 'local-analysis';
      doc.demo = false;
      // the latest check of its passage, so the passage row opens it
      if (name === 'snapshot.json') doc.created_at = '2026-07-19T19:00:00Z';
      await localSnapshots.write('local-analysis', name, JSON.stringify(doc));
    }
  }, SNAPSHOT_ID);
  await page.reload();
  await page.locator('button[data-snapshot-id="local-analysis"]').click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('decision-band')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share this check' })).toBeDisabled();
  await expect(page.getByText('This briefing is stored only in this browser and cannot be shared by link.')).toBeVisible();
});

test('a browser-saved check reopens after a reload in its own tab, through history, until it is deleted', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#passages');
  await page.evaluate(async (id) => {
    const { localSnapshots } = await import('/src/lib/localSnapshots.js');
    for (const [localId, createdAt] of [['local-one', '2026-07-19T19:00:00Z'], ['local-two', '2026-07-19T19:30:00Z']]) {
      for (const name of ['snapshot.json', 'findings.json', 'briefing.json']) {
        const doc = await (await fetch(`/data/snapshots/${id}/${name}`)).json();
        doc.snapshot_id = localId;
        doc.demo = false;
        if (name === 'snapshot.json') doc.created_at = createdAt;
        await localSnapshots.write(localId, name, JSON.stringify(doc));
      }
    }
  }, SNAPSHOT_ID);
  await page.reload();
  const other = await context.newPage();
  other.on('pageerror', (error) => errors.push(error.message));
  const openCheck = (tab) => tab.evaluate(async () => {
    const app = (await import('/src/stores/appStore.js')).useApp.getState();
    return { id: app.snapshotId, source: app.snapshotSource };
  });
  const openFromList = async (tab, localId) => {
    await tab.locator(`button[data-snapshot-id="${localId}"]`).click({ position: { x: 8, y: 8 } });
    await expect(tab.getByTestId('decision-band')).toBeVisible();
  };
  await openFromList(page, 'local-one');
  await other.goto('/#passages');
  await openFromList(other, 'local-two');
  // Two tabs of one browser: each reload reopens that tab's own check, never the id in the URL.
  for (const [tab, id] of [[page, 'local-one'], [other, 'local-two'], [page, 'local-one']]) {
    await tab.reload();
    await expect(tab.getByTestId('decision-band')).toBeVisible();
    await expect(tab).toHaveURL(/#passage$/);
    expect(await openCheck(tab)).toEqual({ id, source: 'local' });
  }
  // Still not shareable once reopened.
  await expect(page.getByRole('button', { name: 'Share this check' })).toBeDisabled();
  // History: My passages, a reload there, then Back reopens the same check; Forward returns.
  await page.getByRole('link', { name: 'My passages' }).first().click();
  await expect(page).toHaveURL(/#passages$/);
  await page.reload();
  await expect(page.locator('button[data-snapshot-id="local-one"]')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#passage$/);
  await expect(page.getByTestId('decision-band')).toBeVisible();
  expect(await openCheck(page)).toEqual({ id: 'local-one', source: 'local' });
  await page.goForward();
  await expect(page).toHaveURL(/#passages$/);
  await page.goBack();
  await expect(page.getByTestId('decision-band')).toBeVisible();
  // Served deep links are unchanged: the URL names the check, read from the server.
  await page.goto(`/#passage?snapshot=${SNAPSHOT_ID}`);
  await page.reload();
  await expect(page.getByTestId('decision-band')).toBeVisible();
  expect(await openCheck(page)).toEqual({ id: SNAPSHOT_ID, source: 'served' });
  // Deleted (here from the first tab): the other tab's reload shows the empty page, no error.
  await page.evaluate(async () => (await import('/src/stores/appStore.js')).useApp.getState().deleteSnapshot('local-two'));
  await other.reload();
  await expect(other.getByText('No briefing open.', { exact: false })).toBeVisible();
  await expect(other.getByRole('alert')).toHaveCount(0);
  await expect(other.getByTestId('decision-band')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an unavailable shared analysis reports failure instead of an empty briefing', async ({ page }) => {
  await page.goto('/#passage?snapshot=missing-analysis');
  await expect(page.getByRole('alert')).toHaveText('This shared analysis is unavailable.');
  await expect(page.getByRole('button', { name: 'Share this check' })).toHaveCount(0);
});
