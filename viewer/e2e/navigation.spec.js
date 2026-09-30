import { expect, test } from '@playwright/test';
import { openAuditedSnapshot, openSection } from './helpers.js';

test.use({ timezoneId: 'Europe/Paris' });

test('campaign UTM parameters survive initial hash routing and client navigation', async ({ page }) => {
  const query = new URLSearchParams({
    utm_source: 'instagram',
    utm_medium: 'social',
    utm_campaign: 'deepregatta-evidence-loop-2026',
    utm_content: 'passage-demo-warning-authority-en-2026-08',
  });

  await page.goto(`/?${query}`);
  await expect(page).toHaveURL(`/?${query}#plan`);

  await page.getByRole('button', { name: 'My passages' }).first().click();
  await expect(page).toHaveURL(`/?${query}#passages`);
});

test('Plan and About the data checkpoints keep URL deep links', async ({ page }) => {
  // The planner defaults to the current local time. Freeze both the instant
  // and browser timezone so its departure fields stay reproducible.
  await page.clock.setFixedTime(new Date('2026-07-20T06:00:00Z'));
  // Keep map controls/attribution in the checkpoint without live tile drift.
  await page.route(/^https:\/\/(tile\.openstreetmap\.org|tiles\.openseamap\.org)\//, (route) => route.abort());
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).first().click();
  await expect(page).toHaveURL(/#plan$/);
  await expect(page.getByRole('heading', { name: 'Plan a passage' })).toBeVisible();
  await page.locator('.leaflet-container').waitFor();
  await page.waitForTimeout(250);
  await expect(page).toHaveScreenshot('plan.png', { fullPage: true });
  await page.getByRole('button', { name: 'About the data' }).click();
  await expect(page).toHaveURL(/#about$/);
  await expect(page.getByText(/Skill claims use 11 real ERA5 cases/i)).toBeVisible();
  await expect(page).toHaveScreenshot('about.png', { fullPage: true });
});

test('example deep link survives reload and returns to passage planning', async ({ page }) => {
  await page.goto('/#example');
  const example = page.getByRole('region', { name: 'Example briefing' });
  await expect(example.getByRole('heading', { name: 'Example briefing', exact: true })).toBeVisible();
  await expect(example.getByText('Synthetic / emulated example. Not a live forecast or a safety decision.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inspect example bulletin' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/#example$/);
  await expect(page.getByRole('button', { name: 'Inspect example bulletin' })).toBeVisible();
  await example.getByRole('link', { name: 'Plan my own passage' }).click();
  await expect(page).toHaveURL(/#plan$/);
  await expect(page.getByRole('heading', { name: 'Plan a passage' })).toBeVisible();
});

test('visible navigation targets are at least 44 pixels tall', async ({ page }) => {
  await openAuditedSnapshot(page);
  const sizes = await page.getByRole('navigation', { name: 'Main navigation' }).locator('button:visible').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  expect(sizes.length).toBeGreaterThan(0);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44);
});

test('the passage page publishes the frozen demo outcome with emulated exclusion', async ({ page }) => {
  await openAuditedSnapshot(page);
  await openSection(page, 'How it turned out');
  await expect(page.getByRole('heading', { name: /What the forecast said, and what happened/i })).toBeInViewport();
  await expect(page.getByText(/NOT A SKILL CLAIM/i)).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Passage sections' }).getByRole('button', { name: 'How it turned out' })).toHaveAttribute('aria-current', 'location');
});

test('retired stage links open the same passage section', async ({ page }) => {
  await page.goto(`/#watch/changes?snapshot=20260720T060000Z_44d2cd5f_64ea971e`);
  await expect(page.getByTestId('decision-band')).toBeVisible();
  await expect(page).toHaveURL(/#passage\?snapshot=20260720T060000Z_44d2cd5f_64ea971e$/);
  await expect(page.getByText(/Edited change story/i)).toBeInViewport();
});

test('track record and outcome render complete French copy, including dynamic counts', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'Français' }).click();
  await openSection(page, 'Ce qui s’est produit');
  await expect(page.getByRole('heading', { name: 'Ce que prévoyait la météo et ce qui s’est produit' })).toBeVisible();
  await expect(page.getByText('DÉMONSTRATION SIMULÉE · AUCUN RÉSULTAT RÉEL')).toBeVisible();
  await page.getByRole('button', { name: 'À propos des données' }).click();
  await expect(page.getByText('Les mesures de fiabilité reposent sur 11 cas ERA5 réels.')).toBeVisible();
  await expect(page.getByText('10 réussites · 1 échec · 0 en attente')).toBeVisible();
  await expect(page.getByText('1 cas simulé affiché uniquement pour la démonstration.')).toBeVisible();
  await expect(page.getByText(/How the forecasts|Skill claims|emulated cases|Not verified yet|Reanalysis-referenced|Track record/)).toHaveCount(0);
});

test('the /fr/ URL renders French and the switcher navigates between language URLs', async ({ page }) => {
  await page.goto('/fr/');
  await expect(page).toHaveTitle(/Planification météo explicable/);
  await expect(page.getByRole('heading', { name: 'Planifier une traversée' })).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:5174\/#plan$/);
  await expect(page.getByRole('heading', { name: 'Plan a passage' })).toBeVisible();
  await page.getByRole('button', { name: 'Français', exact: true }).click();
  await expect(page).toHaveURL(/\/fr\/#plan$/);
  await expect(page.getByRole('heading', { name: 'Planifier une traversée' })).toBeVisible();
});

test('core flow emits no data 404s or uncaught page errors', async ({ page }) => {
  const failures = [];
  page.on('response', (response) => { if (response.status() === 404 && response.url().includes('/data/')) failures.push(response.url()); });
  page.on('pageerror', (error) => failures.push(error.message));
  await openAuditedSnapshot(page);
  await openSection(page, 'Evidence');
  await openSection(page, 'What changed');
  await openSection(page, 'How it turned out');
  await page.getByRole('button', { name: 'About the data' }).click();
  await expect(page.getByText(/Skill claims use/)).toBeVisible();
  await page.waitForTimeout(250);
  expect(failures).toEqual([]);
});
