import type { CapabilityCoverage } from './types.js';

export const CHANNEL_PREPARED_COVERAGE = 'Channel-only prepared run: fixed NE Atlantic synoptic window (35–65°N, 35°W–10°E) and Channel wind grid (49–51°N, 6°W–0°). These windows do not follow your route; synoptic coverage outside the Channel is not established. Forecast-tile coverage is separate.';

/**
 * The existing Python publisher's ecmwf-ifs025 family has fixed windows
 * (ecmwf_open_data.WINDOW and synoptic_prep.WIND_BOUNDS). The run id also
 * identifies this limitation in immutable snapshots predating the disclosure.
 * A future regional publisher must use distinct run provenance/coverage.
 * This describes prepared context only, never the separate forecast tiles.
 */
export function preparedSynopticCoverage(runId?: string | null): CapabilityCoverage | null {
  if (!runId || !/^ecmwf-ifs025-\d{8}T\d{2}Z$/.test(runId)) return null;
  return {
    capability: 'synoptic_attribution',
    status: 'partially_assessed',
    detail: CHANNEL_PREPARED_COVERAGE,
  };
}
