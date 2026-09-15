const STORAGE_KEY = 'deepweather.profile-draft';

/** Audit/scan reads remain strict: the caller reports inaccessible or corrupt storage. */
export function loadProfileDraft(defaults) {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored ? JSON.parse(stored) : defaults;
}

export function saveProfileDraft(draft) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage blocked/full: Settings retains edits in the mounted page.
  }
}

// Recover known editable fields while retaining defaults for missing or invalid values.
export function recoverProfileDraft(defaults) {
  let stored;
  try {
    stored = loadProfileDraft(defaults);
  } catch {
    // A corrupt or inaccessible draft falls back to the declared defaults.
  }
  const merge = (base, value) => Object.fromEntries(Object.entries(base).map(([key, fallback]) => {
    const candidate = value && !Array.isArray(value) ? value[key] : undefined;
    return [key, fallback && typeof fallback === 'object'
      ? merge(fallback, candidate)
      : typeof candidate === typeof fallback && (typeof candidate !== 'number' || Number.isFinite(candidate))
        ? candidate : fallback];
  }));
  return merge(defaults, stored);
}

