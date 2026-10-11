/**
 * Convert one deepregatta-polars/1 release entry (served by /api/polars/<id>)
 * to the router's Polar shape. Passage keeps its own interpolation: the
 * entry's fixed angle rows only (its best-VMG beat/run rows are not used),
 * transposed to speeds_kt[tws][twa].
 *
 * A release cell is null when the source states no speed at that angle. Rows
 * and columns with no speed at all are dropped. Within one wind speed, an
 * angle below the first stated speed is no-go (0), a gap between two stated
 * speeds is interpolated linearly, and an angle past the last stated speed
 * holds that speed, as the router already holds its table edges.
 */
import type { Polar } from './polar.js';

export interface DeepPolarsEntry {
  format: string;
  id: string;
  label: string;
  kind: string;
  source: { id: string; name: string };
  table: {
    twa_deg: number[];
    tws_kt: number[];
    /** speeds_kt[twa][tws]; null is no value */
    speeds_kt: (number | null)[][];
  };
}

export function polarFromRelease(entry: DeepPolarsEntry): Polar {
  if (entry?.format !== 'deepregatta-polars/1') throw new Error('Not a deepregatta-polars/1 entry');
  const { twa_deg: angles, tws_kt: winds, speeds_kt: cells } = entry.table;
  const at = (a: number, w: number) => cells[a]?.[w] ?? null;
  const rows = angles.map((_, a) => a).filter((a) => winds.some((_, w) => at(a, w) !== null));
  const columns = winds.map((_, w) => w).filter((w) => rows.some((a) => at(a, w) !== null));
  if (rows.length < 2 || columns.length < 2) throw new Error(`Polar ${entry.id} has too few stated speeds`);

  const speeds = columns.map((w) => {
    const stated = rows.filter((a) => at(a, w) !== null);
    return rows.map((a) => {
      const value = at(a, w);
      if (value !== null) return value;
      const below = stated.filter((s) => s < a).at(-1);
      const above = stated.find((s) => s > a);
      if (below === undefined) return 0;
      if (above === undefined) return at(below, w)!;
      const t = (angles[a]! - angles[below]!) / (angles[above]! - angles[below]!);
      return at(below, w)! + t * (at(above, w)! - at(below, w)!);
    });
  });

  return {
    schema_version: 1,
    polar_id: entry.id,
    label: entry.label,
    tws_kt: columns.map((w) => winds[w]!),
    twa_deg: rows.map((a) => angles[a]!),
    speeds_kt: speeds,
    source: {
      kind: entry.kind === 'generic' ? 'generic' : entry.source.id.startsWith('orc') ? 'orc_vpp' : 'community',
      match_type: 'release',
      matched_value: entry.source.name,
    },
  };
}
