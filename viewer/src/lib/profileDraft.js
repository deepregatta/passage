const STORAGE_KEY = 'deepweather.profile-draft';

/** Persistence adapter only; actions consume the recovered in-memory draft. */
export function loadProfileDraft(defaults) {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored ? JSON.parse(stored) : defaults;
}

export function saveProfileDraft(draft) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    return true;
  } catch {
    // Storage blocked/full: Settings retains edits in the mounted page.
    return false;
  }
}

// Recover known editable fields while retaining defaults for missing or invalid values.
export function recoverProfileDraft(defaults, value) {
  let stored;
  try {
    stored = value === undefined ? loadProfileDraft(defaults) : value;
  } catch {
    // A corrupt or inaccessible draft falls back to the declared defaults.
  }
  const merge = (base, value) => Object.fromEntries(Object.entries(base).map(([key, fallback]) => {
    const candidate = value && !Array.isArray(value) ? value[key] : undefined;
    return [key, fallback && typeof fallback === 'object'
      ? merge(fallback, candidate)
      : validProfileField(key, candidate, fallback)
        ? candidate : fallback];
  }));
  return merge(defaults, stored);
}

function validProfileField(key, candidate, fallback) {
  if (typeof candidate !== typeof fallback) return false;
  if (typeof candidate !== 'number') return key !== 'declared' || candidate === true;
  if (!Number.isFinite(candidate)) return false;
  if (['scenario_fraction_floor', 'approaching_ratio'].includes(key)) return candidate >= 0 && candidate <= 1;
  if (key === 'schema_version') return Number.isInteger(candidate);
  return key === 'min_visibility_nm' ? true : candidate > 0;
}

export function validateProfileDraft(profile) {
  if (!profile || profile.declared !== true || !Number.isInteger(profile.schema_version)
    || typeof profile.profile_id !== 'string' || !/^[a-z0-9-]+$/.test(profile.profile_id) || typeof profile.label !== 'string') {
    throw new Error('No limits profile available. Open My limits first.');
  }
  for (const [key, value] of Object.entries(profile.max_sustained_kt ?? {})) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid sustained wind limit: ${key}`);
  }
  if (!Number.isFinite(profile.max_sustained_kt?.default) || profile.max_sustained_kt.default <= 0) {
    throw new Error('Invalid sustained wind limit');
  }
  for (const key of ['max_gust_kt', 'max_wave_height_m', 'max_steepness', 'scenario_fraction_floor', 'approaching_ratio', 'min_visibility_nm']) {
    const value = profile[key];
    if (value === undefined && key !== 'max_gust_kt') continue;
    if (value === null && key === 'min_visibility_nm') continue;
    if (!validProfileField(key, value, 1)) throw new Error(`Invalid limit: ${key}`);
  }
  for (const key of ['cross_sea_flag', 'night_ok']) {
    if (profile[key] !== undefined && typeof profile[key] !== 'boolean') throw new Error(`Invalid limit: ${key}`);
  }
}
