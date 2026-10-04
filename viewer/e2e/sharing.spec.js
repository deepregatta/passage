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
    await expect(page.getByText('Loading passage instruments…', { exact: true })).toBeVisible();
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
    await page.getByRole('button', { name: french ? 'Partager cette analyse' : 'Share this analysis' }).click();
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
  await page.locator('button[title="local-analysis"]').click();
  await expect(page.getByTestId('decision-band')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share this analysis' })).toBeDisabled();
  await expect(page.getByText('This briefing is stored only in this browser and cannot be shared by link.')).toBeVisible();
});

test('an unavailable shared analysis reports failure instead of an empty briefing', async ({ page }) => {
  await page.goto('/#passage?snapshot=missing-analysis');
  await expect(page.getByRole('alert')).toHaveText('This shared analysis is unavailable.');
  await expect(page.getByRole('button', { name: 'Share this analysis' })).toHaveCount(0);
});
