import { describe, expect, it } from 'vitest';
import { polarFromRelease, type DeepPolarsEntry } from '../src/routing/deepPolars.js';
import { boatSpeedKt } from '../src/routing/polar.js';

// Invented tables in the deepregatta-polars/1 shape: speeds_kt[twa][tws].
function entry(overrides: Partial<DeepPolarsEntry> & { table: DeepPolarsEntry['table'] }): DeepPolarsEntry {
  return {
    format: 'deepregatta-polars/1', id: 'test-boat', label: 'Test boat', kind: 'type',
    source: { id: 'orc', name: 'ORC 2025' }, ...overrides,
  };
}

describe('polarFromRelease', () => {
  it('transposes a full table to speeds_kt[tws][twa]', () => {
    const polar = polarFromRelease(entry({
      table: { twa_deg: [52, 90, 150], tws_kt: [6, 12], speeds_kt: [[4, 6], [5, 7], [3, 6.5]] },
    }));
    expect(polar).toEqual({
      schema_version: 1, polar_id: 'test-boat', label: 'Test boat',
      tws_kt: [6, 12], twa_deg: [52, 90, 150], speeds_kt: [[4, 5, 3], [6, 7, 6.5]],
      source: { kind: 'orc_vpp', match_type: 'release', matched_value: 'ORC 2025' },
    });
    expect(boatSpeedKt(polar, 9, 90)).toBeCloseTo(6, 9);
  });

  it('drops empty rows and fills nulls as no-go, gap or held edge within one wind speed', () => {
    const polar = polarFromRelease(entry({
      kind: 'variant', source: { id: 'sailgrib', name: 'SailGrib' },
      table: {
        twa_deg: [0, 40, 60, 80, 120],
        tws_kt: [6, 12, 30],
        speeds_kt: [
          [null, null, null],
          [null, 5, null],
          [4, null, null],
          [5, 8, null],
          [null, 7, null],
        ],
      },
    }));
    expect(polar.twa_deg).toEqual([40, 60, 80, 120]);
    expect(polar.tws_kt).toEqual([6, 12]);
    // 6 kt: no-go below 60°, held past 80°; 12 kt: 60° between 40° and 80°.
    expect(polar.speeds_kt).toEqual([[0, 4, 5, 5], [5, 6.5, 8, 7]]);
    expect(polar.source.kind).toBe('community');
  });

  it('marks generic length brackets as generic', () => {
    const polar = polarFromRelease(entry({
      kind: 'generic', table: { twa_deg: [60, 120], tws_kt: [6, 12], speeds_kt: [[4, 6], [5, 7]] },
    }));
    expect(polar.source.kind).toBe('generic');
  });

  it('refuses anything that is not a usable release entry', () => {
    const table = { twa_deg: [60, 120], tws_kt: [6, 12], speeds_kt: [[4, 6], [5, 7]] };
    expect(() => polarFromRelease({ ...entry({ table }), format: 'polar/1' })).toThrow(/deepregatta-polars/);
    expect(() => polarFromRelease(entry({
      table: { twa_deg: [60, 120], tws_kt: [6, 12], speeds_kt: [[4, null], [null, null]] },
    }))).toThrow(/too few/);
  });
});
