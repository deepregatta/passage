import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test('changes checkpoint', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'What changed' }).click();
  await expect(page.getByRole('heading', { name: 'What changed' })).toBeVisible();
  await expect(page).toHaveScreenshot('changes.png', { fullPage: true });
});

test.fixme('warning ledger entries never contain a null leg', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'What changed' }).click();
  await expect(page.getByText(/on null/i)).toHaveCount(0);
});
