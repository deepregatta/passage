import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeRoute, routeRevision } from '@deepweather/engine';
import { usePlanner } from '../src/stores/plannerStore.js';
import { DEPARTURE, routingInputs } from './fixtures/routingTiming.js';

beforeEach(() => { localStorage.clear(); usePlanner.getState().reset(); });
it('persists intent through edits and reload, while reset creates a separate equal-content intent', async () => {
  const planner = usePlanner.getState();
  const id = planner.passageId;
  planner.patch({ name: 'Same', waypoints: [{ lat: 50, lng: -1 }], departureLocal: '2099-07-20T12:00' });
  expect(usePlanner.getState().passageId).toBe(id);
  await usePlanner.persist.rehydrate();
  expect(usePlanner.getState().passageId).toBe(id);
  usePlanner.getState().reset();
  expect(usePlanner.getState().passageId).not.toBe(id);
});
it.each([0, 1])('migrates draft v%s without linking any legacy history or losing geometry', async version => {
  localStorage.setItem('deepweather.planner-draft', JSON.stringify({ version, state: {
    name: 'Legacy', waypoints: [{ lat: 50, lng: -1 }], departureLocal: '2099-07-20T12:00',
  } }));
  await usePlanner.persist.rehydrate();
  const state = usePlanner.getState();
  expect(state.passageId).toBeTruthy();
  expect(state.waypoints).toEqual([{ lat: 50, lng: -1 }]);
  expect(state.name).toBe('Legacy');
  const saved = JSON.parse(localStorage.getItem('deepweather.planner-draft'));
  expect(saved.version).toBe(3);
  expect(saved.state.nameAuto).toBe(false);
  expect(saved.state.passageId).toBe(state.passageId);
});

it('starts a new draft without a boat, and a saved draft keeps the boat it holds', async () => {
  expect(usePlanner.getState()).toMatchObject({ polarId: null, polarLabel: null });
  localStorage.setItem('deepweather.planner-draft', JSON.stringify({ version: 2, state: {
    passageId: 'saved', polarId: 'saved-boat', polarLabel: 'Saved boat', departureLocal: '2099-07-20T12:00',
  } }));
  await usePlanner.persist.rehydrate();
  expect(usePlanner.getState()).toMatchObject({ polarId: 'saved-boat', polarLabel: 'Saved boat' });
  usePlanner.getState().reset();
  expect(usePlanner.getState().polarId).toBeNull();
});

afterEach(() => vi.useRealTimers());

it('gives equal route revisions for equal percentages, different ones for different percentages, and keeps the passage', () => {
  // Route provenance carries computed_at, so the clock is fixed: the revision then depends on the inputs alone.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
  const inputs = routingInputs();
  const passageId = usePlanner.getState().passageId;
  const revisionAt = (percent, id = passageId) => {
    const { route } = computeRoute({ ...inputs, departureUtc: DEPARTURE, polarScaling: percent / 100 });
    return { route: { ...route, passage_id: id, name: 'Same' }, revision: routeRevision({ ...route, passage_id: id, name: 'Same' }, DEPARTURE) };
  };
  const a = revisionAt(90);
  const b = revisionAt(90);
  const full = revisionAt(100);
  expect(b.revision).toBe(a.revision);
  expect(full.revision).not.toBe(a.revision);
  expect(a.route.provenance.routing_request.polar_scaling).toBe(0.9);
  expect(full.route.provenance.routing_request.polar_scaling).toBe(1);
  // The percentage is a setting of the same intent: editing it never starts another passage.
  usePlanner.getState().patch({ polarPercent: 90 });
  usePlanner.getState().patch({ polarPercent: 100 });
  expect(usePlanner.getState().passageId).toBe(passageId);
  expect(a.route.passage_id).toBe(full.route.passage_id);
  // A different passage_id never changes the revision.
  expect(revisionAt(90, 'another-intent').revision).toBe(a.revision);
});
