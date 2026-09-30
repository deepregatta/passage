import { expect, test } from '@playwright/test';
import { openAuditedSnapshot, openSection } from './helpers.js';

test('changes checkpoint', async ({ page }) => {
  await openAuditedSnapshot(page);
  await openSection(page, 'What changed');
  await expect(page.getByText(/Edited change story/i)).toBeVisible();
  await expect(page.locator('[data-section="changes"]')).toHaveScreenshot('changes.png');
});

test('warning ledger entries never contain a null leg', async ({ page }) => {
  await openAuditedSnapshot(page);
  await openSection(page, 'What changed');
  await expect(page.getByText(/on null/i)).toHaveCount(0);
});
