/**
 * The two lines of the route summary block ("Point of sail: Upwind 12 h ·
 * Reaching 20 h"; "Wind: Under 10 kt 4 h · 10–15 kt 18 h"), built here so each
 * line reaches the DOM as one text node and the French catalogue (i18n.js)
 * matches it with one pattern. Zero buckets are left out; hours with no wind
 * or no point of sail are named "Not available", never dropped.
 */

import { isScenarioId } from './sourceNames.js';

const SAIL_LABELS = [
  ['upwind', 'Upwind'],
  ['reach', 'Reaching'],
  ['downwind', 'Downwind'],
  ['unknown', 'Not available'],
];

const WIND_LABELS = [
  ['under_10', 'Under 10 kt'],
  ['from_10_to_15', '10–15 kt'],
  ['from_15_to_20', '15–20 kt'],
  ['from_20_to_25', '20–25 kt'],
  ['from_25_up', '25 kt and over'],
  ['unknown', 'Not available'],
];

/**
 * Whether the hours were read from an emulated forecast: the recorded provenance of the wind
 * forecast behind them, never the rest of the check (a synthetic warning or another feed being
 * emulated says nothing about the wind). In order, the first source that names a wind forecast decides:
 *   1. the saved `forecast_tiles` weather layer: an engine scenario id (or a synthetic source) is
 *      emulated, a named real model is not;
 *   2. an older check's `inputs.openmeteo` entry for the wind forecast (api "forecast", else
 *      "forecast-multimodel"): the same rule on its model (or models) and source;
 *   3. otherwise, evidence items of the wind and gust rules (W-SUST-*, W-GUST-*) marked emulated;
 *   4. otherwise not emulated.
 */
export function routeSummaryEmulated(findings) {
  const marked = (entry) => {
    const models = [entry.model, ...(Array.isArray(entry.models) ? entry.models : [])].filter((m) => m !== null && m !== undefined && m !== '');
    if (entry.source === 'synthetic' || entry.source?.mode === 'synthetic') return true;
    if (!models.length) return null;
    return models.some((model) => isScenarioId(model));
  };
  const inputs = findings?.inputs;
  const weather = inputs?.forecast_tiles?.find((layer) => layer.layer === 'weather');
  if (weather) {
    const verdict = marked(weather);
    if (verdict !== null) return verdict;
  }
  const legacy = inputs?.openmeteo;
  const wind = Array.isArray(legacy) ? (legacy.find((item) => item.api === 'forecast') ?? legacy.find((item) => item.api === 'forecast-multimodel')) : null;
  if (wind) {
    const verdict = marked(wind);
    if (verdict !== null) return verdict;
  }
  return (findings?.evidence ?? []).some((item) => /^W-(SUST|GUST)-/.test(item.rule_id) && item.source_kind === 'emulated');
}

const items = (labels, counts) =>
  labels.filter(([key]) => counts[key] > 0).map(([key, label]) => `${label} ${counts[key]} h`).join(' · ');

/**
 * @param {import('@deepweather/engine').RouteSummary|null} summary from the engine's routeSummary
 * @returns {Array<{ key: 'sail'|'wind', text: string }>} empty without a summary
 */
export function routeSummaryLines(summary) {
  if (!summary) return [];
  return [
    { key: 'sail', text: `Point of sail: ${items(SAIL_LABELS, summary.by_point_of_sail)}` },
    { key: 'wind', text: `Wind: ${items(WIND_LABELS, summary.by_wind_band)}` },
  ];
}
