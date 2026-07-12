import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import manifest from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_f0703423/snapshot.json';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_f0703423/findings.json';
import briefing from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_f0703423/briefing.json';
import plume from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_f0703423/plume.json';
import route from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_f0703423/route.json';
import warnings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_f0703423/warnings.json';
import synoptic from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_f0703423/synoptic.json';
import previousManifest from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_4a1c16e9/snapshot.json';
import previousFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_4a1c16e9/findings.json';

const snapshotId = manifest.snapshot_id;
const fixtureRoutes = new Map([
  ['/data/snapshots/manifest.json', {
    generated_at: '2026-07-12T00:00:00Z',
    snapshots: [
      { ...manifest, verdict_state: findings.verdict.state },
      { ...previousManifest, verdict_state: previousFindings.verdict.state },
    ],
  }],
  [`/data/snapshots/${snapshotId}/snapshot.json`, manifest],
  [`/data/snapshots/${snapshotId}/findings.json`, findings],
  [`/data/snapshots/${snapshotId}/briefing.json`, briefing],
  [`/data/snapshots/${snapshotId}/plume.json`, plume],
  [`/data/snapshots/${snapshotId}/route.json`, route],
  [`/data/snapshots/${snapshotId}/warnings.json`, warnings],
  [`/data/snapshots/${snapshotId}/synoptic.json`, synoptic],
  [`/data/snapshots/${previousManifest.snapshot_id}/findings.json`, previousFindings],
  ['/data/verification/cases/index.json', { cases: [] }],
]);

const response = (body, status = 200) =>
  new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input) => {
    const url = new URL(String(input), 'http://deepweather.test');
    const body = fixtureRoutes.get(url.pathname);
    return body === undefined ? response(null, 404) : response(body);
  });
});

afterEach(() => cleanup());

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock;

HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
  measureText: () => ({ width: 0 }),
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  scale: vi.fn(),
  translate: vi.fn(),
  rotate: vi.fn(),
  beginPath: vi.fn(),
  closePath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
  arc: vi.fn(),
  rect: vi.fn(),
  clip: vi.fn(),
  setTransform: vi.fn(),
  resetTransform: vi.fn(),
  createLinearGradient: () => ({ addColorStop: vi.fn() }),
}));
