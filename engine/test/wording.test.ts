import { expect, it } from 'vitest';
import { countExceedance, fraction, phraseExceedance } from '../src/exceedance.js';
import { hazardNoun, limitRelation, plainValueVsLimit, verdictLabel } from '../src/plainLanguage.js';

it.each([
  ['W-GUST-01', 'gusts'], ['W-SUST-01', 'winds'], ['S-WAVE-01', 'seas'],
  ['T-WAC-01', 'wind against the tide'], ['C-CAPE-01', 'squall risk'],
  ['V-VIS-01', 'visibility'], [null, 'conditions'], ['unknown', 'conditions'],
])('names hazard %s', (rule, noun) => expect(hazardNoun(rule)).toBe(noun));

it.each([[14.9, 'under'], [15, 'close to'], [20, 'close to'], [20.1, 'over']])(
  'describes the ceiling boundary at %s', (value, relation) => expect(limitRelation(Number(value), 20)).toBe(relation),
);
it('uses a minimum relation for visibility and rounds the plain register', () => {
  expect(plainValueVsLimit('V-VIS-01', 1.4, 2, 'nm')).toBe('visibility down to 1 nm, below your 2 nm minimum');
  expect(plainValueVsLimit('W-GUST-01', 29.6, 28, 'kt')).toBe('gusts up to 30 kt, over your 28 kt limit');
});
it.each([
  ['within', 'within your limits'], ['approaching', 'close to your limits'],
  ['exceeds', 'beyond your limits'], ['insufficient', 'too uncertain to assess'],
  ['warning_active', 'official warning active'], ['future_state', 'future state'],
])('labels verdict %s', (state, label) => expect(verdictLabel(state)).toBe(label));
it('counts only finite available members and uses strict exceedance', () => {
  expect(countExceedance([[20], [21], [19], [null], [], [NaN], [Infinity]], 0, 20)).toEqual({ exceed: 1, total: 3 });
  expect(countExceedance([[null], []], 0, 20)).toBeNull();
  expect(countExceedance([[21]], 1, 20)).toBeNull();
  expect(fraction({ exceed: 1, total: 4 })).toBe(0.25);
});
it.each([
  [0, 'none of the 4 forecast scenarios exceed your limit'],
  [2, '2 of 4 forecast scenarios exceed your limit'],
  [4, 'all 4 forecast scenarios exceed your limit'],
])('phrases %s exceeding members as a raw count', (exceed, expected) => {
  expect(phraseExceedance({ exceed: Number(exceed), total: 4 }, 'your limit')).toBe(expected);
});
