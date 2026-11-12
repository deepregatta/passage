/**
 * The lines of the current block on the passage page, built here so each line
 * reaches the DOM as one text node and the French catalogue (i18n.js) matches
 * it with one pattern. Numbers come from the engine's currentSummary; the
 * model, its caveat and the heading's EMULATED stamp come from the check's own
 * record of the current grid it read (`currentInputRecord`), never from other feeds.
 */

import { currentInputRecord } from '@deepweather/engine';
import { fmtTextTime } from './format.js';
import { routeSummaryEmulated } from './routeSummaryLines.js';
import { currentCreditLine } from './credits.js';
import { currentModelFamily, isScenarioId, tileModelId } from './sourceNames.js';

/**
 * Fixed caveats by recorded source and model family, reusing the GRIB page's
 * dataset notes (engine/src/export/gribDatasets.ts):
 * - `tiles_global`: tile currents of the global family (GLO12) are 6-hourly and carry no tide;
 * - `global`: a prepared global grid carries no tide, and its time step is not recorded;
 * - `regional_tide`: an IBI grid includes tide; its time step is not recorded
 *   (the factory may coarsen an hourly dataset), so "hourly" is left out;
 * - `not_recorded`: any other family, an unknown id, or no record.
 * Every caveat is followed by CURRENT_DISCLAIMER (docs/forecast-tile-format.md).
 */
export const CURRENT_CAVEATS = {
  tiles_global: '6-hourly ocean-model currents. Tides are not resolved.',
  global: 'Ocean-model currents. Tides are not resolved.',
  regional_tide: 'Regional model currents including tide.',
  not_recorded: 'Whether this model includes tide is not recorded.',
};

/** The IBI GRIB note's closing sentence, reused verbatim with its French: the one permitted use of the term. */
export const CURRENT_DISCLAIMER = 'Not an official tidal-stream prediction.';

const isTiles = (record) => record.current_source === 'tiles' || record.source === 'tiles' || tileModelId(record.model) !== null;

/**
 * The current model the check recorded, named by family (null: "Model not
 * recorded"), and which caveat applies. A tile grid's model is read from its
 * "<model> tiles (<run>)" id; nothing is guessed when that id is missing.
 * @param {any} findings
 * @returns {{ name: string | null, caveat: keyof typeof CURRENT_CAVEATS }}
 */
export function currentSource(findings) {
  const { family, tiles } = currentFamilyOf(findings);
  if (!family) return { name: null, caveat: 'not_recorded' };
  const caveat = family.tide === true ? 'regional_tide'
    : family.tide === false ? (tiles ? 'tiles_global' : 'global') : 'not_recorded';
  return { name: family.name, caveat };
}

/** The recorded current model's family, and whether the grid came from tiles; no family when none is recorded. */
function currentFamilyOf(findings) {
  const record = currentInputRecord(findings);
  if (!record) return { family: null, tiles: false };
  const tiles = isTiles(record);
  return { family: currentModelFamily(tiles ? tileModelId(record.model) : record.model), tiles };
}

/**
 * The Copernicus Marine credit for the recorded current model, with the product's DOI where one is
 * recorded; null when the model is not Copernicus or none is recorded (credits.js), and
 * when the values are emulated (the heading's rule, currentSummaryEmulated): a real
 * provider's credit never sits under synthetic values.
 * @param {any} findings
 * @returns {string | null}
 */
export function currentCredit(findings) {
  if (currentSummaryEmulated(findings)) return null;
  const { family } = currentFamilyOf(findings);
  return family ? currentCreditLine(family) : null;
}

/**
 * Whether the current values were emulated, from the current grid's own record:
 *   1. the check's current record (tile layer, prepared grid, or an older check's
 *      `cmems-current-grid` entry): synthetic, marked emulated, or a scenario model
 *      is emulated; a named model or recorded mode otherwise is not;
 *   2. without a record, evidence of the wind-against-current rule (T-WAC-01) marked emulated;
 *   3. otherwise not emulated. Another emulated feed in the check never decides it.
 * @param {any} findings
 */
