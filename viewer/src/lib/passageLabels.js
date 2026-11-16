import { PASSAGE_NAME_MAX_LENGTH, cleanPassageName } from '@deepweather/engine';

// A passage's name is a display label only. It lives apart from the saved checks,
// keyed by the passage's grouping key (see lib/passages.js), so renaming never
// touches a passage_id, route_revision, snapshot fingerprint or frozen check.
// The key keeps the internal "deepweather" prefix like the other stored keys.
// A name is cleaned by the engine's one rule (cleanPassageName), typed or read back.

export const PASSAGE_LABELS_KEY = 'deepweather.passage-labels';
export const MAX_LABEL_LENGTH = PASSAGE_NAME_MAX_LENGTH;

// This tab's names that storage has not taken yet: key → name, or null for a removal. A
// successful read returns storage with these laid over it, so a name this tab could not
// store lasts the visit, while another tab's renames and removals still show here; a
// successful write stores that merged set and clears them.
const pending = new Map();
// The names storage last gave (or took), for when it cannot be read.
let known = null;

const clean = cleanPassageName;

/** The stored names, or null when storage cannot be read. */
function read() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PASSAGE_LABELS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, clean(value)]).filter(([, value]) => value));
  } catch {
    return null;
  }
}

/** Storage's names (or the last known ones) with this tab's pending changes laid over them. */
function current() {
  const stored = read();
  if (stored) known = stored;
  const labels = { ...(known ?? {}) };
  for (const [key, value] of pending) {
    if (value === null) delete labels[key];
    else labels[key] = value;
  }
  return labels;
}

/** Store these names; true when storage took them, and then nothing is pending. */
function write(labels) {
  try {
    if (Object.keys(labels).length) localStorage.setItem(PASSAGE_LABELS_KEY, JSON.stringify(labels));
    else localStorage.removeItem(PASSAGE_LABELS_KEY);
  } catch {
    return false;
  }
  known = labels;
  pending.clear();
  return true;
}

export const passageLabels = {
  all() {
    return current();
  },
  /** An empty name removes the label, restoring the original. */
  set(key, name) {
    const label = clean(name);
    pending.set(key, label || null);
    const next = current();
    return { labels: next, persisted: write(next) };
  },
  remove(key) {
    return this.set(key, '');
  },
  clean,
  /** Test hook: forget what this page holds (pending changes and the last stored names). */
  forgetMemory() { known = null; pending.clear(); },
};
