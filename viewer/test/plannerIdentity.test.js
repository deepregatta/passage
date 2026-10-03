import { beforeEach, expect, it } from 'vitest';
import { usePlanner } from '../src/stores/plannerStore.js';

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
  expect(saved.version).toBe(2);
  expect(saved.state.passageId).toBe(state.passageId);
});
