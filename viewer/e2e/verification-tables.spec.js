import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

for (const language of ['en', 'fr']) {
  for (const [view, columns] of [['verification', [5, 7]], ['case-study', [6]]]) {
    test(`${view} tables remain readable and fully reachable in ${language}`, async ({ page }, testInfo) => {
      await page.route(/^https:\/\/(tile\.openstreetmap\.org|tiles\.openseamap\.org)\//, (route) => route.abort());
      // Explicit emulated calibration rows exercise the normally empty demo record.
      await page.route('**/data/verification/calibration.json', (route) => route.fulfill({ json: { records: [{ variable: 'wave_height_m', lead_band_h: [24, 48], area: 'English Channel', n_pairs: 12, bias: -0.35, spread: 1.25, coverage_classes: { emulated: 12 } }] } }));
      await openAuditedSnapshot(page);
      if (language === 'fr') await page.getByRole('button', { name: 'Français' }).click();
      await page.getByRole('button', { name: language === 'fr' ? /Vérifier/ : /Verify/ }).first().click();

      if (view === 'case-study') await page.getByRole('button', { name: language === 'fr' ? 'Étude de cas' : 'Case study', exact: true }).click();
      const tables = page.locator('main table');
      await expect(tables).toHaveCount(columns.length);
      await expect(tables.last().locator('tbody tr').first()).toBeVisible();
      await page.screenshot({ path: `../output/playwright/review-3.8/${view}-${language}-${testInfo.project.name}.png`, fullPage: true });
      for (let i = 0; i < columns.length; i++) {
        const table = tables.nth(i);
        await expect(table.locator('th')).toHaveCount(columns[i]);
        const cells = await table.locator('th, td').evaluateAll((items) => items.map((cell) => ({
          padding: parseFloat(getComputedStyle(cell).paddingRight),
          clipped: cell.scrollWidth > cell.clientWidth,
        })));
        expect(cells.every((cell) => cell.padding >= 12 && !cell.clipped)).toBe(true);
        const region = table.locator('..');
        await expect(region).toHaveAttribute('role', 'region');
        await expect(region).toHaveAttribute('tabindex', '0');
        await expect(region).toHaveAccessibleName(/.+/);
        expect(await region.evaluate((el) => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
        await region.focus();
        await expect.poll(async () => {
          await page.keyboard.press('ArrowRight');
          return region.evaluate((el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
        }, { intervals: [50], timeout: 10000 }).toBe(true);
        await expect(table.locator('th').last()).toBeInViewport();
        await region.screenshot({ path: `../output/playwright/review-3.8/${view}-${language}-${testInfo.project.name}-table-${i}-right.png` });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (view === 'case-study') {
        await page.emulateMedia({ media: 'print' });
        await page.setViewportSize({ width: 794, height: 1123 });
        expect(await tables.first().evaluate((el) => el.scrollWidth <= el.parentElement.clientWidth)).toBe(true);
        await tables.first().screenshot({ path: `../output/playwright/review-3.8/print-${language}-${testInfo.project.name}.png` });
      }
    });
  }
}
