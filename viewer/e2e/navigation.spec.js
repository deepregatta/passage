import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test('Plan and Verify stage checkpoints keep URL-deep-linked subviews', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: /Plan/ }).first().click();
  await expect(page).toHaveURL(/#plan\/planner$/);
  await expect(page.getByRole('heading', { name: 'Plan a passage' })).toBeVisible();
  await page.locator('.leaflet-container').waitFor();
  await page.waitForTimeout(250);
  await expect(page).toHaveScreenshot('plan.png', { fullPage: true });
  await page.getByRole('button', { name: /Verify/ }).first().click();
  await expect(page).toHaveURL(/#verify\/record$/);
  await expect(page.getByText(/Skill claims use 11 real ERA5 cases/i)).toBeVisible();
  await expect(page).toHaveScreenshot('verify.png', { fullPage: true });
});

test('visible stage targets are at least 44 pixels tall', async ({ page }) => {
  await openAuditedSnapshot(page);
  const sizes = await page.getByRole('navigation', { name: 'Passage stages' }).locator('button:visible').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  expect(sizes.length).toBeGreaterThan(0);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44);
});

test('Verify publishes the frozen demo case study with emulated exclusion', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: /Verify/ }).first().click();
  await page.getByRole('button', { name: 'Case study', exact: true }).click();
  await expect(page).toHaveURL(/#verify\/case-study$/);
  await expect(page.getByRole('heading', { name: /What the forecast said, and what happened/i })).toBeVisible();
  await expect(page.getByText(/NOT A SKILL CLAIM/i)).toBeVisible();
});

test('Verify renders complete French copy, including dynamic counts and analysis state', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'Français' }).click();
  await page.getByRole('button', { name: /Vérifier/ }).first().click();
  await expect(page.getByText('Les mesures de fiabilité reposent sur 11 cas ERA5 réels.')).toBeVisible();
  await expect(page.getByText('10 réussites · 1 échec · 0 en attente')).toBeVisible();
  await expect(page.getByText('1 cas simulé affiché uniquement pour la démonstration.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Cette analyse ·/ })).toBeVisible();
  await expect(page.getByText(/How the forecasts|Skill claims|emulated cases|Not verified yet|Reanalysis-referenced|leg · hour/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Étude de cas', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ce que prévoyait la météo et ce qui s’est produit' })).toBeVisible();
  await expect(page.getByText('DÉMONSTRATION SIMULÉE · AUCUN RÉSULTAT RÉEL')).toBeVisible();
});

test('the /fr/ URL renders French and the switcher navigates between language URLs', async ({ page }) => {
  await page.goto('/fr/');
  await expect(page).toHaveTitle(/Planification météo explicable/);
  await expect(page.getByRole('heading', { name: 'Planifier une traversée' })).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:5174\/#plan\/planner$/);
  await expect(page.getByRole('heading', { name: 'Plan a passage' })).toBeVisible();
  await page.getByRole('button', { name: 'Français', exact: true }).click();
  await expect(page).toHaveURL(/\/fr\/#plan\/planner$/);
  await expect(page.getByRole('heading', { name: 'Planifier une traversée' })).toBeVisible();
});

test('core flow emits no data 404s or uncaught page errors', async ({ page }) => {
  const failures = [];
  page.on('response', (response) => { if (response.status() === 404 && response.url().includes('/data/')) failures.push(response.url()); });
  page.on('pageerror', (error) => failures.push(error.message));
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'Evidence', exact: true }).first().click();
  await page.getByRole('button', { name: /Watch/ }).first().click();
  await page.getByRole('button', { name: /Verify/ }).first().click();
  await page.waitForTimeout(250);
  expect(failures).toEqual([]);
});
