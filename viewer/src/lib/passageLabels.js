import { PASSAGE_NAME_MAX_LENGTH, cleanPassageName } from '@deepweather/engine';

// A passage's name is a display label only. It lives apart from the saved checks,
// keyed by the passage's grouping key (see lib/passages.js), so renaming never
// touches a passage_id, route_revision, snapshot fingerprint or frozen check.
// The key keeps the internal "deepweather" prefix like the other stored keys.
// A name is cleaned by the engine's one rule (cleanPassageName), typed or read back.

export const PASSAGE_LABELS_KEY = 'deepweather.passage-labels';
export const MAX_LABEL_LENGTH = PASSAGE_NAME_MAX_LENGTH;

// Kept in memory too, so a rename lasts for the visit when storage is blocked.
let memory = null;

const clean = cleanPassageName;

function read() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PASSAGE_LABELS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, clean(value)]).filter(([, value]) => value));
  } catch {
    return null;
  }
}

/** Returns true when the change reached browser storage. */
function write(labels) {
  memory = labels;
  try {
    if (Object.keys(labels).length) localStorage.setItem(PASSAGE_LABELS_KEY, JSON.stringify(labels));
    else localStorage.removeItem(PASSAGE_LABELS_KEY);
    return true;
  } catch {
    return false;
  }
}

export const passageLabels = {
  all() {
    const stored = read();
    if (stored) memory = stored;
    return { ...(memory ?? {}) };
  },
  /** An empty name removes the label, restoring the original. */
  set(key, name) {
    const next = this.all();
    const label = clean(name);
    if (label) next[key] = label; else delete next[key];
    return { labels: next, persisted: write(next) };
  },
  remove(key) {
    return this.set(key, '');
  },
  clean,
  /** Test hook: forget the in-memory mirror. */
  forgetMemory() { memory = null; },
};
