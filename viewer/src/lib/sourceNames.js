// Human names for the identifiers the engine records with every claim: model
// ids, layer ids, dataset ids and run ids. The raw ids stay in saved findings
// (and in a "Provenance" disclosure); page text uses these names.
// Sources: engine/src/forecast (layers), engine/src/export/gribDatasets.ts,
// engine/src/briefing.ts (PUBLICATION_SCHEDULE model ids), config/providers.json.
// Unknown ids fall back to a cleaned-up form, never to the raw id.

const EMULATED = 'Scenario set (emulated)';

/** Deterministic and ensemble model ids as recorded in findings.inputs and evidence. */
const MODEL_NAMES = {
  gfs_0p25: 'GFS 0.25°',
  gfs_global: 'GFS',
  gefs_0p50: 'GEFS ensemble 0.5°',
  gfswave_0p25: 'GFS-Wave 0.25°',
  ecmwf_ifs_0p25: 'ECMWF IFS 0.25°',
  ecmwf_ifs025: 'ECMWF IFS 0.25°',
  icon_eu: 'DWD ICON-EU',
  arome: 'Météo-France AROME',
  ukv: 'Met Office UKV',
  cmems_glo12: 'Copernicus global ocean currents',
  cmems_ibi: 'Copernicus IBI ocean currents',
};

/** Copernicus dataset ids carry grid and cadence; match on the family. */
const DATASET_NAMES = [
  [/^cmems_mod_ibi_phy_anfc_[\d.]+deg-2D/i, 'Copernicus IBI sea level'],
  [/^cmems_mod_ibi_phy_anfc/i, 'Copernicus IBI ocean currents'],
  [/^cmems_mod_glo_phy/i, 'Copernicus global ocean currents'],
  [/^cmems_mod_med_phy/i, 'Copernicus Mediterranean sea level'],
];

/** Forecast layer ids (ForecastStore layers) to the product they carry. */
const LAYER_NAMES = {
  weather: 'Wind and gusts',
  ensemble: 'Ensemble',
  waves: 'Waves',
  'weather-ecmwf': 'Additional weather model',
  'weather-ecmwf-short': 'Additional weather model',
  'weather-multimodel': 'Additional weather model',
  'weather-arome': 'Regional weather model',
  'weather-icon-eu': 'Regional weather model',
  'weather-ukv': 'Regional weather model',
  currents: 'Surface currents',
  'currents-ibi': 'Surface currents',
  synoptic: 'Synoptic features',
  tides: 'Tide predictions',
  gates: 'Tidal gates',
  warnings: 'Official warnings',
};

/** The model a layer's runs come from, for run labels ("GFS run 10 Nov 12Z"). */
const LAYER_RUN_FAMILY = {
  weather: 'GFS',
  ensemble: 'GEFS',
  waves: 'GFS-Wave',
  'weather-ecmwf': 'ECMWF',
  'weather-ecmwf-short': 'ECMWF',
  'ecmwf-ifs025': 'ECMWF',
  currents: 'Copernicus currents',
  'currents-ibi': 'Copernicus IBI currents',
  'weather-arome': 'AROME',
  'weather-icon-eu': 'ICON-EU',
  'weather-ukv': 'UKV',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "foo_bar_0p25" -> "Foo bar 0.25°": readable, never the raw id. */
function cleanId(id) {
  const words = String(id)
    .replace(/(\d)p(\d+)/g, '$1.$2°')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

const isScenario = (id) => /^scenario([\s_-]|$)/i.test(String(id));

/** True for the engine's emulated scenario ids ("scenario", "scenario ensemble", "scenario-74bece95"). */
export const isScenarioId = (id) => id !== null && id !== undefined && isScenario(id);

/**
 * One model, dataset or layer-model id to a name. Lists ("a,b" or "a/b", as
 * recorded for multi-model evidence) become "Name, Name".
 * @param {string | null | undefined} id
 * @returns {string}
 */
export function modelName(id) {
  if (id === null || id === undefined || String(id).trim() === '') return 'n/a';
  const text = String(id).trim();
  if (/[,/]/.test(text)) return [...new Set(text.split(/\s*[,/]\s*/).filter(Boolean).map(modelName))].join(', ');
  if (isScenario(text)) return EMULATED;
  if (Object.hasOwn(MODEL_NAMES, text)) return MODEL_NAMES[text];
  const dataset = DATASET_NAMES.find(([pattern]) => pattern.test(text));
  if (dataset) return dataset[1];
  // Ids that are already prose ("official bulletin", "tide tables") pass through.
  return /[_\d]/.test(text) ? cleanId(text) : text;
}

/**
 * The product a forecast layer carries ("Wind and gusts"). Unknown layers fall
 * back to a cleaned-up form.
 * @param {string | null | undefined} layer
 */
export function layerName(layer) {
  if (!layer) return 'n/a';
  return Object.hasOwn(LAYER_NAMES, layer) ? LAYER_NAMES[layer] : cleanId(layer);
}

/**
 * A run id to "GFS run 10 Nov 12Z" (UTC cycle). `weather-20261110T12Z` names
 * its layer in the prefix; `ecmwf-ifs025-20260916T00Z` its model. Emulated
 * `scenario-<hash>` runs become "Emulated scenario run". Anything else is
 * cleaned up.
 * @param {string | null | undefined} runId
 * @param {{ layer?: string | null, model?: string | null }} [context] layer or model that names the run's model when the id has no known prefix
 */
export function runLabel(runId, context = {}) {
  if (!runId) return 'n/a';
  const id = String(runId);
  if (isScenario(id)) return 'Emulated scenario run';
  // Cycles recorded as ISO instants ("2026-10-01T06:00Z") carry no model in the id.
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?Z?$/.exec(id);
  const match = iso ? ['', '', iso[1], iso[2], iso[3], iso[4]] : /^(.*?)-?(\d{4})(\d{2})(\d{2})T(\d{2})Z$/.exec(id);
  if (!match) return cleanId(id);
  const [, prefix, , month, day, hour] = match;
  const family = LAYER_RUN_FAMILY[prefix] ?? LAYER_RUN_FAMILY[context.layer ?? '']
    ?? (prefix ? cleanId(prefix) : context.model ? modelName(context.model) : '');
  const when = `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${hour}Z`;
  return family ? `${family} run ${when}` : `Run ${when}`;
}
