/**
 * How much of this browser's storage Passage uses, for the My passages page.
 *
 * `navigator.storage.estimate()` describes the whole origin: saved checks
 * (IndexedDB) and the downloaded forecast tiles (tileCache.js) together. A
 * browser cannot always tell them apart, and Safari's figures are coarse on
 * purpose, so nothing here claims to be the size of the saved checks. Nothing
 * leaves the browser, and this never asks for persistent storage.
 */

/** From this share of the quota the page also says what share is used. */
export const HIGH_SHARE = 0.5;
/** From this share of the quota the page warns that storage is nearly full. */
export const NEARLY_FULL_SHARE = 0.8;

const MB = 1e6;
const GB = 1e9;

export const STORAGE_LEVEL = Object.freeze({ ok: 'ok', high: 'high', nearlyFull: 'nearly-full' });

/** @param {number} share @returns {'ok' | 'high' | 'nearly-full'} */
export function storageLevel(share) {
  if (share >= NEARLY_FULL_SHARE) return STORAGE_LEVEL.nearlyFull;
  if (share >= HIGH_SHARE) return STORAGE_LEVEL.high;
  return STORAGE_LEVEL.ok;
}

/**
 * The origin's usage and quota, or null when this browser gives no usable estimate
 * (no API, a throwing call, a missing or non-positive quota, a missing usage).
 * @returns {Promise<{usageBytes: number, quotaBytes: number, share: number, level: 'ok' | 'high' | 'nearly-full'} | null>}
 */
export async function readStorageUsage() {
  let estimate;
  try {
    const storage = globalThis.navigator?.storage;
    if (typeof storage?.estimate !== 'function') return null;
    estimate = await storage.estimate();
  } catch {
    return null;
  }
  const usageBytes = estimate?.usage;
  const quotaBytes = estimate?.quota;
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) return null;
  if (!Number.isFinite(usageBytes) || usageBytes < 0) return null;
  const share = usageBytes / quotaBytes;
  return { usageBytes, quotaBytes, share, level: storageLevel(share) };
}

/**
 * Decimal units, as file managers show them: "less than 1 MB", whole megabytes
 * from 1 MB, one-decimal gigabytes from 1,000 MB. English; the page translates it.
 * @param {number} bytes
 */
export function formatStorageSize(bytes) {
  if (bytes < MB) return 'less than 1 MB';
  const megabytes = Math.round(bytes / MB);
  if (megabytes < 1000) return `${megabytes} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

/**
 * The share as a whole percent, rounded down so a share below a threshold never
 * reads as the threshold, and never above 100 (usage can exceed the quota).
 * @param {{usageBytes: number, quotaBytes: number}} usage
 */
export function storagePercent({ usageBytes, quotaBytes }) {
  return Math.min(100, Math.floor((usageBytes * 100) / quotaBytes));
}
