import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test('changes checkpoint', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: /Watch/ }).first().click();
  await expect(page.getByText(/Edited change story/i)).toBeVisible();
  await expect(page).toHaveScreenshot('changes.png', { fullPage: true });
});

test('warning ledger entries never contain a null leg', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: /Watch/ }).first().click();
  await expect(page.getByText(/on null/i)).toHaveCount(0);
});
