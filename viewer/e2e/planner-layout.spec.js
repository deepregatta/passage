import { expect, test } from '@playwright/test';

test.use({ timezoneId: 'Europe/Paris' });

const DRAFT_KEY = 'deepweather.planner-draft';

/** A drawn two-point route, so the form's Check button is enabled. */
const seedDraft = (state) => (page) => page.addInitScript(([key, value]) => {
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 3, state: value }));
}, [DRAFT_KEY, state]);

const drawnRoute = {
  passageId: 'e2e-layout', mode: 'draw', name: 'My passage', nameAuto: true, departureLocal: '2026-07-21T08:00',
  waypoints: [{ lat: 49.65, lng: -1.62 }, { lat: 50.36, lng: -4.14 }], endpoints: [],
};

const rect = (locator) => locator.evaluate((element) => {
  const { top, bottom, left, right } = element.getBoundingClientRect();
  return { top, bottom, left, right };
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-07-20T06:00:00Z'));
  await page.route(/^https:\/\/(tile\.openstreetmap\.org|tiles\.openseamap\.org)\//, (route) => route.abort());
});

// The action bar belongs to the single-column layouts: phones and the 768 to 1023 px tablets.
for (const [width, bar] of [[375, true], [768, true], [800, true], [1000, true], [1023, true], [1024, false], [1280, false]]) {
  test(`the action bar is ${bar ? 'shown' : 'hidden'} at ${width} px and never hides a focused control`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await seedDraft(drawnRoute)(page);
    await page.goto('/#plan');
    await page.getByRole('heading', { name: 'Plan a passage' }).waitFor();
    const actionBar = page.getByTestId('planner-action-bar');
    if (!bar) {
      await expect(actionBar).toBeHidden();
      return;
    }
    await expect(actionBar).toBeVisible();
    const form = page.getByRole('region', { name: 'Plan a passage' });
    const controls = form.locator('input:enabled:visible, button:enabled:visible');
    const count = await controls.count();
    expect(count).toBeGreaterThan(8);
    for (let i = 0; i < count; i += 1) {
      const control = controls.nth(i);
      await control.focus();
      const label = await control.evaluate((element) => element.getAttribute('aria-label') || element.textContent?.trim() || element.name || element.type);
      const box = await rect(control);
      const barTop = (await rect(actionBar)).top;
      expect(box.bottom, `${label} is scrolled into view`).toBeLessThanOrEqual(700);
      expect(box.bottom - barTop, `${label} is hidden behind the action bar`).toBeLessThanOrEqual(0);
    }
    // The last control of the form is among those checked.
    await expect(form.getByRole('button', { name: 'Check this passage' })).toBeEnabled();
  });
}

test('the knots unit stays lower case in the speed label, in English and in French', async ({ page }) => {
  await page.goto('/#plan');
  await page.getByRole('tab', { name: 'Draw my route' }).click();
  const label = page.locator('.eyebrow', { hasText: /^Speed/ });
  await expect(label).toContainText('(kt)');
  await page.getByRole('button', { name: 'Français' }).click();
  await expect(page.locator('.eyebrow', { hasText: /^Vitesse/ })).toContainText('(nd)');
});

// Start (north) and Finish (south) a few pixels apart: their 44 px boxes overlap almost entirely,
// and Finish is drawn on top. Whichever the pointer is nearer to is the one it picks.
const closeEndpoints = {
  passageId: 'e2e-markers', mode: 'compute', name: 'My passage', nameAuto: true, departureLocal: '2026-07-21T08:00',
  endpoints: [{ lat: 50.01, lng: -2.0 }, { lat: 50.0, lng: -1.98 }], waypoints: [],
};

test('close Start and Finish markers: the nearer one takes the pointer, and each keeps its 44 px box once apart', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedDraft(closeEndpoints)(page);
  await page.goto('/#plan');
  const markers = page.locator('.passage-marker');
  await expect(markers).toHaveCount(2);
  const pick = (t) => page.evaluate((fraction) => {
    const centre = (label) => {
      const box = document.querySelector(`.passage-marker[aria-label="${label}"]`).getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };
    const start = centre('Start');
    const finish = centre('Finish');
    const x = start.x + (finish.x - start.x) * fraction;
    const y = start.y + (finish.y - start.y) * fraction;
    return {
      gap: Math.hypot(finish.x - start.x, finish.y - start.y),
      label: document.elementFromPoint(x, y)?.closest('.passage-marker')?.getAttribute('aria-label') ?? null,
    };
  }, t);
  // The map fits the two points first; wait for it to settle.
  await expect.poll(async () => (await pick(0.25)).gap).toBeLessThan(30);
  await expect.poll(async () => (await pick(0.25)).label).toBe('Start');
  expect((await pick(0.75)).label).toBe('Finish');
  expect((await pick(-0.4)).label).toBe('Start');
  expect((await pick(1.4)).label).toBe('Finish');

  // Zoomed in until the boxes no longer overlap, nothing is cut away.
  const zoomIn = page.getByRole('button', { name: 'Zoom in' });
  let gap = (await pick(0)).gap;
  for (let zoom = 0; zoom < 3; zoom += 1) {
    await zoomIn.click();
    const before = gap;
    await expect.poll(async () => (gap = (await pick(0)).gap)).toBeGreaterThan(before * 1.9);
  }
  expect(gap).toBeGreaterThan(44);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('[data-marker-hit]')].map((hit) => getComputedStyle(hit).clipPath)))
    .toEqual(['none', 'none']);
});
