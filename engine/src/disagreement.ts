/**
 * Model disagreement (brief §6.2): deterministic runs shown side by side.
 * Agreement is not proof — divergence mainly tells us WHEN TO WAIT for the
 * next run. Triggers the 'insufficient' verdict state when models split on
 * hours that matter (near the declared limits).
 */

export interface DivergenceHour {
  valid_time: string;
  /** per-model sustained wind, kt */
  values: Record<string, number>;
  spread_kt: number;
}

export interface DisagreementResult {
  /** hours where models diverge beyond tolerance */
  divergent_hours: DivergenceHour[];
  /** divergence overlapping hours near/over limits -> assessment unstable */
  insufficient: boolean;
}

const ABS_SPREAD_KT = 8;
const REL_SPREAD = 0.35;
/** divergence matters when the worst model is within this ratio of the limit */
const NEAR_LIMIT_RATIO = 0.8;

export function assessDisagreement(
  hours: Array<{
    valid_time: string;
    byModel: Record<string, number | null>;
    sustained_limit_kt: number;
  }>,
): DisagreementResult {
  const divergent: DivergenceHour[] = [];
  let insufficient = false;

  for (const hour of hours) {
    const entries = Object.entries(hour.byModel).filter(
      (e): e is [string, number] => e[1] !== null && Number.isFinite(e[1]),
    );
    if (entries.length < 2) continue;
    const values = entries.map(([, v]) => v);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = max - min;

    if (spread >= ABS_SPREAD_KT || (mean > 0 && spread / mean >= REL_SPREAD)) {
      divergent.push({
        valid_time: hour.valid_time,
        values: Object.fromEntries(entries.map(([m, v]) => [m, Math.round(v * 10) / 10])),
        spread_kt: Math.round(spread * 10) / 10,
      });
      if (max >= NEAR_LIMIT_RATIO * hour.sustained_limit_kt) {
        insufficient = true;
      }
    }
  }

  return { divergent_hours: divergent, insufficient };
}
