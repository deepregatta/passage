import { describe, expect, it } from 'vitest';
import { groupPassages, routeName } from '../src/lib/passages.js';
import { pageHash, parseRoute } from '../src/lib/routes.js';

const check = (snapshot_id, created_at, extra = {}) => ({
  snapshot_id, created_at, route_id: 'cherbourg-plymouth-v1', departure_utc: '2026-07-20T06:00:00Z', ...extra,
});

describe('passages', () => {
  it('groups checks of one route and departure, oldest first, and puts the example last', () => {
    const passages = groupPassages([
      check('example-latest', '2026-07-19T18:00:00Z', { demo: true }),
      check('example-previous', '2026-07-19T18:00:00Z'),
      check('mine-1', '2026-09-01T08:00:00Z', { route_id: 'my-passage-3wp' }),
      check('mine-2', '2026-09-02T08:00:00Z', { route_id: 'my-passage-3wp' }),
      check('other-departure', '2026-09-03T08:00:00Z', { route_id: 'my-passage-3wp', departure_utc: '2026-09-10T06:00:00Z' }),
    ]);
    expect(passages.map((p) => p.checks.map((c) => c.snapshot_id))).toEqual([
      ['other-departure'],
      ['mine-1', 'mine-2'],
      // a created_at tie goes to the served example as the latest of its demo pair
      ['example-previous', 'example-latest'],
    ]);
    expect(passages[1]).toMatchObject({ latest: { snapshot_id: 'mine-2' }, previous: { snapshot_id: 'mine-1' }, demo: false });
    expect(passages[2]).toMatchObject({ latest: { snapshot_id: 'example-latest' }, demo: true });
    expect(groupPassages(undefined)).toEqual([]);
  });

  it('names a route from its identifier', () => {
    expect(routeName('cherbourg-plymouth-v1')).toBe('Cherbourg plymouth');
    expect(routeName('my-passage-5wp')).toBe('My passage');
  });
});

describe('routes', () => {
  it.each([
    ['#plan', { page: 'planner', section: null, limits: false }],
    ['#passages', { page: 'passages' }],
    ['#passage/evidence?snapshot=abc', { page: 'briefing', section: 'evidence', snapshotId: 'abc' }],
    ['#about', { page: 'about' }],
    // retired stage links keep opening the same content
    ['#plan/planner', { page: 'planner' }],
    ['#plan/limits', { page: 'planner', limits: true }],
    ['#brief/briefings', { page: 'passages' }],
    ['#brief/story?snapshot=abc', { page: 'briefing', section: null, snapshotId: 'abc' }],
    ['#brief/evidence', { page: 'briefing', section: 'evidence' }],
    ['#watch/changes', { page: 'briefing', section: 'changes' }],
    ['#verify/case-study', { page: 'briefing', section: 'outcome' }],
    ['#verify/record', { page: 'about' }],
    ['#nowhere', { page: undefined, snapshotId: null }],
  ])('parses %s', (hash, expected) => {
    expect(parseRoute(hash)).toMatchObject(expected);
  });

  it('writes canonical addresses and only valid served identities', () => {
    expect(pageHash('planner')).toBe('plan');
    expect(pageHash('passages')).toBe('passages');
    expect(pageHash('briefing', 'abc_1')).toBe('passage?snapshot=abc_1');
    expect(pageHash('briefing', '../private')).toBe('passage');
    expect(pageHash('unknown')).toBe('plan');
  });
});
