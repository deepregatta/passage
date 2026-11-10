import { describe, expect, it } from 'vitest';
import { legLabel, legPlace } from '../src/pages/briefing/routeLabels.jsx';

const findings = {
  legs: [
    { leg_id: 'L5', name: 'Mid-Channel → Plymouth approach (E of Eddystone)' },
    { leg_id: 'L6', name: 'Plymouth approach (E of Eddystone) → Plymouth breakwater, western entrance' },
    { leg_id: 'custom', name: 'wp1 → wp2' },
  ],
};

describe('legLabel', () => {
  it('names the place first and the leg number in parentheses', () => {
    expect(legLabel(findings, 'L6')).toBe('near Plymouth breakwater (leg 6)');
    expect(legLabel(findings, 'L6', { bare: true })).toBe('Plymouth breakwater (leg 6)');
    expect(legPlace(findings, 'L6')).toBe('near Plymouth breakwater');
  });

  it('never shows the raw L-id and degrades for unknown legs', () => {
    expect(legLabel(findings, 'L9')).toBe('leg 9');
    expect(legLabel(findings, 'custom')).toBe('near waypoint 2');
    expect(legLabel(findings, 'L5')).not.toMatch(/\bL5\b/);
  });
});

import { ruleLabel } from '../src/lib/ruleLabels.js';

describe('ruleLabel', () => {
  it('shows a friendly label instead of the claim code', () => {
    expect(ruleLabel('W-SUST-03')).toBe('wind scenarios over your limit');
    expect(ruleLabel('W-GUST-01')).toBe('gusts');
    expect(ruleLabel('W-ODD-09')).toBe('conditions');
  });
});
