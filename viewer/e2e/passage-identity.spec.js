import { expect, test } from '@playwright/test';
import path from 'node:path';
const DEPARTURE = '2026-07-20T00:00:00Z';
const engineUrl = `/@fs/${path.resolve(import.meta.dirname, '../../engine/dist/index.js')}`;
const state = page => page.evaluate(async () => {
  const app = (await import('/src/stores/appStore.js')).useApp.getState();
  return { findings: app.findings, snapshot: app.snapshot, id: app.snapshotId };
});
async function settleMap(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.leaflet-zoom-anim')).toHaveCount(0);
}
async function configure(page, lon = -3.2) {
  await page.evaluate(async ({ engineUrl, departure, lon }) => {
    const engine = await import(engineUrl);
    const { auditStore } = await import('/test/fixtures/routingTiming.js');
    const fixture = auditStore(engine, undefined);
    const store = (await import('/src/lib/forecastStore.js')).forecastStore();
    for (const method of ['init', 'describe', 'getPointForecasts', 'getEnsembleForecasts', 'getWaveForecasts', 'getHazardForecasts', 'getCurrentGrid']) store[method] = fixture[method].bind(fixture);
    store.refresh = async () => [];
    store.lastCheckedMs = () => Date.now();
    const planner = (await import('/src/stores/plannerStore.js')).usePlanner.getState();
    const { toLocalDateTimeValue } = await import('/src/lib/format.js');
    planner.patch({ mode: 'draw', waypoints: [{ lat: 49.5, lng: -3.5 }, { lat: 49.5, lng: lon }],
      name: 'Scratch identity', departureLocal: toLocalDateTimeValue(departure), speeds: { slow: 4, nominal: 5, fast: 6 } });
  }, { engineUrl, departure: DEPARTURE, lon });
}
async function check(page) {
  await settleMap(page);
  await page.getByRole('button', { name: 'Check this passage', exact: true }).click();
  await expect(page.getByTestId('decision-band')).toBeVisible();
  return state(page);
}

