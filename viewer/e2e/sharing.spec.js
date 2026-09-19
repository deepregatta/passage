import { expect, test } from '@playwright/test';
import { openAuditedSnapshot, SNAPSHOT_ID } from './helpers.js';

test('Back during planner loading restores the shared briefing without reinitializing its map', async ({ page }) => {
  let releasePlanner;
  let plannerRequested;
  const pendingPlanner = new Promise((resolve) => { releasePlanner = resolve; });
  const requested = new Promise((resolve) => { plannerRequested = resolve; });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/src/pages/Planner.jsx', async (route) => {
    plannerRequested();
    await pendingPlanner;
    await route.continue();
  });
  const url = `/#brief/story?snapshot=${SNAPSHOT_ID}`;
  try {
    await page.goto(url);
    await expect(page.getByTestId('decision-band')).toBeVisible();
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.getByRole('button', { name: /Plan$/ }).first().click();
    await requested;
    await expect(page.getByText('Loading passage instruments…', { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`#brief/story\\?snapshot=${SNAPSHOT_ID}$`));
    await expect(page.getByTestId('decision-band')).toBeVisible();
    await expect(page.locator('.leaflet-container')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    releasePlanner();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const french of [false, true]) {
  test(`copied analysis opens in an independent ${french ? 'French' : 'English'} browser context and survives reload/history`, async ({ page, context, browser }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openAuditedSnapshot(page);
    if (french) await page.getByRole('button', { name: 'Français' }).click();
    await page.getByRole('button', { name: french ? 'Partager cette analyse' : 'Share this analysis' }).click();
    await expect(page.getByRole('button', { name: french ? 'Lien copié' : 'Link copied' })).toBeVisible();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toBe(`http://127.0.0.1:5174/${french ? 'fr/' : ''}#brief/story?snapshot=${SNAPSHOT_ID}`);
    const recipient = await browser.newContext();
    try {
      const tab = await recipient.newPage();
      await tab.goto(url);
      await expect(tab.getByTestId('decision-band')).toBeVisible();
      await expect(tab.getByText(french ? 'SCÉNARIO D’ALERTE SIMULÉ' : 'EMULATED WARNING SCENARIO', { exact: false }).first()).toBeVisible();
      await tab.reload();
      await expect(tab.getByTestId('decision-band')).toBeVisible();
      await tab.getByRole('button', { name: french ? /Planifier$/ : /Plan$/ }).first().click();
      await expect(tab).toHaveURL(/#plan\/planner$/);
      await tab.goBack();
      await expect(tab).toHaveURL(url);
      await expect(tab.getByTestId('decision-band')).toBeVisible();
    } finally {
      await recipient.close();
    }
  });
}

test('local briefings cannot be shared by link', async ({ page }) => {
  await page.goto('/#brief/briefings');
  await page.evaluate(async (id) => {
    const { localSnapshots } = await import('/src/lib/localSnapshots.js');
    for (const name of ['snapshot.json', 'findings.json', 'briefing.json']) {
      const doc = await (await fetch(`/data/snapshots/${id}/${name}`)).json();
      doc.snapshot_id = 'local-analysis';
      doc.demo = false;
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
  await page.goto('/#brief/story?snapshot=missing-analysis');
  await expect(page.getByRole('alert')).toHaveText('This shared analysis is unavailable.');
  await expect(page.getByRole('button', { name: 'Share this analysis' })).toBeDisabled();
});
