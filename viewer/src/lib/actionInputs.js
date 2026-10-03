// @ts-check
import { contentHash } from '@deepweather/engine';
import { validateProfileDraft } from './profileDraft.js';
import { ForecastUpdatedError } from './forecastFreshness.js';

/** @typedef {import('@deepweather/engine').AnalyzeOptions} AnalyzeOptions */
/** @typedef {import('@deepweather/engine').ForecastStore} ForecastStore */
/**
 * @typedef {object} ActionInputs
 * @property {AnalyzeOptions['route']} route
 * @property {AnalyzeOptions['profile']} profile
 * @property {string} departureUtc
 * @property {string} routeRevision
 * @property {string} profileRevision
 * @property {ForecastStore} store
 * @property {ReturnType<ForecastStore['describe']>} tileRuns
 * @property {AnalyzeOptions['currentGrid']} [currentGrid]
 * @property {AnalyzeOptions['currentGridProvenance']} [currentGridProvenance]
 * @property {AnalyzeOptions['currentInput']} [currentInput]
 * @property {AnalyzeOptions['synoptic']} [synoptic]
 * @property {AnalyzeOptions['tides']} [tides]
 * @property {AnalyzeOptions['gates']} [gates]
 * @property {AnalyzeOptions['warnings']} [warnings]
 * @property {NonNullable<AnalyzeOptions['inputRecords']>} inputRecords
 */

/** @template T @param {T} value @returns {T} */
export function freezeInput(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeInput);
    Object.freeze(value);
  }
  return value;
}

/** Capture user inputs before any discovery/refresh awaits. @param {Pick<AnalyzeOptions, 'route' | 'profile' | 'departureUtc'>} draft */
export function captureActionDraft(draft) {
  validateProfileDraft(draft.profile);
  return freezeInput(structuredClone({
    route: draft.route, profile: draft.profile, departureUtc: draft.departureUtc,
    routeRevision: contentHash(draft.route), profileRevision: contentHash(draft.profile),
  }));
}

/**
 * Store refresh remains between actions. A changed run fails the whole action
 * instead of allowing later reads to substitute a new run into this bundle.
 * @param {ForecastStore} store
 */
export async function pinForecastInputs(store) {
  await store.init();
  const tileRuns = freezeInput(structuredClone(store.describe()));
  /** @param {ReturnType<ForecastStore['describe']>} runs */
  const runRevision = (runs) => contentHash(Object.fromEntries(Object.entries(runs).map(([layer, run]) =>
    [layer, { run_id: run.run_id, cycle: run.cycle, model: run.model, resolution_deg: run.resolution_deg, member_count: run.member_count }])));
  const revision = runRevision(tileRuns);
  const assertPinned = () => { if (runRevision(store.describe()) !== revision) throw new ForecastUpdatedError(); };
  /** @template {(...args: any[]) => Promise<any>} T @param {T} read @returns {T} */
  const guard = (read) => /** @type {T} */ (async (...args) => {
    assertPinned();
    const result = await read(...args);
    assertPinned();
    return result;
  });
  /** @type {ForecastStore} */
  const pinned = {
    init: async () => assertPinned(), describe: () => tileRuns,
    getPointForecasts: guard(store.getPointForecasts.bind(store)),
    getEnsembleForecasts: guard(store.getEnsembleForecasts.bind(store)),
    getWaveForecasts: guard(store.getWaveForecasts.bind(store)),
    getHazardForecasts: guard(store.getHazardForecasts.bind(store)),
    getCurrentGrid: guard(store.getCurrentGrid.bind(store)),
    getWindGrid: guard(store.getWindGrid.bind(store)),
  };
  return { store: Object.freeze(pinned), tileRuns };
}

/** @param {ActionInputs} inputs @returns {ActionInputs} */
export function freezeActionInputs(inputs) {
  // The transport owns its cache; only the action's JSON data is deeply frozen.
  const { store, ...data } = inputs;
  return Object.freeze({ ...freezeInput(data), store });
}

/** @param {AnalyzeOptions['currentGrid'] | null} grid @returns {NonNullable<AnalyzeOptions['currentInput']>} */
export function routingCurrentInput(grid) {
  return freezeInput({ grid: grid ?? undefined, provenance: {
    source: 'tiles', current_source: 'tiles', selection_reason: 'same current grid as scan routing',
    content_digest: grid ? contentHash(grid) : null, digest_algorithm: 'fnv1a64',
  } });
}
