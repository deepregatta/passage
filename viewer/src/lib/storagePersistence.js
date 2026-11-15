/**
 * Asking the browser to keep this site's saved checks.
 *
 * Saved checks live only in this browser (IndexedDB), with no other copy. A
 * browser may delete a whole site's data when the device is short of space, and
 * Safari also after days of browser use without a visit. `navigator.storage
 * .persist()` protects only against the low-space case: Chrome grants it
 * silently when it judges the site important, Firefox shows its own question,
 * and a Safari tab is expected to answer no. So this is a request, never a
 * promise, and the pages say so (My passages, the privacy page).
 *
 * `requestPersistence()` is called once, fire-and-forget, right after a check
 * was saved in this browser. It never throws, and nothing waits for it.
 */

/** A request is not repeated sooner than this. */
export const PERSIST_RETRY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When the browser was last asked (ms since epoch), under the internal key prefix. */
export const PERSIST_ASKED_KEY = 'deepweather.persist-asked-at';

/**
 * Whether this browser has granted persistent storage: true, false, or null when
 * it cannot say (no API, a throwing call, an answer that is not a boolean).
 * @returns {Promise<boolean | null>}
 */
export async function readPersisted() {
  try {
    const storage = globalThis.navigator?.storage;
    if (typeof storage?.persisted !== 'function') return null;
    const persisted = await storage.persisted();
    return typeof persisted === 'boolean' ? persisted : null;
  } catch {
    return null;
  }
}

/** The last time the browser was asked, or null (never, unreadable, or blocked localStorage). */
function lastAskedAt() {
  try {
    const stored = Number(globalThis.localStorage?.getItem(PERSIST_ASKED_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** Blocked or full localStorage: ask this time, remember nothing. */
function rememberAsked(now) {
  try {
    globalThis.localStorage?.setItem(PERSIST_ASKED_KEY, String(now));
  } catch {
    // nothing remembered: the next saved check asks again
  }
}

/**
 * Ask the browser to keep this site's data, at most once every PERSIST_RETRY_DAYS
 * days per browser. Does nothing when `persist()` is missing or the data is
 * already persistent. The ask is remembered before it is made, so a request that
 * never answers is not repeated by the next save. Every failure is swallowed;
 * the answer is deliberately not returned.
 * @param {number} [now] the clock, for tests
 * @returns {Promise<void>}
 */
export async function requestPersistence(now = Date.now()) {
  try {
    const storage = globalThis.navigator?.storage;
    if (typeof storage?.persist !== 'function') return;
    if (await readPersisted() === true) return;
    const last = lastAskedAt();
    // a stored time in the future (a clock set back) must not block asking for good
    if (last !== null && last <= now && now - last < PERSIST_RETRY_DAYS * DAY_MS) return;
    rememberAsked(now);
    await storage.persist();
  } catch {
    // a failing or refused request changes nothing
  }
}
