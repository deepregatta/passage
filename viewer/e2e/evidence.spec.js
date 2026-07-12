import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test('evidence checkpoint', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'Evidence', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /forecast scenarios exceed/i })).toBeVisible();
  await expect(page).toHaveScreenshot('evidence.png', { fullPage: true });
});

test('headline, chart, limit, and inspector use one evidence claim', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'Evidence', exact: true }).first().click();
  await page.getByRole('button', { name: /L4 · gust.*23\/51/i }).click();
  await expect(page.getByText(/YOUR LIMIT/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /23 of 51 forecast scenarios/i })).toBeVisible();
});