test('separate intent, reroute history, exact retry, reopen, predecessor and deletion', async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date(DEPARTURE));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https:\/\//, route => route.abort());
  await page.route('**/api/event', route => route.fulfill({ status: 204 }));
  await page.route('**/data/runs/latest.json', route => route.fulfill({ json: null }));
  await page.route('**/data/**', async route => {
    if (['POST', 'DELETE'].includes(route.request().method())) await route.fulfill({ status: 403 });
    else await route.continue();
  });
  await page.goto('/#plan');
  await configure(page);
  const first = await check(page);
  expect(first.findings.identity_version).toBe(2);
  await page.getByRole('button', { name: 'Revise this passage', exact: true }).click();
  const retry = await check(page);
  expect(retry.id).toBe(first.id);
  expect(retry.snapshot).toEqual(first.snapshot);
  await page.getByRole('button', { name: 'Revise this passage', exact: true }).click();
  await configure(page, -3.15);
  const second = await check(page);
  expect(second.findings.passage_id).toBe(first.findings.passage_id);
  expect(second.findings.route_revision).not.toBe(first.findings.route_revision);
  expect(second.id).not.toBe(first.id);
  expect(first.snapshot.check_sequence).toBe(1);
  expect(second.snapshot.check_sequence).toBe(2);
  await page.getByRole('button', { name: 'Revise this passage', exact: true }).click();
  await configure(page, -3.1);
  await page.clock.setFixedTime(new Date(Date.parse(DEPARTURE) + 1000));
  const third = await check(page);
  expect(third.snapshot.check_sequence).toBe(3);
  expect(third.findings.passage_id).toBe(first.findings.passage_id);
  await page.getByRole('navigation', { name: 'Passage sections' }).getByRole('button', { name: 'What changed', exact: true }).click();
  await expect(page.getByText('Edited change story · previous → latest')).toBeVisible();
  await page.goto('/#passages');
  await page.getByRole('button', { name: '+ New passage', exact: true }).click();
  await configure(page);
  const separate = await check(page);
  expect(separate.findings.passage_id).not.toBe(first.findings.passage_id);
  expect(separate.findings.route_revision).toBe(first.findings.route_revision);
  await page.evaluate(async firstId => {
    const local = (await import('/src/lib/localSnapshots.js')).localSnapshots;
    const manifest = JSON.parse(await local.read(firstId, 'snapshot.json'));
    for (const id of ['legacy-a', 'legacy-b']) {
      for (const file of Object.values(manifest.artifacts).filter(file => file !== 'decision-inputs.json').concat('snapshot.json')) {
        const doc = JSON.parse(await local.read(firstId, file));
        for (const field of ['identity_version', 'passage_id', 'route_revision', 'decision_hash', 'check_sequence']) delete doc[field];
        if (doc.snapshot_id) doc.snapshot_id = id;
        if (file === 'snapshot.json') delete doc.artifacts.decision_inputs;
        if (file === 'route.json') doc.name = 'Legacy scratch';
        await local.write(id, file, JSON.stringify(doc));
      }
    }
  }, first.id);
  await page.goto('/#passages');
  await page.reload();
  const modernRows = page.locator('article').filter({ hasText: 'Scratch identity' });
  await expect(modernRows).toHaveCount(2);
  const historyRow = modernRows.filter({ has: page.getByRole('button', { name: 'Check 3', exact: true }) });
  // The first two creation timestamps tie; persisted sequence preserves their
  // actual creation order independently of snapshot hashes or insertion order.
  const checks = await page.evaluate(async () => {
    const { groupPassages } = await import('/src/lib/passages.js');
    const app = (await import('/src/stores/appStore.js')).useApp.getState();
    return groupPassages(app.manifest.snapshots).find(g => g.checks.length === 3).checks.map(c => c.snapshot_id);
  });
  for (let i = 0; i < checks.length; i++) {
    await page.evaluate(async () => {
      window.scratchReads = [];
      const local = (await import('/src/lib/localSnapshots.js')).localSnapshots;
      if (!local.scratchRead) local.scratchRead = local.read.bind(local);
      local.read = async (id, file) => {
        if (file === 'findings.json') window.scratchReads.push(id);
        return local.scratchRead(id, file);
      };
    });
    await historyRow.getByRole('button', { name: `Check ${i + 1}`, exact: true }).click();
    await expect(page.getByTestId('decision-band')).toBeVisible();
    expect((await state(page)).id).toBe(checks[i]);
    await page.getByRole('navigation', { name: 'Passage sections' }).getByRole('button', { name: 'What changed', exact: true }).click();
    if (i === 0) await expect(page.getByText('First analysis of this passage')).toBeVisible();
    else await expect(page.getByText('Edited change story · previous → latest')).toBeVisible();
    const reads = await page.evaluate(() => window.scratchReads);
    if (i > 0) expect(reads).toContain(checks[i - 1]);
    for (const future of checks.slice(i + 1)) expect(reads).not.toContain(future);
    await page.goto('/#passages');
  }
  await page.screenshot({ path: path.resolve(import.meta.dirname, `../../output/passage-03/history-${testInfo.project.name}.png`), fullPage: true });
  page.on('dialog', dialog => dialog.accept());
  await historyRow.locator('..').getByRole('button', { name: 'Delete this passage', exact: true }).click();
  await expect(modernRows).toHaveCount(1);
  const local = await page.evaluate(async () => (await import('/src/lib/localSnapshots.js')).localSnapshots.list());
  expect(local.map(s => s.snapshot_id).sort()).toEqual([separate.id, 'legacy-a', 'legacy-b'].sort());
  const legacyRows = page.locator('article').filter({ hasText: 'Legacy scratch' });
  await expect(legacyRows).toHaveCount(2);
  await expect(legacyRows.first()).toContainText('Saved check · separate history');
  await legacyRows.first().getByRole('button', { name: 'Check 1', exact: true }).click();
  const legacyId = (await state(page)).id;
  expect(['legacy-a', 'legacy-b']).toContain(legacyId);
  await expect(page.getByTestId('decision-band')).toBeVisible();
  await page.goto('/#passages');
  await page.locator(`button[title="${legacyId}"]`).locator('..').locator('..').getByRole('button', { name: 'Delete this passage' }).click();
  await expect(legacyRows).toHaveCount(1);
  const survivors = await page.evaluate(async () => (await import('/src/lib/localSnapshots.js')).localSnapshots.list());
  expect(survivors.map(s => s.snapshot_id).sort()).toEqual([separate.id, legacyId === 'legacy-a' ? 'legacy-b' : 'legacy-a'].sort());
  // Simulate an interrupted save in scratch storage, then retry through Check.
  await page.locator(`button[title="${separate.id}"]`).click();
  await expect(page.getByTestId('decision-band')).toBeVisible();
  await page.getByRole('button', { name: 'Revise this passage', exact: true }).click();
  await configure(page);
  const partialBytes = await page.evaluate(async id => {
    const local = (await import('/src/lib/localSnapshots.js')).localSnapshots;
    const route = await local.read(id, 'route.json');
    await local.remove(id);
    await local.write(id, 'route.json', route);
    return route;
  }, separate.id);
  await settleMap(page);
  await page.getByRole('button', { name: 'Check this passage', exact: true }).click();
  await expect(page.getByText(/incomplete, legacy or conflicting.*write-once/)).toBeVisible();
  expect(await page.evaluate(async id => (await import('/src/lib/localSnapshots.js')).localSnapshots.read(id, 'route.json'), separate.id)).toBe(partialBytes);
  expect(errors).toEqual([]);
});
