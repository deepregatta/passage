import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test('Plan and Verify stage checkpoints keep URL-deep-linked subviews', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: /Plan/ }).first().click();
  await expect(page).toHaveURL(/#plan\/planner$/);
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
  await expect(page.getByText(/EXCLUDED FROM SKILL CLAIMS/i)).toBeVisible();
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
