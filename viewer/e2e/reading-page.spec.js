import { expect, test } from '@playwright/test';
import { openAuditedSnapshot } from './helpers.js';

test.use({ timezoneId: 'Europe/Paris' });

/** Open every disclosure on the page so the checks below see its whole text. */
async function expandEverything(page) {
  const reading = page.locator('.min-text-12');
  const closed = reading.locator('button[aria-expanded="false"]');
  for (let guard = 0; guard < 8 && await closed.count(); guard += 1) await closed.first().click();
  await page.evaluate(() => document.querySelectorAll('.min-text-12 details').forEach((details) => { details.open = true; }));
}

for (const language of ['en', 'fr']) {
  test(`reading page: no text under 12 px, one h1 with no skipped levels, one scroll (${language})`, async ({ page }) => {
    await openAuditedSnapshot(page);
    if (language === 'fr') await page.getByRole('button', { name: 'Français' }).click();
    await expandEverything(page);
    // the evidence inspector is part of the page too
    await page.locator('[data-testid="decision-band"] .evidence-link').first().click();
    await page.getByRole('dialog').waitFor();
    const report = await page.evaluate(() => {
      const small = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const element = walker.currentNode.parentElement;
        if (!walker.currentNode.textContent.trim() || !element || element.closest('script, style, .sr-only')) continue;
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (!box.width || !box.height || style.visibility === 'hidden') continue;
        if (parseFloat(style.fontSize) < 12) small.push(`${parseFloat(style.fontSize)} px: ${walker.currentNode.textContent.trim().slice(0, 40)}`);
      }
      for (const text of document.querySelectorAll('svg text')) {
        const matrix = text.getScreenCTM();
        const size = matrix ? parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.a, matrix.b) : 12;
        if (text.textContent.trim() && size < 12) small.push(`${size.toFixed(1)} px (svg): ${text.textContent.trim().slice(0, 40)}`);
      }
      const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .filter((heading) => heading.getBoundingClientRect().height > 0)
        .map((heading) => Number(heading.tagName[1]));
      const skipped = levels.filter((level, index) => index > 0 && level > levels[index - 1] + 1);
      const boxes = [...document.querySelectorAll('body *')].filter((element) => {
        const overflow = getComputedStyle(element).overflowY;
        return (overflow === 'auto' || overflow === 'scroll') && element.scrollHeight > element.clientHeight + 1
          && !element.closest('[role="dialog"]');
      }).map((element) => `${element.tagName}.${String(element.className).slice(0, 40)}`);
      return { small, h1: levels.filter((level) => level === 1).length, skipped, firstLevel: levels[0], boxes };
    });
    expect(report.small).toEqual([]);
    expect(report.h1).toBe(1);
    expect(report.firstLevel).toBe(1);
    expect(report.skipped).toEqual([]);
    expect(report.boxes).toEqual([]);
  });
}
