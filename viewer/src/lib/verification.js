/** Verification documents are optional: a missing or unreadable file means
 * "not verified yet", never an error on the page. */
export async function loadJson(url, signal) {
  try {
    const res = await fetch(url, { signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const CLASSES = new Set(['verified_near_observation', 'partially_observed', 'reanalysis_referenced', 'not_independently_observed', 'emulated']);
const numericOrNull = (value) => value === null || Number.isFinite(value);
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const counts = (value) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.values(value).every((n) => Number.isInteger(n) && n >= 0);

/** Checked consumer of verification-case.schema.json. V1 is retained for
 * published legacy/demo cases; v2 requires explicit source and lead semantics.
 * Unmatched/malformed numeric rows must never turn null into a zero error. */
export function readVerificationCase(doc, snapshotId) {
  if (!doc || ![1, 2].includes(doc.schema_version) || doc.snapshot_id !== snapshotId
    || !timestamp(doc.generated_at) || !Array.isArray(doc.pairs)
    || (doc.coverage_summary !== undefined && !counts(doc.coverage_summary))) return null;
  const source = doc.observation_source ?? (doc.source_mode === 'synthetic' ? 'emulated' : doc.source_mode);
  if (typeof source !== 'string' || !source.length) return null;
  if (doc.schema_version === 2 && (doc.lead_basis !== 'time_since_check'
    || !/^[0-9a-f]{64}$/.test(doc.case_revision ?? '')
    || !['live', 'fixture', 'synthetic'].includes(doc.observation_provenance?.mode)
    || typeof doc.observation_provenance?.name !== 'string' || !doc.observation_provenance.name.length
    || !Array.isArray(doc.not_independently_observed) || !doc.not_independently_observed.every((v) => typeof v === 'string')
    || !counts(doc.coverage_summary)
    || (doc.check_generated_at !== null && !timestamp(doc.check_generated_at))
    || !['max_km', 'max_min', 'near_km', 'near_min'].every((key) => Number.isFinite(doc.params?.[key]) && doc.params[key] >= 0))) return null;
  if ((doc.source_mode === 'synthetic' || doc.observation_provenance?.mode === 'synthetic') && source !== 'emulated') return null;
  if (doc.pairs.some((pair) => !pair || typeof pair.leg_id !== 'string'
    || typeof pair.variable !== 'string' || !timestamp(pair.valid_time)
    || ![pair.forecast, pair.observed, pair.error].every(Number.isFinite)
    || !CLASSES.has(pair.coverage_class)
    || (source === 'emulated' && pair.coverage_class !== 'emulated')
    || (doc.schema_version === 2 && (!numericOrNull(pair.check_lead_h)
      || !numericOrNull(pair.model_lead_h)
      || pair.lead_h !== pair.check_lead_h
      || typeof pair.station_id !== 'string'
      || ![pair.distance_km, pair.time_offset_min].every((n) => Number.isFinite(n) && n >= 0)
      || (pair.model_cycle !== null && !timestamp(pair.model_cycle))
      || (pair.model_cycle === null && pair.model_lead_h !== null))))) return null;
  return { ...doc, observation_source: source };
}
