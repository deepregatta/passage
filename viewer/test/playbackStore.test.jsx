import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePlayback } from '../src/stores/playbackStore.js';
import TimeRuler from '../src/components/TimeRuler.jsx';

let frames, nextId;
beforeEach(() => {
  usePlayback.setState(usePlayback.getInitialState(), true);
  frames = new Map();
  nextId = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id) => frames.delete(id)));
});
afterEach(() => {
  usePlayback.getState().pause();
  vi.unstubAllGlobals();
});

it('stops animation frames on TimeRuler unmount', () => {
  const { unmount } = render(<TimeRuler findings={{ departure_utc: '2026-07-20T06:00:00Z' }} maxHours={36} />);
  fireEvent.click(screen.getByRole('button', { name: 'Play passage playback' }));
  expect(usePlayback.getState().playing).toBe(true);
  expect(frames.size).toBe(1);
  unmount();
  expect(usePlayback.getState().playing).toBe(false);
  expect(frames.size).toBe(0);
});

it('resets all snapshot-specific playback state and cancels the scheduled frame', () => {
  const playback = usePlayback.getState();
  playback.setCursor(12);
  playback.focusEvent('event-A');
  playback.setFocusedEvidence('evidence-A');
  playback.setDepartureVariant('later');
  playback.play();
  usePlayback.getState().reset();
  expect(usePlayback.getState()).toMatchObject({ cursorHours: 0, playing: false, focusedEventId: null, focusedEvidenceId: null, departureVariant: 'nominal' });
  expect(frames.size).toBe(0);
});

it('keeps only one frame loop for repeated play calls and can restart after pause', () => {
  usePlayback.getState().play();
  usePlayback.getState().play();
  expect(frames.size).toBe(1);
  usePlayback.getState().pause();
  expect(frames.size).toBe(0);
  usePlayback.getState().play();
  expect(frames.size).toBe(1);
  const [[id, tick]] = frames;
  frames.delete(id);
  act(() => tick(performance.now() + 1000));
  expect(usePlayback.getState().cursorHours).toBeGreaterThan(1);
  expect(frames.size).toBe(1);
});

it('respects reduced motion', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true });
  usePlayback.getState().play();
  expect(usePlayback.getState().playing).toBe(false);
  expect(frames.size).toBe(0);
});
