import { describe, expect, it } from 'vitest';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import synoptic from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/synoptic.json';
import route from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/route.json';
import { frameForCursor } from '../src/stores/playbackStore.js';

describe('causal playback frame selector', () => {
  it('moves from cause to interception and focuses evidence from the same event', () => {
    const event = findings.causal_events[0];
    const intersectionHour = (Date.parse(event.route_intersection.window_start) - Date.parse(findings.departure_utc)) / 3600_000 + 1;
    const before = frameForCursor(findings, synoptic, route, intersectionHour - 2, event.event_id);
    const during = frameForCursor(findings, synoptic, route, intersectionHour, event.event_id);
    expect(before.phase).toBe('cause');
    expect(during.phase).toBe('interception');
    expect(event.consequence.evidence_ids).toContain(during.focusedEvidenceId);
    expect(during.systemPosition).not.toBeNull();
    expect(during.boatPosition).not.toBeNull();
  });
});
