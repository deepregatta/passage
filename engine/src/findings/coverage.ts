import { preparedSynopticCoverage } from '../synopticCoverage.js';
import { RULES } from './rules.js';
import type { CapabilityCoverage, Evidence, WarningsInput } from '../types.js';

interface CoverageInputs {
  evidence: Evidence[];
  hasEnsemble: boolean;
  hasMarine: boolean;
  hasMultiModel: boolean;
  deterministicModelCount: number;
  warnings?: WarningsInput;
  hasCurrents: boolean;
  hasTides: boolean;
  hasSynoptic: boolean;
  synopticRunId?: string;
  currentDetail?: string | null;
}

export function deriveCoverage(input: CoverageInputs): CapabilityCoverage[] {
  const ids = (rules: string[]) =>
    input.evidence.filter((item) => rules.includes(item.rule_id)).map((item) => item.evidence_id);
  const warningIds = ids([RULES.AUTHORITY]);
  const warningStatus = !input.warnings
    ? 'not_assessed'
    : input.warnings.doc.source.mode === 'synthetic'
      ? 'assessed_emulated'
      : 'assessed';
  return [
    { capability: 'sustained_wind', status: 'assessed', evidence_ids: ids([RULES.SUSTAINED, RULES.SUSTAINED_ENSEMBLE]) },
    { capability: 'gusts', status: input.hasEnsemble ? 'assessed' : 'partially_assessed', evidence_ids: ids([RULES.GUST, RULES.GUST_ENSEMBLE]) },
    {
      capability: 'waves',
      status: input.hasMarine ? 'partially_assessed' : 'not_assessed',
      detail: input.hasMarine
        ? 'deterministic wave model only; no wave ensemble'
        : 'waves (no marine forecast input)',
      evidence_ids: ids([RULES.WAVE_HEIGHT, RULES.STEEPNESS, RULES.CROSS_SEA, RULES.WIND_AGAINST_SWELL]),
    },
    {
      capability: 'visibility_and_convection',
      status: input.hasMultiModel ? 'partially_assessed' : 'not_assessed',
      detail: input.hasMultiModel
        ? 'screening signals only (single model, GFS); official warnings remain authoritative'
        : 'visibility and convection (no supporting model input)',
      evidence_ids: ids([RULES.VISIBILITY, RULES.SQUALL]),
    },
    {
      capability: 'model_agreement',
      status:
        input.deterministicModelCount >= 2
          ? 'assessed'
          : input.deterministicModelCount === 1
            ? 'partially_assessed'
            : 'not_assessed',
      detail:
        input.deterministicModelCount >= 2
          ? 'independent deterministic models compared hour by hour'
          : input.deterministicModelCount === 1
            ? 'single deterministic model available; disagreement proxied by ensemble spread only'
            : 'model comparison (no multi-model input)',
      evidence_ids: ids([RULES.DIVERGENCE]),
    },
    {
      capability: 'tidal_currents',
      status: input.hasCurrents ? (input.currentDetail ? 'partially_assessed' : 'assessed') : 'not_assessed',
      detail: input.hasCurrents
        ? input.currentDetail ?? 'prepared current grid assessed'
        : 'tidal currents (no prepared current grid)',
      evidence_ids: ids([RULES.WIND_AGAINST_CURRENT]),
    },
    {
      capability: 'tidal_gates',
      status: input.hasTides ? 'assessed' : 'not_assessed',
      detail: input.hasTides ? undefined : 'tidal gates & HW/LW heights (no tide data)',
      evidence_ids: ids(['T-GATE-01']),
    },
    {
      capability: 'official_warnings',
      status: warningStatus,
      detail:
        warningStatus === 'not_assessed'
          ? 'official marine warnings (no feed configured)'
          : warningStatus === 'assessed_emulated'
            ? 'synthetic bulletin scenario; not authority'
            : 'official warning feed assessed for route zones',
      evidence_ids: warningIds,
    },
    (input.hasSynoptic && preparedSynopticCoverage(input.synopticRunId)) || {
      capability: 'synoptic_attribution',
      status: input.hasSynoptic ? 'assessed' : 'not_assessed',
      detail: input.hasSynoptic
        ? 'system tracks assessed against the route ETA envelope'
        : 'causal synoptic attribution (no prepared synoptic run)',
    },
    { capability: 'tropical_systems', status: 'not_assessed', detail: 'tropical systems' },
    { capability: 'ice', status: 'not_assessed', detail: 'ice' },
  ];
}
