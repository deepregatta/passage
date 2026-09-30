import { expect, test } from '@playwright/test';
import { openAuditedSnapshot, openSection } from './helpers.js';

for (const language of ['en', 'fr']) {
  for (const [view, columns] of [['track-record', 7], ['outcome', 6]]) {
    test(`${view} table remains readable and fully reachable in ${language}`, async ({ page }, testInfo) => {
      await page.route(/^https:\/\/(tile\.openstreetmap\.org|tiles\.openseamap\.org)\//, (route) => route.abort());
      // Explicit emulated calibration rows exercise the normally empty demo record.
      await page.route('**/data/verification/calibration.json', (route) => route.fulfill({ json: { records: [{ variable: 'wave_height_m', lead_band_h: [24, 48], area: 'English Channel', n_pairs: 12, bias: -0.35, spread: 1.25, coverage_classes: { emulated: 12 } }] } }));
      await openAuditedSnapshot(page);
      const french = language === 'fr';
      if (french) await page.getByRole('button', { name: 'Français' }).click();
      let scope;
      if (view === 'track-record') {
        await page.getByRole('button', { name: french ? 'À propos des données' : 'About the data' }).click();
        scope = page.locator('main');
      } else {
        await openSection(page, french ? 'Ce qui s’est produit' : 'How it turned out');
        scope = page.locator('[data-section="outcome"]');
      }
      const table = scope.locator('table');
      await expect(table).toHaveCount(1);
      await expect(table.locator('tbody tr').first()).toBeVisible();
      await page.screenshot({ path: `../output/playwright/passage-ui/${view}-${language}-${testInfo.project.name}.png`, fullPage: true });
      await expect(table.locator('th')).toHaveCount(columns);
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
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (view === 'outcome') {
        // Print / save PDF prints the outcome report alone, with every column
        await page.evaluate(() => { document.body.dataset.print = 'outcome'; });
        await page.emulateMedia({ media: 'print' });
        await page.setViewportSize({ width: 794, height: 1123 });
        await expect(page.locator('[data-section="story"]')).toBeHidden();
        await expect(page.getByTestId('decision-band')).toBeHidden();
        expect(await table.evaluate((el) => el.scrollWidth <= el.parentElement.clientWidth)).toBe(true);
        await table.screenshot({ path: `../output/playwright/passage-ui/print-${language}-${testInfo.project.name}.png` });
      }
    });
  }
}
