import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test('evidence checkpoint', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'Evidence', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /forecast scenarios exceed/i })).toBeVisible();
  const charts = page.locator('.echarts-for-react svg');
  await expect(charts).toHaveCount(2);
  for (const chart of await charts.all()) {
    await expect(chart).toBeVisible();
    await expect(chart.locator('path').first()).toBeAttached();
  }
  await expect(page.getByText('Drawing forecast…', { exact: true })).toHaveCount(0);
  await expect(page).toHaveScreenshot('evidence.png', { fullPage: true });
});

test('headline, chart, limit, and inspector use one evidence claim', async ({ page }) => {
  await openAuditedSnapshot(page);
  await page.getByRole('button', { name: 'Evidence', exact: true }).first().click();
  await page.getByRole('button', { name: /L4 · gust.*23\/51/i }).click();
  await expect(page.getByText(/YOUR LIMIT/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /23 of 51 forecast scenarios/i })).toBeVisible();
});

for (const language of ['en', 'fr']) {
  test(`evidence charts fit the viewport in ${language}`, async ({ page }, testInfo) => {
    await openAuditedSnapshot(page);
    await page.getByRole('button', { name: 'Evidence', exact: true }).first().click();
    if (language === 'fr') await page.getByRole('button', { name: 'Français' }).click();
    const charts = page.locator('.echarts-for-react svg');
    await expect(charts).toHaveCount(2);
    for (const chart of await charts.all()) {
      await expect(chart.locator('path').first()).toBeAttached();
    }

    const assertFits = async () => {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);
      // The shell hides horizontal overflow; also reject content clipped inside it.
      await expect.poll(() => page.locator('#main-content').evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
      for (const chart of await charts.all()) {
        await expect.poll(() => chart.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          return bounds.width > 200 && bounds.left >= 0 && bounds.right <= innerWidth;
        })).toBe(true);
      }
      await expect.poll(() => charts.last().evaluate((svg) => {
        const times = [...svg.querySelectorAll('text')]
          .filter((el) => /^\d\d:\d\d$/.test(el.textContent))
          .map((el) => el.getBoundingClientRect()).filter((rect) => rect.width > 0)
          .sort((a, b) => a.left - b.left);
        return times.length >= 2 && times.every((rect, i) => !i || rect.left >= times[i - 1].right);
      })).toBe(true);
      const units = charts.last().locator('text').filter({ hasText: language === 'fr' ? 'vent moyen à 10 m' : '10 m sustained' });
      await expect.poll(() => units.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        const chart = el.closest('svg').getBoundingClientRect();
        return bounds.left >= chart.left && bounds.right <= chart.right;
      })).toBe(true);
    };
    await assertFits();
    await page.screenshot({ path: `../output/playwright/review-3.9/evidence-${language}-${testInfo.project.name}.png`, fullPage: true, scale: 'css' });

    // Existing charts must shrink when the layout changes, not just on first mount.
    await page.setViewportSize({ width: 390, height: 844 });
    await assertFits();
    const claims = page.locator('aside').filter({ has: page.locator('button') }).getByRole('button');
    await claims.last().click();
    await assertFits();
    await page.locator('summary').click();
    await expect(page.locator('main table')).toBeVisible();
    await assertFits();
    await page.screenshot({ path: `../output/playwright/review-3.9/evidence-${language}-${testInfo.project.name}-390-table.png`, fullPage: true, scale: 'css' });
  });
}