export function currentSummaryEmulated(findings) {
  const record = currentInputRecord(findings);
  if (record) {
    if (record.source_kind === 'emulated' || record.mode === 'synthetic' || record.source === 'synthetic') return true;
    if (isScenarioId(record.model)) return true;
    if (record.model || record.mode) return false;
  }
  return (findings?.evidence ?? []).some((item) => item.rule_id === 'T-WAC-01' && item.source_kind === 'emulated');
}

/**
 * Wind against current depends on the wind and the current: emulated when
 * either the current (currentSummaryEmulated) or the wind (routeSummaryEmulated) is.
 * @param {any} findings
 */
export function windAgainstCurrentEmulated(findings) {
  return currentSummaryEmulated(findings) || routeSummaryEmulated(findings);
}

/** Whether the check raised its wind-against-current hazard (T-WAC-01) anywhere. */
export function windAgainstCurrentHazard(findings) {
  return (findings?.evidence ?? []).some((item) => item.rule_id === 'T-WAC-01');
}

const BASIS = {
  routed_timing: 'From the computed route’s own timing: speed over ground minus speed through the water, leg by leg.',
  leg_samples: 'An estimate from one current value per leg, at its midpoint, over the leg’s expected time.',
};

function gainLines(gain) {
  if (!gain) return [{ key: 'gain', text: 'Distance gained or lost to the current: not available' }];
  const tenths = Math.round(Math.abs(gain.nm) * 10) / 10;
  const text = tenths < 0.1 ? 'Distance gained or lost to the current: under 0.1 nm'
    : `Distance ${gain.nm > 0 ? 'gained from' : 'lost to'} the current: ${tenths.toFixed(1)} nm`;
  return [{ key: 'gain', text }, { key: 'basis', text: BASIS[gain.basis] }];
}

/**
 * Wind against current: counted on the expected timing; when none falls there
 * but the check flagged it elsewhere in the arrival range (or raised T-WAC-01),
 * a line says so, so the block never reads calmer than the check's own hazard.
 * Left out only when nothing is flagged anywhere.
 */
function wacLine(summary, hazard) {
  if (summary.wind_against_current_hours > 0) return `Wind against current on the expected timing: ${summary.wind_against_current_hours} h`;
  const lead = 'Wind against current: none on the expected timing, but it occurs at other times in your arrival range';
  if (summary.wind_against_current_arrival_hours > 0) return `${lead} (${summary.wind_against_current_arrival_hours} h).`;
  return hazard ? `${lead}.` : null;
}

/**
 * @param {import('@deepweather/engine').CurrentSummary | null} summary from the engine's currentSummary
 * @param {{ legNumber?: (legId: string) => number | string, hazard?: boolean }} [options]
 *   legNumber: the leg's number on the page; hazard: whether the check raised T-WAC-01
 * @returns {Array<{ key: string, text: string }>} empty without a summary
 */
export function currentSummaryLines(summary, { legNumber = (legId) => String(legId).replace(/^L/, ''), hazard = false } = {}) {
  if (!summary) return [];
  const lines = gainLines(summary.gain);
  const strongest = summary.strongest;
  if (strongest) {
    lines.push({ key: 'strongest', text: `Strongest current at the points checked, anywhere in your arrival range: ${strongest.speed_kt.toFixed(1)} kt at the midpoint of leg ${legNumber(strongest.leg_id)} around ${fmtTextTime(strongest.valid_time)}.` });
  }
  const wac = wacLine(summary, hazard);
  if (wac) lines.push({ key: 'wac', text: wac });
  if (summary.unavailable_hours > 0) lines.push({ key: 'missing', text: `No current value for ${summary.unavailable_hours} h of the passage.` });
  return lines;
}
